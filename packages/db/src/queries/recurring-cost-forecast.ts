import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The recurring cost forecast: the cost side of the cash-flow forecast R-REP consumes.
 *
 * ## The as-of date is an argument, never `current_date`
 *
 * Every figure in this system has to be reproducible. A forecast that read the clock would give a
 * different answer tomorrow for a horizon somebody has already committed to, and the worked example
 * committed in `packages/fixtures/src/recurring-costs.ts` could not exist. The caller passes the
 * **business day**, resolved with `resolveTradingDate` from `@berelax/core` — trading runs 11:00–02:00,
 * so a forecast cut at 01:30 is the previous trading day's forecast.
 *
 * ## What R-REP reads, and what it deliberately cannot
 *
 * These two functions, and `recurring_cost_forward_schedule(as_of, months)` behind them. A report never
 * touches `recurring_cost` or `recurring_cost_instance`, for two separate reasons:
 *
 *   - **The cadence arithmetic exists once.** A report that joined the definitions would have to step
 *     the cadence itself, and a second stepper eventually disagrees with the generator about which month
 *     an annual licence renews in.
 *   - **The forecast must not depend on the generator having run.** Reading
 *     `recurring_cost_instance` would make the horizon end wherever the nightly pass last got to, and a
 *     forecast that quietly shortens looks exactly like a business with no costs in month eleven. The
 *     SQL function computes the occurrences from the definitions instead.
 *
 * ## A period is a month of the horizon
 *
 * The window is half-open, `[asOf, asOf + months)`, which is what makes a monthly cost contribute
 * exactly `months` occurrences whatever day of the month it falls on. A quarterly cost contributes four
 * over a year and an annual one contributes one, each landing in the month it is actually due — so costs
 * of different cadences sum into one cash-flow line, which is the only reading of "period" under which a
 * forecast total means anything.
 *
 * ## Every total here is a bigint
 *
 * `sum()` over the `fils` domain returns numeric and the driver hands it back as a **string** so nothing
 * can silently round a money total. `BigInt`, not `Number`: `trial-balance.ts` documents the four-fils
 * difference a `number` produced out of nothing, and a forecast is read by whoever is deciding whether
 * there is enough cash next month.
 */

export interface ForecastRow {
  readonly recurringCostId: string
  readonly code: string
  readonly description: string
  readonly supplierId: string
  readonly expenseAccountCode: string
  readonly cadence: string
  readonly costKind: string
  /** `YYYY-MM` of the due date. */
  readonly periodKey: string
  readonly dueDate: string
  /**
   * What to hold cash for: the contracted amount for a fixed cost, and the **top** of the band for a
   * variable one. The midpoint is the tempting choice and it is wrong — a plan built on the middle of
   * every band is short of cash in about half the months it covers.
   */
  readonly expectedFils: bigint
  /** The optimistic end of the same range, so a report can show a band rather than one number. */
  readonly expectedLowFils: bigint
  readonly expectedHighFils: bigint
}

export interface ForecastPeriod {
  readonly periodKey: string
  readonly expectedFils: bigint
  readonly expectedLowFils: bigint
  readonly costCount: number
}

export interface RecurringCostForecast {
  readonly asOf: string
  readonly months: number
  readonly rows: readonly ForecastRow[]
  /** One entry per month that has at least one cost due. A month with none is absent, not zero. */
  readonly periods: readonly ForecastPeriod[]
  readonly totalFils: bigint
  readonly lowTotalFils: bigint
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertArguments(asOf: string, months: number): void {
  if (!ISO_DATE.test(asOf)) {
    throw new AppError('validation', `asOf must be an ISO business day (YYYY-MM-DD), got "${asOf}"`)
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new AppError(
      'validation',
      `A forecast covers at least one whole month; received ${months}`,
    )
  }
}

/**
 * Narrows a forecast to some of the register.
 *
 * `codes` is what a report showing one contract's schedule uses — and what the integration suite uses to
 * scope its own rows, because the suite runs sequentially against one database and earlier files leave
 * recurring costs behind. A total over "every cost in the register" would pass until another unit landed.
 */
export interface ForecastFilter {
  readonly codes?: readonly string[]
}

/** Every occurrence due in `[asOf, asOf + months)`, oldest first, then by cost code. */
export async function recurringCostSchedule(
  sql: Sql,
  asOf: string,
  months = 12,
  filter: ForecastFilter = {},
): Promise<readonly ForecastRow[]> {
  assertArguments(asOf, months)
  const codes = filter.codes ?? null
  const rows = await sql<
    {
      recurring_cost_id: string
      code: string
      description: string
      supplier_id: string
      expense_account_code: string
      cadence: string
      cost_kind: string
      period_key: string
      due_date: string
      expected_fils: string
      expected_low_fils: string
      expected_high_fils: string
    }[]
  >`
    select recurring_cost_id::text as recurring_cost_id,
           code, description,
           supplier_id::text      as supplier_id,
           expense_account_code, cadence, cost_kind, period_key,
           due_date::text         as due_date,
           expected_fils::text    as expected_fils,
           expected_low_fils::text  as expected_low_fils,
           expected_high_fils::text as expected_high_fils
      from recurring_cost_forward_schedule(${asOf}::date, ${months}::integer)
     where (${codes}::text[] is null or code = any(${codes}::text[]))
     -- Restated here rather than trusted from the function body: a set-returning function's own ORDER BY
     -- is not a promise to the query that wraps it, and a printed forecast that reordered between runs
     -- would diff everywhere instead of where a figure changed.
     order by due_date, code
  `
  return rows.map((row) => ({
    recurringCostId: row.recurring_cost_id,
    code: row.code,
    description: row.description,
    supplierId: row.supplier_id,
    expenseAccountCode: row.expense_account_code,
    cadence: row.cadence,
    costKind: row.cost_kind,
    periodKey: row.period_key,
    dueDate: row.due_date,
    // The driver returns the `fils` domain as a string precisely so nothing rounds; BigInt, not Number.
    expectedFils: BigInt(row.expected_fils),
    expectedLowFils: BigInt(row.expected_low_fils),
    expectedHighFils: BigInt(row.expected_high_fils),
  }))
}

/**
 * The forecast: every occurrence, the per-month subtotals and the horizon total.
 *
 * The month subtotals and the horizon total are summed by PostgreSQL rather than by adding up the rows
 * above, and the integration test asserts the two agree — because "the totals match the detail" is the
 * property a forecast lives or dies by, and a caller that wants only the monthly figures should not have
 * to pull every occurrence across the wire to get them.
 */
export async function recurringCostForecast(
  sql: Sql,
  asOf: string,
  months = 12,
  filter: ForecastFilter = {},
): Promise<RecurringCostForecast> {
  assertArguments(asOf, months)
  const codes = filter.codes ?? null
  const rows = await recurringCostSchedule(sql, asOf, months, filter)

  const periods = await sql<
    { period_key: string; expected_fils: string; expected_low_fils: string; cost_count: string }[]
  >`
    select period_key,
           sum(expected_fils)::text     as expected_fils,
           sum(expected_low_fils)::text as expected_low_fils,
           count(*)::text               as cost_count
      from recurring_cost_forward_schedule(${asOf}::date, ${months}::integer)
     where (${codes}::text[] is null or code = any(${codes}::text[]))
     group by period_key
     order by period_key
  `

  const shaped = periods.map((row) => ({
    periodKey: row.period_key,
    expectedFils: BigInt(row.expected_fils),
    expectedLowFils: BigInt(row.expected_low_fils),
    costCount: Number(row.cost_count),
  }))

  return {
    asOf,
    months,
    rows,
    periods: shaped,
    totalFils: shaped.reduce((total, period) => total + period.expectedFils, 0n),
    lowTotalFils: shaped.reduce((total, period) => total + period.expectedLowFils, 0n),
  }
}

/** The total of one month of the forecast, or zero. For a caller that wants one figure. */
export function forecastPeriodTotalFils(
  forecast: RecurringCostForecast,
  periodKey: string,
): bigint {
  return forecast.periods.find((period) => period.periodKey === periodKey)?.expectedFils ?? 0n
}

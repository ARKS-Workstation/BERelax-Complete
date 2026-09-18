import {
  classifyVariance,
  filsFrom,
  forwardSchedule,
  localDate,
  money,
  RECURRING_CADENCES,
  type RecurringCadence,
  recurringDueDate,
  recurringPeriodKey,
} from '@berelax/core'
import {
  createConnection,
  recordRecurringCost,
  recordSupplier,
  recurringCostForecast,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FIXTURE_FORECAST_AS_OF,
  FIXTURE_FORECAST_LOW_TOTAL_FILS,
  FIXTURE_FORECAST_MONTHS,
  FIXTURE_FORECAST_PERIODS,
  FIXTURE_FORECAST_ROW_COUNT,
  FIXTURE_FORECAST_TOTAL_FILS,
  FIXTURE_RECURRING_COSTS,
  FIXTURE_RECURRING_DEFINITIONS,
  FIXTURE_VARIANCE_CASES,
} from './recurring-costs.ts'

/**
 * M-VAT-04 — the two statements of the recurring cost rule, proved to agree.
 *
 * The cadence stepper, the period key and the variance exist twice: in SQL, because `packages/db` may not
 * import `packages/core` and the forecast has to group where the rows are; and in `packages/core`, because
 * the schedule is arithmetic and arithmetic belongs in the pure package. Two statements of one rule is a
 * standing invitation to drift, and this file is what closes it — the same arrangement, for the same
 * reason, as `price_list` / `resolve-price.ts` and `payables_aging_bucket` / `payablesBucketFor`.
 *
 * `packages/fixtures` is the one package allowed to depend on both, which is why the comparison lives
 * here rather than in either of them.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = { kind: 'system', label: 'm-vat-04-agreement-itest' } as const
/** Unique per run: the register's history tables are append-only, so nothing here can be cleaned up. */
const RUN = Date.now().toString(36)
const TRN = '000000000000003'

let sql: Sql
/** The fixture cost code as it is stored for this run. */
const storedCode = (code: string) => `${code}-${RUN}`

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the SQL cadence stepper and the pure one agree', () => {
  it('agrees on every occurrence of every cadence over three years', async () => {
    // Anchors on the 1st, mid-month and the 28th — and on the 29th, 30th and 31st, which validation
    // refuses but the arithmetic still has to define, because the SQL clamp and the TypeScript clamp
    // are two implementations of `date + interval '1 month'` and have to clamp the same way.
    const anchors = [
      '2026-01-01',
      '2026-01-15',
      '2026-01-28',
      '2026-01-29',
      '2026-01-30',
      '2026-01-31',
      '2028-01-31',
    ]
    const rows = (await sql`
      select a.anchor::text as anchor, c.cadence, n.occurrence,
             recurring_cost_due_date(a.anchor, c.cadence, n.occurrence)::text as due_date,
             recurring_cost_period_key(
               recurring_cost_due_date(a.anchor, c.cadence, n.occurrence)
             ) as period_key
        from unnest(${anchors}::date[]) as a(anchor)
        cross join unnest(${[...RECURRING_CADENCES]}::text[]) as c(cadence)
        cross join generate_series(0, 36) as n(occurrence)
    `) as unknown as {
      anchor: string
      cadence: string
      occurrence: number
      due_date: string
      period_key: string
    }[]

    // A control on the fixture itself: a query that returned nothing would make every assertion below
    // pass vacuously, which is how an agreement test stops agreeing about anything.
    expect(rows.length).toBe(anchors.length * RECURRING_CADENCES.length * 37)

    const disagreements = rows.filter((row) => {
      const anchor = localDate(row.anchor)
      const cadence = row.cadence as RecurringCadence
      const due = recurringDueDate(anchor, cadence, row.occurrence)
      return due !== row.due_date || recurringPeriodKey(due) !== row.period_key
    })
    expect(
      disagreements.map(
        (row) =>
          `${row.anchor} ${row.cadence} +${row.occurrence}: sql ${row.due_date} vs core ` +
          `${recurringDueDate(localDate(row.anchor), row.cadence as RecurringCadence, row.occurrence)}`,
      ),
    ).toEqual([])
  })

  it('raises rather than returning NULL for a cadence neither side can step', async () => {
    // A NULL here would not fail: it would make every due date NULL and the cost would silently vanish
    // from the forecast, which is the one failure a cost register must not have.
    const error = await sql`select recurring_cost_period_months('fortnightly')`.catch(
      (err: unknown) => err,
    )
    expect((error as { code?: string }).code).toBe('ZR003')
    expect((error as { message?: string }).message).toMatch(/UnknownRecurringCadence/)
  })
})

describe('acceptance — the SQL variance and the pure one agree, on both sides of the boundary', () => {
  it('agrees on every committed boundary case', async () => {
    for (const testCase of FIXTURE_VARIANCE_CASES) {
      const shape = FIXTURE_RECURRING_COSTS.find(
        (candidate) => candidate.code === testCase.costCode,
      )
      const definition = FIXTURE_RECURRING_DEFINITIONS.find(
        (candidate) => candidate.code === testCase.costCode,
      )
      if (shape === undefined || definition === undefined) {
        throw new Error(`no fixture cost ${testCase.costCode}`)
      }
      const [row] = (await sql`
        select delta_fils::text as delta_fils, tolerance_fils::text as tolerance_fils, over_tolerance
          from recurring_cost_variance(
            ${shape.kind},
            ${shape.expectedAmountFils ?? null},
            ${shape.expectedMinFils ?? null},
            ${shape.expectedMaxFils ?? null},
            ${shape.varianceToleranceBp},
            ${testCase.actualGrossFils}
          )
      `) as unknown as { delta_fils: string; tolerance_fils: string; over_tolerance: boolean }[]

      const pure = classifyVariance(
        definition.expectation,
        money(filsFrom(testCase.actualGrossFils)),
      )
      const label = `${testCase.costCode} @ ${testCase.actualGrossFils}`
      // The committed figure, the database and the pure function: all three, so a change to any one of
      // them fails rather than two of them quietly moving together.
      expect(Number(row?.delta_fils), label).toBe(testCase.expectedDeltaFils)
      expect(Number(row?.tolerance_fils), label).toBe(testCase.expectedToleranceFils)
      expect(row?.over_tolerance, label).toBe(testCase.overTolerance)
      expect(pure.delta.fils, label).toBe(testCase.expectedDeltaFils)
      expect(pure.tolerance.fils, label).toBe(testCase.expectedToleranceFils)
      expect(pure.overTolerance, label).toBe(testCase.overTolerance)
    }
  })

  it('agrees across a sweep of amounts either side of both expectation shapes', async () => {
    // The committed cases are the boundaries somebody reasoned about. This is the sweep that would catch
    // a rounding rule that differed anywhere else — the two sides round independently unless they are the
    // same rule, and ADR 0007 exists because a fils of difference eventually reaches a filed return.
    const amounts: number[] = []
    for (let gross = 180_000; gross <= 600_000; gross += 3_137) amounts.push(gross)

    for (const shape of FIXTURE_RECURRING_COSTS) {
      const definition = FIXTURE_RECURRING_DEFINITIONS.find(
        (candidate) => candidate.code === shape.code,
      )
      if (definition === undefined) throw new Error(`no definition for ${shape.code}`)
      const rows = (await sql`
        select g.gross, v.delta_fils::text as delta_fils, v.tolerance_fils::text as tolerance_fils,
               v.over_tolerance
          from unnest(${amounts}::bigint[]) as g(gross)
          cross join lateral recurring_cost_variance(
            ${shape.kind},
            ${shape.expectedAmountFils ?? null},
            ${shape.expectedMinFils ?? null},
            ${shape.expectedMaxFils ?? null},
            ${shape.varianceToleranceBp},
            g.gross
          ) as v
      `) as unknown as {
        gross: string
        delta_fils: string
        tolerance_fils: string
        over_tolerance: boolean
      }[]
      expect(rows.length, shape.code).toBe(amounts.length)

      const disagreements = rows.filter((row) => {
        const pure = classifyVariance(definition.expectation, money(filsFrom(Number(row.gross))))
        return (
          pure.delta.fils !== Number(row.delta_fils) ||
          pure.tolerance.fils !== Number(row.tolerance_fils) ||
          pure.overTolerance !== row.over_tolerance
        )
      })
      expect(
        disagreements.map((row) => `${shape.code} @ ${row.gross}`),
        shape.code,
      ).toEqual([])
    }
  })
})

describe('acceptance — the 12-period forward schedule totals the committed example, from the database', () => {
  const codes = FIXTURE_RECURRING_COSTS.map((shape) => storedCode(shape.code))

  beforeAll(async () => {
    // The fixture suppliers, created per run: the register's history tables are append-only, so a shared
    // code would collide on the second run against the same database.
    const supplierIds = new Map<string, string>()
    for (const supplierCode of new Set(
      FIXTURE_RECURRING_COSTS.map((shape) => shape.supplierCode),
    )) {
      const supplier = await withUnitOfWork(sql, ACTOR, (uow) =>
        recordSupplier(uow, {
          code: storedCode(supplierCode),
          legalName: `FIXTURE (not a real supplier) — ${supplierCode}`,
          residency: 'domestic',
          placeOfSupplyRule: 'domestic_uae',
          trn: TRN,
        }),
      )
      supplierIds.set(supplierCode, supplier.supplierId)
    }

    for (const shape of FIXTURE_RECURRING_COSTS) {
      const supplierId = supplierIds.get(shape.supplierCode)
      if (supplierId === undefined) throw new Error(`no supplier for ${shape.code}`)
      await withUnitOfWork(sql, ACTOR, (uow) =>
        recordRecurringCost(uow, {
          code: storedCode(shape.code),
          description: shape.description,
          supplierId,
          expenseAccountCode: shape.account,
          taxTreatment: shape.taxTreatment,
          cadence: shape.cadence,
          firstDueDate: shape.firstDueDate,
          costKind: shape.kind,
          expectedAmountFils: shape.expectedAmountFils ?? null,
          expectedMinFils: shape.expectedMinFils ?? null,
          expectedMaxFils: shape.expectedMaxFils ?? null,
          varianceToleranceBp: shape.varianceToleranceBp,
        }),
      )
    }
  })

  it('totals the committed figures to the fils', async () => {
    const forecast = await recurringCostForecast(
      sql,
      FIXTURE_FORECAST_AS_OF,
      FIXTURE_FORECAST_MONTHS,
      { codes },
    )
    expect(forecast.rows).toHaveLength(FIXTURE_FORECAST_ROW_COUNT)
    expect(forecast.totalFils).toBe(BigInt(FIXTURE_FORECAST_TOTAL_FILS))
    expect(forecast.lowTotalFils).toBe(BigInt(FIXTURE_FORECAST_LOW_TOTAL_FILS))
  })

  it('lands every occurrence in the committed month', async () => {
    const forecast = await recurringCostForecast(
      sql,
      FIXTURE_FORECAST_AS_OF,
      FIXTURE_FORECAST_MONTHS,
      { codes },
    )
    expect(
      forecast.periods.map((period) => ({
        periodKey: period.periodKey,
        expectedFils: Number(period.expectedFils),
        costCount: period.costCount,
      })),
    ).toEqual([...FIXTURE_FORECAST_PERIODS])
  })

  it('produces occurrence for occurrence the same schedule as the pure function', async () => {
    // The strongest form of the agreement: not just the same total, but the same rows. A total can match
    // while two occurrences have swapped months, and a cash-flow forecast is read month by month.
    const forecast = await recurringCostForecast(
      sql,
      FIXTURE_FORECAST_AS_OF,
      FIXTURE_FORECAST_MONTHS,
      { codes },
    )
    const pure = forwardSchedule(
      FIXTURE_RECURRING_DEFINITIONS,
      FIXTURE_FORECAST_AS_OF,
      FIXTURE_FORECAST_MONTHS,
    )
    expect(
      forecast.rows.map(
        (row) => `${row.dueDate} ${row.code} ${row.expectedFils} ${row.expectedLowFils}`,
      ),
    ).toEqual(
      pure.rows.map(
        (row) =>
          `${row.dueDate} ${storedCode(row.code)} ${row.expected.fils} ${row.expectedLow.fils}`,
      ),
    )
  })

  it('would notice a disagreement: the same comparison against a deliberately wrong horizon fails', async () => {
    // The control. Without it, an agreement test that compared two empty lists would report success.
    const forecast = await recurringCostForecast(sql, FIXTURE_FORECAST_AS_OF, 11, { codes })
    expect(forecast.rows.length).not.toBe(FIXTURE_FORECAST_ROW_COUNT)
    expect(forecast.totalFils).not.toBe(BigInt(FIXTURE_FORECAST_TOTAL_FILS))
  })
})

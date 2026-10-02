import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { trialBalanceAsAt } from '../queries/trial-balance.ts'

/**
 * The reads behind the 13-week cash forecast and the seasonality report (R-REP-06).
 *
 * The **arithmetic** is `packages/core/src/reporting/cash-forecast.ts` and `.../seasonality.ts` and stays
 * there: `packages/db` may never import `packages/core` (ADR 0001), so this module returns ROWS and
 * forecasts nothing. `packages/fixtures/src/cash-forecast.itest.ts` is where the two halves meet against a
 * real database, which is R-REP-02's and R-REP-04's arrangement one subject along.
 *
 * # What this module is allowed to read, which is the whole decision of ADR 0073
 *
 * A forecast line is a commitment already on file, re-timed. So every read here is of something somebody
 * has already done:
 *
 *   | the line            | the read                                        | the commitment            |
 *   | ------------------- | ----------------------------------------------- | ------------------------- |
 *   | opening cash        | `trialBalanceAsAt` over the cash accounts       | money in the bank         |
 *   | recurring costs     | `recurringCostSchedule` (`recurring-cost-forecast.ts`) | a signed contract   |
 *   | forward bookings    | {@link forwardBookingRows}                      | an appointment taken      |
 *   | payroll             | {@link payrollForecastCensus} — a REFUSAL        | nothing; see below        |
 *
 * There is no read of history here at all: no trailing average, no same-week-last-year, no trend. That is
 * not an omission — a business with weeks of trading has nothing to average, and a figure derived from it
 * would be a projection with no visible assumption in it. The seasonality reads below are for a report
 * published BESIDE the forecast, and `cash-forecast.ts` cannot import the module that consumes them.
 *
 * # No account code is stated in this file
 *
 * Every query that needs one takes it as an argument, for `kpi-queries.ts`' reason: the chart of accounts
 * is `ACCOUNTS` in `packages/core`, which this package may not import, so a four-digit literal here would
 * be a second statement of a code whose first statement is somewhere unreachable. The pairing suite passes
 * the real codes, which is what holds the two equal, and gate case 151n scans this file for one.
 *
 * # Every money figure is a `bigint`
 *
 * `sum()` over the `fils` domain returns `numeric` and `connection.ts` hands it back as a string precisely
 * so nothing rounds it. `queries/trial-balance.ts` records the four fils a `number` produced out of nothing
 * on a cumulative ledger position, and a cash forecast is read by whoever is deciding whether the rent is
 * affordable.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A window of trading dates, both ends inclusive and both arguments — never `current_date`. */
export interface ForecastWindow {
  readonly from: string
  readonly to: string
}

function assertWindow(window: ForecastWindow): void {
  if (!ISO_DATE.test(window.from) || !ISO_DATE.test(window.to)) {
    throw new AppError(
      'validation',
      `A forecast window is two ISO dates (YYYY-MM-DD); received "${window.from}".."${window.to}".`,
    )
  }
  if (window.to < window.from) {
    throw new AppError(
      'validation',
      `The window ${window.from}..${window.to} ends before it starts, which selects nothing and would ` +
        'read as a horizon with no costs in it.',
    )
  }
}

// --- the opening position ------------------------------------------------------------------------

export interface ForecastCashPosition {
  readonly asOf: string
  /**
   * The cash position: `Σ (debit − credit)` over the cash accounts, cumulative to `asOf`.
   *
   * Signed as the ledger signs it, so an overdrawn account is negative and is NOT clamped: clamping it
   * to zero is the one error in an opening position nobody can see afterwards, because the forecast
   * still articulates.
   */
  readonly fils: bigint
  /** Per account, so the figure drills to the rows it came from. */
  readonly byAccount: readonly { readonly accountCode: string; readonly fils: bigint }[]
  /** Account codes the caller asked for that the ledger holds no posting on. Reported, not dropped. */
  readonly accountsWithNoPostings: readonly string[]
}

/**
 * The ledger's cash position at a date — the forecast's ONE measured figure.
 *
 * `trialBalanceAsAt` rather than a sum of its own, for `statement-queries.ts`' reason: a second
 * aggregation of `journal_line` is a second answer to the same question, and the two would disagree the
 * first time one of them learned about a new source kind. `cashAccountCodes` is ADR 0064's cash set —
 * the drawer, the petty-cash float and the bank account, with the two clearing accounts deliberately
 * excluded — and it arrives as an argument because the chart lives in a package this one cannot import.
 */
export async function forecastCashPosition(
  sql: Sql,
  asOf: string,
  cashAccountCodes: readonly string[],
): Promise<ForecastCashPosition> {
  if (!ISO_DATE.test(asOf)) {
    throw new AppError('validation', `asOf must be an ISO business day (YYYY-MM-DD), got "${asOf}"`)
  }
  if (cashAccountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A cash position over no accounts is zero, which would be reported as an empty bank account. ' +
        "Pass the balance sheet's own cash set.",
    )
  }
  const balance = await trialBalanceAsAt(sql, asOf)
  const wanted = new Set(cashAccountCodes)
  const rows = balance.rows.filter((row) => wanted.has(row.accountCode))
  const byAccount = rows
    .map((row) => ({ accountCode: row.accountCode, fils: row.debitFils - row.creditFils }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode))
  const present = new Set(rows.map((row) => row.accountCode))
  return {
    asOf,
    fils: byAccount.reduce((total, row) => total + row.fils, 0n),
    byAccount: Object.freeze(byAccount),
    // `trialBalanceAsAt` has a `having` that drops an account whose debits and credits are both zero, so
    // an absent code is "nothing has ever been posted here" and not "the query missed it". Reported
    // rather than inferred, because a cash set of three accounts that silently matched one would produce
    // a plausible figure over a third of the business's money.
    accountsWithNoPostings: Object.freeze(
      cashAccountCodes.filter((code) => !present.has(code)).sort(),
    ),
  }
}

// --- the forward bookings ------------------------------------------------------------------------

/**
 * The appointment statuses a FORWARD booking can be in.
 *
 * `requested` and `confirmed`, and nothing else. The literal is the same claim
 * `BILLABLE_APPOINTMENT_STATUSES` makes in `packages/core` for the delivered side and that this package
 * cannot import; the pairing suite asserts the two sets are disjoint, which is the property that matters
 * — a status counted as both a delivery and a forecast would be revenue reported twice.
 *
 * The three in-flight statuses (`checked_in`, `in_progress`) are deliberately out: they describe a
 * treatment happening now, so they cannot be in a window that starts tomorrow, and including them would
 * make the first week's figure depend on the hour the forecast was cut. `rescheduled` is out because the
 * appointment it was rescheduled TO carries the booking, and counting both would double it.
 */
export const FORWARD_APPOINTMENT_STATUSES: readonly string[] = Object.freeze([
  'requested',
  'confirmed',
])

export interface ForwardBookingRow {
  readonly appointmentId: string
  /** `appointment.trading_date`, foreign-keyed to `business_day`: a 01:30 treatment keeps the day before. */
  readonly tradingDate: string
  readonly status: string
  /** `appointment.gross_price_fils`: the price the booking was taken at, never today's catalogue price. */
  readonly snapshotGrossFils: bigint
}

export interface ForwardBookings {
  readonly window: ForecastWindow
  readonly rows: readonly ForwardBookingRow[]
  /** `Σ snapshotGrossFils`, summed by PostgreSQL so the total and the detail are two reads, not one. */
  readonly grossFils: bigint
  /**
   * Bookings in the window whose trading date has no `business_day` row.
   *
   * Zero by construction — `appointment.trading_date` has a foreign key to `business_day` (0024) — and
   * counted anyway, because the figure that proves a constraint holds is cheaper than the incident that
   * proves it does not, and `fact_sale` is the relation in this schema where the equivalent key has no
   * foreign key at all (ADR 0060).
   */
  readonly bookingsOffTheTradingCalendar: number
}

/**
 * Every appointment already in the diary with a trading date in the window, at its snapshotted gross.
 *
 * Bounded on `trading_date` and not on `lower(period)`: trading runs 11:00-02:00, so an appointment at
 * 01:30 belongs to the previous trading date (ADR 0060) and bounding on the instant would move the last
 * two hours of every night into the next week — and at a week boundary that is a whole night of revenue
 * moving between two figures somebody is comparing.
 */
export async function forwardBookingRows(
  sql: Sql,
  window: ForecastWindow,
  statuses: readonly string[] = FORWARD_APPOINTMENT_STATUSES,
): Promise<ForwardBookings> {
  assertWindow(window)
  const rows = await sql<
    {
      appointmentId: string
      tradingDate: string
      status: string
      snapshotGrossFils: string
      offCalendar: boolean
    }[]
  >`
    select a.id::text                        as "appointmentId",
           a.trading_date::text              as "tradingDate",
           a.status::text                     as status,
           a.gross_price_fils::text           as "snapshotGrossFils",
           (bd.trading_date is null)          as "offCalendar"
      from appointment a
      left join business_day bd on bd.trading_date = a.trading_date
     where a.trading_date between ${window.from}::date and ${window.to}::date
       and a.status::text = any(${[...statuses]}::text[])
     -- Trading date then id: a stable order, so a printed forecast diffs only where a figure changed.
     order by a.trading_date, a.id
  `
  const shaped = rows.map((row) => ({
    appointmentId: row.appointmentId,
    tradingDate: row.tradingDate,
    status: row.status,
    snapshotGrossFils: BigInt(row.snapshotGrossFils),
  }))
  const [totals] = await sql<{ grossFils: string }[]>`
    select coalesce(sum(a.gross_price_fils), 0)::text as "grossFils"
      from appointment a
     where a.trading_date between ${window.from}::date and ${window.to}::date
       and a.status::text = any(${[...statuses]}::text[])
  `
  const grossFils = BigInt(totals?.grossFils ?? '0')
  const detail = shaped.reduce((total, row) => total + row.snapshotGrossFils, 0n)
  if (grossFils !== detail) {
    // The total is summed by PostgreSQL and the detail in TypeScript, so this cannot be a rounding
    // difference — `fils` is an integer domain. It is the two queries having seen different rows, which
    // on a read-committed connection means a booking was taken between them. Refused rather than
    // reported, because a forecast whose total disagrees with its own lines is not a forecast.
    throw new AppError(
      'invariant_violated',
      `The forward-booking total (${grossFils} fils) does not equal the sum of the rows (${detail} ` +
        'fils). The two reads saw different rows, so the detail a reader drills to is not what the ' +
        'figure was computed from.',
    )
  }
  return {
    window,
    rows: Object.freeze(shaped),
    grossFils,
    bookingsOffTheTradingCalendar: rows.filter((row) => row.offCalendar).length,
  }
}

// --- the payroll, which is a census and never a figure -------------------------------------------

export interface PayrollForecastCensus {
  readonly window: ForecastWindow
  /** Employment records that had not ended before the window opened. */
  readonly activeEmploymentRecords: number
  /** Of those, how many carry a `basic_wage_fils`. The allowances are not a wage. */
  readonly pricedEmployees: number
  /** Of those, the ones that do not, sorted. The list ADR 0070 exists for. */
  readonly unpricedEmployeeIds: readonly string[]
  /**
   * `payroll_run` rows whose period overlaps the window.
   *
   * Counted so that "no pay date exists" is distinguishable from "no payroll has ever been run". Both
   * leave the forecast's payroll line refusing, and only one of them is fixed by running payroll.
   */
  readonly payrollRunsOverlappingTheWindow: number
  /**
   * Whether ANY table in this build records the date payroll cash leaves the bank.
   *
   * `false`, and it is a read of the catalogue rather than a constant, so the day somebody adds the
   * column this census stops saying there is none. `Y8-payroll-date` is the open question; the forecast's
   * payroll line refuses while this is false, because a 13-week horizon holds three settlements and
   * putting them on a date this build chose moves a whole month's wage bill into or out of the horizon.
   */
  readonly aPayDateIsRecordedAnywhere: boolean
}

/**
 * What is known about payroll over a window, which is a census and deliberately not an amount.
 *
 * It returns no figure at all — not even the total of the wages that ARE on file. A partial wage bill is
 * the shape of the defect ADR 0070 is about: it is a number, a screen renders it, and it is lower than
 * the real one by exactly the employees nobody has priced. The caller turns this census into
 * `cashForecast`'s refusal-shaped payroll input, and the integration suite measures that it does.
 */
export async function payrollForecastCensus(
  sql: Sql,
  window: ForecastWindow,
): Promise<PayrollForecastCensus> {
  assertWindow(window)
  const rows = await sql<{ employeeId: string; priced: boolean }[]>`
    select e.id::text                      as "employeeId",
           (e.basic_wage_fils is not null)   as priced
      from employee e
     -- An employment record that ended before the window opened cannot be paid out of it. Null is an
     -- open-ended contract, which is every seeded record.
     where e.employed_until is null or e.employed_until >= ${window.from}::date
     order by e.id
  `
  const [runs] = await sql<{ overlapping: string }[]>`
    select count(*)::text as overlapping
      from payroll_run r
     where r.period_starts_on <= ${window.to}::date
       and r.period_ends_on   >= ${window.from}::date
  `
  // The catalogue, not a constant: `Y8-payroll-date` is answered by a column, and this census must stop
  // claiming there is none on the day one exists. `pay%` rather than an exact name because the column
  // this is waiting for has not been named yet, and the names it could not be are excluded explicitly.
  const [payDate] = await sql<{ present: boolean }[]>`
    select exists (
      select 1
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name = 'payroll_run'
         and c.data_type in ('date', 'timestamp with time zone')
         and c.column_name like 'pay%'
         and c.column_name not in ('payslip_count')
    ) as present
  `
  return {
    window,
    activeEmploymentRecords: rows.length,
    pricedEmployees: rows.filter((row) => row.priced).length,
    unpricedEmployeeIds: Object.freeze(
      rows.filter((row) => !row.priced).map((row) => row.employeeId),
    ),
    payrollRunsOverlappingTheWindow: Number(runs?.overlapping ?? '0'),
    aPayDateIsRecordedAnywhere: payDate?.present === true,
  }
}

// --- the seasonality reads -----------------------------------------------------------------------

/** One trading day of `reporting.dim_date`, with the two observance flags split three ways (0110). */
export interface SeasonalityDayRow {
  readonly businessDay: string
  readonly openMinutes: number
  readonly isRamadan: boolean
  readonly ramadanIsProvisional: boolean
  readonly isPublicHoliday: boolean
  readonly publicHolidayIsProvisional: boolean
  readonly publicHolidayIsLunarDated: boolean
  readonly publicHolidayNames: string | null
  readonly monthOfYear: number
}

export interface SeasonalityRoomDayRow {
  readonly businessDay: string
  readonly roomId: string
}

export interface SeasonalityRoomClosureRow {
  readonly businessDay: string
  readonly roomId: string
  readonly fromMinuteAfterOpen: number
  readonly toMinuteAfterOpen: number
}

export interface SeasonalityRevenueLineRow {
  readonly businessDay: string
  readonly accountCode: string
  readonly netFils: bigint
}

export interface SeasonalityPeriod {
  readonly window: ForecastWindow
  readonly days: readonly SeasonalityDayRow[]
  readonly roomDays: readonly SeasonalityRoomDayRow[]
  readonly roomClosures: readonly SeasonalityRoomClosureRow[]
  readonly revenueLines: readonly SeasonalityRevenueLineRow[]
  /**
   * Postings on the named accounts in the window whose `entry_date` is not a trading date.
   *
   * ADR 0060's rule, applied where it is not free. `journal_entry.entry_date` deliberately has no foreign
   * key to `business_day`, because the journal must be able to record the rent for a month containing
   * days the premises were shut (ADR 0064) — so a revenue posting dated off the trading calendar is
   * possible, and the seasonality index cannot include it, because an index is a ratio of two sets of
   * trading days. It is COUNTED rather than dropped silently: revenue leaving a revenue figure with
   * nothing said is the failure `reporting.assert_business_day_keys` refuses one layer down.
   */
  readonly revenueOffTheTradingCalendarFils: bigint
}

/**
 * Everything the seasonality index reads, over a window of trading dates.
 *
 * `reporting.dim_date` and not `business_day`, deliberately: `open_minutes` and the observance flags are
 * the reporting schema's own columns, and ADR 0068's rule is that the hours denominator reads
 * `dim_date.open_minutes` and nothing else. The chain from there is `business_day.duration_seconds`
 * (generated by 0011 from the day's instants), which `generateBusinessDays` computes from
 * `premises_hours` and `premises_hours_override` — so a Ramadan hours row changes the index with no
 * change to any code, which is R-REP-06's third acceptance line and what the pairing suite proves by
 * writing one.
 *
 * `rooms.is_bookable` has no history, so the room-day set for a PAST window uses the rooms in service
 * now. That is ADR 0068's stated cost arriving here: a decommissioned room's past capacity is recorded
 * nowhere, and inventing it would be a denominator this build made up.
 */
export async function seasonalityPeriod(
  sql: Sql,
  window: ForecastWindow,
  revenueAccountCodes: readonly string[],
): Promise<SeasonalityPeriod> {
  assertWindow(window)
  if (revenueAccountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A seasonality index over no revenue accounts has a numerator of zero in every bucket, which ' +
        'would read as a business that earns nothing rather than as a caller that passed no accounts.',
    )
  }
  const days = await sql<
    {
      businessDay: string
      openMinutes: number
      isRamadan: boolean
      ramadanIsProvisional: boolean
      isPublicHoliday: boolean
      publicHolidayIsProvisional: boolean
      publicHolidayIsLunarDated: boolean
      publicHolidayNames: string | null
      monthOfYear: number
    }[]
  >`
    select d.business_day::text                       as "businessDay",
           d.open_minutes                              as "openMinutes",
           d.is_ramadan                                as "isRamadan",
           d.ramadan_is_provisional                    as "ramadanIsProvisional",
           d.is_public_holiday                         as "isPublicHoliday",
           d.public_holiday_is_provisional             as "publicHolidayIsProvisional",
           d.public_holiday_is_lunar_dated             as "publicHolidayIsLunarDated",
           d.public_holiday_names                      as "publicHolidayNames",
           extract(month from d.business_day)::integer as "monthOfYear"
      from reporting.dim_date d
     where d.business_day between ${window.from}::date and ${window.to}::date
     order by d.business_day
  `
  const roomDays = await sql<{ businessDay: string; roomId: string }[]>`
    select d.business_day::text as "businessDay",
           r.id::text           as "roomId"
      from reporting.dim_date d
      cross join rooms r
     where d.business_day between ${window.from}::date and ${window.to}::date
       and r.is_bookable
     order by d.business_day, r.id
  `
  const roomClosures = await sql<
    {
      businessDay: string
      roomId: string
      fromMinuteAfterOpen: number
      toMinuteAfterOpen: number
    }[]
  >`
    select d.business_day::text as "businessDay",
           b.room_id::text      as "roomId",
           -- Rebased against the day's OWN opening instant, in whole minutes, which is what the pure
           -- layer takes: ADR 0068 gives it no instant at all, so a date cannot be re-derived there.
           -- Not clipped here: room_closure_minutes in packages/core clips to the open window and
           -- unions overlaps, and clipping in both places would be two statements of one rule.
           (extract(epoch from (lower(b.period) - d.opens_at)) / 60)::integer as "fromMinuteAfterOpen",
           (extract(epoch from (upper(b.period) - d.opens_at)) / 60)::integer as "toMinuteAfterOpen"
      from reporting.dim_date d
      join resource_block b
        on b.period && tstzrange(d.opens_at, d.closes_at, '[)')
     where d.business_day between ${window.from}::date and ${window.to}::date
     order by d.business_day, b.room_id, b.id
  `
  const revenueLines = await sql<{ businessDay: string; accountCode: string; netFils: string }[]>`
    select e.entry_date::text                                as "businessDay",
           l.account_code                                      as "accountCode",
           -- Debit less credit, so a posting to the contra discounts account is NEGATIVE and the
           -- numerator is net of discount. The sign is the ledger's; nothing here flips it.
           sum(l.debit_fils - l.credit_fils)::text             as "netFils"
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
      join reporting.dim_date d on d.business_day = e.entry_date
     where e.entry_date between ${window.from}::date and ${window.to}::date
       and l.account_code = any(${[...revenueAccountCodes]}::text[])
     group by e.entry_date, l.account_code
     order by e.entry_date, l.account_code
  `
  const [offCalendar] = await sql<{ fils: string }[]>`
    select coalesce(sum(l.debit_fils - l.credit_fils), 0)::text as fils
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where e.entry_date between ${window.from}::date and ${window.to}::date
       and l.account_code = any(${[...revenueAccountCodes]}::text[])
       and not exists (
         select 1 from reporting.dim_date d where d.business_day = e.entry_date
       )
  `
  return {
    window,
    days: Object.freeze(days),
    roomDays: Object.freeze(roomDays),
    roomClosures: Object.freeze(roomClosures),
    revenueLines: Object.freeze(
      revenueLines.map((row) => ({
        businessDay: row.businessDay,
        accountCode: row.accountCode,
        // Negated against the ledger's own direction: a revenue account's natural balance is a CREDIT,
        // so `debit - credit` is negative for revenue earned and `treatment_net_revenue_fils` sums a
        // positive net. The flip is here and stated once; the measure in `packages/core` sums what it is
        // given, which is why the pairing suite checks a known figure end to end.
        netFils: -BigInt(row.netFils),
      })),
    ),
    revenueOffTheTradingCalendarFils: -BigInt(offCalendar?.fils ?? '0'),
  }
}

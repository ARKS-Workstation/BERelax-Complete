import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The working-hours read side: the rostered shifts, the business day each belongs to, the versioned rule
 * table and the public-holiday closures.
 *
 * The **arithmetic** is `packages/core/src/hr/working-hours.ts`'s and stays there — `packages/db` must
 * never import `packages/core` — so this module returns **rows** and never a bucket, a total or a
 * violation. `packages/fixtures/src/hr-working-hours.itest.ts` is the one place that may import both and
 * is where the pair is asserted to work, the same arrangement `hr-credentials.itest.ts` has.
 *
 * ## Why the shift read joins `business_day` rather than deriving the day
 *
 * `shift.trading_date` is a foreign key into `business_day` (0030), so the trading date a shift belongs
 * to is **stored and referentially guaranteed**: no row can name a date the premises does not trade on.
 * This read joins that table and returns its `opens_at` and `closes_at` alongside the shift, which is the
 * one thing a caller cannot work out for itself — trading runs 11:00–02:00, so a shift ending at 01:30
 * has a trading date whose calendar date is the day before, and any attempt to recover it from the period
 * would be a second reading of the rule `resolveTradingDate` already owns.
 *
 * ## Instants as epoch milliseconds
 *
 * `lower(period)` and `upper(period)` come back as `timestamptz` and are converted here, because the
 * `Instant` the pure arithmetic works in is epoch milliseconds (`packages/core/src/time.ts`) and a `Date`
 * crossing that boundary is a second representation of one instant. The conversion is exact: a
 * `timestamptz` is microsecond-precision and the maths refuses a boundary that is not on a whole minute.
 */

/** One version of `working_hours_rule`. Structurally `WorkingHoursRules` in `@berelax/core`. */
export interface WorkingHoursRuleRow {
  readonly effectiveFrom: string
  readonly ordinaryMinutesPerDay: number
  readonly ordinaryMinutesPerWeek: number
  readonly weekStartsOn: number
  readonly overtimeDailyCapMinutes: number
  readonly minimumRestMinutes: number
  /** `HH:MM`, trimmed from Postgres's `HH:MM:SS` so it is the `LocalTime` the maths accepts. */
  readonly nightWindowFrom: string
  readonly nightWindowUntil: string
  readonly ordinaryMultiplierBp: number
  readonly overtimeMultiplierBp: number
  readonly nightMultiplierBp: number
  readonly publicHolidayMultiplierBp: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/** One `shift` row joined to its assignment and to the `business_day` its trading date names. */
export interface RosteredShiftRow {
  readonly shiftId: string
  readonly employeeId: string
  /** `shift.trading_date`. A trading date, never a calendar date. */
  readonly tradingDate: string
  /** `lower(shift.period)` and `upper(shift.period)` as epoch milliseconds. */
  readonly startsAt: number
  readonly endsAt: number
  /** `business_day.opens_at` / `closes_at` for that trading date, through the foreign key. */
  readonly dayOpensAt: number
  readonly dayClosesAt: number
}

/** A `premises_closure` row of kind `public_holiday`. */
export interface PublicHolidayClosureRow {
  readonly startsOn: string
  readonly endsOn: string
  readonly kind: string
  readonly isConfirmed: boolean
}

/**
 * Every version of the rules, oldest first.
 *
 * All of them and not the one in force, which is this table's whole reason for existing: payroll
 * recomputes March in April and must use March's rates. `rulesFor` in `@berelax/core` picks the version
 * that governs each trading date, and it is pure precisely so that choice is testable without a database.
 *
 * **Throws** when the table is empty, for `readCredentialPolicy`'s reason: 0059 seeds a version from a
 * sentinel date before any trading this business could have done, so an empty result means the row is
 * gone rather than that no rules have been decided. Returning an empty array would hand the arithmetic a
 * choice between inventing rates and failing somewhere less informative.
 */
export async function readWorkingHoursRules(sql: Sql): Promise<readonly WorkingHoursRuleRow[]> {
  const rows = await sql<WorkingHoursRuleRow[]>`
    select effective_from::text             as "effectiveFrom",
           ordinary_minutes_per_day         as "ordinaryMinutesPerDay",
           ordinary_minutes_per_week        as "ordinaryMinutesPerWeek",
           week_starts_on                   as "weekStartsOn",
           overtime_daily_cap_minutes       as "overtimeDailyCapMinutes",
           minimum_rest_minutes             as "minimumRestMinutes",
           to_char(night_window_from, 'HH24:MI')  as "nightWindowFrom",
           to_char(night_window_until, 'HH24:MI') as "nightWindowUntil",
           ordinary_multiplier_bp           as "ordinaryMultiplierBp",
           overtime_multiplier_bp           as "overtimeMultiplierBp",
           night_multiplier_bp              as "nightMultiplierBp",
           public_holiday_multiplier_bp     as "publicHolidayMultiplierBp",
           is_provisional                   as "isProvisional",
           open_question_id                 as "openQuestionId",
           provisional_note                 as "provisionalNote",
           source_note                      as "sourceNote"
      from working_hours_rule
     order by effective_from
  `
  if (rows.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No working-hours rule version exists, so the overtime multipliers, the caps, the night window ' +
        'and the minimum rest gap are unknown. 0059 seeds version 1 flagged provisional against ' +
        'Y9-overtime; an empty table means it was deleted. An empty answer here would leave the ' +
        'arithmetic to invent its own rates.',
    )
  }
  return rows
}

/**
 * The rostered shifts in a range of TRADING dates, with the business day each belongs to.
 *
 * Bounded by a trading-date range, which is what a payroll or rota question always is, so there is no
 * unbounded variant: an admin screen that read every shift ever rostered would get slower every month.
 * Both bounds are inclusive — a trading date is a whole session, and a half-open date range invites the
 * off-by-one that drops the last day of a pay period.
 *
 * `employeeIds` narrows to those employees. Omitted means every employee on those dates, which is the
 * rota validator's question; `[]` is refused rather than silently meaning "everybody", because an empty
 * list is what an unfiltered variable looks like.
 */
export async function readRosteredShifts(
  sql: Sql,
  args: {
    readonly fromTradingDate: string
    readonly toTradingDate: string
    readonly employeeIds?: readonly string[]
  },
): Promise<readonly RosteredShiftRow[]> {
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readRosteredShifts was given an empty employee list. Omit the argument to mean every employee; ' +
        'an empty array is what an unfiltered variable looks like.',
    )
  }
  if (args.toTradingDate < args.fromTradingDate) {
    throw new AppError(
      'validation',
      `The trading-date range ${args.fromTradingDate}..${args.toTradingDate} ends before it starts`,
    )
  }
  const rows = await sql<
    {
      shiftId: string
      employeeId: string
      tradingDate: string
      startsAt: Date
      endsAt: Date
      dayOpensAt: Date
      dayClosesAt: Date
    }[]
  >`
    select s.id                 as "shiftId",
           sa.employee_id       as "employeeId",
           s.trading_date::text as "tradingDate",
           lower(s.period)      as "startsAt",
           upper(s.period)      as "endsAt",
           bd.opens_at          as "dayOpensAt",
           bd.closes_at         as "dayClosesAt"
      from shift s
      join shift_assignment sa on sa.shift_id = s.id
      -- An INNER join, and it can be: shift.trading_date is a foreign key into business_day, so a shift
      -- naming a date the premises does not trade on cannot exist. The join is here to RETURN the day's
      -- bounds, not to filter — a left join would suggest the row might be missing and invite a caller to
      -- handle a case the schema forbids.
      join business_day bd on bd.trading_date = s.trading_date
     where s.trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       ${
         args.employeeIds === undefined
           ? sql``
           : sql`and sa.employee_id = any(${[...args.employeeIds]}::uuid[])`
       }
     order by sa.employee_id, s.trading_date, lower(s.period), s.id
  `
  return rows.map((row) => ({
    shiftId: row.shiftId,
    employeeId: row.employeeId,
    tradingDate: row.tradingDate,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
    dayOpensAt: row.dayOpensAt.getTime(),
    dayClosesAt: row.dayClosesAt.getTime(),
  }))
}

/**
 * The public-holiday closures overlapping a date range.
 *
 * `premises_closure` rows of kind `public_holiday` only, and **both confirmed and unconfirmed**: UAE
 * public holidays are lunar and announced at short notice, which is why 0003 carries `is_confirmed` at
 * all, and `publicHolidayTradingDates` in `@berelax/core` explains why the unconfirmed ones are counted —
 * of the two possible errors, paying an uplift for a day that turns out not to be a holiday is visible
 * and recoverable, while not paying one is a shortfall nobody re-reads.
 *
 * The rows this cannot return are the reason the holiday flag reaches the arithmetic as an argument: a
 * public holiday the premises TRADES THROUGH has no closure row, so this is a floor and not a calendar.
 */
export async function readPublicHolidayClosures(
  sql: Sql,
  args: { readonly fromDate: string; readonly toDate: string },
): Promise<readonly PublicHolidayClosureRow[]> {
  return sql<PublicHolidayClosureRow[]>`
    select starts_on::text as "startsOn",
           ends_on::text   as "endsOn",
           kind,
           is_confirmed    as "isConfirmed"
      from premises_closure
     where kind = 'public_holiday'
       and starts_on <= ${args.toDate}::date
       and ends_on   >= ${args.fromDate}::date
     order by starts_on, ends_on
  `
}

import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The holiday calendar's rows, and the two writes that change it.
 *
 * ## What is here and what deliberately is not
 *
 * This module READS the rows a holiday impact report is about and WRITES the calendar. It does not
 * compute the report: `packages/db` may never import `packages/core` (brief rule 4), and the report is
 * arithmetic over dates — `holidayConfirmationImpact` in `packages/core/src/hr/holiday-impact.ts`. The
 * composition happens in `packages/fixtures/src/hr-holiday-calendar.itest.ts` and in the rota route,
 * which are the two places allowed to import both.
 *
 * The types here are structural mirrors for the same reason the gratuity repository's are: `LocalDate`
 * becomes an ISO `YYYY-MM-DD` string and a branded id becomes a string. A caller holding a core
 * observance maps it field for field.
 *
 * ## Why confirming takes the caller's transaction when there is one
 *
 * {@link confirmHolidayObservance} and {@link saveHoursOverride} both write in ONE transaction, and both
 * join the caller's when the caller already has one (see `inOneTransaction`). That is
 * `frequency-ledger.ts`'s arrangement and it is not a convenience: the deferred triggers fire at COMMIT,
 * so a repository that opened its own transaction inside a caller's would put the checks at a savepoint
 * release, where they do not fire at all.
 *
 * ## Why confirming is one transaction and not two calls
 *
 * {@link confirmHolidayObservance} updates the observance's dates and state and inserts the announcement
 * in one transaction, because the database holds the two to each other: ZY293 refuses a confirmation whose
 * dates disagree with its observance, and ZY291 refuses a confirmed lunar observance with no announcement
 * behind it. Both are DEFERRED constraint triggers, so either order works inside the transaction and
 * neither works outside one. A two-call API would have a window in which a lunar date read as settled with
 * nothing on file, which is the state `reporting.calendar_observance`'s CHECK existed to make impossible.
 *
 * It returns the dates the observance HELD, because that is the other half of the impact report's input
 * and the caller would otherwise have to read them before the write and hope nothing moved in between.
 *
 * ## Why nothing here touches an appointment, a shift or a leave request
 *
 * ADR 0075: a confirmation reports its impact and mutates nothing. Moving a customer's appointment because
 * a holiday date changed is a decision with its own actor; this module has no actor and no business
 * inventing one. `packages/fixtures/src/hr-holiday-calendar.itest.ts` asserts the rows are byte-identical
 * across the confirmation, which is the acceptance line as a measurement rather than as a promise.
 */

/** The SQLSTATEs `0123_hr_holiday_calendar.sql` raises. */
export const HOLIDAY_CALENDAR_SQLSTATE = {
  /** A lunar-dated observance was confirmed with no `holiday_confirmation` naming the announcement. */
  lunarNotAnnounced: 'ZY291',
  /** A `holiday_confirmation` row was UPDATEd or DELETEd. */
  announcementAppendOnly: 'ZY292',
  /** A confirmation's dates or state disagree with the observance it names. */
  confirmationMismatch: 'ZY293',
  /** A `premises_hours_override` would leave an already-booked appointment outside trading hours. */
  overrideStrandsAppointment: 'ZY294',
} as const

/** `23505`: a second `holiday_confirmation` for one observance. */
const UNIQUE_VIOLATION = '23505'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from the holiday calendar into an `AppError`, or `null`.
 *
 * On SQLSTATE alone, for 0018's recorded reason: matching on the message makes the translation depend on
 * wording, and a wording change silently stops it working — after which the code that treats a stranded
 * booking as an unknown failure is the code that retries it.
 */
export function holidayCalendarError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case HOLIDAY_CALENDAR_SQLSTATE.announcementAppendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case HOLIDAY_CALENDAR_SQLSTATE.lunarNotAnnounced:
    case HOLIDAY_CALENDAR_SQLSTATE.confirmationMismatch:
      return new AppError('validation', message, { details: { sqlState: code } })
    case HOLIDAY_CALENDAR_SQLSTATE.overrideStrandsAppointment:
      // `conflict` and not `validation`: the override's own figures are fine and a BOOKING is in the way.
      // The answer is to move the appointments or narrow the range, which is a different thing to do from
      // correcting a time, and a caller that cannot tell them apart reports the wrong one.
      return new AppError('conflict', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      return new AppError('conflict', message, { details: { sqlState: code } })
    default:
      return null
  }
}

export function isHolidayOverrideStrandingRefusal(err: unknown): boolean {
  return sqlState(err) === HOLIDAY_CALENDAR_SQLSTATE.overrideStrandsAppointment
}

export function isLunarNotAnnouncedRefusal(err: unknown): boolean {
  return sqlState(err) === HOLIDAY_CALENDAR_SQLSTATE.lunarNotAnnounced
}

/**
 * True for a `postgres.js` TRANSACTION handle, which carries `savepoint`, and false for the pool.
 *
 * `frequency-ledger.ts` reads the same property for the same reason, and the reason is worth repeating:
 * a repository whose two writes must commit together has to be able to join a transaction the CALLER
 * already owns, or the caller ends up with two transactions and the pair can diverge. Given a
 * transaction this writes into it; given the pool it opens its own. There is no third shape in which the
 * observance and its announcement are written outside one transaction.
 *
 * It is also what lets a suite drive these functions inside a rolled-back probe:
 * `packages/fixtures/src/hr-holiday-calendar.itest.ts` has to, because `holiday_confirmation` is
 * append-only and pins its observance, so a committed confirmation can never be removed again.
 */
function isTransaction(sql: Sql): boolean {
  return typeof (sql as unknown as { savepoint?: unknown }).savepoint === 'function'
}

/**
 * Runs `body` in the caller's transaction when there is one, and in a new one otherwise.
 *
 * `tx as unknown as Sql` for the reason `withUnitOfWork` does it: postgres.js types a transaction handle
 * as `TransactionSql`, which is deliberately missing `END`, `CLOSE` and the pool's own members, and every
 * repository in this package takes `Sql`. The cast is at the seam and nowhere else.
 */
async function inOneTransaction<T>(sql: Sql, body: (tx: Sql) => Promise<T>): Promise<T> {
  if (isTransaction(sql)) return await body(sql)
  return (await sql.begin(async (tx) => await body(tx as unknown as Sql))) as T
}

// --- reads ---------------------------------------------------------------------------------------

/** One `holiday_observance` row. Dates are ISO `YYYY-MM-DD`. */
export interface HolidayObservanceRow {
  readonly id: string
  readonly kind: string
  readonly name: string
  readonly dateBasis: string
  readonly confirmationState: string
  readonly startsOn: string
  readonly endsOn: string
  readonly openQuestionId: string | null
  readonly source: string
}

/**
 * Every observance overlapping `[fromTradingDate, toTradingDate]`.
 *
 * OVERLAPPING and not contained: a two-day Eid whose first day is before the range still makes the range's
 * first day a holiday, and a containment predicate would answer `false` for exactly the row somebody
 * asked about. Ordered so two reads produce one list.
 */
export async function readHolidayObservances(
  sql: Sql,
  range: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly HolidayObservanceRow[]> {
  return await sql<HolidayObservanceRow[]>`
    select id::text                as "id",
           kind                    as "kind",
           name                    as "name",
           date_basis              as "dateBasis",
           confirmation_state      as "confirmationState",
           starts_on::text         as "startsOn",
           ends_on::text           as "endsOn",
           open_question_id        as "openQuestionId",
           source                  as "source"
      from holiday_observance
     where starts_on <= ${range.toTradingDate}::date
       and ends_on   >= ${range.fromTradingDate}::date
     order by starts_on, kind, name, id
  `
}

/** One `holiday_confirmation` row. */
export interface HolidayConfirmationRow {
  readonly id: string
  readonly observanceId: string
  readonly previousStartsOn: string
  readonly previousEndsOn: string
  readonly confirmedStartsOn: string
  readonly confirmedEndsOn: string
  readonly announcementSource: string
  readonly recordedBy: string
  readonly recordedAtIso: string
}

export async function readHolidayConfirmation(
  sql: Sql,
  observanceId: string,
): Promise<HolidayConfirmationRow | null> {
  const rows = await sql<HolidayConfirmationRow[]>`
    select id::text                        as "id",
           observance_id::text             as "observanceId",
           previous_starts_on::text        as "previousStartsOn",
           previous_ends_on::text          as "previousEndsOn",
           confirmed_starts_on::text       as "confirmedStartsOn",
           confirmed_ends_on::text         as "confirmedEndsOn",
           announcement_source             as "announcementSource",
           recorded_by                     as "recordedBy",
           to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "recordedAtIso"
      from holiday_confirmation
     where observance_id = ${observanceId}::uuid
  `
  return rows[0] ?? null
}

/** An appointment that holds its resources, over the dates an impact report is about. */
export interface HolidayImpactAppointmentRow {
  readonly appointmentId: string
  readonly tradingDate: string
}

/** A `shift_assignment` joined to its shift's trading date. */
export interface HolidayImpactShiftAssignmentRow {
  readonly shiftId: string
  readonly employeeId: string
  readonly tradingDate: string
}

/** One approved leave DAY. `employee_approved_leave` holds a period; this expands it per date. */
export interface HolidayImpactLeaveDayRow {
  readonly leaveRequestId: string
  readonly employeeId: string
  readonly tradingDate: string
}

export interface HolidayImpactRows {
  readonly appointments: readonly HolidayImpactAppointmentRow[]
  readonly shiftAssignments: readonly HolidayImpactShiftAssignmentRow[]
  readonly approvedLeave: readonly HolidayImpactLeaveDayRow[]
}

/**
 * Every row an impact report could be about: the appointments, shift assignments and approved leave days
 * over the UNION of the two date ranges.
 *
 * Both ranges, because the report has two sides — the dates the holiday left and the dates it arrived on —
 * and reading only the confirmed range would produce a report that could never say anything was released.
 * The pure function then decides which side each row falls on; this one decides nothing.
 *
 * `holds_resources` filters the appointments, so a cancelled or no-show visit is absent: it occupies
 * nothing and nobody has to act on it, and 0024 generates that column precisely so no reader has to spell
 * the status list.
 *
 * The leave read expands a period into DAYS, because a leave day is a calendar day (P-HR-08's own last
 * acceptance line) and a report keyed on a request would say "one request affected" about a fortnight.
 */
export async function readHolidayImpactRows(
  sql: Sql,
  ranges: {
    readonly previousStartsOn: string
    readonly previousEndsOn: string
    readonly confirmedStartsOn: string
    readonly confirmedEndsOn: string
  },
): Promise<HolidayImpactRows> {
  const [appointments, shiftAssignments, approvedLeave] = await Promise.all([
    sql<HolidayImpactAppointmentRow[]>`
      select id::text          as "appointmentId",
             trading_date::text as "tradingDate"
        from appointment
       where holds_resources
         and (trading_date between ${ranges.previousStartsOn}::date and ${ranges.previousEndsOn}::date
           or trading_date between ${ranges.confirmedStartsOn}::date and ${ranges.confirmedEndsOn}::date)
       order by trading_date, id
    `,
    sql<HolidayImpactShiftAssignmentRow[]>`
      select sa.shift_id::text    as "shiftId",
             sa.employee_id::text as "employeeId",
             s.trading_date::text as "tradingDate"
        from shift_assignment sa
        join shift s on s.id = sa.shift_id
       where s.trading_date between ${ranges.previousStartsOn}::date and ${ranges.previousEndsOn}::date
          or s.trading_date between ${ranges.confirmedStartsOn}::date and ${ranges.confirmedEndsOn}::date
       order by s.trading_date, sa.shift_id, sa.employee_id
    `,
    sql<HolidayImpactLeaveDayRow[]>`
      select l.leave_request_id::text as "leaveRequestId",
             l.employee_id::text      as "employeeId",
             d::date::text            as "tradingDate"
        from employee_approved_leave l
        cross join lateral generate_series(
          (lower(l.period) at time zone 'Asia/Dubai')::date,
          (upper(l.period) at time zone 'Asia/Dubai')::date - 1,
          interval '1 day'
        ) d
       where d::date between ${ranges.previousStartsOn}::date and ${ranges.previousEndsOn}::date
          or d::date between ${ranges.confirmedStartsOn}::date and ${ranges.confirmedEndsOn}::date
       order by d, l.leave_request_id, l.employee_id
    `,
  ])
  return { appointments, shiftAssignments, approvedLeave }
}

// --- writes --------------------------------------------------------------------------------------

export interface HolidayObservanceInput {
  readonly kind: 'public_holiday' | 'ramadan'
  readonly name: string
  readonly dateBasis: 'gregorian' | 'lunar'
  readonly confirmationState: 'provisional' | 'confirmed'
  readonly startsOn: string
  readonly endsOn: string
  /** Required on a provisional observance and refused on a confirmed one, by the database. */
  readonly openQuestionId: string | null
  readonly source: string
}

/**
 * Records an observance.
 *
 * It takes no date of its own and invents nothing: every field is the caller's. There is deliberately no
 * "seed the UAE public holidays" helper anywhere in this package — the dates are `Y9-holiday-calendar`,
 * and a function that produced them would be brief rule 15's "plausible is indistinguishable from
 * configured" with a convenient name on it.
 */
export async function recordHolidayObservance(
  sql: Sql,
  input: HolidayObservanceInput,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into holiday_observance
      (kind, name, date_basis, confirmation_state, starts_on, ends_on, open_question_id, source)
    values (
      ${input.kind}, ${input.name}, ${input.dateBasis}, ${input.confirmationState},
      ${input.startsOn}::date, ${input.endsOn}::date, ${input.openQuestionId}, ${input.source}
    )
    returning id::text as id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    throw new AppError('conflict', 'The observance insert returned no row')
  }
  return id
}

export interface HolidayConfirmationInput {
  readonly observanceId: string
  readonly confirmedStartsOn: string
  readonly confirmedEndsOn: string
  readonly announcementSource: string
  readonly recordedBy: string
}

/** What a confirmation moved: the dates the observance held, and the announcement's own id. */
export interface ConfirmedObservance {
  readonly confirmationId: string
  readonly previousStartsOn: string
  readonly previousEndsOn: string
  readonly confirmedStartsOn: string
  readonly confirmedEndsOn: string
}

/**
 * Confirms an observance onto its announced dates, in one transaction.
 *
 * `for update` on the read, because the previous dates are what the impact report is computed against and
 * two confirmations racing would otherwise both report against the same "previous" range — leaving one
 * report describing a move that never happened.
 *
 * The announcement is inserted AFTER the update, which reads naturally and is also the order the deferred
 * triggers make safe: both ZY291 and ZY293 fire at COMMIT, so neither row has to exist before the other.
 * An immediate trigger would have forced the opposite order and made the natural one impossible.
 */
export async function confirmHolidayObservance(
  sql: Sql,
  input: HolidayConfirmationInput,
): Promise<ConfirmedObservance> {
  return await inOneTransaction(sql, async (tx) => {
    const current = await tx<{ startsOn: string; endsOn: string; state: string }[]>`
      select starts_on::text as "startsOn", ends_on::text as "endsOn",
             confirmation_state as "state"
        from holiday_observance
       where id = ${input.observanceId}::uuid
         for update
    `
    const held = current[0]
    if (held === undefined) {
      throw new AppError('not_found', `No holiday observance ${input.observanceId}`)
    }
    if (held.state === 'confirmed') {
      // Not an update to a confirmed row: `holiday_confirmation` is append-only and unique per observance,
      // so a second announcement is a NEW observance naming the one it supersedes. Refused here with the
      // sentence that says what to do, rather than as a unique-violation at COMMIT.
      throw new AppError(
        'conflict',
        `Observance ${input.observanceId} is already confirmed. A re-announcement is a new observance ` +
          'superseding this one, because the announcement behind it is append-only (ZY292) and a report ' +
          'somebody acted on was read from it.',
      )
    }
    await tx`
      update holiday_observance
         set confirmation_state = 'confirmed',
             open_question_id   = null,
             starts_on          = ${input.confirmedStartsOn}::date,
             ends_on            = ${input.confirmedEndsOn}::date
       where id = ${input.observanceId}::uuid
    `
    const written = await tx<{ id: string }[]>`
      insert into holiday_confirmation
        (observance_id, previous_starts_on, previous_ends_on, confirmed_starts_on, confirmed_ends_on,
         announcement_source, recorded_by)
      values (
        ${input.observanceId}::uuid, ${held.startsOn}::date, ${held.endsOn}::date,
        ${input.confirmedStartsOn}::date, ${input.confirmedEndsOn}::date,
        ${input.announcementSource}, ${input.recordedBy}
      )
      returning id::text as id
    `
    const confirmationId = written[0]?.id
    if (confirmationId === undefined) {
      throw new AppError('conflict', 'The confirmation insert returned no row')
    }
    return {
      confirmationId,
      previousStartsOn: held.startsOn,
      previousEndsOn: held.endsOn,
      confirmedStartsOn: input.confirmedStartsOn,
      confirmedEndsOn: input.confirmedEndsOn,
    }
  })
}

// --- the hours override --------------------------------------------------------------------------

export interface HoursOverrideInput {
  readonly startsOn: string
  readonly endsOn: string
  /** Null means every date in the range; a number is a weekday, 0 = Sunday. */
  readonly dayOfWeek: number | null
  /** `HH:MM` or `HH:MM:SS`. */
  readonly openTime: string
  readonly closeTime: string
  readonly reason: string
}

export interface StrandedAppointmentRow {
  readonly appointmentId: string
  readonly tradingDate: string
}

/**
 * The appointments an override would leave outside trading hours, from the database's OWN rule.
 *
 * It calls `holiday_override_stranded_appointments`, which is the same function the ZY294 refusal calls.
 * That is deliberate and it is the whole reason the SQL function exists: a reader that computed its own
 * list would be a second statement of the rule, and the direction it would drift is the one where the
 * report comes back empty and the write still fails — leaving a screen saying "nothing is in the way"
 * beside an error saying something is.
 */
export async function readStrandedAppointmentsForOverride(
  sql: Sql,
  override: HoursOverrideInput,
): Promise<readonly StrandedAppointmentRow[]> {
  return await sql<StrandedAppointmentRow[]>`
    select appointment_id::text as "appointmentId",
           trading_date::text   as "tradingDate"
      from holiday_override_stranded_appointments(
        ${override.startsOn}::date, ${override.endsOn}::date,
        ${override.dayOfWeek}::smallint, ${override.openTime}::time, ${override.closeTime}::time)
  `
}

/** Either the override was written, or it was refused and these are the bookings in the way. */
export type HoursOverrideSaveResult =
  | { readonly saved: true; readonly overrideId: string }
  | { readonly saved: false; readonly strandedAppointments: readonly StrandedAppointmentRow[] }

/**
 * Saves a dated hours override, refusing it when it would strand a booking.
 *
 * The report comes BEFORE the write and is returned rather than thrown, because the acceptance line is
 * that the refusal "returns the conflicting appointment ids as an impact report" — a thrown error carries
 * a message, and a message is not a list anybody can render. The ZY294 trigger is still there and is the
 * backstop: this function is the one the application calls, and the refusal is what makes it impossible
 * to get round by calling something else. Both are exercised in
 * `packages/fixtures/src/hr-holiday-calendar.itest.ts`, the second by a raw insert.
 *
 * One transaction, so the check and the insert cannot be separated by another session's booking.
 */
export async function saveHoursOverride(
  sql: Sql,
  override: HoursOverrideInput,
): Promise<HoursOverrideSaveResult> {
  return await inOneTransaction(sql, async (tx) => {
    const stranded = await readStrandedAppointmentsForOverride(tx, override)
    if (stranded.length > 0) return { saved: false, strandedAppointments: stranded }
    const rows = await tx<{ id: string }[]>`
      insert into premises_hours_override
        (starts_on, ends_on, day_of_week, open_time, close_time, reason)
      values (
        ${override.startsOn}::date, ${override.endsOn}::date, ${override.dayOfWeek}::smallint,
        ${override.openTime}::time, ${override.closeTime}::time, ${override.reason}
      )
      returning id::text as id
    `
    const overrideId = rows[0]?.id
    if (overrideId === undefined) {
      throw new AppError('conflict', 'The hours override insert returned no row')
    }
    return { saved: true, overrideId }
  })
}

/** One `premises_hours_override` row, for the availability engine's hours lookup. */
export interface PremisesHoursOverrideRow {
  readonly id: string
  readonly startsOn: string
  readonly endsOn: string
  readonly dayOfWeek: number | null
  readonly openTime: string
  readonly closeTime: string
  readonly reason: string
}

/**
 * Every override overlapping the range, ordered by `starts_on`.
 *
 * The order is load-bearing: `hoursWithOverrides` in `packages/core` lets the LAST applicable override
 * win, so a narrower row entered later for the same range governs. Reading them in another order would
 * change which hours a date has, which is why the order is here and documented rather than incidental.
 */
export async function readPremisesHoursOverrides(
  sql: Sql,
  range: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly PremisesHoursOverrideRow[]> {
  return await sql<PremisesHoursOverrideRow[]>`
    select id::text              as "id",
           starts_on::text       as "startsOn",
           ends_on::text         as "endsOn",
           day_of_week           as "dayOfWeek",
           to_char(open_time, 'HH24:MI')  as "openTime",
           to_char(close_time, 'HH24:MI') as "closeTime",
           reason                as "reason"
      from premises_hours_override
     where starts_on <= ${range.toTradingDate}::date
       and ends_on   >= ${range.fromTradingDate}::date
     order by starts_on, id
  `
}

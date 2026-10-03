/**
 * When a win-back is due, measured on BUSINESS DAYS and never on calendar dates.
 *
 * C-AUTO-11. The acceptance line is a worked example and it is the whole module: *"a committed worked
 * example for a customer whose last visit ended at 01:30 measures from the previous business day, not the
 * calendar date"*.
 *
 * ## Why that example is the one the acceptance names
 *
 * Trading runs 11:00–02:00 (ADR 0007), so a treatment that ends at 01:30 belongs to the session that
 * opened at 11:00 the PREVIOUS calendar day. Every other figure in this build is dated that way —
 * `resolveTradingDate` is the one reading of it — and a win-back dated on the calendar date would:
 *
 *   - measure from a day the business was not open on the clock it was open on, and
 *   - give the late-evening customer one day LESS of grace than the afternoon customer, every time,
 *
 * and neither would look wrong. A 90-day win-back that fired on day 89 for roughly one visit in three is
 * the shape of defect nobody reports: the message is plausible, the customer is plausibly lapsed, and the
 * only evidence is a date column that reads one off.
 *
 * ## Why the interval is an argument and no figure appears here
 *
 * 90 days is C-AUTO-11's provisional value and lives in the F09 settings registry, where a provisional
 * figure can say it is one and reach the Unconfirmed Assumptions panel. `packages/core` reads no setting
 * and no clock, so every instant, the hours and the interval all arrive as arguments.
 *
 * ## Why an unresolvable last visit is a REFUSAL and not a date
 *
 * A visit whose end instant falls in no trading session at all — the premises was closed, or the instant
 * is between 02:00 and 11:00 — has no business day to measure from. Substituting the calendar date would
 * produce a due date that reconciles perfectly against a day nothing happened on, which is ADR 0070's
 * subject one unit along. So {@link winbackDue} answers `not_measurable` naming the reason, and a contact
 * in that state is not enrolled rather than enrolled from a guess.
 */
import {
  type HoursForDate,
  nextDate,
  resolveTradingDate,
  type TradingDateResolution,
} from '../business-day/resolve.ts'
import { ASIA_DUBAI, type Instant, type LocalDate, localDate, type TimeZone } from '../time.ts'

/** The OPEN-QUESTIONS id the win-back interval is provisional until. */
export const WINBACK_INTERVAL_OPEN_QUESTION = 'Y9-crm-pipeline'

/**
 * Days since the last completed visit's business day before a contact is won back. **90, provisional.**
 *
 * C-AUTO-11's own provisional value — *"win-back trigger at 90 days since last completed visit"* — and
 * not an interval this build chose. It is exported for the F09 registry's default and for a test; every
 * function here takes the figure as an argument and none of them reads this.
 */
export const PROVISIONAL_WINBACK_DAYS = 90

export type WinbackDecision =
  /** Due. `dueFrom` is the business day it was measured from, which is the fact a reader checks. */
  | {
      readonly kind: 'due'
      readonly lastVisitBusinessDay: LocalDate
      readonly dueOn: LocalDate
      readonly intervalDays: number
    }
  /** Not yet. The same two dates, so a screen can say how long is left without recomputing anything. */
  | {
      readonly kind: 'not_yet'
      readonly lastVisitBusinessDay: LocalDate
      readonly dueOn: LocalDate
      readonly intervalDays: number
    }
  /** Never visited. Not the same as "visited long ago": a win-back has nothing to win back. */
  | { readonly kind: 'never_visited' }
  /** The last visit's end instant belongs to no trading session. See the header. */
  | {
      readonly kind: 'not_measurable'
      readonly reason: 'premises_closed' | 'before_opening' | 'after_closing'
      readonly calendarDate: LocalDate
      readonly detail: string
    }

/**
 * The business day a visit's end instant belongs to, or a named reason why it belongs to none.
 *
 * A thin wrapper on {@link resolveTradingDate} and deliberately thin: there is ONE reading of "which
 * trading day did this instant happen on" in this build and this is not a second one. It exists so the
 * win-back's refusal carries the resolver's own reason rather than a boolean.
 */
export function visitBusinessDay(
  endedAt: Instant,
  hoursFor: HoursForDate,
  zone: TimeZone = ASIA_DUBAI,
): TradingDateResolution {
  return resolveTradingDate(endedAt, hoursFor, zone)
}

/**
 * `date` plus `days` calendar days, as a `LocalDate`.
 *
 * Calendar days forward from a BUSINESS day, which is the one place in this module where calendar
 * arithmetic is right: "90 days later" is ninety turns of the clock, not ninety trading sessions, and a
 * business that closes for a week does not thereby extend every customer's grace period by a week. What
 * the business day decides is the ORIGIN, and the origin is the half the calendar date gets wrong.
 *
 * `nextDate` from `business-day/resolve.ts` rather than string arithmetic of its own, so there is one
 * day-step in this package.
 */
export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days) || days < 0) {
    throw new RangeError(
      `A win-back interval must be a whole non-negative number of days, received ${days}. A fractional ` +
        'interval means the caller divided a figure, and a due date derived from an average is a date ' +
        'nobody can reconcile against the visit it was measured from.',
    )
  }
  let out = date
  for (let step = 0; step < days; step += 1) out = nextDate(out)
  return out
}

/**
 * Whether a contact is due a win-back, measured from the BUSINESS day of their last completed visit.
 *
 * `today` is the business day the decision is being taken on, supplied by the caller — the sweep resolves
 * it once for the whole pass with `resolveTradingDate`, so every contact in one pass is judged against
 * one day. A function that resolved it per contact would judge the first and the last contact of a long
 * pass against different days at 02:00.
 */
export function winbackDue(args: {
  /** When the last COMPLETED visit ended, or null for a contact who has never had one. */
  readonly lastVisitEndedAt: Instant | null
  readonly hoursFor: HoursForDate
  readonly today: LocalDate
  readonly intervalDays: number
  readonly zone?: TimeZone
}): WinbackDecision {
  if (args.lastVisitEndedAt === null) return { kind: 'never_visited' }

  const resolved = visitBusinessDay(args.lastVisitEndedAt, args.hoursFor, args.zone ?? ASIA_DUBAI)
  if (resolved.kind !== 'trading') {
    return {
      kind: 'not_measurable',
      reason: resolved.reason,
      calendarDate: resolved.calendarDate,
      detail:
        `The last visit ended at an instant in no trading session (${resolved.reason}, calendar date ` +
        `${resolved.calendarDate}), so there is no business day to measure ninety days from. Refusing ` +
        'rather than falling back to the calendar date: a substituted origin produces a due date that ' +
        'reconciles perfectly against a day nothing happened on.',
    }
  }

  const dueOn = addCalendarDays(resolved.date, args.intervalDays)
  // String comparison: ISO dates sort, and `localDate` has already validated both.
  const kind = args.today >= dueOn ? 'due' : 'not_yet'
  return {
    kind,
    lastVisitBusinessDay: resolved.date,
    dueOn,
    intervalDays: args.intervalDays,
  }
}

/**
 * The worked example the acceptance line asks to be COMMITTED, as a value rather than as prose.
 *
 * Exported so the test asserts the committed example rather than an example it wrote itself, and so a
 * reader can see the figure that is being claimed without running anything. 01:30 on 19 September 2026
 * is inside the session that opened at 11:00 on the 18th, so the origin is the 18th and the due date is
 * the 18th plus ninety days — 17 December 2026 — and NOT the 19th plus ninety.
 *
 * The one-day difference is the whole subject: dated on the calendar, this customer would be won back on
 * 18 December, a day late, and nothing on any screen would say so.
 */
export const WINBACK_WORKED_EXAMPLE = Object.freeze({
  lastVisitEndedAtIso: '2026-09-18T21:30:00.000Z',
  lastVisitLocal: '2026-09-19T01:30:00+04:00',
  intervalDays: PROVISIONAL_WINBACK_DAYS,
  businessDay: localDate('2026-09-18'),
  dueOn: localDate('2026-12-17'),
  /** What the calendar-dated answer would have been. Committed so the difference is visible. */
  calendarDatedWouldBe: localDate('2026-12-18'),
})

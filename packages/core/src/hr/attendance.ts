import { AppError } from '@berelax/shared'
import type { Period } from '../availability/room-predicates.ts'
import { ASIA_DUBAI, type Instant, type LocalDate, type TimeZone, toLocal } from '../time.ts'
import type { WorkingHoursRules } from './rates.ts'
import {
  mergePresences,
  type RosteredShift,
  summariseWorkedHours,
  type WorkedHoursSummary,
} from './working-hours.ts'

/**
 * Attendance against the published rota: what somebody actually did, measured against what was rostered,
 * and the payable minutes that come out of it. Pure.
 *
 * ## What this module is measured against, and why it is not `shift`
 *
 * **The published `rota_version`.** P-HR-06 deferred attendance variance here in exactly those words — the
 * immutable version *exists to be compared against* — and the reason is not tidiness. `shift` plus
 * `shift_assignment` is the DRAFT, and 0030 says a shift "IS deleted — an unpublished roster is rewritten".
 * A variance measured against it would change after the fact: move a Tuesday shift an hour later next month
 * and a therapist who was on time becomes an hour late on a day already approved and already paid. Every
 * function here therefore takes the ROSTER as an argument, and the one caller that supplies it supplies it
 * from `rota_version_assignment` — a table no UPDATE can reach (ZW001).
 *
 * The same argument makes the grace window an ARGUMENT rather than a literal, and a VERSIONED row rather
 * than an `app_setting` value: attendance is asked about the past more insistently than anything else in
 * this build. "Was she late on the 4th of March?" is a question about a day already approved, and one
 * current value cannot answer it — widening the window from five minutes to ten in April would make March's
 * lateness retroactively disappear, with nothing able to say what the window was when the timesheet was
 * approved. `attendance_grace_rule` (0086) holds the figures, versioned; {@link attendanceGraceFor} picks
 * the version governing a trading date, exactly as `rulesFor` and `rotaCoverageRulesFor` do next door.
 *
 * ## The three arithmetic mistakes this module exists not to make
 *
 *   1. **Measuring the machine's zone instead of the emirate's.** Trading runs 11:00–02:00, so a clock-out
 *      at 01:50 belongs to the trading date that opened at 11:00 the previous calendar day. Nothing here
 *      re-derives that: the trading date arrives on the punch, materialised by
 *      `attendance_trading_date_for()` in 0086 — one definition, in SQL, over the `business_day` calendar.
 *      {@link describeAttendanceInstant} renders the local TIME beside the local DATE precisely so that an
 *      assertion cannot pass by measuring `toISOString()`, which reports the previous day for a 00:00-Dubai
 *      instant and would make a wrong test look right. P-HR-06 had a case pass for that reason.
 *   2. **Closing an open presence at the end of the day.** A clock-in with no clock-out is not a shift that
 *      ended at close; it is a shift whose end is unknown. Guessing close would pay whatever the window
 *      happened to be, and the figure would look ordinary. An INCOMPLETE span is EXCLUDED from the minutes
 *      computation rather than truncated, which is what makes "contributes zero payable minutes" structural
 *      rather than a subtraction somebody can forget.
 *   3. **Computing minutes twice.** {@link summariseTimesheet} does no minute arithmetic of its own: it
 *      hands the attended presences to P-HR-05's {@link summariseWorkedHours} and reports what comes back.
 *      That is why "approved payable minutes equal the sum of the P-HR-05 buckets" holds by construction —
 *      the buckets are a partition of the total by that module's own property — instead of being a
 *      coincidence between two implementations that will drift, and the drift would be a wrong payslip.
 *
 * ## Why an outcome is one value with a precedence, and what is never lost by that
 *
 * A span can be late AND short. The outcome is a single value because the acceptance criterion asks for one
 * case per outcome and a screen prints one badge, so {@link deriveAttendanceVariance} applies a stated
 * precedence — and it reports `lateByMinutes` and `earlyLeaveByMinutes` as NUMBERS on every row whatever the
 * outcome is. So nothing the precedence hides is unavailable. `dearestBucket` in `./rates.ts` takes the same
 * shape for the same reason.
 */

/**
 * Every verdict a rostered span or an attended presence can carry.
 *
 * Five of the six are the acceptance criterion's. `INCOMPLETE` is the sixth and it is not a variance but an
 * absence of evidence: you cannot say whether somebody left early when you do not know when they left, so a
 * verdict of `EARLY_LEAVE` on a span with no clock-out would be half an answer presented as a whole one.
 */
export const ATTENDANCE_OUTCOMES = [
  'ON_TIME',
  'LATE',
  'EARLY_LEAVE',
  'ABSENT',
  'UNROSTERED',
  'INCOMPLETE',
] as const

export type AttendanceOutcome = (typeof ATTENDANCE_OUTCOMES)[number]

/** Why a span is `INCOMPLETE`. A closed set, mirrored by a CHECK on `attendance_correction` in 0086. */
export const INCOMPLETE_REASONS = ['missing_clock_out', 'implausible_span'] as const

export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number]

/** A punch, exactly as `attendance_event` holds it. */
export interface AttendancePunch {
  readonly eventId: string
  readonly employeeId: string
  /**
   * The trading date the punch was attributed to, from `attendance_event.trading_date`.
   *
   * Never re-derived here. `attendance_trading_date_for()` in 0086 is the one definition and the insert
   * trigger refuses a row whose column disagrees with it, so a second reading in this module would be a
   * second answer to "which day is it" — the mistake `working-hours.ts` names as the one this subject is
   * most likely to ship.
   */
  readonly tradingDate: LocalDate
  readonly kind: 'clock_in' | 'clock_out'
  readonly occurredAt: Instant
  /**
   * The `attendance_correction` this punch's instant came from, when it did not come from the punch itself.
   *
   * Set by {@link applyAttendanceCorrections} and never by a read of `attendance_event`, which holds no such
   * column: a correction produces no punch row (0086), so this is the ONE place a corrected instant becomes a
   * punch, and the id is carried so a screen can say that a day was corrected and by which row rather than
   * showing a figure that silently differs from the punch underneath it.
   */
  readonly correctionId: string | null
}

/** One row of `attendance_correction` (0086), reduced to what the layering needs. */
export interface AttendanceCorrection {
  readonly correctionId: string
  readonly employeeId: string
  readonly tradingDate: LocalDate
  /** The day the correction is ABOUT is `tradingDate`; the day it is POSTED on is this one. */
  readonly adjustmentDate: LocalDate
  readonly kind: 'supply_missing_clock_out' | 'amend_punch_instant'
  readonly correctsEventId: string
  readonly correctedOccurredAt: Instant
}

/** One clock-in, and the clock-out that closed it if there was one. */
export interface AttendedPresence {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly startsAt: Instant
  /** Null when no clock-out closed this clock-in. The span is then `INCOMPLETE`. */
  readonly endsAt: Instant | null
  readonly clockInEventId: string
  readonly clockOutEventId: string | null
}

/** One rostered span, taken from `rota_version_assignment` and never from `shift`. */
export interface RosteredSpan {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly startsAt: Instant
  readonly endsAt: Instant
}

/** One version of `attendance_grace_rule` (0086). Every figure is provisional against Y9-attendance. */
export interface AttendanceGraceRules {
  readonly effectiveFrom: LocalDate
  /** Minutes after the rostered start a clock-in may be and still be `ON_TIME`. */
  readonly graceMinutesAfterStart: number
  /** Minutes before the rostered end a clock-out may be and still be `ON_TIME`. */
  readonly graceMinutesBeforeEnd: number
  /**
   * The span above which a clock-in and a clock-out are not believed to be one presence.
   *
   * The acceptance criterion's "never yields an implausible >12h shift" is this figure doing its work: a
   * therapist who forgot to clock out on Friday and clocked out on Saturday morning produces a pair
   * spanning eighteen hours, and paying it is worse than refusing to price it. Such a span becomes
   * `INCOMPLETE` with `implausible_span` and contributes nothing until a correction says what happened.
   */
  readonly maximumPlausiblePresenceMinutes: number
  /**
   * How far outside a trading day's own window a punch may fall and still be attributed to it.
   *
   * Not a variance figure — it is what `attendance_trading_date_for()` widens the window by, and it lives
   * here so the widening is versioned with the rest. A therapist arriving before the doors open and a front
   * desk clocking out after the cash-up are both ordinary, and a guard that refused them would refuse the
   * truth.
   */
  readonly punchToleranceMinutes: number
}

/** One rostered span, or one unrostered presence, judged. */
export interface AttendanceVariance {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly outcome: AttendanceOutcome
  /** Set exactly when `outcome` is `INCOMPLETE`. */
  readonly incompleteReason: IncompleteReason | null
  /** Minutes past the rostered start the first clock-in was, past the grace window. 0 when unrostered. */
  readonly lateByMinutes: number
  /** Minutes before the rostered end the last clock-out was, past the grace window. 0 when unknown. */
  readonly earlyLeaveByMinutes: number
  /** The rostered span's minutes. 0 for `UNROSTERED`. */
  readonly rosteredMinutes: number
  /**
   * The minutes that go forward to be priced. Zero for `ABSENT` and for `INCOMPLETE`.
   *
   * Reported here for the screen, and NOT the figure a timesheet is approved on: that one comes back from
   * P-HR-05's bucket split in {@link summariseTimesheet}, over these very presences.
   */
  readonly attendedMinutes: number
  /**
   * The presences this row is about, chronologically. Empty exactly for `ABSENT`.
   *
   * A list and not a pair, because a therapist who clocked out for lunch and back in worked TWO presences
   * against one rostered span, and a row holding one pair could only describe one of them. The list is also
   * what {@link payablePresences} prices, so a reader can see that the minutes come from the punches rather
   * than from a figure computed beside them.
   */
  readonly presences: readonly AttendedPresence[]
}

export interface TimesheetSummary {
  readonly employeeId: string
  readonly fromTradingDate: LocalDate
  readonly toTradingDate: LocalDate
  readonly variances: readonly AttendanceVariance[]
  /** P-HR-05's answer over the attended presences, in full: days, weeks and its three violations. */
  readonly workedHours: WorkedHoursSummary
  /** `sum(workedHours.days[].totalMinutes)`. The figure `timesheet_approval.payable_minutes` stores. */
  readonly payableMinutes: number
  /** `sum(workedHours.days[].weightedMinuteBp)`. Whole basis-point-minutes, never money. */
  readonly weightedMinuteBp: number
  /** How many spans contributed nothing because an end was unknown or not believed. */
  readonly incompletePresenceCount: number
}

const MINUTE = 60_000

function assertGraceRules(rules: AttendanceGraceRules): void {
  const figures: readonly [string, number][] = [
    ['graceMinutesAfterStart', rules.graceMinutesAfterStart],
    ['graceMinutesBeforeEnd', rules.graceMinutesBeforeEnd],
    ['maximumPlausiblePresenceMinutes', rules.maximumPlausiblePresenceMinutes],
    ['punchToleranceMinutes', rules.punchToleranceMinutes],
  ]
  for (const [name, value] of figures) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AppError(
        'validation',
        `Attendance grace rule ${name} must be a whole number of minutes and not negative, got ${value}`,
      )
    }
  }
  if (rules.maximumPlausiblePresenceMinutes === 0) {
    throw new AppError(
      'validation',
      'A maximum plausible presence of zero minutes makes every presence implausible, so every clock-out ' +
        'is disbelieved and nobody is ever paid. Zero is not the strict reading of this figure — it is the ' +
        'one that silently pays nothing.',
    )
  }
}

/**
 * The grace version governing a trading date: the latest row at or before it.
 *
 * `rulesFor` in `./rates.ts` and `rotaCoverageRulesFor` in `./rota-validator.ts` take the same shape, and so
 * does the reason. A trading date BEFORE every version throws rather than falling back to the earliest: a
 * fallback would judge a day by a standard that did not exist then, and a timesheet approved that way would
 * record a verdict nobody set.
 */
export function attendanceGraceFor(
  versions: readonly AttendanceGraceRules[],
  tradingDate: LocalDate,
): AttendanceGraceRules {
  if (versions.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No attendance grace rule version exists, so how late is late is unknown. 0086 seeds version 1 ' +
        'flagged provisional against Y9-attendance. Attendance measured against no grace window is ' +
        'attendance nothing was ever judged against.',
    )
  }
  const ordered = [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
  let governing: AttendanceGraceRules | undefined
  for (const version of ordered) {
    if (version.effectiveFrom <= tradingDate) governing = version
  }
  if (governing === undefined) {
    throw new AppError(
      'invariant_violated',
      `No attendance grace rule version takes effect on or before ${tradingDate}; the earliest is ` +
        `${String(ordered[0]?.effectiveFrom)}. Judging that day by a later version would record a verdict ` +
        'against a standard that did not exist when it was worked.',
    )
  }
  assertGraceRules(governing)
  return governing
}

/**
 * A punch's wall clock in the business zone, as `YYYY-MM-DD HH:MM`, beside the trading date it was filed
 * under.
 *
 * This exists because of one measured failure. `toISOString()` on a 00:00-Dubai instant reports the PREVIOUS
 * calendar day, so an assertion written against it measures the machine's zone while claiming to measure the
 * emirate's — and P-HR-06 had a case pass for exactly that wrong reason. A test asserting this string is
 * asserting the local TIME as well as the local date, which the UTC rendering cannot accidentally satisfy:
 * 01:50 Dubai is 21:50 UTC the day before, and the two strings agree on neither field.
 */
export function describeAttendanceInstant(
  instant: Instant,
  tradingDate: LocalDate,
  zone: TimeZone = ASIA_DUBAI,
): string {
  const local = toLocal(instant, zone)
  return `${local.date} ${local.time} (trading date ${tradingDate})`
}

/**
 * The punches as corrected: the layer `attendance_correction` puts over `attendance_event`.
 *
 * A correction writes NO punch row (0086's comment on `corrected_occurred_at` says why: the punch would be
 * dated inside the very period the correction exists to work around, and the same fact in two places means a
 * reader that found one and not the other reports a corrected day as an ordinary one). So the corrections are
 * applied HERE, once, and everything downstream — pairing, variance, pricing — sees one list.
 *
 * Two kinds, and each is exactly one edit to the list:
 *
 *   * **`amend_punch_instant`** moves an existing punch. The punch keeps its own `eventId`, because it is
 *     still that punch, and picks up `correctionId` so the change is visible.
 *   * **`supply_missing_clock_out`** adds a clock-out that was never punched. Its `eventId` is
 *     `correction:<id>` and NOT a uuid, deliberately: an identifier that looked like an `attendance_event.id`
 *     would be one somebody could go looking for and not find, and the prefix says where it came from in the
 *     one place a reader would ask.
 *
 * A correction naming a punch that is not in the list is refused rather than ignored. `corrects_event_id` is
 * a foreign key, so the punch exists — which means an absence here is a caller that read a narrower range
 * than it corrected, and silently dropping the correction would report an INCOMPLETE day that had been
 * settled weeks ago.
 */
export function applyAttendanceCorrections(
  punches: readonly AttendancePunch[],
  corrections: readonly AttendanceCorrection[],
): readonly AttendancePunch[] {
  const byEvent = new Map(punches.map((punch) => [punch.eventId, punch]))
  const amended = new Map<string, AttendancePunch>()
  const supplied: AttendancePunch[] = []

  for (const correction of corrections) {
    const target = byEvent.get(correction.correctsEventId)
    if (target === undefined) {
      throw new AppError(
        'invariant_violated',
        `Correction ${correction.correctionId} amends punch ${correction.correctsEventId}, which is not in ` +
          'the punch list it is being applied to. `corrects_event_id` is a foreign key so the punch exists ' +
          '— this is a caller that read a narrower range of punches than of corrections, and dropping the ' +
          'correction would report a day as INCOMPLETE weeks after it was settled.',
      )
    }
    if (correction.kind === 'amend_punch_instant') {
      amended.set(target.eventId, {
        ...target,
        occurredAt: correction.correctedOccurredAt,
        correctionId: correction.correctionId,
      })
      continue
    }
    supplied.push({
      eventId: `correction:${correction.correctionId}`,
      employeeId: target.employeeId,
      tradingDate: target.tradingDate,
      kind: 'clock_out',
      occurredAt: correction.correctedOccurredAt,
      correctionId: correction.correctionId,
    })
  }

  return [...punches.map((punch) => amended.get(punch.eventId) ?? punch), ...supplied]
}

/**
 * Punches paired into presences, per employee per trading date, chronologically.
 *
 * `attendance_event` carries one row per punch and `assert_attendance_punch_alternates` (ZX002) refuses a
 * clock-in while one is open and a clock-out while none is — so a day's punches alternate by construction
 * and pairing is a walk rather than a reconciliation. This function nevertheless refuses a sequence that does
 * not alternate, because a `psql` session with owner rights can reach past the trigger and because a pairing
 * that silently skipped a stray punch would drop a whole presence from somebody's pay.
 *
 * A trailing clock-in becomes a presence with `endsAt` null. That is the INCOMPLETE case and it is
 * deliberately NOT closed at the end of the trading day: a guessed end pays whatever the window happened to
 * be, and the figure looks ordinary.
 */
export function pairAttendancePunches(
  punches: readonly AttendancePunch[],
): readonly AttendedPresence[] {
  const byDay = new Map<string, AttendancePunch[]>()
  for (const punch of punches) {
    const key = `${punch.employeeId}\u0000${punch.tradingDate}`
    const held = byDay.get(key)
    if (held === undefined) byDay.set(key, [punch])
    else held.push(punch)
  }

  const presences: AttendedPresence[] = []
  for (const key of [...byDay.keys()].sort()) {
    const ordered = [...(byDay.get(key) as AttendancePunch[])].sort(
      (a, b) =>
        a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
    )
    let open: AttendancePunch | null = null
    for (const punch of ordered) {
      if (punch.kind === 'clock_in') {
        if (open !== null) {
          throw new AppError(
            'invariant_violated',
            `Employee ${punch.employeeId} has two clock-ins on ${punch.tradingDate} with no clock-out ` +
              `between them (${open.eventId} then ${punch.eventId}). ZX002 refuses this at INSERT, so a ` +
              'sequence holding it was written past the trigger — and pairing it by guessing which punch ' +
              'to drop would drop a whole presence from somebody’s pay.',
          )
        }
        open = punch
        continue
      }
      if (open === null) {
        throw new AppError(
          'invariant_violated',
          `Employee ${punch.employeeId} has a clock-out on ${punch.tradingDate} (${punch.eventId}) with ` +
            'no clock-in open. ZX002 refuses this at INSERT.',
        )
      }
      presences.push({
        employeeId: open.employeeId,
        tradingDate: open.tradingDate,
        startsAt: open.occurredAt,
        endsAt: punch.occurredAt,
        clockInEventId: open.eventId,
        clockOutEventId: punch.eventId,
      })
      open = null
    }
    if (open !== null) {
      presences.push({
        employeeId: open.employeeId,
        tradingDate: open.tradingDate,
        startsAt: open.occurredAt,
        endsAt: null,
        clockInEventId: open.eventId,
        clockOutEventId: null,
      })
    }
  }
  return presences
}

function dayKey(employeeId: string, tradingDate: LocalDate): string {
  return `${employeeId}\u0000${tradingDate}`
}

/** Rows bucketed by `(employeeId, tradingDate)`, insertion order kept inside each bucket. */
function groupByDay<T extends { readonly employeeId: string; readonly tradingDate: LocalDate }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const key = dayKey(row.employeeId, row.tradingDate)
    const held = grouped.get(key)
    if (held === undefined) grouped.set(key, [row])
    else held.push(row)
  }
  return grouped
}

/** Minutes between two instants, refusing a boundary off a whole minute for `workedMinutes`'s reason. */
function minutesBetween(later: Instant, earlier: Instant): number {
  const milliseconds = later - earlier
  if (milliseconds % MINUTE !== 0) {
    throw new AppError(
      'validation',
      `An attendance boundary must fall on a whole minute; this span is ${milliseconds}ms. Rounding it ` +
        'would create or destroy paid time by a few seconds per punch, which reconciles to nothing. ' +
        '`attendance_event_occurred_on_whole_minute` refuses such a punch, so a span holding one came from ' +
        'somewhere other than the table.',
    )
  }
  return milliseconds / MINUTE
}

/**
 * One rostered span and every presence matched to it, judged.
 *
 * The precedence, stated once because it is a judgement and not an implementation detail:
 *
 *   1. **`ABSENT`** — a rostered span no presence overlapped at all.
 *   2. **`INCOMPLETE`** — an end is unknown (`missing_clock_out`) or not believed (`implausible_span`).
 *      Before `LATE`, because a span whose total is unknown cannot be priced at all and a badge saying `LATE`
 *      would suggest the day had been measured.
 *
 *      **Before `UNROSTERED` too**, and that ordering was wrong in this function's first version — which is
 *      worth recording because only the integration run found it. An unrostered presence with no clock-out is
 *      both things at once, and `UNROSTERED` first made it a PAYABLE row with an unknown end, so
 *      {@link payablePresences} threw its structural guard and a 503 reached the timesheet screen for an
 *      ordinary case: somebody clocked in a few minutes early and forgot to clock out. Nothing is lost by the
 *      order, because such a row carries `rosteredMinutes: 0`, which is what `UNROSTERED` says.
 *   3. **`UNROSTERED`** — attended, complete, and the published rota rostered nobody over any of it.
 *   4. **`LATE`** before **`EARLY_LEAVE`** — of the two, a late arrival is the one the rota was published to
 *      prevent and the one a waiting client experiences. Reporting the earlier deviation first is also what
 *      makes a day's list read chronologically.
 *   5. **`ON_TIME`** — both ends inside the grace windows.
 *
 * Both minute figures are on every row whatever the outcome, so the precedence hides no number.
 *
 * ## Which end is measured when a span holds several presences
 *
 * Lateness from the FIRST presence's clock-in and early leaving from the LAST one's clock-out. A therapist
 * who clocked out for lunch and back in is neither late nor early, and a per-presence reading would report
 * the afternoon return as a late arrival and the lunch break as an early departure — two variances for one
 * ordinary day. The attended minutes are the SUM, so the break is excluded from pay, which is what clocking
 * out for it means.
 */
interface PresenceScan {
  /** The first reason found, in this order: an unknown end is a stronger statement than a disbelieved one,
   * because a missing clock-out is a fact about the record and an implausible span is a judgement about it. */
  readonly incompleteReason: IncompleteReason | null
  /** The sum over the presences that WERE believed. Discarded when `incompleteReason` is set. */
  readonly believedMinutes: number
}

function scanPresences(
  presences: readonly AttendedPresence[],
  rules: AttendanceGraceRules,
): PresenceScan {
  let incompleteReason: IncompleteReason | null = null
  let believedMinutes = 0
  for (const presence of presences) {
    if (presence.endsAt === null) {
      incompleteReason ??= 'missing_clock_out'
      continue
    }
    const span = minutesBetween(presence.endsAt, presence.startsAt)
    if (span > rules.maximumPlausiblePresenceMinutes) {
      incompleteReason ??= 'implausible_span'
      continue
    }
    believedMinutes += span
  }
  return { incompleteReason, believedMinutes }
}

function absentVariance(args: {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly rostered: RosteredSpan | null
  readonly rosteredMinutes: number
}): AttendanceVariance {
  if (args.rostered === null) {
    throw new AppError(
      'invariant_violated',
      `Asked for ${args.employeeId}'s variance on ${args.tradingDate} with neither a rostered span nor a ` +
        'punch. A day with nothing on either side is not an absence — it is a day nobody asked about, and ' +
        'reporting it as ABSENT would put every therapist on every closed date on the exception list.',
    )
  }
  return {
    employeeId: args.employeeId,
    tradingDate: args.tradingDate,
    outcome: 'ABSENT',
    incompleteReason: null,
    lateByMinutes: 0,
    earlyLeaveByMinutes: 0,
    rosteredMinutes: args.rosteredMinutes,
    attendedMinutes: 0,
    presences: [],
  }
}

function varianceOfSpan(args: {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly rostered: RosteredSpan | null
  readonly presences: readonly AttendedPresence[]
  readonly rules: AttendanceGraceRules
}): AttendanceVariance {
  const { employeeId, tradingDate, rostered, presences, rules } = args
  const rosteredMinutes = rostered === null ? 0 : minutesBetween(rostered.endsAt, rostered.startsAt)

  if (presences.length === 0) {
    return absentVariance({ employeeId, tradingDate, rostered, rosteredMinutes })
  }

  const first = presences[0] as AttendedPresence
  const last = presences[presences.length - 1] as AttendedPresence
  const { incompleteReason, believedMinutes } = scanPresences(presences, rules)

  // Measured against the rostered span whenever there is one, INCLUDING for an incomplete span: the clock-in
  // is known, so "she arrived forty minutes late and forgot to clock out" is two facts and the second must
  // not erase the first.
  const lateBy =
    rostered === null
      ? 0
      : Math.max(
          0,
          minutesBetween(first.startsAt, rostered.startsAt) - rules.graceMinutesAfterStart,
        )
  const earlyLeaveBy =
    rostered === null || last.endsAt === null || incompleteReason !== null
      ? 0
      : Math.max(0, minutesBetween(rostered.endsAt, last.endsAt) - rules.graceMinutesBeforeEnd)

  const outcome: AttendanceOutcome =
    incompleteReason !== null
      ? 'INCOMPLETE'
      : rostered === null
        ? 'UNROSTERED'
        : lateBy > 0
          ? 'LATE'
          : earlyLeaveBy > 0
            ? 'EARLY_LEAVE'
            : 'ON_TIME'

  return {
    employeeId,
    tradingDate,
    outcome,
    incompleteReason,
    lateByMinutes: lateBy,
    earlyLeaveByMinutes: earlyLeaveBy,
    rosteredMinutes,
    // Zero for an INCOMPLETE span, and zero by EXCLUSION rather than by subtraction — its presences never
    // reach the minutes computation at all (see `payablePresences`), so there is no path by which an unknown
    // end contributes a figure.
    attendedMinutes: incompleteReason === null ? believedMinutes : 0,
    presences,
  }
}

export interface DeriveAttendanceVarianceArgs {
  /** From `rota_version_assignment`: what the IMMUTABLE published rota said, never what `shift` says. */
  readonly rostered: readonly RosteredSpan[]
  /** Straight from `attendance_event`, uncorrected. */
  readonly punches: readonly AttendancePunch[]
  /**
   * From `attendance_correction`. Applied HERE rather than by the caller, and that is deliberate: a caller
   * that forgot them would report a day as INCOMPLETE weeks after it was settled, and the figure would look
   * ordinary. One reader of "what actually happened", so there is nothing for two callers to disagree about.
   */
  readonly corrections: readonly AttendanceCorrection[]
  /** Every version, oldest first. The one governing each trading date is chosen per day. */
  readonly graceRuleVersions: readonly AttendanceGraceRules[]
}

/**
 * True when a rostered span and a presence share an instant.
 *
 * An OPEN presence — one with no clock-out — is matched on its start alone: it belongs to the span if it did
 * not begin after that span had finished. The obvious alternative, treating it as one minute wide, was this
 * function's first version and the integration run found what it costs: a therapist who clocks in eight
 * minutes before an 11:00 shift and forgets to clock out has a presence that overlaps nothing, so the day came
 * back `UNROSTERED` rather than as the incomplete shift it is. An unknown end cannot be used to exclude a
 * span, only to leave the span unpriced.
 */
function overlaps(rostered: RosteredSpan, presence: AttendedPresence): boolean {
  if (presence.endsAt === null) return presence.startsAt < rostered.endsAt
  return presence.startsAt < rostered.endsAt && rostered.startsAt < presence.endsAt
}

/**
 * The rostered spans of one employee on one trading date, merged.
 *
 * {@link mergePresences} is `working-hours.ts`'s reading of 0030 and has to be the same reading here: a
 * roster written as 18:00–22:00 plus 22:00–02:00 is ONE presence, and measuring lateness against the second
 * half would report a therapist four hours late for a shift she was on time for. Two spans with a real gap
 * stay two spans and each is measured on its own, which is why a morning-plus-evening day reports the
 * morning ON_TIME and the evening ABSENT rather than refusing the whole day for having no single start.
 */
function mergedRosteredSpans(spans: readonly RosteredSpan[]): readonly RosteredSpan[] {
  const first = spans[0] as RosteredSpan
  return mergePresences(
    spans.map(
      (span, index): RosteredShift => ({
        shiftId: `${span.employeeId}#${index}`,
        employeeId: span.employeeId,
        tradingDate: span.tradingDate,
        period: { startsAt: span.startsAt, endsAt: span.endsAt } as Period,
      }),
    ),
  ).map((presence) => ({
    employeeId: first.employeeId,
    tradingDate: first.tradingDate,
    startsAt: presence.period.startsAt,
    endsAt: presence.period.endsAt,
  }))
}

/**
 * Every rostered span and every attended presence of a period, matched and judged. Ordered by employee, then
 * trading date, then span start.
 *
 * Matching is by OVERLAP and nothing else. A presence overlapping no rostered span is `UNROSTERED`; a span
 * no presence overlaps is `ABSENT`; several presences overlapping one span are that span's. Deliberately not
 * "the nearest span", which is the version that looks more forgiving and is worse: a presence three hours
 * from anything rostered would be attached to a span it has nothing to do with and reported as three hours
 * late, and the row would then name a shift the person was never on.
 *
 * A presence overlapping TWO rostered spans is matched to the earlier one only. Counting it twice would
 * double the minutes it contributes, which is `mergePresences`'s reason for existing one module along.
 */
export function deriveAttendanceVariance(
  args: DeriveAttendanceVarianceArgs,
): readonly AttendanceVariance[] {
  const mergedByDay = new Map<string, readonly RosteredSpan[]>()
  for (const [key, spans] of groupByDay(args.rostered)) {
    mergedByDay.set(key, mergedRosteredSpans(spans))
  }
  const attendedByDay = groupByDay(
    pairAttendancePunches(applyAttendanceCorrections(args.punches, args.corrections)),
  )

  const keys = new Set<string>([...mergedByDay.keys(), ...attendedByDay.keys()])
  const variances: AttendanceVariance[] = []
  for (const key of [...keys].sort()) {
    const [employeeId, tradingDate] = key.split('\u0000') as [string, LocalDate]
    const rules = attendanceGraceFor(args.graceRuleVersions, tradingDate)
    const spans = [...(mergedByDay.get(key) ?? [])].sort((a, b) => a.startsAt - b.startsAt)
    const presences = [...(attendedByDay.get(key) ?? [])].sort((a, b) => a.startsAt - b.startsAt)

    const matched = new Set<string>()
    for (const span of spans) {
      const mine = presences.filter(
        (presence) => !matched.has(presence.clockInEventId) && overlaps(span, presence),
      )
      for (const presence of mine) matched.add(presence.clockInEventId)
      variances.push(
        varianceOfSpan({ employeeId, tradingDate, rostered: span, presences: mine, rules }),
      )
    }
    for (const presence of presences) {
      if (matched.has(presence.clockInEventId)) continue
      variances.push(
        varianceOfSpan({ employeeId, tradingDate, rostered: null, presences: [presence], rules }),
      )
    }
  }
  return variances
}

/**
 * The presences that go forward to be priced: everything except `ABSENT` and `INCOMPLETE`.
 *
 * Exported because it is the join between this module and P-HR-05's, and because the exclusion IS the
 * acceptance criterion "contributes zero payable minutes" — a reader should be able to see that an
 * incomplete span is absent from the list rather than subtracted from a total afterwards.
 */
export function payablePresences(
  variances: readonly AttendanceVariance[],
): readonly RosteredShift[] {
  const shifts: RosteredShift[] = []
  for (const variance of variances) {
    if (variance.outcome === 'ABSENT' || variance.outcome === 'INCOMPLETE') continue
    for (const presence of variance.presences) {
      if (presence.endsAt === null) {
        throw new AppError(
          'invariant_violated',
          `Variance for ${variance.employeeId} on ${variance.tradingDate} is ${variance.outcome} and holds ` +
            `a presence with no clock-out (${presence.clockInEventId}). Only INCOMPLETE rows may hold one ` +
            'and they are excluded above, so this is the exclusion having been lost — the one way an ' +
            'unknown end could reach a payslip.',
        )
      }
      shifts.push({
        // The clock-in's event id, which is what a payable minute is traceable to here — NOT a `shift.id`.
        // Payroll pays attendance and never the roster (0081's own comment on `labour_cost_rule`), so the
        // identifier on a priced span has to be the punch that evidences it.
        shiftId: presence.clockInEventId,
        employeeId: presence.employeeId,
        tradingDate: presence.tradingDate,
        period: { startsAt: presence.startsAt, endsAt: presence.endsAt } as Period,
      })
    }
  }
  return shifts
}

export interface SummariseTimesheetArgs extends DeriveAttendanceVarianceArgs {
  readonly employeeId: string
  readonly fromTradingDate: LocalDate
  readonly toTradingDate: LocalDate
  /** P-HR-05's versioned rates. Passed through untouched: this module prices nothing itself. */
  readonly workingHoursRuleVersions: readonly WorkingHoursRules[]
  readonly publicHolidays?: ReadonlySet<LocalDate>
  readonly zone?: TimeZone
}

/**
 * One employee's timesheet for a period: the variances, and the payable minutes P-HR-05 computed.
 *
 * **No minute arithmetic happens here.** The attended presences go to {@link summariseWorkedHours} and the
 * totals come back out of its per-day rows. That is the whole of the acceptance criterion "approved payable
 * minutes equal the sum of the P-HR-05 buckets for the same employee and period": the buckets are a
 * PARTITION of the total in that module — each minute counted once, in the dearest bucket that applies — so
 * the equality holds by construction rather than as an agreement between two implementations. An independent
 * sum here would be the second reading that drifts, and its drift would be a wrong payslip.
 *
 * Every argument is filtered to `employeeId` and to the period rather than trusted, because a caller passing
 * a whole month's punches would otherwise get a figure whose label said one week.
 */
export function summariseTimesheet(args: SummariseTimesheetArgs): TimesheetSummary {
  if (args.toTradingDate < args.fromTradingDate) {
    throw new AppError(
      'validation',
      `A timesheet period ends (${args.toTradingDate}) before it starts (${args.fromTradingDate})`,
    )
  }
  const inScope = (employeeId: string, tradingDate: LocalDate): boolean =>
    employeeId === args.employeeId &&
    tradingDate >= args.fromTradingDate &&
    tradingDate <= args.toTradingDate

  const variances = deriveAttendanceVariance({
    rostered: args.rostered.filter((span) => inScope(span.employeeId, span.tradingDate)),
    punches: args.punches.filter((punch) => inScope(punch.employeeId, punch.tradingDate)),
    // Filtered on the day the correction is ABOUT and never on its `adjustmentDate`, which is the day it was
    // posted on and is by design in a LATER period. Filtering on that would drop every correction to a closed
    // month — the only corrections there are.
    corrections: args.corrections.filter((row) => inScope(row.employeeId, row.tradingDate)),
    graceRuleVersions: args.graceRuleVersions,
  })

  const workedHours = summariseWorkedHours({
    shifts: payablePresences(variances),
    ruleVersions: args.workingHoursRuleVersions,
    ...(args.publicHolidays === undefined ? {} : { publicHolidays: args.publicHolidays }),
    ...(args.zone === undefined ? {} : { zone: args.zone }),
  })

  let payableMinutes = 0
  let weightedMinuteBp = 0
  for (const day of workedHours.days) {
    payableMinutes += day.totalMinutes
    weightedMinuteBp += day.weightedMinuteBp
  }

  return {
    employeeId: args.employeeId,
    fromTradingDate: args.fromTradingDate,
    toTradingDate: args.toTradingDate,
    variances,
    workedHours,
    payableMinutes,
    weightedMinuteBp,
    incompletePresenceCount: variances.filter((row) => row.outcome === 'INCOMPLETE').length,
  }
}

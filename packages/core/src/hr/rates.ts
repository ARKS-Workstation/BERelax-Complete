import { AppError } from '@berelax/shared'
import { type LocalDate, type LocalTime, minutesSinceMidnight } from '../time.ts'

/**
 * The working-hours rule set, and how a version of it is chosen. Pure.
 *
 * `working_hours_rule` (migration 0059) holds one row per version of the rules — ordinary hours, the
 * overtime cap, the minimum rest gap, the night window and the four bucket multipliers. This module is
 * the shape those rows take once they are in hand, plus the two judgements that belong to the rate table
 * rather than to the arithmetic: **which version governs a trading date**, and **which bucket a minute
 * falls in when more than one applies**.
 *
 * ## Why the version is chosen by trading date and not by "now"
 *
 * `regulatory_profile` is versioned with `superseded_at` and every consumer reads the row *in force*,
 * because the question it answers ("may we say this on the website?") is only ever asked about the
 * present. Working hours are the opposite: payroll recomputes March in April, an owner queries last
 * quarter's overtime, and a corrected shift is re-split months later. A "current row" model answers all
 * of those with April's rates, and the error is invisible — the figures are plausible, they are simply
 * not the ones that applied.
 *
 * So a version is keyed on the first **trading date** it governs and {@link rulesFor} picks the latest
 * version at or before the date being computed. The date is a trading date and never a calendar date,
 * for the reason that runs through this whole unit: trading runs 11:00–02:00, so the minutes worked at
 * 01:30 belong to the previous trading date and must be paid at that date's rates.
 *
 * ## Why there is no default rule set
 *
 * {@link rulesFor} throws when no version governs the date. The alternative — falling back to a constant
 * — is the failure `readCredentialPolicy` describes for the credential gate one layer along: a payroll
 * that invents its own rates produces a payslip nobody can trace to a decision, and it looks exactly
 * like a payslip that came from the table. 0059 seeds a version from a sentinel date before any trading
 * this business could have done, so the only way to reach the throw is to have lost the row.
 *
 * ## Basis points, and why the multipliers never become a float
 *
 * A multiplier is an integer count of basis points: 10000 is the ordinary rate, 12500 is 1.25. The
 * figures are multiplied by minute counts and will one day be multiplied by a fils-denominated wage, and
 * ADR 0007's rule that money is integer applies to the rate as much as to the amount. It also makes the
 * unit's grep test meaningful: there is no spelling of `1.25` anywhere in the arithmetic to find, because
 * the arithmetic is whole basis points throughout.
 */

/**
 * The four buckets a worked minute may land in, **dearest intent first**.
 *
 * The order is load-bearing twice over.
 *
 * It is the tie-break in {@link dearestBucket}, and version 1 of the rules makes that tie real: the
 * night uplift and the public-holiday uplift are both 150%, so a minute worked at 23:00 on a public
 * holiday has two applicable buckets paying the same. `publicHoliday` wins, and the reason is not that
 * it is dearer — it is that a public holiday is a property of the whole trading date while the night
 * window is a property of the minute. Recording the day's uplift as a night uplift would make "how many
 * public-holiday minutes did we work this year" unanswerable from the split, and that figure is the one a
 * compensatory-rest-day policy (Y9-overtime) will be built on.
 *
 * It is also the order results are reported in, so two splits of the same shift compare field by field.
 */
export const WORKED_MINUTE_BUCKETS = ['publicHoliday', 'night', 'overtime', 'ordinary'] as const

export type WorkedMinuteBucket = (typeof WORKED_MINUTE_BUCKETS)[number]

/** The buckets that are an uplift on the ordinary rate. `ordinary` is the floor, never a candidate. */
export const UPLIFT_BUCKETS: readonly WorkedMinuteBucket[] = WORKED_MINUTE_BUCKETS.filter(
  (bucket) => bucket !== 'ordinary',
)

/**
 * The night window as local wall-clock times, half-open `[from, until)`.
 *
 * Wall-clock and not instants, because the window is the same every night and the instants are not: the
 * 22:00 that starts the night window on one date is a different offset from UTC on another as soon as a
 * zone with DST is asked about. `from > until` is the normal case here — 22:00 to 04:00 wraps midnight,
 * which is the whole reason this is a pair of times rather than a range.
 */
export interface NightWindow {
  readonly from: LocalTime
  readonly until: LocalTime
}

/** One version of `working_hours_rule`. Every figure is data; none of it is a constant in this package. */
export interface WorkingHoursRules {
  /** The first trading date this version governs. */
  readonly effectiveFrom: LocalDate
  /** Minutes worked in a trading date before a minute becomes overtime-eligible. */
  readonly ordinaryMinutesPerDay: number
  /** Minutes worked in a trading week before the weekly cap is breached. */
  readonly ordinaryMinutesPerWeek: number
  /** 0 = Sunday, the spelling `premises_hours.day_of_week` uses. */
  readonly weekStartsOn: number
  /** The daily overtime ceiling. Exceeding it is a violation, never a dearer bucket. */
  readonly overtimeDailyCapMinutes: number
  /** The minimum gap between two consecutive presences for one employee. */
  readonly minimumRestMinutes: number
  readonly nightWindow: NightWindow
  /** Basis points per bucket. 10000 is the ordinary rate. */
  readonly multiplierBp: Readonly<Record<WorkedMinuteBucket, number>>
}

function assertWholeMinutes(label: string, minutes: number, maximum: number): void {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > maximum) {
    throw new AppError(
      'validation',
      `${label} must be a whole number of minutes between 0 and ${maximum}, got ${minutes}`,
    )
  }
}

/**
 * Refuses a rule set the arithmetic cannot be right about, with the same reasons 0059's constraints give.
 *
 * Deliberately a second implementation of those constraints rather than a claim that the database has
 * already checked. Most rule sets the maths sees in a test were built in the test, and a fixture holding
 * an impossible rule set is how an assertion comes to pass for the wrong reason — the property "the
 * buckets sum to the total" holds trivially if every multiplier is equal and the night window is empty.
 * The database refuses a bad ROW; this refuses a bad OBJECT.
 */
export function assertWorkingHoursRules(rules: WorkingHoursRules): void {
  assertWholeMinutes('The ordinary minutes in a day', rules.ordinaryMinutesPerDay, 1440)
  if (rules.ordinaryMinutesPerDay === 0) {
    throw new AppError('validation', 'A day with no ordinary minutes at all is not a rule set')
  }
  assertWholeMinutes('The ordinary minutes in a week', rules.ordinaryMinutesPerWeek, 10_080)
  assertWholeMinutes('The daily overtime cap', rules.overtimeDailyCapMinutes, 1440)
  assertWholeMinutes('The minimum rest', rules.minimumRestMinutes, 1440)
  if (!Number.isInteger(rules.weekStartsOn) || rules.weekStartsOn < 0 || rules.weekStartsOn > 6) {
    throw new AppError(
      'validation',
      `A working week starts on a weekday 0-6, got ${rules.weekStartsOn}`,
    )
  }
  // An empty night window is not "no night rule", it is a night rule that silently never applies — and a
  // rule that never applies passes every test written to prove the night bucket is separate.
  if (rules.nightWindow.from === rules.nightWindow.until) {
    throw new AppError(
      'validation',
      `A night window from ${rules.nightWindow.from} to ${rules.nightWindow.until} covers either no ` +
        'minute or every minute; 0059 refuses the same row',
    )
  }
  for (const bucket of UPLIFT_BUCKETS) {
    if (rules.multiplierBp[bucket] < rules.multiplierBp.ordinary) {
      throw new AppError(
        'validation',
        `The ${bucket} multiplier (${rules.multiplierBp[bucket]}bp) is below the ordinary rate ` +
          `(${rules.multiplierBp.ordinary}bp). The dearest applicable bucket is the one a minute is ` +
          'counted in, so an uplift below the base rate would send that minute to `ordinary` and read ' +
          'as a defect in the split rather than as a rate somebody typed wrong',
      )
    }
  }
}

/**
 * The version of the rules that governs a trading date: the latest one effective at or before it.
 *
 * `versions` may arrive in any order — the caller is usually a SQL read and an `order by` is easy to
 * lose. Sorting here is on the ISO date string, which sorts as it compares.
 *
 * Throws when nothing governs the date, for the reason in this module's header: an invented rate is
 * indistinguishable from a configured one on the payslip that results.
 */
export function rulesFor(
  versions: readonly WorkingHoursRules[],
  tradingDate: LocalDate,
): WorkingHoursRules {
  let governing: WorkingHoursRules | undefined
  for (const version of versions) {
    if (version.effectiveFrom > tradingDate) continue
    if (governing === undefined || version.effectiveFrom > governing.effectiveFrom) {
      governing = version
    }
  }
  if (governing === undefined) {
    throw new AppError(
      'invariant_violated',
      `No working-hours rule version is effective on or before the trading date ${tradingDate}, so ` +
        'which multipliers, caps and night window apply is unknown. 0059 seeds a version from a ' +
        'sentinel date before any trading this business could have done; an empty answer means the row ' +
        'is gone. A default rule set here would be a payroll that invented its own rates.',
    )
  }
  assertWorkingHoursRules(governing)
  return governing
}

/**
 * True when a local wall-clock time is inside the night window, half-open `[from, until)`.
 *
 * Half-open for the reason every other window in this system is: a minute beginning exactly at `until`
 * is a day minute, and a night window that included both boundaries would pay one minute twice at two
 * different rates in the two shifts that meet there.
 *
 * The wrapping case — `from > until`, which 22:00–04:00 is — is a union of two ranges and not a range
 * with a negative length. Getting it wrong is the defect that pays nothing at night: `m >= from && m <
 * until` is never true when `from > until`, so the night bucket silently stays empty and the split still
 * sums to the total.
 */
export function isWithinNightWindow(time: LocalTime, window: NightWindow): boolean {
  const from = minutesSinceMidnight(window.from)
  const until = minutesSinceMidnight(window.until)
  const at = minutesSinceMidnight(time)
  return from < until ? at >= from && at < until : at >= from || at < until
}

/**
 * The bucket a minute is counted in, given which uplifts apply to it: the **dearest** of them.
 *
 * This is what makes the buckets a partition of the minutes worked rather than four overlapping tallies.
 * A minute at 23:30 in the ninth hour of a shift is both a night minute and an overtime minute; counting
 * it in both makes the buckets sum to more than the minutes worked, and choosing the cheaper pays less
 * than either rule allows. The dearest is therefore both the lawful answer and the one that keeps the
 * unit's property — buckets sum to total, exactly — true by construction.
 *
 * `ordinary` is the floor and not a candidate, so the result is always defined. Equal multipliers are
 * broken by {@link WORKED_MINUTE_BUCKETS}'s order; see the note there for why `publicHoliday` wins.
 */
export function dearestBucket(
  rules: WorkingHoursRules,
  applicableUplifts: readonly WorkedMinuteBucket[],
): WorkedMinuteBucket {
  let dearest: WorkedMinuteBucket = 'ordinary'
  for (const bucket of WORKED_MINUTE_BUCKETS) {
    if (!applicableUplifts.includes(bucket)) continue
    if (rules.multiplierBp[bucket] > rules.multiplierBp[dearest]) dearest = bucket
  }
  return dearest
}

/** An empty tally, one entry per bucket. Every split starts here so no bucket is ever absent. */
export function emptyBucketMinutes(): Record<WorkedMinuteBucket, number> {
  return { publicHoliday: 0, night: 0, overtime: 0, ordinary: 0 }
}

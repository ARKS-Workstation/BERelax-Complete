import { BREACH_CLOCK_OPEN_QUESTION_ID } from '@berelax/shared'

/**
 * The breach-notification clock: discovery in, a dated deadline out. Pure, and it decides nothing else.
 *
 * ## The clock starts at an EVENT, which is why the input is an instant and not `now()`
 *
 * A breach is discovered on a Friday evening and filed on Monday morning. If the deadline were computed
 * from the filing, the statutory clock would restart every time somebody got round to the paperwork —
 * and the later the record, the more time the business would appear to have. That is the defect this
 * signature exists to make impossible: `discoveredAt` is an argument, `filed_at` is a different column,
 * and the migration's CHECK requires the filing to be at or after the discovery so the gap is a visible
 * fact rather than an erased one.
 *
 * ## Why the deadline is a civil date and not a trading date
 *
 * Everything else dated in this build goes through `resolveTradingDate`, because trading runs
 * 11:00–02:00 and 01:30 belongs to the previous business day. A statutory deadline does not — the
 * phrase is already in `packages/core/src/privacy/rights-policy.ts`: *a statutory deadline does not move
 * with the salon's trading hours*. A regulator's period runs on the calendar, so a breach discovered at
 * 01:30 on the 4th is discovered on the 4th whatever the till thinks, and using the trading date here
 * would hand the business an extra day roughly one night in three.
 *
 * `obligation_instance.due_on` is a DATE, and the instant is kept too: the date is what the compliance
 * calendar compares and shows, and the instant is what answers "was the notification inside the period"
 * to the hour. Keeping only the date would lose up to a day of the answer, and keeping only the instant
 * would mean the calendar could not hold the duty at all.
 *
 * ## What this does NOT decide
 *
 * **Whether the breach is notifiable.** That is a judgement about risk to the people affected, and
 * nothing here can make it. So the duty is always generated and dated, and closing it is an act with a
 * recorded reason — including "assessed as not notifiable". A function that applied a threshold would be
 * deciding not to notify, from a rule nobody wrote down, and the evidence would be an absence.
 *
 * **How long the period is.** The caller passes it, and it comes from a `provisional` F09 setting
 * because docs/04 §8 marks the regulation and its deadline `[UNVERIFIED]`. This module refuses a period
 * it was not given rather than defaulting to one: a default here would be the invented figure in the
 * one place nobody looks.
 */

/** A UTC offset in minutes, supplied by the caller. `packages/core` has no clock and no zone database. */
export interface CivilZone {
  /**
   * Minutes to add to UTC to get civil time. Asia/Dubai is +240 and has no daylight saving, which is
   * why an offset is sufficient here and would not be in a jurisdiction that observes it.
   */
  readonly utcOffsetMinutes: number
  /** The zone's name, carried so a stored deadline says which civil day it was computed in. */
  readonly name: string
}

/** Asia/Dubai, +04:00 all year. The business's civil zone, and the one every deadline is dated in. */
export const BUSINESS_CIVIL_ZONE: CivilZone = Object.freeze({
  utcOffsetMinutes: 240,
  name: 'Asia/Dubai',
})

export interface BreachClockInput {
  /** When the business became aware. ISO 8601 with an offset. */
  readonly discoveredAtIso: string
  /** The period, in whole hours, from the `provisional` setting. Never defaulted here. */
  readonly periodHours: number
  readonly zone?: CivilZone
}

export interface BreachDeadline {
  /** The instant the period expires. What answers "was it inside the period" to the hour. */
  readonly deadlineAtIso: string
  /** The civil date the deadline falls on, for `obligation_instance.due_on`. */
  readonly dueOn: string
  /** The civil date the discovery fell on, so the two can be compared without recomputing. */
  readonly discoveredOn: string
  /** The zone both dates were computed in, recorded rather than assumed. */
  readonly zoneName: string
  /** The period used, carried so a stored deadline says which figure produced it. */
  readonly periodHours: number
  /** The open question the period is provisional against. */
  readonly openQuestionId: string
}

/** `YYYY-MM-DD` for an instant in a civil zone, by shifting and then reading the UTC fields. */
function civilDate(epochMs: number, zone: CivilZone): string {
  const shifted = new Date(epochMs + zone.utcOffsetMinutes * 60_000)
  const iso = shifted.toISOString()
  const date = iso.slice(0, 10)
  if (date.length !== 10) {
    throw new Error(`could not read a civil date out of ${iso}`)
  }
  return date
}

/**
 * The deadline for one discovered breach.
 *
 * Throws rather than coercing on every bad input, because each one would otherwise produce a plausible
 * date: an unparseable instant gives `Invalid Date` and then `NaN`, which formats as a string; a
 * fractional period gives a deadline at a time nobody can act on; a zero or negative period gives a
 * deadline at or before the discovery, which reads on the calendar as a duty that was already overdue
 * when it was created.
 */
export function breachNotificationDeadline(input: BreachClockInput): BreachDeadline {
  const zone = input.zone ?? BUSINESS_CIVIL_ZONE
  const discovered = Date.parse(input.discoveredAtIso)
  if (Number.isNaN(discovered)) {
    throw new Error(
      `breachNotificationDeadline: "${input.discoveredAtIso}" is not an instant. The clock starts at ` +
        'the discovery, so an unparseable discovery is an unanswerable deadline rather than a default.',
    )
  }
  if (!Number.isInteger(input.periodHours) || input.periodHours < 1) {
    throw new Error(
      `breachNotificationDeadline: the period must be a whole number of hours of at least one, not ` +
        `${input.periodHours}. It is read from a provisional setting and is never defaulted here — a ` +
        'default would be the invented figure in the one place nobody looks.',
    )
  }
  const deadline = discovered + input.periodHours * 3_600_000
  return {
    deadlineAtIso: new Date(deadline).toISOString(),
    dueOn: civilDate(deadline, zone),
    discoveredOn: civilDate(discovered, zone),
    zoneName: zone.name,
    periodHours: input.periodHours,
    openQuestionId: BREACH_CLOCK_OPEN_QUESTION_ID,
  }
}

/**
 * Was a notification inside the period?
 *
 * Compared on the INSTANT and not on the date, which is the whole reason `deadlineAtIso` is kept beside
 * `dueOn`. A notification sent at 23:00 on the due date is inside a 72-hour period that expired at 09:00
 * that morning only if the comparison is done on dates, and that is the answer a regulator would not
 * accept. The calendar still works in dates, because a date is what a screen can show.
 *
 * Answers `unknown` for a notification with no instant rather than `false`: "we cannot tell" and "it was
 * late" are different findings, and the second is an accusation.
 */
export function notificationWasTimely(args: {
  readonly deadlineAtIso: string
  readonly notifiedAtIso: string | null
}): 'timely' | 'late' | 'unknown' {
  if (args.notifiedAtIso === null) return 'unknown'
  const deadline = Date.parse(args.deadlineAtIso)
  const notified = Date.parse(args.notifiedAtIso)
  if (Number.isNaN(deadline) || Number.isNaN(notified)) return 'unknown'
  return notified <= deadline ? 'timely' : 'late'
}

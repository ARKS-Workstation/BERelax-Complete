/**
 * The promotional quiet-hours rule: when a promotional message may leave, and what happens when it may not.
 *
 * ## Why the rule is here and the ceiling is not
 *
 * TDRA confines promotional SMS to 07:00–21:00 Asia/Dubai (docs/04 §5), and the sanction for sending
 * outside it is sender-ID SUSPENSION rather than a per-message fine — so the identity the booking
 * confirmations also leave from is what a late campaign costs. The rule therefore lives in code.
 *
 * What is deliberately NOT in this file is the figure 07:00–21:00. `packages/core` may not import
 * `@berelax/config`, and the ceiling is `messaging.promotional_window`'s registry default, which
 * `@berelax/messaging`'s gate already reads rather than copies — for the reason its header gives: a
 * ceiling written in two places lets the gate and the admin panel disagree, and the symptom of that
 * disagreement is a message sent at 21:30 that every screen says was compliant. So every function here
 * takes the ceiling as an argument and none of them knows what it is.
 *
 * ## Why an override can only ever narrow, twice over
 *
 * `Y9-ramadan-window` is open: nobody has confirmed whether the window narrows during Ramadan. The
 * provisional answer is the conservative one — {@link RAMADAN_PROMOTIONAL_HOURS}, 10:00–16:00 — and it is
 * the shape of the answer rather than a date: **no Ramadan date is written down anywhere in this build.**
 * Ramadan's dates are announced by an authority and are a fact about the world, not a value a unit may
 * invent (brief rule 15), so the dated rows live in `business_calendar` (migration 0003, `kind =
 * 'ramadan_hours'`) where an admin states them, and this module takes them as an argument.
 *
 * The narrowing is enforced in two independent ways, and the second is what still holds if the first is
 * ever removed:
 *
 *   1. {@link effectivePromotionalHours} REFUSES an override that would widen, by name, so a row saying
 *      `00:00-24:00 during Ramadan` is a loud failure rather than a quiet relaxation;
 *   2. it returns {@link intersectPromotionalHours} of the ceiling and every covering override, and an
 *      intersection cannot widen — so even with the refusal deleted, the widest answer this function can
 *      give is the ceiling.
 *
 * That is the same two-layer shape `frequency_cap_value_is_a_cap()` has in migration 0080: the readable
 * refusal for a human, and the structural one that holds when the readable one is bypassed.
 *
 * ## Why the answer outside the window is `queue` and not `refuse`
 *
 * A promotional message at 01:00 is not wrong, it is early. Refusing it drops it, and a dropped message
 * is indistinguishable from one that was never scheduled — which is how "the February campaign went to
 * nobody" becomes unanswerable. So the decision is a HOLD with the instant it may leave at.
 *
 * `Y9-queued-staleness` is the other half, and its provisional answer is "expires unsent, with a report
 * to the owner rather than a late send". A 23:00 offer released at 07:00 may be advertising yesterday, and
 * a late send is worse than none: the recipient's allowance is spent on a message about something that has
 * expired. So a hold older than {@link MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS} is EXPIRED with a typed
 * reason, never sent late and never silently discarded.
 *
 * ## Why there is no `Date` in this file
 *
 * `scripts/check-core-purity.mjs` bans the `Date` token throughout `packages/core/src/messaging`, and the
 * ban is right here rather than merely inherited: this module walks forward over calendar days, and a
 * `Date`-based day step re-derives a local date through UTC — which is the arithmetic that disagrees with
 * the caller for the hours either side of midnight. {@link nextLocalDate} is string arithmetic over
 * `YYYY-MM-DD` with a leap rule, which is exact in every zone and has no midnight to get wrong.
 */
import type { MessageClass } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import {
  fromLocal,
  type Instant,
  instantToIso,
  type LocalDate,
  type LocalDateTime,
  localDate,
  localTime,
  minutesSinceMidnight,
  type TimeZone,
} from '../time.ts'

/** The OPEN-QUESTIONS id the Ramadan narrowing is provisional until. */
export const RAMADAN_WINDOW_OPEN_QUESTION = 'Y9-ramadan-window'

/** The OPEN-QUESTIONS id the staleness ceiling is provisional until. */
export const QUEUED_STALENESS_OPEN_QUESTION = 'Y9-queued-staleness'

/**
 * Hours of the day, in the business zone, that promotional traffic may leave in.
 *
 * Structurally identical to `PromotionalWindow` in `@berelax/messaging` and deliberately a separate
 * declaration: `packages/core` may not import that package (`core-must-not-import-infrastructure`), and a
 * structural shape is assignable in both directions without either one owning the other.
 */
export interface PromotionalHours {
  /** Inclusive. */
  readonly startHour: number
  /** Exclusive, so 21 means "nothing after 20:59". */
  readonly endHour: number
}

/**
 * The provisional Ramadan narrowing. Hours only — see the header on why no date appears in this build.
 *
 * 10:00–16:00 is the conservative guess `Y9-ramadan-window` records, and conservative is what a
 * provisional value has to be (docs/12 §2): a wider guess risks the breach, a narrower one only sends
 * less marketing.
 */
export const RAMADAN_PROMOTIONAL_HOURS: PromotionalHours = Object.freeze({
  startHour: 10,
  endHour: 16,
})

/**
 * How long a held promotional message may wait before it expires unsent.
 *
 * Twelve hours, which is the figure `C-AUTO-04`'s manifest entry carries and which `Y9-queued-staleness`
 * governs. It is long enough that a 23:00 attempt reaches the 07:00 opening — eight hours — and short
 * enough that a message held over a whole day never leaves.
 */
export const MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS = 12 * 60 * 60

/**
 * How many days forward {@link nextPromotionalOpen} will look for an opening.
 *
 * Bounded, and a bound that is REACHED is an error rather than a default. A set of overrides under which
 * the window never opens is quiet hours switched off by starvation — every message held, for ever, with
 * nothing saying so — and it is the one failure of this module that would look like nothing happening.
 * Eight days, so a whole week of dated overrides cannot hide an opening beyond the horizon.
 */
export const PROMOTIONAL_OPENING_HORIZON_DAYS = 8

/**
 * A dated narrowing of the window, as `business_calendar` holds it.
 *
 * Both ends inclusive, because a calendar row names the days it applies to rather than a half-open range,
 * and a reader who has to remember which end is exclusive gets the last day of Ramadan wrong.
 */
export interface DatedPromotionalOverride {
  readonly fromDate: LocalDate
  readonly toDate: LocalDate
  readonly hours: PromotionalHours
  /** Why this narrowing exists, for the refusal message and for the audit trail. Never blank. */
  readonly reason: string
  /** The OPEN-QUESTIONS id, when the hours are provisional. */
  readonly openQuestionId?: string
}

/** True when the hours contain no minute at all — a window that never opens. */
export function promotionalHoursAreEmpty(hours: PromotionalHours): boolean {
  return hours.startHour >= hours.endHour
}

/**
 * The hours both arguments permit. Total, and structurally unable to widen either one.
 *
 * `max` of the starts and `min` of the ends, which is the whole of the guarantee: whatever two windows go
 * in, the result is inside both. That is why this is the layer that still holds if
 * {@link effectivePromotionalHours}'s refusal is ever deleted — the widest answer available is the
 * ceiling, and no override can reach past it even by claiming to.
 *
 * An empty result is possible and is not corrected here: two disjoint narrowings really do leave no
 * minute to send in, and silently widening one of them to fix it is the mistake. The caller decides, and
 * for the send path {@link decidePromotionalWindow} holds the message rather than sending it.
 */
export function intersectPromotionalHours(
  a: PromotionalHours,
  b: PromotionalHours,
): PromotionalHours {
  return Object.freeze({
    startHour: Math.max(a.startHour, b.startHour),
    endHour: Math.min(a.endHour, b.endHour),
  })
}

/** True when `date` falls inside the override's inclusive span. String comparison: ISO dates sort. */
export function overrideCoversDate(override: DatedPromotionalOverride, date: LocalDate): boolean {
  return override.fromDate <= date && date <= override.toDate
}

const hourLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`

const hoursLabel = (hours: PromotionalHours): string =>
  `${hourLabel(hours.startHour)}-${hourLabel(hours.endHour)}`

/**
 * The hours in force on one local date: the ceiling, narrowed by every override covering that date.
 *
 * EVERY covering override rather than the first, and that is deliberate. Two rows covering one day is a
 * legitimate arrangement — a Ramadan narrowing and a one-day maintenance narrowing — and taking the first
 * would make the answer depend on the order a query returned rows in. Intersecting all of them means the
 * strictest wins, which is the only reading that cannot accidentally relax.
 *
 * A widening override is refused BY NAME before the intersection, because a row saying promotional
 * traffic may leave at 03:00 is not a narrowing that needs clamping — it is somebody switching quiet
 * hours off through the calendar, and it has to be visible rather than silently corrected.
 */
export function effectivePromotionalHours(args: {
  readonly date: LocalDate
  readonly ceiling: PromotionalHours
  readonly overrides?: readonly DatedPromotionalOverride[] | undefined
}): PromotionalHours {
  let hours: PromotionalHours = args.ceiling
  for (const override of args.overrides ?? []) {
    if (!overrideCoversDate(override, args.date)) continue
    if (
      override.hours.startHour < args.ceiling.startHour ||
      override.hours.endHour > args.ceiling.endHour
    ) {
      throw new AppError(
        'forbidden',
        `The dated promotional override "${override.reason}" covering ${args.date} asks for ` +
          `${hoursLabel(override.hours)}, which is outside the ${hoursLabel(args.ceiling)} ceiling. An ` +
          'override may only ever NARROW the window: widening it through the calendar is how quiet hours ' +
          'get switched off without anybody editing the setting, and the sanction for a promotional SMS ' +
          'outside the permitted hours is sender-ID suspension — which stops the booking confirmations ' +
          'too.',
        {
          userFacing: true,
          details: {
            date: args.date,
            override,
            ceiling: args.ceiling,
            ...(override.openQuestionId === undefined
              ? {}
              : { openQuestionId: override.openQuestionId }),
          },
        },
      )
    }
    hours = intersectPromotionalHours(hours, override.hours)
  }
  return hours
}

/**
 * The calendar day after `date`, by arithmetic on the string.
 *
 * Here rather than reached for from `hr/leave-accrual.ts` or `compliance/obligation-notice.ts`, which each
 * have one, for two reasons. `scripts/check-core-purity.mjs` bans the `Date` token throughout this
 * directory and both of those are built on `new Date(...)`; and `messaging` importing the leave accruals
 * to step a day would be a cross-domain edge with no domain meaning. Fifteen lines of exact arithmetic is
 * cheaper than either, and `promotional-window.test.ts` walks every month end and both leap rules.
 */
export function nextLocalDate(date: LocalDate): LocalDate {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  if (day < daysInMonth(year, month)) return isoDate(year, month, day + 1)
  if (month < 12) return isoDate(year, month + 1, 1)
  return isoDate(year + 1, 1, 1)
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function daysInMonth(year: number, month: number): number {
  // February, under the full Gregorian rule rather than the four-year approximation: 1900 was not a leap
  // year and 2000 was, and a build that lives past 2100 would put the last day of February on the 29th.
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return MONTH_LENGTHS[month - 1] ?? 30
}

function isoDate(year: number, month: number, day: number): LocalDate {
  return localDate(
    `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  )
}

/** True when the wall-clock time is inside the hours. */
export function withinPromotionalHours(local: LocalDateTime, hours: PromotionalHours): boolean {
  const minutes = minutesSinceMidnight(local.time)
  return minutes >= hours.startHour * 60 && minutes < hours.endHour * 60
}

/**
 * The next instant the window opens, honouring the dated overrides on every day it looks at.
 *
 * The override handling is the reason this cannot be "07:00 tomorrow". A message attempted at 23:30 on
 * the night before a Ramadan day opens at 10:00 and not at 07:00, and a gate that answered 07:00 would
 * release it three hours early — inside the narrowing, which is precisely the breach the narrowing exists
 * to avoid. So each candidate day's hours are resolved before its opening instant is taken.
 *
 * Trading runs 11:00–02:00 (ADR on `business_day`), so the interesting case is 01:30: inside trading
 * hours, outside the promotional window, and the next opening is that morning rather than the next day.
 */
export function nextPromotionalOpen(args: {
  readonly local: LocalDateTime
  readonly ceiling: PromotionalHours
  readonly overrides?: readonly DatedPromotionalOverride[] | undefined
  readonly zone: TimeZone
  readonly horizonDays?: number
}): Instant {
  const horizon = args.horizonDays ?? PROMOTIONAL_OPENING_HORIZON_DAYS
  let date = args.local.date
  for (let day = 0; day < horizon; day += 1) {
    const hours = effectivePromotionalHours({
      date,
      ceiling: args.ceiling,
      ...(args.overrides === undefined ? {} : { overrides: args.overrides }),
    })
    // A day whose narrowings leave no minute at all cannot be the answer, and skipping it here is what
    // makes two disjoint overrides hold a message to the next real opening rather than release it into a
    // window with nothing in it.
    if (!promotionalHoursAreEmpty(hours)) {
      const opensAt = fromLocal(date, localTime(hourLabel(hours.startHour)), args.zone)
      // On the FIRST day only, an opening that has already passed is not an opening: 22:00 today is after
      // 07:00 today. On every later day the opening is in the future by construction.
      const alreadyPassed =
        day === 0 && minutesSinceMidnight(args.local.time) >= hours.startHour * 60
      if (!alreadyPassed) return opensAt
    }
    date = nextLocalDate(date)
  }

  throw new AppError(
    'invariant_violated',
    `No promotional window opens in the ${horizon} days from ${args.local.date}. The ceiling is ` +
      `${hoursLabel(args.ceiling)} and the dated overrides in force leave no minute to send in, which is ` +
      'quiet hours switched off by starvation rather than by a setting: every promotional message would ' +
      'be held for ever with nothing saying why. Refusing to answer rather than inventing an opening.',
    {
      details: {
        from: args.local.date,
        horizonDays: horizon,
        ceiling: args.ceiling,
        overrides: args.overrides ?? [],
        openQuestionId: RAMADAN_WINDOW_OPEN_QUESTION,
      },
    },
  )
}

export type PromotionalWindowDecision =
  /**
   * Transactional. Out of scope, and answered here as well as short-circuited by the gate, so a path
   * nobody exercises cannot turn a booking confirmation or an OTP into a held message.
   */
  | { readonly kind: 'not_applicable'; readonly reason: 'transactional' }
  | { readonly kind: 'open'; readonly hours: PromotionalHours }
  /** Outside the window, so held rather than dropped, with the instant it may leave at. */
  | {
      readonly kind: 'queue'
      readonly reason: 'queued_for_window'
      readonly releaseAt: Instant
      readonly hours: PromotionalHours
    }
  /** Held too long. Expires unsent — never sent late, never silently discarded. */
  | {
      readonly kind: 'expire'
      readonly reason: 'stale_outside_window'
      readonly queuedSince: Instant
      readonly ageSeconds: number
      readonly maxStalenessSeconds: number
      readonly detail: string
    }

export interface PromotionalWindowInput {
  readonly messageClass: MessageClass
  /** The instant the decision is taken at, and the one a release is measured from. */
  readonly at: Instant
  /** `at` in the business zone, read by the caller so one clock reader serves the whole gate. */
  readonly local: LocalDateTime
  readonly zone: TimeZone
  /** The regulator's hours. Never a copy: see the header. */
  readonly ceiling: PromotionalHours
  readonly overrides?: readonly DatedPromotionalOverride[] | undefined
  /**
   * When this message was first held, for a release attempt. Absent for a first attempt.
   *
   * Absent rather than defaulted to `at`, because "held for zero seconds" and "never held" are different
   * facts and only one of them can go stale. A first attempt outside the window is queued however long
   * the staleness ceiling is.
   */
  readonly queuedSince?: Instant | undefined
  readonly maxStalenessSeconds?: number | undefined
}

/**
 * Whether one promotional message may leave now, be held, or has waited too long.
 *
 * The staleness test comes BEFORE the window test and that order is load-bearing: a message held since
 * 23:00 and re-attempted at 11:00 the next day is inside the window, and a window-first reading would
 * send it — twelve hours late, advertising yesterday, having spent the recipient's allowance. Expiry is a
 * statement about how long the message has waited, not about where in the day the release landed.
 */
export function decidePromotionalWindow(input: PromotionalWindowInput): PromotionalWindowDecision {
  if (input.messageClass === 'transactional') {
    return { kind: 'not_applicable', reason: 'transactional' }
  }

  const maxStalenessSeconds = input.maxStalenessSeconds ?? MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS
  if (input.queuedSince !== undefined) {
    const ageSeconds = (input.at - input.queuedSince) / 1000
    if (ageSeconds >= maxStalenessSeconds) {
      return {
        kind: 'expire',
        reason: 'stale_outside_window',
        queuedSince: input.queuedSince,
        ageSeconds,
        maxStalenessSeconds,
        detail:
          `Held since ${instantToIso(input.queuedSince)}, which is ${Math.round(ageSeconds / 3600)}h ` +
          `before ${instantToIso(input.at)} and past the ${maxStalenessSeconds / 3600}h ceiling. ` +
          'Expired unsent rather than released late: a promotional message released a day after it was ' +
          "written may be advertising something that has finished, and it would spend the contact's " +
          `frequency allowance doing it (${QUEUED_STALENESS_OPEN_QUESTION}).`,
      }
    }
  }

  const hours = effectivePromotionalHours({
    date: input.local.date,
    ceiling: input.ceiling,
    ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
  })

  if (!promotionalHoursAreEmpty(hours) && withinPromotionalHours(input.local, hours)) {
    return { kind: 'open', hours }
  }

  return {
    kind: 'queue',
    reason: 'queued_for_window',
    releaseAt: nextPromotionalOpen({
      local: input.local,
      ceiling: input.ceiling,
      ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
      zone: input.zone,
    }),
    hours,
  }
}

/**
 * The cancellation window, the fee that is zero, and the NO_SHOW clock guard (B-LIFE-03).
 *
 * Three judgements that all need one thing `packages/core` may not have: an instant. So the instant is an
 * ARGUMENT in every one of them. `pnpm purity` bans `Date.now()` here, and the reason is not tidiness —
 * a hidden clock read makes "refused one minute before the start, accepted one minute after" a test that
 * passes today and fails at 03:00, and makes a disputed no-show impossible to reproduce.
 *
 * ## The window flags; it does not charge
 *
 * `booking.cancellation_window_hours` is an F09 setting declared `provisional: true` against **Y9-windows**
 * with the note "24 hours, flagged only, no fee". The owner has agreed no fee policy, and the business
 * takes no card payments at all — so there is no instrument to charge with and no amount anybody has
 * approved. {@link cancellationCharge} therefore answers zero for every input, and it exists as a function
 * rather than as an absence for one reason: it is the single seam a fee policy arrives through, so the day
 * one is agreed there is exactly one place to change and one test to update. A fee invented here would be
 * a capability the business does not have, written where a later reader would find it and assume it is in
 * use (brief rule 15).
 *
 * What a late cancellation produces is a FLAG and the figure it was judged against (0049), and nothing
 * else: no payment row, no invoice, no fee row, no ledger entry.
 *
 * ## The NO_SHOW guard narrows what a caller may ask for; it does not re-decide the transition
 *
 * B-LIFE-01 owns which pairs are legal and declares `confirmed -> no_show` and `checked_in -> no_show`.
 * This module adds the one thing that table cannot hold, and its own NOTE says so: "the CLOCK GUARD — only
 * once the start is past — is B-LIFE-03's, as is the cancellation window. They narrow what a caller may
 * ask for; adding them here would put a clock in packages/core, which may not read one." The guard is
 * therefore a SEPARATE verdict applied before the transition table is consulted at all, and it never
 * widens the table: a pair the table refuses stays refused whatever the clock says.
 *
 * Marking a future appointment a no-show is not a near miss. It is the front desk working the wrong row —
 * tomorrow's 19:00 in front of them instead of yesterday's — and the consequence lands on the customer,
 * because `no_show` is the judgement a fee policy will read.
 */
import { AppError } from '@berelax/shared'
import { differenceInMinutes, type Instant } from '../time.ts'

/** The F09 registry key. Spelled once, so a reader of either package finds the same string. */
export const CANCELLATION_WINDOW_SETTING_KEY = 'booking.cancellation_window_hours'

/**
 * 24 hours, provisional against Y9-windows.
 *
 * The same figure the F09 registry declares as this setting's default. Duplicated deliberately and
 * narrowly: `packages/config` holds the registry and `packages/core` may not import it, so the fallback
 * has to be spelled here for a database with no `app_setting` row — which is every freshly migrated one.
 * Drift is caught where both packages may be imported at once: `appointment-reschedule.itest.ts` in
 * `packages/fixtures` asserts this constant equals `getDefinition(CANCELLATION_WINDOW_SETTING_KEY)`'s
 * declared default AND that the definition is still `provisional`. A core test cannot make that assertion —
 * `pnpm boundaries` forbids core, including its tests, from importing `packages/config`.
 */
export const DEFAULT_CANCELLATION_WINDOW_HOURS = 24

/** The open question this window is provisional against. Carried in the verdict, not in a comment. */
export const CANCELLATION_WINDOW_OPEN_QUESTION = 'Y9-windows'

/** Hours, as the F09 registry bounds them (`z.number().int().min(0).max(168)`). */
const MAX_CANCELLATION_WINDOW_HOURS = 168

/**
 * A stored window as a whole number of hours, or the provisional default.
 *
 * Normalising rather than throwing, the choice {@link genderMatchingMode} makes and for the same reason
 * reversed: there IS a safe reading here. The flag charges nothing, so neither direction of error costs a
 * customer money — a window of zero would flag nothing and a window of a year would flag everything, and
 * both are worse records than the figure the registry declares. A value written by an older build whose
 * schema was wider therefore reads as 24 rather than failing a cancellation the customer has already made:
 * refusing to cancel because a setting is corrupt turns a cancellation into a no-show, which is the one
 * outcome worse than a mis-flagged one.
 */
export function cancellationWindowHours(value: unknown): number {
  // `Number(null)`, `Number([])` and `Number(false)` are all 0, and 0 is a LEGAL window (flag nothing).
  // Coercing them would make three kinds of corruption indistinguishable from a deliberate zero, so the
  // accepted shapes are named rather than coerced: a number, or the numeric string an older build's
  // wider schema may have stored.
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_CANCELLATION_WINDOW_HOURS) {
    return DEFAULT_CANCELLATION_WINDOW_HOURS
  }
  return parsed
}

/** Whether a cancellation is late, the figure that decided it, and how much notice was actually given. */
export interface CancellationVerdict {
  /** True when the cancellation arrived inside the window. */
  readonly late: boolean
  /** The window in force, in whole hours. Stored beside the flag (0049) so it can be accounted for. */
  readonly windowHours: number
  /** Notice given, in minutes. Negative when the cancellation arrives after the start. */
  readonly noticeMinutes: number
  /** Zero fils, always. See {@link cancellationCharge}. */
  readonly chargeFils: number
  /** Why this is not a charge, in the words the admin panel shows. */
  readonly chargeWhy: string
  /** The open question the window is provisional against. */
  readonly openQuestionId: string
}

export interface CancellationRequest {
  /** When the treatment was due to START. `lower(appointment.period)`, never the room's busy interval. */
  readonly startsAt: Instant
  /** The instant the cancellation was made. An ARGUMENT: core reads no clock. */
  readonly at: Instant
  /**
   * The window in force, **as stored**.
   *
   * `unknown` rather than `number`, and that is what makes the seam work in both directions: the value
   * comes out of `app_setting` through `readCancellationWindow`, which deliberately does not coerce it
   * (`Number(null)` is 0, and 0 is a legal window meaning "flag nothing"). {@link cancellationWindowHours}
   * normalises it here, once, so a corrupt row cannot reach a stored flag as a zero window.
   */
  readonly windowHours: unknown
}

/**
 * The amount a cancellation charges. **Zero, for every input.**
 *
 * A function and not an absence, because it is the seam. `chargeFils` is on the verdict so a caller writes
 * the figure it was given rather than assuming one, and the day a fee policy is agreed (Y9-windows) this is
 * the one place that changes — with the row counts in
 * `packages/fixtures/src/appointment-reschedule.itest.ts` as the assertion that has to be updated
 * deliberately rather than quietly.
 */
export function cancellationCharge(): { readonly fils: number; readonly why: string } {
  return {
    fils: 0,
    why:
      'No cancellation fee is charged. The window is provisional (Y9-windows), no fee policy has been ' +
      'agreed, and the business takes no card payments — so a late cancellation is recorded as a flag ' +
      'and produces no payment, invoice or fee row of any kind.',
  }
}

/**
 * Whether a cancellation made at `at` falls inside the window before `startsAt`.
 *
 * The comparison is `notice < window`, strictly. A cancellation made at exactly the window boundary — 24
 * hours to the minute — is NOT late: the customer did what was asked of them, and a boundary that reads
 * the other way flags the person who complied. `[window, ∞)` is on time and `(-∞, window)` is late, which
 * is the same half-open convention every interval in this build uses.
 *
 * A cancellation after the start is late by this reading too, and deliberately so: the notice is negative,
 * which is less than any window. Whether such a cancellation should instead have been a no-show is the
 * front desk's judgement and not this function's — `no_show` has its own state, its own permission and its
 * own guard.
 */
export function classifyCancellation(request: CancellationRequest): CancellationVerdict {
  const windowHours = cancellationWindowHours(request.windowHours)
  const noticeMinutes = differenceInMinutes(request.startsAt, request.at)
  const charge = cancellationCharge()
  return {
    late: noticeMinutes < windowHours * 60,
    windowHours,
    noticeMinutes,
    chargeFils: charge.fils,
    chargeWhy: charge.why,
    openQuestionId: CANCELLATION_WINDOW_OPEN_QUESTION,
  }
}

/** Every reason the no-show guard refuses. A value, so callers branch on it rather than on prose. */
export const NO_SHOW_GUARD_REFUSALS = [
  /** The appointment has not started yet, so nobody can have failed to arrive for it. */
  'appointment_not_started',
] as const
export type NoShowGuardRefusal = (typeof NO_SHOW_GUARD_REFUSALS)[number]

export type NoShowClockVerdict =
  | { readonly kind: 'allowed'; readonly minutesSinceStart: number }
  | {
      readonly kind: 'refused'
      readonly refusal: NoShowGuardRefusal
      readonly why: string
      /** How long until the appointment starts, in minutes. Positive. */
      readonly minutesUntilStart: number
    }

export interface NoShowRequest {
  /** When the treatment was due to START. `lower(appointment.period)`. */
  readonly startsAt: Instant
  /** The instant the judgement is being made. An ARGUMENT: core reads no clock. */
  readonly at: Instant
}

/**
 * Whether the appointment's start is in the past, which is the only moment a no-show can be judged.
 *
 * `at >= startsAt` is permitted, and the boundary is deliberate in the other direction from the
 * cancellation window: the instant the treatment was due to begin, the client either is or is not in the
 * building, so the fact is knowable exactly then. `at < startsAt` is refused however close it is — a
 * minute before the start, the client may still walk in, and a fee policy reading `no_show` would be
 * charging them for arriving on time.
 *
 * This is a guard and not a transition. `confirmed -> no_show` and `checked_in -> no_show` are legal pairs
 * in B-LIFE-01's table and stay refused for any other `from` status whatever this returns; all this can do
 * is narrow.
 */
export function noShowClockVerdict(request: NoShowRequest): NoShowClockVerdict {
  const minutes = differenceInMinutes(request.at, request.startsAt)
  if (request.at < request.startsAt) {
    return {
      kind: 'refused',
      refusal: 'appointment_not_started',
      why:
        `the appointment starts in ${minutes === 0 ? 'under a minute' : `${-minutes} minute(s)`} and a ` +
        'no-show is a statement that the client did not arrive for a slot that has already begun. The ' +
        'likeliest cause of an early no-show is the wrong appointment being in front of the actor, and ' +
        'the judgement lands on the customer.',
      minutesUntilStart: -minutes,
    }
  }
  return { kind: 'allowed', minutesSinceStart: minutes }
}

/**
 * An `Instant` from the plain number that crossed a package boundary.
 *
 * `packages/db` cannot name the brand — it may not import `packages/core` — so every instant arrives as
 * epoch milliseconds and is branded on this side, which is the arrangement `AvailabilityQueryFacts` uses
 * for exactly the same reason. Refused rather than coerced when it is not a whole number: `NaN` compares
 * false against every bound, so an unparsed timestamp would read as "on time" and as "not started" at
 * once — two wrong answers from one missing check.
 */
export function instantFromEpochMs(value: number, what: string): Instant {
  if (!Number.isInteger(value)) {
    throw new AppError(
      'validation',
      `${what} must be whole epoch milliseconds, received ${JSON.stringify(value)}. NaN compares false ` +
        'against every bound, which would read as "on time" and as "not started" at once.',
      { details: { what, value } },
    )
  }
  return value as Instant
}

/**
 * The two injected seams, as `packages/db` sees them.
 *
 * `packages/db` may never import `packages/core`, so the write path takes these as functions exactly as
 * `createBooking` takes its slot re-check and `transitionAppointment` takes its transition decider. Epoch
 * milliseconds cross the boundary and are branded here, which is the arrangement `solveAvailabilityQuery`
 * uses; `satisfies CancellationPolicy` / `satisfies NoShowClock` in
 * `packages/fixtures/src/appointment-reschedule.itest.ts` is what proves the two declarations of each seam
 * agree, so a field added on one side and not the other is a `pnpm typecheck` failure rather than a rule
 * that silently stopped being applied.
 */
export interface CancellationBoundaryRequest {
  readonly startsAtMs: number
  readonly atMs: number
  /** As stored. See {@link CancellationRequest.windowHours}. */
  readonly windowHours: unknown
}

/** {@link classifyCancellation} across the package boundary. */
export function cancellationVerdictFor(request: CancellationBoundaryRequest): CancellationVerdict {
  return classifyCancellation({
    startsAt: instantFromEpochMs(request.startsAtMs, 'the appointment start'),
    at: instantFromEpochMs(request.atMs, 'the cancellation instant'),
    windowHours: request.windowHours,
  })
}

/** {@link noShowClockVerdict} across the package boundary. */
export function noShowVerdictFor(request: {
  readonly startsAtMs: number
  readonly atMs: number
}): NoShowClockVerdict {
  return noShowClockVerdict({
    startsAt: instantFromEpochMs(request.startsAtMs, 'the appointment start'),
    at: instantFromEpochMs(request.atMs, 'the instant the no-show is judged'),
  })
}

import { ORIGINATION_BASES, type OriginationBasis } from './origination.ts'

/**
 * First touch and last touch: the two claims that OUTLIVE the session they name (A-FIRST-08).
 *
 * ## Why this is two claims and not one column
 *
 * `analytics.attribution` (0096) answers "what originated THIS session". It is purged with the session
 * at ninety days, and it says nothing about a person: one visitor arriving three times from three
 * sources has three rows, none of which is the answer to "where did this customer come from".
 *
 * First touch and last touch are the two answers, and they are different claims that MAY DISAGREE — a
 * customer found through an ad in March and booked through a reminder link in June is `cpc` by first
 * touch and `email` by last touch, and a build that kept one column would be choosing which of those two
 * questions the business is allowed to ask. So there are two, they are stored separately, and the
 * subject of each is different as well: the first touch belongs to the PERSON and the last touch belongs
 * to the BOOKING. One row holding both would mean a second booking overwriting the first booking's last
 * touch, which is the figure every "which channel produced this sale" report divides by.
 *
 * ## Why nothing here holds a foreign key
 *
 * Retention purges `analytics.session` at ninety days (0096). A foreign key in either direction would
 * therefore either block the purge or cascade the attribution away with it, and the attribution is the
 * half that has to survive — it is what a customer's acquisition channel IS, years later. So the session
 * is carried as an opaque `uuid` with no reference, which is the shape A-FIRST-07 chose for
 * `whatsapp_ref.session_reference` for exactly this reason. A dangling reference is the expected state
 * of a row older than the window, not a fault.
 *
 * ## This module is pure
 *
 * It reads no clock and no database: every instant and every candidate touch arrives as an argument,
 * which is what lets `attribution.itest.ts` replay a shuffled set of sessions and assert the answer is
 * the same one every time.
 */

/**
 * The bases an attribution row may carry: `analytics.attribution`'s four, plus `offline`.
 *
 * `offline` is a FIFTH basis and not a reuse of `direct`, and the distinction is the one the coverage
 * figure rests on. `direct` means a browser arrived with nothing to resolve — a real web session whose
 * origination could not be attributed. `offline` means there was no browser at all: a walk-in off the
 * road, or a telephone call. Folding them would make "what share of our paid bookings can we attribute"
 * unanswerable, because the denominator would contain every walk-in the salon has ever had.
 *
 * Derived from `ORIGINATION_BASES` rather than written out, so a fifth web basis cannot arrive without
 * this list gaining it; `attribution.test.ts` holds the derivation against the source.
 */
export const ATTRIBUTION_BASES = Object.freeze([...ORIGINATION_BASES, 'offline']) as readonly (
  | OriginationBasis
  | 'offline'
)[]
export type AttributionBasis = (typeof ATTRIBUTION_BASES)[number]

/** The source an offline booking carries. A-FIRST-08's acceptance line names the value. */
export const OFFLINE_SOURCE = 'offline'
/** The medium an offline booking carries. A-FIRST-08's acceptance line names the value. */
export const OFFLINE_MEDIUM = 'direct'

/**
 * The source value that means "nobody recorded where this came from".
 *
 * The same word `customer_acquisition_source` (0053) uses for the same thing, so a reader comparing the
 * CRM's channel with the attribution's is not comparing two spellings of one absence.
 */
export const UNKNOWN_SOURCE = 'unknown'

/**
 * One touch, as the attribution tables hold it.
 *
 * `sessionReference` is `null` for an offline touch and `howHeard` is `null` for every touch that came
 * through a browser — the two are mutually exclusive by construction here and by CHECK in the database,
 * because a how-heard answer is what the front desk was TOLD and a session is what the server SAW.
 */
export interface AttributionTouch {
  readonly basis: AttributionBasis
  readonly source: string
  readonly medium: string
  /** `''` when unknown, never null: a null dimension in a rollup's primary key never equals a null. */
  readonly campaign: string
  readonly sessionReference: string | null
  readonly howHeard: string | null
  /** When the touch HAPPENED — a session's `started_at`, or the booking's own instant for an offline one. */
  readonly occurredAtMs: number
}

/**
 * A candidate touch, before anything has decided whether it is the first or the last.
 *
 * `sessionReference` is REQUIRED here and nullable on {@link AttributionTouch}: every candidate comes
 * from a session, and it is the tie-break that makes the answer total.
 */
export interface TouchCandidate extends Omit<AttributionTouch, 'sessionReference' | 'howHeard'> {
  readonly sessionReference: string
}

/**
 * The earliest candidate — the FIRST touch.
 *
 * Ordered on the instant and then on the session reference, and the second key is not decoration: two
 * sessions of one visitor can share a `started_at` to the millisecond (a tab restored into two windows
 * is the real case), and without a total order the answer would depend on the order the rows arrived in.
 * A-FIRST-08's acceptance line replays the same sessions SHUFFLED and asserts one answer, which only a
 * total order can give.
 *
 * `undefined` for an empty list, and that is the honest answer rather than an offline touch: "this
 * customer has no session on file" is what the caller has to branch on, and manufacturing an offline
 * first touch here would attribute a web customer to the front desk.
 */
export function firstTouchOf(candidates: readonly TouchCandidate[]): TouchCandidate | undefined {
  return [...candidates].sort(compareTouches)[0]
}

/**
 * The most recent candidate that started AT OR BEFORE the booking, — the LAST touch.
 *
 * The bound is the whole claim. A session that began after the booking was created cannot have produced
 * it, and including it would re-attribute a completed sale to whatever the customer browsed afterwards —
 * which is both wrong and self-reinforcing, because the page they land on next is usually the
 * confirmation. A-FIRST-08's acceptance line asserts the later session "never overwrites it".
 *
 * `<=` and not `<`: a booking taken in the same millisecond as the session that produced it is the
 * ordinary case for a one-page quick-book, and a strict bound would discard exactly the sessions that
 * convert fastest.
 */
export function lastTouchBeforeOf(
  candidates: readonly TouchCandidate[],
  bookingCreatedAtMs: number,
): TouchCandidate | undefined {
  const eligible = candidates.filter((touch) => touch.occurredAtMs <= bookingCreatedAtMs)
  return eligible.sort(compareTouches)[eligible.length - 1]
}

/** The total order both answers are taken from. Instant first, then the session's own id. */
function compareTouches(left: TouchCandidate, right: TouchCandidate): number {
  if (left.occurredAtMs !== right.occurredAtMs) return left.occurredAtMs - right.occurredAtMs
  return left.sessionReference < right.sessionReference ? -1 : 1
}

/**
 * The touch an offline booking carries: a walk-in or a telephone call, with the how-heard answer beside
 * it when the front desk was given one.
 *
 * `howHeard` is normalised to `null` for a blank, because the database refuses a blank one: an empty
 * string in that column is a staff member who pressed Enter, and it would read as an answer in every
 * count of how-heard responses.
 */
export function offlineTouchFor(input: {
  readonly occurredAtMs: number
  readonly howHeard?: string | null
}): AttributionTouch {
  const trimmed = (input.howHeard ?? '').trim()
  return {
    basis: 'offline',
    source: OFFLINE_SOURCE,
    medium: OFFLINE_MEDIUM,
    campaign: '',
    sessionReference: null,
    howHeard: trimmed === '' ? null : trimmed,
    occurredAtMs: input.occurredAtMs,
  }
}

/** A candidate, promoted to the stored shape once it has won. */
export function touchFromCandidate(candidate: TouchCandidate): AttributionTouch {
  return { ...candidate, howHeard: null }
}

/**
 * Whether a source counts towards attribution coverage.
 *
 * Two values do not: `offline`, which is a booking that never touched a browser, and `unknown`, which is
 * a booking whose channel nobody recorded. Both are honest answers and neither is an attribution, which
 * is why the coverage figure exists at all — a build that counted them would report 100% coverage on a
 * day of walk-ins.
 */
export function isAttributedSource(source: string): boolean {
  return source !== OFFLINE_SOURCE && source !== UNKNOWN_SOURCE
}

/**
 * Attribution coverage: the share of paid bookings whose source is neither `offline` nor `unknown`.
 *
 * Per mille and not a float, for the reason every rate in this build is: a percentage computed in
 * floating point and rendered to one decimal place disagrees with the two integers it was computed
 * from, and somebody then has to work out which of the three is wrong.
 *
 * `kind: 'no_paid_bookings'` rather than a zero, which is ADR 0002's rule applied to a share: a day with
 * no paid bookings has no coverage figure, and reporting 0% for it says the marketing failed on a day
 * nothing was sold.
 */
export type AttributionCoverage =
  | {
      readonly kind: 'coverage'
      readonly paidBookings: number
      readonly attributedBookings: number
      readonly coveragePerMille: number
    }
  | { readonly kind: 'no_paid_bookings'; readonly why: string }

export function attributionCoverageOf(paidBookingSources: readonly string[]): AttributionCoverage {
  if (paidBookingSources.length === 0) {
    return {
      kind: 'no_paid_bookings',
      why:
        'no paid booking was settled in this window, so there is no denominator. A share of zero ' +
        'bookings is not 0% coverage: it is no figure, and rendering it as 0% reports a marketing ' +
        'failure on a day nothing was sold (ADR 0002).',
    }
  }
  const attributed = paidBookingSources.filter((source) => isAttributedSource(source)).length
  return {
    kind: 'coverage',
    paidBookings: paidBookingSources.length,
    attributedBookings: attributed,
    // Integer arithmetic throughout, rounded once at the end. `Math.round` and not a truncation,
    // because a truncated share of 999.6 per mille renders as 99.9% on a set where one booking in a
    // thousand is unattributed, and the rounding direction should not be a surprise.
    coveragePerMille: Math.round((attributed * 1000) / paidBookingSources.length),
  }
}

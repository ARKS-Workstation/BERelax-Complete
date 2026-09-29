// Subpath import, not the `@berelax/providers` barrel — see the note in lifecycle.ts.
import type { PlacesDetails, PlacesProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * Places API (New) — the aggregate, and the reviews this adapter exists to throw away (G-REV-02).
 *
 * ## The whole point of this module
 *
 * docs/10 §6 marks it **[UNVERIFIED]** whether the Places terms permit caching review CONTENT: *"Places has
 * historically been restrictive, so check before storing."* Nobody has checked — it is a build-time item in
 * docs/10 §8 and it is unanswered — so the strictest safe reading is that they do not, and this build stores
 * the aggregate and nothing else. ADR 0049 records that decision and its cost.
 *
 * `places.get` returns a curated sample of review bodies whether or not a caller asks for them, so
 * "we do not store them" cannot be a property of the request. It has to be a property of this function, and
 * the way it is made one is {@link PlaceAggregateReading}: a type with no field that can hold a string other
 * than the place id. A caller cannot persist a body it was never given, which is a stronger guarantee than a
 * caller remembering not to — and `packages/fixtures/src/review-fallback-intake.itest.ts` closes the loop by
 * scanning **every text column in the database** for the three fixture bodies after a real run.
 *
 * ## Why the rating comes back as integer tenths
 *
 * Google reports `rating` as a decimal one place wide. The database column is `smallint` tenths, so 4.6 is
 * 46, and the conversion happens here rather than at the write so there is exactly one place that rounds.
 * It is not money and ADR 0007 does not apply, but the reason ADR 0007 exists does: a float that is stored,
 * read back and compared for equality to decide *did the rating move* is a comparison that fails on a value
 * that did not change. `Math.round` rather than a truncation, because Google's own value is already rounded
 * to one place and the float that represents it may be 4.599999999999999.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not decide whether the count went up — that is `apps/worker/src/jobs/review-count-tripwire.ts`,
 * which has the previous reading — and it does not read a clock. One reading in, one reading out; the caller
 * supplies the instant, so every assertion about the tripwire is made on a frozen clock.
 */

/** The field mask this build sends. Re-exported from the fake's constant so there is one list. */
export { PLACES_AGGREGATE_FIELD_MASK } from '@berelax/providers/google'

/** The refusal when Places answers about a different place than the one that was asked for. */
export const PLACES_ANSWERED_ABOUT_ANOTHER_PLACE = 'places-answered-about-another-place'

/**
 * One aggregate reading, and everything this build is willing to know from Places.
 *
 * Every field is a number or the place id. There is deliberately **no** field for a review body, an author
 * name, a review id or a review instant — see the header. Adding one would be the change ADR 0049 forbids,
 * and it would be a visible one rather than a line inside a function.
 */
export interface PlaceAggregateReading {
  readonly placeId: string
  /**
   * The average rating in integer tenths, or `null` for a listing nobody has rated.
   *
   * `null` and `0` are different facts and this build keeps them apart: a new listing has no rating, and a
   * rating of zero is not a value Google can report.
   */
  readonly ratingTenths: number | null
  /** How many ratings the listing has, or `null` for a listing with none. */
  readonly reviewCount: number | null
  /**
   * How many curated review bodies the call returned and this adapter discarded.
   *
   * A count, never the bodies. It is here because a silent discard is indistinguishable from an API that
   * returned nothing, and the difference matters the day somebody asks whether the terms question was ever
   * a real constraint: a non-zero number on the reading is the evidence that bodies arrived and were
   * dropped on purpose.
   */
  readonly curatedReviewsDiscarded: number
}

/**
 * Reads the aggregate for one place.
 *
 * `transport` is the port rather than the registry, so the tripwire job can hand it a scripted fake and this
 * module never learns which one it has.
 *
 * Throws rather than returning a reading when Places answers about a different place. The deep link and the
 * count comparison are both keyed on the place id, so a reading filed under the wrong one would produce an
 * email pointing at somebody else's listing and a count difference computed across two businesses — and a
 * throw reaches `withAgentRun`, which records the run as failed and leaves `last_success_at` alone.
 */
export async function readPlaceAggregate(
  transport: Pick<PlacesProvider, 'getPlace'>,
  args: { readonly placeId: string; readonly fieldMask: readonly string[] },
): Promise<PlaceAggregateReading> {
  const details = await transport.getPlace({ placeId: args.placeId, fieldMask: args.fieldMask })
  if (details.placeId !== args.placeId) {
    throw new AppError(
      'invariant_violated',
      `[${PLACES_ANSWERED_ABOUT_ANOTHER_PLACE}] asked for ${args.placeId} and Places answered about ` +
        `${details.placeId}. Nothing was recorded: the deep link and the count comparison are both keyed ` +
        'on the place id.',
      { details: { asked: args.placeId, answered: details.placeId } },
    )
  }
  return aggregateOf(details)
}

/**
 * The narrowing, as its own exported function.
 *
 * Separated from the call so a test can hand it a `PlacesDetails` carrying bodies and assert what comes out,
 * without a provider. That is the assertion that would fail if somebody widened the reading: a test that
 * could only go through `readPlaceAggregate` would be asserting the fake's shape as much as this function's.
 */
export function aggregateOf(details: PlacesDetails): PlaceAggregateReading {
  return {
    placeId: details.placeId,
    ratingTenths: details.rating === undefined ? null : Math.round(details.rating * 10),
    reviewCount: details.userRatingCount === undefined ? null : details.userRatingCount,
    curatedReviewsDiscarded: details.reviews.length,
  }
}

/**
 * The deep link the owner follows, built from the STORED place id.
 *
 * docs/10 §6: *"a deep link built from the stored `placeId`"*. Stored rather than configured, and the
 * argument is the reason migration 0020 denormalises `place_id` onto every review row: a link built from
 * configuration is a link that keeps working after the configuration is re-pointed at another listing, and
 * it then sends the owner to the wrong business's reviews.
 *
 * `search/?api=1&query=Google&query_place_id=` is Google's own documented URL form for opening a place by
 * id, which is what makes it safe to construct rather than to store: it is a documented template with one
 * variable, not a URL somebody transcribed. The place id is percent-encoded because a place id is opaque and
 * this build must not assume anything about its alphabet.
 */
export function placeReviewsDeepLink(placeId: string): string {
  if (placeId.trim().length === 0) {
    throw new AppError(
      'validation',
      'A reviews deep link needs a stored placeId. An email whose one action is a dead link is worse ' +
        'than no email (the same argument migration 0075 makes for no_reconnect_link_configured).',
    )
  }
  return `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(placeId)}`
}

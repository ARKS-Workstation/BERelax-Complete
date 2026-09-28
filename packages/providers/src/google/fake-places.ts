import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import type { PlacesDetails, PlacesProvider, PlacesReview } from './port.ts'

/**
 * The Places API (New) fake.
 *
 * A separate module from `fake-google.ts` because it stands in for a separately billed, separately enabled
 * and separately gated service — see the port's header. The behaviour it models is the behaviour that
 * changes the code around it:
 *
 * **It returns review BODIES, and the aggregate beside them.** That is what the real API does, and it is the
 * whole reason the adapter above it is worth testing: the acceptance line is *after a run against a Places
 * fixture containing three review bodies, a test asserts none of those body strings is present in any
 * table*. A fake that returned only the aggregate would make that test pass with no adapter at all.
 *
 * **`fieldMask` is mandatory.** The real API rejects a request without one, and a fake that defaulted it
 * would hide the mistake until the first billed call.
 *
 * **The count moves when the fixture says so.** {@link FakePlacesOptions.details} lets a caller script the
 * successive answers, because the tripwire's whole subject is a count that changed between two runs and the
 * only honest way to exercise it is two different answers from the same provider.
 */

export const GOOGLE_PLACES = 'google-places'

/**
 * The field mask this build sends, and the one the adapter is asserted to send.
 *
 * `reviews` is deliberately **absent**. The API returns the curated sample for `places.get` regardless of
 * whether a caller asks for it, so leaving it out of the mask is not a defence — the adapter dropping it is
 * (ADR 0049) — but asking for a field nothing may store would be a request this business cannot justify if
 * anybody ever read the billing or the terms question behind it.
 */
export const PLACES_AGGREGATE_FIELD_MASK: readonly string[] = Object.freeze([
  'id',
  'rating',
  'userRatingCount',
])

/**
 * The three review bodies the aggregate-only assertion scans for.
 *
 * Obviously fictional and deliberately distinctive: each is a phrase no other fixture, seed row, template or
 * document in this repository contains, so a scan for it across every text column cannot match something
 * else and report a pass. They are exported so the test scans for THESE strings rather than for its own copy
 * of them — a second copy would drift, and a drifted copy is a scan that finds nothing and says so happily.
 */
export const PLACES_REVIEW_FIXTURES: readonly PlacesReview[] = Object.freeze([
  {
    name: 'places/fake-al-zahiyah/reviews/fixture-1',
    rating: 5,
    text: 'Zaphod quince sandalwood: the hot stone session was the best hour of my week.',
    authorDisplayName: 'A Google user',
    publishTimeIso: '2026-09-19T14:02:00.000Z',
  },
  {
    name: 'places/fake-al-zahiyah/reviews/fixture-2',
    rating: 4,
    text: 'Zaphod quince tamarind: parking is tight but the treatment room was immaculate.',
    authorDisplayName: 'A Google user',
    publishTimeIso: '2026-09-20T09:41:00.000Z',
  },
  {
    name: 'places/fake-al-zahiyah/reviews/fixture-3',
    rating: 3,
    text: 'Zaphod quince juniper: good massage, reception kept me waiting twenty minutes.',
    authorDisplayName: 'A Google user',
    publishTimeIso: '2026-09-21T19:15:00.000Z',
  },
])

/**
 * The listing's aggregate as the fake reports it by default.
 *
 * `placeId` is the same visibly-fake id `AL_ZAHIYAH_LOCATION` carries, for the reason that fixture gives:
 * a plausible opaque id is indistinguishable from a configured one, and a wrong place id stored as a fact is
 * a deep link and a reply pointed at somebody else's business.
 */
export const PLACES_FIXTURE_PLACE_ID = 'ChIJ-fake-place-al-zahiyah'

export const PLACES_AGGREGATE_FIXTURE: PlacesDetails = Object.freeze({
  placeId: PLACES_FIXTURE_PLACE_ID,
  rating: 4.6,
  userRatingCount: 41,
  reviews: PLACES_REVIEW_FIXTURES,
})

export interface FakePlacesOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
  /**
   * The answers, in order. The last one repeats once the script is exhausted.
   *
   * Scripted rather than mutable state, so a suite that needs 41 then 43 says so in one place instead of
   * reaching into the fake between calls.
   */
  readonly details?: readonly PlacesDetails[]
}

export function createFakePlaces(options: FakePlacesOptions): PlacesProvider {
  const { log, failures } = options
  const script = options.details ?? [PLACES_AGGREGATE_FIXTURE]
  let index = 0

  return {
    name: GOOGLE_PLACES,

    async getPlace(args) {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: GOOGLE_PLACES,
          operation: 'getPlace',
          outcome: 'failure',
          summary: `places.get for ${args.placeId} failed: ${armed}`,
          detail: { failureMode: armed, placeId: args.placeId },
        })
        throw failureError(GOOGLE_PLACES, armed)
      }

      if (args.fieldMask.length === 0) {
        log.record({
          provider: GOOGLE_PLACES,
          operation: 'getPlace',
          outcome: 'failure',
          summary: 'places.get rejected: fieldMask is mandatory',
          detail: { failureMode: 'rejected', placeId: args.placeId },
        })
        throw failureError(GOOGLE_PLACES, 'rejected')
      }

      const answer = script[Math.min(index, script.length - 1)] ?? PLACES_AGGREGATE_FIXTURE
      index += 1
      log.record({
        provider: GOOGLE_PLACES,
        operation: 'getPlace',
        outcome: 'success',
        // The count and the rating, because those are the two figures the tripwire reads. The review
        // bodies are deliberately NOT summarised into the log: the log is shown on an admin screen and in
        // screenshots, and a body in it would be exactly the cached review content ADR 0049 forbids.
        summary:
          `places.get for ${args.placeId}: rating ${answer.rating ?? 'none'}, ` +
          `${answer.userRatingCount ?? 'no'} ratings, ${answer.reviews.length} curated review(s) ` +
          'returned and discarded',
        detail: {
          placeId: args.placeId,
          rating: answer.rating ?? null,
          userRatingCount: answer.userRatingCount ?? null,
          curatedReviewsReturned: answer.reviews.length,
          fieldMask: [...args.fieldMask],
        },
      })
      return { ...answer, placeId: args.placeId }
    },
  }
}

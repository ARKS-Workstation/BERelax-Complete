import { type CallLog, createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  createFakePlaces,
  PLACES_AGGREGATE_FIXTURE,
  PLACES_FIXTURE_PLACE_ID,
  PLACES_REVIEW_FIXTURES,
} from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import {
  aggregateOf,
  PLACES_AGGREGATE_FIELD_MASK,
  PLACES_ANSWERED_ABOUT_ANOTHER_PLACE,
  placeReviewsDeepLink,
  readPlaceAggregate,
} from './places-aggregate.ts'

/**
 * G-REV-02 — the Places adapter, measured on what it does NOT return.
 *
 * The acceptance line's assertion is a scan of every table in the database and it lives in
 * `packages/fixtures/src/review-fallback-intake.itest.ts`, because only a real run can make it. This file
 * makes the narrower claim one step earlier: the value the adapter hands its caller contains none of the
 * three fixture bodies, in any field, at any depth. A caller cannot store what it was never given, and if
 * this assertion fails the database scan cannot pass either.
 *
 * It is asserted by walking the returned value rather than by naming its fields, deliberately. Naming them
 * would be a test that keeps passing after somebody adds `reviews` to the reading and forgets to update it,
 * which is exactly the change ADR 0049 exists to refuse.
 */

const FIELD_MASK = [...PLACES_AGGREGATE_FIELD_MASK]

/** 20:15 Asia/Dubai, frozen. The log's timestamps are asserted nowhere and must still be reproducible. */
const NOW = () => '2026-09-22T16:15:00.000Z'

/** A log and a failure script, so each case arms its own failures and reads its own calls. */
function harness(): { readonly log: CallLog; readonly failures: FailureScript } {
  return { log: createCallLog(NOW), failures: new FailureScript() }
}

/** Every string anywhere inside a value, however deeply nested. */
function stringsIn(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(stringsIn)
  }
  return []
}

describe('acceptance — the reading carries the aggregate and no review content', () => {
  it('drops every curated body, asserted by walking the value rather than naming its fields', () => {
    const reading = aggregateOf(PLACES_AGGREGATE_FIXTURE)
    const strings = stringsIn(reading)
    for (const review of PLACES_REVIEW_FIXTURES) {
      for (const string of strings) {
        expect(string).not.toContain(review.text)
        expect(string).not.toContain(review.authorDisplayName)
        expect(string).not.toContain(review.name)
      }
    }
    // Non-vacuity: the fixture really does carry three bodies, so the loop above had something to find.
    expect(PLACES_REVIEW_FIXTURES).toHaveLength(3)
    expect(stringsIn(PLACES_AGGREGATE_FIXTURE).join('\n')).toContain(
      PLACES_REVIEW_FIXTURES[0]?.text ?? 'x',
    )
    expect(reading.curatedReviewsDiscarded).toBe(3)
  })

  it('reports the aggregate as integer tenths, so a rating comparison is never a float compare', () => {
    expect(aggregateOf({ ...PLACES_AGGREGATE_FIXTURE, rating: 4.6 }).ratingTenths).toBe(46)
    // 4.35 is the value a naive truncation gets wrong: the nearest double is just under it.
    expect(aggregateOf({ ...PLACES_AGGREGATE_FIXTURE, rating: 4.35 }).ratingTenths).toBe(44)
    expect(aggregateOf({ ...PLACES_AGGREGATE_FIXTURE, rating: 5 }).ratingTenths).toBe(50)
  })

  it('keeps "never rated" distinct from zero', () => {
    const unrated = aggregateOf({ placeId: PLACES_FIXTURE_PLACE_ID, reviews: [] })
    expect(unrated.ratingTenths).toBeNull()
    expect(unrated.reviewCount).toBeNull()
    expect(unrated.curatedReviewsDiscarded).toBe(0)
  })
})

describe('the transport call', () => {
  it('sends the field mask it was given and reads back the aggregate', async () => {
    const { log, failures } = harness()
    const places = createFakePlaces({ log, failures, now: NOW })
    const reading = await readPlaceAggregate(places, {
      placeId: PLACES_FIXTURE_PLACE_ID,
      fieldMask: FIELD_MASK,
    })
    expect(reading.reviewCount).toBe(41)
    expect(reading.ratingTenths).toBe(46)
    const call = log.all().at(-1)
    expect(call?.detail?.['fieldMask']).toEqual(FIELD_MASK)
  })

  it('refuses a reading about a different place rather than filing it under the one asked for', async () => {
    const { log, failures } = harness()
    const places = createFakePlaces({
      log,
      failures,
      now: NOW,
      details: [{ ...PLACES_AGGREGATE_FIXTURE, placeId: 'ChIJ-fake-place-airport-terminal-a' }],
    })
    // The fake echoes back the id it was asked about, so the mismatch has to be constructed directly
    // against the narrowing's guard — which is what `readPlaceAggregate` is given here.
    const answering = {
      getPlace: async () => ({
        ...PLACES_AGGREGATE_FIXTURE,
        placeId: 'ChIJ-fake-place-airport-terminal-a',
      }),
    }
    await expect(
      readPlaceAggregate(answering, { placeId: PLACES_FIXTURE_PLACE_ID, fieldMask: FIELD_MASK }),
    ).rejects.toThrow(PLACES_ANSWERED_ABOUT_ANOTHER_PLACE)
    expect(places.name).toBe('google-places')
  })

  it('propagates access_not_granted rather than reporting an empty aggregate', async () => {
    const { log, failures } = harness()
    failures.failNext('access_not_granted')
    const places = createFakePlaces({ log, failures, now: NOW })
    await expect(
      readPlaceAggregate(places, { placeId: PLACES_FIXTURE_PLACE_ID, fieldMask: FIELD_MASK }),
    ).rejects.toThrow()
  })
})

describe('the deep link', () => {
  it('is built from the stored place id and percent-encodes it', () => {
    expect(placeReviewsDeepLink(PLACES_FIXTURE_PLACE_ID)).toBe(
      `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${PLACES_FIXTURE_PLACE_ID}`,
    )
    expect(placeReviewsDeepLink('a b&c')).toContain('a%20b%26c')
  })

  it('refuses a blank place id rather than building a link to nothing', () => {
    expect(() => placeReviewsDeepLink('  ')).toThrow(/stored placeId/)
  })
})

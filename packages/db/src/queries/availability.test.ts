import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { Sql } from '../connection.ts'
import {
  AVAILABILITY_REFUSALS,
  type AvailabilityAnswer,
  type AvailabilityCacheEntry,
  type AvailabilityRequest,
  availabilityCacheTag,
  availabilityError,
  availabilityRefusalOf,
  createAvailabilityCache,
  DEFAULT_AVAILABILITY_TTL_MS,
  joinWaitlist,
  MAX_AVAILABILITY_TTL_MS,
  peekAvailabilityCache,
  queryAvailability,
  WAITLIST_INELIGIBILITY,
  WAITLIST_WINDOW_CONSTRAINT,
} from './availability.ts'

/**
 * B-AVAIL-07 — the half of the availability read path that needs no database.
 *
 * `packages/db` has **no** database in the unit runner, which is why every database-backed assertion for
 * this unit is in `availability.itest.ts` and in `packages/fixtures` — the same correction B-AVAIL-01 made
 * for `booking-constraints`, B-LIFE-02 for `otp` and B-AVAIL-04 for `eligibility`. What is here is the
 * part that is a property of the code rather than of the data: the cache key, the TTL band, the refusal
 * vocabulary and every refusal raised before a statement is issued.
 *
 * The connection those last assertions get is one whose every statement **throws**. That is not a mock of
 * a database: it is what makes "refused before anything was read" a property of the test rather than a
 * claim about it. If a refusal ever stopped happening first, the assertion would fail with the thrown
 * marker instead of quietly passing.
 */

const NO_DATABASE = 'the unit suite has no database and this statement must never be reached'

/** A connection whose every use throws. Asserting a refusal against it proves the refusal came first. */
const unusableSql = (() => {
  const thrower = (): never => {
    throw new Error(NO_DATABASE)
  }
  return new Proxy(thrower, {
    apply: thrower,
    get: thrower,
  }) as unknown as Sql
})()

const REQUEST: AvailabilityRequest = {
  tradingDate: '2099-11-04',
  serviceVariantId: '40000000-0000-4000-8000-000000000001',
  minLeadMinutes: 120,
  maxAdvanceDays: 90,
}

const answer = (overrides: Partial<AvailabilityAnswer> = {}): AvailabilityAnswer => ({
  tradingDate: REQUEST.tradingDate,
  serviceVariantId: REQUEST.serviceVariantId,
  shape: 'solo',
  epoch: '7',
  computedAt: 1_000,
  slots: [],
  rejected: [],
  refusal: null,
  window: null,
  excluded: [],
  cached: false,
  ...overrides,
})

const entry = (overrides: Partial<AvailabilityCacheEntry> = {}): AvailabilityCacheEntry => ({
  tag: availabilityCacheTag(REQUEST),
  epoch: '7',
  computedAt: 1_000,
  answer: answer(),
  ...overrides,
})

describe('availabilityCacheTag', () => {
  it('is stable for one request', () => {
    expect(availabilityCacheTag(REQUEST)).toBe(availabilityCacheTag({ ...REQUEST }))
  })

  it('separates the three axes the manifest names', () => {
    const base = availabilityCacheTag(REQUEST)
    expect(availabilityCacheTag({ ...REQUEST, tradingDate: '2099-11-05' })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, serviceVariantId: 'other' })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, therapistIds: ['a'] })).not.toBe(base)
  })

  it('separates every other field that changes the ANSWER for the same three axes', () => {
    // The control that matters. A key over the three named axes alone would serve one caller's
    // cross-gender slots to another caller under a strict rule, and would serve a solo slot list for a
    // Four Hands request.
    const base = availabilityCacheTag(REQUEST)
    expect(availabilityCacheTag({ ...REQUEST, shape: 'four_hands' })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, clientGender: 'female' })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, genderMatching: 'advisory' })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, minLeadMinutes: 60 })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, maxAdvanceDays: 30 })).not.toBe(base)
    expect(availabilityCacheTag({ ...REQUEST, stepMinutes: 30 })).not.toBe(base)
  })

  it('normalises the matching mode rather than keying on the raw value', () => {
    // A stale `'off'` from a build before B-AVAIL-05 READS as strict everywhere else, so it must not be
    // its own cache tag — two tags for one mode is two memos of one answer.
    expect(availabilityCacheTag({ ...REQUEST, genderMatching: 'off' as never })).toBe(
      availabilityCacheTag({ ...REQUEST, genderMatching: 'strict' }),
    )
  })

  it('treats an absent therapist filter and an empty one as different questions', () => {
    // Absent means every therapist; empty means nobody. `= any(array[]::uuid[])` is false for every row,
    // so the two answers differ and a shared tag would serve one for the other.
    expect(availabilityCacheTag({ ...REQUEST, therapistIds: [] })).not.toBe(
      availabilityCacheTag(REQUEST),
    )
  })

  it('is order- and duplicate-insensitive in the therapist filter', () => {
    const one = availabilityCacheTag({ ...REQUEST, therapistIds: ['b', 'a'] })
    const two = availabilityCacheTag({ ...REQUEST, therapistIds: ['a', 'b', 'a'] })
    expect(one).toBe(two)
  })
})

describe('createAvailabilityCache', () => {
  it('defaults to the shortest of the 30-60 s band', () => {
    expect(createAvailabilityCache().ttlMs).toBe(DEFAULT_AVAILABILITY_TTL_MS)
    expect(DEFAULT_AVAILABILITY_TTL_MS).toBe(30_000)
  })

  it('refuses a memo longer than the band allows, by name', () => {
    const thrown = ((): AppError => {
      try {
        createAvailabilityCache({ ttlMs: MAX_AVAILABILITY_TTL_MS + 1 })
        throw new Error('a memo longer than the band was accepted')
      } catch (error) {
        return error as AppError
      }
    })()
    expect(availabilityRefusalOf(thrown)).toBe('availability_ttl_too_long')
  })

  it('accepts zero, because the strict direction is never the refused one', () => {
    // A zero-TTL memo validates on every read. That is slower and never wrong, which is why only the
    // permissive direction is bounded.
    expect(createAvailabilityCache({ ttlMs: 0 }).ttlMs).toBe(0)
  })

  it('refuses a fractional or negative lifetime', () => {
    expect(() => createAvailabilityCache({ ttlMs: -1 })).toThrow(/availability_ttl_too_long/)
    expect(() => createAvailabilityCache({ ttlMs: 1.5 })).toThrow(/availability_ttl_too_long/)
  })

  it('stores, reads back and forgets an entry', () => {
    const cache = createAvailabilityCache()
    expect(cache.size).toBe(0)
    cache.set(entry())
    expect(cache.size).toBe(1)
    expect(peekAvailabilityCache(cache, availabilityCacheTag(REQUEST))?.epoch).toBe('7')
    cache.delete(availabilityCacheTag(REQUEST))
    expect(cache.size).toBe(0)
  })
})

describe('peekAvailabilityCache', () => {
  it('returns the memo WITHOUT validating it, which is what a stale caller holds', () => {
    // The whole point of the function. A rendered page holds a slot list nobody re-checked, and the
    // stale-cache assertion in packages/fixtures needs to be able to read exactly that.
    const cache = createAvailabilityCache()
    const stale = entry({ epoch: '1', answer: answer({ epoch: '1' }) })
    cache.set(stale)
    expect(peekAvailabilityCache(cache, stale.tag)?.epoch).toBe('1')
  })
})

describe('queryAvailability', () => {
  it('refuses when no solver is injected, before reading anything', async () => {
    // Fail closed, the same shape `createBooking` uses for its slot re-check. A slot list produced
    // without the rule is a slot list nobody computed — and the connection here throws on use, so this
    // also proves the refusal happens before a statement is issued.
    await expect(
      queryAvailability(unusableSql, REQUEST, { solve: undefined as never }),
    ).rejects.toThrow(/availability_not_solved/)
  })

  it('refuses a solver that is not a function at all', async () => {
    await expect(
      queryAvailability(unusableSql, REQUEST, { solve: 'assume it is fine' as never }),
    ).rejects.toThrow(/availability_not_solved/)
  })
})

describe('joinWaitlist', () => {
  it('refuses an empty window before issuing a statement', async () => {
    const at = Date.parse('2099-11-04T11:00:00+04:00')
    await expect(
      joinWaitlist(unusableSql, {
        customerId: '40000000-0000-4000-8000-000000000002',
        serviceVariantId: REQUEST.serviceVariantId,
        tradingDate: REQUEST.tradingDate,
        window: { startsAt: at, endsAt: at },
      }),
    ).rejects.toThrow(/waitlist_window_empty/)
  })

  it('refuses a window that ends before it starts', async () => {
    await expect(
      joinWaitlist(unusableSql, {
        customerId: '40000000-0000-4000-8000-000000000002',
        serviceVariantId: REQUEST.serviceVariantId,
        tradingDate: REQUEST.tradingDate,
        window: {
          startsAt: Date.parse('2099-11-04T20:00:00+04:00'),
          endsAt: Date.parse('2099-11-04T11:00:00+04:00'),
        },
      }),
    ).rejects.toThrow(/waitlist_window_empty/)
  })
})

describe('availabilityError', () => {
  it('names waitlist_one_row_per_window for a unique violation on that constraint', () => {
    const translated = availabilityError({
      code: '23505',
      constraint_name: WAITLIST_WINDOW_CONSTRAINT,
      message: 'duplicate key value violates unique constraint',
    })
    expect(translated).not.toBeNull()
    expect(translated?.message).toContain(WAITLIST_WINDOW_CONSTRAINT)
    expect(availabilityRefusalOf(translated)).toBe('waitlist_window_already_joined')
  })

  it('reads the constraint from either spelling the drivers use', () => {
    const translated = availabilityError({
      code: '23505',
      constraint: WAITLIST_WINDOW_CONSTRAINT,
      message: 'duplicate key',
    })
    expect(availabilityRefusalOf(translated)).toBe('waitlist_window_already_joined')
  })

  it('returns null for a unique violation on any OTHER constraint', () => {
    // The control. A translation that guessed would report a duplicate customer phone number as a
    // waitlist collision, and the caller would tell somebody they were already waiting.
    expect(
      availabilityError({ code: '23505', constraint_name: 'customer_phone_e164_key' }),
    ).toBeNull()
  })

  it('returns null for anything that is not a unique violation', () => {
    expect(
      availabilityError({ code: '23503', constraint_name: WAITLIST_WINDOW_CONSTRAINT }),
    ).toBeNull()
    expect(availabilityError(new Error('disk full'))).toBeNull()
    expect(availabilityError(null)).toBeNull()
  })
})

describe('the refusal vocabularies', () => {
  it('has no duplicate refusal', () => {
    expect(new Set(AVAILABILITY_REFUSALS).size).toBe(AVAILABILITY_REFUSALS.length)
    expect(new Set(WAITLIST_INELIGIBILITY).size).toBe(WAITLIST_INELIGIBILITY.length)
  })

  it('carries every structural refusal into the waitlist reasons', () => {
    // The drift guard. A structural refusal the query can produce and the waitlist cannot name would be
    // handled by `waitlistIneligibilityFrom` throwing — better than defaulting to "eligible", and better
    // still caught here. `availability_not_solved`, `availability_ttl_too_long` and the two waitlist
    // refusals are deliberately absent: none of them is ever an ANSWER's refusal.
    const structural = [
      'not_a_trading_date',
      'variant_not_found',
      'shape_not_offered',
      'no_compatible_room_type',
    ]
    for (const reason of structural) {
      expect(AVAILABILITY_REFUSALS as readonly string[], reason).toContain(reason)
      expect(WAITLIST_INELIGIBILITY as readonly string[], reason).toContain(reason)
    }
  })

  it('names requires_client_gender, which the solver produces and this module does not', () => {
    // B-AVAIL-05's refusal arrives from `@berelax/core` through the injected solver, so it is NOT in
    // AVAILABILITY_REFUSALS — and it still has to be a waitlist reason, because a request that cannot be
    // answered cannot be waited for either.
    expect(WAITLIST_INELIGIBILITY as readonly string[]).toContain('requires_client_gender')
    expect(AVAILABILITY_REFUSALS as readonly string[]).not.toContain('requires_client_gender')
  })

  it('availabilityRefusalOf refuses a name that is not in the vocabulary', () => {
    const invented = new AppError('conflict', 'something went wrong', {
      details: { refusal: 'slot_taken' },
    })
    // `slot_taken` is a BOOKING refusal, not an availability one. Passing it through would let a caller
    // branch on a name this module never raises.
    expect(availabilityRefusalOf(invented)).toBeNull()
  })
})

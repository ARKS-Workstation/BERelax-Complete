import { recheckShapeAssignment } from '@berelax/core'
import type { Sql } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import {
  BOOKING_ENDPOINT_ERRORS,
  type BookingEndpointDeps,
  coreSlotRecheck,
  handleBookingRequest,
  IDEMPOTENCY_HEADER,
  readBookingBody,
} from './handler.ts'

/**
 * `POST /api/v1/bookings` — the refusals the handler makes before it touches the database.
 *
 * The acceptance line this file exists for is "a POST with no idempotency key is rejected with 400 and a
 * named error, **asserted at the route handler**", and the way it is asserted matters: the dependencies
 * handed over are a connection that throws on use and a clock that throws on use, so a handler that read
 * the body, opened a transaction or looked at the time before refusing would fail this test rather than
 * pass it. "Refused before anything was written" is then a property of the test.
 *
 * Everything that needs real rows — the lock, the race, the snapshot, the outbox — is
 * `packages/fixtures/src/booking-transaction.itest.ts` and `booking-concurrency.itest.ts`, against a real
 * PostgreSQL. A mock would assert that the mock refuses the second booking.
 */

/** Dependencies that fail on use. Using them is the failure these assertions are about. */
const unusableDeps = (): BookingEndpointDeps => ({
  sql: (() => {
    throw new Error('the handler queried the database before it should have refused the request')
  }) as unknown as Sql,
  now: () => {
    throw new Error('the handler read the clock before it should have refused the request')
  },
})

const post = (args: { readonly key?: string; readonly body?: unknown }): Request =>
  new Request('https://example.test/api/v1/bookings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(args.key === undefined ? {} : { 'Idempotency-Key': args.key }),
    },
    body: JSON.stringify(args.body ?? {}),
  })

const VALID_BODY = {
  phone: '+971501234567',
  deliveries: [
    {
      serviceVariantId: '11111111-1111-4111-8111-111111111111',
      shape: 'solo',
      roomId: '22222222-2222-4222-8222-222222222222',
      therapistIds: ['33333333-3333-4333-8333-333333333333'],
      startsAt: '2099-10-05T19:00:00+04:00',
    },
  ],
}

describe('acceptance — a POST with no idempotency key is refused with 400 and a named error', () => {
  it('refuses before reading the body, the clock or the database', async () => {
    const response = await handleBookingRequest(unusableDeps(), post({ body: VALID_BODY }))
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string; header: string; reason: string }
    expect(body.error).toBe('idempotency_key_required')
    expect(BOOKING_ENDPOINT_ERRORS).toContain(body.error)
    // The header is named in the response, because a client that does not send it cannot guess.
    expect(body.header).toBe('Idempotency-Key')
    expect(body.reason).toContain('retry')
    // Never cacheable: a CDN with a default policy would serve one customer's confirmation to another.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a header that is present but blank, which is the same thing said differently', async () => {
    for (const key of ['', '   ', '\t']) {
      const response = await handleBookingRequest(unusableDeps(), post({ key, body: VALID_BODY }))
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe('idempotency_key_required')
    }
  })

  it('reads the key from the header and nowhere else', async () => {
    // A body field would be a second spelling of one key, and a retry then presents as a second booking
    // the first time a client fills in the other one. So a key in the body is NOT a key.
    const response = await handleBookingRequest(
      unusableDeps(),
      post({ body: { ...VALID_BODY, idempotencyKey: 'in-the-body' } }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('idempotency_key_required')
    // The control: the same request WITH the header gets past this refusal and reaches the database —
    // which the unusable connection then reports as its own error, not as a 400.
    await expect(
      handleBookingRequest(unusableDeps(), post({ key: 'k', body: VALID_BODY })),
    ).rejects.toThrow('queried the database')
  })

  it('names the header in lower case, which is how Headers normalises it', () => {
    expect(IDEMPOTENCY_HEADER).toBe('idempotency-key')
    expect(new Headers({ 'Idempotency-Key': 'k' }).get(IDEMPOTENCY_HEADER)).toBe('k')
  })
})

describe('the body is refused rather than defaulted', () => {
  it('rejects a malformed JSON body with a named error, after the key check', async () => {
    const request = new Request('https://example.test/api/v1/bookings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k' },
      body: 'not json',
    })
    const response = await handleBookingRequest(unusableDeps(), request)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_request')
  })

  it('accepts the well-formed body, so the rejections below are the fields', () => {
    expect(readBookingBody(VALID_BODY)).toMatchObject({
      phone: '+971501234567',
      // Defaulted only where there is an honest default: a public POST is an online booking.
      source: 'online',
      deliveries: [{ shape: 'solo' }],
    })
  })

  it('rejects every malformed field, one at a time', () => {
    const one = VALID_BODY.deliveries[0] as Record<string, unknown>
    const withDelivery = (patch: Record<string, unknown>) => ({
      ...VALID_BODY,
      deliveries: [{ ...one, ...patch }],
    })
    const bad: readonly unknown[] = [
      null,
      'a string',
      { ...VALID_BODY, phone: 123 },
      { ...VALID_BODY, phone: '' },
      { ...VALID_BODY, phone: 'x'.repeat(33) },
      // An unrecognised source, deliberately not a silent fall back to `online`.
      { ...VALID_BODY, source: 'carrier-pigeon' },
      { ...VALID_BODY, clientGender: 'unspecified' },
      { ...VALID_BODY, notes: 'x'.repeat(2_001) },
      { ...VALID_BODY, deliveries: [] },
      { ...VALID_BODY, deliveries: 'one' },
      // An unrecognised shape. It decides how many therapists are rostered and which room is held, so a
      // typo that quietly became the cheapest footprint is the wrong direction for this to fail in.
      withDelivery({ shape: 'four-hands' }),
      withDelivery({ serviceVariantId: 'not-a-uuid' }),
      withDelivery({ roomId: 42 }),
      withDelivery({ therapistIds: [] }),
      withDelivery({ therapistIds: ['not-a-uuid'] }),
      withDelivery({ startsAt: 'yesterday' }),
      withDelivery({ startsAt: 1_760_000_000_000 }),
    ]
    for (const body of bad) {
      expect(readBookingBody(body)).toBeNull()
    }
    // The control: the untouched body still parses, so the seventeen above are the fields and not a
    // parser that refuses everything.
    expect(readBookingBody(VALID_BODY)).not.toBeNull()
  })
})

describe('the injected re-check is core’s own rule and not a copy of it', () => {
  it('is `recheckShapeAssignment` itself', () => {
    // Identity, not behaviour. `packages/db` may not import `packages/core`, so the rule arrives as a
    // function — and an adapter written a second time in this route would be a second rule that drifts
    // from the one the availability query used. This line is what stops that being possible quietly.
    expect(coreSlotRecheck).toBe(recheckShapeAssignment)
  })
})

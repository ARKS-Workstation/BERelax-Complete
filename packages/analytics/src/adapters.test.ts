import { buildEgressPayload, serialiseEgressPayload, unpermittedEgressTokens } from '@berelax/core'
import { FUNNEL_TERMINAL_STAGE, type FunnelStage } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  createDispatchOutbox,
  type DispatchOutbox,
  TransportScript,
  transportRefusalOf,
} from './fakes.ts'
import {
  createFakeGa4MeasurementProtocol,
  GA4_CLIENT_REFERENCE_OMITTED,
  GA4_MEASUREMENT_PROTOCOL,
  ga4MeasurementBody,
} from './ga4.ts'
import { hashedUserData, PHONE_HASHING_VECTORS, phoneSha256 } from './identity.ts'
import {
  createFakeMetaConversionsApi,
  META_CONVERSIONS_API,
  META_PAST_EVENT_WINDOW_IS_AN_OPEN_QUESTION,
  metaConversionsBody,
  metaUserData,
} from './meta-capi.ts'
import {
  ANALYTICS_ACTION_SOURCES,
  type AnalyticsActionSource,
  type AnalyticsDispatchRequest,
  actionSourceFor,
  BOOKING_SOURCE_ACTION_SOURCE,
  BOOKING_SOURCES,
} from './port.ts'

/**
 * The two adapters' bodies and the action-source table (A-MEAS-03).
 *
 * This file reaches `./ga4.ts` and `./meta-capi.ts` directly, which
 * `analytics-adapters-only-through-the-registry` permits for a test and for nothing else — the bodies
 * cannot be asserted through the registry, because the registry's whole job is to hand back an interface.
 */

const AT = '2026-10-01T18:30:00.000Z'
const EVENT_TIME = '2026-09-29T14:15:30.500Z'

/**
 * The terminal funnel stage, narrowed once.
 *
 * `FUNNEL_TERMINAL_STAGE` is the tuple's last element and `noUncheckedIndexedAccess` makes that
 * `FunnelStage | undefined`, which `buildEgressPayload` will not take. Narrowed by a function that
 * RETURNS it rather than by a `?? 'paid'`, which would be a second statement of which stage is terminal —
 * the thing the taxonomy module exists to prevent.
 */
const TERMINAL: FunnelStage = ((stage: FunnelStage | undefined): FunnelStage => {
  if (stage === undefined) {
    throw new Error('FUNNEL_STAGES is empty, so there is no conversion stage to build a body for.')
  }
  return stage
})(FUNNEL_TERMINAL_STAGE)

const conversion = (actionSource: AnalyticsActionSource): AnalyticsDispatchRequest => ({
  eventId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  destination: GA4_MEASUREMENT_PROTOCOL.destination,
  payload: buildEgressPayload({
    ref: { kind: 'package_template' },
    eventType: TERMINAL,
    quantity: 2,
    valueFils: 32_010,
  }).payload,
  actionSource,
  eventTimeIso: EVENT_TIME,
  userData: hashedUserData({ phone: PHONE_HASHING_VECTORS[1], fbc: 'fbclid-value' }).userData,
})

const fakeContext = (
  appEnv: 'test' | 'production',
): {
  outbox: DispatchOutbox
  script: TransportScript
  appEnv: typeof appEnv
  now: () => string
} => ({
  appEnv,
  now: () => AT,
  outbox: createDispatchOutbox(() => AT),
  script: new TransportScript(),
})

describe('the action source table', () => {
  it('is total over every LIVE booking source, and refuses the imported one', () => {
    // `Record<BookingSource, …>` makes this true by compilation; this is the runtime half, and the
    // equality with the database's own CHECK is asserted in packages/fixtures where a connection exists.
    expect(Object.keys(BOOKING_SOURCE_ACTION_SOURCE).sort()).toEqual(
      [...BOOKING_SOURCES].filter((value) => value !== 'import').sort(),
    )
    // `import` is the one source with no action source, and that is a decision rather than a gap:
    // migration 0130 admits it for a reconstructed visit, the legacy file does not say where the
    // booking was taken, and a dispatch for it would report a visit from before this system existed
    // as a conversion that happened now. The refusal is the behaviour, so it is asserted.
    expect(() => actionSourceFor('import')).toThrow(/no action source is declared/)
  })

  it('maps the three the acceptance line names, table-driven', () => {
    const cases = [
      { bookingSource: 'online', actionSource: 'website' },
      { bookingSource: 'phone', actionSource: 'phone_call' },
      { bookingSource: 'walk_in', actionSource: 'physical_store' },
    ] as const
    for (const { bookingSource, actionSource } of cases) {
      expect(actionSourceFor(bookingSource)).toBe(actionSource)
    }
    // The fourth source exists and is deliberately not in the acceptance line's list: a front-desk
    // booking did not happen on a website and was not a phone call, so the platform vocabulary has one
    // word for it and for a walk-in.
    expect(actionSourceFor('front_desk')).toBe('physical_store')
  })

  it('uses every declared action source, so none is dead', () => {
    const used = new Set(Object.values(BOOKING_SOURCE_ACTION_SOURCE))
    expect([...used].sort()).toEqual([...ANALYTICS_ACTION_SOURCES].sort())
  })

  it('REFUSES an unknown source rather than defaulting to website', () => {
    // The default a lookup falls through to is the first value, and it would report a walk-in as a web
    // order in somebody else's advertising account.
    expect(() => actionSourceFor('kiosk')).toThrow(/refused rather than defaulted/)
  })
})

describe('the GA4 Measurement Protocol body', () => {
  it('carries the opaque code, the count, the value and the currency, and nothing else', () => {
    const body = ga4MeasurementBody(conversion('website'))
    const events = body['events'] as readonly { name: string; params: Record<string, unknown> }[]
    expect(events).toHaveLength(1)
    expect(events[0]?.name).toBe(FUNNEL_TERMINAL_STAGE)
    const params = events[0]?.params ?? {}
    expect(Object.keys(params).sort()).toEqual(
      [
        'action_source',
        'currency',
        'event_id',
        'item_category',
        'quantity',
        'timestamp_micros',
        'value',
      ].sort(),
    )
    expect(params['quantity']).toBe(2)
    expect(params['currency']).toBe('AED')
  })

  it('converts fils to the major unit exactly, through the one conversion', () => {
    const body = ga4MeasurementBody(conversion('website'))
    const events = body['events'] as readonly { params: Record<string, unknown> }[]
    // 32,010 fils is 320.10, not 320.1000000000001 and not 320.
    expect(events[0]?.params['value']).toBe(320.1)
  })

  it('uses MICROseconds, which is the unit mistake GA4 would accept', () => {
    const body = ga4MeasurementBody(conversion('website'))
    const events = body['events'] as readonly { params: Record<string, unknown> }[]
    expect(events[0]?.params['timestamp_micros']).toBe(Date.parse(EVENT_TIME) * 1000)
    // The control: it is NOT milliseconds, which GA4 accepts and dates in 1970.
    expect(events[0]?.params['timestamp_micros']).not.toBe(Date.parse(EVENT_TIME))
  })

  it('omits client_id and SAYS so, rather than inventing one', () => {
    const body = ga4MeasurementBody(conversion('website'))
    expect(Object.hasOwn(body, 'client_id')).toBe(false)
    expect(body['client_id_omitted']).toBe(GA4_CLIENT_REFERENCE_OMITTED)
    // And with one supplied, it is used and the marker is gone — so the omission is a fact about this
    // build rather than a hard-coded refusal A-MEAS-04 would have to unpick.
    const withClient = ga4MeasurementBody({ ...conversion('website'), clientReference: 'ga-1.2' })
    expect(withClient['client_id']).toBe('ga-1.2')
    expect(Object.hasOwn(withClient, 'client_id_omitted')).toBe(false)
  })

  it('drops the value on a non-terminal stage, because the guard already did', () => {
    const nonTerminal: AnalyticsDispatchRequest = {
      ...conversion('website'),
      payload: buildEgressPayload({
        ref: { kind: 'package_template' },
        eventType: 'price_viewed',
        quantity: 1,
        valueFils: 32_000,
      }).payload,
    }
    const events = ga4MeasurementBody(nonTerminal)['events'] as readonly {
      params: Record<string, unknown>
    }[]
    // The figure never reaches the adapter: the guard counted it as a drop. A price on a `price_viewed`
    // event hands over one row of the code mapping, and a few hundred hand over the menu (ADR 0059).
    expect(Object.hasOwn(events[0]?.params ?? {}, 'value')).toBe(false)
    expect(Object.hasOwn(events[0]?.params ?? {}, 'currency')).toBe(false)
  })
})

describe('the Meta Conversions API body', () => {
  it("carries the hashed match keys under Meta's own key names", () => {
    const body = metaConversionsBody(conversion('physical_store'))
    const data = body['data'] as readonly Record<string, unknown>[]
    expect(data).toHaveLength(1)
    const userData = data[0]?.['user_data'] as Record<string, string>
    expect(userData['ph']).toBe(phoneSha256(PHONE_HASHING_VECTORS[1]).sha256)
    expect(userData['fbc']).toBe('fbclid-value')
    // No email on this fixture, so the key is absent rather than null: Meta reads a null match key as a
    // key that matched nobody, which is a different report from no key at all.
    expect(Object.hasOwn(userData, 'em')).toBe(false)
  })

  it('uses WHOLE seconds and floors rather than rounding', () => {
    const body = metaConversionsBody(conversion('physical_store'))
    const data = body['data'] as readonly Record<string, unknown>[]
    const seconds = Math.floor(Date.parse(EVENT_TIME) / 1000)
    expect(data[0]?.['event_time']).toBe(seconds)
    // The fixture instant carries .500, so rounding would land a second LATER — and a future event_time
    // is the one value Meta rejects outright.
    expect(data[0]?.['event_time']).not.toBe(Math.round(Date.parse(EVENT_TIME) / 1000))
  })

  it('carries the action source and the event id, which is what deduplicates against the pixel', () => {
    const body = metaConversionsBody(conversion('phone_call'))
    const data = body['data'] as readonly Record<string, unknown>[]
    expect(data[0]?.['action_source']).toBe('phone_call')
    expect(data[0]?.['event_id']).toBe(conversion('phone_call').eventId)
  })

  it('states the past-event window as an open question rather than a number', () => {
    expect(META_PAST_EVENT_WINDOW_IS_AN_OPEN_QUESTION).toContain('Y1-analytics-credentials')
    // Nothing in this module may carry a day count for the window: a guessed window either silently
    // drops conversions that would have been accepted, or passes ones that will be rejected while this
    // build records them as sent.
    expect(META_PAST_EVENT_WINDOW_IS_AN_OPEN_QUESTION).not.toMatch(/\d+\s*(day|hour|minute)/i)
  })

  it('drops an empty match set to an empty object rather than a set of nulls', () => {
    expect(metaUserData({})).toEqual({})
  })
})

describe('both adapters, through their own fakes', () => {
  const adapters = [
    { constant: GA4_MEASUREMENT_PROTOCOL, create: createFakeGa4MeasurementProtocol },
    { constant: META_CONVERSIONS_API, create: createFakeMetaConversionsApi },
  ] as const

  it('neither transmits off production, and each writes an outbox row instead', async () => {
    // The acceptance line, asserted for BOTH rather than for the shared guard: a shared guard that one
    // adapter stopped calling is exactly the failure a test of the guard alone cannot see.
    for (const { constant, create } of adapters) {
      const context = fakeContext('test')
      const adapter = create(context)
      const accepted = await adapter.send(conversion('website'))
      expect(accepted.provider).toBe(constant.name)
      expect(accepted.transmitted).toBe(false)
      expect(accepted.divertedReason).toContain('APP_ENV=test')
      // Not a bare success: the row is the receipt, and it holds the body that would have been posted.
      const [row] = adapter.drainLocalOutbox()
      expect(row?.outboxId).toBe(accepted.outboxId)
      expect(row?.body).not.toEqual({})
      expect(row?.serialisedPayload).toBe(serialiseEgressPayload(conversion('website').payload))
    }
  })

  it('transmits in production, which is what makes the case above a measurement', async () => {
    // The control. Without it, an adapter that never transmitted under any environment would pass the
    // case above and the guard would be proving nothing.
    for (const { create } of adapters) {
      const adapter = create(fakeContext('production'))
      const accepted = await adapter.send(conversion('website'))
      expect(accepted.transmitted).toBe(true)
      expect(accepted.divertedReason).toBeNull()
    }
  })

  it('raises the armed refusal and writes NO outbox row for it', async () => {
    for (const { create } of adapters) {
      const context = fakeContext('test')
      const adapter = create(context)
      context.script.arm('rate_limited', 1)
      await expect(adapter.send(conversion('website'))).rejects.toSatisfy(
        (error: unknown) => transportRefusalOf(error) === 'rate_limited',
      )
      // An attempt the far end rejected is recorded on the dispatch ROW as an attempt and an error. An
      // outbox row per refused attempt would make A-MEAS-07 count five pushes for one conversion.
      expect(adapter.drainLocalOutbox()).toHaveLength(0)
      // And the next call goes through, which is what the consumer's retry depends on.
      await expect(adapter.send(conversion('website'))).resolves.toMatchObject({
        transmitted: false,
      })
    }
  })

  it('refuses an unparseable event time rather than dating the conversion on receipt', async () => {
    for (const { create } of adapters) {
      const adapter = create(fakeContext('test'))
      await expect(
        adapter.send({ ...conversion('website'), eventTimeIso: 'not an instant' }),
      ).rejects.toThrow(/is not an instant/)
    }
  })

  it('lets no token outside the permitted vocabulary into either serialised body', async () => {
    // The strong form of the claim (A-MEAS-01's own): not "no health term appears" — which holds for a
    // body that leaked a service name instead — but "nothing appears except the closed vocabulary". The
    // hashes, the cookie value, the event id and the platforms' own field names are expected extras, so
    // the assertion is over the PAYLOAD the body carries rather than over the body.
    for (const { create } of adapters) {
      const adapter = create(fakeContext('test'))
      await adapter.send(conversion('website'))
      const [row] = adapter.drainLocalOutbox()
      expect(unpermittedEgressTokens(row?.serialisedPayload ?? '')).toEqual([])
    }
  })
})

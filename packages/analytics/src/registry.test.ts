import type { Config } from '@berelax/config'
import { PENDING } from '@berelax/providers/not-implemented'
import { describe, expect, it } from 'vitest'
import { GA4_MEASUREMENT_PROTOCOL } from './ga4.ts'
import { META_CONVERSIONS_API } from './meta-capi.ts'
import { createAnalyticsDispatchers, DISPATCH_DESTINATIONS } from './registry.ts'

/**
 * Provider selection (A-MEAS-03, ADR 0005, ADR 0022 rule 3).
 *
 * The registry is the only module that reads `ANALYTICS_PROVIDER`, and that claim is enforced by
 * `.dependency-cruiser.cjs` rather than here. What is asserted here is what the setting DOES.
 */
const config = (overrides: Partial<Config> = {}): Config =>
  ({
    APP_ENV: 'test',
    ANALYTICS_PROVIDER: 'fake',
    ...overrides,
  }) as Config

describe('selection', () => {
  it('serves both destinations with a fake by default', () => {
    const dispatchers = createAnalyticsDispatchers({ config: config(), now: () => 'now' })
    expect(dispatchers.all.map((adapter) => adapter.name)).toEqual([
      GA4_MEASUREMENT_PROTOCOL.name,
      META_CONVERSIONS_API.name,
    ])
    for (const destination of DISPATCH_DESTINATIONS) {
      expect(dispatchers.forDestination(destination).name).toBeTruthy()
    }
  })

  it('names the destinations the consent gate names, and no others', () => {
    // The registry is keyed on `CONSENT_GATED_TARGETS`' server-dispatch ids, so the consumer can read a
    // dispatch row's `destination` column and get an adapter with no branch. The equality against the
    // gate's own table is asserted in packages/fixtures, where both halves are importable.
    expect([...DISPATCH_DESTINATIONS].sort()).toEqual(
      ['advertising_conversion_push', 'analytics_measurement_push'].sort(),
    )
  })

  it('throws for a destination no adapter serves, rather than skipping it', () => {
    const dispatchers = createAnalyticsDispatchers({ config: config(), now: () => 'now' })
    // Skipping is the fail-quiet an id typo reaches: the row stays queued for ever with nothing saying
    // why, which looks exactly like a consumer that stopped running.
    expect(() => dispatchers.forDestination('some_other_push')).toThrow(
      /refused rather than skipped/,
    )
  })

  it('resolves real to notImplemented, at CONSTRUCTION', () => {
    // At construction rather than at first use, for `not-implemented.ts`' reason: the failure belongs at
    // boot, where a deploy fails and somebody is watching, not at 22:00 on the one path that needed it.
    expect(() =>
      createAnalyticsDispatchers({
        config: config({ APP_ENV: 'production', ANALYTICS_PROVIDER: 'real' }),
        now: () => 'now',
      }),
    ).toThrow(/is not implemented/)
  })

  it('names what each real adapter needs, and the two prerequisites differ', () => {
    const ga4 = PENDING[GA4_MEASUREMENT_PROTOCOL.name]
    const meta = PENDING[META_CONVERSIONS_API.name]
    expect(ga4?.needs).toBeTruthy()
    expect(meta?.needs).toBeTruthy()
    // Deliberately different: Meta's dataset is behind a Business verification somebody reviews, where a
    // GA4 property is created in an afternoon. An operator reading the wrong one waits for the wrong
    // thing — the mistake `google-places` and `google-business-profile` already record.
    expect(ga4?.needs).not.toBe(meta?.needs)
    expect(`${ga4?.needs} ${meta?.needs}`).toContain('Y1-analytics-credentials')
  })

  it('names no measurement id, pixel id, token or secret anywhere in what it needs', () => {
    // Brief rule 15: a plausible-looking credential is indistinguishable from a configured one. The
    // PENDING entries say what is MISSING; they must not contain anything shaped like a value.
    for (const name of [GA4_MEASUREMENT_PROTOCOL.name, META_CONVERSIONS_API.name]) {
      expect(PENDING[name]?.needs).not.toMatch(/\bG-[A-Z0-9]{6,}\b/)
      expect(PENDING[name]?.needs).not.toMatch(/\b\d{15,}\b/)
    }
  })
})

describe('the shared outbox and script', () => {
  it('are shared between the two adapters, because a rate limit hits everything at once', async () => {
    const dispatchers = createAnalyticsDispatchers({ config: config(), now: () => 'now' })
    expect(dispatchers.outbox).toBeDefined()
    dispatchers.script.arm('rate_limited', 1)
    // One armed refusal, consumed by whichever adapter calls first — which is what makes the script a
    // model of a per-ACCOUNT rate limit rather than a per-adapter one.
    expect(dispatchers.script.armed).toBe(1)
    await expect(
      dispatchers.forDestination(GA4_MEASUREMENT_PROTOCOL.destination).send({
        eventId: 'e',
        destination: GA4_MEASUREMENT_PROTOCOL.destination,
        payload: { eventType: 'paid', categoryCode: 'X', quantity: 1 } as never,
        actionSource: 'website',
        eventTimeIso: '2026-10-01T10:00:00.000Z',
        userData: {},
      }),
    ).rejects.toThrow()
    expect(dispatchers.script.armed).toBe(0)
  })

  it('accepts an injected outbox, so two registries can write to one inbox', () => {
    const first = createAnalyticsDispatchers({ config: config(), now: () => 'now' })
    const second = createAnalyticsDispatchers({
      config: config(),
      now: () => 'now',
      outbox: first.outbox,
    })
    expect(second.outbox).toBe(first.outbox)
  })
})

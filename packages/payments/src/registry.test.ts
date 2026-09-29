import { parseConfig } from '@berelax/config'
import type { IdempotencyKey } from '@berelax/core'
import { aed, fixedClock, TENDER_KINDS, TENDER_TYPES } from '@berelax/core'
import { failureModeOf } from '@berelax/providers/failure'
import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { createManualGateway } from './adapters/manual.ts'
import { createRecordSink } from './record-sink.ts'
import { createPaymentGateways, instrumentCoverage, resolveGateway } from './registry.ts'

/**
 * The registry: selection is configuration, `real` refuses, and every instrument has exactly one home.
 */

const CLOCK = '2026-09-28T19:30:00.000Z'

const config = (overrides: Record<string, string> = {}) =>
  parseConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/berelax_test',
    ...overrides,
  })

const registry = () => createPaymentGateways({ config: config(), clock: fixedClock(CLOCK) })

describe('PAYMENT_PROVIDER=real is refused outside production (ADR 0005)', () => {
  it('refuses at parseConfig, before the registry is reached', () => {
    // Asserted for PAYMENT_PROVIDER specifically rather than for the provider set as a whole. A check that
    // proved the rule for SMS and assumed it for payments is the shape this repository keeps paying for:
    // the assumption holds until somebody adds a key to the schema and not to the refusal list.
    for (const env of ['development', 'test', 'preview', 'staging'] as const) {
      expect(() =>
        parseConfig({
          APP_ENV: env,
          DATABASE_URL: 'postgres://localhost/berelax',
          PAYMENT_PROVIDER: 'real',
        }),
      ).toThrow(/PAYMENT_PROVIDER=real is refused when APP_ENV=/)
    }
  })

  it('names PAYMENT_PROVIDER in the message, so the operator knows which key to change', () => {
    try {
      parseConfig({
        APP_ENV: 'staging',
        DATABASE_URL: 'postgres://localhost/berelax',
        PAYMENT_PROVIDER: 'real',
      })
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      expect((error as Error).message).toContain('PAYMENT_PROVIDER')
      expect((error as Error).message).toMatch(/only production may use real providers/i)
    }
  })

  it('defaults to the fake, so nothing has to opt out of being safe', () => {
    expect(config().PAYMENT_PROVIDER).toBe('fake')
  })

  it('the control: staging with PAYMENT_PROVIDER=fake parses', () => {
    // Without this the refusal above is satisfied by a schema that rejects every staging configuration.
    expect(() =>
      parseConfig({ APP_ENV: 'staging', DATABASE_URL: 'postgres://localhost/berelax' }),
    ).not.toThrow()
  })
})

describe('PAYMENT_PROVIDER=real resolves to an adapter that refuses, never to the fake', () => {
  it('throws at construction, naming the unit and what it needs', () => {
    // A silent fallback to the fake is the worst outcome available: a production deploy that looks
    // connected, takes no money, and sends a receipt for it.
    try {
      createPaymentGateways({
        config: parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://localhost/berelax',
          PAYMENT_PROVIDER: 'real',
        }),
        clock: fixedClock(CLOCK),
      })
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) {
        expect(error.kind).toBe('provider_unavailable')
        expect(error.details['unit']).toBe('Y-PAY')
        expect(String(error.details['needs'])).toMatch(/merchant account/i)
      }
    }
  })

  it('the control: production with the fake builds both gateways', () => {
    const built = createPaymentGateways({
      config: parseConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgres://localhost/berelax',
      }),
      clock: fixedClock(CLOCK),
    })
    expect(built.all).toHaveLength(2)
  })
})

describe('every instrument has exactly one gateway', () => {
  it('serves every tender kind', () => {
    const coverage = instrumentCoverage(registry())
    for (const kind of TENDER_KINDS) {
      expect(coverage[kind], `no gateway serves "${kind}"`).toHaveLength(1)
    }
  })

  it('routes each kind to the gateway whose registry adapter matches', () => {
    // The tender registry says which ADAPTER owns each kind; this asserts the gateway that answers agrees.
    // Without it the mapping could be total and still put an online card through the till.
    const built = registry()
    for (const kind of TENDER_KINDS) {
      const expected = TENDER_TYPES[kind].adapter === 'gateway' ? built.cards : built.till
      expect(built.byInstrument(kind).name, `"${kind}" routed wrongly`).toBe(expected.name)
    }
  })

  it('keeps the till adapter real in every environment', () => {
    // Cash taken at the desk is recorded, not sent anywhere. A fake till would make the ledger fictional.
    expect(registry().till.capabilities.hasExternalService).toBe(false)
    expect(registry().till.serves).toContain('cash')
  })

  it('refuses an instrument no gateway serves, rather than picking the nearest', () => {
    const tillOnly = [
      createManualGateway({ clock: fixedClock(CLOCK), records: createRecordSink() }),
    ]
    expect(() => resolveGateway(tillOnly, 'card_online')).toThrow(/NoGatewayServesInstrument/)
  })

  it('refuses two gateways claiming one instrument, rather than ordering them', () => {
    const deps = { clock: fixedClock(CLOCK), records: createRecordSink() }
    const twice = [createManualGateway(deps), createManualGateway(deps)]
    expect(() => resolveGateway(twice, 'cash')).toThrow(/2 gateways claim "cash"/)
  })

  it('the control: one gateway resolves', () => {
    const tillOnly = [
      createManualGateway({ clock: fixedClock(CLOCK), records: createRecordSink() }),
    ]
    expect(resolveGateway(tillOnly, 'cash').name).toBe('manual-till')
  })
})

describe('one sink and one failure script across the registry', () => {
  it('records movements from both gateways into one sink', async () => {
    // The admin has one payments screen. Two sinks would mean a cash payment and a card payment could not
    // be reconciled against each other, which is the whole point of a shared log (ADR 0022).
    const built = registry()
    await built.till.authorise({
      amount: aed(350),
      instrument: 'cash',
      idempotencyKey: 'reg-till' as IdempotencyKey,
      reference: 'REG-1',
    })
    await built.cards.authorise({
      amount: aed(350),
      instrument: 'card_online',
      idempotencyKey: 'reg-card' as IdempotencyKey,
      reference: 'REG-2',
    })
    expect(new Set(built.records.all().map((movement) => movement.gateway)).size).toBe(2)
  })

  it('arms a failure on the card gateway and not on the till', async () => {
    const built = registry()
    built.failures.failAlways('server_error')
    // Matched on `failureModeOf` and not on the message. ADR 0022 puts the mode and its retryability in
    // `details` precisely so a retry policy can branch on them without parsing prose, and the first version
    // of this assertion read the message — which says "The provider returned an internal error." and names
    // no mode at all, so it would have passed for any of the seven.
    const armed = await built.cards
      .authorise({
        amount: aed(350),
        instrument: 'card_online',
        idempotencyKey: 'reg-armed-card' as IdempotencyKey,
        reference: 'REG-3',
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(armed, 'the armed failure did not fire').not.toBeNull()
    expect(failureModeOf(armed)).toBe('server_error')
    // The till has no external service, so an armed failure cannot reach it. A till that could be made to
    // fail by a test switch would be a till whose failures were fiction.
    await expect(
      built.till.authorise({
        amount: aed(350),
        instrument: 'cash',
        idempotencyKey: 'reg-armed-till' as IdempotencyKey,
        reference: 'REG-4',
      }),
    ).resolves.toBeDefined()
  })
})

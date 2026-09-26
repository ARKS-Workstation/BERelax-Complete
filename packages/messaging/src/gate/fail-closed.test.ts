/**
 * Failing closed, asserted per evaluator.
 *
 * The transport here is a stub that records what it was asked to send and nothing else — no provider,
 * no fake, no registry. That is deliberate: the claim under test is *the transport was never called*,
 * and a claim about zero calls is only worth making against something that counts every one.
 *
 * Each case pairs its assertion with the same send through healthy evaluators, which must be delivered.
 * "Blocked" is the easy assertion to make pass by accident.
 */
import { fixedClock, type Instant, type LocalDateTime, type TimeZone } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { InMemoryOutbox } from '../outbox.ts'
import type { MessageId } from '../port.ts'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  type SendContext,
  type SendRequest,
  sendMessage,
  type TransportRequest,
} from '../send.ts'
import { PROVISIONAL_SENDER_IDS } from '../sender-identity.ts'
import {
  evaluateGate,
  type GateContext,
  type GateEvaluators,
  TDRA_PROMOTIONAL_WINDOW,
} from './index.ts'

/** 14:00 Asia/Dubai: trading, and well inside the promotional window. Nothing here is about timing. */
const AFTERNOON = '2026-09-18T10:00:00.000Z'

const OFFER: ClassifiedTemplate = {
  key: 'campaign.offer',
  messageClass: 'promotional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Two treatments for the price of one this week. Stop: {{link}}',
  variables: ['link'],
}

const CONFIRMATION: ClassifiedTemplate = {
  key: 'booking.confirmed',
  messageClass: 'transactional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Booking confirmed for {{date}} at {{time}}. Details or changes: {{link}}',
  variables: ['date', 'time', 'link'],
}

const VALUES = {
  link: 'https://be.relax/b/7',
  date: '19 Sep',
  time: '21:00',
} as const

let sequence = 0
function requestFor(template: ClassifiedTemplate): SendRequest {
  sequence += 1
  return {
    id: `msg-${sequence}` as MessageId,
    template,
    values: VALUES,
    recipient: '+971528239069',
  }
}

/** Counts every call, including one that would have failed. */
function countingTransport(): ClassRoutedTransport & { readonly calls: TransportRequest[] } {
  const calls: TransportRequest[] = []
  return {
    channel: 'sms',
    calls,
    async send(request: TransportRequest) {
      calls.push(request)
      return {
        kind: 'accepted',
        providerMessageId: `stub-${calls.length}`,
        segments: 1,
        costFils: 9,
      }
    },
  }
}

const HEALTHY: GateEvaluators = {
  hasConsent: () => true,
  isSuppressed: () => false,
  frequencyCapReached: () => false,
}

const explode = (what: string) => (): never => {
  throw new Error(`${what} is unavailable`)
}

function contextWith(evaluators: GateEvaluators): {
  readonly ctx: SendContext
  readonly transport: ReturnType<typeof countingTransport>
} {
  const transport = countingTransport()
  return {
    transport,
    ctx: {
      // Production, so nothing here can pass because the staging guard diverted it first.
      appEnv: 'production',
      outboundAllowlist: [],
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [transport],
      outbox: new InMemoryOutbox(),
      clock: fixedClock(AFTERNOON),
      gate: {
        marketingKillSwitch: false,
        promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
        evaluators,
      },
    },
  }
}

/** The clock reader the quiet-hours rule uses. Throwing here is a clock that cannot answer. */
const unreadableClock = (_instant: Instant, _zone: TimeZone): LocalDateTime => {
  throw new Error('the timezone database is unavailable')
}

describe('an evaluator that cannot decide never resolves to allowed', () => {
  const cases = [
    {
      evaluator: 'consent' as const,
      // A connection pool exhausted mid-campaign. The tempting default is to carry on.
      evaluators: { ...HEALTHY, hasConsent: explode('the consent store') },
    },
    {
      evaluator: 'suppression' as const,
      evaluators: { ...HEALTHY, isSuppressed: explode('the suppression list') },
    },
    {
      evaluator: 'quiet_hours' as const,
      evaluators: { ...HEALTHY, localTimeAt: unreadableClock },
    },
  ]

  for (const { evaluator, evaluators } of cases) {
    it(`records blocked_unevaluable and calls no transport when ${evaluator} throws`, async () => {
      const { ctx, transport } = contextWith(evaluators)

      const result = await sendMessage(ctx, requestFor(OFFER))

      expect(result).toMatchObject({ kind: 'blocked', reason: 'blocked_unevaluable', evaluator })
      expect(transport.calls).toHaveLength(0)
      expect(ctx.outbox.size).toBe(0)
    })
  }

  it('delivers the same message through healthy evaluators, so the three above are not vacuous', async () => {
    const { ctx, transport } = contextWith(HEALTHY)

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({ kind: 'sent', senderId: 'AD-BERELAX' })
    expect(transport.calls).toHaveLength(1)
    expect(transport.calls[0]?.senderId?.messageClass).toBe('promotional')
  })

  it('blocks on the frequency-cap evaluator too, which is the fourth stored input', async () => {
    const { ctx, transport } = contextWith({
      ...HEALTHY,
      frequencyCapReached: explode('the frequency ledger'),
    })

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'blocked_unevaluable',
      evaluator: 'frequency_cap',
    })
    expect(transport.calls).toHaveLength(0)
  })

  it('treats a non-boolean answer as unevaluable, not as falsy', async () => {
    // A repository that answers `undefined` on an unexpected cache miss satisfies a `boolean`
    // signature at compile time. Falsy would read as "no consent" for consent and as "not suppressed"
    // for suppression: the same non-answer blocking one check and allowing the other.
    const lying = {
      ...HEALTHY,
      isSuppressed: (() => undefined) as unknown as GateEvaluators['isSuppressed'],
    }
    const { ctx, transport } = contextWith(lying)

    const result = await sendMessage(ctx, requestFor(OFFER))

    expect(result).toMatchObject({
      kind: 'blocked',
      reason: 'blocked_unevaluable',
      evaluator: 'suppression',
    })
    expect(transport.calls).toHaveLength(0)
  })
})

describe('an unevaluable promotional input never stops transactional traffic', () => {
  it('delivers a booking confirmation while all three evaluators are throwing', async () => {
    // The containment ADR 0016 is about. An unreachable consent store is a marketing problem; it must
    // not become the reason a customer never learns their appointment is confirmed.
    const { ctx, transport } = contextWith({
      hasConsent: explode('the consent store'),
      isSuppressed: explode('the suppression list'),
      frequencyCapReached: explode('the frequency ledger'),
      localTimeAt: unreadableClock,
    })

    const result = await sendMessage(ctx, requestFor(CONFIRMATION))

    expect(result).toMatchObject({ kind: 'sent', senderId: 'BERELAX' })
    expect(transport.calls).toHaveLength(1)
  })

  it('delivers a booking confirmation with the marketing kill switch engaged', async () => {
    const { ctx, transport } = contextWith(HEALTHY)
    const killed: SendContext = { ...ctx, gate: { ...ctx.gate, marketingKillSwitch: true } }

    const result = await sendMessage(killed, requestFor(CONFIRMATION))

    expect(result.kind).toBe('sent')
    expect(transport.calls).toHaveLength(1)
  })
})

describe('the gate reads the cheapest refusal first', () => {
  const gateWith = (evaluators: GateEvaluators, killSwitch = false): GateContext => ({
    marketingKillSwitch: killSwitch,
    promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
    evaluators,
  })

  const promotional = {
    id: 'g1' as MessageId,
    channel: 'sms' as const,
    messageClass: 'promotional' as const,
    recipient: '+971528239069',
    body: 'Two treatments for the price of one this week.',
    templateKey: 'campaign.offer',
    locale: 'en' as const,
  }

  it('does not read the consent store when the kill switch is engaged', () => {
    // A stopped campaign should not be hammering the consent store, and an unreachable one should not
    // change what a stopped campaign does.
    let reads = 0
    const decision = evaluateGate(
      gateWith(
        {
          ...HEALTHY,
          hasConsent: () => {
            reads += 1
            return true
          },
        },
        true,
      ),
      promotional,
      fixedClock(AFTERNOON).now(),
    )

    expect(decision).toMatchObject({ kind: 'refuse', reason: 'marketing_kill_switch' })
    expect(reads).toBe(0)
  })

  it('refuses a suppressed recipient who has consent', () => {
    const decision = evaluateGate(
      gateWith({ ...HEALTHY, isSuppressed: () => true }),
      promotional,
      fixedClock(AFTERNOON).now(),
    )
    expect(decision).toMatchObject({ kind: 'refuse', reason: 'refused_suppressed' })
  })

  it('refuses a contact whose weekly allowance is spent', () => {
    const decision = evaluateGate(
      gateWith({ ...HEALTHY, frequencyCapReached: () => true }),
      promotional,
      fixedClock(AFTERNOON).now(),
    )
    expect(decision).toMatchObject({ kind: 'refuse', reason: 'refused_frequency_cap' })
  })
})

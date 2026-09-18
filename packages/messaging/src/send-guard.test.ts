import type { AppEnv } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import { createGuardedTransport, InMemoryOutbox } from './outbox.ts'
import type { MessageId, OutboundMessage, SendOutcome, Transport } from './port.ts'
import { guardOutbound } from './send-guard.ts'

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  id: 'm1' as MessageId,
  channel: 'sms',
  messageClass: 'transactional',
  recipient: '+971501234567',
  body: 'Your appointment is confirmed.',
  templateKey: 'booking.confirmed',
  locale: 'en',
  ...overrides,
})

const NON_PRODUCTION: readonly AppEnv[] = ['development', 'test', 'preview', 'staging']

describe('guardOutbound', () => {
  for (const appEnv of NON_PRODUCTION) {
    it(`diverts a real recipient when APP_ENV=${appEnv}`, () => {
      const decision = guardOutbound({ appEnv, outboundAllowlist: [] }, message())
      expect(decision.kind).toBe('divert')
    })
  }

  it('delivers in production', () => {
    const decision = guardOutbound({ appEnv: 'production', outboundAllowlist: [] }, message())
    expect(decision.kind).toBe('deliver')
  })

  it('delivers to an allowlisted recipient outside production, so a developer can test', () => {
    const decision = guardOutbound(
      { appEnv: 'staging', outboundAllowlist: ['+971501234567'] },
      message(),
    )
    expect(decision.kind).toBe('deliver')
  })

  it('matches the allowlist case-insensitively and ignores surrounding whitespace', () => {
    const decision = guardOutbound(
      { appEnv: 'staging', outboundAllowlist: ['  DEV@Example.COM '] },
      message({ channel: 'email', recipient: 'dev@example.com' }),
    )
    expect(decision.kind).toBe('deliver')
  })

  it('diverts a promotional message to a non-allowlisted recipient just the same', () => {
    const decision = guardOutbound(
      { appEnv: 'staging', outboundAllowlist: ['+971500000000'] },
      message({ messageClass: 'promotional', recipient: '+971509999999' }),
    )
    expect(decision.kind).toBe('divert')
  })
})

describe('createGuardedTransport', () => {
  const recordingTransport = (): Transport & { readonly sent: OutboundMessage[] } => {
    const sent: OutboundMessage[] = []
    return {
      channel: 'sms',
      sent,
      async send(m: OutboundMessage): Promise<SendOutcome> {
        sent.push(m)
        return { kind: 'sent', providerMessageId: 'provider-1' }
      },
    }
  }

  it('never reaches the inner transport when the guard diverts', async () => {
    const inner = recordingTransport()
    const outbox = new InMemoryOutbox()
    const transport = createGuardedTransport({
      inner,
      decide: (m) => guardOutbound({ appEnv: 'staging', outboundAllowlist: [] }, m),
      outbox,
      now: () => '2026-09-18T06:00:00.000Z',
    })

    const outcome = await transport.send(message())

    expect(outcome.kind).toBe('diverted')
    expect(inner.sent).toHaveLength(0)
    expect(outbox.size).toBe(1)
  })

  it('records a diverted message with its reason rather than dropping it', async () => {
    const outbox = new InMemoryOutbox()
    const transport = createGuardedTransport({
      inner: recordingTransport(),
      decide: (m) => guardOutbound({ appEnv: 'test', outboundAllowlist: [] }, m),
      outbox,
      now: () => '2026-09-18T06:00:00.000Z',
    })

    await transport.send(message())
    const [entry] = outbox.all()
    expect(entry?.reason).toContain('OUTBOUND_ALLOWLIST')
    expect(entry?.message.templateKey).toBe('booking.confirmed')
    expect(entry?.recordedAtIso).toBe('2026-09-18T06:00:00.000Z')
  })

  it('reaches the inner transport in production', async () => {
    const inner = recordingTransport()
    const transport = createGuardedTransport({
      inner,
      decide: (m) => guardOutbound({ appEnv: 'production', outboundAllowlist: [] }, m),
      outbox: new InMemoryOutbox(),
      now: () => '2026-09-18T06:00:00.000Z',
    })

    const outcome = await transport.send(message())
    expect(outcome).toEqual({ kind: 'sent', providerMessageId: 'provider-1' })
    expect(inner.sent).toHaveLength(1)
  })
})

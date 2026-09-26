import type { AppEnv } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import type { MessageId, OutboundMessage } from './port.ts'
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

/**
 * `describe('createGuardedTransport')` USED TO BE HERE, and its three cases are not lost.
 *
 * C-AUTO-04 removed `createGuardedTransport`: it was a second send path that applied this guard and
 * nothing else (see `outbox.ts` for the whole argument). Its three claims — a diverted message never
 * reaches the transport, it is recorded in the outbox with its reason and instant, and production
 * delivers — are all asserted through the REAL choke point instead, in `send.test.ts`: 'diverts to the
 * local outbox instead of sending', 'delivers to an allowlisted recipient' and the production cases
 * above them. Asserting them there is strictly stronger, because those run the gate, the identity
 * resolution and the template judgement as well, which is the order a real send takes.
 */

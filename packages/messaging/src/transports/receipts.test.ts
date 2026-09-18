/**
 * The vendor-status mappings, and the drains that produce them.
 *
 * This is the file the vendor-independence claim rests on: the lifecycle is ours, the vendors' words are
 * theirs, and the whole of the translation is two tables in this directory. So the tables are asserted
 * exhaustively — every word the vendor's own union declares, with the value it maps to — and the case
 * that matters most is asserted negatively as well: **an unrecognised status must not become
 * `delivered`.** A mapping with a `default:` branch would pass a "delivered is delivered" test and
 * silently report every future vocabulary change as a successful delivery.
 */
import { parseConfig } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import type { MessageId, OutboundMessage } from '../port.ts'
import { PROVISIONAL_SENDER_IDS } from '../send.ts'
import { createResendTransport, mapResendEvent, RESEND_EVENT_MAP } from './resend.ts'
import { createSmsalaTransport, mapSmsalaStatus, SMSALA_STATUS_MAP } from './smsala.ts'

const NOW = '2026-09-18T10:00:00.000Z'
const FROM = { address: 'not-configured@example.invalid' }

const config = parseConfig({
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://localhost/berelax_test',
})

function smsMessage(recipient: string): OutboundMessage {
  return {
    id: 'm1' as MessageId,
    channel: 'sms',
    messageClass: 'transactional',
    recipient,
    body: 'Your appointment is confirmed.',
    templateKey: 'booking.confirmed',
    locale: 'en',
  }
}

function emailMessage(recipient: string): OutboundMessage {
  return {
    id: 'm2' as MessageId,
    channel: 'email',
    messageClass: 'transactional',
    recipient,
    subject: 'Your tax invoice',
    body: 'Your tax invoice INV-1042 is attached.',
    templateKey: 'invoice.issued',
    locale: 'en',
  }
}

describe('SMSala', () => {
  it('maps every word its own union declares', () => {
    // The vendor's five, from packages/providers/src/sms/port.ts. `satisfies` makes a sixth a compile
    // error; this asserts the five that exist are all handled and none was quietly dropped.
    expect(Object.keys(SMSALA_STATUS_MAP).sort()).toEqual([
      'accepted',
      'delivered',
      'expired',
      'failed',
      'rejected',
    ])
    expect(mapSmsalaStatus('accepted')).toBe('sent')
    expect(mapSmsalaStatus('delivered')).toBe('delivered')
    // Three vendor words, one lifecycle state — and each keeps its own word on the receipt row, because
    // an expiry (a handset switched off for 48 hours) and a rejection (a number that will never work)
    // are different pieces of work for an operator.
    expect(mapSmsalaStatus('failed')).toBe('failed')
    expect(mapSmsalaStatus('expired')).toBe('failed')
    expect(mapSmsalaStatus('rejected')).toBe('failed')
  })

  it('maps a word it does not know to nothing, and above all not to delivered', () => {
    for (const unknown of ['DELIVRD', 'undeliverable', 'queued_at_operator', '', 'DELIVERED']) {
      expect(mapSmsalaStatus(unknown), unknown).toBeNull()
      expect(mapSmsalaStatus(unknown), unknown).not.toBe('delivered')
    }
    // The control. If the table were empty or the lookup broken, every case above would pass.
    expect(mapSmsalaStatus('delivered')).toBe('delivered')
  })

  it('drains both registered identities, with ids that cannot collide', async () => {
    const sms = createSmsalaTransport({ config, now: () => NOW })
    const transactional = await sms.transport.send({
      message: smsMessage('+971528239069'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'booking.confirmed:m1',
    })
    const promotional = await sms.transport.send({
      message: { ...smsMessage('+971528239070'), messageClass: 'promotional' },
      senderId: PROVISIONAL_SENDER_IDS.promotional,
      idempotencyKey: 'campaign.offer:m2',
    })
    expect(transactional.kind).toBe('accepted')
    expect(promotional.kind).toBe('accepted')
    if (transactional.kind !== 'accepted' || promotional.kind !== 'accepted') return
    // The vendor's own id, unprefixed, because it is persisted and quoted at SMSala support. It is
    // derived from the idempotency key rather than counted, which is what stops the two identities'
    // instances — this transport holds one each — from both issuing `smsala-000001`.
    expect(transactional.providerMessageId).toMatch(/^smsala-[0-9a-f]{12}$/)
    expect(promotional.providerMessageId).toMatch(/^smsala-[0-9a-f]{12}$/)
    expect(transactional.providerMessageId).not.toBe(promotional.providerMessageId)
    // Stable, not random: the same key in another process is the same id, which is what lets a stored
    // row still match a receipt after a restart — and what keeps a screenshot byte-identical.
    const again = createSmsalaTransport({ config, now: () => NOW })
    const replayed = await again.transport.send({
      message: smsMessage('+971528239069'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'booking.confirmed:m1',
    })
    expect(replayed.kind === 'accepted' && replayed.providerMessageId).toBe(
      transactional.providerMessageId,
    )

    const drained = await sms.receipts.drain()
    expect(drained.map((r) => r.providerMessageId).sort()).toEqual(
      [transactional.providerMessageId, promotional.providerMessageId].sort(),
    )
    expect(drained.every((r) => r.vendor === 'smsala')).toBe(true)
    expect(drained.every((r) => r.mapped === 'delivered')).toBe(true)
    // Drained means drained: a second pass has nothing, so the DLR job cannot apply the same receipt
    // twice inside one process.
    expect(await sms.receipts.drain()).toEqual([])
  })
})

describe('Resend', () => {
  it('maps every event its own union declares', () => {
    expect(Object.keys(RESEND_EVENT_MAP).sort()).toEqual([
      'bounced',
      'complained',
      'delivered',
      'opened',
    ])
    expect(mapResendEvent('delivered')).toBe('delivered')
    expect(mapResendEvent('bounced')).toBe('failed')
    // A complaint happens AFTER a successful delivery: the message arrived and the reader pressed a
    // button. Recording it as failed would tell an operator a confirmation never landed.
    expect(mapResendEvent('complained')).toBe('no_lifecycle_change')
    expect(mapResendEvent('opened')).toBe('no_lifecycle_change')
  })

  it('maps an event it does not know to nothing', () => {
    expect(mapResendEvent('deliveryDelayed')).toBeNull()
    expect(mapResendEvent('clicked')).toBeNull()
    expect(mapResendEvent('delivered')).toBe('delivered')
  })

  it('sends both parts, and drains the event the address asked for', async () => {
    const email = createResendTransport({ config, now: () => NOW, from: FROM })
    const accepted = await email.transport.send({
      message: emailMessage('guest@example.com'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'invoice.issued:m2',
    })
    expect(accepted.kind).toBe('accepted')
    if (accepted.kind !== 'accepted') return
    // Not segment-billed: the SMS arithmetic must not reach a channel billed per message.
    expect(accepted.segments).toBe(0)
    expect(accepted.costFils).toBe(0)
    const call = email.calls.forProvider('resend').at(-1)
    expect(call?.outcome).toBe('success')

    const drained = await email.receipts.drain()
    expect(drained).toHaveLength(1)
    expect(drained[0]).toMatchObject({
      vendor: 'resend',
      vendorStatus: 'delivered',
      mapped: 'delivered',
      providerMessageId: accepted.providerMessageId,
    })
  })

  it('reports a bounce as a failure and a complaint as neither', async () => {
    const email = createResendTransport({ config, now: () => NOW, from: FROM })
    await email.transport.send({
      message: emailMessage('bounced@example.com'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'invoice.issued:bounce',
    })
    await email.transport.send({
      message: emailMessage('complained@example.com'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'invoice.issued:complaint',
    })
    const drained = await email.receipts.drain()
    expect(drained.map((r) => [r.vendorStatus, r.mapped])).toEqual([
      ['bounced', 'failed'],
      ['complained', 'no_lifecycle_change'],
    ])
    // The provider's own suppression is what a complaint actually costs, and it is the provider's to
    // enforce — which is why it is not modelled as a status change here.
    expect(await email.provider.isSuppressed('complained@example.com')).toBe(true)
    expect(await email.provider.isSuppressed('guest@example.com')).toBe(false)
  })

  it('refuses an email whose template produced no subject', async () => {
    const email = createResendTransport({ config, now: () => NOW, from: FROM })
    const { subject: _dropped, ...withoutSubject } = emailMessage('guest@example.com')
    await expect(
      email.transport.send({
        message: withoutSubject,
        senderId: PROVISIONAL_SENDER_IDS.transactional,
        idempotencyKey: 'invoice.issued:nosubject',
      }),
    ).rejects.toThrow(/no subject/)
    // Refused before the provider was called: a message the vendor accepted and the database then
    // refused (message_email_carries_both_parts) is the one state nothing can reconcile.
    expect(email.calls.forProvider('resend')).toHaveLength(0)
  })

  it('maps a provider failure into our transport vocabulary', async () => {
    const email = createResendTransport({ config, now: () => NOW, from: FROM })
    email.failures.failAlways('rate_limited')
    const outcome = await email.transport.send({
      message: emailMessage('guest@example.com'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'invoice.issued:limited',
    })
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'provider_rate_limited' })
    email.failures.clear()
    // The control: unarmed, the same send is accepted, so the failure came from the script rather than
    // from a transport that cannot send at all.
    const recovered = await email.transport.send({
      message: emailMessage('guest@example.com'),
      senderId: PROVISIONAL_SENDER_IDS.transactional,
      idempotencyKey: 'invoice.issued:recovered',
    })
    expect(recovered.kind).toBe('accepted')
  })
})

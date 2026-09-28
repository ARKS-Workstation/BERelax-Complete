/**
 * C-AUTO-05 — a suspended promotional sender ID stops marketing and nothing else.
 *
 * This is the other half of the unit. The kill switch is a decision somebody takes; a suspension is one taken
 * about us, and the practical TDRA sanction for a promotional breach is suspension of the *identity* rather
 * than a fine (docs/04 §5). The reason two are registered is that the sanction then lands on one of them.
 *
 * ## Why this is driven through the real transport and the real fake
 *
 * The claim is about a composition rather than about a function: `createSmsalaTransport` holds ONE
 * `SmsProvider` per registered identity, each with its own `FailureScript`, and routes on the SENDER's class.
 * A test that armed a single shared script would prove nothing about that arrangement, and a test with a stub
 * transport would not exercise it at all. So `failures.promotional.failAlways('rejected')` is armed — which is
 * exactly what a suspension looks like from this side of the wire — and the assertion is that the
 * transactional success count is **unaffected**, sent from the identity it is supposed to be sent from.
 *
 * Gate case 126e collapses the two scripts into one, which is the defect this arrangement exists to prevent,
 * and asserts this file goes red.
 *
 * ## Why the counts are asserted rather than the last outcome
 *
 * "Transactional delivery stays green" is a statement about a run, not about a message. A single confirmation
 * sent after the suspension would also be reported by a transport that had started failing on the second
 * attempt, so every send is counted and the counts are compared: the transactional total is the same with the
 * suspension armed as without it, and the promotional total is zero.
 */
import { parseConfig } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import {
  promotionalSenderSuspensionSuspected,
  promotionalSendingBanner,
} from '../gate/kill-switch.ts'
import type { MessageId, OutboundMessage } from '../port.ts'
import type { TransportOutcome } from '../send.ts'
import { PROVISIONAL_SENDER_IDS, senderIdFor } from '../sender-identity.ts'
import { createSmsalaTransport } from './smsala.ts'

const NOW = '2026-09-18T10:00:00.000Z'

const config = parseConfig({
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://localhost/berelax_test',
})

/** Ten of each, so "unaffected" is a count rather than one message that happened to get through. */
const PER_CLASS = 10

function messageFor(messageClass: 'transactional' | 'promotional', index: number): OutboundMessage {
  return {
    id: `cauto05-${messageClass}-${index}` as MessageId,
    channel: 'sms',
    messageClass,
    // Distinct numbers, and none ending in the fake's `0000` undeliverable suffix — that suffix models
    // "accepted then failed an hour later", which is a different fact from a rejected send and would make
    // the receipt counts below ambiguous.
    recipient: `+9715282391${String(index + 10).padStart(2, '0')}`,
    body:
      messageClass === 'promotional'
        ? 'Two treatments for the price of one this week.'
        : 'Booking confirmed for 18 Sep at 20:00.',
    templateKey: messageClass === 'promotional' ? 'campaign.offer' : 'booking.confirmed',
    locale: 'en',
  }
}

interface Run {
  readonly accepted: Record<'transactional' | 'promotional', number>
  readonly rejected: Record<'transactional' | 'promotional', number>
  readonly senderIdsUsed: Record<'transactional' | 'promotional', Set<string>>
  readonly suspicions: number
}

/**
 * Sends ten of each class through one transport, counting what happened per class.
 *
 * The identity comes from `senderIdFor`, which is what the choke point uses: a test that passed the
 * promotional identity for a transactional message would be testing the fake's class check instead.
 */
async function run(suspendPromotional: boolean): Promise<Run> {
  const sms = createSmsalaTransport({ config, now: () => NOW })
  if (suspendPromotional) {
    // THE suspension, modelled. One script per registered identity is what makes this expressible at all.
    sms.failures.promotional.failAlways('rejected')
  }

  const accepted = { transactional: 0, promotional: 0 }
  const rejected = { transactional: 0, promotional: 0 }
  const senderIdsUsed = {
    transactional: new Set<string>(),
    promotional: new Set<string>(),
  }
  let suspicions = 0

  for (let index = 0; index < PER_CLASS; index += 1) {
    for (const messageClass of ['transactional', 'promotional'] as const) {
      const message = messageFor(messageClass, index)
      const senderId = senderIdFor(PROVISIONAL_SENDER_IDS, messageClass)
      const outcome: TransportOutcome = await sms.transport.send({
        message,
        senderId,
        idempotencyKey: `${message.templateKey}:${message.id}`,
      })
      if (outcome.kind === 'accepted') {
        accepted[messageClass] += 1
        senderIdsUsed[messageClass].add(senderId.value)
      } else {
        rejected[messageClass] += 1
        if (
          promotionalSenderSuspensionSuspected({
            messageClass,
            // The transport's `failed` outcome, in the shape `sendMessage` returns it — the classifier reads
            // `kind` and `reason`, which is exactly what the choke point carries out of a transport failure.
            result: { kind: 'failed', reason: outcome.reason },
          })
        ) {
          suspicions += 1
        }
      }
    }
  }

  return { accepted, rejected, senderIdsUsed, suspicions }
}

describe('a suspended promotional sender ID is not an operational outage', () => {
  it('halts every promotional send and leaves the transactional count untouched', async () => {
    const healthy = await run(false)
    const suspended = await run(true)

    // The control first, so "transactional unaffected" is a comparison and not an assertion about one number.
    expect(healthy.accepted).toEqual({ transactional: PER_CLASS, promotional: PER_CLASS })
    expect(healthy.rejected).toEqual({ transactional: 0, promotional: 0 })

    // The containment. Marketing is stopped; the operational half is byte-for-byte the same count.
    expect(suspended.accepted.promotional).toBe(0)
    expect(suspended.rejected.promotional).toBe(PER_CLASS)
    expect(suspended.accepted.transactional).toBe(healthy.accepted.transactional)
    expect(suspended.rejected.transactional).toBe(0)

    // On the identity they are supposed to leave on. A transactional send that started leaving under
    // `AD-BERELAX` would satisfy every count above and would be the send that gets the OTHER identity
    // suspended too.
    expect([...suspended.senderIdsUsed.transactional]).toEqual(['BERELAX'])
    expect([...healthy.senderIdsUsed.promotional]).toEqual(['AD-BERELAX'])
    expect(suspended.senderIdsUsed.promotional.size).toBe(0)
  })

  it('recognises the suspension rather than failing silently, and sets the banner state', async () => {
    const suspended = await run(true)

    // Every rejected promotional send is recognised for what it is. Without this the suspension is a rising
    // count of failures in a table nobody watches, and the first evidence is somebody asking why the
    // campaign did nothing.
    expect(suspended.suspicions).toBe(PER_CLASS)

    // The staff-visible state, from the one function every admin surface reads it through.
    const banner = promotionalSendingBanner({ killSwitchEngaged: false, senderSuspended: true })
    expect(banner.state).toBe('sender_suspended')
    expect(banner.headline).toBe('Promotional sending suspended')
    expect(banner.detail).toContain('Booking confirmations')
    // And the control: with nothing suspended the banner does not cry wolf. A banner that is always up is a
    // banner nobody reads.
    expect(
      promotionalSendingBanner({ killSwitchEngaged: false, senderSuspended: false }).state,
    ).toBe('sending')
  })

  it('leaves the transactional identity delivering receipts while the promotional one rejects', async () => {
    // The drain reads both identities' queues, and a suspension must not empty the transactional one. This is
    // the assertion that would catch a "fix" that shared one provider instance between the two classes: the
    // rejected promotional sends produce no receipt, and the ten transactional ones must still produce theirs.
    const sms = createSmsalaTransport({ config, now: () => NOW })
    sms.failures.promotional.failAlways('rejected')

    for (let index = 0; index < PER_CLASS; index += 1) {
      for (const messageClass of ['transactional', 'promotional'] as const) {
        const message = messageFor(messageClass, index)
        await sms.transport.send({
          message,
          senderId: senderIdFor(PROVISIONAL_SENDER_IDS, messageClass),
          idempotencyKey: `${message.templateKey}:${message.id}`,
        })
      }
    }

    const receipts = await sms.receipts.drain()
    expect(receipts).toHaveLength(PER_CLASS)
    for (const receipt of receipts) {
      expect(receipt.vendorStatus).toBe('delivered')
      expect(receipt.mapped).toBe('delivered')
    }
  })
})

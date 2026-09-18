/**
 * The SMSala fake.
 *
 * It models the four things about SMSala that change how the system must be written, and ignores
 * everything else:
 *
 * **Sender-ID class enforcement.** A promotional body sent from the transactional identity is
 * rejected here, as TDRA compliance requires. Getting this wrong in production risks suspension of
 * the identity, which stops every booking confirmation — see ADR 0016. Catching it in the fake means
 * the send path is exercised against the rule from the first day.
 *
 * **Segment counting and cost.** Computed with `segmentSms`, so an Arabic campaign shows its real
 * price rather than an English estimate: 70 characters per segment against 160.
 *
 * **Asynchronous delivery.** `send` returns *accepted*. A receipt arrives afterwards, drained
 * separately, and the fake produces one per message so the DLR handling path has something to run
 * against. A number ending in the suffix below fails delivery instead, because "accepted then
 * failed" is the case that is easy to forget.
 *
 * **Idempotency.** The same key returns the same message id and does not bill twice.
 */
import { createHash } from 'node:crypto'
import { segmentSms } from '@berelax/core'
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import type { DeliveryReceipt, SmsAccepted, SmsProvider, SmsRequest } from './port.ts'

export const SMSALA = 'smsala'

/** Fils per segment. Provisional — the real rate is on the SMSala contract (docs/05). */
export const PROVISIONAL_COST_PER_SEGMENT_FILS = 9

/**
 * A recipient ending in this fails delivery after being accepted.
 *
 * Deliberately a suffix on the number rather than a flag: it makes the "accepted, then failed an
 * hour later" path reachable from a seeded fixture and from a screenshot, not only from a test.
 */
export const UNDELIVERABLE_SUFFIX = '0000'

export interface FakeSmsalaOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
}

export function createFakeSmsala(options: FakeSmsalaOptions): SmsProvider {
  const { log, failures, now } = options
  const byIdempotencyKey = new Map<string, SmsAccepted>()
  let pendingReceipts: DeliveryReceipt[] = []

  return {
    name: SMSALA,

    async send(request: SmsRequest): Promise<SmsAccepted> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: SMSALA,
          operation: 'send',
          outcome: 'failure',
          summary: `Send to ${mask(request.recipient)} failed: ${armed}`,
          detail: { failureMode: armed, templateClass: request.messageClass },
        })
        throw failureError(SMSALA, armed)
      }

      const replayed = byIdempotencyKey.get(request.idempotencyKey)
      if (replayed !== undefined) {
        log.record({
          provider: SMSALA,
          operation: 'send',
          outcome: 'success',
          summary: `Duplicate suppressed for ${mask(request.recipient)}; no second message, no second charge`,
          detail: {
            idempotencyKey: request.idempotencyKey,
            providerMessageId: replayed.providerMessageId,
          },
        })
        return replayed
      }

      if (request.senderId.messageClass !== request.messageClass) {
        log.record({
          provider: SMSALA,
          operation: 'send',
          outcome: 'failure',
          summary:
            `Rejected: ${request.messageClass} content from the ` +
            `${request.senderId.messageClass} sender ID '${request.senderId.value}'`,
          detail: {
            senderId: request.senderId.value,
            senderClass: request.senderId.messageClass,
            messageClass: request.messageClass,
          },
        })
        throw failureError(SMSALA, 'rejected')
      }

      const segmentation = segmentSms(request.body)
      const accepted: SmsAccepted = {
        providerMessageId: providerMessageIdFor(SMSALA, request.idempotencyKey),
        segments: segmentation.segments,
        encoding: segmentation.encoding,
        estimatedCostFils: segmentation.segments * PROVISIONAL_COST_PER_SEGMENT_FILS,
      }
      byIdempotencyKey.set(request.idempotencyKey, accepted)

      const undeliverable = request.recipient.endsWith(UNDELIVERABLE_SUFFIX)
      pendingReceipts.push({
        providerMessageId: accepted.providerMessageId,
        status: undeliverable ? 'failed' : 'delivered',
        occurredAtIso: now(),
        ...(undeliverable ? { reason: 'Absent subscriber' } : {}),
      })

      log.record({
        provider: SMSALA,
        operation: 'send',
        outcome: 'success',
        summary:
          `Accepted for ${mask(request.recipient)} from '${request.senderId.value}' — ` +
          `${segmentation.segments} ${segmentation.encoding} segment(s), ` +
          `${accepted.estimatedCostFils} fils`,
        detail: {
          providerMessageId: accepted.providerMessageId,
          segments: segmentation.segments,
          encoding: segmentation.encoding,
          estimatedCostFils: accepted.estimatedCostFils,
          forcedUnicodeBy: segmentation.forcedBy,
          senderId: request.senderId.value,
        },
      })
      return accepted
    },

    async drainDeliveryReceipts(): Promise<readonly DeliveryReceipt[]> {
      const drained = pendingReceipts
      pendingReceipts = []
      if (drained.length > 0) {
        log.record({
          provider: SMSALA,
          operation: 'drainDeliveryReceipts',
          outcome: 'success',
          summary: `${drained.length} delivery receipt(s) drained`,
          detail: { statuses: drained.map((receipt) => receipt.status) },
        })
      }
      return drained
    },
  }
}

/**
 * A provider message id, derived from the idempotency key rather than counted.
 *
 * It was a per-instance counter, and B-MSG-04 made that a defect rather than a simplification: message
 * ids are now **persisted** with a `(vendor, provider_message_id)` uniqueness constraint, and a delivery
 * receipt finds its message row by that id. A counter repeats — across processes, so a second run of a
 * suite reissues `smsala-000001`, and across instances, and the SMSala transport deliberately holds two
 * (one per registered identity, so a promotional suspension does not stop booking confirmations). Two
 * messages sharing an id means a receipt lands on an arbitrary one of them.
 *
 * A digest of the idempotency key is stable for the same message in any process, distinct for different
 * messages, and deterministic — which the counter also was, and which a random id would not be: the
 * screenshot harness needs byte-identical output across runs. It also models the vendor more closely,
 * since the real id is stable for an accepted message and is what a support query quotes.
 */
function providerMessageIdFor(prefix: string, idempotencyKey: string): string {
  return `${prefix}-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12)}`
}

/** Last four digits only. The log is shown on screen and in screenshots. */
function mask(recipient: string): string {
  return recipient.length <= 4 ? recipient : `…${recipient.slice(-4)}`
}

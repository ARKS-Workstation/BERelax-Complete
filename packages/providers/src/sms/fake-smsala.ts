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
  let counter = 0

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
      counter += 1
      const accepted: SmsAccepted = {
        providerMessageId: `smsala-${String(counter).padStart(6, '0')}`,
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

/** Last four digits only. The log is shown on screen and in screenshots. */
function mask(recipient: string): string {
  return recipient.length <= 4 ? recipient : `…${recipient.slice(-4)}`
}

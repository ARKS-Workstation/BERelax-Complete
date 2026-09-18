/**
 * The Resend fake.
 *
 * Models the parts that change the code around it:
 *
 * **Bounce and complaint are terminal.** A hard bounce or a spam complaint adds the address to a
 * suppression list, and every later send to it is rejected — by the provider, not by us. Systems that
 * treat suppression as advisory end up with a sending reputation problem that takes weeks to undo, so
 * the fake enforces it.
 *
 * **Attachments are counted and sized**, because the real limit is on total message size and an
 * invoice PDF with embedded fonts is ~65KB. A month of them on one email is not a hypothetical.
 *
 * **Events arrive later.** `send` returns an id; delivered, bounced or complained is drained
 * afterwards, so the webhook-handling path has something to run against with no webhook.
 */
import { createHash } from 'node:crypto'
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import type { EmailAccepted, EmailEvent, EmailProvider, EmailRequest } from './port.ts'

export const RESEND = 'resend'

/** Resend's documented ceiling on total message size, attachments included. */
export const MAX_MESSAGE_BYTES = 40 * 1024 * 1024

/**
 * Local-part markers that drive a terminal event, so a fixture can exercise them.
 *
 * Chosen to match the addresses Resend itself documents for testing, so the same fixtures work
 * against the real provider.
 */
export const BOUNCE_MARKER = 'bounced'
export const COMPLAINT_MARKER = 'complained'

export interface FakeResendOptions {
  readonly log: CallLog
  readonly failures: FailureScript
  readonly now: () => string
}

export function createFakeResend(options: FakeResendOptions): EmailProvider {
  const { log, failures, now } = options
  const suppressed = new Set<string>()
  const byIdempotencyKey = new Map<string, EmailAccepted>()
  let pendingEvents: EmailEvent[] = []

  const normalise = (address: string): string => address.trim().toLowerCase()

  return {
    name: RESEND,

    async send(request: EmailRequest): Promise<EmailAccepted> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: RESEND,
          operation: 'send',
          outcome: 'failure',
          summary: `Send to ${mask(request.to.address)} failed: ${armed}`,
          detail: { failureMode: armed, subject: request.subject },
        })
        throw failureError(RESEND, armed)
      }

      const replayed = byIdempotencyKey.get(request.idempotencyKey)
      if (replayed !== undefined) {
        log.record({
          provider: RESEND,
          operation: 'send',
          outcome: 'success',
          summary: `Duplicate suppressed for ${mask(request.to.address)}; no second email`,
          detail: { idempotencyKey: request.idempotencyKey },
        })
        return replayed
      }

      const address = normalise(request.to.address)

      if (suppressed.has(address)) {
        log.record({
          provider: RESEND,
          operation: 'send',
          outcome: 'failure',
          summary: `Rejected: ${mask(address)} is on the provider suppression list`,
          detail: { reason: 'suppressed' },
        })
        throw failureError(RESEND, 'rejected')
      }

      const attachmentBytes = (request.attachments ?? []).reduce(
        (total, attachment) => total + attachment.bytes.byteLength,
        0,
      )
      const totalBytes = attachmentBytes + request.html.length + request.text.length
      if (totalBytes > MAX_MESSAGE_BYTES) {
        log.record({
          provider: RESEND,
          operation: 'send',
          outcome: 'failure',
          summary: `Rejected: message is ${Math.round(totalBytes / 1024)}KB, over the provider limit`,
          detail: { totalBytes, limit: MAX_MESSAGE_BYTES },
        })
        throw failureError(RESEND, 'rejected')
      }

      const accepted: EmailAccepted = {
        providerMessageId: providerMessageIdFor(RESEND, request.idempotencyKey),
      }
      byIdempotencyKey.set(request.idempotencyKey, accepted)

      const local = address.split('@')[0] ?? ''
      const terminal: EmailEvent['type'] = local.includes(BOUNCE_MARKER)
        ? 'bounced'
        : local.includes(COMPLAINT_MARKER)
          ? 'complained'
          : 'delivered'
      if (terminal !== 'delivered') suppressed.add(address)

      pendingEvents.push({
        providerMessageId: accepted.providerMessageId,
        type: terminal,
        occurredAtIso: now(),
        ...(terminal === 'bounced' ? { reason: 'Mailbox does not exist' } : {}),
      })

      log.record({
        provider: RESEND,
        operation: 'send',
        outcome: 'success',
        summary:
          `Accepted for ${mask(address)} — "${request.subject}"` +
          ((request.attachments?.length ?? 0) > 0
            ? `, ${request.attachments?.length} attachment(s), ${Math.round(attachmentBytes / 1024)}KB`
            : ''),
        detail: {
          providerMessageId: accepted.providerMessageId,
          messageClass: request.messageClass,
          attachments: request.attachments?.map((a) => a.filename) ?? [],
          willEmit: terminal,
        },
      })
      return accepted
    },

    async drainEvents(): Promise<readonly EmailEvent[]> {
      const drained = pendingEvents
      pendingEvents = []
      if (drained.length > 0) {
        log.record({
          provider: RESEND,
          operation: 'drainEvents',
          outcome: 'success',
          summary: `${drained.length} event(s) drained`,
          detail: { types: drained.map((event) => event.type) },
        })
      }
      return drained
    },

    async isSuppressed(address: string): Promise<boolean> {
      return suppressed.has(normalise(address))
    },
  }
}

/**
 * A provider message id, derived from the idempotency key rather than counted.
 *
 * It was a per-instance counter, and B-MSG-04 made that a defect rather than a simplification: message
 * ids are now **persisted** with a `(vendor, provider_message_id)` uniqueness constraint, and a delivery
 * receipt finds its message row by that id. A counter repeats — across processes, so a second run of a
 * suite reissues `resend-000001`, and across instances, and the SMSala transport deliberately holds two
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

/** First character and domain only. The log appears on screen and in screenshots. */
function mask(address: string): string {
  const [local = '', domain = ''] = address.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

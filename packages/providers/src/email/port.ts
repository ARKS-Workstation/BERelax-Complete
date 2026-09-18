/**
 * The email provider port — the interface Resend's real adapter will implement.
 *
 * Resend-shaped in three ways that matter. **A message carries both an HTML and a text part**,
 * because a transactional email with no text part is a deliverability problem, not a nicety. **The
 * result is an id, not a delivery**: bounces and complaints arrive later by webhook. And
 * **suppression is the provider's, not ours** — a recipient who complained must not be emailed again
 * even if our own consent record says yes, so the port exposes it rather than pretending it does not
 * exist.
 */
import type { MessageClass } from '@berelax/messaging'

export interface EmailAddress {
  readonly address: string
  readonly name?: string
}

export interface EmailRequest {
  readonly to: EmailAddress
  readonly from: EmailAddress
  readonly subject: string
  readonly html: string
  /** Required, not optional. An HTML-only transactional email is a spam signal. */
  readonly text: string
  readonly messageClass: MessageClass
  readonly idempotencyKey: string
  /** Attachments as bytes; invoices arrive here from `@berelax/pdf`. */
  readonly attachments?: readonly EmailAttachment[]
}

export interface EmailAttachment {
  readonly filename: string
  readonly contentType: string
  readonly bytes: Uint8Array
}

export interface EmailAccepted {
  readonly providerMessageId: string
}

export type EmailEventType = 'delivered' | 'bounced' | 'complained' | 'opened'

export interface EmailEvent {
  readonly providerMessageId: string
  readonly type: EmailEventType
  readonly occurredAtIso: string
  readonly reason?: string
}

export interface EmailProvider {
  readonly name: string
  send(request: EmailRequest): Promise<EmailAccepted>
  drainEvents(): Promise<readonly EmailEvent[]>
  /** True when the provider will refuse this address regardless of our own consent record. */
  isSuppressed(address: string): Promise<boolean>
}

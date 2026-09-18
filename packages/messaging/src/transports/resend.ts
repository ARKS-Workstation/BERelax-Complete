/**
 * The Resend transport: the one module in the repository that may touch an email provider.
 *
 * The same boundary as `smsala.ts` next door, for the same reason — `.dependency-cruiser.cjs`'s
 * `messaging-providers-only-inside-a-transport`, with a known-bad fixture in `scripts/test-gates.mjs` —
 * and the same shape: a `ClassRoutedTransport` the choke point hands a message to, plus a drain the DLR
 * pass reads receipts from.
 *
 * ## Why email carries both parts
 *
 * `EmailRequest` requires `html` **and** `text`, because an HTML-only transactional email is a
 * deliverability problem (`packages/providers/src/email/port.ts`). Both come from one template body:
 * `renderEmailHtml` derives the HTML part, and the row stores exactly those bytes so the admin inbox's
 * preview pane shows what was sent rather than a re-render of it.
 *
 * ## Why `from` is a required argument with no default
 *
 * docs/05 §2 asks for **separate verified sending subdomains** for transactional and marketing, so that
 * a campaign complaint cannot kill booking confirmations. Neither address exists yet, and a
 * plausible-looking one is worse than a blank: blank is visibly unanswered, and `noreply@…` is
 * indistinguishable from configured. So the caller supplies it, `OPEN-QUESTIONS Y6-email-sender` records
 * the question, and the fixture supplies a marked placeholder on a `.invalid` domain.
 *
 * ## Why there is one failure script here and two next door
 *
 * TDRA registers two SMS *identities* and a suspension applies to one of them. Resend's equivalent — a
 * reputation problem on a sending subdomain — is a real hazard and it is not modelled by the fake: it
 * has one suppression list and one identity. One script, therefore, and the day the second sending
 * subdomain is configured is the day this grows the second one.
 */
import type { Config } from '@berelax/config'
import {
  type CallLog,
  createCallLog,
  createProviders,
  type EmailEventType,
  type EmailProvider,
  FailureScript,
  failureModeOf,
} from '@berelax/providers'
import { AppError, type MessageStatus } from '@berelax/shared'
import { renderEmailHtml } from '../email-html.ts'
import type { DeliveryReceiptRecord, ReceiptSource } from '../lifecycle.ts'
import type { ClassRoutedTransport, TransportOutcome, TransportRequest } from '../send.ts'
import { transportFailureFor } from './smsala.ts'

/**
 * Resend's event vocabulary, mapped onto ours. Exhaustive by construction.
 *
 * `satisfies Record<EmailEventType, …>` so a fifth Resend event fails to compile rather than falling
 * into a `default`.
 *
 * **`complained` is deliberately not a failure.** A spam complaint happens *after* a successful
 * delivery: the message arrived, and the reader pressed a button. Recording it as `failed` would tell an
 * operator looking at a booking confirmation that it never landed, which is the opposite of what
 * happened — and the consequence that matters, suppression, is the provider's and is already enforced by
 * it (`isSuppressed` on the port). So it is recorded with its own word and changes no status.
 * `opened` is the same shape for a happier reason.
 */
export const RESEND_EVENT_MAP = {
  delivered: 'delivered',
  bounced: 'failed',
  complained: 'no_lifecycle_change',
  opened: 'no_lifecycle_change',
} as const satisfies Record<EmailEventType, MessageStatus | 'no_lifecycle_change'>

/**
 * One Resend event word, mapped.
 *
 * `null` for anything else. An unrecognised event must not become `delivered`: it is recorded with the
 * vendor's word and `ignored_reason = 'vendor_status_unrecognised'`, which surfaces a vocabulary change
 * as a queue of unapplied receipts rather than as a wall of messages reported as delivered.
 */
export function mapResendEvent(vendorStatus: string): MessageStatus | 'no_lifecycle_change' | null {
  return Object.hasOwn(RESEND_EVENT_MAP, vendorStatus)
    ? RESEND_EVENT_MAP[vendorStatus as EmailEventType]
    : null
}

export interface ResendTransport {
  readonly transport: ClassRoutedTransport
  /** Every provider call, in order. Shared with nothing: the inbox reads the message rows. */
  readonly calls: CallLog
  readonly failures: FailureScript
  readonly receipts: ReceiptSource
  /** The provider, for the one assertion a test makes that the send path cannot: suppression. */
  readonly provider: EmailProvider
}

export interface ResendTransportOptions {
  readonly config: Config
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
  /** The verified sending address. No default — see this module's header and Y6-email-sender. */
  readonly from: { readonly address: string; readonly name?: string }
}

export function createResendTransport(options: ResendTransportOptions): ResendTransport {
  const { config, now, from } = options
  const calls = createCallLog(now)
  const failures = new FailureScript()
  const provider = createProviders({ config, now, log: calls, failures }).email

  const transport: ClassRoutedTransport = {
    channel: 'email',
    async send(request: TransportRequest): Promise<TransportOutcome> {
      const { message } = request
      if (message.subject === undefined) {
        // Refused here rather than sent with an empty subject: `message_email_carries_both_parts`
        // (migration 0035) would refuse the row afterwards, and a message the provider accepted and the
        // database rejected is the one state nothing in this system can reconcile.
        throw new AppError(
          'invariant_violated',
          `Email template '${message.templateKey}' produced no subject. An email with no subject line ` +
            'is a message nobody can find again, and the row would be refused by CHECK.',
          { details: { templateKey: message.templateKey } },
        )
      }
      try {
        const accepted = await provider.send({
          to: { address: message.recipient },
          from,
          subject: message.subject,
          html: renderEmailHtml(message),
          // The template's own body is the text part. Required, not optional.
          text: message.body,
          messageClass: message.messageClass,
          idempotencyKey: request.idempotencyKey,
        })
        return {
          kind: 'accepted',
          providerMessageId: accepted.providerMessageId,
          // Email is not segment-billed. Zero rather than one, and `message_segments_billed_on_sms_only`
          // is the constraint that stops the SMS arithmetic — 70 characters to an Arabic segment — from
          // being applied to a channel that is billed per message.
          segments: 0,
          costFils: 0,
        }
      } catch (error) {
        return {
          kind: 'failed',
          reason: transportFailureFor(failureModeOf(error)),
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }

  const receipts: ReceiptSource = {
    vendor: 'resend',
    async drain(): Promise<readonly DeliveryReceiptRecord[]> {
      const drained = await provider.drainEvents()
      return drained.map((event) => ({
        vendor: 'resend' as const,
        providerMessageId: event.providerMessageId,
        vendorStatus: event.type,
        mapped: mapResendEvent(event.type),
        occurredAtIso: event.occurredAtIso,
        reason: event.reason ?? null,
      }))
    },
  }

  return { transport, calls, failures, receipts, provider }
}

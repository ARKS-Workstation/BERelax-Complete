/**
 * The durable half of a send: the row, its attempts, and the receipts that move it.
 *
 * B-MSG-02 built the choke point and persisted nothing — every outcome was a returned `SendResult` plus
 * a provider call log, which proves a decision was made and cannot answer "did that reminder arrive?".
 * This module is the answer, and it is deliberately thin: it decides *what* is recorded and leaves the
 * SQL to `@berelax/db`.
 *
 * ## Why the store is a port here and an implementation there
 *
 * `MessageLifecycleStore` is declared in this package because the lifecycle is this package's domain,
 * and it is implemented in `packages/db/src/repositories/message.ts` — which does **not** import this
 * file. It cannot: `packages/db` may import `@berelax/shared` only, and a `db -> messaging` edge would
 * put a provider-facing package underneath the persistence layer. Structural typing is what lets one
 * port be declared once and satisfied once with no edge in either direction, and the fit is checked by
 * the compiler at the place both meet — `reconcileDeliveryReceipts` in the worker, and
 * `packages/fixtures/src/message-lifecycle.itest.ts`, which passes the Postgres store into these
 * functions.
 *
 * The port is narrow for the reason G-CONN-05 gave for keeping three narrow Google seams: the reads the
 * admin inbox needs — the listing, the cost aggregates, the frequency-cap count — are queries the
 * surface asks the database directly, and folding them in here would make this the interface everything
 * messaging-shaped accumulates against.
 *
 * ## Why a row is written after the transport answered, not before
 *
 * The row records a message a vendor was asked to send. Writing it first would mean a gate refusal and a
 * staging diversion both leave a row behind that says `queued` for ever — and both of those are already
 * recorded where they belong: a refusal in the `SendResult` the caller gets (its stores are C-CRM-03,
 * C-CRM-04 and C-AUTO-03), a diversion in the local outbox F03 puts it in. A durable row for a message
 * that was deliberately never sent would also appear in the cost report and count against the frequency
 * cap, and both of those describe messages that left.
 */
import { decideRetry, instantToIso } from '@berelax/core'
import type {
  Channel,
  MessageClass,
  MessageFailureReason,
  MessageRowFailureReason,
  MessageStatus,
  ReceiptIgnoredReason,
} from '@berelax/shared'
import { AppError } from '@berelax/shared'
import { renderEmailHtml } from './email-html.ts'
import { costOf } from './encoding.ts'
import {
  outboundMessageFor,
  type SendContext,
  type SendRequest,
  type SendResult,
  sendMessage,
} from './send.ts'
import { resolveSenderIdentity } from './sender-identity.ts'

/**
 * The vendors, as a closed set.
 *
 * RESEND for email and SMSALA for SMS are fixed (docs/05 §1 and §2), and the value is on the row
 * because a receipt's status vocabulary cannot be read without knowing whose it is. WhatsApp is
 * deliberately absent: the channel exists in the schema from day one (ADR 0016) and the vendor does
 * not, so `vendorFor` refuses it rather than defaulting to one of these two.
 */
export const MESSAGE_VENDORS = ['smsala', 'resend'] as const
export type MessageVendor = (typeof MESSAGE_VENDORS)[number]

const VENDOR_BY_CHANNEL: Readonly<Partial<Record<Channel, MessageVendor>>> = {
  sms: 'smsala',
  email: 'resend',
}

/** The vendor a channel's messages go to. Throws for a channel with no contracted vendor. */
export function vendorFor(channel: Channel): MessageVendor {
  const vendor = VENDOR_BY_CHANNEL[channel]
  if (vendor === undefined) {
    throw new AppError(
      'invariant_violated',
      `No vendor is contracted for channel '${channel}'. The row's vendor decides how a delivery ` +
        'receipt is read, so guessing one would make every receipt on that row uninterpretable.',
      { details: { channel } },
    )
  }
  return vendor
}

// --- what the store is asked to write ----------------------------------------------------------

/** The message as it was handed to a vendor. Every field is what was sent, not what is current. */
export interface RecordedMessage {
  readonly templateId: string
  readonly channel: Channel
  readonly messageClass: MessageClass
  readonly locale: 'en' | 'ar'
  readonly vendor: MessageVendor
  readonly recipient: string
  readonly senderId: string | null
  readonly subject: string | null
  readonly body: string
  /** The HTML part, exactly as the provider was given it. Email only. */
  readonly bodyHtml: string | null
  readonly encoding: 'GSM-7' | 'UCS-2'
  readonly segments: number
  readonly costFils: number
}

/** What one attempt produced. */
export type AttemptOutcome =
  | {
      readonly kind: 'accepted'
      readonly providerMessageId: string
      /** From the vendor, not from the estimate: the two are reconciled rather than assumed equal. */
      readonly segments: number
      readonly costFils: number
      readonly atIso: string
    }
  | {
      readonly kind: 'failed'
      readonly reason: MessageFailureReason
      readonly detail: string
      readonly atIso: string
      /** When the next attempt may run, or null when the policy is exhausted and the row fails. */
      readonly nextAttemptAtIso: string | null
    }
  /** Held for the promotional window. Not an attempt: nothing was sent, and nothing failed. */
  | { readonly kind: 'held'; readonly releaseAtIso: string; readonly atIso: string }

/** One message row, as much of it as a caller of this module needs. */
export interface MessageRecord {
  readonly id: string
  readonly status: MessageStatus
  readonly providerMessageId: string | null
  readonly attempts: number
  readonly segments: number
  readonly costFils: number
  readonly nextAttemptAtIso: string | null
  /**
   * The superset, not the transport's four.
   *
   * A row can also carry `delivery_reported_failed`, which no transport ever returns: it left, a vendor
   * accepted it, and the network said afterwards that it did not arrive. See
   * `MESSAGE_ROW_FAILURE_REASONS`.
   */
  readonly lastFailureReason: MessageRowFailureReason | null
}

/** A receipt, already mapped out of the vendor's vocabulary by that vendor's transport. */
export interface DeliveryReceiptRecord {
  readonly vendor: MessageVendor
  readonly providerMessageId: string
  /** The vendor's own word, verbatim, kept whether or not it is recognised. */
  readonly vendorStatus: string
  /**
   * What our lifecycle makes of it.
   *
   * `null` means the vendor sent a word this system does not map — it must change nothing, and above
   * all must not become `delivered`. `'no_lifecycle_change'` means recognised and not about delivery:
   * Resend's `opened`, and its `complained`, which happens *after* a successful delivery.
   */
  readonly mapped: MessageStatus | 'no_lifecycle_change' | null
  readonly occurredAtIso: string
  readonly reason: string | null
}

/**
 * Where receipts come from, whatever shape the vendor delivers them in.
 *
 * SMSala reports by webhook and Resend by webhook; the fakes hold a queue a drain empties, which is the
 * read side of both — a worker drains the same way whether a receipt arrived over HTTP and was stored,
 * or is sitting in a fake's queue. That is the whole reason the port is a drain rather than a handler:
 * the code that decides what a receipt *means* must not also be the code that parses one vendor's HTTP
 * body, or there is no way to test the meaning without inventing a request.
 */
export interface ReceiptSource {
  readonly vendor: MessageVendor
  drain(): Promise<readonly DeliveryReceiptRecord[]>
}

/** What applying one receipt did. */
export type ReceiptApplication =
  | { readonly kind: 'applied'; readonly messageId: string; readonly status: MessageStatus }
  | {
      readonly kind: 'ignored'
      readonly messageId: string
      readonly status: MessageStatus
      readonly reason: ReceiptIgnoredReason
    }
  /** The same webhook body again. One row, one transition, whatever the vendor's retry count. */
  | { readonly kind: 'replayed'; readonly messageId: string; readonly status: MessageStatus }
  /** A receipt for an id this system never issued. Recorded nowhere, reported here. */
  | { readonly kind: 'unknown_message'; readonly providerMessageId: string }

export interface MessageLifecycleStore {
  /** Creates the row for a message a vendor has just answered for, first attempt included. */
  recordSend(
    message: RecordedMessage,
    outcome: AttemptOutcome,
    queuedAtIso: string,
  ): Promise<MessageRecord>
  /** Records attempt 2, 3, … against an existing row. */
  recordAttempt(messageId: string, outcome: AttemptOutcome): Promise<MessageRecord>
  /** Applies one receipt, idempotently, and never lowers the stored status. */
  applyReceipt(receipt: DeliveryReceiptRecord): Promise<ReceiptApplication>
}

// --- sending, with the row and the retries -----------------------------------------------------

export interface DeliveryDeps {
  readonly store: MessageLifecycleStore
  readonly send: SendContext
  /**
   * Waits until an instant. Injected, and the reason is the whole retry test.
   *
   * In a worker this is a re-enqueue with `startAfter`, so the process is not holding a connection
   * open for five minutes. In a test it advances the frozen clock, so the declared backoff is asserted
   * rather than slept through — a suite that really waited 60 seconds would be a suite nobody runs.
   */
  readonly waitUntil: (iso: string) => Promise<void>
}

/**
 * A send request plus the template row it came from.
 *
 * `SendRequest` carries the template as a *definition* — key, channel, locale, body, declared
 * variables and immutable class — because the choke point's decisions are made from those and from
 * nothing else. The row needs the database id as well, so the message keeps pointing at the version it
 * left with after `reclassify_template` (0015) supersedes it. Extended here rather than added to
 * `SendRequest`, so nothing about the send decision changes and no call site of `sendMessage` has to
 * know a row exists.
 */
export interface RecordedSendRequest extends SendRequest {
  readonly templateId: string
}

export type DeliveryOutcome =
  | {
      readonly kind: 'sent'
      readonly message: MessageRecord
      readonly waitedForIso: readonly string[]
    }
  | {
      readonly kind: 'failed'
      readonly message: MessageRecord
      readonly waitedForIso: readonly string[]
    }
  /** Queued for the promotional window. A row exists, with the instant it may leave at. */
  | { readonly kind: 'held'; readonly message: MessageRecord }
  /** The gate refused, or the staging guard diverted it. No row: see this module's header. */
  | { readonly kind: 'not_sent'; readonly result: SendResult }

/**
 * Sends one message, records it, and retries it according to the declared policy.
 *
 * The attempt count is the assertion this exists to make checkable: `provider_rejected` is attempted
 * once because a rejection does not become acceptable on a retry, `provider_rate_limited` three times
 * with the declared waits, and both end `failed` rather than in a state nobody named. See
 * `MESSAGE_RETRY_POLICY` in `@berelax/core` for why each cap is what it is.
 */
export async function deliverMessage(
  deps: DeliveryDeps,
  request: RecordedSendRequest,
): Promise<DeliveryOutcome> {
  const message = outboundMessageFor(request)
  const vendor = vendorFor(message.channel)
  const cost = costOf(message.channel, message.body)
  // Resolved BEFORE the first attempt, and written onto every attempt's row including a failed one.
  //
  // It used to be `null` here and filled in only on the `sent` branch, and that left a real hole:
  // `recordAttempt` updates by id and is never handed the message, so a message that was rate-limited on
  // attempt 1 and accepted on attempt 2 was stored as `sent` with NO record of the registered identity it
  // left from — which is exactly the evidence a sender-ID suspension investigation asks for, and the
  // column an audit reads back. `message_sender_id_is_sms_only` (migration 0061) is the biconditional
  // that makes leaving it null unstorable for an SMS row.
  //
  // The same total table `sendMessage` reads, called a second time rather than threaded through the
  // result: it is a pure lookup over (class, channel), so two calls cannot disagree, and a refusal here
  // needs no handling because `sendMessage` will refuse the send for the same reason a moment later.
  const identity = resolveSenderIdentity(deps.send.senderIds, message)
  const recorded: RecordedMessage = {
    templateId: request.templateId,
    channel: message.channel,
    messageClass: message.messageClass,
    locale: message.locale,
    vendor,
    recipient: message.recipient,
    senderId: identity.kind === 'identity' ? identity.identity.value : null,
    subject: message.subject ?? null,
    body: message.body,
    bodyHtml: message.channel === 'email' ? renderEmailHtml(message) : null,
    encoding: cost.encoding,
    segments: cost.segments,
    costFils: cost.costFils,
  }

  const queuedAtIso = instantToIso(deps.send.clock.now())
  const waited: string[] = []
  let row: MessageRecord | undefined

  // A `for` over the cap of the *largest* policy rather than a `while (true)`: a retry loop whose exit
  // condition is a policy lookup is a loop that spins for ever the day a policy is edited wrongly.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_ANY_POLICY; attempt += 1) {
    const result = await sendMessage(deps.send, request)
    const atIso = instantToIso(deps.send.clock.now())

    if (result.kind === 'blocked' || result.kind === 'diverted' || result.kind === 'expired') {
      // Only reachable on the first attempt: none of the three depends on the transport, so a retry
      // would produce the same answer and a row for it would claim a send that never happened.
      //
      // `expired` is here rather than beside `queued` although both come from the window, and the
      // difference is what each one has to leave behind. A hold is a message that will be sent, so it gets
      // a row with its release instant. An expiry is a message that never will be, so a row saying
      // `queued` would be a reminder that waits for ever and a row saying `sent` would be a lie — the
      // outcome is returned, typed, and the caller reports it (`Y9-queued-staleness` asks the owner for a
      // report rather than a late send). Moving an EXISTING held row to expired is the release job's, which
      // is C-AUTO-07's; nothing in this build releases a hold yet, so nothing here can reach that case.
      if (row === undefined) return { kind: 'not_sent', result }
      throw new AppError(
        'invariant_violated',
        `A retry of message ${row.id} was ${result.kind}, which cannot follow an accepted attempt: ` +
          'the gate and the staging guard do not depend on the transport.',
        { details: { messageId: row.id, result } },
      )
    }

    if (result.kind === 'queued') {
      const outcome: AttemptOutcome = {
        kind: 'held',
        releaseAtIso: result.releaseAtIso,
        atIso,
      }
      row = await record(deps, recorded, outcome, queuedAtIso, row)
      return { kind: 'held', message: row }
    }

    if (result.kind === 'sent') {
      const outcome: AttemptOutcome = {
        kind: 'accepted',
        providerMessageId: result.providerMessageId,
        segments: result.segments,
        costFils: result.costFils,
        atIso,
      }
      row = await record(
        deps,
        { ...recorded, senderId: result.senderId },
        outcome,
        queuedAtIso,
        row,
      )
      return { kind: 'sent', message: row, waitedForIso: waited }
    }

    const attemptsSoFar = attempt
    const decision = decideRetry({
      reason: result.reason,
      attemptsSoFar,
      failedAt: deps.send.clock.now(),
    })
    const outcome: AttemptOutcome = {
      kind: 'failed',
      reason: result.reason,
      detail: result.detail,
      atIso,
      nextAttemptAtIso: decision.kind === 'retry' ? decision.atIso : null,
    }
    row = await record(deps, recorded, outcome, queuedAtIso, row)
    if (decision.kind === 'exhausted') return { kind: 'failed', message: row, waitedForIso: waited }

    waited.push(decision.atIso)
    await deps.waitUntil(decision.atIso)
  }

  // Unreachable while every policy's cap is at or below the constant below, which
  // `assertRetryPolicies` and `MAX_ATTEMPTS_ANY_POLICY`'s own test hold to. Throwing rather than
  // returning a made-up outcome: a caller cannot act on "we stopped trying for no stated reason".
  throw new AppError(
    'invariant_violated',
    `Message to ${recorded.recipient} exceeded ${MAX_ATTEMPTS_ANY_POLICY} attempts without reaching a ` +
      'terminal state. MESSAGE_RETRY_POLICY declares a larger cap than this loop allows.',
  )
}

/**
 * The ceiling on the retry loop, independent of the policy table.
 *
 * Deliberately a separate number: the loop's bound and the policy's cap being the same expression is
 * how an edit to one silently removes the other. `retry.test.ts` asserts no policy exceeds it.
 */
export const MAX_ATTEMPTS_ANY_POLICY = 5

async function record(
  deps: DeliveryDeps,
  message: RecordedMessage,
  outcome: AttemptOutcome,
  queuedAtIso: string,
  existing: MessageRecord | undefined,
): Promise<MessageRecord> {
  return existing === undefined
    ? await deps.store.recordSend(message, outcome, queuedAtIso)
    : await deps.store.recordAttempt(existing.id, outcome)
}

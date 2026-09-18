/**
 * The message row: writing it, moving it, and the four reads the admin inbox and the agent console need.
 *
 * ## Why the write side is an object and not four exported functions
 *
 * `createPostgresMessageStore(sql)` returns exactly the shape `MessageLifecycleStore` declares in
 * `@berelax/messaging` — and does so **structurally**, with no import in either direction, because
 * `packages/db` may import `@berelax/shared` only and a `db -> messaging` edge would put the provider-
 * facing package underneath the persistence layer. The compiler checks the fit where the two meet: the
 * worker's `reconcileDeliveryReceipts` and `packages/fixtures/src/message-lifecycle.itest.ts` both pass
 * this object into functions typed by that port, so a method renamed here fails to compile there.
 *
 * ## Why the status UPDATE carries a rank predicate as well as having a trigger behind it
 *
 * `refuse_message_status_regression` (migration 0035) raises. That is right for a writer that should not
 * be doing it — a migration, a psql session — and wrong for a delivery receipt, because an out-of-order
 * DLR is the *normal* case for a webhook and a normal case must not be an exception. So the UPDATE says
 * `where message_status_rank(status) < message_status_rank($new)`: an out-of-order receipt updates no
 * rows, the caller is told it did not advance, and the receipt is recorded with the reason. The trigger
 * is the backstop for everybody else.
 *
 * ## Why the reads are not in the port
 *
 * The listing, the cost aggregates and the frequency-cap count are queries a surface asks. Folding them
 * into the write port would make it the interface everything messaging-shaped accumulates against —
 * G-CONN-05's reason for three narrow Google seams rather than one wide one.
 */
import {
  AppError,
  advanceMessageStatus,
  DELIVERY_REPORTED_FAILED,
  type MessageRowFailureReason,
  type MessageStatus,
  type ReceiptIgnoredReason,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'

/** A message as the store returns it. The shape `MessageRecord` declares in @berelax/messaging. */
export interface MessageRow {
  readonly id: string
  readonly status: MessageStatus
  readonly providerMessageId: string | null
  readonly attempts: number
  readonly segments: number
  readonly costFils: number
  readonly nextAttemptAtIso: string | null
  readonly lastFailureReason: MessageRowFailureReason | null
}

/** The message as it was handed to a vendor. Matches `RecordedMessage` in @berelax/messaging. */
export interface MessageToRecord {
  readonly templateId: string
  readonly channel: string
  readonly messageClass: string
  readonly locale: string
  readonly vendor: string
  readonly recipient: string
  readonly senderId: string | null
  readonly subject: string | null
  readonly body: string
  readonly bodyHtml: string | null
  readonly encoding: string
  readonly segments: number
  readonly costFils: number
}

/** What one attempt produced. Matches `AttemptOutcome` in @berelax/messaging. */
export type MessageAttemptOutcome =
  | {
      readonly kind: 'accepted'
      readonly providerMessageId: string
      readonly segments: number
      readonly costFils: number
      readonly atIso: string
    }
  | {
      readonly kind: 'failed'
      readonly reason: MessageRowFailureReason
      readonly detail: string
      readonly atIso: string
      readonly nextAttemptAtIso: string | null
    }
  | { readonly kind: 'held'; readonly releaseAtIso: string; readonly atIso: string }

/** A receipt, already mapped by the vendor's transport. Matches `DeliveryReceiptRecord`. */
export interface ReceiptToApply {
  readonly vendor: string
  readonly providerMessageId: string
  readonly vendorStatus: string
  readonly mapped: MessageStatus | 'no_lifecycle_change' | null
  readonly occurredAtIso: string
  readonly reason: string | null
}

export type ReceiptOutcome =
  | { readonly kind: 'applied'; readonly messageId: string; readonly status: MessageStatus }
  | {
      readonly kind: 'ignored'
      readonly messageId: string
      readonly status: MessageStatus
      readonly reason: ReceiptIgnoredReason
    }
  | { readonly kind: 'replayed'; readonly messageId: string; readonly status: MessageStatus }
  | { readonly kind: 'unknown_message'; readonly providerMessageId: string }

interface RawMessageRow {
  readonly id: string
  readonly status: MessageStatus
  readonly provider_message_id: string | null
  readonly attempts: number
  readonly segments: number
  readonly cost_fils: string
  readonly next_attempt_at: Date | null
  readonly last_failure_reason: MessageRowFailureReason | null
}

const toRow = (row: RawMessageRow): MessageRow => ({
  id: row.id,
  status: row.status,
  providerMessageId: row.provider_message_id,
  attempts: Number(row.attempts),
  segments: Number(row.segments),
  // The driver returns bigint as a string so a fils amount cannot lose precision in transit; Number()
  // here is safe because a message costs tens of fils, and the column is the authority either way.
  costFils: Number(row.cost_fils),
  nextAttemptAtIso: iso(row.next_attempt_at),
  lastFailureReason: row.last_failure_reason,
})

/** A nullable timestamptz as an instant. The driver hands back a Date; the surface wants an ISO string. */
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

const RETURNING = `id, status, provider_message_id, attempts, segments, cost_fils::text as cost_fils,
  next_attempt_at, last_failure_reason`

/**
 * The column values one attempt's outcome produces.
 *
 * One function for the insert and the update, because the two diverging is how a retry ends up setting
 * a status the first attempt would not have: the rules about `sent_at`, `failed_at` and `next_attempt_at`
 * are the same whichever attempt it is.
 */
function columnsFor(outcome: MessageAttemptOutcome): {
  status: MessageStatus
  providerMessageId: string | null
  sentAt: string | null
  deliveredAt: null
  failedAt: string | null
  nextAttemptAt: string | null
  failureReason: MessageRowFailureReason | null
  failureDetail: string | null
  countsAsAttempt: boolean
} {
  const base = {
    providerMessageId: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    nextAttemptAt: null,
    failureReason: null,
    failureDetail: null,
  } as const
  if (outcome.kind === 'accepted') {
    return {
      ...base,
      status: 'sent',
      providerMessageId: outcome.providerMessageId,
      sentAt: outcome.atIso,
      countsAsAttempt: true,
    }
  }
  if (outcome.kind === 'held') {
    // Not an attempt: the promotional window held it before any transport was called, so counting it
    // would make the retry cap fire on a message that has never been tried.
    return {
      ...base,
      status: 'queued',
      nextAttemptAt: outcome.releaseAtIso,
      countsAsAttempt: false,
    }
  }
  const terminal = outcome.nextAttemptAtIso === null
  return {
    ...base,
    status: terminal ? 'failed' : 'queued',
    failedAt: terminal ? outcome.atIso : null,
    nextAttemptAt: outcome.nextAttemptAtIso,
    failureReason: outcome.reason,
    failureDetail: outcome.detail,
    countsAsAttempt: true,
  }
}

/**
 * The accepted outcome, or undefined.
 *
 * Narrowing in one place rather than at each of the four call sites: what a vendor charged is only
 * known on an acceptance, and an `outcome.kind === 'accepted' ? … : …` repeated per column is where one
 * of them ends up spelled the other way round.
 */
function accepted(
  outcome: MessageAttemptOutcome,
): Extract<MessageAttemptOutcome, { kind: 'accepted' }> | undefined {
  return outcome.kind === 'accepted' ? outcome : undefined
}

export interface PostgresMessageStore {
  recordSend(
    message: MessageToRecord,
    outcome: MessageAttemptOutcome,
    queuedAtIso: string,
  ): Promise<MessageRow>
  recordAttempt(messageId: string, outcome: MessageAttemptOutcome): Promise<MessageRow>
  applyReceipt(receipt: ReceiptToApply): Promise<ReceiptOutcome>
}

export function createPostgresMessageStore(sql: Sql): PostgresMessageStore {
  return {
    async recordSend(message, outcome, queuedAtIso) {
      const c = columnsFor(outcome)
      const [row] = await sql<RawMessageRow[]>`
        insert into message (
          template_id, channel, message_class, locale, vendor, recipient, sender_id,
          subject, body, body_html, encoding, segments, cost_fils,
          status, provider_message_id, attempts, last_failure_reason, last_failure_detail,
          next_attempt_at, queued_at, sent_at, delivered_at, failed_at
        ) values (
          ${message.templateId}, ${message.channel}::message_channel,
          ${message.messageClass}::message_class, ${message.locale}, ${message.vendor},
          ${message.recipient}, ${message.senderId},
          ${message.subject}, ${message.body}, ${message.bodyHtml}, ${message.encoding},
          ${accepted(outcome)?.segments ?? message.segments},
          ${accepted(outcome)?.costFils ?? message.costFils},
          ${c.status}::message_status, ${c.providerMessageId}, ${c.countsAsAttempt ? 1 : 0},
          ${c.failureReason}, ${c.failureDetail},
          ${c.nextAttemptAt}, ${queuedAtIso}, ${c.sentAt}, ${c.deliveredAt}, ${c.failedAt}
        )
        returning ${sql.unsafe(RETURNING)}
      `
      if (row === undefined) {
        throw new AppError('invariant_violated', 'The message insert returned no row.')
      }
      return toRow(row)
    },

    async recordAttempt(messageId, outcome) {
      const c = columnsFor(outcome)
      const [row] = await sql<RawMessageRow[]>`
        update message set
          status = ${c.status}::message_status,
          provider_message_id = coalesce(${c.providerMessageId}, provider_message_id),
          attempts = attempts + ${c.countsAsAttempt ? 1 : 0},
          last_failure_reason = ${c.failureReason},
          last_failure_detail = ${c.failureDetail},
          -- Reconciled on the attempt that was accepted, and left alone otherwise: the estimate priced
          -- the body, the vendor priced what it took, and where they differ the vendor's number is the
          -- one on the invoice. A coalesce rather than a branch, so a failed attempt cannot zero a
          -- billed segment count, which would remove a real cost from the report.
          segments = coalesce(${accepted(outcome)?.segments ?? null}::smallint, segments),
          cost_fils = coalesce(${accepted(outcome)?.costFils ?? null}::fils, cost_fils),
          next_attempt_at = ${c.nextAttemptAt},
          sent_at = coalesce(${c.sentAt}::timestamptz, sent_at),
          failed_at = ${c.failedAt}::timestamptz
        where id = ${messageId}
        returning ${sql.unsafe(RETURNING)}
      `
      if (row === undefined) {
        throw new AppError(
          'not_found',
          `No message ${messageId} to record an attempt against. An attempt with no row is an ` +
            'invisible send, which is the one outcome docs/12 §1 forbids.',
          { details: { messageId } },
        )
      }
      return toRow(row)
    },

    async applyReceipt(receipt) {
      // One transaction: the receipt row and the status it produced are one fact, and a receipt
      // recorded as applied against a status that did not change is worse than either alone.
      return (await sql.begin(async (tx) => {
        const [message] = await tx<{ id: string; status: MessageStatus }[]>`
          select id, status from message
           where vendor = ${receipt.vendor}
             and provider_message_id = ${receipt.providerMessageId}
           for update
        `
        if (message === undefined) {
          // Not recorded anywhere: the receipt has no row to belong to, and inventing one would
          // create a message this system never sent. Reported to the caller, which counts them —
          // a rising count means the vendor and this system disagree about what was sent.
          return { kind: 'unknown_message', providerMessageId: receipt.providerMessageId }
        }

        const decision = decide(message.status, receipt.mapped)

        const [inserted] = await tx<{ id: string }[]>`
          insert into message_delivery_receipt (
            message_id, vendor, vendor_status, mapped_status, applied, ignored_reason, reason,
            occurred_at
          ) values (
            ${message.id}, ${receipt.vendor}, ${receipt.vendorStatus},
            ${decision.mappedStatus}::message_status, ${decision.applied},
            ${decision.ignoredReason}, ${receipt.reason}, ${receipt.occurredAtIso}
          )
          on conflict on constraint message_delivery_receipt_replay_unique do nothing
          returning id
        `
        if (inserted === undefined) {
          // The same webhook body again. The first copy is already recorded and already applied, so
          // there is nothing to do and nothing to charge: this is the whole of the idempotency claim.
          return { kind: 'replayed', messageId: message.id, status: message.status }
        }
        if (!decision.applied) {
          return {
            kind: 'ignored',
            messageId: message.id,
            status: message.status,
            reason: decision.ignoredReason,
          }
        }

        const next = decision.mappedStatus
        const [advanced] = await tx<{ status: MessageStatus }[]>`
          update message set
            status = ${next}::message_status,
            delivered_at = case when ${next} = 'delivered' then ${receipt.occurredAtIso}::timestamptz
                                else delivered_at end,
            failed_at = case when ${next} = 'failed' then ${receipt.occurredAtIso}::timestamptz
                             else failed_at end,
            last_failure_reason = case when ${next} = 'failed'
                                       then ${DELIVERY_REPORTED_FAILED}
                                       else last_failure_reason end,
            last_failure_detail = case when ${next} = 'failed'
                                       then ${vendorDetail(receipt)}
                                       else last_failure_detail end,
            -- A terminal message must hold no pending retry: message_retry_only_while_queued refuses
            -- the row otherwise, and a retry on a delivered message would send it twice.
            next_attempt_at = null
          where id = ${message.id}
            and message_status_rank(status) < message_status_rank(${next}::message_status)
          returning status
        `
        if (advanced === undefined) {
          // Lost a race with another receipt for the same message. The stored status already wins,
          // and the receipt is on record — so this is the same answer as an out-of-order one.
          return {
            kind: 'ignored',
            messageId: message.id,
            status: message.status,
            reason: 'status_would_not_advance',
          }
        }
        return { kind: 'applied', messageId: message.id, status: advanced.status }
      })) as ReceiptOutcome
    },
  }
}

/** The vendor's word and its own reason text, for `last_failure_detail`. */
function vendorDetail(receipt: ReceiptToApply): string {
  const reason = receipt.reason === null ? '' : `: ${receipt.reason}`
  return `${receipt.vendor} reported '${receipt.vendorStatus}'${reason}`
}

type ReceiptDecision =
  | { readonly applied: true; readonly mappedStatus: MessageStatus; readonly ignoredReason: null }
  | {
      readonly applied: false
      readonly mappedStatus: MessageStatus | null
      readonly ignoredReason: ReceiptIgnoredReason
    }

/**
 * What a receipt does, before any row is written.
 *
 * The `'no_lifecycle_change'` branch is recorded with its mapping intact — the receipt was understood,
 * it simply is not about delivery (Resend's `opened`, and its `complained`, which happens *after* a
 * successful delivery). The `null` branch is the one the acceptance criterion turns on: an unrecognised
 * vendor status changes nothing and must never become `delivered`.
 */
function decide(
  current: MessageStatus,
  mapped: MessageStatus | 'no_lifecycle_change' | null,
): ReceiptDecision {
  if (mapped === 'no_lifecycle_change') {
    return {
      applied: false,
      mappedStatus: null,
      ignoredReason: 'vendor_status_carries_no_lifecycle_change',
    }
  }
  const advance = advanceMessageStatus(current, mapped)
  return advance.applied
    ? { applied: true, mappedStatus: advance.status, ignoredReason: null }
    : { applied: false, mappedStatus: mapped, ignoredReason: advance.reason }
}

// --- the reads -----------------------------------------------------------------------------------

/** One receipt, as the inbox shows it. */
export interface InboxReceipt {
  readonly vendorStatus: string
  readonly mappedStatus: MessageStatus | null
  readonly applied: boolean
  readonly ignoredReason: string | null
  readonly reason: string | null
  readonly occurredAtIso: string
}

/** One inbox row: everything the acceptance criterion asks to be visible, plus its receipts. */
export interface InboxEntry {
  readonly id: string
  readonly templateKey: string
  readonly templateVersion: number
  readonly channel: string
  readonly vendor: string
  readonly messageClass: string
  readonly locale: string
  readonly recipient: string
  readonly senderId: string | null
  readonly subject: string | null
  readonly body: string
  readonly bodyHtml: string | null
  readonly encoding: string
  readonly segments: number
  readonly costFils: number
  readonly status: MessageStatus
  readonly providerMessageId: string | null
  readonly attempts: number
  readonly lastFailureReason: string | null
  readonly lastFailureDetail: string | null
  readonly queuedAtIso: string
  readonly sentAtIso: string | null
  readonly deliveredAtIso: string | null
  readonly failedAtIso: string | null
  readonly nextAttemptAtIso: string | null
  readonly receipts: readonly InboxReceipt[]
}

export interface InboxFilter {
  readonly limit?: number
  /**
   * Narrow to one template, which is how a test isolates itself.
   *
   * The integration suite runs sequentially against one database and `message` is protected by an
   * ON DELETE RESTRICT foreign key from an append-only table, so rows accumulate by design. A reader
   * that asserted "the inbox holds one row" would pass until the next unit sent a message
   * (`docs/CONTRIBUTING-AGENT-BRIEF.md` §12). Narrowing what the reader can see is the fix; deleting
   * rows is not.
   */
  readonly templateKey?: string
  readonly recipient?: string
  readonly status?: MessageStatus
}

const DEFAULT_INBOX_LIMIT = 50

export async function listMessageInbox(
  sql: Sql,
  filter: InboxFilter = {},
): Promise<readonly InboxEntry[]> {
  const limit = filter.limit ?? DEFAULT_INBOX_LIMIT
  const rows = await sql<
    {
      id: string
      template_key: string
      template_version: number
      channel: string
      vendor: string
      message_class: string
      locale: string
      recipient: string
      sender_id: string | null
      subject: string | null
      body: string
      body_html: string | null
      encoding: string
      segments: number
      cost_fils: string
      status: MessageStatus
      provider_message_id: string | null
      attempts: number
      last_failure_reason: string | null
      last_failure_detail: string | null
      queued_at: Date
      sent_at: Date | null
      delivered_at: Date | null
      failed_at: Date | null
      next_attempt_at: Date | null
      receipts: readonly {
        vendor_status: string
        mapped_status: MessageStatus | null
        applied: boolean
        ignored_reason: string | null
        reason: string | null
        occurred_at: string
      }[]
    }[]
  >`
    select m.id,
           t.template_key,
           t.version as template_version,
           m.channel::text as channel,
           m.vendor,
           m.message_class::text as message_class,
           m.locale,
           m.recipient,
           m.sender_id,
           m.subject,
           m.body,
           m.body_html,
           m.encoding,
           m.segments,
           m.cost_fils::text as cost_fils,
           m.status,
           m.provider_message_id,
           m.attempts,
           m.last_failure_reason,
           m.last_failure_detail,
           m.queued_at,
           m.sent_at,
           m.delivered_at,
           m.failed_at,
           m.next_attempt_at,
           coalesce((
             select json_agg(json_build_object(
                      'vendor_status', r.vendor_status,
                      'mapped_status', r.mapped_status,
                      'applied', r.applied,
                      'ignored_reason', r.ignored_reason,
                      'reason', r.reason,
                      'occurred_at', r.occurred_at
                    ) order by r.occurred_at, r.received_at)
               from message_delivery_receipt r
              where r.message_id = m.id
           ), '[]'::json) as receipts
      from message m
      join message_template t on t.id = m.template_id
     where (${filter.templateKey ?? null}::text is null or t.template_key = ${filter.templateKey ?? null})
       and (${filter.recipient ?? null}::text is null or m.recipient = ${filter.recipient ?? null})
       and (${filter.status ?? null}::text is null or m.status::text = ${filter.status ?? null})
     order by m.queued_at desc, m.id desc
     limit ${limit}
  `
  return rows.map((row) => ({
    id: row.id,
    templateKey: row.template_key,
    templateVersion: Number(row.template_version),
    channel: row.channel,
    vendor: row.vendor,
    messageClass: row.message_class,
    locale: row.locale,
    recipient: row.recipient,
    senderId: row.sender_id,
    subject: row.subject,
    body: row.body,
    bodyHtml: row.body_html,
    encoding: row.encoding,
    segments: Number(row.segments),
    costFils: Number(row.cost_fils),
    status: row.status,
    providerMessageId: row.provider_message_id,
    attempts: Number(row.attempts),
    lastFailureReason: row.last_failure_reason,
    lastFailureDetail: row.last_failure_detail,
    queuedAtIso: row.queued_at.toISOString(),
    sentAtIso: iso(row.sent_at),
    deliveredAtIso: iso(row.delivered_at),
    failedAtIso: iso(row.failed_at),
    nextAttemptAtIso: iso(row.next_attempt_at),
    receipts: row.receipts.map((receipt) => ({
      vendorStatus: receipt.vendor_status,
      mappedStatus: receipt.mapped_status,
      applied: receipt.applied,
      ignoredReason: receipt.ignored_reason,
      reason: receipt.reason,
      // json_agg serialises a timestamptz as ISO 8601 with an offset, so this is already an instant.
      occurredAtIso: new Date(receipt.occurred_at).toISOString(),
    })),
  }))
}

export interface CostWindow {
  readonly fromIso: string
  readonly toIso: string
  /**
   * Narrow to these template keys. Absent means every template, which is what the console shows.
   *
   * A list rather than one key, because the assertion these queries exist for is a literal total over a
   * seeded fixture of several templates — and a reader that could only narrow to one would make the
   * fixture's own total unassertable without also counting whatever else the shared test database holds.
   */
  readonly templateKeys?: readonly string[]
}

/** One trading day's messaging spend. `tradingDate` is null for a send outside every trading window. */
export interface CostByTradingDate {
  readonly tradingDate: string | null
  readonly messages: number
  readonly segments: number
  readonly costFils: number
}

/**
 * Cost per trading day.
 *
 * Grouped by `business_day.trading_date` rather than by `date(sent_at)`, because trading runs
 * 11:00–02:00: a confirmation sent at 01:30 belongs to the previous trading date, and a report that
 * split it by calendar date would put one evening's messages on two days and reconcile against nothing.
 *
 * The join is a LEFT join and the null bucket is returned rather than dropped. An inner join would
 * silently omit every message sent while the salon was shut — a 09:00 reminder is real, it cost real
 * money, and a cost report that quietly excludes it is the class of defect that only shows up when
 * somebody adds the columns by hand.
 */
export async function messageCostByTradingDate(
  sql: Sql,
  window: CostWindow,
): Promise<readonly CostByTradingDate[]> {
  const rows = await sql<
    { trading_date: string | null; messages: string; segments: string; cost_fils: string }[]
  >`
    select bd.trading_date::text as trading_date,
           count(*)::text as messages,
           coalesce(sum(m.segments), 0)::text as segments,
           coalesce(sum(m.cost_fils), 0)::text as cost_fils
      from message m
      join message_template t on t.id = m.template_id
      left join business_day bd
        on m.sent_at >= bd.opens_at and m.sent_at < bd.closes_at
     where m.sent_at is not null
       and m.sent_at >= ${window.fromIso}::timestamptz
       and m.sent_at < ${window.toIso}::timestamptz
       and (${window.templateKeys ?? null}::text[] is null
            or t.template_key = any(${window.templateKeys ?? null}::text[]))
     group by bd.trading_date
     order by bd.trading_date nulls last
  `
  return rows.map((row) => ({
    tradingDate: row.trading_date,
    messages: Number(row.messages),
    segments: Number(row.segments),
    costFils: Number(row.cost_fils),
  }))
}

export interface CostByTemplate {
  readonly templateKey: string
  readonly messages: number
  readonly segments: number
  readonly costFils: number
}

/**
 * Cost per template, over a window.
 *
 * Grouped by `template_key` rather than by `template_id`: a reclassification creates a new version
 * (migration 0015), and a report that grouped by id would split one template's spend across its
 * versions on the day somebody corrected its class.
 */
export async function messageCostByTemplate(
  sql: Sql,
  window: CostWindow,
): Promise<readonly CostByTemplate[]> {
  const rows = await sql<
    { template_key: string; messages: string; segments: string; cost_fils: string }[]
  >`
    select t.template_key,
           count(*)::text as messages,
           coalesce(sum(m.segments), 0)::text as segments,
           coalesce(sum(m.cost_fils), 0)::text as cost_fils
      from message m
      join message_template t on t.id = m.template_id
     where m.sent_at is not null
       and m.sent_at >= ${window.fromIso}::timestamptz
       and m.sent_at < ${window.toIso}::timestamptz
       and (${window.templateKeys ?? null}::text[] is null
            or t.template_key = any(${window.templateKeys ?? null}::text[]))
     group by t.template_key
     order by t.template_key
  `
  return rows.map((row) => ({
    templateKey: row.template_key,
    messages: Number(row.messages),
    segments: Number(row.segments),
    costFils: Number(row.cost_fils),
  }))
}

/**
 * How many promotional messages this recipient has been sent since an instant.
 *
 * This is the number `messaging.frequency_cap_per_week` is compared against, and the two things it
 * deliberately does **not** do are the point:
 *
 * **No status filter.** A message counts from the moment a vendor accepted it. A delivery receipt that
 * later marks it delivered, or failed, must not be able to change the count — otherwise a DLR pass
 * becomes a way of buying another marketing send, and the cap it is capping is "messages the customer
 * received" rather than "messages we sent", which is not what a do-not-bother-me limit means.
 *
 * **Counted on `queued_at`, not `sent_at`.** A message held for the promotional window has already been
 * decided on; not counting it would let a batch queued at 23:00 clear the cap twice over before 07:00.
 */
export async function countPromotionalMessagesSince(
  sql: Sql,
  args: { readonly recipient: string; readonly sinceIso: string },
): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n
      from message
     where recipient = ${args.recipient}
       and message_class = 'promotional'
       and queued_at >= ${args.sinceIso}::timestamptz
  `
  return Number(row?.n ?? '0')
}

/** One message by id, for a detail view and for a test's assertion on the final stored value. */
export async function readMessageRow(sql: Sql, id: string): Promise<MessageRow | null> {
  const [row] = await sql<RawMessageRow[]>`
    select ${sql.unsafe(RETURNING)} from message where id = ${id}
  `
  return row === undefined ? null : toRow(row)
}

/** Every receipt on one message, oldest first. Append-only, so a count here is a delta over time. */
export async function listMessageReceipts(
  sql: Sql,
  messageId: string,
): Promise<readonly InboxReceipt[]> {
  const rows = await sql<
    {
      vendor_status: string
      mapped_status: MessageStatus | null
      applied: boolean
      ignored_reason: string | null
      reason: string | null
      occurred_at: Date
    }[]
  >`
    select vendor_status, mapped_status, applied, ignored_reason, reason, occurred_at
      from message_delivery_receipt
     where message_id = ${messageId}
     order by occurred_at, received_at
  `
  return rows.map((row) => ({
    vendorStatus: row.vendor_status,
    mappedStatus: row.mapped_status,
    applied: row.applied,
    ignoredReason: row.ignored_reason,
    reason: row.reason,
    occurredAtIso: row.occurred_at.toISOString(),
  }))
}

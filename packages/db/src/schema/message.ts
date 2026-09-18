import { MESSAGE_STATUSES } from '@berelax/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { messageChannel, messageClass, messageTemplate } from './messaging.ts'

/**
 * The status lifecycle, mirrored from migration 0035.
 *
 * The values come from `MESSAGE_STATUSES` in `@berelax/shared` rather than being retyped, so the enum
 * the database holds, the union the application branches on and the badge the admin inbox renders are
 * one list. `pnpm db:drift` compares the mirror with the live database, and it compares columns rather
 * than enum members — which is exactly the gap a hand-copied array would fall into.
 */
export const messageStatus = pgEnum('message_status', MESSAGE_STATUSES)

/**
 * One outbound message, from the moment a vendor answered for it to its terminal state.
 *
 * The status vocabulary is **ours**: SMSala says `accepted / delivered / failed / expired / rejected`
 * and Resend says `delivered / bounced / complained / opened`, and mapping their words onto these four
 * is what makes a vendor change a change to a mapping table rather than to every report in the system.
 * The vendor's own word is kept verbatim on each receipt below.
 *
 * `messageClass` and `costFils` are copied here at send time and never recomputed: the frequency cap and
 * the cost report describe what was sent, and a later `reclassify_template` (migration 0015) must not
 * move a past message into or out of either.
 */
export const message = pgTable(
  'message',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The version that was sent, not the current one. ON DELETE RESTRICT: a sent message is evidence. */
    templateId: uuid('template_id')
      .notNull()
      .references(() => messageTemplate.id, { onDelete: 'restrict' }),
    channel: messageChannel('channel').notNull(),
    messageClass: messageClass('message_class').notNull(),
    locale: text('locale').notNull(),
    /** Whose status vocabulary a receipt on this row is written in. `smsala` or `resend`. */
    vendor: text('vendor').notNull(),
    /** E.164 or an address. Masked at render: the inbox is screenshotted. */
    recipient: text('recipient').notNull(),
    /** The registered sender identity an SMS left from. Null for email. */
    senderId: text('sender_id'),
    subject: text('subject'),
    body: text('body').notNull(),
    /** The HTML part exactly as the provider received it, so the preview pane shows what was sent. */
    bodyHtml: text('body_html'),
    encoding: text('encoding').notNull(),
    segments: smallint('segments').notNull(),
    costFils: bigint('cost_fils', { mode: 'bigint' }).notNull(),
    status: messageStatus('status').notNull(),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').notNull(),
    lastFailureReason: text('last_failure_reason'),
    lastFailureDetail: text('last_failure_detail'),
    /** When the retry policy allows the next attempt. Only ever set while `status = 'queued'`. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** One vendor id, one message: a receipt is matched on it, so two rows would be ambiguous. */
    unique('message_provider_id_unique').on(t.vendor, t.providerMessageId),
    index('message_inbox_idx').on(t.queuedAt),
    index('message_template_cost_idx').on(t.templateId, t.sentAt),
    index('message_recipient_window_idx').on(t.recipient, t.messageClass, t.queuedAt),
  ],
)

/**
 * Every delivery receipt a vendor sent, applied or not.
 *
 * Append-only (UPDATE and DELETE raise), because a receipt is the evidence for a status: an
 * out-of-order one, a duplicate, an unrecognised vendor word and Resend's `opened` are all recorded with
 * `applied = false` and the reason they changed nothing. A receipt discarded silently is a receipt
 * nobody can use to explain why a message still says `sent` three days later.
 *
 * `messageId` is ON DELETE RESTRICT on purpose, and it is the shape of the isolation rule in
 * `docs/CONTRIBUTING-AGENT-BRIEF.md` §12: a test cannot tidy up by deleting the message, because that
 * would be deleting the evidence. Narrow what the reader can see instead.
 */
export const messageDeliveryReceipt = pgTable(
  'message_delivery_receipt',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => message.id, { onDelete: 'restrict' }),
    vendor: text('vendor').notNull(),
    /** The vendor's own word, verbatim. This is the column a vendor change reads differently. */
    vendorStatus: text('vendor_status').notNull(),
    /** What our lifecycle made of it. Null when the vendor sent a word this system does not map. */
    mappedStatus: messageStatus('mapped_status'),
    applied: boolean('applied').notNull(),
    ignoredReason: text('ignored_reason'),
    /** The vendor's free text: 'Absent subscriber', 'Mailbox does not exist'. */
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** The replay guard: the same webhook body three times is one row and one transition. */
    unique('message_delivery_receipt_replay_unique').on(t.messageId, t.vendorStatus, t.occurredAt),
    index('message_delivery_receipt_message_idx').on(t.messageId, t.occurredAt),
  ],
)

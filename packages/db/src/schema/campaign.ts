import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { customer } from './customer.ts'
import { messageChannel } from './messaging.ts'

/**
 * Drizzle mirror of 0154_campaign_and_segment.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Four things the mirror cannot say, and each one will bite somebody who builds a write from these
 * definitions rather than calling `packages/db/src/repositories/campaign.ts`:
 *
 *   - **`campaign.spentFils` may not be written from here.** `db.update(campaign).set({ spentFils })`
 *     typechecks perfectly and raises `ZY753` at run time, which is the correct outcome: the spend is
 *     moved only by `claim_campaign_recipient` and `settle_campaign_recipient`, which reserve against the
 *     cap and record the reservation in ONE statement. A cap checked in application code is a cap until
 *     two workers run, and the type system cannot express "this column has two writers and both are
 *     functions".
 *   - **`campaign_spend_within_cap` is the layer underneath that.** `spentFils <= capFils` by CHECK, so
 *     the cap holds against a hand-written UPDATE, a future function and a `psql` session alike.
 *   - **A `sent` campaign_recipient row is immutable** (ZY755) and is required to carry its gate decision
 *     and consent record id (`campaign_recipient_sent_row_is_answerable`). The pending → claimed → sent
 *     transitions are ordinary updates; the table is therefore NOT append-only and carries no such
 *     marker.
 *   - **`termCount` is GENERATED ALWAYS.** Passing a value makes Postgres raise, which is right: it is
 *     `jsonb_array_length(definition -> 'terms')` and a caller-supplied one would be a second opinion
 *     about a document the row already holds.
 *
 * `campaignRecipient.consentRecordId` carries no foreign key into `consent`, and that is not an omission:
 * it is `consent.contactCustomerId`'s arrangement for `consent.contactCustomerId`'s reason. The consent
 * ledger is deliberately not joined to by reference, so a customer erasure cannot cascade away the
 * evidence that a message was sent lawfully.
 */

/** Where a campaign is. `halted` is one state with a reason column — see the migration's comment. */
export const campaignState = pgEnum('campaign_state', [
  'draft',
  'scheduled',
  'running',
  'halted',
  'completed',
  'cancelled',
])

/** One recipient's outcome. `held` and `failed` are different facts: a held message is still owed. */
export const campaignRecipientState = pgEnum('campaign_recipient_state', [
  'pending',
  'claimed',
  'sent',
  'held',
  'failed',
])

/** Why a running campaign stopped. Null while it has not. */
export const campaignHaltReason = pgEnum('campaign_halt_reason', [
  'spend_cap_reached',
  'promotional_window_closed',
  'operator',
])

/** One segment definition and its DATED cached count. The definition is compiled, never executed. */
export const customerSegment = pgTable(
  'customer_segment',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The stable machine key a campaign names. UNIQUE. */
    segmentKey: text('segment_key').notNull(),
    title: text('title').notNull(),
    /**
     * The definition document, as `serialiseSegmentDefinition` produces it.
     *
     * Never SQL. `compileSegment` in `@berelax/core` turns it into one parameterised query over an
     * allowlisted attribute registry; a stored SQL string would be a stored injection with a cached count
     * attached.
     */
    definition: jsonb('definition').notNull(),
    /** GENERATED ALWAYS from the document. Not writable. */
    termCount: integer('term_count').notNull(),
    /**
     * The count, and the instant it was taken. Both or neither, by CHECK.
     *
     * A count with no instant is a number beside a send button with nothing saying how stale it is, and
     * C-AUTO-10's provisional answer requires the timestamp to be shown next to the number.
     */
    cachedCount: integer('cached_count'),
    cachedCountAt: timestamp('cached_count_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('customer_segment_key_unique').on(t.segmentKey),
    check(
      'customer_segment_key_is_lower_snake_case',
      sql`${t.segmentKey} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      'customer_segment_cached_count_is_dated',
      sql`(${t.cachedCount} is null) = (${t.cachedCountAt} is null)`,
    ),
  ],
)

/** One campaign: a segment, a template, a cap and a schedule. */
export const campaign = pgTable(
  'campaign',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    campaignKey: text('campaign_key').notNull(),
    title: text('title').notNull(),
    segmentId: uuid('segment_id')
      .notNull()
      .references(() => customerSegment.id),
    /** The template the copy comes from. The CLASS is the template row's, read by the choke point. */
    templateKey: text('template_key').notNull(),
    channel: messageChannel('channel').notNull(),
    state: campaignState('state').notNull().default('draft'),
    haltedReason: campaignHaltReason('halted_reason'),
    /**
     * When it may leave.
     *
     * Deliberately carries NO promotional-window constraint. The window is
     * `messaging.promotional_window` and the rule is `promotional-window.ts`; a constraint here would be
     * a second answer to when a message may be sent, and the symptom of two answers is a 21:30 send that
     * every screen says was compliant.
     */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    /** The pre-launch estimate. All three or none of them, by CHECK. */
    estimatedRecipients: integer('estimated_recipients'),
    estimatedSegments: integer('estimated_segments'),
    estimatedFils: integer('estimated_fils'),
    capFils: integer('cap_fils').notNull(),
    /** Moved only by the claim and settle functions (ZY753) and bounded by CHECK. See the header. */
    spentFils: integer('spent_fils').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    launchedAt: timestamp('launched_at', { withTimezone: true }),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
  },
  (t) => [
    unique('campaign_key_unique').on(t.campaignKey),
    index('campaign_state_scheduled_idx').on(t.state, t.scheduledAt),
    index('campaign_segment_idx').on(t.segmentId),
    check('campaign_key_is_lower_snake_case', sql`${t.campaignKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('campaign_spend_within_cap', sql`${t.spentFils} >= 0 and ${t.spentFils} <= ${t.capFils}`),
  ],
)

/** One contact on one campaign, with its outcome and the evidence that outcome was lawful. */
export const campaignRecipient = pgTable(
  'campaign_recipient',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaign.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    /** The enumeration order, so "recipient 120 of 200" is a fact about the row. Claimed in this order. */
    position: integer('position').notNull(),
    state: campaignRecipientState('state').notNull().default('pending'),
    /** What was reserved against the cap, and what it actually cost. Both, so the two can be equal. */
    reservedFils: integer('reserved_fils'),
    costFils: integer('cost_fils'),
    segments: smallint('segments'),
    /** NOT NULL on a sent row, by CHECK. This is the regulator's answer and it is one query away. */
    gateDecision: text('gate_decision'),
    /** A plain uuid, not a foreign key. See the header. */
    consentRecordId: uuid('consent_record_id'),
    heldReason: text('held_reason'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('campaign_recipient_one_message_per_contact').on(t.campaignId, t.customerId),
    unique('campaign_recipient_position_is_unique').on(t.campaignId, t.position),
    index('campaign_recipient_claim_idx').on(t.campaignId, t.state, t.position),
    index('campaign_recipient_customer_idx').on(t.customerId),
    check(
      'campaign_recipient_sent_row_is_answerable',
      sql`${t.state} <> 'sent'
        or (${t.gateDecision} is not null and ${t.consentRecordId} is not null
            and ${t.costFils} is not null and ${t.segments} is not null
            and ${t.settledAt} is not null)`,
    ),
  ],
)

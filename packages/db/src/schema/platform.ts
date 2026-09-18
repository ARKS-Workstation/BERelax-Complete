import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/** Audit trail. Append-only and partitioned monthly in the database; see migration 0005. */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: uuid('id').notNull().default(sql`uuid_generate_v7()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    /** Reads matter as much as writes for clinical and salary data. */
    operation: text('operation').notNull(),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    requestId: text('request_id'),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('audit_event_entity_idx').on(t.entityType, t.entityId, t.occurredAt),
    index('audit_event_actor_idx').on(t.actorId, t.occurredAt),
    index('audit_event_action_idx').on(t.action, t.occurredAt),
  ],
)

/** Transactional outbox. Written in the same transaction as the state change. */
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: smallint('event_version').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').notNull(),
    /** At-least-once delivery: every handler must be idempotent on this. */
    idempotencyKey: text('idempotency_key').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: smallint('attempts').notNull(),
    lastError: text('last_error'),
  },
  (t) => [index('outbox_event_aggregate_idx').on(t.aggregateType, t.aggregateId, t.occurredAt)],
)

/**
 * One row per (event, handler) already delivered.
 *
 * The composite primary key is what turns the outbox's at-least-once delivery into exactly-once
 * *per handler*: a second attempt is a PK conflict rather than a duplicate side effect. A handler
 * added later starts with no rows and therefore receives events it has not yet seen.
 */
export const outboxDelivery = pgTable(
  'outbox_delivery',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => outboxEvent.id, { onDelete: 'cascade' }),
    handler: text('handler').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
    attempts: smallint('attempts').notNull(),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.handler] }),
    index('outbox_delivery_handler_idx').on(t.handler, t.deliveredAt),
  ],
)

/** Settings tier. Mirrors the `setting_tier` enum in migration 0010. */
export const settingTier = pgEnum('setting_tier', [
  'content',
  'operational',
  'brand',
  'structural',
  'compliance_locked',
])

/**
 * Current value per setting key.
 *
 * `isProvisional` marks a value the build chose because no answer existed. It is what the
 * Unconfirmed Assumptions panel reads, and a human confirming the value clears the flag — so the
 * panel empties as answers arrive rather than needing separate bookkeeping.
 */
export const appSetting = pgTable(
  'app_setting',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    tier: settingTier('tier').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    provisionalNote: text('provisional_note'),
    openQuestionId: text('open_question_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [index('app_setting_tier_idx').on(t.tier)],
)

/** Append-only history, written by a database trigger so no write path can skip it. */
export const appSettingHistory = pgTable(
  'app_setting_history',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    key: text('key').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value').notNull(),
    tier: settingTier('tier').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    changedBy: text('changed_by').notNull(),
    justification: text('justification'),
  },
  (t) => [index('app_setting_history_key_idx').on(t.key, t.changedAt)],
)

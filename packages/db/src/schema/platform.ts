import { sql } from 'drizzle-orm'
import { index, inet, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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

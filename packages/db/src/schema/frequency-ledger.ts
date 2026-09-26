import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { customer } from './customer.ts'
import { message } from './message.ts'
import { messageChannel } from './messaging.ts'

/**
 * Drizzle mirror of 0080_frequency_ledger.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Four things the mirror cannot say, and each one will bite somebody who builds a write from these
 * definitions rather than calling `packages/db/src/repositories/frequency-ledger.ts`:
 *
 *   - **The cap counts `countedAt`, never `attemptedAt`.** `countedAt` is NULL for a refused attempt and
 *     `frequency_ledger_instants_match_the_outcome` holds that biconditional, so no range predicate can
 *     count a refusal. Counting refusals would make the cap self-reinforcing — each refusal raising the
 *     count that caused it — and a `select count(*) … where attempted_at > …` is how somebody writes that
 *     by accident. There is no type here that can express the difference, so it is stated: the count reads
 *     `countedAt`.
 *   - **A counted row is immutable except for its contact.** `frequency_ledger_count_is_immutable` raises
 *     ZW002 for an UPDATE that changes `countedAt`, `outcome`, `messageId`, `sendKey` or `attemptedAt`, for
 *     every role including the owner. `db.update(frequencyLedger).set({ countedAt })` typechecks perfectly
 *     and raises. `contactCustomerId` stays writable because the merge re-points it.
 *   - **The unique index is PARTIAL**, on `countedAt is not null`, which Drizzle cannot express. That is
 *     what lets a capped attempt retried after the window rolls become a `sent` row under the same
 *     `sendKey`, and it is the conflict key `MERGE_PARTICIPANTS` registers — `union_dedupe` with
 *     `conflictKey: ['send_key']` and `activePredicate: 'counted_at is not null'`.
 *   - **`sourceRef` is NOT a foreign key**, deliberately, and there must never be one. A deleted campaign
 *     must not delete the evidence of what it sent, nor reduce a contact's count — which a cascade would do
 *     silently, handing the contact an allowance back.
 *
 * DELETE and TRUNCATE are revoked from the application role. Erasure still works through the cascade from
 * `customer`, which runs with the referencing table owner's privileges rather than the caller's.
 */

/** A counted send, or an attempt the cap refused. Nothing transactional is ever written here. */
export const frequencyLedgerOutcome = pgEnum('frequency_ledger_outcome', [
  'sent',
  'frequency_capped',
])

/** The three things in this build that can ask for a promotional send. */
export const frequencySourceKind = pgEnum('frequency_source_kind', ['flow', 'campaign', 'manual'])

export const frequencyLedger = pgTable(
  'frequency_ledger',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** CASCADE from `customer`: with the contact erased there is nobody left to protect from a send. */
    contactCustomerId: uuid('contact_customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    outcome: frequencyLedgerOutcome('outcome').notNull(),
    /** THE column the cap counts. NULL for every outcome that did not send. See the note above. */
    countedAt: timestamp('counted_at', { withTimezone: true }),
    /** The mirror. NULL unless the cap refused. Exactly one of the two is set. */
    refusedAt: timestamp('refused_at', { withTimezone: true }),
    /** From the caller's clock, never `now()`: a rolling window is asserted to the second. */
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    /** Recorded, not counted: the cap is global across channels, so an SMS and an email both spend one. */
    channel: messageChannel('channel').notNull(),
    /** The send that happened. NULL for a refusal; ON DELETE RESTRICT, because it is the evidence. */
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'restrict' }),
    sourceKind: frequencySourceKind('source_kind').notNull(),
    /** The flow or campaign. NOT a foreign key — see the note above. */
    sourceRef: text('source_ref').notNull(),
    /** The natural key of the attempt, and what `union_dedupe` folds on. */
    sendKey: text('send_key').notNull(),
    /** Which cap refused, and the numbers it refused on. All four together, or all four null. */
    boundCapKey: text('bound_cap_key'),
    boundCapLimit: integer('bound_cap_limit'),
    boundCapWindowSeconds: integer('bound_cap_window_seconds'),
    boundCapCount: integer('bound_cap_count'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** PARTIAL in the SQL (`where counted_at is not null`), which Drizzle cannot express. */
    uniqueIndex('frequency_ledger_one_counted_send').on(t.contactCustomerId, t.sendKey),
    index('frequency_ledger_cap_read_idx').on(t.contactCustomerId, t.countedAt.desc()),
    index('frequency_ledger_source_idx').on(t.sourceKind, t.sourceRef, t.attemptedAt.desc()),
    index('frequency_ledger_refusal_idx').on(t.contactCustomerId, t.refusedAt.desc()),
  ],
)

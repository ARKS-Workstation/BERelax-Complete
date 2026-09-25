import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0069_customer_merge.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Four things the mirror cannot say, and each of them will bite somebody who builds a write from these
 * definitions rather than calling `packages/db/src/repositories/merge.ts`:
 *
 *   - **Both tables are append-only.** `update` and `delete` are revoked from `berelax_app` AND refused
 *     by BEFORE triggers for every role including the owner (ZT001). `db.update(mergeRecord)`
 *     typechecks perfectly and raises at run time, which is the correct outcome: a merge that was wrong
 *     is answered by a new operation with its own record, never by editing the row that says what was
 *     done.
 *   - **`loserCustomerId` is UNIQUE, and that is the tombstone.** There is no `isTombstone` column and
 *     no `mergedInto` column on `customer`: the pair lives here once, so it cannot disagree with itself.
 *     `merge_survivor_of(uuid)` in the database follows the chain, and `mergeSurvivorOf` in the
 *     repository is the one caller that should be used from TypeScript.
 *   - **Neither customer id is a foreign key.** 0056's decision for an append-only log, restated in
 *     0069's header: a cascade would fire the refusal trigger and make `delete from customer` raise for
 *     every caller, including the four integration files that clear that table. So there is no relation
 *     to declare here and `db.delete(customer)` is not blocked by either.
 *   - **The counts on `mergeRecordTable` are CHECKed, not merely recorded.**
 *     `rows_after_loser = rows_before_loser - rows_moved` and
 *     `rows_after_survivor = rows_before_survivor + rows_moved + rows_inserted`, so a merge that
 *     dropped or doubled a row cannot store its own report and the refusal rolls the merge back. A
 *     write assembled from these definitions with plausible-looking numbers will be refused by the
 *     database, and that is the intended behaviour rather than an inconvenience.
 *
 * `mergedAt`, like `consent.recordedAt` and `suppression.recordedAt`, has NO default: it is supplied
 * from an injected clock because every ordering assertion in this area is made under a frozen one.
 */

export const mergeRecord = pgTable(
  'merge_record',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The record that survived. A plain uuid, not a foreign key; see the header. */
    survivorCustomerId: uuid('survivor_customer_id').notNull(),
    /** The record that became a tombstone. UNIQUE — a record is merged away exactly once. */
    loserCustomerId: uuid('loser_customer_id').notNull(),
    /** When the merge was decided. Supplied, never defaulted. */
    mergedAt: timestamp('merged_at', { withTimezone: true }).notNull(),
    /** `staff` or `system`, behind a CHECK. Never `customer`. */
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    /** `auto_merge` or `operator_confirmed`. There is deliberately no third value. */
    authority: text('authority').notNull(),
    reason: text('reason').notNull(),
    /** C-CRM-02's authoritative figure, integer per-mille. Never a float. */
    scorePerMille: integer('score_per_mille').notNull(),
    /** Pinned to `PHONE_AGREEMENTS` in `@berelax/core` by the integration suite. */
    phoneAgreement: text('phone_agreement').notNull(),
    /** Pinned to `LABEL_AGREEMENTS` in `@berelax/core` by the integration suite. */
    labelAgreement: text('label_agreement').notNull(),
    /** The scalar conflicts and the loser's discarded values. An array, behind a CHECK. */
    fieldResolutions: jsonb('field_resolutions').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('merge_record_one_merge_per_loser').on(t.loserCustomerId),
    index('merge_record_survivor_idx').on(t.survivorCustomerId, t.mergedAt),
  ],
)

/**
 * What one merge did to one table.
 *
 * `participant` is `schema.table` as `merge-participants.ts` spells it, and it is text rather than an
 * enum on purpose: the registry is code, later units register into it — C-AUTO-03's frequency ledger and
 * C-AUTO-07's flow runs both will — and an enum would make every registration a migration.
 */
export const mergeRecordTable = pgTable(
  'merge_record_table',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** A real foreign key, unlike the customer ids: its parent can never be deleted. */
    mergeRecordId: uuid('merge_record_id').notNull(),
    participant: text('participant').notNull(),
    idColumn: text('id_column').notNull(),
    strategy: text('strategy').notNull(),
    rowsBeforeSurvivor: integer('rows_before_survivor').notNull(),
    rowsBeforeLoser: integer('rows_before_loser').notNull(),
    rowsAfterSurvivor: integer('rows_after_survivor').notNull(),
    rowsAfterLoser: integer('rows_after_loser').notNull(),
    /** Re-pointed in place. */
    rowsMoved: integer('rows_moved').notNull(),
    /** Copied onto the survivor with the original left where it was — an append-only table. */
    rowsInserted: integer('rows_inserted').notNull(),
    /** Rows that stayed on the tombstone: a taken key, or the same event recorded twice. */
    rowsRetainedOnLoser: integer('rows_retained_on_loser').notNull(),
    /** Required exactly when `rowsRetainedOnLoser` is above zero, by CHECK. */
    retainedReason: text('retained_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('merge_record_table_one_row_per_participant').on(t.mergeRecordId, t.participant),
    index('merge_record_table_record_idx').on(t.mergeRecordId),
  ],
)

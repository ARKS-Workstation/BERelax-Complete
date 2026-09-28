import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0085_data_subject_rights.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Five things the mirror cannot say, and each will bite somebody who builds a write from these definitions
 * rather than calling `packages/db/src/repositories/rights.ts`:
 *
 *   - **Three of these tables are append-only.** `rightsResolution`, `rightsResolutionClass` and
 *     `rightsExport` refuse UPDATE and DELETE by BEFORE triggers for EVERY role including the owner
 *     (ZA004), and `update`/`delete`/`truncate` are revoked from `berelax_app` as well.
 *     `db.update(rightsResolution)` typechecks perfectly and raises at run time, which is the correct
 *     outcome: the resolution is the evidence that a request was answered and what was retained on what
 *     basis, and evidence that can be edited is not evidence.
 *   - **`rightsRequest` is mutable in exactly one column.** `state` moves along the machine
 *     `refuse_rights_request_rewrite` declares (ZA003); the type, the subject, `receivedAt`, `dueAt`,
 *     `slaDays` and `verifiedVia` are FROZEN (ZA002) because an SLA nobody can edit is the only kind worth
 *     having, and DELETE raises for every role (ZA001).
 *   - **`rightsResolutionClass` CHECKs its own arithmetic.** `rows_before = rows_acted + rows_retained`,
 *     `retained_reason` is required exactly when rows were retained, and `retain_statutory` must name the
 *     `regulatory_profile` column its years figure came from. A row assembled here with plausible-looking
 *     numbers is refused by the database, and the refusal rolls the erasure back — which is the intended
 *     behaviour rather than an inconvenience.
 *   - **`rightsExport.alerted` is not a free boolean.** `rights_export_multi_subject_alerts` ties it to
 *     `subjectCount > 1`, so a bulk export cannot be recorded as un-alerted.
 *   - **`subjectCustomerId` is not a foreign key**, here or on `legalHold`. 0056's and 0069's decision:
 *     four integration files clear `customer`, and a foreign key would make `delete from customer` raise
 *     for every one of them. The record of a request also has to outlive the record it was about.
 *
 * `receivedAt`, `resolvedAt`, `exportedAt` and `placedAt` have NO default, like `consent.recordedAt` and
 * `suppression.recordedAt`: they are supplied from an injected clock because every deadline and ordering
 * assertion in this area is made under a frozen one.
 */

export const rightsRequest = pgTable(
  'rights_request',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** One of the five rights, behind a CHECK. Text and not an enum; see 0085's header. */
    requestType: text('request_type').notNull(),
    /** A plain uuid, not a foreign key; see the header. */
    subjectCustomerId: uuid('subject_customer_id').notNull(),
    /** When the subject asked. Supplied, never defaulted. Frozen after insert (ZA002). */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** The SLA this request was taken under, stored so a later setting change cannot retroactively move it. */
    slaDays: smallint('sla_days').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    state: text('state').notNull().default('received'),
    /** `otp`, `in_person_id` or `staff_attested`. Required, and frozen: see the header. */
    verifiedVia: text('verified_via').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    requestDetail: text('request_detail').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rights_request_one_open_per_subject_and_type')
      .on(table.subjectCustomerId, table.requestType)
      .where(sql`closed_at is null`),
    index('rights_request_overdue_idx').on(table.dueAt).where(sql`closed_at is null`),
    index('rights_request_subject_idx').on(table.subjectCustomerId, table.receivedAt),
  ],
)

export const rightsResolution = pgTable(
  'rights_resolution',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    rightsRequestId: uuid('rights_request_id').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull(),
    /** WHICH profile decided. The reason a past retention stays explainable after the profile changes. */
    regulatoryProfileVersion: integer('regulatory_profile_version').notNull(),
    /** `erased-` plus 32 letters, behind a CHECK. Null for a request that is not an erasure. */
    pseudonym: text('pseudonym'),
    privacyRegime: text('privacy_regime').notNull(),
    regimeIsProvisional: boolean('regime_is_provisional').notNull(),
    openQuestionIds: text('open_question_ids').array().notNull(),
    /** Required with NO default: row-level erasure cannot reach a backup, and silence would imply it does. */
    backupPosition: text('backup_position').notNull(),
    responseIssued: boolean('response_issued').notNull(),
    responseWithheldReason: text('response_withheld_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('rights_resolution_resolved_idx').on(table.resolvedAt)],
)

export const rightsResolutionClass = pgTable(
  'rights_resolution_class',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    rightsResolutionId: uuid('rights_resolution_id').notNull(),
    dataClass: text('data_class').notNull(),
    /** `schema.table`, behind the same regex 0069 uses for a merge participant. */
    participant: text('participant').notNull(),
    /** The column the rule was keyed on, or `*` for a table-wide rule. */
    columnName: text('column_name').notNull(),
    action: text('action').notNull(),
    rowsBefore: integer('rows_before').notNull(),
    rowsActed: integer('rows_acted').notNull(),
    rowsRetained: integer('rows_retained').notNull(),
    /** The reason it is lawful to keep the rows. Required exactly when there are any. */
    retainedReason: text('retained_reason'),
    /** The `regulatory_profile` column the figure came from, so the years are never a literal. */
    obligationColumn: text('obligation_column'),
    obligationYears: smallint('obligation_years'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('rights_resolution_class_one_row_per_column').on(
      table.rightsResolutionId,
      table.participant,
      table.columnName,
    ),
    index('rights_resolution_class_resolution_idx').on(table.rightsResolutionId),
  ],
)

export const rightsExport = pgTable(
  'rights_export',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Null for a staff export that is not answering a request; `purpose` is required either way. */
    rightsRequestId: uuid('rights_request_id'),
    purpose: text('purpose').notNull(),
    exportedAt: timestamp('exported_at', { withTimezone: true }).notNull(),
    rowCount: integer('row_count').notNull(),
    /** docs/06 D4's insider-threat control turns on this number alone. */
    subjectCount: integer('subject_count').notNull(),
    /** Tied to `subjectCount > 1` by a CHECK: a bulk export cannot be recorded as un-alerted. */
    alerted: boolean('alerted').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('rights_export_exported_idx').on(table.exportedAt),
    index('rights_export_multi_subject_idx').on(table.exportedAt).where(sql`subject_count > 1`),
  ],
)

export const legalHold = pgTable(
  'legal_hold',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Null means every subject; a null `dataClass` means every class. Both null is REFUSED. */
    subjectCustomerId: uuid('subject_customer_id'),
    dataClass: text('data_class'),
    reason: text('reason').notNull(),
    placedAt: timestamp('placed_at', { withTimezone: true }).notNull(),
    placedByKind: text('placed_by_kind').notNull(),
    placedByLabel: text('placed_by_label').notNull(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
    liftedReason: text('lifted_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('legal_hold_one_live_per_scope')
      .on(table.subjectCustomerId, table.dataClass)
      .where(sql`lifted_at is null`),
  ],
)

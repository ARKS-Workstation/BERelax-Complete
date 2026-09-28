import { sql } from 'drizzle-orm'
import {
  bigint,
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
 * Drizzle mirror of 0093_publication.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Six things the mirror cannot say, and each will bite somebody who assembles a write from these
 * definitions rather than calling `packages/db/src/repositories/publication.ts`:
 *
 *   - **All three tables are append-only, for every role including the owner.** BEFORE triggers raise
 *     `ZZ001` on UPDATE and DELETE, and `update`/`delete`/`truncate` are revoked from `berelax_app` as
 *     well. `db.update(publicationRecord)` typechecks and raises at run time, which is correct: these rows
 *     are the evidence that a page was linted, approved by a named person against a content hash and put
 *     live, and evidence that can be edited is not evidence. A correction is a NEW published record naming
 *     the one it supersedes.
 *   - **`state` is a sequence, not a value.** `assert_publication_transition` (ZZ002) refuses a state that
 *     does not follow the surface's previous record, and the arrows are declared in
 *     `packages/core/src/publication/state-machine.ts` — where a caller should ask before writing, because
 *     a rejected INSERT has already consumed a `seq`.
 *   - **`published` needs evidence, by CHECK.** `lint_pass_id` and `approval_id` are both required for it
 *     (`publication_record_published_needs_evidence`), and `approved` needs the lint pass. Nullable here
 *     because a draft carries neither.
 *   - **The hashes are chained by COMPOSITE foreign keys.** `(lint_pass_id, content_sha256)` on the
 *     approval and `(approval_id, content_sha256)` on the record, so approving or publishing content whose
 *     hash differs from the linted or approved content is `23503` naming the constraint — during a restore
 *     with triggers off as well. Drizzle cannot express a composite key against a `unique (id, hash)`
 *     parent, which is why it is not declared below; the SQL is the authority and `db:drift` compares
 *     columns, so the omission costs nothing but this paragraph.
 *   - **A published row must carry its measured weight and be inside it.**
 *     `measured_critical_path_bytes` and `critical_path_budget_bytes` are required exactly on `published`
 *     (`publication_record_published_carries_its_weight`), and `measured <= budget`
 *     (`publication_record_published_is_within_budget`, plus ZZ005 which prints both numbers). A publish
 *     that skipped docs/08 §8's third enforcement layer has nothing to write.
 *   - **Every publish needs an `audit_event` in the SAME transaction.** A `deferrable initially deferred`
 *     constraint trigger checks it at COMMIT (ZZ004), so an audit row written afterwards in a second
 *     transaction does not satisfy it.
 *
 * `linted_at`, `approved_at` and `recorded_at` have NO default, like `consent.recordedAt` and
 * `rights_request.receivedAt`: they come from an injected clock, because every ordering assertion in this
 * area is made under a frozen one and a column defaulting to `now()` cannot be frozen.
 */

export const publicationLintPass = pgTable(
  'publication_lint_pass',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** A locator — collection and slug — never the copy. The same shape `CmsCopy.where` uses. */
    surface: text('surface').notNull(),
    /** sha256 of exactly the content that was linted, lower-case hex, behind a CHECK. */
    contentSha256: text('content_sha256').notNull(),
    /** WHICH profile decided. Stored so a past publication stays explainable after the profile changes. */
    regulatoryProfileVersion: integer('regulatory_profile_version').notNull(),
    /** How many banned terms the pass compared against. `> 0` by CHECK; see 0093's header. */
    termsChecked: smallint('terms_checked').notNull(),
    lintedAt: timestamp('linted_at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('publication_lint_pass_surface_idx').on(table.surface, table.lintedAt)],
)

export const publicationApproval = pgTable(
  'publication_approval',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    lintPassId: uuid('lint_pass_id').notNull(),
    /** Must equal the lint pass's hash — by composite foreign key, not by a trigger. See the header. */
    contentSha256: text('content_sha256').notNull(),
    /** The approver's id. Not a foreign key: there is no staff table yet, and the record outlives them. */
    approverUserId: text('approver_user_id').notNull(),
    /** Snapshotted at approval, so a later rename cannot rewrite who approved what. */
    approverDisplayName: text('approver_display_name').notNull(),
    /** And the role they held then, behind a CHECK against F07's role set. */
    approverRole: text('approver_role').notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('publication_approval_approver_idx').on(table.approverUserId, table.approvedAt),
  ],
)

export const publicationRecord = pgTable(
  'publication_record',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * The append order within a surface, `generated always as identity`.
     *
     * Read rather than written: a uuid v7 ties for two rows inserted in one transaction, and the
     * transition trigger needs an unambiguous "row before this one". `bigint` with `mode: 'number'`
     * because the figure is a row counter and will not reach 2^53.
     */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    surface: text('surface').notNull(),
    /** `draft`, `lint_passed`, `approved` or `published`. A SEQUENCE; see the header. */
    state: text('state').notNull(),
    contentSha256: text('content_sha256').notNull(),
    /** Required on `approved` and `published` by CHECK; null on a draft. */
    lintPassId: uuid('lint_pass_id'),
    /** Required on `published` by CHECK; null before it. */
    approvalId: uuid('approval_id'),
    /** The record this one replaces. Set exactly on a correction or a revert (ZZ003). */
    supersedesId: uuid('supersedes_id'),
    /** What the publish-time synthetic weight check measured. Required on `published`. */
    measuredCriticalPathBytes: integer('measured_critical_path_bytes'),
    /** And what it was measured against, so the row explains its own verdict. Required on `published`. */
    criticalPathBudgetBytes: integer('critical_path_budget_bytes'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('publication_record_surface_seq_idx').on(table.surface, table.seq),
    index('publication_record_state_idx').on(table.state, table.recordedAt),
    index('publication_record_published_idx')
      .on(table.surface, table.seq)
      .where(sql`state = 'published'`),
  ],
)

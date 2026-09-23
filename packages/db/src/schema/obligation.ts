import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0052_obligation.sql` — the compliance calendar.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these definitions against the live database in both directions.
 *
 * The three tables are the definitions, their dated occurrences and the evidence filed against a
 * completion. What makes the set worth reading is which columns have **no writer**:
 *
 *   - `obligation.isBlocking` is GENERATED from `blockingEffect`, the way `employee.isPublishable` is
 *     generated from its two inputs. Declared here as an ordinary column — the mirror records the
 *     shape and the generation expression lives in the migration that owns it — and the point is that
 *     nothing in this package or above it can write it.
 *   - every other column of `obligation` is fixed after insert. `refuse_obligation_shape_change()`
 *     refuses an UPDATE that changes anything but `anchorOn`, so "blocking cannot be switched off from
 *     settings" is a property of the schema rather than of the absence of a settings key.
 *
 * `employee` is **imported** rather than re-declared, exactly as `./staff.ts` imports `therapistSkill`
 * from `./catalogue.ts`: a second `pgTable('employee', …)` would compile, read identically and give
 * `pnpm db:drift` two mirrors of one table to disagree about.
 */

/** What kind of duty this is. The blocking consequence is CHECKed against it in 0052. */
export const obligationClass = pgEnum('obligation_class', [
  'licence',
  'credential',
  'hygiene',
  'tax',
  'labour',
])

/**
 * How the next occurrence is dated.
 *
 * `event_driven` generates **nothing** from a cadence: the due date comes from the event — a renewal
 * notice, a document expiry — and stepping a guessed interval would put a date in the calendar that
 * nothing on file supports. `obligationDueDates` in `@berelax/core` returns an empty list for it.
 */
export const obligationCadence = pgEnum('obligation_cadence', [
  'monthly',
  'quarterly',
  'annual',
  'event_driven',
])

/**
 * What changes when this obligation is overdue.
 *
 * Not a boolean plus a comment: the two consequences are enforced in two different code paths — the
 * availability read (`overdueBlockingObligationExclusion`) and the publication guard
 * (`assertPublishingNotBlocked`) — and a flag would leave the pairing to a `case` somewhere.
 */
export const obligationBlockingEffect = pgEnum('obligation_blocking_effect', [
  'none',
  'therapist_unbookable',
  'publishing_blocked',
])

/** Whether one occurrence covers the business or one covers each therapist. */
export const obligationSubjectScope = pgEnum('obligation_subject_scope', ['business', 'therapist'])

export const obligationInstanceStatus = pgEnum('obligation_instance_status', ['open', 'completed'])

export const obligation = pgTable(
  'obligation',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The stable handle a refusal names. `PublishingBlocked: trade_licence_renewal is overdue`. */
    key: text('key').notNull().unique(),
    title: text('title').notNull(),
    obligationClass: obligationClass('obligation_class').notNull(),
    cadence: obligationCadence('cadence').notNull(),
    subjectScope: obligationSubjectScope('subject_scope').notNull(),
    /**
     * The F07 role that owes it. Text with a CHECK restating `ROLES`, as
     * `appointmentStatusHistory.actorRole` (0046) carries it: this package may not import the policy
     * layer, and the duplication is pinned to `ROLES` by a test that parses the constraint.
     */
    ownerRole: text('owner_role').notNull(),
    blockingEffect: obligationBlockingEffect('blocking_effect').notNull(),
    /** GENERATED as `blocking_effect <> 'none'`. There is no writer, which is the whole point. */
    isBlocking: boolean('is_blocking').notNull(),
    evidenceRequired: boolean('evidence_required').notNull(),
    /**
     * Our reading of a secondary source rather than a confirmed duty (the `[UNVERIFIED]` items in
     * docs/04). Deliberately not the `isProvisional` trio: that means "the build chose this VALUE",
     * this means "the duty itself is unconfirmed", and one flag covering both would clear M-VAT-11's
     * dashboard for an answer nobody gave.
     */
    isUnverified: boolean('is_unverified').notNull(),
    unverifiedNote: text('unverified_note'),
    openQuestionId: text('open_question_id'),
    /** Where the duty is written down, so a reader can check it. A document section, never prose. */
    sourceReference: text('source_reference').notNull(),
    /** NULL where the build has not been told which body it is: a plausible one reads as configured. */
    authority: text('authority'),
    /**
     * The first due date, and the only column an UPDATE may change.
     *
     * NULL on every seeded row. The build has not seen the trade licence, the municipality permit or a
     * therapist's certificate, so it does not know when any of them expires, and a plausible date would
     * be indistinguishable from one read off the document. A NULL anchor generates no occurrences.
     */
    anchorOn: date('anchor_on'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('obligation_blocking_idx').on(t.blockingEffect),
    check('obligation_key_shape', sql`${t.key} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    check('obligation_title_not_placeholder', sql`not is_placeholder_text(${t.title})`),
    check(
      'obligation_owner_role_known',
      sql`${t.ownerRole} in ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')`,
    ),
    check(
      'obligation_unverified_names_a_question',
      sql`not ${t.isUnverified} or (${t.openQuestionId} is not null and ${t.unverifiedNote} is not null)`,
    ),
    // The two consequences docs/04 §9 names, each tied to the class that can carry it.
    check(
      'obligation_blocking_effect_matches_class',
      sql`${t.blockingEffect} = 'none'
          or (${t.blockingEffect} = 'therapist_unbookable' and ${t.obligationClass} = 'credential')
          or (${t.blockingEffect} = 'publishing_blocked' and ${t.obligationClass} = 'licence')`,
    ),
    check(
      'obligation_therapist_effect_is_per_therapist',
      sql`${t.blockingEffect} <> 'therapist_unbookable' or ${t.subjectScope} = 'therapist'`,
    ),
  ],
)

export const obligationInstance = pgTable(
  'obligation_instance',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    obligationId: uuid('obligation_id')
      .notNull()
      .references(() => obligation.id, { onDelete: 'restrict' }),
    /** The therapist this occurrence is about, or NULL for a business-wide obligation. */
    subjectEmployeeId: uuid('subject_employee_id').references(() => employee.id, {
      onDelete: 'restrict',
    }),
    /**
     * Compared against the TRADING date, never the calendar date: trading runs 11:00–02:00, so at
     * 01:30 the business is still working the previous trading date and an obligation due that date is
     * not yet overdue (`resolveTradingDate` in `@berelax/core`).
     */
    dueOn: date('due_on').notNull(),
    status: obligationInstanceStatus('status').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByRole: text('completed_by_role'),
    completedByLabel: text('completed_by_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('obligation_instance_open_due_idx').on(t.dueOn, t.obligationId),
    index('obligation_instance_subject_idx').on(t.subjectEmployeeId),
    /**
     * UNIQUE **NULLS NOT DISTINCT**, which is what makes the generator idempotent.
     *
     * The subject is NULL for a business-wide obligation, and the default NULL-is-distinct reading
     * would let a second generation run insert the trade-licence renewal again — so the determinism the
     * acceptance asks for is a constraint here rather than a convention in the writer. Drizzle's
     * `.nullsNotDistinct()` is the mirror of that; the migration is the authority.
     */
    unique('obligation_instance_one_per_due_date')
      .on(t.obligationId, t.subjectEmployeeId, t.dueOn)
      .nullsNotDistinct(),
    check(
      'obligation_instance_completed_by_role_known',
      sql`${t.completedByRole} is null or ${t.completedByRole} in ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')`,
    ),
    check(
      'obligation_instance_completion_is_whole',
      sql`(${t.status} = 'completed') = (${t.completedAt} is not null)`,
    ),
    check(
      'obligation_instance_completion_has_an_actor',
      sql`${t.status} <> 'completed' or (${t.completedByRole} is not null and ${t.completedByLabel} is not null)`,
    ),
  ],
)

/**
 * What was filed against a completion. Append-only: UPDATE and DELETE raise ZO004.
 *
 * Evidence that can be edited after the fact is not evidence. M-VAT-11 owns serving these privately by
 * signed URL and auditing every download; the columns are here now because the completion trigger needs
 * something real to join to, and a nullable text column on the instance would be a reference to nothing.
 */
export const obligationEvidence = pgTable(
  'obligation_evidence',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    obligationInstanceId: uuid('obligation_instance_id')
      .notNull()
      .references(() => obligationInstance.id, { onDelete: 'restrict' }),
    /** Where the file is, in the private bucket. Never a public URL. */
    storageKey: text('storage_key').notNull(),
    contentHash: text('content_hash').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull(),
    uploadedByLabel: text('uploaded_by_label').notNull(),
  },
  (t) => [
    unique('obligation_evidence_one_row_per_file').on(t.obligationInstanceId, t.contentHash),
    check(
      'obligation_evidence_storage_key_not_placeholder',
      sql`not is_placeholder_text(${t.storageKey})`,
    ),
    check('obligation_evidence_content_hash_shape', sql`${t.contentHash} ~ '^[a-f0-9]{64}$'`),
  ],
)

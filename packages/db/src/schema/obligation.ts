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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { message } from './message.ts'
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
    /**
     * When somebody took responsibility for this occurrence (0060).
     *
     * On the OCCURRENCE and not on the notice, because it is a fact about the duty rather than about one
     * message: recorded against a notice it would stop only that rung, so the second escalation would
     * still fire about a duty somebody picked up on day eight. It stops ESCALATION and deliberately not
     * the reminders — an acknowledgement at 60 days must not silence the notice at 7.
     */
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedByRole: text('acknowledged_by_role'),
    acknowledgedByLabel: text('acknowledged_by_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('obligation_instance_open_due_idx').on(t.dueOn, t.obligationId),
    index('obligation_instance_unacknowledged_idx').on(t.dueOn),
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
    check(
      'obligation_instance_acknowledged_by_role_known',
      sql`${t.acknowledgedByRole} is null or ${t.acknowledgedByRole} in ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')`,
    ),
    // All three or none: an acknowledgement with no actor is a compliance control that stops escalating
    // because somebody unknown clicked something.
    check(
      'obligation_instance_acknowledgement_is_whole',
      sql`(${t.acknowledgedAt} is null) = (${t.acknowledgedByRole} is null)
          and (${t.acknowledgedAt} is null) = (${t.acknowledgedByLabel} is null)`,
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

/**
 * Drizzle mirror of the 0060 half: the notices and the evidence grant.
 *
 * The structure is `scheduledStep`'s (0051) and that is deliberate rather than convergent — a reminder
 * about a deadline that has moved is the same bug as a reminder about an appointment that has moved, and
 * a second mechanism for it would be a second thing to reconcile. Two things differ and both are stated
 * in the migration: `notifyOn` is a `date`, because an obligation falls due at the end of a day; and
 * there are TWO partial unique indexes rather than one, because the acceptance criterion asks for at most
 * one SENT notice per (occurrence, step) for ever and not merely one live one.
 */
export const obligationNoticeKind = pgEnum('obligation_notice_kind', ['reminder', 'escalation'])

/**
 * Four states, not 0051's five.
 *
 * `cancelled` is absent because an obligation occurrence is never cancelled — its status is open or
 * completed — and a completed one is recorded as a SKIP carrying `obligation_completed`, so "how many
 * notices did we not send because the renewal was already filed" stays a countable answer.
 */
export const obligationNoticeState = pgEnum('obligation_notice_state', [
  'pending',
  'sent',
  'skipped',
  'superseded',
])

export const obligationNotice = pgTable(
  'obligation_notice',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /**
     * CASCADE, for 0051's reason and not by symmetry: a pending notice is an intention, and 0052 keeps
     * DELETE granted on `obligation_instance` so the generator may withdraw a future occurrence. What a
     * SENT notice leaves behind is the `message` row, referenced RESTRICT below.
     */
    obligationInstanceId: uuid('obligation_instance_id')
      .notNull()
      .references(() => obligationInstance.id, { onDelete: 'cascade' }),
    kind: obligationNoticeKind('kind').notNull(),
    /** `reminder_60d`. Bounded by pattern rather than by an enum: both ladders are settings. */
    step: text('step').notNull(),
    /**
     * The F07 role this notice names. NOT NULL, because a notice nobody is accountable for is
     * decoration. A reminder names the duty's declared owner; an escalation must name somebody else,
     * which `assert_obligation_notice_names_an_accountable_role()` refuses to let a writer forget.
     */
    toRole: text('to_role').notNull(),
    invalidationKey: text('invalidation_key').notNull(),
    /** A `date`: the calendar is a date calendar, and the trading date is the unit of comparison. */
    notifyOn: date('notify_on').notNull(),
    state: obligationNoticeState('state').notNull(),
    messageId: uuid('message_id').references(() => message.id, { onDelete: 'restrict' }),
    stalenessNote: text('staleness_note'),
    skippedReason: text('skipped_reason'),
    /** Required for every terminal state. What makes a silent settlement unstorable. */
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('obligation_notice_due_idx').on(t.notifyOn),
    index('obligation_notice_instance_idx').on(t.obligationInstanceId, t.step),
    uniqueIndex('obligation_notice_one_pending_per_step').on(t.obligationInstanceId, t.step),
    uniqueIndex('obligation_notice_one_send_per_step').on(t.obligationInstanceId, t.step),
    unique('obligation_notice_message_claimed_once').on(t.messageId),
    check(
      'obligation_notice_to_role_known',
      sql`${t.toRole} in ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')`,
    ),
    check(
      'obligation_notice_step_is_a_declared_rung',
      sql`${t.step} ~ '^(reminder|escalation)_[1-9][0-9]{0,2}d$'`,
    ),
    check(
      'obligation_notice_pending_has_settled_nothing',
      sql`${t.state} <> 'pending'
          or (${t.settledAt} is null and ${t.messageId} is null and ${t.skippedReason} is null
              and ${t.stalenessNote} is null)`,
    ),
    check(
      'obligation_notice_terminal_is_settled',
      sql`${t.state} = 'pending' or ${t.settledAt} is not null`,
    ),
    check(
      'obligation_notice_sent_carries_its_message',
      sql`(${t.state} = 'sent') = (${t.messageId} is not null)`,
    ),
    check(
      'obligation_notice_skipped_carries_a_reason',
      sql`(${t.state} = 'skipped') = (${t.skippedReason} is not null)`,
    ),
  ],
)

/**
 * An expiring capability to download one filed evidence file (0060).
 *
 * `tokenSha256` and never the token: a grant table that held its own tokens would be a table that grants
 * access to every evidence file in the business, which is why `repositories/otp.ts` stores a digest of a
 * six-digit code rather than the code. A stored grant rather than an HMAC over the URL for three reasons
 * the migration sets out — no new signing secret for a link that lives fifteen minutes, revocable by
 * DELETE, and the row records who asked.
 */
export const obligationEvidenceGrant = pgTable(
  'obligation_evidence_grant',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    obligationEvidenceId: uuid('obligation_evidence_id')
      .notNull()
      .references(() => obligationEvidence.id, { onDelete: 'restrict' }),
    tokenSha256: text('token_sha256').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** A role and a label, never a person's name (ADR 0020). */
    issuedToRole: text('issued_to_role').notNull(),
    issuedToLabel: text('issued_to_label').notNull(),
    purpose: text('purpose').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('obligation_evidence_grant_evidence_idx').on(t.obligationEvidenceId, t.expiresAt),
    check('obligation_evidence_grant_token_shape', sql`${t.tokenSha256} ~ '^[a-f0-9]{64}$'`),
    check(
      'obligation_evidence_grant_role_known',
      sql`${t.issuedToRole} in ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')`,
    ),
    check(
      'obligation_evidence_grant_purpose_not_placeholder',
      sql`not is_placeholder_text(${t.purpose})`,
    ),
    check('obligation_evidence_grant_expires_after_issue', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
)

import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { message } from './message.ts'
import { employee, leaveRequest } from './staff.ts'

/**
 * Drizzle mirror of the six tables `packages/db/migrations/0092_leave_approval.sql` creates.
 *
 * A file of its own rather than more of `./hr.ts`, and the reason is what `./hr.ts`'s own header gives for
 * keeping 0086's four tables in `./attendance.ts`: that file mirrors the ROSTER — what the business intends
 * people to work — and these six are the record of a DECISION somebody took about somebody's time off.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`.
 *
 * What is NOT expressible here, and therefore lives only in the migration and is asserted against real
 * PostgreSQL by `packages/fixtures/src/hr-leave-approval.itest.ts`:
 *
 *   * the exclusion constraint `leave_delegation_no_overlapping_live`;
 *   * the four append-only trigger pairs (ZY001) and the two assertion triggers (ZY002, ZY003, ZY004, ZY005);
 *   * the `leave_approval_live` view, which Drizzle has no mirror for — and which is where the "is this
 *     approval still live" predicate lives, for `employee_approved_leave`'s reason (0030).
 */

/**
 * `tstzrange`, which Drizzle has no built-in column type for.
 *
 * Carried as the Postgres text form rather than parsed into a pair of instants — the same choice
 * `./staff.ts`, `./rooms.ts` and `./booking.ts` make, and for the same reason: parsing it here would put
 * range semantics in the ORM layer, where a caller could construct an inclusive upper bound without
 * noticing. The database refuses anything but `[)`.
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange'
  },
})

/**
 * Time-bounded authority for a named deputy to decide another employee's leave.
 *
 * The only MUTABLE table of the six: withdrawal is an UPDATE of `revokedAt`, because deleting a delegation
 * would erase that the authority ever existed — the question asked after a decision somebody disputes.
 */
export const leaveApprovalDelegation = pgTable(
  'leave_approval_delegation',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    delegatorEmployeeId: uuid('delegator_employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    /** The DEPUTY, a person. A delegation to a role would make every holder of it a deputy. */
    deputyEmployeeId: uuid('deputy_employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    period: tstzrange('period').notNull(),
    reason: text('reason').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('leave_delegation_deputy_idx').on(t.deputyEmployeeId),
    check('leave_delegation_period_nonempty', sql`not isempty(${t.period})`),
    check(
      'leave_delegation_period_bounded',
      sql`lower(${t.period}) is not null and upper(${t.period}) is not null`,
    ),
    check(
      'leave_delegation_period_half_open',
      sql`lower_inc(${t.period}) and not upper_inc(${t.period})`,
    ),
    check(
      'leave_delegation_is_to_somebody_else',
      sql`${t.delegatorEmployeeId} <> ${t.deputyEmployeeId}`,
    ),
    check(
      'leave_delegation_reason_is_written',
      sql`length(btrim(${t.reason})) >= 8 and not is_placeholder_text(${t.reason})`,
    ),
    check(
      'leave_delegation_created_by_not_placeholder',
      sql`not is_placeholder_text(${t.createdBy})`,
    ),
    // A biconditional: revoked with no reason is as wrong as a reason with no revocation.
    check(
      'leave_delegation_revocation_is_whole',
      sql`(${t.revokedAt} is null) = (${t.revokedReason} is null)`,
    ),
    check(
      'leave_delegation_revocation_reason_is_written',
      sql`${t.revokedReason} is null
       or (length(btrim(${t.revokedReason})) >= 8 and not is_placeholder_text(${t.revokedReason}))`,
    ),
  ],
)

/** One approved leave request: who decided it, under what authority, and what judged the floor. */
export const leaveApproval = pgTable(
  'leave_approval',
  {
    leaveRequestId: uuid('leave_request_id')
      .primaryKey()
      .references(() => leaveRequest.id, { onDelete: 'restrict' }),
    approvedByEmployeeId: uuid('approved_by_employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    approverRole: text('approver_role').notNull(),
    approvedVia: text('approved_via').notNull(),
    delegationId: uuid('delegation_id').references(() => leaveApprovalDelegation.id, {
      onDelete: 'restrict',
    }),
    /**
     * The `rota_coverage_rule` version that judged the floor. A plain date and not a foreign key, for
     * 0081's reason: a RESTRICT reference from a row that can never be deleted pins the parent for ever.
     */
    coverageRuleEffectiveFrom: date('coverage_rule_effective_from').notNull(),
    period: tstzrange('period').notNull(),
    conflictsOverridden: smallint('conflicts_overridden').notNull(),
    conflictsReassigned: smallint('conflicts_reassigned').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('leave_approval_employee_idx').on(t.approvedByEmployeeId),
    check('leave_approval_via_is_known', sql`${t.approvedVia} in ('own_authority', 'delegation')`),
    check(
      'leave_approval_delegation_matches_via',
      sql`(${t.approvedVia} = 'delegation') = (${t.delegationId} is not null)`,
    ),
    check(
      'leave_approval_role_not_placeholder',
      sql`length(btrim(${t.approverRole})) > 0 and not is_placeholder_text(${t.approverRole})`,
    ),
    check('leave_approval_period_nonempty', sql`not isempty(${t.period})`),
    check(
      'leave_approval_period_half_open',
      sql`lower_inc(${t.period}) and not upper_inc(${t.period})`,
    ),
    check(
      'leave_approval_conflict_counts_are_whole',
      sql`${t.conflictsOverridden} >= 0 and ${t.conflictsReassigned} >= 0`,
    ),
  ],
)

/** One appointment a human decided to leave standing inside approved leave. Never a cancellation. */
export const leaveConflictOverride = pgTable(
  'leave_conflict_override',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    leaveRequestId: uuid('leave_request_id')
      .notNull()
      .references(() => leaveRequest.id, { onDelete: 'restrict' }),
    /**
     * A plain column, not a reference. 0081's lesson in full: `ON DELETE SET NULL` arrives as an UPDATE,
     * which ZY001 refuses, and `ON DELETE RESTRICT` pins the parent for ever because nothing here can be
     * deleted to release it. `recordLeaveConflictOverride` refuses an appointment the leave does not
     * overlap, which is a stronger check than the existence a key would give.
     */
    appointmentId: uuid('appointment_id').notNull(),
    /** Refused unless 'owner' or 'manager', by ZY002 in the migration — a trigger, not a CHECK. */
    actorRole: text('actor_role').notNull(),
    actorLabel: text('actor_label').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('leave_conflict_override_once').on(t.leaveRequestId, t.appointmentId),
    index('leave_conflict_override_request_idx').on(t.leaveRequestId),
    check(
      'leave_conflict_override_actor_label_written',
      sql`length(btrim(${t.actorLabel})) > 0 and not is_placeholder_text(${t.actorLabel})`,
    ),
  ],
)

/** One staff notification per approved leave request. Modelled on `rota_publication_notice` (0081). */
export const leaveApprovalNotice = pgTable(
  'leave_approval_notice',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    leaveRequestId: uuid('leave_request_id')
      .notNull()
      .references(() => leaveRequest.id, { onDelete: 'restrict' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    templateKey: text('template_key').notNull(),
    outcome: text('outcome').notNull(),
    skippedReason: text('skipped_reason'),
    messageId: uuid('message_id').references(() => message.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('leave_approval_notice_once').on(t.leaveRequestId, t.employeeId),
    index('leave_approval_notice_request_idx').on(t.leaveRequestId),
    check('leave_approval_notice_outcome_is_known', sql`${t.outcome} in ('sent', 'skipped')`),
    check(
      'leave_approval_notice_skip_has_a_reason',
      sql`(${t.outcome} = 'skipped') = (${t.skippedReason} is not null)`,
    ),
    check(
      'leave_approval_notice_send_has_a_message',
      sql`(${t.outcome} = 'sent') = (${t.messageId} is not null)`,
    ),
    check(
      'leave_approval_notice_template_not_placeholder',
      sql`length(btrim(${t.templateKey})) > 0 and not is_placeholder_text(${t.templateKey})`,
    ),
  ],
)

/** An approved leave request withdrawn. Its presence is what makes an approval stop being live. */
export const leaveApprovalCancellation = pgTable(
  'leave_approval_cancellation',
  {
    leaveRequestId: uuid('leave_request_id')
      .primaryKey()
      .references(() => leaveRequest.id, { onDelete: 'restrict' }),
    cancelledBy: text('cancelled_by').notNull(),
    actorRole: text('actor_role').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'leave_approval_cancellation_reason_is_written',
      sql`length(btrim(${t.reason})) >= 8 and not is_placeholder_text(${t.reason})`,
    ),
    check(
      'leave_approval_cancellation_actor_is_written',
      sql`length(btrim(${t.cancelledBy})) > 0 and not is_placeholder_text(${t.cancelledBy})
       and length(btrim(${t.actorRole})) > 0`,
    ),
  ],
)

/**
 * One lockable row per trading date, and the only table here that carries no history.
 *
 * Two leave approvals for two DIFFERENT therapists on one day conflict on no row, so nothing in the schema
 * serialises them. `approveLeaveRequest` takes `select ... for update` over these in ascending date order,
 * which is what makes the second approval a refusal from the coverage check rather than a race.
 */
export const leaveCoverageLock = pgTable('leave_coverage_lock', {
  /** No reference to `business_day`: it is generated and emptied by a suite, so a key would pin it. */
  tradingDate: date('trading_date').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

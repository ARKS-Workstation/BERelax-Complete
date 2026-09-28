import { AppError } from '@berelax/shared'
import type { Actor, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'

/**
 * Writing and approving a leave period, and the rows that say who decided it and what it cost.
 *
 * This module is the FIRST writer of `leave_request` in the build. 0030 created the table, left one decision
 * to P-HR — whether a leave day is aligned to the trading day or to the calendar day — and 0066 took it in
 * `leaveCoveragePeriod()`, saying in its own header that "writing and approving that period is P-HR-09's".
 * That is this file.
 *
 * ## What is injected, and why it has to be
 *
 * `packages/db` may never import `packages/core` (`pnpm boundaries`), and the two rules this transaction
 * cannot take without are both core's:
 *
 *   * the coverage delta — `coverageBreachesCausedBy`, which calls `validateRota` twice;
 *   * the decision — `decideLeaveApproval`, which holds the refusal order and the authority rules.
 *
 * So they arrive as {@link LeaveApprovalDeps}, and a caller that supplies neither is refused by name
 * (`coverage_not_evaluated`, `decision_not_taken`) rather than defaulting to yes. That is P-HR-04's shape and
 * for its reason: a rule that can be absent must fail closed, because the one thing worse than a refused
 * approval is an approval nothing judged.
 *
 * The **rows** those rules judge are read inside the transaction, which is what makes the concurrency line
 * true: see {@link approveLeaveRequest}.
 *
 * ## What this module never does
 *
 * It writes no `appointment` column and no `appointment_status_history` row. A conflict is resolved by
 * calling P-HR-04's `reassignAppointment` — a different transaction, a different module — or by recording a
 * `leave_conflict_override`. No statement here can cancel a booking, which is the boundary ADR 0041 records
 * and which `packages/fixtures/src/hr-leave-approval.test.ts` asserts out of the SOURCE rather than out of a
 * list somebody typed.
 *
 * It writes no `leave_movement` row either, in either direction. 0066: "a request reserves when it is made
 * and approval only makes the reservation final, so an approval writes no row", and the cancellation's
 * `released` row is the reversal of a reservation the submission path makes. That path is P-HR-14's, so this
 * unit writes neither half — symmetrically, because a release with no reservation creates leave out of
 * nothing, which `decideRequest` in `@berelax/core` refuses.
 */

/** Every reason an approval or a cancellation is refused from this module, as a value. */
export const LEAVE_REQUEST_REFUSALS = [
  /** No leave request with that id. */
  'leave_request_not_found',
  /** No coverage rule was injected, so nothing judged the floor. Fail closed. */
  'coverage_not_evaluated',
  /** No decision rule was injected, so nothing judged the authority. Fail closed. */
  'decision_not_taken',
  /** The injected decision refused. Carries the core refusal in `details.leaveRefusal`. */
  'approval_refused',
  /** The request is not approved, so there is no approval to withdraw. */
  'not_approved',
  /** This request's approval has already been withdrawn. */
  'already_withdrawn',
  /** The status UPDATE matched no row, which means somebody else decided it first. */
  'decided_concurrently',
  /** The outbox already held this event, so the approval would commit with nothing announced. */
  'event_not_enqueued',
  /** The appointment named is not one this leave overlaps, so there is no conflict to override. */
  'not_a_conflict',
] as const

export type LeaveRequestRefusal = (typeof LEAVE_REQUEST_REFUSALS)[number]

const refusal = (
  kind: 'conflict' | 'validation' | 'forbidden' | 'not_found' | 'invariant_violated',
  name: LeaveRequestRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

/** The refusal an error carries, or `null`. Lets a caller branch without matching on a message. */
export function leaveRequestRefusalOf(err: unknown): LeaveRequestRefusal | null {
  const name = err instanceof AppError ? err.details['refusal'] : undefined
  return LEAVE_REQUEST_REFUSALS.includes(name as LeaveRequestRefusal)
    ? (name as LeaveRequestRefusal)
    : null
}

// ---------------------------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------------------------

/** One `leave_request` row, with its period as epoch milliseconds so core can compare instants. */
export interface LeaveRequestRow {
  readonly id: string
  readonly employeeId: string
  readonly kind: string
  readonly status: string
  readonly startsAt: number
  readonly endsAt: number
  readonly decidedAt: Date | null
  readonly reason: string | null
}

interface RequestQueryRow {
  readonly id: string
  readonly employeeId: string
  readonly kind: string
  readonly status: string
  readonly startsAtText: string
  readonly endsAtText: string
  readonly decidedAt: Date | null
  readonly reason: string | null
}

/**
 * Epoch milliseconds out of a `timestamptz`, through a STRING.
 *
 * `extract(epoch from …)` is `numeric`, and postgres.js hands a numeric back as a string rather than as a
 * number because a numeric does not fit a double in general. Reading it as a number without saying so is how
 * a period silently becomes `NaN`, and `NaN < NaN` is false — so every containment test would answer "not
 * inside" and the conflict report would come back empty with nothing wrong on the face of it.
 */
const asInstant = (text: string): number => {
  const value = Number(text)
  if (!Number.isFinite(value)) {
    throw new AppError(
      'invariant_violated',
      `A leave period bound read back as ${text}, which is not a finite instant. postgres.js returns a ` +
        'numeric as a string; reading one as a number without checking turns a period into NaN, and every ' +
        'containment test then answers "not inside" with the report coming back empty.',
    )
  }
  return value
}

const asRequest = (row: RequestQueryRow): LeaveRequestRow => ({
  id: row.id,
  employeeId: row.employeeId,
  kind: row.kind,
  status: row.status,
  startsAt: asInstant(row.startsAtText),
  endsAt: asInstant(row.endsAtText),
  decidedAt: row.decidedAt,
  reason: row.reason,
})

export interface WriteLeaveRequestInput {
  readonly employeeId: string
  /** One of 0030's `leave_kind` values. Refused by the enum, so it is not re-validated here. */
  readonly kind: string
  /**
   * The period, in epoch milliseconds, from `leaveCoveragePeriod()` in `@berelax/core`.
   *
   * Instants and not dates, and computed by the caller rather than here. This package cannot import the
   * function that decides where a trading day ends, and re-deriving the bounds in SQL would be the second
   * reading 0066's header refuses: `resolveTradingDate` is the one.
   */
  readonly startsAt: number
  readonly endsAt: number
  readonly reason?: string
}

/**
 * Writes a pending leave request over the instants the caller computed.
 *
 * Pending, always. A row inserted as `approved` would skip every rule in {@link approveLeaveRequest} —
 * the authority, the conflict report, the coverage delta — and `leave_request_decision_has_an_instant`
 * would be satisfied by a `decided_at` nobody decided at. `leave_request.status` DEFAULTs to pending
 * (0030) and this statement does not name the column, so there is no parameter to get wrong.
 */
export async function writeLeaveRequest(
  sql: Sql,
  input: WriteLeaveRequestInput,
): Promise<LeaveRequestRow> {
  const [row] = await sql<RequestQueryRow[]>`
    insert into leave_request (employee_id, period, kind, reason)
    values (
      ${input.employeeId}::uuid,
      tstzrange(
        to_timestamp(${input.startsAt} / 1000.0),
        to_timestamp(${input.endsAt} / 1000.0),
        '[)'
      ),
      ${input.kind}::leave_kind,
      ${input.reason ?? null}
    )
    returning id::text          as "id",
              employee_id::text as "employeeId",
              kind::text        as "kind",
              status::text      as "status",
              (extract(epoch from lower(period)) * 1000)::bigint::text as "startsAtText",
              (extract(epoch from upper(period)) * 1000)::bigint::text as "endsAtText",
              decided_at        as "decidedAt",
              reason            as "reason"
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The leave request insert returned no row')
  }
  return asRequest(row)
}

/** One request, or null. `forUpdate` takes the row lock the approval needs. */
export async function readLeaveRequest(
  sql: Sql,
  id: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<LeaveRequestRow | null> {
  // Both statements are written out in full rather than assembled from a shared string. postgres.js
  // interpolates a VALUE and not a fragment, so a column list spliced in through `sql.unsafe` would be a
  // different mechanism from the one every other query in this package uses — and `for update` is one word.
  const rows =
    options.forUpdate === true
      ? await sql<RequestQueryRow[]>`
          select id::text          as "id",
                 employee_id::text as "employeeId",
                 kind::text        as "kind",
                 status::text      as "status",
                 (extract(epoch from lower(period)) * 1000)::bigint::text as "startsAtText",
                 (extract(epoch from upper(period)) * 1000)::bigint::text as "endsAtText",
                 decided_at        as "decidedAt",
                 reason            as "reason"
            from leave_request
           where id = ${id}::uuid
             for update
        `
      : await sql<RequestQueryRow[]>`
          select id::text          as "id",
                 employee_id::text as "employeeId",
                 kind::text        as "kind",
                 status::text      as "status",
                 (extract(epoch from lower(period)) * 1000)::bigint::text as "startsAtText",
                 (extract(epoch from upper(period)) * 1000)::bigint::text as "endsAtText",
                 decided_at        as "decidedAt",
                 reason            as "reason"
            from leave_request
           where id = ${id}::uuid
        `
  const row = rows[0]
  return row === undefined ? null : asRequest(row)
}

/**
 * Every trading date whose session overlaps a period, ascending.
 *
 * THE definition, and not a derivation of it. `business_day` is the materialised calendar — one row per
 * trading date with its own `opens_at` and `closes_at` — so "which trading dates does this period touch" is a
 * range overlap against those rows and nothing else. The first version of this read computed it from the
 * period's own instants in TypeScript, stepping back an hour from the upper bound and testing the hour to
 * decide whether a post-midnight instant belonged to the previous session; that is a second reading of
 * `resolveTradingDate`, it disagrees with the first the moment a Ramadan override moves the close, and it is
 * the defect this whole build keeps finding. The calendar answers the question directly.
 *
 * Empty means the period covers no trading date at all, which a caller must treat as "cannot be judged"
 * rather than as "no breach": the coverage grid comes from the window, so an absent day is silently uncovered
 * by every rule.
 */
export async function readTradingDatesCovering(
  sql: Sql,
  period: { readonly startsAt: number; readonly endsAt: number },
): Promise<readonly string[]> {
  const rows = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate"
      from business_day
     where tstzrange(opens_at, closes_at, '[)') && tstzrange(
             to_timestamp(${period.startsAt} / 1000.0),
             to_timestamp(${period.endsAt} / 1000.0),
             '[)'
           )
     order by trading_date
  `
  return rows.map((row) => row.tradingDate)
}

// ---------------------------------------------------------------------------------------------
// The conflict report
// ---------------------------------------------------------------------------------------------

/** One appointment overlapping the leave, with the five facts the acceptance line names. */
export interface LeaveConflictRow {
  readonly appointmentId: string
  readonly bookingId: string
  readonly customerId: string
  /**
   * `customer.display_name`, or null when nobody has recorded one.
   *
   * Null rather than a manufactured label, which is brief rule 15 applied to a person: `Customer 0042` is
   * what `packages/fixtures/src/synthetic.ts` MINTS for a synthetic record, and a reader that generated the
   * same shape for a real row would make an invented label indistinguishable from a recorded one. The screen
   * says "no name recorded" and prints the id, which is the only handle the database holds.
   */
  readonly customerDisplayName: string | null
  readonly serviceVariantId: string
  readonly serviceLabel: string
  readonly roomId: string
  readonly roomCode: string
  readonly therapistId: string
  /** `employee.staff_reference` — "Therapist 07" — for the same reason the queue uses it. */
  readonly therapistReference: string
  readonly startsAt: Date
  readonly tradingDate: string
  readonly status: string
  readonly resolution: 'unresolved' | 'reassigned' | 'overridden'
}

/**
 * Every appointment this leave overlaps, with what has been decided about each.
 *
 * Four decisions are in this query, and each one is a way the report could have been wrong:
 *
 *   1. **`&&` against the request's own period**, so the 01:30 appointment in the session tail is IN. The
 *      period came from `leaveCoveragePeriod`, so this is a comparison and not a second alignment rule — and
 *      it is the whole reason the acceptance line about 01:30 is a claim about a stored period rather than
 *      about a query.
 *   2. **`holds_resources`**, which is generated from the status (0024). An appointment already cancelled or
 *      rescheduled holds no therapist, so it is not a conflict — and listing it would put a cancelled booking
 *      on a manager's screen as something to resolve.
 *   3. **The therapist is the one going on leave.** Another therapist's appointment in the same period is not
 *      this leave's problem. Without this the report would list the whole diary.
 *   4. **`resolution` is DERIVED, never asserted by a caller**, and the `reassigned` arm is read out of
 *      P-HR-04's own record rather than inferred. A reassignment moves the appointment off the therapist, so
 *      the row stops satisfying (3) and would simply VANISH from the report — which is what the first version
 *      of this query did, and it made `reassigned` a label nothing could produce and
 *      `leave_approval.conflicts_reassigned` a figure that was always zero. The row is therefore kept in the
 *      report when an `appointment_status_history` row exists for it carrying `from_therapist_id` = the
 *      employee on leave and `reason = 'leave_approved'` — the row `reassignAppointment` writes through the
 *      0065 trigger, with the reason P-HR-04 reserved for this unit ("leave_approved belongs to P-HR-09").
 *      Reading it means the resolution is evidenced by the audit trail rather than by an absence.
 *
 *      `overridden` means a `leave_conflict_override` row exists for this (request, appointment). Anything
 *      else is `unresolved`. The three arms are ordered so an appointment that was reassigned AND overridden
 *      reads as reassigned, which is the stronger resolution: the therapist is no longer on it at all.
 *
 * `appointmentIds` narrows the report, which is how a test asserts about its own rows without depending on
 * what earlier files in the integration suite left behind (brief rule 12).
 */
export async function readLeaveApprovalConflicts(
  sql: Sql,
  args: { readonly leaveRequestId: string; readonly appointmentIds?: readonly string[] },
): Promise<readonly LeaveConflictRow[]> {
  // `null` rather than an empty array for "every appointment": `= any(array[]::uuid[])` is false for every
  // row, so an empty array would silently mean "nothing" where the caller meant "everything".
  const narrowed = args.appointmentIds === undefined ? null : [...args.appointmentIds]
  return sql<LeaveConflictRow[]>`
    with request as (
      select id, employee_id, period from leave_request where id = ${args.leaveRequestId}::uuid
    )
    select a.id::text                 as "appointmentId",
           a.booking_id::text         as "bookingId",
           b.customer_id::text        as "customerId",
           c.display_name             as "customerDisplayName",
           a.service_variant_id::text as "serviceVariantId",
           s.style::text || ' / ' || s.treatment_key::text as "serviceLabel",
           a.room_id::text            as "roomId",
           r.code                     as "roomCode",
           a.therapist_id::text       as "therapistId",
           e.staff_reference          as "therapistReference",
           lower(a.period)            as "startsAt",
           a.trading_date::text       as "tradingDate",
           a.status::text             as status,
           case
             when exists (
               select 1 from appointment_status_history h
                where h.appointment_id = a.id
                  and h.from_therapist_id = request.employee_id
                  and h.reason = 'leave_approved'
             ) then 'reassigned'
             when exists (
               select 1 from leave_conflict_override o
                where o.leave_request_id = request.id and o.appointment_id = a.id
             ) then 'overridden'
             else 'unresolved'
           end                        as resolution
      from request
      join appointment a on a.period && request.period and a.holds_resources
      join booking b on b.id = a.booking_id
      join customer c on c.id = b.customer_id
      join service_variant v on v.id = a.service_variant_id
      join service s on s.id = v.service_id
      join rooms r on r.id = a.room_id
      join employee e on e.id = a.therapist_id
     where (
             a.therapist_id = request.employee_id
             or exists (
               select 1 from leave_conflict_override o
                where o.leave_request_id = request.id and o.appointment_id = a.id
             )
             or exists (
               select 1 from appointment_status_history h
                where h.appointment_id = a.id
                  and h.from_therapist_id = request.employee_id
                  and h.reason = 'leave_approved'
             )
           )
       and (${narrowed}::uuid[] is null or a.id = any(${narrowed}::uuid[]))
     order by lower(a.period), a.id
  `
}

// ---------------------------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------------------------

export interface LeaveDelegationRow {
  readonly id: string
  readonly delegatorEmployeeId: string
  readonly deputyEmployeeId: string
  readonly startsAt: number
  readonly endsAt: number
  readonly revokedAt: number | null
  readonly reason: string
}

interface DelegationQueryRow {
  readonly id: string
  readonly delegatorEmployeeId: string
  readonly deputyEmployeeId: string
  readonly startsAtText: string
  readonly endsAtText: string
  readonly revokedAtText: string | null
  readonly reason: string
}

const asDelegation = (row: DelegationQueryRow): LeaveDelegationRow => ({
  id: row.id,
  delegatorEmployeeId: row.delegatorEmployeeId,
  deputyEmployeeId: row.deputyEmployeeId,
  startsAt: asInstant(row.startsAtText),
  endsAt: asInstant(row.endsAtText),
  revokedAt: row.revokedAtText === null ? null : asInstant(row.revokedAtText),
  reason: row.reason,
})

export interface WriteLeaveDelegationInput {
  readonly delegatorEmployeeId: string
  readonly deputyEmployeeId: string
  readonly startsAt: number
  readonly endsAt: number
  readonly reason: string
  readonly createdBy: string
}

export async function writeLeaveApprovalDelegation(
  sql: Sql,
  input: WriteLeaveDelegationInput,
): Promise<LeaveDelegationRow> {
  const [row] = await sql<DelegationQueryRow[]>`
    insert into leave_approval_delegation
      (delegator_employee_id, deputy_employee_id, period, reason, created_by)
    values (
      ${input.delegatorEmployeeId}::uuid,
      ${input.deputyEmployeeId}::uuid,
      tstzrange(
        to_timestamp(${input.startsAt} / 1000.0),
        to_timestamp(${input.endsAt} / 1000.0),
        '[)'
      ),
      ${input.reason},
      ${input.createdBy}
    )
    returning id::text                    as "id",
              delegator_employee_id::text as "delegatorEmployeeId",
              deputy_employee_id::text    as "deputyEmployeeId",
              (extract(epoch from lower(period)) * 1000)::bigint::text as "startsAtText",
              (extract(epoch from upper(period)) * 1000)::bigint::text as "endsAtText",
              (extract(epoch from revoked_at) * 1000)::bigint::text    as "revokedAtText",
              reason
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The leave delegation insert returned no row')
  }
  return asDelegation(row)
}

/**
 * Every delegation naming this deputy, revoked ones included.
 *
 * Revoked ones included deliberately: the authority rule has to be able to tell "you are not a deputy" from
 * "your window has closed", and it cannot if the read has already dropped the row. `authoriseLeaveApproval`
 * in `@berelax/core` makes that distinction, and a read that filtered here would collapse the two refusals
 * into the one that tells a deputy to ask for a permission instead of asking for the window to be extended.
 */
export async function readLeaveApprovalDelegations(
  sql: Sql,
  args: { readonly deputyEmployeeId: string },
): Promise<readonly LeaveDelegationRow[]> {
  const rows = await sql<DelegationQueryRow[]>`
    select id::text                    as "id",
           delegator_employee_id::text as "delegatorEmployeeId",
           deputy_employee_id::text    as "deputyEmployeeId",
           (extract(epoch from lower(period)) * 1000)::bigint::text as "startsAtText",
           (extract(epoch from upper(period)) * 1000)::bigint::text as "endsAtText",
           (extract(epoch from revoked_at) * 1000)::bigint::text    as "revokedAtText",
           reason
      from leave_approval_delegation
     where deputy_employee_id = ${args.deputyEmployeeId}::uuid
     order by lower(period), id
  `
  return rows.map(asDelegation)
}

export async function revokeLeaveApprovalDelegation(
  sql: Sql,
  args: { readonly id: string; readonly reason: string },
): Promise<void> {
  await sql`
    update leave_approval_delegation
       set revoked_at = now(), revoked_reason = ${args.reason}
     where id = ${args.id}::uuid and revoked_at is null
  `
}

// ---------------------------------------------------------------------------------------------
// The floor, net of leave already approved
// ---------------------------------------------------------------------------------------------

/** One fragment of one employee's presence on one trading date, net of approved leave. */
export interface FloorPresenceRow {
  readonly employeeId: string
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
}

interface PresenceQueryRow {
  readonly employeeId: string
  readonly tradingDate: string
  readonly startsAtText: string
  readonly endsAtText: string
}

/**
 * The floor as the booking system can see it: rostered presence MINUS every approved leave that overlaps.
 *
 * The subtraction is PostgreSQL's multirange difference — `range_agg(shift.period) - range_agg(leave.period)`
 * — which is the same operator `tp_net` in `./eligibility.ts` uses for the same subtraction. That is the
 * point: there is one implementation of "presence net of leave" in the system, Postgres's own, so this answer
 * and the availability query's cannot drift apart on a boundary minute. A TypeScript re-implementation would
 * be the second statement, and it would be the one that disagreed.
 *
 * `employee_approved_leave`, never `leave_request`: a PENDING request must not take a therapist off the
 * floor, which is 0030's reason for the view existing at all. The request under decision is subtracted by the
 * CALLER — `coverageBreachesCausedBy` in `@berelax/core` — precisely because it is not approved yet, and
 * because subtracting it here would make the "before" and "after" halves of the delta the same read.
 */
export async function readFloorPresence(
  sql: Sql,
  args: { readonly fromTradingDate: string; readonly toTradingDate: string },
): Promise<readonly FloorPresenceRow[]> {
  const rows = await sql<PresenceQueryRow[]>`
    with day_span as (
      select trading_date, tstzrange(opens_at, closes_at, '[)') as span
        from business_day
       where trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
    ),
    rostered as (
      select sa.employee_id, s.trading_date, range_agg(s.period) as rostered
        from shift s
        join shift_assignment sa on sa.shift_id = s.id
       where s.trading_date between ${args.fromTradingDate}::date and ${args.toTradingDate}::date
       group by sa.employee_id, s.trading_date
    ),
    taken as (
      select r.employee_id, r.trading_date, range_agg(al.period) as leave
        from rostered r
        join day_span d on d.trading_date = r.trading_date
        join employee_approved_leave al
          on al.employee_id = r.employee_id and al.period && d.span
       group by r.employee_id, r.trading_date
    ),
    net as (
      select r.employee_id, r.trading_date,
             case when t.leave is null then r.rostered else r.rostered - t.leave end as net
        from rostered r
        left join taken t
          on t.employee_id = r.employee_id and t.trading_date = r.trading_date
    )
    select n.employee_id::text as "employeeId",
           n.trading_date::text as "tradingDate",
           (extract(epoch from lower(fragment)) * 1000)::bigint::text as "startsAtText",
           (extract(epoch from upper(fragment)) * 1000)::bigint::text as "endsAtText"
      from net n
      cross join lateral unnest(n.net) as fragment
     order by n.employee_id, n.trading_date, lower(fragment)
  `
  return rows.map((row) => ({
    employeeId: row.employeeId,
    tradingDate: row.tradingDate,
    startsAt: asInstant(row.startsAtText),
    endsAt: asInstant(row.endsAtText),
  }))
}

// ---------------------------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------------------------

export interface LeaveOverrideRow {
  readonly id: string
  readonly leaveRequestId: string
  readonly appointmentId: string
  readonly actorRole: string
  readonly actorLabel: string
  readonly reason: string
}

/**
 * Records that a human decided to leave one appointment standing inside the leave.
 *
 * Refused unless the appointment is actually one the leave overlaps. Without that check an override could be
 * recorded against any appointment at all, and `leave_approval.conflicts_overridden` would count decisions
 * about bookings nobody was asked about — while the approval still refused for the conflict that was real.
 *
 * The role and the reason are NOT validated here. Migration 0092's ZY002 refuses both, for every role and for
 * a `psql` session; `judgeLeaveConflictOverride` in `@berelax/core` is the layer that says which half is
 * wrong before a transaction is opened. A third copy in this function would be the one that drifts.
 */
export async function recordLeaveConflictOverride(
  sql: Sql,
  actor: Actor,
  input: {
    readonly leaveRequestId: string
    readonly appointmentId: string
    readonly actorRole: string
    readonly reason: string
  },
  context: RequestContext = {},
): Promise<LeaveOverrideRow> {
  return withUnitOfWork(
    sql,
    actor,
    async (uow) => {
      const [overlaps] = await uow.sql<{ ok: boolean }[]>`
        select exists (
          select 1
            from leave_request lr
            join appointment a on a.period && lr.period and a.holds_resources
           where lr.id = ${input.leaveRequestId}::uuid
             and a.id = ${input.appointmentId}::uuid
             and a.therapist_id = lr.employee_id
        ) as ok
      `
      if (overlaps?.ok !== true) {
        throw refusal(
          'validation',
          'not_a_conflict',
          `appointment ${input.appointmentId} is not an appointment leave request ` +
            `${input.leaveRequestId} overlaps for that therapist, so there is no conflict to override. ` +
            'An override recorded against another booking would be counted by the approval while the ' +
            'real conflict stayed unresolved.',
          { appointmentId: input.appointmentId, leaveRequestId: input.leaveRequestId },
        )
      }
      const [row] = await uow.sql<LeaveOverrideRow[]>`
        insert into leave_conflict_override
          (leave_request_id, appointment_id, actor_role, actor_label, reason)
        values (
          ${input.leaveRequestId}::uuid, ${input.appointmentId}::uuid,
          ${input.actorRole}, ${actor.label ?? input.actorRole}, ${input.reason}
        )
        returning id::text               as "id",
                  leave_request_id::text as "leaveRequestId",
                  appointment_id::text   as "appointmentId",
                  actor_role             as "actorRole",
                  actor_label            as "actorLabel",
                  reason
      `
      if (row === undefined) {
        throw new AppError(
          'invariant_violated',
          'The leave conflict override insert returned no row',
        )
      }
      await uow.audit.record({
        action: 'hr.leave.conflict_overridden',
        entityType: 'leave_request',
        entityId: input.leaveRequestId,
        operation: 'create',
        after: {
          appointmentId: input.appointmentId,
          actorRole: input.actorRole,
          reason: input.reason,
        },
      })
      return row
    },
    context,
  )
}

// ---------------------------------------------------------------------------------------------
// The approval
// ---------------------------------------------------------------------------------------------

/** Core's coverage delta, as this transaction's injected dependency. */
export interface LeaveCoverageInput {
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly employeeId: string
  readonly period: { readonly startsAt: number; readonly endsAt: number }
  readonly presence: readonly FloorPresenceRow[]
}

export interface LeaveCoverageAnswer {
  /** One line per segment the approval would break, already worded for a refusal. */
  readonly causedDescriptions: readonly string[]
  /** Machine-readable, for a screen and for an assertion. */
  readonly caused: readonly {
    readonly rule: string
    readonly tradingDate: string
    readonly segmentLabel: string
    readonly segmentIndex: number
  }[]
  readonly presenceFragmentsAffected: number
  /** The `rota_coverage_rule` version that judged it, stored on the approval. */
  readonly coverageRuleEffectiveFrom: string
}

export type LeaveCoverageRule = (input: LeaveCoverageInput) => Promise<LeaveCoverageAnswer>

export interface LeaveDecisionInput {
  readonly request: LeaveRequestRow
  readonly approver: { readonly employeeId: string; readonly role: string }
  readonly delegations: readonly LeaveDelegationRow[]
  readonly at: number
  readonly conflicts: readonly LeaveConflictRow[]
  readonly coverage: LeaveCoverageAnswer
}

export type LeaveDecisionAnswer =
  | {
      readonly kind: 'approve'
      readonly approvedVia: 'own_authority' | 'delegation'
      readonly delegationId: string | null
      readonly conflictsOverridden: number
      readonly conflictsReassigned: number
    }
  | { readonly kind: 'refused'; readonly refusal: string; readonly why: string }

export type LeaveDecisionRule = (input: LeaveDecisionInput) => LeaveDecisionAnswer

export interface LeaveApprovalDeps {
  readonly coverage: LeaveCoverageRule
  readonly decide: LeaveDecisionRule
}

export interface ApproveLeaveInput {
  readonly leaveRequestId: string
  readonly approver: { readonly employeeId: string; readonly role: string }
  /** The trading dates the leave covers, from the caller's own reading of the period. */
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly notificationTemplateKey: string
}

export interface ApprovedLeave {
  readonly leaveRequestId: string
  readonly employeeId: string
  readonly approvedVia: 'own_authority' | 'delegation'
  readonly delegationId: string | null
  readonly coverageRuleEffectiveFrom: string
  readonly conflictsOverridden: number
  readonly conflictsReassigned: number
  readonly decidedAt: Date
  readonly noticeId: string
  readonly noticeOutcome: string
  readonly eventId: string
}

/**
 * Approves a leave request, or refuses it — in one transaction, with the coverage check inside it.
 *
 * ## Why the lock, and what it makes true
 *
 * Two approvals for two DIFFERENT therapists on one trading date conflict on no row. Without a lock both
 * transactions read a floor that still holds the other therapist, both coverage deltas come back empty, and
 * the floor ends up one short with every check having said yes. `leave_request_no_overlapping_approved` cannot
 * catch it — it is per employee — and neither can any constraint, because the fact being broken is a COUNT
 * over other people's rows.
 *
 * So the first statement in the transaction takes `select ... for update` over one `leave_coverage_lock` row
 * per trading date, in ascending date order. The second approval BLOCKS there until the first commits, then
 * reads the floor WITH the first leave subtracted — `readFloorPresence` reads `employee_approved_leave`, so
 * the first approval is visible the instant it commits — and its coverage check refuses. That is the
 * acceptance line's own wording: *refused by the coverage check inside the transaction, not left to a race.*
 *
 * Ascending order because two transactions taking two dates in opposite orders deadlock, and a deadlock is
 * reported as a 40P01 that names neither leave request.
 *
 * ## Why the refusal is a THROW and the row is read back
 *
 * A refusal must not commit anything, and the cheapest way to be sure of that is to leave the transaction by
 * throwing: `sql.begin` rolls back. A returned status would leave the caller to decide, and the caller that
 * forgets is the one that writes the notice. Every test asserts the non-commit by reading `leave_request`
 * back rather than by trusting what came out of here.
 */
export async function approveLeaveRequest(
  sql: Sql,
  actor: Actor,
  input: ApproveLeaveInput,
  deps: LeaveApprovalDeps,
  context: RequestContext = {},
): Promise<ApprovedLeave> {
  if (typeof deps?.coverage !== 'function') {
    throw refusal(
      'invariant_violated',
      'coverage_not_evaluated',
      'no coverage rule was injected, so nothing would have judged the floor. `packages/db` may not ' +
        'import `packages/core`, so `coverageBreachesCausedBy` arrives as a dependency — and an absent ' +
        'one fails closed rather than approving.',
    )
  }
  if (typeof deps?.decide !== 'function') {
    throw refusal(
      'invariant_violated',
      'decision_not_taken',
      'no decision rule was injected, so nothing would have judged the approver’s authority. Fail ' +
        'closed: an approval nothing judged is worse than a refused one.',
    )
  }

  return withUnitOfWork(
    sql,
    actor,
    async (uow) => {
      await lockCoverageDates(uow, input.fromTradingDate, input.toTradingDate)

      const request = await readLeaveRequest(uow.sql, input.leaveRequestId, { forUpdate: true })
      if (request === null) {
        throw refusal(
          'not_found',
          'leave_request_not_found',
          `no leave request ${input.leaveRequestId}`,
          { leaveRequestId: input.leaveRequestId },
        )
      }

      const [delegations, conflicts, presence] = await Promise.all([
        readLeaveApprovalDelegations(uow.sql, {
          deputyEmployeeId: input.approver.employeeId,
        }),
        readLeaveApprovalConflicts(uow.sql, { leaveRequestId: input.leaveRequestId }),
        readFloorPresence(uow.sql, {
          fromTradingDate: input.fromTradingDate,
          toTradingDate: input.toTradingDate,
        }),
      ])

      const coverage = await deps.coverage({
        fromTradingDate: input.fromTradingDate,
        toTradingDate: input.toTradingDate,
        employeeId: request.employeeId,
        period: { startsAt: request.startsAt, endsAt: request.endsAt },
        presence,
      })

      // `now()` and not a clock in this module: the decision instant is the transaction's, and the same
      // value is what `decided_at` DEFAULTs to, so the delegation window the rule judged and the window
      // 0092's ZY004 judges are the same instant rather than two readings a few milliseconds apart.
      const [clock] = await uow.sql<{ atText: string }[]>`
        select (extract(epoch from now()) * 1000)::bigint::text as "atText"
      `
      const at = asInstant((clock as { atText: string }).atText)

      const decision = deps.decide({
        request,
        approver: input.approver,
        delegations,
        at,
        conflicts,
        coverage,
      })
      if (decision.kind === 'refused') {
        throw refusal(
          decision.refusal === 'approver_not_authorised' ||
            decision.refusal === 'delegation_not_in_window'
            ? 'forbidden'
            : 'conflict',
          'approval_refused',
          decision.why,
          {
            leaveRefusal: decision.refusal,
            leaveRequestId: input.leaveRequestId,
            unresolvedConflicts: conflicts
              .filter((row) => row.resolution === 'unresolved')
              .map((row) => row.appointmentId),
            breachedSegments: coverage.caused.map((row) => row.segmentLabel),
          },
        )
      }

      // The status and the record are two statements of one decision, which is why 0092's ZY005 refuses an
      // approval row whose request is not approved: the UPDATE has to land first, and a row that did not
      // match means somebody else decided it between the lock and here.
      const updated = await uow.sql<{ id: string }[]>`
        update leave_request
           set status = 'approved', decided_at = now()
         where id = ${input.leaveRequestId}::uuid and status = 'pending'
        returning id
      `
      if (updated.length !== 1) {
        throw refusal(
          'conflict',
          'decided_concurrently',
          `leave request ${input.leaveRequestId} was decided by somebody else between the coverage lock ` +
            'and the update. Nothing is written: the approval this transaction judged was about a ' +
            'pending request, and that is no longer what this row is.',
          { leaveRequestId: input.leaveRequestId },
        )
      }

      const [approval] = await uow.sql<{ decidedAt: Date }[]>`
        insert into leave_approval (
          leave_request_id, approved_by_employee_id, approver_role, approved_via, delegation_id,
          coverage_rule_effective_from, period, conflicts_overridden, conflicts_reassigned
        )
        select ${input.leaveRequestId}::uuid, ${input.approver.employeeId}::uuid,
               ${input.approver.role}, ${decision.approvedVia}, ${decision.delegationId}::uuid,
               ${coverage.coverageRuleEffectiveFrom}::date, lr.period,
               ${decision.conflictsOverridden}, ${decision.conflictsReassigned}
          from leave_request lr where lr.id = ${input.leaveRequestId}::uuid
        returning decided_at as "decidedAt"
      `
      if (approval === undefined) {
        throw new AppError('invariant_violated', 'The leave approval insert returned no row')
      }

      // One notice, to the employee whose leave it is. `skipped` with a reason rather than nothing, for
      // `rota_publication_notice`'s reason (0081): every seeded employee has no recipient on file, and a
      // notice table that recorded nothing would be indistinguishable from a notification path that does
      // not exist. The send itself is P-HR-14's — the staff notification set is its acceptance line — and
      // `message_id` is the column that path fills in.
      const [notice] = await uow.sql<{ id: string; outcome: string }[]>`
        insert into leave_approval_notice
          (leave_request_id, employee_id, template_key, outcome, skipped_reason)
        values (
          ${input.leaveRequestId}::uuid, ${request.employeeId}::uuid,
          ${input.notificationTemplateKey}, 'skipped', 'no_recipient_on_file'
        )
        returning id::text as id, outcome
      `
      if (notice === undefined) {
        throw new AppError('invariant_violated', 'The leave approval notice insert returned no row')
      }

      // Keyed on the ROW ID, never on a display number: `outbox_event.idempotency_key` is unique and
      // `publishEvent` resolves a collision with `on conflict do nothing`, so a key that can repeat drops
      // the second event silently. `packages/db/src/outbox-keys.test.ts` enforces it tree-wide.
      const eventId = await uow.publish({
        eventType: 'leave.approved',
        aggregateType: 'leave_request',
        aggregateId: input.leaveRequestId,
        idempotencyKey: `leave.approved:${input.leaveRequestId}`,
        payload: {
          leaveRequestId: input.leaveRequestId,
          employeeId: request.employeeId,
          kind: request.kind,
          startsAt: new Date(request.startsAt).toISOString(),
          endsAt: new Date(request.endsAt).toISOString(),
          approvedByEmployeeId: input.approver.employeeId,
          approverRole: input.approver.role,
          approvedVia: decision.approvedVia,
          conflictsOverridden: decision.conflictsOverridden,
          conflictsReassigned: decision.conflictsReassigned,
          coverageRuleEffectiveFrom: coverage.coverageRuleEffectiveFrom,
        },
      })
      if (eventId === null) {
        throw refusal(
          'conflict',
          'event_not_enqueued',
          `the outbox already holds leave.approved for ${input.leaveRequestId}, so this approval would ` +
            'commit with nothing announced. The key is the row id, so a collision means the request was ' +
            'already approved once.',
          { leaveRequestId: input.leaveRequestId },
        )
      }

      await uow.audit.record({
        action: 'hr.leave.approved',
        entityType: 'leave_request',
        entityId: input.leaveRequestId,
        operation: 'update',
        before: { status: 'pending' },
        after: {
          status: 'approved',
          employeeId: request.employeeId,
          approvedByEmployeeId: input.approver.employeeId,
          approverRole: input.approver.role,
          approvedVia: decision.approvedVia,
          delegationId: decision.delegationId,
          coverageRuleEffectiveFrom: coverage.coverageRuleEffectiveFrom,
          conflictsOverridden: decision.conflictsOverridden,
          conflictsReassigned: decision.conflictsReassigned,
          coveragePresenceFragmentsAffected: coverage.presenceFragmentsAffected,
        },
      })

      return {
        leaveRequestId: input.leaveRequestId,
        employeeId: request.employeeId,
        approvedVia: decision.approvedVia,
        delegationId: decision.delegationId,
        coverageRuleEffectiveFrom: coverage.coverageRuleEffectiveFrom,
        conflictsOverridden: decision.conflictsOverridden,
        conflictsReassigned: decision.conflictsReassigned,
        decidedAt: approval.decidedAt,
        noticeId: notice.id,
        noticeOutcome: notice.outcome,
        eventId,
      }
    },
    context,
  )
}

/**
 * One lockable row per trading date the leave touches, created on demand and taken in ascending order.
 *
 * `on conflict do nothing` then `for update`, rather than an upsert that returns the row: the insert is only
 * there so the first approval of a date does not find nothing to lock, and two transactions inserting the
 * same date are settled by the primary key with neither of them raising.
 */
async function lockCoverageDates(
  uow: UnitOfWork,
  fromTradingDate: string,
  toTradingDate: string,
): Promise<void> {
  await uow.sql`
    insert into leave_coverage_lock (trading_date)
    select d::date
      from generate_series(${fromTradingDate}::date, ${toTradingDate}::date, interval '1 day') as d
    on conflict (trading_date) do nothing
  `
  await uow.sql`
    select trading_date
      from leave_coverage_lock
     where trading_date between ${fromTradingDate}::date and ${toTradingDate}::date
     order by trading_date
       for update
  `
}

// ---------------------------------------------------------------------------------------------
// Withdrawing an approval
// ---------------------------------------------------------------------------------------------

export interface CancelApprovedLeaveInput {
  readonly leaveRequestId: string
  readonly actorRole: string
  readonly reason: string
}

export interface CancelledLeave {
  readonly leaveRequestId: string
  readonly employeeId: string
  readonly eventId: string
}

/**
 * Withdraws an approved leave request, and clears what the approval created.
 *
 * Two halves, and both are asserted by the round-trip test rather than assumed:
 *
 *   * **Availability comes back.** `leave_request.status = 'cancelled'` takes the row out of
 *     `employee_approved_leave`, which is the only thing the availability query reads — so the therapist is
 *     bookable again with nothing else touched. Nothing here writes to `shift`, and nothing re-inserts a
 *     roster, because the roster was never changed.
 *   * **The approval stops being live.** The `leave_approval_cancellation` row is what
 *     `leave_approval_live` excludes on, so the coverage version, the authority and the override counts stop
 *     being asserted about a leave nobody is taking. `leave_approval` itself is append-only, which is why
 *     this is a row rather than a column.
 *
 * `leave_approval_notice` is deliberately NOT cleared: a notification that was sent cannot be unsent, and a
 * record of it that disappeared would make "was she told?" unanswerable — which is the question asked after
 * somebody turns up for a shift they thought they were off for.
 */
export async function cancelApprovedLeave(
  sql: Sql,
  actor: Actor,
  input: CancelApprovedLeaveInput,
  context: RequestContext = {},
): Promise<CancelledLeave> {
  return withUnitOfWork(
    sql,
    actor,
    async (uow) => {
      const request = await readLeaveRequest(uow.sql, input.leaveRequestId, { forUpdate: true })
      if (request === null) {
        throw refusal(
          'not_found',
          'leave_request_not_found',
          `no leave request ${input.leaveRequestId}`,
          { leaveRequestId: input.leaveRequestId },
        )
      }
      if (request.status !== 'approved') {
        throw refusal(
          'conflict',
          'not_approved',
          `leave request ${input.leaveRequestId} is ${request.status}, so there is no approval to ` +
            'withdraw. Cancelling a pending request is a different decision and a different row.',
          { leaveRequestId: input.leaveRequestId, status: request.status },
        )
      }
      const [live] = await uow.sql<{ ok: boolean }[]>`
        select exists (
          select 1 from leave_approval_live where leave_request_id = ${input.leaveRequestId}::uuid
        ) as ok
      `
      if (live?.ok !== true) {
        throw refusal(
          'conflict',
          'already_withdrawn',
          `the approval of leave request ${input.leaveRequestId} is not live. A second withdrawal would ` +
            'be refused by the primary key with nothing saying why.',
          { leaveRequestId: input.leaveRequestId },
        )
      }

      await uow.sql`
        update leave_request set status = 'cancelled' where id = ${input.leaveRequestId}::uuid
      `
      await uow.sql`
        insert into leave_approval_cancellation (leave_request_id, cancelled_by, actor_role, reason)
        values (
          ${input.leaveRequestId}::uuid, ${actor.label ?? input.actorRole}, ${input.actorRole},
          ${input.reason}
        )
      `

      const eventId = await uow.publish({
        eventType: 'leave.approval_cancelled',
        aggregateType: 'leave_request',
        aggregateId: input.leaveRequestId,
        idempotencyKey: `leave.approval_cancelled:${input.leaveRequestId}`,
        payload: {
          leaveRequestId: input.leaveRequestId,
          employeeId: request.employeeId,
          reason: input.reason,
        },
      })
      if (eventId === null) {
        throw refusal(
          'conflict',
          'event_not_enqueued',
          `the outbox already holds leave.approval_cancelled for ${input.leaveRequestId}`,
          { leaveRequestId: input.leaveRequestId },
        )
      }

      await uow.audit.record({
        action: 'hr.leave.approval_cancelled',
        entityType: 'leave_request',
        entityId: input.leaveRequestId,
        operation: 'update',
        before: { status: 'approved' },
        after: { status: 'cancelled', reason: input.reason, actorRole: input.actorRole },
      })

      return { leaveRequestId: input.leaveRequestId, employeeId: request.employeeId, eventId }
    },
    context,
  )
}

/** One live approval, or null. Reads the VIEW, so the cancellation predicate cannot be forgotten. */
export async function readLiveLeaveApproval(
  sql: Sql,
  leaveRequestId: string,
): Promise<{
  readonly leaveRequestId: string
  readonly approvedByEmployeeId: string
  readonly approverRole: string
  readonly approvedVia: string
  readonly delegationId: string | null
  readonly coverageRuleEffectiveFrom: string
  readonly conflictsOverridden: number
  readonly conflictsReassigned: number
  readonly decidedAt: Date
} | null> {
  const [row] = await sql<
    {
      leaveRequestId: string
      approvedByEmployeeId: string
      approverRole: string
      approvedVia: string
      delegationId: string | null
      coverageRuleEffectiveFrom: string
      conflictsOverridden: number
      conflictsReassigned: number
      decidedAt: Date
    }[]
  >`
    select leave_request_id::text              as "leaveRequestId",
           approved_by_employee_id::text       as "approvedByEmployeeId",
           approver_role                       as "approverRole",
           approved_via                        as "approvedVia",
           delegation_id::text                 as "delegationId",
           coverage_rule_effective_from::text  as "coverageRuleEffectiveFrom",
           conflicts_overridden                as "conflictsOverridden",
           conflicts_reassigned                as "conflictsReassigned",
           decided_at                          as "decidedAt"
      from leave_approval_live
     where leave_request_id = ${leaveRequestId}::uuid
  `
  return row ?? null
}

/** Every live override for one request, through the same view, so a withdrawn approval clears them. */
export async function readLiveLeaveConflictOverrides(
  sql: Sql,
  leaveRequestId: string,
): Promise<readonly LeaveOverrideRow[]> {
  return sql<LeaveOverrideRow[]>`
    select o.id::text               as "id",
           o.leave_request_id::text as "leaveRequestId",
           o.appointment_id::text   as "appointmentId",
           o.actor_role             as "actorRole",
           o.actor_label            as "actorLabel",
           o.reason
      from leave_conflict_override o
      join leave_approval_live a on a.leave_request_id = o.leave_request_id
     where o.leave_request_id = ${leaveRequestId}::uuid
     order by o.id
  `
}

/** Every notice written for one request. Append-only, so this is the whole history. */
export async function readLeaveApprovalNotices(
  sql: Sql,
  leaveRequestId: string,
): Promise<
  readonly {
    readonly id: string
    readonly employeeId: string
    readonly templateKey: string
    readonly outcome: string
    readonly skippedReason: string | null
  }[]
> {
  return sql`
    select id::text          as "id",
           employee_id::text as "employeeId",
           template_key      as "templateKey",
           outcome,
           skipped_reason    as "skippedReason"
      from leave_approval_notice
     where leave_request_id = ${leaveRequestId}::uuid
     order by id
  `
}

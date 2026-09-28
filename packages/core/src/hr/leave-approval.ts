import { AppError } from '@berelax/shared'
import type { Role } from '../access/permissions.ts'
import { can } from '../access/permissions.ts'
import type { Period } from '../availability/room-predicates.ts'
import type { Instant, LocalDate } from '../time.ts'
import {
  type RotaSegment,
  type RotaValidation,
  type RotaViolation,
  type ValidateRotaArgs,
  validateRota,
} from './rota-validator.ts'
// P-HR-05's shape, which is what `validateRota` counts cover from. Imported rather than redeclared so a
// field added to it is a type error here instead of a presence row the validator silently ignores.
import type { RosteredShift } from './working-hours.ts'

/**
 * Approving leave: who may decide it, what it costs the floor, and what it may never do to a booking. Pure.
 *
 * Every figure and every row is an argument. This module holds no coverage rule, no period arithmetic and no
 * appointment vocabulary, and each of those three absences is a decision:
 *
 *   * **The coverage rule is P-HR-06's.** {@link coverageBreachesCausedBy} calls `validateRota` twice — once
 *     over the floor as rostered and once over the floor with this leave removed — and returns the segment
 *     violations present in the second and absent from the first. A second coverage rule here is exactly the
 *     "a second statement of a fact drifts" defect this build keeps finding: the two would disagree on the
 *     boundary minute, and the screen would print one while the transaction refused for the other.
 *
 *   * **The period is `leaveCoveragePeriod`'s** (`./leave-accrual.ts`), which decides once that a leave day
 *     covers its TRADING session — 11:00 on the 17th to 02:00 on the 18th — so the 01:30 appointment in the
 *     tail falls inside the leave rather than beside it. Nothing here recomputes it. {@link leavePeriodCovers}
 *     is a containment test over the instants that function produced, which is not the same thing as
 *     deciding what they are.
 *
 *   * **There is no appointment status anywhere in this file**, and that is the boundary ADR 0041 records.
 *     An approval resolves a conflict by P-HR-04's reassignment or by an audited override, and it cancels
 *     nothing. `packages/fixtures/src/hr-leave-approval.test.ts` enumerates the statuses reachable from the
 *     approval path out of the SOURCE and asserts `cancelled_by_salon` and `no_show` are not among them; a
 *     hand-written list of "statuses we do not write" would be a second statement, and it would still pass
 *     if this module started cancelling appointments tomorrow.
 *
 * ## Why the coverage refusal is a DELTA and not an absolute
 *
 * The acceptance line is "an approval that would **drop** floor coverage below the configured minimum", and
 * the word is load-bearing. An absolute reading — refuse whenever any segment of the leave's days is short —
 * makes leave unapprovable whenever the rota is short for a reason that has nothing to do with the request:
 * on a database whose `shift` table is empty, which is every seeded database in this build, every segment of
 * every day breaches and no leave could ever be approved. Worse, the refusal would name a segment the
 * requester cannot do anything about.
 *
 * So the question is "does THIS approval break a segment that was covered without it", and the answer is the
 * set difference. Both halves are `validateRota`'s, over the same arguments, differing only in the leave.
 * That is also what makes the refusal actionable: the segments it names are the ones a manager can fix by
 * rostering somebody.
 *
 * The other direction is asserted too, because a delta that could never fire would be worse than no check:
 * `leave-approval.test.ts` holds a case where the segment was ALREADY short and the approval is allowed, and
 * one where the leave is what makes it short and the approval is refused, over the same rota.
 *
 * ## Both segment rules, not only the floor minimum
 *
 * `minimum_floor_coverage` is the rule the acceptance line names and `wet_room_capability` is the other rule
 * measured per segment. Both are returned, because docs/12 §2 says a provisional position is the strictest
 * safe option and the strictest reading of "the approval must not break the floor" includes "and must not
 * leave the bath with nobody able to run it". The refusal names the rule, so the two are distinguishable
 * rather than merged.
 *
 * Pure: rows and instants in, refusals out. No clock — the decision instant is an argument — no I/O, and no
 * role table of its own: {@link authoriseLeaveApproval} asks `can()` from `../access/permissions.ts`.
 */

/** The outbox event an approval publishes. One spelling, shared by the writer and every assertion. */
export const LEAVE_APPROVED_EVENT = 'leave.approved'

/** The event a withdrawal publishes. A separate fact, so a separate event (0081's division). */
export const LEAVE_APPROVAL_CANCELLED_EVENT = 'leave.approval_cancelled'

/** The transactional-class template the staff notification is sent under. */
export const LEAVE_APPROVED_TEMPLATE_KEY = 'hr.leave_approved'

/**
 * The permission an approval requires, asked of `ROLE_DEFINITIONS` rather than restated as a role list.
 *
 * A literal `['owner', 'manager']` here would be a second copy of the matrix, and it would go stale the
 * first time a grant moved — which is the failure `permittedRolesFor` in `../lifecycle/transitions.ts`
 * exists not to have.
 */
export const LEAVE_APPROVAL_PERMISSION = 'leave:approve' as const

/**
 * The roles that may OVERRIDE a booking conflict, and why this one IS a literal list.
 *
 * It is not a permission, and inventing one would be inventing a grant nobody asked for. Y9-coverage's
 * provisional answer says the override needs "owner or manager role and a non-empty audited reason", and
 * these are those two roles. Migration 0092 refuses any other role with ZY002, so this list and that trigger
 * are two layers of one rule rather than two rules — and `leave-approval.test.ts` asserts that every role
 * outside this list is refused, so a third role added here without the migration fails a test.
 */
export const LEAVE_OVERRIDE_ROLES: readonly Role[] = Object.freeze(['owner', 'manager'])

/** Every reason an approval is refused, as a value. Callers branch on these, never on prose. */
export const LEAVE_APPROVAL_REFUSALS = [
  /** The request is not pending, so there is no decision left to take. */
  'not_pending',
  /** The approver holds neither the permission nor a delegation covering the decision instant. */
  'approver_not_authorised',
  /** A delegation exists and the decision instant is outside its window. */
  'delegation_not_in_window',
  /** At least one overlapping appointment is neither reassigned nor overridden. */
  'conflicts_unresolved',
  /** A segment covered without this leave is not covered with it. */
  'coverage_would_break',
  /** The override was attempted by a role that may not take it. */
  'override_role_not_permitted',
  /** The override carries no written reason. */
  'override_reason_not_written',
] as const

export type LeaveApprovalRefusal = (typeof LEAVE_APPROVAL_REFUSALS)[number]

/** The shortest reason a human has to write on an override. 0092's ZY002 refuses anything shorter. */
export const LEAVE_OVERRIDE_REASON_MINIMUM_LENGTH = 8

/** One row of `leave_approval_delegation`, as this module needs it. */
export interface LeaveApprovalDelegation {
  readonly id: string
  readonly delegatorEmployeeId: string
  readonly deputyEmployeeId: string
  readonly period: Period
  /** Set when the authority was withdrawn; the delegation confers nothing from that instant. */
  readonly revokedAt: Instant | null
}

/** The person taking the decision. A role and an employee id, never a name (brief rule 10). */
export interface LeaveApprover {
  readonly employeeId: string
  readonly role: Role
}

/** How an approval was authorised, which `leave_approval.approved_via` stores. */
export type LeaveApprovalAuthority =
  | { readonly via: 'own_authority' }
  | { readonly via: 'delegation'; readonly delegationId: string }

export type LeaveApprovalAuthorisation =
  | { readonly authorised: true; readonly authority: LeaveApprovalAuthority }
  | {
      readonly authorised: false
      readonly refusal: Extract<
        LeaveApprovalRefusal,
        'approver_not_authorised' | 'delegation_not_in_window'
      >
      readonly why: string
    }

/**
 * Whether this approver may decide this request, at this instant.
 *
 * Three answers, and the acceptance line names all three: the named deputy inside the window may, an
 * undelegated peer of the same role may not, and an approval outside the window is refused.
 *
 * The order of the two tests is the decision. A holder of `leave:approve` is authorised on their OWN
 * authority and a delegation is not consulted for them — so a manager whose delegation has expired can still
 * approve, because their own grant never depended on it. It is the deputy who has nothing else: the
 * delegation is the whole of their authority, which is why `delegation_not_in_window` is a distinct refusal
 * from `approver_not_authorised`. Collapsing the two would tell a deputy whose window closed yesterday that
 * they are not allowed to approve leave at all, and they would ask for the permission instead of asking for
 * the window to be extended.
 *
 * A delegation whose deputy is the approver but whose window does not contain `at` produces
 * `delegation_not_in_window`; no delegation naming them at all produces `approver_not_authorised`. That is
 * what makes "an undelegated peer of the same role cannot" a different sentence from "outside the window".
 */
export function authoriseLeaveApproval(args: {
  readonly approver: LeaveApprover
  readonly requestEmployeeId: string
  readonly delegations: readonly LeaveApprovalDelegation[]
  readonly at: Instant
}): LeaveApprovalAuthorisation {
  const { approver, requestEmployeeId, delegations, at } = args
  if (approver.employeeId === requestEmployeeId) {
    // Approving your own leave is refused whatever you hold, and it is refused HERE rather than left to a
    // constraint: `leave:approve` is a grant to decide the floor's leave, and a manager deciding their own
    // is the one case where holding the permission is not the question anybody is asking.
    return {
      authorised: false,
      refusal: 'approver_not_authorised',
      why:
        `Employee ${approver.employeeId} may not approve their own leave request. The permission is to ` +
        "decide the floor's leave, and a self-approval is the one case where holding it is not the " +
        "question — a delegation to somebody else is how a manager's own holiday is approved.",
    }
  }
  if (can(approver.role, LEAVE_APPROVAL_PERMISSION)) {
    return { authorised: true, authority: { via: 'own_authority' } }
  }
  const mine = delegations.filter(
    (delegation) => delegation.deputyEmployeeId === approver.employeeId,
  )
  if (mine.length === 0) {
    return {
      authorised: false,
      refusal: 'approver_not_authorised',
      why:
        `Role ${approver.role} does not hold ${LEAVE_APPROVAL_PERMISSION} and no delegation names ` +
        `employee ${approver.employeeId} as a deputy. A peer of a delegated deputy holds nothing the ` +
        'deputy holds: the delegation is to a PERSON, because a delegation to a role would make every ' +
        'holder of that role a deputy.',
    }
  }
  const live = mine.filter(
    (delegation) => delegation.revokedAt === null || delegation.revokedAt > at,
  )
  const covering = live.find(
    (delegation) => delegation.period.startsAt <= at && at < delegation.period.endsAt,
  )
  if (covering !== undefined) {
    return { authorised: true, authority: { via: 'delegation', delegationId: covering.id } }
  }
  return {
    authorised: false,
    refusal: 'delegation_not_in_window',
    why:
      `Employee ${approver.employeeId} is a named deputy, and none of their ${mine.length} ` +
      `delegation(s) is live and covering the decision instant ${String(at)}. A delegation is ` +
      'time-bounded; an approval outside the window is the case the bound exists for.',
  }
}

/** One appointment overlapping the leave, and what has been decided about it. */
export interface LeaveConflict {
  readonly appointmentId: string
  readonly customerId: string
  readonly serviceVariantId: string
  readonly roomId: string
  readonly therapistId: string
  readonly startsAt: Instant
  /**
   * `unresolved` until a P-HR-04 reassignment has moved the appointment off this therapist, or an audited
   * override has been recorded against it. Derived by the reader from the rows, never asserted by a caller.
   */
  readonly resolution: 'unresolved' | 'reassigned' | 'overridden'
}

/** Whether the leave period contains an instant. Containment over instants somebody else computed. */
export function leavePeriodCovers(period: Period, instant: Instant): boolean {
  return period.startsAt <= instant && instant < period.endsAt
}

/** The conflicts nothing has been decided about. Empty is what lets an approval commit. */
export function unresolvedConflicts(conflicts: readonly LeaveConflict[]): readonly LeaveConflict[] {
  return conflicts.filter((conflict) => conflict.resolution === 'unresolved')
}

/** The two rules `validateRota` measures per SEGMENT, which are the two an approval can break. */
const SEGMENT_RULES = ['minimum_floor_coverage', 'wet_room_capability'] as const

type SegmentRule = (typeof SEGMENT_RULES)[number]

/** A segment violation, narrowed to the two rules that are about a segment. */
export type CoverageSegmentViolation = Extract<RotaViolation, { readonly rule: SegmentRule }>

const isSegmentViolation = (violation: RotaViolation): violation is CoverageSegmentViolation =>
  (SEGMENT_RULES as readonly string[]).includes(violation.rule)

/** `rule|tradingDate|segmentIndex`, which identifies one breach of one segment by one rule. */
const breachKey = (violation: CoverageSegmentViolation): string =>
  `${violation.rule}|${violation.tradingDate}|${violation.segmentIndex}`

/**
 * One employee's presence, as the floor reads it: NET of every approved leave already in force.
 *
 * A `RosteredShift` whose `shiftId` is synthetic, and that is stated rather than hidden. The rows come from
 * a multirange difference in SQL (`range_agg(shift.period) - range_agg(leave.period)`, the same operator
 * `tp_net` in `packages/db/src/repositories/eligibility.ts` uses for the same subtraction), so one rostered
 * span can arrive as two fragments and neither is a `shift` row any more.
 *
 * Why net and not raw: a therapist rostered on a day they are already on approved leave for is not on the
 * floor, and counting them would under-report the breach a second approval causes. `validateRota` is handed
 * raw `shift_assignment` rows by `publishRota`, which is right for the question a publish asks — is this
 * DRAFT publishable — and wrong for the question here. See this unit's NOTE in the manifest: the difference
 * is a finding about P-HR-06's publish path, reported rather than repaired.
 */
export interface FloorPresence {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly period: Period
}

export interface CoverageDeltaArgs {
  /**
   * Everything `validateRota` needs except the assignments, which are built from {@link presence}.
   *
   * Spread verbatim into both calls, so the two answers differ in exactly one input.
   */
  readonly rota: Omit<ValidateRotaArgs, 'assignments'>
  /** The floor as it stands, net of leave already approved. */
  readonly presence: readonly FloorPresence[]
  /** The employee whose leave is being decided. */
  readonly employeeId: string
  /** The period the leave would cover, from `leaveCoveragePeriod`. */
  readonly period: Period
}

export interface CoverageDelta {
  /** Segments a breach would be CAUSED in: breaching with the leave and not without it. */
  readonly caused: readonly CoverageSegmentViolation[]
  /** Segments already breaching without the leave. Reported, never refused on. */
  readonly preexisting: readonly CoverageSegmentViolation[]
  /** The grid, from the WITH-leave validation, so a screen draws what the refusal is about. */
  readonly segments: readonly RotaSegment[]
  /**
   * How many presence fragments the leave actually removed or shortened.
   *
   * The control on the whole delta, and it is here rather than in a test because the failure it catches is
   * silent: a leave period that overlaps nothing subtracts nothing, both validations are identical, and
   * `caused` is empty — a coverage check that examined nothing and passed (ADR 0002). A caller that refuses
   * on `caused` while this is zero is refusing on an answer about the wrong period.
   */
  readonly presenceFragmentsAffected: number
}

/**
 * Presence with one employee's leave period subtracted, and the count of fragments that changed.
 *
 * The subtraction is a period difference over half-open instants and it is written out rather than delegated,
 * because there is nothing in `@berelax/core` to delegate it to: `mergePeriods` unions and nothing
 * subtracts. It is the one piece of arithmetic in this file, it is nine lines, and the four cases are the
 * whole of it — no overlap, cut from the front, cut from the back, and split in two.
 */
function withoutLeave(
  presence: readonly FloorPresence[],
  employeeId: string,
  leave: Period,
): { readonly presence: readonly FloorPresence[]; readonly affected: number } {
  const out: FloorPresence[] = []
  let affected = 0
  for (const span of presence) {
    if (span.employeeId !== employeeId) {
      out.push(span)
      continue
    }
    if (span.period.endsAt <= leave.startsAt || leave.endsAt <= span.period.startsAt) {
      out.push(span)
      continue
    }
    affected += 1
    if (span.period.startsAt < leave.startsAt) {
      out.push({ ...span, period: { startsAt: span.period.startsAt, endsAt: leave.startsAt } })
    }
    if (leave.endsAt < span.period.endsAt) {
      out.push({ ...span, period: { startsAt: leave.endsAt, endsAt: span.period.endsAt } })
    }
  }
  return { presence: out, affected }
}

/**
 * Presence as `RosteredShift`s, with ids that say what they are.
 *
 * The id has to be stable across the two validations for the same fragment, or `minimum_rest`'s violations
 * would name different shifts in the two answers — which nothing here reads, but a reader comparing the two
 * outputs would. It is derived from the employee, the date and the instants for that reason, and it is
 * prefixed so a `minimum_rest` violation in a log cannot be mistaken for a `shift.id`.
 */
function asRosteredShifts(presence: readonly FloorPresence[]): readonly RosteredShift[] {
  return presence.map((span) => ({
    shiftId: `leave-coverage:${span.employeeId}:${span.tradingDate}:${String(span.period.startsAt)}-${String(span.period.endsAt)}`,
    employeeId: span.employeeId,
    tradingDate: span.tradingDate,
    period: span.period,
  }))
}

/**
 * The segments this leave would break: breaching with it, not breaching without it.
 *
 * Two `validateRota` calls over identical arguments bar the leave. That is the whole implementation, and it
 * is what "reusing the P-HR-06 validator" has to mean: if the floor minimum, the containment test or the
 * segment grid changes, both halves of this answer change with it and this file says nothing new.
 */
export function coverageBreachesCausedBy(args: CoverageDeltaArgs): CoverageDelta {
  const { rota, presence, employeeId, period } = args
  if (period.endsAt <= period.startsAt) {
    throw new AppError(
      'validation',
      'A leave period that ends when or before it starts subtracts nothing from the floor, so the ' +
        'coverage answer would be the rota unchanged and the approval would read as safe.',
    )
  }
  const before = validateRota({ ...rota, assignments: asRosteredShifts(presence) })
  const after = withoutLeave(presence, employeeId, period)
  const withLeave = validateRota({ ...rota, assignments: asRosteredShifts(after.presence) })

  const preexisting = before.violations.filter(isSegmentViolation)
  const known = new Set(preexisting.map(breachKey))
  const caused = withLeave.violations
    .filter(isSegmentViolation)
    .filter((violation) => !known.has(breachKey(violation)))

  return {
    caused,
    preexisting,
    segments: withLeave.segments,
    presenceFragmentsAffected: after.affected,
  }
}

/** Human wording for one caused breach, for a refusal message and for a screen. */
export function describeCoverageBreach(violation: CoverageSegmentViolation): string {
  if (violation.rule === 'minimum_floor_coverage') {
    return `${violation.segmentLabel}: approving this leave leaves ${violation.onFloor} therapist(s) on the floor, ${violation.required} required`
  }
  return `${violation.segmentLabel}: approving this leave leaves ${violation.capableOnFloor} wet-room-capable therapist(s) on the floor while the wet room is bookable, ${violation.required} required`
}

export interface LeaveApprovalDecisionArgs {
  readonly request: {
    readonly id: string
    readonly employeeId: string
    readonly status: string
    readonly period: Period
  }
  readonly approver: LeaveApprover
  readonly delegations: readonly LeaveApprovalDelegation[]
  readonly at: Instant
  readonly conflicts: readonly LeaveConflict[]
  readonly coverage: CoverageDelta
}

export type LeaveApprovalDecision =
  | {
      readonly kind: 'approve'
      readonly authority: LeaveApprovalAuthority
      /** What the approval stepped over, for `leave_approval`'s two counts. */
      readonly conflictsOverridden: number
      readonly conflictsReassigned: number
    }
  | {
      readonly kind: 'refused'
      readonly refusal: LeaveApprovalRefusal
      readonly why: string
      /** Every unresolved conflict, whole, when that is the refusal. The report IS the answer. */
      readonly conflicts: readonly LeaveConflict[]
      /** Every segment the approval would break, when that is the refusal. */
      readonly breaches: readonly CoverageSegmentViolation[]
    }

/**
 * The whole decision, in the order the refusals have to be taken.
 *
 * The ORDER is a decision and it is the cheap-and-certain one first: authority, then the request's own state,
 * then the conflicts, then coverage. Authority first because an unauthorised caller must not learn from a
 * refusal which of somebody else's appointments overlap their leave — a conflict report names a customer, and
 * the report is the informative half of this answer. Conflicts before coverage because a conflict is resolved
 * by moving an appointment and a coverage breach is fixed by rostering somebody, and telling a manager about
 * the second while the first is outstanding sends them to the wrong screen.
 *
 * `not_pending` is checked after authority for the same reason and one more: the status of somebody else's
 * leave request is a fact about that person's time off.
 */
export function decideLeaveApproval(args: LeaveApprovalDecisionArgs): LeaveApprovalDecision {
  const { request, approver, delegations, at, conflicts, coverage } = args

  const authorisation = authoriseLeaveApproval({
    approver,
    requestEmployeeId: request.employeeId,
    delegations,
    at,
  })
  if (!authorisation.authorised) {
    return {
      kind: 'refused',
      refusal: authorisation.refusal,
      why: authorisation.why,
      conflicts: [],
      breaches: [],
    }
  }

  if (request.status !== 'pending') {
    return {
      kind: 'refused',
      refusal: 'not_pending',
      why:
        `Leave request ${request.id} is ${request.status}. An approval applies to a pending request: ` +
        're-deciding a decided one is how a reservation comes to be released twice, which is what ' +
        '`decideRequest` in ./leave-accrual.ts refuses for the balance and what this refuses for the row.',
      conflicts: [],
      breaches: [],
    }
  }

  const unresolved = unresolvedConflicts(conflicts)
  if (unresolved.length > 0) {
    return {
      kind: 'refused',
      refusal: 'conflicts_unresolved',
      why:
        `${unresolved.length} of ${conflicts.length} appointment(s) overlapping this leave are neither ` +
        'reassigned nor overridden. Each one resolves by a P-HR-04 reassignment or by an audited ' +
        'override; neither of those is a cancellation (ADR 0041).',
      conflicts: unresolved,
      breaches: [],
    }
  }

  if (coverage.caused.length > 0) {
    return {
      kind: 'refused',
      refusal: 'coverage_would_break',
      why:
        `Approving this leave breaks ${coverage.caused.length} segment(s) that are covered without it: ` +
        `${coverage.caused.map(describeCoverageBreach).join('; ')}`,
      conflicts: [],
      breaches: coverage.caused,
    }
  }

  return {
    kind: 'approve',
    authority: authorisation.authority,
    conflictsOverridden: conflicts.filter((conflict) => conflict.resolution === 'overridden')
      .length,
    conflictsReassigned: conflicts.filter((conflict) => conflict.resolution === 'reassigned')
      .length,
  }
}

/** Whether a role may take a conflict override. 0092's ZY002 refuses the same set in the database. */
export function mayOverrideLeaveConflict(role: Role): boolean {
  return LEAVE_OVERRIDE_ROLES.includes(role)
}

/**
 * The widest reader the leave screen serves until there is an admin session.
 *
 * `manager` and not `owner`, which is the narrower of the two available ceilings: the manager holds
 * `leave:approve` and `booking:read`, which is everything that screen shows, and nothing an owner holds beyond
 * that is on it. A ceiling of `owner` would be a wider grant that bought nothing.
 */
export const LEAVE_APPROVAL_SESSIONLESS_CEILING_ROLE: Role = 'manager'

/** What a reader of one leave request may do and see. Three booleans, decided from the F07 matrix. */
export interface LeaveApprovalAccess {
  readonly mayApprove: boolean
  readonly mayOverride: boolean
  /**
   * Whether the conflict report may be shown at all.
   *
   * `booking:read`, because the report names a client, a service and a room. It is the one thing on that
   * screen that is somebody else's business, and a count is withheld with it: a number is enough to tell
   * somebody whether a named colleague has bookings.
   */
  readonly maySeeConflicts: boolean
}

export function resolveLeaveApprovalAccess(role: Role): LeaveApprovalAccess {
  return {
    mayApprove: can(role, LEAVE_APPROVAL_PERMISSION),
    mayOverride: mayOverrideLeaveConflict(role),
    maySeeConflicts: can(role, 'booking:read'),
  }
}

/**
 * Two access answers intersected, which is how a claimed role can only ever NARROW a ceiling.
 *
 * There is no admin session until W-SYS-11, so the leave screen takes the reader's role from `?role=`. A role
 * IS a permission, so taking one from a query string would be an escalation with a query string — unless the
 * decision is taken for the claimed role and then intersected with the ceiling's, which is what this does.
 *
 * It lives in `@berelax/core` and not in the route for the reason `/clients/[id]/flags` records for its own
 * ceiling: "the property that matters — this can only NARROW — is proved by a pure test rather than by serving
 * the page. A ceiling whose only test needs a server is a ceiling somebody removes without ever seeing it
 * fail." That is not a preference. A gate case that mutated the route and drove the built application reported
 * "nothing was rejected", because `next start` serves whatever `.next` was last built — so a narrowing whose
 * only home is a route handler has no known-bad fixture at all.
 *
 * Every field is a conjunction, and the property test asserts over every role that the narrowed answer is
 * never wider than the ceiling's in any field. A `||` in any one of them is the one-character escalation.
 */
export function narrowLeaveApprovalAccess(
  claimed: LeaveApprovalAccess,
  ceiling: LeaveApprovalAccess,
): LeaveApprovalAccess {
  return {
    mayApprove: claimed.mayApprove && ceiling.mayApprove,
    mayOverride: claimed.mayOverride && ceiling.mayOverride,
    maySeeConflicts: claimed.maySeeConflicts && ceiling.maySeeConflicts,
  }
}

export type LeaveOverrideVerdict =
  | { readonly permitted: true }
  | {
      readonly permitted: false
      readonly refusal: Extract<
        LeaveApprovalRefusal,
        'override_role_not_permitted' | 'override_reason_not_written'
      >
      readonly why: string
    }

/**
 * Whether this override may be recorded: the role, and the reason, which are one rule in two halves.
 *
 * Both halves are ALSO refused by migration 0092 (ZY002), and that duplication is deliberate in the one
 * direction this build allows it: the trigger is the layer that still holds for the UPDATE somebody runs in
 * `psql`, and this is the layer that can say which of the two is wrong before a transaction is opened. The
 * test asserts the two agree on every role, so they cannot drift into two different answers.
 */
export function judgeLeaveConflictOverride(args: {
  readonly role: Role
  readonly reason: string
}): LeaveOverrideVerdict {
  if (!mayOverrideLeaveConflict(args.role)) {
    return {
      permitted: false,
      refusal: 'override_role_not_permitted',
      why:
        `A leave-conflict override may be taken by ${LEAVE_OVERRIDE_ROLES.join(' or ')} and not by a ` +
        `${args.role}. Leaving an appointment standing inside approved leave is a decision about ` +
        "somebody else's booking (Y9-coverage).",
    }
  }
  if (args.reason.trim().length < LEAVE_OVERRIDE_REASON_MINIMUM_LENGTH) {
    return {
      permitted: false,
      refusal: 'override_reason_not_written',
      why:
        `An override reason of ${args.reason.trim().length} character(s) is not a written reason; at ` +
        `least ${LEAVE_OVERRIDE_REASON_MINIMUM_LENGTH} are required. A blank reason is ` +
        'indistinguishable from a conflict nobody looked at, and the row is the only record that ' +
        'anybody did.',
    }
  }
  return { permitted: true }
}

/** The validation `validateRota` produced for the floor WITHOUT this leave, for a screen. */
export type LeaveCoverageValidation = RotaValidation

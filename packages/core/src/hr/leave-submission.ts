import { AppError } from '@berelax/shared'
import { type LocalDate, localDate } from '../time.ts'
import {
  applyLeaveLedgerEvent,
  calendarLeaveDays,
  emptyLeaveLedger,
  HUNDREDTHS_PER_DAY,
  type LeaveEntitlementRules,
  leaveYearStart,
  mayTakeAnnualLeaveOn,
} from './leave-accrual.ts'

/**
 * The ONE judgement a submitted leave request passes through, whoever submits it (P-HR-14).
 *
 * ## Why this is a function and not two screens' worth of checks
 *
 * The acceptance line is "a leave request submitted from the portal enters the same validator as the admin
 * path". The way that line gets satisfied falsely is two code paths that agree today: the portal checks the
 * balance and the probation, the admin screen checks the balance, and a year later only one of them knows
 * about the carry-over rule. So there is one function, it is pure, and
 * `packages/fixtures/src/leave-submission-entry-points.test.ts` asserts by SOURCE SCAN that every entry
 * point reaches it — and that none of them reaches `writeLeaveRequest` without it.
 *
 * ## Every refusal is a RETURNED value
 *
 * `applyLeaveLedgerEvent`'s decision, restated because it applies here for the same reason: an employee
 * asking for more leave than they have is the commonest thing that happens to a leave balance, so it is an
 * outcome and not a fault. A thrown refusal would put the business rule in an exception handler and would
 * make the screen's own refusal sentence a `catch` block's reading of a message.
 *
 * The one thing thrown is a malformed input — an inverted date range, a request against a leave year that
 * has not started — which is a programming error at a call site rather than a decision about somebody's
 * holiday.
 *
 * ## The balance is the ledger's, and the reservation is the submission's
 *
 * 0066 is explicit: a request reserves when it is MADE, and approval only makes the reservation final. So
 * the judgement a submission needs is exactly `applyLeaveLedgerEvent`'s `request` event, which is where
 * `insufficient_balance` lives and where the property test proving no sequence of events can drive a
 * balance negative already points. This module therefore does NOT re-implement the subtraction: it builds
 * the ledger the balance view reports, applies the event, and hands back what the engine said.
 */

/**
 * One `leave_entitlement_rule` row as a policy version — the ONE mapping, in core.
 *
 * It was two. `apps/worker/src/jobs/leave-accrual.ts` had a private `asRules` and this module needed the
 * same thing, which is the "second statement of a fact" the brief names: the row has thirteen fields and
 * the three sick-leave tiers nest, so the copy that stops matching does it silently and the symptom is an
 * entitlement figure nobody can trace. The worker job now delegates here and its copy is gone.
 *
 * The argument is structurally typed and NOT `LeaveEntitlementRuleRow` from `@berelax/db`, because
 * `packages/core` may import `@berelax/shared` and nothing else (brief rule 4). The db interface satisfies
 * this shape, so a column renamed there is a type error at the call site.
 */
export interface LeaveEntitlementRuleFields {
  readonly effectiveFrom: string
  readonly annualEntitlementDays: number
  readonly monthlyAccrualHundredths: number
  readonly probationMonths: number
  readonly accruesDuringProbation: boolean
  readonly carryOverCapHundredths: number
  readonly carryOverExpiresAfterOneLeaveYear: boolean
  readonly leaveYearStartsOnAnniversary: boolean
  readonly unpaidLeaveReducesAccrual: boolean
  readonly absentDayReducesAccrual: boolean
  readonly sickFullPayDays: number
  readonly sickHalfPayDays: number
  readonly sickUnpaidDays: number
}

export function leaveEntitlementRulesFrom(row: LeaveEntitlementRuleFields): LeaveEntitlementRules {
  return {
    effectiveFrom: localDate(row.effectiveFrom),
    annualEntitlementDays: row.annualEntitlementDays,
    monthlyAccrualHundredths: row.monthlyAccrualHundredths,
    probationMonths: row.probationMonths,
    accruesDuringProbation: row.accruesDuringProbation,
    carryOverCapHundredths: row.carryOverCapHundredths,
    carryOverExpiresAfterOneLeaveYear: row.carryOverExpiresAfterOneLeaveYear,
    leaveYearStartsOnAnniversary: row.leaveYearStartsOnAnniversary,
    unpaidLeaveReducesAccrual: row.unpaidLeaveReducesAccrual,
    absentDayReducesAccrual: row.absentDayReducesAccrual,
    sickLeave: {
      fullPayDays: row.sickFullPayDays,
      halfPayDays: row.sickHalfPayDays,
      unpaidDays: row.sickUnpaidDays,
    },
  }
}

/** The `leave_kind` enum (0030), as values, so a submission can be refused by name rather than by SQL. */
export const LEAVE_REQUEST_KINDS = ['annual', 'sick', 'unpaid', 'other'] as const

export type LeaveRequestKind = (typeof LEAVE_REQUEST_KINDS)[number]

export function isLeaveRequestKind(value: string): value is LeaveRequestKind {
  return (LEAVE_REQUEST_KINDS as readonly string[]).includes(value)
}

/**
 * Why a submission was refused.
 *
 * `insufficient_balance` is the ledger engine's own reason, passed through rather than renamed, so the
 * refusal a therapist sees and the refusal the property test exercises are one value.
 */
export const LEAVE_SUBMISSION_REFUSALS = [
  'unknown_leave_kind',
  /** The range is inverted, or longer than {@link MAX_SUBMITTED_LEAVE_DAYS}. */
  'leave_range_not_submittable',
  /** Annual leave inside probation. Sick and unpaid leave are not refused by it. */
  'within_probation',
  /** The request starts before the employment did, so there is no leave year to charge it to. */
  'before_employment',
  'insufficient_balance',
] as const

export type LeaveSubmissionRefusal = (typeof LEAVE_SUBMISSION_REFUSALS)[number]

/**
 * The longest run of days one request may cover.
 *
 * A YEAR, deliberately generous, because this is not a policy about how much leave somebody may take — the
 * balance is that — it is the fence that stops a mistyped year (`2027-01-05` for `2026-01-05`) becoming a
 * reservation of three hundred and sixty-five days against a balance that cannot refuse it, since the
 * reservation is written before anybody approves anything. 366 so a leap year's worth of annual shutdown
 * is expressible.
 */
export const MAX_SUBMITTED_LEAVE_DAYS = 366

export interface LeaveSubmissionRequest {
  readonly kind: string
  readonly from: LocalDate
  readonly to: LocalDate
}

export interface LeaveSubmissionSubject {
  readonly employedFrom: LocalDate
  /** The balance as `leave_balance` reports it, in day-hundredths. */
  readonly balanceHundredths: number
}

export type LeaveSubmissionVerdict =
  | {
      readonly kind: 'accepted'
      readonly leaveKind: LeaveRequestKind
      readonly days: number
      /**
       * What the reservation must deduct, in day-hundredths. Positive for annual leave and **zero** for
       * every other kind — see the body on why nothing else touches the annual ledger. The sign is the
       * repository's.
       */
      readonly hundredths: number
      readonly leaveYearStart: LocalDate
    }
  | {
      readonly kind: 'refused'
      readonly refusal: LeaveSubmissionRefusal
      readonly detail: string
    }

const refused = (refusal: LeaveSubmissionRefusal, detail: string): LeaveSubmissionVerdict => ({
  kind: 'refused',
  refusal,
  detail,
})

/**
 * Judges one submission.
 *
 * `submittedOn` is an argument and not a clock read: this module is pure (brief rule 4), and the date a
 * request is submitted on decides the leave year the reservation is charged to — so a function that read
 * the clock would make "which leave year" untestable at a boundary.
 *
 * Only ANNUAL leave is charged to the balance, and only annual leave is refused inside probation. Sick
 * leave has its own entitlement (`sick-leave.ts`), unpaid leave is by definition not drawn from an accrual,
 * and `other` is the kind that exists because the enum needed one — charging either of the last two against
 * the annual balance would deduct days nobody earned against them.
 */
export function judgeLeaveSubmission(args: {
  readonly request: LeaveSubmissionRequest
  readonly subject: LeaveSubmissionSubject
  readonly rules: LeaveEntitlementRules
  readonly submittedOn: LocalDate
}): LeaveSubmissionVerdict {
  const { request, subject, rules, submittedOn } = args

  if (!isLeaveRequestKind(request.kind)) {
    return refused(
      'unknown_leave_kind',
      `"${request.kind}" is not a leave kind. The enum holds ${LEAVE_REQUEST_KINDS.join(', ')}, and a ` +
        'kind the enum does not know would be refused by the database with a message about a cast.',
    )
  }
  const leaveKind = request.kind

  if (request.to < request.from) {
    return refused(
      'leave_range_not_submittable',
      `Leave from ${request.from} to ${request.to} ends before it starts.`,
    )
  }
  const days = calendarLeaveDays({ from: request.from, to: request.to })
  if (days > MAX_SUBMITTED_LEAVE_DAYS) {
    return refused(
      'leave_range_not_submittable',
      `${days} days is longer than the ${MAX_SUBMITTED_LEAVE_DAYS} one request may cover. A range this ` +
        'long is a mistyped year far more often than it is a request, and the reservation is written ' +
        'before anybody approves it.',
    )
  }

  if (request.from < subject.employedFrom || submittedOn < subject.employedFrom) {
    return refused(
      'before_employment',
      `Leave from ${request.from}, submitted on ${submittedOn}, is not wholly after the employment ` +
        `started on ${subject.employedFrom}, so there is no leave year to charge it to.`,
    )
  }

  if (leaveKind === 'annual' && !mayTakeAnnualLeaveOn(rules, subject.employedFrom, request.from)) {
    return refused(
      'within_probation',
      `Annual leave on ${request.from} falls inside probation. Accrual runs from day one and taking ` +
        'waits for the end of it, which is the separation leave-accrual.ts records.',
    )
  }

  /*
    The leave year is the one containing the SUBMISSION date, not the one containing the leave.

    That is 0066's own reading of the column it is written to. `leave_movement.occurred_on` for a
    reservation is "the day the request was made" and `leave_year_start` is "the first date of the leave
    year this movement belongs to", so the movement belongs to the year it is dated in. It is also the only
    reading consistent with the balance: a request reserves when it is made, so the days come out of the
    balance that exists now, and charging them to a leave year that has not started would let somebody
    spend next year's entitlement and still show this year's as whole.

    A December request for January leave therefore reserves from December's balance. That is deliberate and
    it is the conservative direction: the alternative lets the carry-over cap forfeit days that a pending
    request had already spoken for.
  */
  const yearStart = leaveYearStart(rules, subject.employedFrom, submittedOn)

  /*
    Not annual: NOTHING is reserved, and `hundredths` is zero rather than the days.

    `leave_movement` is the ANNUAL leave ledger — `leave_balance` sums it, `accrueMonth` feeds it, and the
    entitlement it tracks is the 30-day annual one. Sick leave has its own tiers (`sick-leave.ts`), unpaid
    leave is by definition not drawn from an accrual, and `other` exists because the enum needed a fourth
    value. A reservation for any of the three would deduct days from a balance they were never earned
    against, and `leave_movement` is append-only (ZH001) so nothing could take it back.

    This was the first version's defect: it reserved `days * 100` for every kind, so three days of unpaid
    leave cost three days of annual entitlement. The integration suite caught it by asserting the balance
    delta for an unpaid request, which was -300 and had to be 0.
  */
  const hundredths = leaveKind === 'annual' ? days * HUNDREDTHS_PER_DAY : 0
  if (leaveKind !== 'annual') {
    return { kind: 'accepted', leaveKind, days, hundredths, leaveYearStart: yearStart }
  }

  /*
    The balance question asked of the ENGINE and not re-derived here.

    A ledger with the reported balance as its opening balance and the request applied to it. That is the
    same `request` event the property test drives, so `insufficient_balance` here and
    `insufficient_balance` there are one rule rather than two readings of one. Re-deriving it as
    `balance >= hundredths` would be the second reading, and it is the one that stops agreeing the day the
    engine learns about a negative-balance allowance.

    A negative reported balance is possible — an opening balance import can be corrected downwards — and
    `applyLeaveLedgerEvent` refuses an opening balance that is not a whole non-negative figure, so it is
    clamped to zero for the probe with the shortfall still refused by the comparison that follows. Stated
    rather than silently handled: the clamp can only ever make the engine refuse, never accept.
  */
  const opening = Math.max(0, Math.trunc(subject.balanceHundredths))
  const seeded = applyLeaveLedgerEvent(emptyLeaveLedger(), {
    kind: 'opening_balance',
    hundredths: opening,
  })
  if (seeded.refusal !== null) {
    throw new AppError(
      'invariant_violated',
      `A probe ledger seeded with ${opening} day-hundredths was refused as ` +
        `${seeded.refusal.reason}: ${seeded.refusal.detail}. The opening balance is the reported ` +
        'balance clamped to a whole non-negative figure, so nothing here should be refusable.',
    )
  }
  const step = applyLeaveLedgerEvent(seeded.ledger, {
    kind: 'request',
    // A probe id, never written anywhere. The real request's id does not exist yet: the row has to be
    // inserted before it has one, and judging after the insert would be judging a reservation already made.
    requestId: 'leave-submission-probe',
    hundredths,
  })
  if (step.refusal !== null) {
    /*
      Anything but `insufficient_balance` is THROWN and not reported.

      `request_already_known` cannot arise on a fresh ledger carrying one request, and no other reason the
      engine has applies to a `request` event. So a different reason arriving here means the engine has
      learned a rule this module has not been told about, and reporting it as "you do not have enough
      leave" would be this function inventing a reason for a refusal it does not understand — which is
      the one failure a screen about somebody's holiday must not have.
    */
    if (step.refusal.reason !== 'insufficient_balance') {
      throw new AppError(
        'invariant_violated',
        `The leave ledger refused a submission as ${step.refusal.reason}, which judgeLeaveSubmission ` +
          `does not know how to report: ${step.refusal.detail}. Add it to LEAVE_SUBMISSION_REFUSALS ` +
          'with the sentence a screen should show.',
      )
    }
    return refused('insufficient_balance', step.refusal.detail)
  }

  return { kind: 'accepted', leaveKind, days, hundredths, leaveYearStart: yearStart }
}

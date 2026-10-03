import {
  ASIA_DUBAI,
  assertPortalSubject,
  can,
  type HoursForDate,
  type Instant,
  judgeLeaveSubmission,
  type LeaveEntitlementRules,
  type LeaveSubmissionVerdict,
  type LocalDate,
  leaveCoveragePeriod,
  leaveEntitlementRulesFrom,
  leaveRulesFor,
  type PortalBankView,
  type PortalSurface,
  portalBankView,
  type Role,
  type TradingHours,
  toLocal,
} from '@berelax/core'
import {
  type Actor,
  type CommissionDerivationRow,
  type PayslipRow,
  type PortalLeaveRequestRow,
  type PortalShiftRow,
  readLeaveBalances,
  readLeaveEntitlementRules,
  readPortalBankSummary,
  readPortalLeaveRequests,
  readPortalShifts,
  type Sql,
  type TradingDayWindowRow,
  withUnitOfWork,
  writeLeaveRequest,
  writePortalLeaveReservation,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { readCommissionDerivationFor } from './commission-run.ts'
import { readPayslipFor } from './payroll-run.ts'

/**
 * The staff portal's one entry point per surface, and the one place its refusal is made (P-HR-14).
 *
 * ## Why here
 *
 * The rule that decides whose data this is lives in `@berelax/core`
 * (`assertPortalSubject`), the rows live in `@berelax/db`, and `packages/db` may not import
 * `packages/core`. This package already depends on both, which is the arrangement `commission-run.ts` and
 * `payroll-run.ts` next door made for exactly this reason.
 *
 * ## The refusal is BEFORE the statement, on every surface, and the test proves the statement never ran
 *
 * Each function below calls `assertPortalSubject` as its first statement. That is the "refusal in the
 * query, not a filter in the view" the unit is held to: a request naming another employee throws before
 * any SQL is composed, so there is no result set to filter and no empty list to misread as "you have no
 * shifts". `packages/fixtures/src/staff-portal.itest.ts` asserts it with the colleague's rows PRESENT in
 * every table, which is what makes the refusal distinguishable from an empty table.
 *
 * ## Commission and payslips are DELEGATED, and that is deliberate
 *
 * {@link readPortalCommission} and {@link readPortalPayslips} apply the portal's self-only fence and then
 * hand over to `readCommissionDerivationFor` and `readPayslipFor` — P-HR-11's and P-HR-12's own guarded
 * readers. Two fences in series rather than one, and the portal's is the narrower: the delegate permits a
 * colleague's row to a role holding `payroll:read`, this does not permit one to anybody. A portal reader
 * that reached the repository directly would be a second authority over somebody's pay, and the second one
 * is the one nobody updates.
 */

/** Who is asking, and whose data they are asking for. */
export interface PortalViewer {
  readonly role: Role
  readonly employeeId: string
}

const fence = (surface: PortalSurface, viewer: PortalViewer, subjectEmployeeId: string): void => {
  assertPortalSubject({
    surface,
    role: viewer.role,
    viewerEmployeeId: viewer.employeeId,
    subjectEmployeeId,
  })
}

/** The viewer's own published shifts. Refuses before composing a statement. */
export async function readPortalSchedule(
  sql: Sql,
  args: {
    readonly viewer: PortalViewer
    readonly subjectEmployeeId: string
    readonly fromTradingDate: string
    readonly toTradingDate: string
  },
): Promise<readonly PortalShiftRow[]> {
  fence('schedule', args.viewer, args.subjectEmployeeId)
  return readPortalShifts(sql, {
    subject: { employeeId: args.subjectEmployeeId },
    fromTradingDate: args.fromTradingDate,
    toTradingDate: args.toTradingDate,
  })
}

export interface PortalLeaveView {
  readonly requests: readonly PortalLeaveRequestRow[]
  /** Null when the employee has no leave movement at all — which is not a balance of zero (0066). */
  readonly balanceHundredths: number | null
  readonly reservedHundredths: number | null
}

/** The viewer's own leave requests and balance. Refuses before composing a statement. */
export async function readPortalLeave(
  sql: Sql,
  args: { readonly viewer: PortalViewer; readonly subjectEmployeeId: string },
): Promise<PortalLeaveView> {
  fence('leave', args.viewer, args.subjectEmployeeId)
  const subject = { employeeId: args.subjectEmployeeId }
  const [requests, balances] = await Promise.all([
    readPortalLeaveRequests(sql, { subject }),
    readLeaveBalances(sql, [args.subjectEmployeeId]),
  ])
  const balance = balances[0]
  return {
    requests,
    // Null and not zero, which is `readLeaveBalances`' own distinction: an employee with no movement has
    // no row in `leave_balance`, and a synthetic zero would tell a therapist their balance is nil when
    // the truth is that nothing has been accrued or imported for them yet.
    balanceHundredths: balance === undefined ? null : balance.balanceHundredths,
    reservedHundredths: balance === undefined ? null : balance.reservedHundredths,
  }
}

/** What the portal says about the viewer's own bank account. Never the number — see `portalBankView`. */
export async function readPortalBank(
  sql: Sql,
  args: { readonly viewer: PortalViewer; readonly subjectEmployeeId: string },
): Promise<PortalBankView> {
  // The `payslip` surface and not a fifth one: the bank account is on the payslip panel, and a surface
  // enumeration that did not match the screens would make the horizontal-access test's iteration a list of
  // names rather than a list of reads.
  fence('payslip', args.viewer, args.subjectEmployeeId)
  const row = await readPortalBankSummary(sql, { subject: { employeeId: args.subjectEmployeeId } })
  return portalBankView({
    onFile: row !== null,
    label: row?.label ?? null,
    filedOn: row?.filedOn ?? null,
  })
}

/**
 * The viewer's own commission derivation for one run. The portal's fence, then P-HR-11's.
 *
 * Two fences in series and the portal's is the narrower one: `readCommissionDerivationFor` permits a
 * colleague's rows to a role holding `payroll:read`, and this permits them to nobody. Delegating rather
 * than reading the repository is what keeps the pay-visibility rule in ONE place — a portal reader that
 * reached `readCommissionDerivation` itself would be a second authority over somebody's earnings.
 */
export async function readPortalCommission(
  sql: Sql,
  args: {
    readonly viewer: PortalViewer
    readonly subjectEmployeeId: string
    readonly runId: string
  },
): Promise<readonly CommissionDerivationRow[]> {
  fence('commission', args.viewer, args.subjectEmployeeId)
  return readCommissionDerivationFor(sql, {
    runId: args.runId,
    role: args.viewer.role,
    viewerEmployeeId: args.viewer.employeeId,
    subjectEmployeeId: args.subjectEmployeeId,
  })
}

/**
 * The viewer's own payslips for one run. The portal's fence, then P-HR-12's.
 *
 * `readPayslipFor` writes the `payroll.payslips_read` audit row inside its own unit of work, so a therapist
 * opening their own payslip is recorded like every other read of a wage — which is docs/04 §7's "every read
 * audited" applied to the surface that will be read most often.
 */
export async function readPortalPayslips(
  sql: Sql,
  args: {
    readonly viewer: PortalViewer
    readonly subjectEmployeeId: string
    readonly runId: string
    readonly actor: Actor
  },
): Promise<readonly PayslipRow[]> {
  fence('payslip', args.viewer, args.subjectEmployeeId)
  return readPayslipFor(sql, {
    runId: args.runId,
    role: args.viewer.role,
    viewerEmployeeId: args.viewer.employeeId,
    subjectEmployeeId: args.subjectEmployeeId,
    actor: args.actor,
  })
}

/**
 * The trading hours of each generated business day, as `leaveCoveragePeriod` wants them.
 *
 * `business_day` is the generated calendar and its `opens_at`/`closes_at` are the authoritative session
 * bounds, so the hours come from there rather than from `premises_hours` plus the override table. That is
 * the point: `generateBusinessDays` has ALREADY applied the weekly pattern, the Ramadan override and every
 * closure, and reading the three inputs again here would be a second derivation that disagrees with the
 * calendar the booking engine answers from.
 *
 * A date with no row is CLOSED — `undefined`, which `leaveCoveragePeriod` reads as "no session, use the
 * calendar day". That is the honest answer rather than a fallback to the weekly pattern: a date the
 * calendar does not cover is a date nothing can be rostered on, so a leave day there covers nothing the
 * rota could have offered anyway.
 */
export function tradingHoursFromWindows(windows: readonly TradingDayWindowRow[]): HoursForDate {
  const byDate = new Map<string, TradingHours>()
  for (const window of windows) {
    byDate.set(window.tradingDate, {
      // Back to local times in the business zone, because `TradingHours` is a pair of wall-clock times
      // and the row holds instants. The zone is named rather than defaulted so the conversion reads as a
      // decision: a session stored as 11:00 Dubai must come back as 11:00 and not as 07:00 UTC.
      open: toLocal(window.opensAt as Instant, ASIA_DUBAI).time,
      close: toLocal(window.closesAt as Instant, ASIA_DUBAI).time,
    })
  }
  return (date) => byDate.get(date)
}

export interface SubmitLeaveRequestArgs {
  readonly viewer: PortalViewer
  readonly subjectEmployeeId: string
  readonly kind: string
  readonly from: LocalDate
  readonly to: LocalDate
  readonly reason?: string
  /** The date the submission is made on, which decides the leave year it is charged to. */
  readonly submittedOn: LocalDate
  readonly employedFrom: LocalDate
  /** Trading hours per date, so one reading decides where a leave day ends (`leaveCoveragePeriod`). */
  readonly hoursFor: HoursForDate
  readonly actor: Actor
  /** The label written onto the `leave_movement` row. An audit handle, never a person's name (ADR 0020). */
  readonly createdBy: string
}

export type SubmitLeaveRequestResult =
  | {
      readonly kind: 'submitted'
      readonly leaveRequestId: string
      readonly status: string
      /** Null for a kind that reserves nothing — every kind but annual. See `judgeLeaveSubmission`. */
      readonly reservationMovementId: string | null
      /** Signed day-hundredths as the movement stored them, or 0 when nothing was reserved. */
      readonly reservedHundredths: number
    }
  | {
      readonly kind: 'refused'
      readonly verdict: Extract<LeaveSubmissionVerdict, { kind: 'refused' }>
    }

/**
 * The ONE submission path. Both entry points call this and neither calls `writeLeaveRequest`.
 *
 * ## What it does in one transaction, and why all three must commit together
 *
 * The request row, the `reserved` leave movement and the audit row. 0066 is explicit that a request
 * reserves when it is MADE — approval only makes the reservation final, which is why P-HR-09's approval
 * writes no movement and says so in its header. So a request committed without its reservation is leave a
 * therapist has asked for and still appears to hold, and the next request would be judged against a
 * balance that has not moved. A reservation committed without its request is days deducted for nothing, and
 * `leave_movement` is append-only (ZH001) so nothing can take it back.
 *
 * ## The judgement is `judgeLeaveSubmission`'s and the fence is `assertPortalSubject`'s
 *
 * Two separate questions and they are asked in that order on purpose. The fence is about WHOSE request this
 * is, and it is the one an on-behalf caller is allowed to pass with a wider authority; the judgement is
 * about whether the request is possible at all, and nothing widens that. Asking the judgement first would
 * mean a request for somebody else's leave got as far as reading their balance before being refused.
 *
 * ## On behalf of somebody else
 *
 * `subjectEmployeeId` may differ from the viewer's **only** when the viewer holds `leave:approve`, and the
 * check is `assertOnBehalfAuthority` below rather than `assertPortalSubject`. That is the one place the two
 * paths diverge and it is why they are different functions rather than a flag: the portal's fence has no
 * permission in it by design, and folding an on-behalf case into it would put one there.
 */
export async function submitLeaveRequest(
  sql: Sql,
  args: SubmitLeaveRequestArgs,
): Promise<SubmitLeaveRequestResult> {
  if (args.viewer.employeeId === args.subjectEmployeeId) {
    fence('leave', args.viewer, args.subjectEmployeeId)
  } else {
    assertOnBehalfAuthority(args.viewer, args.subjectEmployeeId)
  }

  const [ruleRows, balances] = await Promise.all([
    readLeaveEntitlementRules(sql),
    readLeaveBalances(sql, [args.subjectEmployeeId]),
  ])
  const rules: LeaveEntitlementRules = leaveRulesFor(
    ruleRows.map(leaveEntitlementRulesFrom),
    args.from,
  )
  const verdict = judgeLeaveSubmission({
    request: { kind: args.kind, from: args.from, to: args.to },
    subject: {
      employedFrom: args.employedFrom,
      // Absent is zero HERE and null on the screen, and the asymmetry is deliberate: a balance nobody has
      // accrued cannot fund annual leave, so the judgement must treat it as nothing, while the screen must
      // not print "0 days" as though a figure had been computed.
      balanceHundredths: balances[0]?.balanceHundredths ?? 0,
    },
    rules,
    submittedOn: args.submittedOn,
  })
  if (verdict.kind === 'refused') return { kind: 'refused', verdict }

  const period = leaveCoveragePeriod({ from: args.from, to: args.to, hoursFor: args.hoursFor })

  return withUnitOfWork(sql, args.actor, async (uow) => {
    const request = await writeLeaveRequest(uow.sql, {
      employeeId: args.subjectEmployeeId,
      kind: verdict.leaveKind,
      startsAt: period.startsAt,
      endsAt: period.endsAt,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
    })
    /*
      The reservation, for ANNUAL leave only.

      `judgeLeaveSubmission` answers zero hundredths for every other kind, and the branch is here rather
      than inside the repository because the repository's job is to write a movement and it refuses a
      non-positive one by name — which is the right refusal for a caller that got the figure wrong, and
      the wrong one for a caller that correctly has nothing to reserve.
    */
    const reservation =
      verdict.hundredths === 0
        ? null
        : await writePortalLeaveReservation(uow, {
            subject: { employeeId: args.subjectEmployeeId },
            leaveRequestId: request.id,
            hundredths: verdict.hundredths,
            occurredOn: args.submittedOn,
            leaveYearStart: verdict.leaveYearStart,
            createdBy: args.createdBy,
          })
    await uow.audit.record({
      action: 'hr.leave_requested',
      entityType: 'leave_request',
      entityId: request.id,
      operation: 'create',
      after: {
        employeeId: args.subjectEmployeeId,
        onBehalf: args.viewer.employeeId !== args.subjectEmployeeId,
        kind: verdict.leaveKind,
        days: verdict.days,
        reservedHundredths: reservation?.hundredths ?? 0,
        leaveYearStart: verdict.leaveYearStart,
      },
    })
    return {
      kind: 'submitted' as const,
      leaveRequestId: request.id,
      status: request.status,
      reservationMovementId: reservation?.movementId ?? null,
      reservedHundredths: reservation?.hundredths ?? 0,
    }
  })
}

/**
 * Filing leave for somebody else needs `leave:approve`, and the refusal names the subject.
 *
 * `leave:approve` and not `employee:write`, because the person who may decide somebody's leave is the
 * person who may file it for them — nineteen employees have no phone on file (0081), so a therapist with no
 * way to reach the portal still has to be able to take a holiday, and a manager typing it in is how that
 * happens. `leave:request` alone is NOT enough: every therapist holds it, and it is what lets them file
 * their OWN.
 */
export function assertOnBehalfAuthority(viewer: PortalViewer, subjectEmployeeId: string): void {
  if (can(viewer.role, 'leave:approve')) return
  throw new AppError(
    'forbidden',
    `on_behalf_requires_leave_approve: role "${viewer.role}" may file its own leave and not somebody ` +
      "else's. Filing for another employee is the authority that decides leave, which the matrix grants " +
      'with leave:approve.',
    {
      details: {
        refusal: 'on_behalf_requires_leave_approve',
        role: viewer.role,
        viewerEmployeeId: viewer.employeeId,
        subjectEmployeeId,
      },
    },
  )
}

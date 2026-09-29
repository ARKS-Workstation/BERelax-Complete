import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Payroll: the tips and deductions a period holds, the runs that pay them, and the exports taken of one.
 *
 * The **arithmetic** is `packages/core/src/hr/payroll.ts`'s and stays there — `packages/db` must never
 * import `packages/core` — so this module returns ROWS and takes computed figures, never a wage conversion
 * or a net it worked out itself. `packages/hr/src/payroll-run.ts` is where the two halves meet, for the
 * reason `packages/hr`'s own header gives, and `packages/fixtures/src/hr-payroll.itest.ts` is where the pair
 * is asserted against a real database.
 *
 * ## What this module deliberately does not read
 *
 * It contains no reader for `timesheet_approval`, `working_hours_rule` or `labour_cost_rule`.
 * `readTimesheetApprovals` (P-HR-07), `readWorkingHoursRules` (P-HR-05) and `readLabourCostRules` (P-HR-06)
 * already exist and the orchestrator calls those. A second reader of a versioned rule table is the defect
 * those tables exist to prevent: two readers eventually disagree about which version governs a date, and the
 * one that disagrees is discovered on a payslip.
 *
 * ## Every read of a payslip is audited, and that is a function here rather than a caller's duty
 *
 * A payslip is somebody's pay, which docs/04 §7 puts in the same sentence as bank details and identity
 * numbers: *"field-level encryption plus separate access control ... with every read audited"*. So
 * {@link readPayslips} takes a `UnitOfWork` and not an `Sql`, and writes the audit row itself. A read
 * function that took a plain connection would be one a caller could use without auditing, and the audit
 * would then be a convention rather than a property — `readEmployeeBankDetail` (P-HR-01) takes the same
 * shape for the same reason.
 *
 * {@link recordWpsExport} uses `recordExport`, which is the INDEXED insider-threat signal: 0005 carries
 * `audit_event_export_idx` on `operation = 'export'` precisely so an unusually large export is cheap to
 * find, and `readCustomerExport` (C-CRM-10) writes one on every call and not only on a bulk one. An export
 * of wages is the most sensitive one in the build.
 *
 * ## What the database enforces without help from here
 *
 *   1. **A completed run is immutable** — `refuse_completed_payroll_run_change` (ZY141), and a draft accepts
 *      only its own completion (ZY142). {@link completePayrollRun} issues the one permitted UPDATE and
 *      nothing here issues another.
 *   2. **A correction names the completed run it corrects** — ZY143, plus
 *      `payroll_run_one_original_per_period`.
 *   3. **A tip is a liability** — `assert_tip_is_owed_as_a_liability` (ZY146). A caller that passed a
 *      revenue account could not store the row.
 *   4. **A payslip's commission names its run and version** — ZY147.
 *   5. **A completed run's header equals its payslips** — ZY150, at the completion UPDATE.
 */

/** The SQLSTATEs `0104_hr_payroll.sql` raises. Subclass range ZY141-ZY150 of the shared 'ZY' class. */
export const PAYROLL_SQLSTATE = {
  /** A completed run was UPDATEd, or any run was DELETEd. */
  runImmutable: 'ZY141',
  /** A draft run was UPDATEd in some way other than being completed. */
  draftMayOnlyBeCompleted: 'ZY142',
  /** A second run over a period does not name the completed run it corrects. */
  correctionUnnamed: 'ZY143',
  /** A payslip, tip, deduction or export row was UPDATEd or DELETEd. */
  recordAppendOnly: 'ZY144',
  /** The period holds an approved timesheet counting an INCOMPLETE presence. */
  attendanceNotClosed: 'ZY145',
  /** A tip names an account whose type is not `liability`. */
  tipIsNotALiability: 'ZY146',
  /** A payslip states a commission figure that names no run and version, or the wrong version. */
  commissionUnpinned: 'ZY147',
  /** A payslip was added to a run that has already been completed. */
  runAlreadyCompleted: 'ZY148',
  /** An export names a run that is not completed, or disagrees with its figures. */
  exportOfADraft: 'ZY149',
  /** A completed run's payslip count or net total disagrees with its payslips. */
  headerDisagreesWithPayslips: 'ZY150',
} as const

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

/**
 * A payroll refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message, and never on the class: the class no
 * longer identifies a file (ADR 0043), so `startsWith('ZY')` would claim five other units' refusals as this
 * one's — which is exactly the failure the registry was built to end.
 */
export function payrollError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = Object.entries(PAYROLL_SQLSTATE).find(([, code]) => code === state)
  if (known === undefined) return null
  const [rule] = known
  return new AppError(
    'invariant_violated',
    error instanceof Error ? error.message : `Payroll rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertIsoDate(value: string, what: string): void {
  if (!ISO_DATE.test(value)) {
    throw new AppError(
      'validation',
      `${what} must be an ISO trading date (YYYY-MM-DD), got "${value}"`,
    )
  }
}

export interface PayrollPeriod {
  readonly periodStartsOn: string
  readonly periodEndsOn: string
}

function assertPeriod(period: PayrollPeriod): void {
  assertIsoDate(period.periodStartsOn, 'periodStartsOn')
  assertIsoDate(period.periodEndsOn, 'periodEndsOn')
}

// ---------------------------------------------------------------------------------------------
// The wages on file
// ---------------------------------------------------------------------------------------------

/** One employee's contractual monthly figures, or the absence of them. */
export interface EmployeeWageRow {
  readonly employeeId: string
  readonly staffReference: string
  /** `employee.basic_wage_fils`. Null when none is on file, which is NOT zero. */
  readonly basicWageFils: number | null
  /** `housing + transport + other`, coalesced to 0 each. Null only when the basic wage is null. */
  readonly allowancesFils: number | null
  readonly employedFrom: string
  readonly employedUntil: string | null
}

/**
 * The wages of everybody employed at any point in a period.
 *
 * The employment test is against the PERIOD and not against today, for `employee.employed_from`'s recorded
 * reason: employment is a period rather than an `is_active` flag, so somebody who left in March is payable
 * for March and not for April, and a flag cannot say that. A `where employed_until is null` read here would
 * silently drop every leaver's final payslip — the one payslip that is most often disputed.
 *
 * `allowancesFils` is summed in SQL with each component coalesced to zero, which mirrors
 * `employee.total_wage_fils`'s generated expression (0050) minus the basic. Not read from
 * `total_wage_fils` itself, because a payslip needs basic and allowances as SEPARATE lines — that column is
 * the sum of both and subtracting one from it would make the two lines depend on each other.
 */
export async function readEmployeeWages(
  sql: Sql,
  period: PayrollPeriod,
): Promise<readonly EmployeeWageRow[]> {
  assertPeriod(period)
  const rows = await sql<
    {
      employeeId: string
      staffReference: string
      basicWageFils: string | null
      allowancesFils: string | null
      employedFrom: string
      employedUntil: string | null
    }[]
  >`
    select id                       as "employeeId",
           staff_reference          as "staffReference",
           basic_wage_fils::text    as "basicWageFils",
           case when basic_wage_fils is null then null
                else (coalesce(housing_allowance_fils, 0)
                      + coalesce(transport_allowance_fils, 0)
                      + coalesce(other_allowance_fils, 0))
           end::text                as "allowancesFils",
           employed_from::text      as "employedFrom",
           employed_until::text     as "employedUntil"
      from employee
     where employed_from <= ${period.periodEndsOn}::date
       and (employed_until is null or employed_until >= ${period.periodStartsOn}::date)
     order by staff_reference
  `
  // `::text` then `Number`, for `weighted_minute_bp`'s reason one module along: the driver hands a bigint
  // back as a string so nothing rounds it, and a bigint on this boundary would make every arithmetic caller
  // a bigint caller. A month of one person's pay cannot reach 2^53, and `computePayslip` refuses a gross
  // that is not a safe integer rather than trusting that.
  return rows.map((row) => ({
    employeeId: row.employeeId,
    staffReference: row.staffReference,
    basicWageFils: row.basicWageFils === null ? null : Number(row.basicWageFils),
    allowancesFils: row.allowancesFils === null ? null : Number(row.allowancesFils),
    employedFrom: row.employedFrom,
    employedUntil: row.employedUntil,
  }))
}

// ---------------------------------------------------------------------------------------------
// Tips
// ---------------------------------------------------------------------------------------------

export interface RecordTipInput {
  readonly employeeId: string
  readonly tradingDate: string
  readonly amountFils: number
  /**
   * The liability account the salon owes it against. Omitted takes the column's default, 2040.
   *
   * Passable at all so a pooled arrangement is expressible without a migration (Y9-tips has not said), and
   * safe to pass because ZY146 refuses anything whose type is not `liability` — including a revenue account,
   * which is what the acceptance criterion is about.
   */
  readonly liabilityAccountCode?: string
  readonly cashSessionId?: string | null
  readonly recordedBy: string
}

/** Records one tip inside `uow`'s transaction, with its audit row. */
export async function recordTip(uow: UnitOfWork, input: RecordTipInput): Promise<string> {
  assertIsoDate(input.tradingDate, 'tradingDate')
  const [row] = await uow.sql<{ id: string }[]>`
    insert into employee_tip (
      employee_id, trading_date, amount_fils, liability_account_code, cash_session_id, recorded_by
    ) values (
      ${input.employeeId}::uuid,
      ${input.tradingDate}::date,
      ${input.amountFils},
      coalesce(${input.liabilityAccountCode ?? null}, '2040'),
      ${input.cashSessionId ?? null}::uuid,
      ${input.recordedBy}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Recording a tip returned no row')
  }
  await uow.audit.record({
    action: 'payroll.tip_recorded',
    entityType: 'employee_tip',
    entityId: row.id,
    operation: 'create',
    after: {
      employeeId: input.employeeId,
      tradingDate: input.tradingDate,
      amountFils: input.amountFils,
    },
  })
  return row.id
}

/** One employee's tips in a period, summed. */
export interface PeriodTotalRow {
  readonly employeeId: string
  readonly totalFils: number
  readonly rowCount: number
}

const toTotals = (rows: readonly { employeeId: string; totalFils: string; rowCount: string }[]) =>
  rows.map((row) => ({
    employeeId: row.employeeId,
    totalFils: Number(row.totalFils),
    rowCount: Number(row.rowCount),
  }))

/**
 * Tips per employee over a period, counted as well as summed.
 *
 * The COUNT is not decoration. A period's tip total of zero and a period with no tip rows are the same
 * number and different facts — `commission_run.module_enabled` records the same distinction for the same
 * reason — and a payslip whose tip line is 0.00 when four tips were recorded against a colleague's id is
 * exactly the sort of thing the count makes visible.
 */
export async function readTipTotals(
  sql: Sql,
  period: PayrollPeriod,
): Promise<readonly PeriodTotalRow[]> {
  assertPeriod(period)
  const rows = await sql<{ employeeId: string; totalFils: string; rowCount: string }[]>`
    select employee_id       as "employeeId",
           sum(amount_fils)::text as "totalFils",
           count(*)::text     as "rowCount"
      from employee_tip
     where trading_date between ${period.periodStartsOn}::date and ${period.periodEndsOn}::date
     group by employee_id
     order by employee_id
  `
  return toTotals(rows)
}

// ---------------------------------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------------------------------

export interface RecordDeductionInput {
  readonly employeeId: string
  readonly tradingDate: string
  readonly amountFils: number
  readonly reason: string
  readonly authorisedBy: string
  readonly recordedBy: string
}

/** Records one authorised deduction inside `uow`'s transaction, with its audit row. */
export async function recordDeduction(
  uow: UnitOfWork,
  input: RecordDeductionInput,
): Promise<string> {
  assertIsoDate(input.tradingDate, 'tradingDate')
  const [row] = await uow.sql<{ id: string }[]>`
    insert into payroll_deduction (
      employee_id, trading_date, amount_fils, reason, authorised_by, recorded_by
    ) values (
      ${input.employeeId}::uuid,
      ${input.tradingDate}::date,
      ${input.amountFils},
      ${input.reason},
      ${input.authorisedBy},
      ${input.recordedBy}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Recording a deduction returned no row')
  }
  await uow.audit.record({
    action: 'payroll.deduction_recorded',
    entityType: 'payroll_deduction',
    entityId: row.id,
    operation: 'create',
    after: {
      employeeId: input.employeeId,
      tradingDate: input.tradingDate,
      amountFils: input.amountFils,
      authorisedBy: input.authorisedBy,
    },
  })
  return row.id
}

/** Deductions per employee over a period, counted as well as summed, for `readTipTotals`'s reason. */
export async function readDeductionTotals(
  sql: Sql,
  period: PayrollPeriod,
): Promise<readonly PeriodTotalRow[]> {
  assertPeriod(period)
  const rows = await sql<{ employeeId: string; totalFils: string; rowCount: string }[]>`
    select employee_id       as "employeeId",
           sum(amount_fils)::text as "totalFils",
           count(*)::text     as "rowCount"
      from payroll_deduction
     where trading_date between ${period.periodStartsOn}::date and ${period.periodEndsOn}::date
     group by employee_id
     order by employee_id
  `
  return toTotals(rows)
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

export interface OpenPayrollRunInput extends PayrollPeriod {
  /** The `labour_cost_rule` version whose divisor prices this run's overtime. Pinned, never resolved later. */
  readonly labourCostRuleEffectiveFrom: string
  /** The completed run this one corrects, or null for a period's first run. */
  readonly correctsRunId?: string | null
  readonly createdBy: string
}

/**
 * Opens a DRAFT run. The header figures are left at zero until {@link completePayrollRun} states them.
 *
 * Deliberately two steps and not one insert carrying the totals. A run is built by computing a payslip per
 * employee, and the totals are only knowable once every payslip exists — so an insert that took them would
 * have to be given figures the caller had computed BEFORE writing the rows they sum, which is the shape in
 * which a header and its rows come to disagree. ZY150 then holds the claim at the moment it is made.
 */
export async function openPayrollRun(uow: UnitOfWork, input: OpenPayrollRunInput): Promise<string> {
  assertPeriod(input)
  assertIsoDate(input.labourCostRuleEffectiveFrom, 'labourCostRuleEffectiveFrom')
  const [row] = await uow.sql<{ id: string }[]>`
    insert into payroll_run (
      period_starts_on, period_ends_on, labour_cost_rule_effective_from, corrects_run_id, created_by
    ) values (
      ${input.periodStartsOn}::date,
      ${input.periodEndsOn}::date,
      ${input.labourCostRuleEffectiveFrom}::date,
      ${input.correctsRunId ?? null}::uuid,
      ${input.createdBy}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Opening a payroll run returned no row')
  }
  await uow.audit.record({
    action: 'payroll.run_opened',
    entityType: 'payroll_run',
    entityId: row.id,
    operation: 'create',
    after: {
      periodStartsOn: input.periodStartsOn,
      periodEndsOn: input.periodEndsOn,
      correctsRunId: input.correctsRunId ?? null,
    },
  })
  return row.id
}

export interface PayslipToRecord {
  readonly employeeId: string
  readonly basicFils: number
  readonly allowancesFils: number
  readonly overtimeFils: number
  readonly commissionFils: number
  readonly commissionRunId: string | null
  readonly commissionRuleVersion: number | null
  readonly tipsFils: number
  readonly deductionsFils: number
  readonly timesheetApprovalId: string
  readonly payableMinutes: number
  readonly overtimeUpliftMinuteBp: number
}

/**
 * Writes one payslip. `gross_fils` and `net_fils` are NOT passed and cannot be: they are generated columns.
 *
 * That is the point of them being generated rather than checked. A caller cannot supply a net at all, so
 * there is no statement anybody can write in which the net disagrees with the lines above it — which is
 * stronger than a CHECK comparing two columns, because a CHECK still lets a wrong pair of numbers be
 * offered and only refuses the ones it can see are wrong.
 */
export async function recordPayslip(
  uow: UnitOfWork,
  runId: string,
  payslip: PayslipToRecord,
): Promise<string> {
  const [row] = await uow.sql<{ id: string; netFils: string }[]>`
    insert into payslip (
      run_id, employee_id, basic_fils, allowances_fils, overtime_fils, commission_fils, tips_fils,
      deductions_fils, commission_run_id, commission_rule_version, timesheet_approval_id,
      payable_minutes, overtime_uplift_minute_bp
    ) values (
      ${runId}::uuid,
      ${payslip.employeeId}::uuid,
      ${payslip.basicFils},
      ${payslip.allowancesFils},
      ${payslip.overtimeFils},
      ${payslip.commissionFils},
      ${payslip.tipsFils},
      ${payslip.deductionsFils},
      ${payslip.commissionRunId}::uuid,
      ${payslip.commissionRuleVersion},
      ${payslip.timesheetApprovalId}::uuid,
      ${payslip.payableMinutes},
      ${payslip.overtimeUpliftMinuteBp}
    )
    returning id, net_fils::text as "netFils"
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Recording a payslip returned no row')
  }
  await uow.audit.record({
    action: 'payroll.payslip_recorded',
    entityType: 'payslip',
    entityId: row.id,
    operation: 'create',
    after: { runId, employeeId: payslip.employeeId, netFils: Number(row.netFils) },
  })
  return row.id
}

export interface CompletePayrollRunInput {
  readonly runId: string
  readonly payslipCount: number
  readonly netTotalFils: number
  readonly unpricedEmployeeCount: number
  readonly completedBy: string
}

/**
 * Completes a run: the ONE UPDATE this schema permits against `payroll_run`.
 *
 * The three header figures are set in the SAME statement that sets `completed_at`, and that is required
 * rather than convenient. `refuse_payroll_run_draft_edit` (ZY142) carries two allow-lists: a COMPLETING
 * update may set `completed_at`, `completed_by` and the three header figures, and any other update of a
 * draft may change nothing but `updated_at`. So there is no statement that writes the header without
 * completing the run — which is what makes ZY150's check, on this same statement, the only moment the header
 * is ever stated. A run whose totals could be written while it stayed open could have them written before
 * the payslips they sum.
 *
 * This is also where the unit's one self-inflicted defect was found: the first version of ZY142 permitted
 * only the two completion columns, so this statement was refused by the trigger meant to allow it. Nothing
 * had exercised the pair yet, and the symptom would have been a payroll run that could be built and never
 * finished.
 *
 * `and completed_at is null` in the WHERE clause is not the guard — ZY141 is — but it turns the race into a
 * zero-row answer this function can explain, rather than a SQLSTATE a caller has to translate.
 */
export async function completePayrollRun(
  uow: UnitOfWork,
  input: CompletePayrollRunInput,
): Promise<void> {
  const rows = await uow.sql`
    update payroll_run
       set payslip_count           = ${input.payslipCount},
           net_total_fils          = ${input.netTotalFils},
           unpriced_employee_count = ${input.unpricedEmployeeCount},
           completed_at            = now(),
           completed_by            = ${input.completedBy}
     where id = ${input.runId}::uuid
       and completed_at is null
    returning id
  `
  if (rows.length === 0) {
    throw new AppError(
      'conflict',
      `Payroll run ${input.runId} is not an open draft, so it cannot be completed. Either it does not ` +
        'exist or it has already been completed — and a completed run is immutable (ZY141): correct it ' +
        'with a NEW run naming it.',
    )
  }
  await uow.audit.record({
    action: 'payroll.run_completed',
    entityType: 'payroll_run',
    entityId: input.runId,
    operation: 'update',
    after: {
      payslipCount: input.payslipCount,
      netTotalFils: input.netTotalFils,
      unpricedEmployeeCount: input.unpricedEmployeeCount,
    },
  })
}

export interface PayrollRunRow {
  readonly runId: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly labourCostRuleEffectiveFrom: string
  readonly correctsRunId: string | null
  readonly payslipCount: number
  readonly netTotalFils: number
  readonly unpricedEmployeeCount: number
  readonly completedAt: Date | null
  readonly completedBy: string | null
  readonly createdAt: Date
  readonly createdBy: string
}

/** Runs overlapping a period, newest first. A bounded read: see the commission screen's reason. */
export async function readPayrollRuns(
  sql: Sql,
  period: PayrollPeriod,
): Promise<readonly PayrollRunRow[]> {
  assertPeriod(period)
  const rows = await sql<(Omit<PayrollRunRow, 'netTotalFils'> & { netTotalFils: string })[]>`
    select id                                   as "runId",
           period_starts_on::text               as "periodStartsOn",
           period_ends_on::text                 as "periodEndsOn",
           labour_cost_rule_effective_from::text as "labourCostRuleEffectiveFrom",
           corrects_run_id                      as "correctsRunId",
           payslip_count                        as "payslipCount",
           net_total_fils::text                 as "netTotalFils",
           unpriced_employee_count              as "unpricedEmployeeCount",
           completed_at                         as "completedAt",
           completed_by                         as "completedBy",
           created_at                           as "createdAt",
           created_by                           as "createdBy"
      from payroll_run
     where period_starts_on <= ${period.periodEndsOn}::date
       and period_ends_on   >= ${period.periodStartsOn}::date
     order by created_at desc
  `
  return rows.map((row) => ({ ...row, netTotalFils: Number(row.netTotalFils) }))
}

// ---------------------------------------------------------------------------------------------
// The payslips, and the audit row every read of one writes
// ---------------------------------------------------------------------------------------------

export interface PayslipRow {
  readonly payslipId: string
  readonly runId: string
  readonly employeeId: string
  readonly staffReference: string
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  readonly runCompletedAt: Date | null
  readonly basicFils: number
  readonly allowancesFils: number
  readonly overtimeFils: number
  readonly commissionFils: number
  readonly tipsFils: number
  readonly grossFils: number
  readonly deductionsFils: number
  readonly netFils: number
  readonly commissionRunId: string | null
  readonly commissionRuleVersion: number | null
  readonly timesheetApprovalId: string
  readonly payableMinutes: number
  readonly overtimeUpliftMinuteBp: number
  readonly workingHoursRuleEffectiveFrom: string
  readonly labourCostRuleEffectiveFrom: string
}

const MONEY_COLUMNS = [
  'basicFils',
  'allowancesFils',
  'overtimeFils',
  'commissionFils',
  'tipsFils',
  'grossFils',
  'deductionsFils',
  'netFils',
  'overtimeUpliftMinuteBp',
] as const

/**
 * The payslips of one run, optionally narrowed to one employee, with the read audited.
 *
 * Takes a `UnitOfWork` and not an `Sql`, so the audit row and the read share a transaction and there is no
 * shape of this call that does not write one. `readEmployeeBankDetail` (P-HR-01) takes the same shape and the
 * reason is the same: docs/04 §7 puts salary beside bank details and identity numbers, "with every read
 * audited", and a read function taking a plain connection makes that a convention a caller can forget.
 *
 * **`employeeId` is an ARGUMENT and the authorisation is not here.** Whether a viewer may read a given
 * employee's payslip is `mayReadPayslip` in `@berelax/core`, applied by `readPayslipFor` in `@berelax/hr` —
 * the same division P-HR-11 made, and for the reason its route records: a `?employee=` parameter is refused
 * across the whole of `apps/web` by `admin-guard.test.ts`, so the refusal has to live at the FUNCTION
 * boundary where a payroll run reading a derivation for an employee it names also hits it.
 *
 * The audit row names the ACTOR (from the unit of work) and the ROW COUNT, which is the acceptance
 * criterion's wording. The count is on a read and not only on an export because a screen that pages through
 * every payslip one at a time is the shape a bulk read takes when somebody is being careful.
 */
export async function readPayslips(
  uow: UnitOfWork,
  args: { readonly runId: string; readonly employeeId?: string },
): Promise<readonly PayslipRow[]> {
  const rows = await uow.sql<Record<string, string | number | Date | null>[]>`
    select payslip_id                            as "payslipId",
           run_id                                as "runId",
           employee_id                           as "employeeId",
           staff_reference                       as "staffReference",
           period_starts_on::text                as "periodStartsOn",
           period_ends_on::text                  as "periodEndsOn",
           run_completed_at                      as "runCompletedAt",
           basic_fils::text                      as "basicFils",
           allowances_fils::text                 as "allowancesFils",
           overtime_fils::text                   as "overtimeFils",
           commission_fils::text                 as "commissionFils",
           tips_fils::text                       as "tipsFils",
           gross_fils::text                      as "grossFils",
           deductions_fils::text                 as "deductionsFils",
           net_fils::text                        as "netFils",
           commission_run_id                     as "commissionRunId",
           commission_rule_version               as "commissionRuleVersion",
           timesheet_approval_id                 as "timesheetApprovalId",
           payable_minutes                       as "payableMinutes",
           overtime_uplift_minute_bp::text       as "overtimeUpliftMinuteBp",
           working_hours_rule_effective_from::text as "workingHoursRuleEffectiveFrom",
           labour_cost_rule_effective_from::text as "labourCostRuleEffectiveFrom"
      from payslip_detail
     where run_id = ${args.runId}::uuid
       and (${args.employeeId ?? null}::uuid is null or employee_id = ${args.employeeId ?? null}::uuid)
     order by staff_reference
  `

  /*
    The audit row is written whatever the read returned, INCLUDING zero rows.

    A read that found nothing is still a read: somebody asked for somebody's pay and was told there is none,
    and the attempt is the thing an insider-threat review looks at. Auditing only non-empty reads would make
    enumeration — one request per employee id until one answers — the one access pattern that leaves no
    trace.
  */
  await uow.audit.record({
    action: 'payroll.payslips_read',
    entityType: 'payslip',
    entityId: args.runId,
    operation: 'read',
    after: { runId: args.runId, employeeId: args.employeeId ?? null, rowCount: rows.length },
  })

  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row }
    for (const key of MONEY_COLUMNS) out[key] = Number(row[key])
    return out as unknown as PayslipRow
  })
}

// ---------------------------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------------------------

export interface RecordWpsExportInput {
  readonly runId: string
  readonly format: string
  readonly recordCount: number
  readonly totalFils: number
  /** sha256 of the bytes, lower-case hex. The database refuses anything that is not 64 hex characters. */
  readonly fileSha256: string
  readonly exportedBy: string
}

/**
 * Records that a WPS file left the building, with the INDEXED insider-threat audit row.
 *
 * `recordExport` and not `record`, always, and not only for a large file: 0005 carries
 * `audit_event_export_idx on audit_event (occurred_at desc) where operation = 'export'` precisely so an
 * unusual export is cheap to find, and an entry that used the generic `record` would be absent from the one
 * index anybody reviewing insider access reads. `readCustomerExport` (C-CRM-10) states the same rule in the
 * same words, and an export of wages is the most sensitive one in this build.
 */
export async function recordWpsExport(
  uow: UnitOfWork,
  input: RecordWpsExportInput,
): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into wps_export (run_id, format, record_count, total_fils, file_sha256, exported_by)
    values (
      ${input.runId}::uuid,
      ${input.format},
      ${input.recordCount},
      ${input.totalFils},
      ${input.fileSha256},
      ${input.exportedBy}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Recording a WPS export returned no row')
  }
  await uow.audit.recordExport('wps_export', input.recordCount, 'payroll.wps_file_exported')
  return row.id
}

export interface WpsExportRow {
  readonly exportId: string
  readonly runId: string
  readonly format: string
  readonly recordCount: number
  readonly totalFils: number
  readonly fileSha256: string
  readonly exportedBy: string
  readonly exportedAt: Date
}

/** Every export taken of one run, newest first. The evidence of what was actually sent. */
export async function readWpsExports(sql: Sql, runId: string): Promise<readonly WpsExportRow[]> {
  const rows = await sql<(Omit<WpsExportRow, 'totalFils'> & { totalFils: string })[]>`
    select id            as "exportId",
           run_id        as "runId",
           format,
           record_count  as "recordCount",
           total_fils::text as "totalFils",
           file_sha256   as "fileSha256",
           exported_by   as "exportedBy",
           exported_at   as "exportedAt"
      from wps_export
     where run_id = ${runId}::uuid
     order by exported_at desc
  `
  return rows.map((row) => ({ ...row, totalFils: Number(row.totalFils) }))
}

import { createHash } from 'node:crypto'
import {
  type ApprovedTimesheet,
  assertAttendanceIsComplete,
  assertMayReadPayslip,
  computePayslip,
  labourCostRulesFor,
  localDate,
  overtimeUpliftMinuteBp,
  type PayrollSummary,
  type Payslip,
  priceOvertimeUplift,
  type Role,
  renderWpsSif,
  summarisePayroll,
  validateWpsFile,
  type WpsDetailRecord,
  type WpsFile,
  type WpsSifFormat,
  type WpsValidationFailure,
} from '@berelax/core'
import {
  type Actor,
  completePayrollRun,
  type EmployeeWageRow,
  openPayrollRun,
  type PayrollRunRow,
  type PayslipRow,
  readCommissionDerivation,
  readDeductionTotals,
  readEmployeeWages,
  readLabourCostRules,
  readPayrollRuns,
  readPayslips,
  readTimesheetApprovals,
  readTipTotals,
  readWorkingHoursRules,
  recordPayslip,
  recordWpsExport,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The payroll run: where `@berelax/core`'s arithmetic meets `@berelax/db`'s rows, and where every figure is
 * READ from what decided it rather than judged again.
 *
 * `packages/db` may never import `packages/core` (brief rule 4), so neither package can perform a run on its
 * own — the repositories read approvals, wages, tips and deductions, the engine turns them into payslips, and
 * something has to hold both. `packages/hr` already depends on both for P-HR-01's reason, which makes it the
 * right home; the alternative is a second copy of the arithmetic inside `packages/db`, and two
 * implementations of a money formula is two chances to get the rounding wrong.
 *
 * ## Four pins, and none of them is optional
 *
 * Every figure a payslip prints comes off something already decided, and the reason is one sentence: a
 * payslip is the document somebody disputes, and the dispute is never about the arithmetic. It is about a
 * figure that moved.
 *
 *   1. **Commission** comes off a `commission_run` this function is GIVEN, never one it resolves. P-HR-11's
 *      `readCommissionDerivationFor` is the read, and the run's `ruleVersion` is snapshotted onto the
 *      payslip. There is no code path here that calls `computeCommission`.
 *   2. **Hours** come off `timesheet_approval`. Nothing here pairs a punch or splits a minute.
 *   3. **The overtime multipliers** come off the `working_hours_rule` version the APPROVAL snapshotted, so
 *      the ordinary multiplier the uplift is measured against is March's when March is paid.
 *   4. **The monthly-wage divisor** comes off a `labour_cost_rule` version pinned on the run, so a run
 *      reproduced next year prices its overtime at the divisor that priced it the first time.
 *
 * ## Why {@link executePayrollRun} takes the commission run as an argument
 *
 * It could read "the newest commission run over this period" itself, and that is the version of this function
 * that goes wrong. Which commission run a payroll run pays is a DECISION — a month may have been recomputed
 * three times, and the one that was paid is not necessarily the newest — so it is the caller's to state and
 * the payslip's to record. A function that picked one would make the payslip's pin true and its provenance a
 * guess, which is the same defect as recomputing, one level up.
 *
 * ## The export is a separate function, and there is no submit path in either
 *
 * {@link exportWpsFile} returns a STRING and records that it did. It makes no network call, and there is no
 * bank SDK, endpoint or URL anywhere in this repository — absent, not disabled, which is docs/04 §4's rule
 * for VAT201 applied where the consequence is larger. `packages/fixtures/src/wps-no-submission.test.ts` is
 * the scan that keeps it absent.
 */

/** The commission run a payroll run pays from, as the caller states it. */
export interface CommissionRunPin {
  readonly runId: string
  readonly ruleVersion: number
}

export interface ExecutePayrollRunArgs {
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  /**
   * The commission run whose lines this payroll pays, or null when there is none.
   *
   * Null is the ORDINARY state today: `hr.commission_enabled` is `false` and no `commission_rule` version is
   * published (Y9-commission), so there is nothing to pay and every payslip carries a zero commission with
   * no run named — which `assert_payslip_commission_is_pinned` (ZY147) requires to be written exactly that
   * way, because a zero naming a run would claim a run was read.
   */
  readonly commissionRun: CommissionRunPin | null
  /** The completed run this one corrects, or null for a period's first run. */
  readonly correctsRunId?: string | null
  readonly actor: Actor
  readonly runBy: string
}

export interface PayrollRunResult {
  readonly runId: string
  readonly summary: PayrollSummary
  /** Employees employed in the period with no wage on file. Counted and NAMED, never paid as zero. */
  readonly unpricedEmployeeIds: readonly string[]
  /** Employees employed in the period with no approved timesheet. Named for the same reason. */
  readonly unapprovedEmployeeIds: readonly string[]
  readonly labourCostRuleEffectiveFrom: string
}

/** Sums a per-employee total list into a map, so a missing employee reads as zero rather than undefined. */
function totalsByEmployee(
  rows: readonly { readonly employeeId: string; readonly totalFils: number }[],
): Map<string, number> {
  return new Map(rows.map((row) => [row.employeeId, row.totalFils]))
}

/**
 * Computes and completes one payroll run over one period.
 *
 * The order is load-bearing and is the same argument `render-document.ts` makes about bytes: every refusal
 * happens BEFORE anything is written. `assertAttendanceIsComplete` and `computePayslip` both throw, and a
 * run that has opened and then thrown would leave a draft nobody asked for — which a later run over the
 * period would collide with through `payroll_run_one_original_per_period`, and the operator would be told
 * their period already had a run.
 *
 * So: read everything, compute every payslip, and only then open the run, write them and complete it. All
 * three writes share one transaction, so a run that exists is a run that is complete and reconciled — ZY150
 * fires on the completing statement, inside the same transaction, and a header that disagreed would take the
 * payslips down with it.
 */
export async function executePayrollRun(
  sql: Sql,
  args: ExecutePayrollRunArgs,
): Promise<PayrollRunResult> {
  const period = { periodStartsOn: args.periodStartsOn, periodEndsOn: args.periodEndsOn }

  const [wages, approvals, tipRows, deductionRows, labourRules, hoursRules] = await Promise.all([
    readEmployeeWages(sql, period),
    readTimesheetApprovals(sql, {
      fromTradingDate: args.periodStartsOn,
      toTradingDate: args.periodEndsOn,
    }),
    readTipTotals(sql, period),
    readDeductionTotals(sql, period),
    readLabourCostRules(sql),
    readWorkingHoursRules(sql),
  ])

  /*
    The attendance refusal, before any arithmetic.

    The `IncompletePresenceRef` list is empty here and that is deliberate rather than a gap: the specific
    `attendance_event` ids come from `incompletePresencesOf` over `summariseTimesheet`'s variances, which
    needs the punches and the rostered spans for the period — a read a payroll run has no other use for. A
    caller that has them (the screen, which shows the variance table anyway) passes them to
    `assertAttendanceIsComplete` directly and gets the ids in the message; this path gets the approval rows,
    which is what the database's own ZY145 can name too. The count is the same refusal either way, and the
    message says which of the two it is.
  */
  const timesheets: readonly ApprovedTimesheet[] = approvals.map((row) => ({
    timesheetApprovalId: row.id,
    employeeId: row.employeeId,
    fromTradingDate: localDate(row.fromTradingDate),
    toTradingDate: localDate(row.toTradingDate),
    payableMinutes: row.payableMinutes,
    weightedMinuteBp: row.weightedMinuteBp,
    incompletePresenceCount: row.incompletePresenceCount,
    workingHoursRuleEffectiveFrom: localDate(row.workingHoursRuleEffectiveFrom),
  }))
  assertAttendanceIsComplete({ timesheets, incomplete: [] })

  // The divisor version that prices this run's overtime, resolved ONCE against the period end and then
  // pinned on the run. Resolved against the end rather than the start because the run pays a period and is
  // dated at its close, which is the same date `payroll_run_period_guard` tests against the lock.
  const rules = labourCostRulesFor(
    labourRules.map((row) => ({
      effectiveFrom: localDate(row.effectiveFrom),
      monthlyWageDaysDivisor: row.monthlyWageDaysDivisor,
      paidMinutesPerDay: row.paidMinutesPerDay,
    })),
    localDate(args.periodEndsOn),
  )

  const ordinaryMultiplierByVersion = new Map(
    hoursRules.map((row) => [row.effectiveFrom, row.ordinaryMultiplierBp]),
  )
  const tips = totalsByEmployee(tipRows)
  const deductions = totalsByEmployee(deductionRows)
  const approvalByEmployee = new Map(timesheets.map((sheet) => [sheet.employeeId, sheet]))

  const payslips: Payslip[] = []
  const toWrite: {
    readonly payslip: Payslip
    readonly timesheetApprovalId: string
    readonly payableMinutes: number
    readonly upliftMinuteBp: number
  }[] = []
  const unpriced: string[] = []
  const unapproved: string[] = []

  for (const wage of wages) {
    const sheet = approvalByEmployee.get(wage.employeeId)
    if (sheet === undefined) {
      /*
        No approved timesheet: NOT paid, and named.

        The tempting alternative is to pay the monthly basic anyway, since a monthly wage does not depend on
        attendance. It is wrong for a reason that is about evidence rather than arithmetic: the manifest's
        summary is "a run over APPROVED timesheets", and a payslip with no approval behind it has nothing
        pinned to it — `payslip.timesheet_approval_id` is NOT NULL precisely so a figure cannot come from
        nowhere. So the employee is named and the operator approves the timesheet.
      */
      unapproved.push(wage.employeeId)
      continue
    }
    if (wage.basicWageFils === null || wage.allowancesFils === null) {
      // Counted and named, never paid as zero. All nineteen seeded employees are in this state (Y8-staff),
      // so a run that treated an absent wage as zero would pay nineteen payslips of 0.00 AED and every
      // figure on the screen would reconcile.
      unpriced.push(wage.employeeId)
      continue
    }

    const ordinaryMultiplierBp = ordinaryMultiplierByVersion.get(
      String(sheet.workingHoursRuleEffectiveFrom),
    )
    if (ordinaryMultiplierBp === undefined) {
      throw new AppError(
        'invariant_violated',
        `Timesheet approval ${sheet.timesheetApprovalId} was measured against working_hours_rule version ` +
          `${sheet.workingHoursRuleEffectiveFrom}, which is not among the published versions. The ` +
          'approval snapshots the version as a plain date (0086, for 0081’s reason), so a missing row ' +
          'means the rule table was emptied — and the ordinary multiplier the uplift is measured against ' +
          'is not something to substitute a default for.',
      )
    }

    const upliftMinuteBp = overtimeUpliftMinuteBp({
      payableMinutes: sheet.payableMinutes,
      weightedMinuteBp: sheet.weightedMinuteBp,
      ordinaryMultiplierBp,
    })
    const overtimeFils = priceOvertimeUplift({
      basicWageFils: wage.basicWageFils,
      upliftMinuteBp,
      rules,
    })

    const commissionFils =
      args.commissionRun === null
        ? 0
        : (
            await readCommissionDerivation(sql, {
              runId: args.commissionRun.runId,
              employeeId: wage.employeeId,
            })
          ).reduce((total, line) => total + line.commissionFils, 0)

    const payslip = computePayslip({
      employeeId: wage.employeeId,
      basicWageFils: wage.basicWageFils,
      allowancesFils: wage.allowancesFils,
      overtimeFils,
      commission: {
        fils: commissionFils,
        // Zero commission names NO run, even when a run was read: ZY147 refuses a zero that names one,
        // because naming a run claims one produced nothing for this employee — a different fact from the
        // module being disabled, and the two must not be written the same way.
        runId: commissionFils === 0 ? null : (args.commissionRun?.runId ?? null),
        ruleVersion: commissionFils === 0 ? null : (args.commissionRun?.ruleVersion ?? null),
      },
      tipsFils: tips.get(wage.employeeId) ?? 0,
      deductionsFils: deductions.get(wage.employeeId) ?? 0,
    })
    payslips.push(payslip)
    toWrite.push({
      payslip,
      timesheetApprovalId: sheet.timesheetApprovalId,
      payableMinutes: sheet.payableMinutes,
      upliftMinuteBp,
    })
  }

  // The identity, asserted before anything is written. `summarisePayroll` throws if any payslip's components
  // do not sum to its gross, or if the run's totals do not follow from the payslips.
  const summary = summarisePayroll(payslips)

  const runId = await withUnitOfWork(sql, args.actor, async (uow) => {
    const id = await openPayrollRun(uow, {
      periodStartsOn: args.periodStartsOn,
      periodEndsOn: args.periodEndsOn,
      labourCostRuleEffectiveFrom: String(rules.effectiveFrom),
      correctsRunId: args.correctsRunId ?? null,
      createdBy: args.runBy,
    })
    for (const entry of toWrite) {
      await recordPayslip(uow, id, {
        employeeId: entry.payslip.employeeId,
        basicFils: entry.payslip.basicFils,
        allowancesFils: entry.payslip.allowancesFils,
        overtimeFils: entry.payslip.overtimeFils,
        commissionFils: entry.payslip.commissionFils,
        commissionRunId: entry.payslip.commissionRunId,
        commissionRuleVersion: entry.payslip.commissionRuleVersion,
        tipsFils: entry.payslip.tipsFils,
        deductionsFils: entry.payslip.deductionsFils,
        timesheetApprovalId: entry.timesheetApprovalId,
        payableMinutes: entry.payableMinutes,
        overtimeUpliftMinuteBp: entry.upliftMinuteBp,
      })
    }
    await completePayrollRun(uow, {
      runId: id,
      payslipCount: summary.payslipCount,
      netTotalFils: summary.netTotalFils,
      unpricedEmployeeCount: unpriced.length,
      completedBy: args.runBy,
    })
    return id
  })

  return {
    runId,
    summary,
    unpricedEmployeeIds: [...unpriced].sort(),
    unapprovedEmployeeIds: [...unapproved].sort(),
    labourCostRuleEffectiveFrom: String(rules.effectiveFrom),
  }
}

/**
 * One employee's payslips from a run, refused when the viewer may not read them.
 *
 * The refusal happens BEFORE the read and not by filtering it, which is `readCommissionDerivationFor`'s
 * decision and its words: a filtered read of somebody else's payslip returns an empty list, which reads as
 * "no payslip" rather than as "not yours" — and a therapist told they have no payslip is a worse answer than
 * a therapist told they may not look.
 *
 * It takes a `UnitOfWork` because `readPayslips` does: the audit row and the read share a transaction, so
 * there is no shape of this call that does not write one.
 */
export async function readPayslipFor(
  sql: Sql,
  args: {
    readonly runId: string
    readonly role: Role
    readonly viewerEmployeeId: string
    readonly subjectEmployeeId: string
    readonly actor: Actor
  },
): Promise<readonly PayslipRow[]> {
  assertMayReadPayslip({
    role: args.role,
    viewerEmployeeId: args.viewerEmployeeId,
    subjectEmployeeId: args.subjectEmployeeId,
  })
  return withUnitOfWork(sql, args.actor, (uow) =>
    readPayslips(uow, { runId: args.runId, employeeId: args.subjectEmployeeId }),
  )
}

/**
 * Where the IBAN and the contact number come from, as an injected port.
 *
 * A PORT and not a direct call to `createEmployeeRepository`, for two reasons and the second decided it.
 * Opening a sealed bank payload needs the staff KEK, and a payroll orchestrator that read the environment
 * for one would make this module untestable without key material. And the contact number has NO source at
 * all — there is no phone column on `employee` (see `WpsDetailRecord.phone`) — so the shape of the port is
 * where that absence is visible, rather than being hidden inside a query that returns null.
 *
 * The production wiring supplies `readBankDetail` from `EmployeeRepository`, which writes one audited read
 * per employee. That is the right cost: an export of everybody's bank details SHOULD leave one audit row per
 * account, not one for the file.
 */
export interface WpsContactSource {
  contactFor(employeeId: string): Promise<{
    readonly iban: string | null
    readonly phone: string | null
  }>
}

export interface ExportWpsFileArgs {
  readonly runId: string
  readonly format: WpsSifFormat
  /** The employer identifier, from the settings registry. Unset or pending, and the file is refused. */
  readonly employerId: string
  readonly agentId: string
  readonly contacts: WpsContactSource
  readonly actor: Actor
  readonly exportedBy: string
}

export interface WpsExportResult {
  /** The bytes-to-be. This function makes no network call; nothing in this repository can send them. */
  readonly content: string
  readonly fileSha256: string
  readonly exportId: string
  readonly recordCount: number
  readonly totalFils: number
}

/**
 * Builds a WPS file from a COMPLETED run, records that it was taken, and returns the bytes.
 *
 * Refuses before producing anything, twice over: `renderWpsSif` throws `WpsFileRefused` carrying every rule
 * that failed, and the database refuses an export of a run that was never completed (ZY149). Two layers
 * because they catch different things — the first is about the file's CONTENTS and the second about the
 * run's STATE, and neither can see the other's subject.
 *
 * {@link validateWpsFile} is also exported from `@berelax/core` and is what a screen calls to LIST the
 * refusals without producing bytes, so an operator sees all four bad IBANs at once rather than one per
 * attempt.
 */
export async function exportWpsFile(sql: Sql, args: ExportWpsFileArgs): Promise<WpsExportResult> {
  const [run] = await readPayrollRunById(sql, args.runId)
  if (run === undefined) {
    throw new AppError('not_found', `Payroll run ${args.runId} does not exist.`)
  }
  if (run.completedAt === null) {
    throw new AppError(
      'conflict',
      `Payroll run ${args.runId} has not been completed, so no WPS file may be taken of it. The bytes ` +
        'carry no draft flag a bank would read, so a file of a draft is indistinguishable from a real ' +
        'payment instruction. ZY149 refuses the export row as well.',
    )
  }

  const payslips = await withUnitOfWork(sql, args.actor, (uow) =>
    readPayslips(uow, { runId: args.runId }),
  )

  const records: WpsDetailRecord[] = []
  for (const slip of payslips) {
    const contact = await args.contacts.contactFor(slip.employeeId)
    records.push({
      employeeId: slip.employeeId,
      // The internal handle, never a name: nineteen employment records have none (ADR 0020, brief rule 10),
      // and the name on a work permit is a third thing again that nothing here holds.
      staffReference: slip.staffReference,
      // An absent account becomes the empty string, which `wps_iban_malformed` refuses by name. Not
      // substituted, not skipped: a payslip silently dropped from the file is somebody not paid, and the
      // count would then disagree with the run (`wps_record_count_disagrees`) for a reason nobody could see.
      iban: contact.iban ?? '',
      phone: contact.phone,
      netFils: slip.netFils,
      payableMinutes: slip.payableMinutes,
    })
  }

  const file: WpsFile = {
    header: {
      format: args.format,
      employerId: args.employerId,
      agentId: args.agentId,
      periodStartsOn: run.periodStartsOn,
      periodEndsOn: run.periodEndsOn,
      // The RUN's own figures, not the file's. That is what makes `wps_record_count_disagrees` and
      // `wps_total_disagrees` real rules rather than tautologies: they compare the run's claim with the
      // rows, and a run and a file that disagree is the disagreement worth catching.
      declaredRecordCount: run.payslipCount,
      declaredTotalFils: run.netTotalFils,
    },
    records,
  }

  const content = renderWpsSif(file)
  const fileSha256 = createHash('sha256').update(content, 'utf8').digest('hex')

  const exportId = await withUnitOfWork(sql, args.actor, (uow) =>
    recordWpsExport(uow, {
      runId: args.runId,
      format: args.format,
      recordCount: run.payslipCount,
      totalFils: run.netTotalFils,
      fileSha256,
      exportedBy: args.exportedBy,
    }),
  )

  return {
    content,
    fileSha256,
    exportId,
    recordCount: run.payslipCount,
    totalFils: run.netTotalFils,
  }
}

/** The one run, by id. A narrow read over `readPayrollRuns` rather than a second query for one row. */
async function readPayrollRunById(sql: Sql, runId: string): Promise<readonly PayrollRunRow[]> {
  const rows = await sql<{ periodStartsOn: string; periodEndsOn: string }[]>`
    select period_starts_on::text as "periodStartsOn", period_ends_on::text as "periodEndsOn"
      from payroll_run where id = ${runId}::uuid
  `
  const bounds = rows[0]
  if (bounds === undefined) return []
  const runs = await readPayrollRuns(sql, {
    periodStartsOn: bounds.periodStartsOn,
    periodEndsOn: bounds.periodEndsOn,
  })
  return runs.filter((run) => run.runId === runId)
}

export type { EmployeeWageRow, WpsValidationFailure }
/** Re-exported so a caller validating a file before exporting it uses the same function the export does. */
export { validateWpsFile }

import { AppError } from '@berelax/shared'
import { can, type Role } from '../access/permissions.ts'
import type { LocalDate } from '../time.ts'
import type { AttendanceVariance } from './attendance.ts'
import { filsForWeightedMinuteBp, type LabourCostRules } from './labour-cost.ts'

/**
 * The payslip: integer fils, and every figure read from a version that has already been decided. Pure.
 *
 * ## What this module refuses to do, and why that is the whole unit
 *
 * A payslip is the one document in this build that somebody will dispute. The dispute is never "is the
 * arithmetic right" — arithmetic is easy and this module's is six additions and one subtraction. It is
 * always **"why is this figure different from the one I was told"**, and every way that happens is a
 * recomputation at the wrong moment against rules that have since moved:
 *
 *   - **Commission.** The figure comes off a commission RUN that has already been recorded, pinned by
 *     `commission_run_id` and its `rule_version`, and it is never recomputed here. P-HR-11 built a whole
 *     migration to make a run reproducible; a payslip that called `computeCommission` again would throw
 *     that away, because it would resolve "the rule in force" and a rate published in June would restate
 *     March. {@link PayslipInput.commission} therefore takes the run's id and version beside the figure,
 *     and {@link assertCommissionIsPinned} refuses a non-zero commission that names neither.
 *   - **Overtime.** The uplift is priced from `timesheet_approval`'s own `weighted_minute_bp` against the
 *     `working_hours_rule` version that approval SNAPSHOTTED, never against today's multipliers. P-HR-07
 *     stored `working_hours_rule_effective_from` on the approval row precisely so this read has a version
 *     to use, and {@link overtimeUpliftMinuteBp} takes `ordinaryMultiplierBp` as an argument rather than
 *     reaching for a constant — there is no literal `10000` in this file to reach for.
 *   - **Hours.** Nothing here pairs a punch or splits a minute. `payableMinutes` and `weightedMinuteBp`
 *     are the approved figures, and re-deriving them would be a second reader of attendance that
 *     disagrees with the approval on the one day it mattered.
 *
 * The rule the three share: **read the version that judged a figure; do not judge it again.**
 *
 * ## The monthly wage is paid AS a monthly wage, and overtime is the UPLIFT only
 *
 * This is the one modelling decision in the module and it is the one that can double-pay somebody, so it is
 * stated rather than implied. `employee.basic_wage_fils` is a MONTHLY figure: it is what the contract pays
 * for an ordinary month, and it does not vary with how many minutes were attended. So the payslip pays:
 *
 *     basic      = the monthly basic wage, in full
 *     allowances = housing + transport + other, in full
 *     overtime   = ONLY the uplift above the ordinary rate on the approved minutes
 *
 * `weightedMinuteBp` from P-HR-05 is `sum(minutes × multiplier)` over EVERY minute, ordinary ones included,
 * so pricing it whole and adding it to the monthly basic pays the ordinary month twice. The uplift is
 * `weightedMinuteBp − payableMinutes × ordinaryMultiplierBp`, which is zero for a month with no overtime,
 * no night minutes and no public holiday worked — and a payslip whose overtime line is zero in an ordinary
 * month is the sanity check that this subtraction is present.
 *
 * The alternative reading is that nothing is a monthly wage and every attended minute is paid at its
 * bucket rate, with the monthly figure only a budget. That reading is defensible and is a DIFFERENT
 * payslip: an employee who worked three days of a month would be paid for three days rather than for the
 * month. Which one is right is part of `Y9-overtime` — the row that already records that "the
 * monthly-to-hourly question" is unanswered — and neither reading can be chosen by a comment, so the
 * consequence is stated on the Unconfirmed Assumptions panel and the arithmetic says which one it is.
 *
 * **What this module does NOT do about absence.** Under the monthly-wage reading, unpaid absence reduces
 * pay by a DEDUCTION, and a deduction here is always an explicit authorised row (`payroll_deduction`,
 * migration 0104) and never a figure this module derives. Deriving one would mean choosing which absences
 * are unpaid and what a day of a monthly salary is worth in a deduction — two policy questions nobody has
 * answered (`Y9-deductions`) — and a derived deduction is indistinguishable on the payslip from one a
 * manager authorised.
 *
 * ## Tips are a pass-through liability, never revenue and never an uplift
 *
 * A tip is the customer's money on its way to a therapist. It reaches the payslip as its own line and it
 * reaches the ledger as a credit to `2040 Tips payable to therapists`, which is a LIABILITY — the salon
 * holds it and owes it. Nothing here can put it anywhere else: migration 0104 makes a tip name the
 * liability account it is owed against and refuses a revenue one by SQLSTATE, so "a tip never lands in a
 * revenue account" is a property of the schema rather than a habit of this function.
 *
 * Pure: integers in, integers out, no clock and no I/O.
 */

/**
 * The additive components of gross pay, in the order a payslip prints them.
 *
 * A list and not five parameters, because every aggregate in this module and every column on the screen
 * iterates it: a sixth component is one member here plus one column in migration 0104, and the totals, the
 * reconciliation and the identity check all pick it up. The acceptance criterion's
 * `basic + allowances + overtime + commission + tips − deductions = net` is this list plus the one
 * subtraction, and {@link summarisePayroll} states it as an assertion rather than as a comment.
 */
export const PAYSLIP_EARNING_COMPONENTS = [
  'basic',
  'allowances',
  'overtime',
  'commission',
  'tips',
] as const

export type PayslipEarningComponent = (typeof PAYSLIP_EARNING_COMPONENTS)[number]

/** The commission figure and the run it came off. Both, or neither. */
export interface PayslipCommission {
  readonly fils: number
  /**
   * The `commission_run` this figure is a line of, or null when it is zero.
   *
   * The pin, and the reason this is an object rather than a number. A payslip carrying a commission figure
   * with no run behind it is a figure nobody can reproduce: the run holds the rule version and the
   * `source_as_of` instant, and without them "why is this 1,250 fils" has no answer at all. Zero is the
   * one figure that needs no run, because the commission module shipping disabled (`Y9-commission`) is the
   * state the build is in and every payslip it produces has a zero here.
   */
  readonly runId: string | null
  /** `commission_run.rule_version`, snapshotted so the payslip names the version and not just the run. */
  readonly ruleVersion: number | null
}

/** One employee's inputs, each already decided by something else. */
export interface PayslipInput {
  readonly employeeId: string
  /**
   * `employee.basic_wage_fils`, a MONTHLY figure. Null when none is on file, which is NOT zero.
   *
   * All nineteen seeded employees have this null (`Y8-staff`), and a payslip cannot be produced for an
   * employee without one: {@link computePayslip} refuses rather than paying zero. P-HR-05's forecast
   * counts an unpriced employee and carries on, which is right for a forecast and wrong here — a payslip
   * of 0.00 AED is a document that says somebody is owed nothing, and it would be paid.
   */
  readonly basicWageFils: number | null
  /** `housing + transport + other`, in fils. Zero is a real answer here, unlike the basic wage. */
  readonly allowancesFils: number
  /** The uplift above the ordinary rate, from {@link priceOvertimeUplift}. */
  readonly overtimeFils: number
  readonly commission: PayslipCommission
  /** Individually attributed tips the run discharges, in fils. */
  readonly tipsFils: number
  /** The sum of the authorised `payroll_deduction` rows in the period. Never derived. */
  readonly deductionsFils: number
}

/** One payslip's figures. `netFils` is the one the WPS file pays and the one an employee disputes. */
export interface Payslip {
  readonly employeeId: string
  readonly basicFils: number
  readonly allowancesFils: number
  readonly overtimeFils: number
  readonly commissionFils: number
  readonly commissionRunId: string | null
  readonly commissionRuleVersion: number | null
  readonly tipsFils: number
  /** The sum of {@link PAYSLIP_EARNING_COMPONENTS}. */
  readonly grossFils: number
  readonly deductionsFils: number
  /** `grossFils − deductionsFils`. Never negative; see {@link computePayslip}. */
  readonly netFils: number
}

export interface PayrollSummary {
  readonly payslips: readonly Payslip[]
  readonly payslipCount: number
  /** The exact sum of every payslip's net. Never an approximation of one. */
  readonly netTotalFils: number
  readonly grossTotalFils: number
  readonly deductionsTotalFils: number
  /** Per component, the exact sum across payslips. What the screen prints beside the total. */
  readonly componentTotalsFils: Readonly<Record<PayslipEarningComponent, number>>
}

/** A whole non-negative number of fils, or a refusal naming the field. */
function assertFils(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError(
      'validation',
      `${name} must be a whole non-negative number of fils, got ${value}. ADR 0007: money is integer ` +
        'fils and never a float, and a negative component here would be a deduction wearing an ' +
        "earning's name — which is the one thing a payslip line may not be.",
    )
  }
}

/**
 * The basis-point-minutes that are an UPLIFT over the ordinary rate.
 *
 * `weightedMinuteBp` is `sum(minutes × multiplier)` over every approved minute, so subtracting
 * `payableMinutes × ordinaryMultiplierBp` leaves exactly the excess the uplift buckets contributed. Zero
 * for an ordinary month, which is the check that the subtraction happened at all.
 *
 * `ordinaryMultiplierBp` is an ARGUMENT and comes from the `working_hours_rule` version the timesheet
 * approval snapshotted — never from a literal here. `working_hours_rule_ordinary_multiplier_is_unity`
 * (migration 0059) pins it at 10,000 today, and that is precisely why it must not be written here: a
 * constant would keep answering 10,000 after a version changed it, the payslip would be silently wrong in
 * the direction of overpaying, and every figure on the page would still reconcile.
 */
export function overtimeUpliftMinuteBp(args: {
  readonly payableMinutes: number
  readonly weightedMinuteBp: number
  readonly ordinaryMultiplierBp: number
}): number {
  const { payableMinutes, weightedMinuteBp, ordinaryMultiplierBp } = args
  for (const [name, value] of [
    ['payableMinutes', payableMinutes],
    ['weightedMinuteBp', weightedMinuteBp],
    ['ordinaryMultiplierBp', ordinaryMultiplierBp],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new AppError('validation', `${name} must be a whole non-negative number, got ${value}`)
    }
  }
  const uplift = weightedMinuteBp - payableMinutes * ordinaryMultiplierBp
  if (uplift < 0) {
    /*
      Unreachable through any timesheet this build can approve, and answered rather than clamped.

      `ordinary_multiplier_bp = 10000` and every other multiplier is `>= ordinary_multiplier_bp`
      (migration 0059's CHECK), so the weighted total can never be below the ordinary-rate total. A
      negative uplift therefore means the approval's two figures disagree — a restore with triggers off,
      or a rule version whose ordinary multiplier was raised above the bucket rates. Clamping to zero
      would pay the monthly wage and quietly drop real overtime; this says which two figures disagree.
    */
    throw new AppError(
      'invariant_violated',
      `${weightedMinuteBp} weighted basis-point-minutes is below ${payableMinutes} payable minutes at ` +
        `the ordinary rate of ${ordinaryMultiplierBp} basis points, which is ` +
        `${payableMinutes * ordinaryMultiplierBp}. Every uplift bucket is at or above the ordinary ` +
        'multiplier (migration 0059), so these two figures cannot both be right and the uplift is not ' +
        'clamped to zero: that would pay the monthly wage and drop the overtime without saying so.',
    )
  }
  return uplift
}

/**
 * The uplift in integer fils, rounded up, from the ONE formula that turns a monthly wage into money.
 *
 * `filsForWeightedMinuteBp` is `labour-cost.ts`'s and is shared rather than restated: see its comment for
 * why a second spelling would make the roster forecast and the payslip round differently and have the
 * difference read as a rostered-versus-attended variance.
 *
 * Rounded UP, which for a payslip is the direction that favours the employee. P-HR-05 rounds up because a
 * forecast must not understate a cost; here the argument is different and lands in the same place — of the
 * two available one-fil errors, underpaying somebody is the one that is a labour complaint.
 */
export function priceOvertimeUplift(args: {
  readonly basicWageFils: number
  readonly upliftMinuteBp: number
  readonly rules: LabourCostRules
}): number {
  return filsForWeightedMinuteBp({
    basicWageFils: args.basicWageFils,
    weightedMinuteBp: args.upliftMinuteBp,
    rules: args.rules,
  })
}

/**
 * Refuses a commission figure that names no run.
 *
 * The acceptance criterion that a payslip "names the commission RUN and rule VERSION that produced its
 * figure, never a recomputation at payslip time" needs something to fail when it does not, and this is it.
 * Migration 0104 states the same rule as `assert_payslip_commission_is_pinned` (ZY147) so it holds for a
 * `psql` session; this one holds for a payslip a caller built in memory, which no trigger ever sees.
 */
export function assertCommissionIsPinned(commission: PayslipCommission): void {
  assertFils('A commission figure', commission.fils)
  if (commission.fils === 0) {
    if (commission.runId !== null || commission.ruleVersion !== null) {
      throw new AppError(
        'validation',
        'A zero commission names a run. That is not harmless: it says a run was read and produced ' +
          'nothing for this employee, which is a different fact from the module being disabled, and the ' +
          'two must not be written the same way. Pass a zero with no run, or the run’s own figure.',
      )
    }
    return
  }
  if (commission.runId === null || commission.ruleVersion === null) {
    throw new AppError(
      'validation',
      `A commission of ${commission.fils} fils names no run (runId=${String(commission.runId)}, ` +
        `ruleVersion=${String(commission.ruleVersion)}). A figure with no run behind it cannot be ` +
        'reproduced: the run holds the rule version and the source_as_of instant, and without them the ' +
        'question a therapist actually asks — why is this the figure — has no answer. P-HR-11 exists to ' +
        'make that answerable; a payslip that dropped the pin would undo it.',
    )
  }
  if (!Number.isInteger(commission.ruleVersion) || commission.ruleVersion < 1) {
    throw new AppError(
      'validation',
      `A commission rule version of ${commission.ruleVersion} is not a version. Versions start at 1 ` +
        '(commission_rule_version_starts_at_one, migration 0097).',
    )
  }
}

/**
 * One payslip, from figures something else has already decided.
 *
 * Refuses rather than producing a document, in three cases, and each one is a payslip that would be paid:
 *
 *   - **no wage on file** — a payslip of zero says somebody is owed nothing, and it would be filed as
 *     though it were true. P-HR-05 counts an unpriced employee and carries on, because a forecast of the
 *     priced ones is still useful; there is no useful payslip for an employee whose wage is unknown.
 *   - **a commission figure with no run** — see {@link assertCommissionIsPinned}.
 *   - **deductions above gross** — a negative net. Refused rather than floored at zero: a floor would
 *     silently forgive whatever the excess was, and the excess is the part somebody has to look at. MOHRE
 *     also caps deductions as a proportion of pay, and what that cap is nobody here has been told
 *     (`Y9-deductions`), so this is the weakest true statement rather than an invented percentage.
 */
export function computePayslip(input: PayslipInput): Payslip {
  if (input.basicWageFils === null) {
    throw new AppError(
      'validation',
      `Employee ${input.employeeId} has no basic wage on file, so no payslip can be produced. A wage is ` +
        'a fact about a person and this build does not invent one (brief rule 15): zero would be a ' +
        'payslip saying nothing is owed, and it would be paid. Enter the wage, or leave the employee out ' +
        'of the run — which the run then records rather than passes over.',
    )
  }
  assertFils('A basic wage', input.basicWageFils)
  assertFils('An allowance total', input.allowancesFils)
  assertFils('An overtime figure', input.overtimeFils)
  assertFils('A tip total', input.tipsFils)
  assertFils('A deduction total', input.deductionsFils)
  assertCommissionIsPinned(input.commission)

  const grossFils =
    input.basicWageFils +
    input.allowancesFils +
    input.overtimeFils +
    input.commission.fils +
    input.tipsFils
  if (!Number.isSafeInteger(grossFils)) {
    throw new AppError(
      'invariant_violated',
      `A gross of ${grossFils} fils is beyond exact integer arithmetic, so the additions have stopped ` +
        'being reliable. ADR 0007 failing quietly rather than loudly is the outcome this refuses.',
    )
  }
  if (input.deductionsFils > grossFils) {
    throw new AppError(
      'validation',
      `Deductions of ${input.deductionsFils} fils exceed gross pay of ${grossFils} fils for employee ` +
        `${input.employeeId}, which is a negative net. Not floored at zero: a floor forgives the excess ` +
        'silently and the excess is the figure somebody has to look at. A deduction larger than the pay ' +
        'it comes out of is either the wrong figure or a deduction that belongs to more than one month.',
    )
  }
  return {
    employeeId: input.employeeId,
    basicFils: input.basicWageFils,
    allowancesFils: input.allowancesFils,
    overtimeFils: input.overtimeFils,
    commissionFils: input.commission.fils,
    commissionRunId: input.commission.runId,
    commissionRuleVersion: input.commission.ruleVersion,
    tipsFils: input.tipsFils,
    grossFils,
    deductionsFils: input.deductionsFils,
    netFils: grossFils - input.deductionsFils,
  }
}

/** The component figures of one payslip, keyed by component. Used by the totals and by the identity. */
function componentsOf(payslip: Payslip): Readonly<Record<PayslipEarningComponent, number>> {
  return {
    basic: payslip.basicFils,
    allowances: payslip.allowancesFils,
    overtime: payslip.overtimeFils,
    commission: payslip.commissionFils,
    tips: payslip.tipsFils,
  }
}

/**
 * The run's totals, with the reconciliation asserted rather than assumed.
 *
 * "Reconciles per employee AND in total" is two claims and this makes both: every payslip's own identity
 * is checked as it is summed, and the run's net total is checked against the component totals less the
 * deduction total. Doing only the second would pass over two payslips whose errors cancelled, which is
 * not a contrived case — a figure moved from one employee's line to another's is exactly that shape.
 *
 * The totals are EXACT sums and not rounded aggregates. Every rounding in this unit happened once, inside
 * `priceOvertimeUplift`, on one employee's uplift; a total that rounded again would not be the sum of the
 * numbers printed beside it, which is the defect a reader finds first and trusts least.
 */
export function summarisePayroll(payslips: readonly Payslip[]): PayrollSummary {
  const seen = new Set<string>()
  const componentTotalsFils: Record<PayslipEarningComponent, number> = {
    basic: 0,
    allowances: 0,
    overtime: 0,
    commission: 0,
    tips: 0,
  }
  let netTotalFils = 0
  let grossTotalFils = 0
  let deductionsTotalFils = 0

  for (const payslip of payslips) {
    if (seen.has(payslip.employeeId)) {
      throw new AppError(
        'validation',
        `Employee ${payslip.employeeId} has two payslips in one run. Two payslips for one person in one ` +
          'period is two payments, and nothing downstream could choose between them — the WPS file would ' +
          'carry both. `payslip_once_per_employee_per_run` (migration 0104) refuses the same row.',
      )
    }
    seen.add(payslip.employeeId)

    const components = componentsOf(payslip)
    const gross = PAYSLIP_EARNING_COMPONENTS.reduce((sum, key) => sum + components[key], 0)
    if (gross !== payslip.grossFils) {
      throw new AppError(
        'invariant_violated',
        `Employee ${payslip.employeeId}'s payslip states a gross of ${payslip.grossFils} fils and its ` +
          `components sum to ${gross}. The components are the document: ` +
          `${PAYSLIP_EARNING_COMPONENTS.join(' + ')}.`,
      )
    }
    if (payslip.netFils !== payslip.grossFils - payslip.deductionsFils) {
      throw new AppError(
        'invariant_violated',
        `Employee ${payslip.employeeId}'s payslip states a net of ${payslip.netFils} fils, which is not ` +
          `${payslip.grossFils} gross less ${payslip.deductionsFils} deductions. The net is what the WPS ` +
          'file pays, so a net that does not follow from the lines above it is a payment nobody can ' +
          'explain.',
      )
    }
    for (const key of PAYSLIP_EARNING_COMPONENTS) componentTotalsFils[key] += components[key]
    netTotalFils += payslip.netFils
    grossTotalFils += payslip.grossFils
    deductionsTotalFils += payslip.deductionsFils
  }

  const componentSum = PAYSLIP_EARNING_COMPONENTS.reduce(
    (sum, key) => sum + componentTotalsFils[key],
    0,
  )
  if (componentSum !== grossTotalFils || grossTotalFils - deductionsTotalFils !== netTotalFils) {
    throw new AppError(
      'invariant_violated',
      `The run's totals do not reconcile: components sum to ${componentSum}, gross total is ` +
        `${grossTotalFils}, deductions ${deductionsTotalFils}, net ${netTotalFils}. Asserted in ` +
        'addition to the per-payslip identity above, because two payslips whose errors cancel satisfy ' +
        'the total and not the lines — which is the shape of a figure moved from one employee to another.',
    )
  }

  return {
    payslips,
    payslipCount: payslips.length,
    netTotalFils,
    grossTotalFils,
    deductionsTotalFils,
    componentTotalsFils,
  }
}

/** One approved timesheet, as a payroll run reads it. Every figure is P-HR-07's, not recomputed. */
export interface ApprovedTimesheet {
  readonly timesheetApprovalId: string
  readonly employeeId: string
  readonly fromTradingDate: LocalDate
  readonly toTradingDate: LocalDate
  readonly payableMinutes: number
  readonly weightedMinuteBp: number
  /** `timesheet_approval.incomplete_presence_count`. Above zero stops the run; see below. */
  readonly incompletePresenceCount: number
  /** The `working_hours_rule` version this approval was measured and priced against. */
  readonly workingHoursRuleEffectiveFrom: LocalDate
}

/** An INCOMPLETE presence a run stopped on, named so somebody can go and look at it. */
export interface IncompletePresenceRef {
  readonly employeeId: string
  readonly tradingDate: LocalDate
  /** `attendance_event.id` of the clock-in nothing closed, or that was not believed. */
  readonly clockInEventId: string
  readonly reason: string
}

/**
 * Refuses a payroll run over a period holding an INCOMPLETE attendance row, naming the rows.
 *
 * ## Why the refusal, rather than paying what is known
 *
 * An INCOMPLETE presence contributes ZERO payable minutes (P-HR-07), which is the right answer for a
 * timesheet and a trap for payroll: a month in which every clock-out was missed approves as 0 minutes and
 * reads as somebody who never came in. Paying that is the failure — an employee paid their monthly basic
 * and no overtime for a month of twelve-hour days, with nothing on the payslip saying a figure was
 * missing. So the run stops, and the remedy is P-HR-07's audited `attendance_correction`.
 *
 * ## Why the ids, and where they come from
 *
 * `timesheet_approval.incomplete_presence_count` is a COUNT: it says a period has three of them and not
 * which. The ids come from re-reading the punches through `pairAttendancePunches` — the ONE implementation
 * — and are passed in, so this function names rows without becoming a second reader of attendance. The
 * database refuses the same run through `assert_payroll_run_over_complete_attendance` (ZY145), which can
 * only name the approval row; between them the refusal holds for a `psql` session AND tells a human which
 * punch to go and fix.
 */
export function assertAttendanceIsComplete(args: {
  readonly timesheets: readonly ApprovedTimesheet[]
  readonly incomplete: readonly IncompletePresenceRef[]
}): void {
  const counted = args.timesheets.filter((sheet) => sheet.incompletePresenceCount > 0)
  if (counted.length === 0 && args.incomplete.length === 0) return

  const named =
    args.incomplete.length === 0
      ? '(no punch ids supplied, so only the approvals can be named)'
      : args.incomplete
          .map(
            (ref) =>
              `attendance_event ${ref.clockInEventId} (employee ${ref.employeeId}, ` +
              `${ref.tradingDate}, ${ref.reason})`,
          )
          .join('; ')
  const approvals = counted
    .map(
      (sheet) =>
        `timesheet_approval ${sheet.timesheetApprovalId} (employee ${sheet.employeeId}, ` +
        `${sheet.fromTradingDate}..${sheet.toTradingDate}, ${sheet.incompletePresenceCount} incomplete)`,
    )
    .join('; ')
  throw new AppError(
    'conflict',
    'This period holds attendance that was never closed, so payroll is refused rather than run over it. ' +
      `${named}. ${approvals === '' ? '' : `${approvals}. `}An INCOMPLETE presence contributes zero ` +
      'payable minutes, so a month of missed clock-outs approves as 0 minutes and reads as somebody who ' +
      'never came in — paying that is the failure this refusal exists for. Record an ' +
      'attendance_correction (P-HR-07) saying what happened, then run payroll.',
    {
      details: {
        incompleteEventIds: args.incomplete.map((ref) => ref.clockInEventId),
        timesheetApprovalIds: counted.map((sheet) => sheet.timesheetApprovalId),
      },
    },
  )
}

/**
 * The INCOMPLETE presences in a set of variances, as refs.
 *
 * A projection of `summariseTimesheet(...).variances` and not a second judgement of anything: the outcome
 * and the reason are P-HR-07's, and this only reads the clock-in ids off the presences it already marked.
 */
export function incompletePresencesOf(
  variances: readonly AttendanceVariance[],
): readonly IncompletePresenceRef[] {
  return variances
    .filter((variance) => variance.outcome === 'INCOMPLETE')
    .flatMap((variance) =>
      variance.presences.map((presence) => ({
        employeeId: variance.employeeId,
        tradingDate: variance.tradingDate,
        clockInEventId: presence.clockInEventId,
        reason: variance.incompleteReason ?? 'unstated',
      })),
    )
}

/**
 * Whether a viewer may read a given employee's payslip.
 *
 * ## Why the grants are the ones they are, and why no new permission is invented here
 *
 * `mayReadCommissionDerivation`'s shape exactly, and deliberately the same two grants rather than a new
 * `payslip:read`. P-HR-11's own comment records why a therapist holds `commission:read` at all: *"precisely
 * so somebody can check their own payslip"*. That grant was created for this read, so using it is following
 * the matrix rather than working around it — and adding a permission would be this unit editing
 * `ROLE_DEFINITIONS`, which decides what six roles may do across the whole product, to answer a question
 * already answered.
 *
 * What falls out of it is right in every case and is worth checking one role at a time, because a
 * permission matrix is the kind of thing that looks obviously correct and is not:
 *
 *   - **owner** holds everything, so both views.
 *   - **accountant** holds `payroll:read`, so every payslip. Books and filings need them.
 *   - **manager** holds `commission:read` and NOT `payroll:read`, so their OWN payslip and nobody else's.
 *     That is `ROLE_DEFINITIONS`' "Pay is different" working as intended: a floor manager runs the rota and
 *     does not see what the floor is paid.
 *   - **therapist** the same: their own, which is the whole reason the grant exists.
 *   - **receptionist** and **marketer** hold neither, so nothing.
 *
 * A dedicated `payslip:read` would be the cleaner long-run shape, and this unit declines to add it on its
 * own: it would need the matrix, `permissions.test.ts` and every role's documented description to move
 * together, and nothing about the answer would change.
 */
export function mayReadPayslip(args: {
  readonly role: Role
  readonly viewerEmployeeId: string
  readonly subjectEmployeeId: string
}): boolean {
  if (can(args.role, 'payroll:read')) return true
  if (!can(args.role, 'commission:read')) return false
  return args.viewerEmployeeId === args.subjectEmployeeId
}

/**
 * {@link mayReadPayslip} as a refusal, which is where the acceptance criterion's refusal actually lives.
 *
 * On the FUNCTION and not on a `?employee=` parameter, which is P-HR-11's decision restated because it
 * applies unchanged: `apps/web/src/admin-guard.test.ts` refuses a principal taken from the request across the
 * whole of `apps/web`, so a request for somebody else's payslip is not something this estate can express and
 * there is no URL to authorise. What DOES name a subject is a caller — a payroll run reading one employee's
 * figures, a screen rendering the viewer's own — and the refusal has to hold for that caller.
 *
 * It refuses BEFORE the read rather than filtering it. A filtered read of a colleague's payslip returns an
 * empty list, which reads as "no payslip" rather than as "not yours" — and a therapist told they have no
 * payslip is a worse answer than a therapist told they may not look.
 */
export function assertMayReadPayslip(args: {
  readonly role: Role
  readonly viewerEmployeeId: string
  readonly subjectEmployeeId: string
}): void {
  if (mayReadPayslip(args)) return
  throw new AppError(
    'forbidden',
    !can(args.role, 'commission:read')
      ? `Role "${args.role}" may not read a payslip at all.`
      : `Role "${args.role}" may read only their own payslip, and this request names another employee. ` +
          "Reading a colleague's payslip is reading their pay, which needs payroll:read — the matrix " +
          'grants it to the owner and the accountant and deliberately not to the floor manager.',
    {
      details: {
        role: args.role,
        viewerEmployeeId: args.viewerEmployeeId,
        subjectEmployeeId: args.subjectEmployeeId,
      },
    },
  )
}

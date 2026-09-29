import { filsFrom, type Money } from '@berelax/core'
import type { PayslipView } from '../documents/payslip.ts'

/**
 * The payslip the committed fixtures are rendered from, and the one the itest asserts against.
 *
 * ## Every figure here is a FIXTURE and none is a claim about this business
 *
 * `Y8-staff` records that the staff list is synthetic and `Y9-overtime` that nobody has answered the
 * monthly-to-hourly question, so a payslip needs figures no document supplies. These are chosen for what
 * they make VISIBLE in a rendered page rather than for plausibility:
 *
 *   - **Every component is non-zero**, including tips, so a line that vanished from the template shows up as
 *     a missing row rather than as a zero that looks deliberate.
 *   - **No two components are equal**, so a row rendered in the wrong order is caught by the amounts rather
 *     than only by the labels — which a locale swap could otherwise hide.
 *   - **The net is not a round number.** A total ending in `.00` is the one a wrong figure most easily
 *     imitates.
 *   - **The deduction is small relative to gross**, because the interesting rendering case is a deduction
 *     that has to sit under a much larger total without the columns disagreeing about width.
 *
 * The employee is `Therapist 07`, which is `employee.staff_reference`'s own documented example and NOT a
 * person's name: nineteen employment records have no name recorded (ADR 0020, `Y12-names`, brief rule 10),
 * and a payslip is exactly the document on which an invented one would look like a fact about a person.
 *
 * The commission is non-zero and names a run, so the PIN renders. That is the state the build is NOT in
 * today — `hr.commission_enabled` is false and no rule version is published (`Y9-commission`) — and the
 * fixture is deliberately the configured case, because the null case renders a sentence and the pinned case
 * renders two identifiers, and the second is the one with something to get wrong. `payslip.itest.ts`
 * asserts the null case too, from {@link UNCONFIGURED_COMMISSION_PAYSLIP}.
 *
 * The uuids are all-zero with a serial tail: they are visibly synthetic, `uuid_generate_v7()` cannot produce
 * them, and they name no row that will ever exist.
 */
const money = (fils: number): Money => ({ fils: filsFrom(fils), currency: 'AED' })

export const COMMITTED_PAYSLIP: PayslipView = {
  staffReference: 'Therapist 07',
  periodStartsOn: '2026-03-01',
  periodEndsOn: '2026-03-31',
  runCompletedOn: '2026-04-02',
  basic: money(600_000),
  allowances: money(155_000),
  overtime: money(12_375),
  commission: money(4_250),
  tips: money(3_125),
  gross: money(774_750),
  deductions: money(18_400),
  net: money(756_350),
  payableMinutes: 10_680,
  overtimeUpliftMinuteBp: 297_000,
  commissionRunId: '00000000-0000-0000-0000-0000000000c1',
  commissionRuleVersion: 2,
  timesheetApprovalId: '00000000-0000-0000-0000-0000000000a1',
  workingHoursRuleEffectiveFrom: '1900-01-01',
  wageDivisorRuleEffectiveFrom: '1900-01-01',
  correctsRunId: null,
}

/**
 * The state the build actually ships in: no commission structure configured, so no run and no version.
 *
 * Rendered by the itest and not committed as a fixture PDF, because what it exercises is one branch of the
 * provenance list rather than a different layout — and a second pair of committed PDFs would be two more
 * files to review by eye for one sentence's difference.
 */
export const UNCONFIGURED_COMMISSION_PAYSLIP: PayslipView = {
  ...COMMITTED_PAYSLIP,
  commission: money(0),
  commissionRunId: null,
  commissionRuleVersion: null,
  gross: money(770_500),
  net: money(752_100),
}

/** A correction's payslip, so the "correction of run" row has something to render. */
export const CORRECTION_PAYSLIP: PayslipView = {
  ...COMMITTED_PAYSLIP,
  correctsRunId: '00000000-0000-0000-0000-0000000000b1',
}

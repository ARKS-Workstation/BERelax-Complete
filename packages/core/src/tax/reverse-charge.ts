import { AppError } from '@berelax/shared'
import type { Account, AccountCode, VatBox } from '../ledger/account.ts'
import { ACCOUNTS, accountFor, type ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import {
  filsFrom,
  type Money,
  money,
  roundHalfUp,
  subtract,
  UAE_STANDARD_VAT_BP,
  type VatRateBp,
  ZERO_AED,
} from '../money.ts'
import type { DerivedBill, DerivedBillLine, ReverseChargePair } from '../purchases/bill.ts'
import { selfAccountsVat } from '../purchases/bill.ts'
import { type InputVatRecoverability, recoverabilityOf } from './recoverability.ts'

/**
 * The imported-services reverse charge: the obligation docs/04 §4 calls the most commonly missed at this
 * size, expressed as the two figures it actually is.
 *
 * Pure. Everything here takes its inputs as arguments — the consideration, the rate, the account — and
 * returns values. The writes are `postBill` in `@berelax/db`; the scan that finds a bill missing its pair
 * is `reverseChargeExceptions` there too.
 *
 * ## Why it is two entries and never one
 *
 * An offshore supplier charges no UAE VAT. DigitalOcean, Resend, Google, Meta and Anthropic (docs/04 §4,
 * seeded by `0028_purchases.sql`) are not established in the UAE and issue no UAE tax invoice, which is
 * why `supplier_tax_profile` refuses a TRN on an offshore supplier at all. The tax does not disappear: on
 * an imported service the **recipient** accounts for it. One supply therefore produces two VAT entries:
 *
 *   **output side** — the VAT the business declares as though it had charged itself. `Cr 2035
 *     Reverse-charge VAT payable`, whose `vatBox` is `reverse_charge`.
 *   **input side** — the same VAT reclaimed, where the category allows recovery. `Dr 1080 Recoverable
 *     input VAT`, whose `vatBox` is `recoverable_input_tax`.
 *
 * Where the input is recoverable the two are equal and the net effect on cash is **nil** — which is
 * precisely why the obligation is missed: nothing is owed, so nothing prompts anybody, and a return that
 * omits both sides balances exactly as well as one that carries them. It is not nil where the input is
 * **blocked**: 0034 classifies entertainment and a staff benefit the business is not obliged to provide as
 * categories recovery is denied on, and on those the output side stands alone and the VAT is a real cost.
 * That is where M-VAT-02's classification meets this unit, and it is the case a single net figure hides
 * completely.
 *
 * So {@link reverseChargeOn} returns a pair, and nothing in this module returns "the reverse charge" as one
 * number. {@link reverseChargeBorneVat} is the difference, derived rather than stored.
 *
 * ## Which VAT201 boxes, and where the box numbers are
 *
 * The box numbering is **not** stated here. `Y11-vat201-boxes` is open — the FTA's box numbers await a tax
 * agent — and its recorded answer is "held in a data table with a test proving the mapping is data not
 * code". The data table that exists today is `account.vat_box`, and the full numbered mapping plus the
 * return engine are M-VAT-07's (`vat_box_mapping`). So this module names the two **accounts**, and
 * {@link reverseChargeBoxes} reads their groupings out of the chart. A constant `3` or `10` here would be
 * a number nobody has confirmed, indistinguishable from one somebody had — which is the failure
 * `is_placeholder_text` exists for.
 *
 * ## The rounding, and why it is stated twice
 *
 * A sale's VAT is the remainder of an authoritative gross (ADR 0007), so no rounding decision arises. A
 * reverse charge has no gross to take a remainder from: the tax is computed **on** the consideration, and a
 * rounding is unavoidable. It is half-up, the same rule `splitGross` and `grossFromNet` use, and it is
 * stated a second time in SQL as `bill_line_reverse_charge_output_matches_the_rate` — because
 * `packages/db` may not import this package and the database has to be able to refuse a figure that does
 * not match its rate. `packages/fixtures/src/reverse-charge.itest.ts` asserts the two agree over the
 * half-fils boundaries, which is the same arrangement, for the same reason, as `payables_aging_bucket()`.
 */

/** The account the output side is credited to: the VAT the business declares on an import. */
export const REVERSE_CHARGE_OUTPUT_ACCOUNT: AccountCode = ACCOUNTS.reverseChargeVatPayable
/** The account the input side is debited to, where the category allows recovery. */
export const REVERSE_CHARGE_INPUT_ACCOUNT: AccountCode = ACCOUNTS.recoverableInputVat

/**
 * One reverse charge: the rate it was computed at, and both sides of it.
 *
 * `rateBp` is carried because the rate is the authority's to set and a filed line keeps the rate it was
 * filed at — the same reason `bill_line.vat_rate_bp` is data rather than an assumption.
 */
export interface ReverseCharge extends ReverseChargePair {
  readonly rateBp: VatRateBp
  /** `outputVat - inputVat`: the tax the business bore. Zero on a recoverable category. */
  readonly borneVat: Money
  /** The classification that decided the input side. Carried so a working paper can say why. */
  readonly recoverability: InputVatRecoverability
}

/**
 * The reverse charge on one imported supply.
 *
 * `consideration` is what the supplier charged — which for an offshore supply is the whole gross, because
 * there is no UAE VAT inside it. The output side is `roundHalfUp(consideration × rateBp / 10000)`; the
 * input side is the whole of it on a recoverable category and nothing at all otherwise.
 *
 * `out_of_scope` claims nothing, exactly as `blocked` does, and the two are not collapsed into one
 * argument: the disclosure differs — one is tax the business bore on a category the law denies recovery
 * on, the other is tax borne on a category no recoverable input VAT arises on — and a return that reported
 * a single "not claimed" figure could not tell a tax agent which.
 */
export function reverseChargeOn(
  consideration: Money,
  recoverability: InputVatRecoverability,
  rateBp: VatRateBp = UAE_STANDARD_VAT_BP,
): ReverseCharge {
  if (consideration.fils <= 0) {
    throw new AppError(
      'validation',
      `A reverse charge needs a positive consideration, received ${consideration.fils} fils. Zero is a ` +
        'missing amount, not a free import: it would declare nothing and reconcile to nothing while the ' +
        'bill still looked entered.',
    )
  }
  if (rateBp <= 0) {
    throw new AppError(
      'validation',
      `A reverse charge at ${rateBp} bp accounts for no VAT at all. A supply outside the scope of UAE ` +
        'VAT is out_of_scope, not a nil reverse charge.',
    )
  }
  // `filsFrom`, not a cast: the figure is computed rather than a literal, and the integer check is what
  // stops a half fils reaching a VAT return. ADR 0007, and the reason `aed()` refuses a variable at all.
  const outputVat: Money = money(
    filsFrom(roundHalfUp((consideration.fils * rateBp) / 10_000)),
    consideration.currency,
  )
  // All of it or none of it. Recovery is a property of the account (0034), so the line is coded either to a
  // category that allows it or to one that does not; a proportion would be an apportionment, which nothing
  // in this system computes and nobody could reproduce from the row years later.
  const inputVat = recoverability === 'recoverable' ? outputVat : ZERO_AED
  return {
    rateBp,
    outputVat,
    inputVat,
    borneVat: subtract(outputVat, inputVat),
    recoverability,
  }
}

/** The reverse charge on a supply coded to `account`, with the account deciding the input side. */
export function reverseChargeForAccount(
  consideration: Money,
  account: Account,
  rateBp: VatRateBp = UAE_STANDARD_VAT_BP,
): ReverseCharge {
  return reverseChargeOn(consideration, recoverabilityOf(account), rateBp)
}

/** `outputVat - inputVat` of a derived line: the reverse-charge tax it bore. */
export function reverseChargeBorneVat(line: DerivedBillLine): Money {
  return subtract(line.reverseChargeOutputVat, line.reverseChargeInputVat)
}

/**
 * The VAT201 groupings the two sides of a reverse charge land in, read out of the chart.
 *
 * Read rather than declared, which is the point: `account.vatBox` is the mapping this build holds (0018),
 * the numbered mapping is M-VAT-07's, and a constant here would be a box number nobody has confirmed. A
 * test asserting these two values is therefore asserting the chart, not itself — and re-tagging either
 * account fails it.
 */
export function reverseChargeBoxes(chart: ChartOfAccounts): {
  readonly output: VatBox
  readonly input: VatBox
} {
  // `accountFor`, not `findAccount`: a chart with no 2035 cannot post a reverse charge at all, and
  // `UnknownAccount` names that rather than letting an undefined flow into a box lookup.
  const output = accountFor(chart, REVERSE_CHARGE_OUTPUT_ACCOUNT)
  const input = accountFor(chart, REVERSE_CHARGE_INPUT_ACCOUNT)
  if (output.vatBox === null || input.vatBox === null) {
    throw new AppError(
      'invariant_violated',
      `The reverse-charge pair posts to ${output.code} and ${input.code}, and one of them feeds no VAT201 ` +
        'grouping. Both sides of a reverse charge appear in the return by definition: an account tagged ' +
        'null here would silently drop one half of it.',
    )
  }
  return { output: output.vatBox, input: input.vatBox }
}

/**
 * Whether a bill's reverse charge is internally consistent, and what is wrong if it is not.
 *
 * The pure twin of the exception report's row-level rules, so a caller can *ask* rather than be refused —
 * and so the report's definition of "the two sides do not agree" has one statement a test can read.
 * Returns an empty array for a bill with no reverse charge at all, which is the ordinary domestic bill.
 */
export function reverseChargeProblems(bill: DerivedBill): readonly string[] {
  const problems: string[] = []
  for (const [index, line] of bill.lines.entries()) {
    const at = `line ${index + 1} ("${line.description}")`
    if (selfAccountsVat(line.treatment)) {
      if (line.reverseChargeOutputVat.fils <= 0) {
        problems.push(`${at} is an imported service and declares no reverse-charge VAT`)
      }
      if (
        line.reverseChargeInputVat.fils !== 0 &&
        line.reverseChargeInputVat.fils !== line.reverseChargeOutputVat.fils
      ) {
        problems.push(
          `${at} declares ${line.reverseChargeOutputVat.fils} fils and reclaims ` +
            `${line.reverseChargeInputVat.fils}, which is neither all of it nor none of it`,
        )
      }
      continue
    }
    if (line.reverseChargeOutputVat.fils !== 0 || line.reverseChargeInputVat.fils !== 0) {
      problems.push(`${at} is ${line.treatment} and carries a reverse charge it does not owe`)
    }
  }
  if (bill.reverseChargeInputVat.fils > bill.reverseChargeOutputVat.fils) {
    problems.push(
      `the bill reclaims ${bill.reverseChargeInputVat.fils} fils of reverse-charge VAT and declares ` +
        `only ${bill.reverseChargeOutputVat.fils}`,
    )
  }
  return problems
}

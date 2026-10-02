import { AppError } from '@berelax/shared'
import type { Account, AccountCode, AccountType, NormalBalance } from '../ledger/account.ts'
import { naturalBalance } from '../ledger/account.ts'
import type { ChartOfAccounts, ProvisionalMarker } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { LocalDate } from '../time.ts'

/**
 * The three financial statements, as a pure function of the ledger (R-REP-02).
 *
 * # What "tied to the ledger" means here, and what it cannot mean
 *
 * A balance sheet that balances because it was computed from itself proves nothing. Every figure below is
 * therefore a **directed sum over a named set of account codes**, and nothing else: no statement line
 * holds a figure of its own, no line is adjusted, and no line is derived from another line's total. What
 * makes the three statements agree with `journal_line` is not an assertion in this module — it is that
 * they have nowhere else to come from, plus four properties the caller can check against the ledger
 * itself:
 *
 *   1. **the balance sheet's lines partition the WHOLE chart, once each** — so
 *      `assets - (liabilities + equity)` is the trial-balance identity `sum(debit) = sum(credit)` and
 *      nothing else. The database already guarantees the right-hand side: `0018_ledger.sql`'s deferred
 *      constraint trigger refuses an entry whose debits and credits disagree, at COMMIT, for every role.
 *      So the balance sheet balances **because the journal cannot hold an unbalanced entry**, and the one
 *      way it can stop balancing is a layout that drops an account or claims one twice — which is
 *      {@link statementLayoutFindings}' first rule, not an accident that shows up as a plausible figure.
 *   2. **every line names the account codes it claims**, so a caller can read the `journal_line` rows
 *      behind it and add them up. That is the acceptance line's drill-down, and it is a genuinely
 *      SECOND path: the figures here come from a `group by account_code` aggregate, the drill-down from
 *      the raw rows. A wrong date predicate or a dropped join makes the two disagree.
 *   3. **the cash flow's closing cash is derived from the NON-cash accounts** and compared with the cash
 *      accounts' own position. Two derivations of one figure, which is the only arrangement in which
 *      "closing cash equals the ledger cash balance" is a check rather than a restatement.
 *   4. **the totals the statements claim account for every fil in the window.** The caller passes a
 *      census of `journal_line` over the same window — a count and two sums taken with no reference to
 *      this layout at all — and {@link buildFinancialStatements} reports whether the claimed accounts
 *      cover it. An account posted to and claimed by no line is a named difference, not a silent gap.
 *
 * The balance identity is deliberately weaker than it looks, and saying so is the point: it holds for ANY
 * total, disjoint partition of the chart whose per-section signs are consistent — including one that
 * files a liability under assets. So it is not the check that the sections are right. {@link SENSES} and
 * the direction rule are, and `statements.test.ts` exercises both with the misfiling that the identity
 * cannot see.
 *
 * # Why every figure is a `bigint`
 *
 * `packages/db/src/queries/trial-balance.ts` records what a `number` did there: a ledger holding
 * 2^53 + 1 fils on each side reported a difference of **-4 fils, out of nothing**, because the debit side
 * and the credit side round independently. These statements sum the same columns over the same ledger and
 * would inherit it exactly. `Fils` in `../money.ts` is a branded `number` capped at
 * `Number.MAX_SAFE_INTEGER`, so it is the wrong type for a cumulative ledger position and is not used
 * here; the amounts arrive as `bigint` from the driver, which returns `bigint` columns as strings for
 * this reason, and stay `bigint` through every sum.
 *
 * # Why this is not a materialised view in the `reporting` schema
 *
 * ADR 0064, and the short version is that ADR 0060 keys everything in `reporting` on
 * `business_day.trading_date` while `journal_entry.entry_date` deliberately has **no** foreign key to
 * `business_day` — the journal must be able to record the rent for a month containing days the premises
 * were shut. A statement materialised there would either drop those entries or be the first relation in
 * that schema not keyed on a trading date.
 *
 * # What is provisional
 *
 * The chart is (Y8-coa) and so is the grouping of its accounts into lines: "what the accountant expects
 * monthly" is the unanswered half of that question. {@link STANDARD_SPA_STATEMENT_LAYOUT} therefore
 * carries the marker, {@link buildFinancialStatements} copies it onto every statement set it builds, and
 * nothing here invents a figure, a threshold or a tax rate. No statutory computation happens in this
 * module at all: corporate tax appears only if somebody posted to the corporate tax accounts.
 */

// --- the shape of a line ------------------------------------------------------------------------

export const STATEMENT_FORMAT_VERSION = 'statements-1'

export type StatementId = 'profit_and_loss' | 'balance_sheet' | 'cash_flow'

/**
 * Which subtraction a line's figure is.
 *
 * Never a magnitude: `debit_less_credit` over an account carrying a credit balance is NEGATIVE, and that
 * is how accumulated depreciation appears on the balance sheet as a deduction without anybody flipping a
 * sign at the render site.
 */
export type LineDirection = 'debit_less_credit' | 'credit_less_debit'

/**
 * Whether the line reports its accounts' own side, or the opposite of it.
 *
 * Declared per line rather than inferred, because both occur and the difference is invisible in the
 * figure. A cash-flow line is `inverted` over an asset — cash spent on stock is an outflow, and the stock
 * account was debited — and `natural` over a liability, where a credit is cash the business still holds.
 * The equity section's `costs_since_the_books_opened` is `inverted` over expense accounts for the same
 * reason: an expense reduces what the owner is owed.
 *
 * It exists so that {@link statementLayoutFindings} can check `direction` against the ACCOUNT TYPE, which
 * is the one thing the balance-sheet identity cannot see. A liability filed under assets still balances.
 */
export type LineSense = 'natural' | 'inverted'

export const SENSES: readonly LineSense[] = ['natural', 'inverted']

/**
 * One drillable line. There is no other kind: a total is a sum of these, computed where it is reported.
 *
 * `accountCodes` is what makes the line drillable, and a line claiming none is refused
 * (`statement-line-claims-at-least-one-account`) — a line with no accounts agrees with its own drill-down
 * for ever, which is the vacuity ADR 0003 is about arriving as a presentation decision.
 */
export interface StatementLineSpec {
  readonly lineId: string
  readonly label: string
  readonly statement: StatementId
  /** `assets`, `liabilities`, `equity`, `revenue`, `expenses`, `operating`, `investing`, `financing`. */
  readonly section: string
  readonly direction: LineDirection
  readonly sense: LineSense
  readonly accountCodes: readonly AccountCode[]
}

/**
 * Which window a statement reads: the cumulative position to a date, or the change across a period.
 *
 * A property of the STATEMENT and not of the line, and stated here once so the drill-down reads the same
 * window the figure came from. A balance sheet read as a movement is a balance sheet that omits every
 * opening balance, which still balances.
 */
export const STATEMENT_WINDOWS = {
  profit_and_loss: 'movement',
  balance_sheet: 'position',
  cash_flow: 'movement',
} as const satisfies Record<StatementId, 'position' | 'movement'>

export type StatementWindow = (typeof STATEMENT_WINDOWS)[StatementId]

export interface StatementLayout {
  readonly chartId: string
  /** `null` once the accountant's chart and monthly reporting are supplied. Until then, Y8-coa. */
  readonly provisional: ProvisionalMarker | null
  readonly lines: readonly StatementLineSpec[]
  /** Cash and cash equivalents, stated ONCE. The balance sheet's cash line must claim exactly these. */
  readonly cashAccountCodes: readonly AccountCode[]
}

// --- the layout for the provisional standard spa chart ------------------------------------------

const line = (
  statement: StatementId,
  section: string,
  lineId: string,
  label: string,
  direction: LineDirection,
  sense: LineSense,
  accountCodes: readonly AccountCode[],
): StatementLineSpec => ({ lineId, label, statement, section, direction, sense, accountCodes })

/** The seven revenue accounts, including the contra one. Written once and claimed by three lines. */
const REVENUE_CODES: readonly AccountCode[] = [
  ACCOUNTS.treatmentRevenue,
  ACCOUNTS.packageRedemptionRevenue,
  ACCOUNTS.retailRevenue,
  ACCOUNTS.voucherRedemptionRevenue,
  ACCOUNTS.voucherBreakageRevenue,
  ACCOUNTS.otherOperatingIncome,
  ACCOUNTS.discountsAndAllowances,
]

/** The twenty-five expense accounts, in chart order. */
const EXPENSE_CODES: readonly AccountCode[] = [
  ACCOUNTS.therapistWages,
  ACCOUNTS.commissionExpense,
  ACCOUNTS.gratuityExpense,
  ACCOUNTS.leaveExpense,
  ACCOUNTS.visaAndMedicalFees,
  ACCOUNTS.staffAccommodation,
  ACCOUNTS.rent,
  ACCOUNTS.utilities,
  ACCOUNTS.consumablesUsed,
  ACCOUNTS.costOfRetailGoodsSold,
  ACCOUNTS.laundryAndCleaning,
  ACCOUNTS.repairsAndMaintenance,
  ACCOUNTS.marketing,
  ACCOUNTS.importedServices,
  ACCOUNTS.paymentProcessingFees,
  ACCOUNTS.bankCharges,
  ACCOUNTS.entertainment,
  ACCOUNTS.finesAndPenalties,
  ACCOUNTS.professionalFees,
  ACCOUNTS.insurance,
  ACCOUNTS.licenceAndGovernmentFees,
  ACCOUNTS.depreciation,
  ACCOUNTS.cashOverShort,
  ACCOUNTS.badDebt,
  ACCOUNTS.corporateTaxExpense,
]

/**
 * Cash and cash equivalents: the drawer, the petty-cash float and the bank account.
 *
 * **Gateway clearing (1030) and card terminal clearing (1040) are deliberately NOT here**, and the
 * decision is worth the three lines because it moves a reported figure. Both hold money the business has
 * earned and does not yet hold — 1030's own comment in the chart says so — so counting them as cash would
 * make "cash at the end of the period" a figure the owner cannot check against a bank statement, which is
 * the one thing that figure is for. The maturity that would justify including them is not in the ledger:
 * nothing records when a processor settles.
 *
 * Provisional with the layout (Y8-coa): an accountant may want them in, and moving one code is all that
 * takes, because `cash-flow-cash-accounts-are-the-balance-sheet-cash-line` holds the two readers of this
 * list equal.
 */
const CASH_CODES: readonly AccountCode[] = [
  ACCOUNTS.cashInDrawer,
  ACCOUNTS.pettyCash,
  ACCOUNTS.bankCurrent,
]

/**
 * The balance sheet: every account in the chart, exactly once.
 *
 * There is **no current / non-current split**, and its absence is a decision rather than an omission. The
 * split needs a maturity per balance — when a payable falls due, how much of the gratuity liability is
 * within a year — and the journal records none. A guessed split produces a statutory-looking subtotal
 * that nobody can derive from the rows, which is worse than a flat section an accountant can re-cut.
 *
 * The last two equity lines are what make this balance. Revenue and expense accounts are never closed out
 * in this ledger — nothing in the build posts a year-end closing entry — so the earnings since the books
 * opened sit in the revenue and expense accounts, and equity has to include them or the sheet is out by
 * the profit since inception. Two lines rather than one because each claims accounts of a single type,
 * which is what lets the direction rule check them at all.
 */
const BALANCE_SHEET_LINES: readonly StatementLineSpec[] = [
  line(
    'balance_sheet',
    'assets',
    'cash_and_bank',
    'Cash and bank',
    'debit_less_credit',
    'natural',
    CASH_CODES,
  ),
  line(
    'balance_sheet',
    'assets',
    'card_and_gateway_clearing',
    'Card and gateway clearing',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.gatewayClearing, ACCOUNTS.cardTerminalClearing],
  ),
  line(
    'balance_sheet',
    'assets',
    'trade_receivables',
    'Trade receivables',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.tradeReceivables],
  ),
  line(
    'balance_sheet',
    'assets',
    'prepayments_and_deposits',
    'Prepayments and deposits',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.prepaidExpenses, ACCOUNTS.deposits],
  ),
  line('balance_sheet', 'assets', 'inventory', 'Inventory', 'debit_less_credit', 'natural', [
    ACCOUNTS.inventoryRetail,
    ACCOUNTS.inventoryConsumables,
  ]),
  line(
    'balance_sheet',
    'assets',
    'recoverable_input_vat',
    'Recoverable input VAT',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.recoverableInputVat],
  ),
  line(
    'balance_sheet',
    'assets',
    'equipment_at_cost',
    'Furniture, fittings and equipment, at cost',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.equipment],
  ),
  // Negative by construction: a credit balance read debit-less-credit. The deduction a reader expects,
  // with no sign flipped anywhere.
  line(
    'balance_sheet',
    'assets',
    'accumulated_depreciation',
    'Less: accumulated depreciation',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.accumulatedDepreciation],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'trade_payables_and_accruals',
    'Trade payables and accruals',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.tradePayables, ACCOUNTS.accruedExpenses],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'vat_payable',
    'VAT payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.outputVatPayable, ACCOUNTS.reverseChargeVatPayable],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'tips_payable',
    'Tips payable to therapists',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.tipsPayable],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'deferred_revenue',
    'Deferred revenue — packages and vouchers',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.packageDeferredRevenue, ACCOUNTS.voucherDeferredRevenue],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'staff_liabilities',
    'Wages, gratuity, leave and commission payable',
    'credit_less_debit',
    'natural',
    [
      ACCOUNTS.wagesPayable,
      ACCOUNTS.wpsPayrollClearing,
      ACCOUNTS.gratuityLiability,
      ACCOUNTS.leaveLiability,
      ACCOUNTS.commissionPayable,
    ],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'refunds_payable',
    'Customer refunds payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.refundsPayable],
  ),
  line(
    'balance_sheet',
    'liabilities',
    'corporate_tax_payable',
    'Corporate tax payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.corporateTaxPayable],
  ),
  line(
    'balance_sheet',
    'equity',
    'owners_capital',
    "Owner's capital",
    'credit_less_debit',
    'natural',
    [ACCOUNTS.ownersCapital],
  ),
  line(
    'balance_sheet',
    'equity',
    'owners_drawings',
    "Owner's drawings",
    'credit_less_debit',
    'natural',
    [ACCOUNTS.ownersDrawings],
  ),
  line(
    'balance_sheet',
    'equity',
    'retained_earnings_brought_forward',
    'Retained earnings brought forward',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.retainedEarnings],
  ),
  line(
    'balance_sheet',
    'equity',
    'revenue_since_the_books_opened',
    'Revenue since the books opened',
    'credit_less_debit',
    'natural',
    REVENUE_CODES,
  ),
  line(
    'balance_sheet',
    'equity',
    'costs_since_the_books_opened',
    'Less: costs since the books opened',
    'credit_less_debit',
    'inverted',
    EXPENSE_CODES,
  ),
]

/**
 * The profit and loss account: the revenue and expense accounts, regrouped.
 *
 * The grouping is the provisional half of Y8-coa. It is a regrouping of the same accounts the balance
 * sheet's last two lines claim, which is why `profit-and-loss-claims-every-revenue-and-expense-account-
 * exactly-once` is its own rule: a P&L that quietly omitted an expense account would still articulate
 * with a balance sheet that did not.
 */
const PROFIT_AND_LOSS_LINES: readonly StatementLineSpec[] = [
  line(
    'profit_and_loss',
    'revenue',
    'treatment_revenue',
    'Treatment revenue',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.treatmentRevenue],
  ),
  line(
    'profit_and_loss',
    'revenue',
    'package_and_voucher_revenue',
    'Package and voucher revenue',
    'credit_less_debit',
    'natural',
    [
      ACCOUNTS.packageRedemptionRevenue,
      ACCOUNTS.voucherRedemptionRevenue,
      ACCOUNTS.voucherBreakageRevenue,
    ],
  ),
  line(
    'profit_and_loss',
    'revenue',
    'retail_revenue',
    'Retail product revenue',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.retailRevenue],
  ),
  line(
    'profit_and_loss',
    'revenue',
    'other_operating_income',
    'Other operating income',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.otherOperatingIncome],
  ),
  // Contra revenue, read on the revenue side, so a discount arrives as a negative revenue line rather
  // than as a cost. Netting it into treatment revenue instead loses the gross-sales figure.
  line(
    'profit_and_loss',
    'revenue',
    'discounts_and_allowances',
    'Less: discounts and allowances',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.discountsAndAllowances],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'staff_costs',
    'Staff costs',
    'debit_less_credit',
    'natural',
    [
      ACCOUNTS.therapistWages,
      ACCOUNTS.commissionExpense,
      ACCOUNTS.gratuityExpense,
      ACCOUNTS.leaveExpense,
      ACCOUNTS.visaAndMedicalFees,
      ACCOUNTS.staffAccommodation,
    ],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'premises_costs',
    'Premises costs',
    'debit_less_credit',
    'natural',
    [
      ACCOUNTS.rent,
      ACCOUNTS.utilities,
      ACCOUNTS.laundryAndCleaning,
      ACCOUNTS.repairsAndMaintenance,
      ACCOUNTS.insurance,
      ACCOUNTS.licenceAndGovernmentFees,
    ],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'treatment_and_retail_costs',
    'Treatment consumables and cost of retail goods',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.consumablesUsed, ACCOUNTS.costOfRetailGoodsSold],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'marketing_and_technology',
    'Marketing, software and imported services',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.marketing, ACCOUNTS.importedServices],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'payment_and_bank_costs',
    'Payment processing and bank charges',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.paymentProcessingFees, ACCOUNTS.bankCharges],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'professional_fees',
    'Professional fees',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.professionalFees],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'depreciation',
    'Depreciation',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.depreciation],
  ),
  line(
    'profit_and_loss',
    'expenses',
    'other_operating_costs',
    'Other operating costs',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.entertainment, ACCOUNTS.finesAndPenalties, ACCOUNTS.cashOverShort, ACCOUNTS.badDebt],
  ),
  // Present because the chart has the accounts, at whatever was posted to them, and NOT computed here.
  // docs/04 §4 gives corporate tax as 9% above AED 375,000 of taxable income with elective Small Business
  // Relief; a rate applied in a reporting module would be this codebase filing a return by arithmetic.
  line(
    'profit_and_loss',
    'expenses',
    'corporate_tax_expense',
    'Corporate tax expense',
    'debit_less_credit',
    'natural',
    [ACCOUNTS.corporateTaxExpense],
  ),
]

/**
 * The cash flow, INDIRECT, and the identity it rests on.
 *
 * Every line is `credit_less_debit` over a NON-cash account, and the sum of them all is the movement in
 * cash — because the movement in every account nets to zero over any set of balanced entries, so the
 * cash accounts' movement is minus the movement of everything else. That is the whole derivation: there
 * is no classification of individual entries, no allocation, and no rounding.
 *
 * **Why not the direct method.** Classifying each cash line by the accounts on the other side of its
 * entry is the obvious approach and it does not survive an ordinary banking run: `Dr bank 90, Dr fees 10,
 * Cr drawer 100` has one cash line whose counterparts span an operating cost and another cash account, so
 * the amount has to be split pro rata — and a pro-rata split of an exact figure is a rounding rule inside
 * a statement whose acceptance is "to the fils". The indirect form needs no such decision.
 *
 * **Depreciation.** `accumulated_depreciation` (1110) is an operating add-back and `equipment_at_cost`
 * (1100) is investing, which is the standard presentation and is also the only one that is arithmetically
 * honest here: the charge for the period is the credit to 1110, the cash spent is the debit to 1100, and
 * the two are different events. Reading the movement in the NET book value as investing would report a
 * month with no purchases as an investing inflow the size of the depreciation charge.
 */
const CASH_FLOW_LINES: readonly StatementLineSpec[] = [
  line(
    'cash_flow',
    'operating',
    'revenue_recognised_in_the_period',
    'Revenue recognised in the period',
    'credit_less_debit',
    'natural',
    REVENUE_CODES,
  ),
  line(
    'cash_flow',
    'operating',
    'costs_recognised_in_the_period',
    'Costs recognised in the period',
    'credit_less_debit',
    'inverted',
    EXPENSE_CODES,
  ),
  line(
    'cash_flow',
    'operating',
    'depreciation_charged_in_the_period',
    'Add back: depreciation charged',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.accumulatedDepreciation],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_card_and_gateway_clearing',
    'Movement in card and gateway clearing',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.gatewayClearing, ACCOUNTS.cardTerminalClearing],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_trade_receivables',
    'Movement in trade receivables',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.tradeReceivables],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_inventory',
    'Movement in inventory',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.inventoryRetail, ACCOUNTS.inventoryConsumables],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_prepayments_and_deposits',
    'Movement in prepayments and deposits',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.prepaidExpenses, ACCOUNTS.deposits],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_recoverable_input_vat',
    'Movement in recoverable input VAT',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.recoverableInputVat],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_trade_payables_and_accruals',
    'Movement in trade payables and accruals',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.tradePayables, ACCOUNTS.accruedExpenses],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_vat_payable',
    'Movement in VAT payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.outputVatPayable, ACCOUNTS.reverseChargeVatPayable],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_tips_payable',
    'Movement in tips payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.tipsPayable],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_deferred_revenue',
    'Movement in deferred revenue',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.packageDeferredRevenue, ACCOUNTS.voucherDeferredRevenue],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_staff_liabilities',
    'Movement in staff liabilities',
    'credit_less_debit',
    'natural',
    [
      ACCOUNTS.wagesPayable,
      ACCOUNTS.wpsPayrollClearing,
      ACCOUNTS.gratuityLiability,
      ACCOUNTS.leaveLiability,
      ACCOUNTS.commissionPayable,
    ],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_refunds_payable',
    'Movement in refunds payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.refundsPayable],
  ),
  line(
    'cash_flow',
    'operating',
    'movement_in_corporate_tax_payable',
    'Movement in corporate tax payable',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.corporateTaxPayable],
  ),
  line(
    'cash_flow',
    'investing',
    'purchase_of_equipment',
    'Purchase of furniture, fittings and equipment',
    'credit_less_debit',
    'inverted',
    [ACCOUNTS.equipment],
  ),
  line(
    'cash_flow',
    'financing',
    'owners_capital_introduced',
    "Owner's capital introduced",
    'credit_less_debit',
    'natural',
    [ACCOUNTS.ownersCapital],
  ),
  line(
    'cash_flow',
    'financing',
    'owners_drawings_paid',
    "Owner's drawings",
    'credit_less_debit',
    'natural',
    [ACCOUNTS.ownersDrawings],
  ),
  // Normally zero: nothing in this build posts to retained earnings, and the same figure is what
  // {@link Articulation} reports as `directEquityPostingsFils`. One statement of it, two readers — a
  // second `sum(3030)` somewhere else is what would eventually disagree with this one.
  line(
    'cash_flow',
    'financing',
    'postings_to_retained_earnings',
    'Postings to retained earnings',
    'credit_less_debit',
    'natural',
    [ACCOUNTS.retainedEarnings],
  ),
]

export const STANDARD_SPA_STATEMENT_LAYOUT: StatementLayout = Object.freeze({
  chartId: STANDARD_SPA_CHART.id,
  provisional: Object.freeze({
    openQuestionId: 'Y8-coa',
    note:
      'The statement layout groups the provisional standard spa chart. Y8-coa asks for the existing ' +
      'chart AND what the accountant expects monthly; the second half is this grouping, including which ' +
      'accounts count as cash and cash equivalents. Answering it is a regrouping, not a re-derivation: ' +
      'every figure is a directed sum over account codes and no line holds a figure of its own.',
  }),
  lines: Object.freeze([...BALANCE_SHEET_LINES, ...PROFIT_AND_LOSS_LINES, ...CASH_FLOW_LINES]),
  cashAccountCodes: CASH_CODES,
})

/** Raised when no statement layout has been written for a chart. */
export class UnknownStatementLayout extends AppError {
  constructor(chartId: string) {
    super(
      'not_found',
      `No statement layout exists for chart "${chartId}". A layout is a grouping of THAT chart's ` +
        'codes into lines; deriving one from account numbers would be this module guessing at what an ' +
        'accountant expects (Y8-coa), and a guessed grouping produces a statement nobody can re-cut.',
      { details: { chartId } },
    )
    this.name = 'UnknownStatementLayout'
  }
}

/** The layout for `chart`, or {@link UnknownStatementLayout}. */
export function statementLayoutFor(chart: ChartOfAccounts): StatementLayout {
  if (chart.id === STANDARD_SPA_STATEMENT_LAYOUT.chartId) return STANDARD_SPA_STATEMENT_LAYOUT
  throw new UnknownStatementLayout(chart.id)
}

export function linesOf(
  layout: StatementLayout,
  statement: StatementId,
): readonly StatementLineSpec[] {
  return layout.lines.filter((spec) => spec.statement === statement)
}

// --- the layout rules ---------------------------------------------------------------------------

/**
 * Every rule {@link statementLayoutFindings} can report, in the order it reports them.
 *
 * Named, and asserted by name: a rule that stops matching reports no findings, and "the layout is sound"
 * then passes over a layout that has stopped being one (ADR 0003). `scripts/test-gates.mjs` block 142
 * breaks each one and requires the failure to carry its name.
 */
export const STATEMENT_LAYOUT_RULES = [
  'balance-sheet-claims-every-account-in-the-chart-exactly-once',
  'profit-and-loss-claims-every-revenue-and-expense-account-exactly-once',
  'cash-flow-claims-every-non-cash-account-exactly-once',
  'statement-line-claims-accounts-of-one-type',
  'statement-line-direction-matches-its-declared-sense',
  'cash-flow-cash-accounts-are-the-balance-sheet-cash-line',
  'statement-line-claims-at-least-one-account',
  'statement-line-ids-are-unique-within-a-statement',
] as const

export type StatementLayoutRule = (typeof STATEMENT_LAYOUT_RULES)[number]

export interface LayoutFinding {
  readonly rule: StatementLayoutRule
  readonly detail: string
}

const opposite = (side: NormalBalance): NormalBalance => (side === 'debit' ? 'credit' : 'debit')

/** The side a line of this direction reports on, so it can be compared with an account type's. */
const sideOfDirection = (direction: LineDirection): NormalBalance =>
  direction === 'debit_less_credit' ? 'debit' : 'credit'

/** How a set of lines fails to be a partition of an expected set of codes. */
interface PartitionCensus {
  readonly duplicated: readonly string[]
  readonly missing: readonly string[]
  readonly foreign: readonly string[]
}

/** Codes claimed more than once across `specs`, and codes in `expected` that none claims. */
function partitionFindings(
  specs: readonly StatementLineSpec[],
  expected: readonly AccountCode[],
): PartitionCensus {
  const seen = new Map<string, number>()
  for (const spec of specs) {
    for (const code of spec.accountCodes) {
      seen.set(code as string, (seen.get(code as string) ?? 0) + 1)
    }
  }
  const expectedSet = new Set(expected.map((code) => code as string))
  return {
    duplicated: [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([code]) => code)
      .sort(),
    missing: [...expectedSet].filter((code) => !seen.has(code)).sort(),
    foreign: [...seen.keys()].filter((code) => !expectedSet.has(code)).sort(),
  }
}

const describePartition = (what: string, parts: PartitionCensus): string =>
  `${what}: claimed twice [${parts.duplicated.join(', ')}], claimed by no line ` +
  `[${parts.missing.join(', ')}], claimed but not in the expected set [${parts.foreign.join(', ')}]`

const isSound = (parts: PartitionCensus): boolean =>
  parts.duplicated.length === 0 && parts.missing.length === 0 && parts.foreign.length === 0

/**
 * Every way `layout` fails to be a statement layout over `chart`, as named findings.
 *
 * Returns findings rather than throwing, so a test can hand it a layout that DOES violate each rule and
 * read back which one fired — the arrangement `packages/db/src/reporting/schema-rules.ts` uses for the
 * same reason. {@link assertStatementLayout} is the throwing wrapper the builder calls.
 */
export function statementLayoutFindings(
  chart: ChartOfAccounts,
  layout: StatementLayout,
): readonly LayoutFinding[] {
  const findings: LayoutFinding[] = []
  const byCode = new Map<string, Account>(chart.accounts.map((a) => [a.code as string, a]))
  const codesOfType = (...types: readonly AccountType[]): readonly AccountCode[] =>
    chart.accounts.filter((a) => types.includes(a.type)).map((a) => a.code)

  const balanceSheet = linesOf(layout, 'balance_sheet')
  const profitAndLoss = linesOf(layout, 'profit_and_loss')
  const cashFlow = linesOf(layout, 'cash_flow')

  const wholeChart = partitionFindings(
    balanceSheet,
    chart.accounts.map((a) => a.code),
  )
  if (!isSound(wholeChart)) {
    findings.push({
      rule: 'balance-sheet-claims-every-account-in-the-chart-exactly-once',
      detail: describePartition(
        'the balance sheet is not a partition of the chart, so assets - (liabilities + equity) is no ' +
          'longer the trial-balance identity and would balance or not for reasons nothing states',
        wholeChart,
      ),
    })
  }

  const pnl = partitionFindings(profitAndLoss, codesOfType('revenue', 'expense'))
  if (!isSound(pnl)) {
    findings.push({
      rule: 'profit-and-loss-claims-every-revenue-and-expense-account-exactly-once',
      detail: describePartition(
        'the profit and loss account is not a partition of revenue and expense',
        pnl,
      ),
    })
  }

  const cashCodes = new Set(layout.cashAccountCodes.map((code) => code as string))
  const nonCash = partitionFindings(
    cashFlow,
    chart.accounts.map((a) => a.code).filter((code) => !cashCodes.has(code as string)),
  )
  if (!isSound(nonCash)) {
    findings.push({
      rule: 'cash-flow-claims-every-non-cash-account-exactly-once',
      detail: describePartition(
        'the cash flow is not a partition of the non-cash accounts, so the movement it reports is not ' +
          'the movement in cash',
        nonCash,
      ),
    })
  }

  for (const spec of layout.lines) {
    if (spec.accountCodes.length === 0) {
      findings.push({
        rule: 'statement-line-claims-at-least-one-account',
        detail: `${spec.lineId} claims no account, so its drill-down agrees with it for ever`,
      })
      continue
    }
    const types = [...new Set(spec.accountCodes.map((code) => byCode.get(code as string)?.type))]
    if (types.length !== 1 || types[0] === undefined) {
      findings.push({
        rule: 'statement-line-claims-accounts-of-one-type',
        detail:
          `${spec.lineId} claims accounts of ${types.length} type(s) [${types.join(', ')}], so no ` +
          'single direction can be checked against them',
      })
      continue
    }
    const type = types[0]
    const natural = naturalBalance(type)
    const expected = spec.sense === 'natural' ? natural : opposite(natural)
    if (sideOfDirection(spec.direction) !== expected) {
      findings.push({
        rule: 'statement-line-direction-matches-its-declared-sense',
        detail:
          `${spec.lineId} claims ${type} accounts and declares sense "${spec.sense}", so it must be ` +
          `read ${expected}-less-the-other; it declares ${spec.direction}`,
      })
    }
  }

  const bsCash = balanceSheet.find((spec) => spec.lineId === 'cash_and_bank')
  const declared = [...cashCodes].sort().join(',')
  const onTheSheet = [...(bsCash?.accountCodes ?? [])]
    .map((code) => code as string)
    .sort()
    .join(',')
  if (declared !== onTheSheet) {
    findings.push({
      rule: 'cash-flow-cash-accounts-are-the-balance-sheet-cash-line',
      detail:
        `the cash set is stated twice and the two disagree: layout.cashAccountCodes [${declared}] ` +
        `against the balance sheet's cash_and_bank line [${onTheSheet}]. The cash flow would then ` +
        'report a closing cash figure the balance sheet does not carry',
    })
  }

  for (const statement of ['balance_sheet', 'profit_and_loss', 'cash_flow'] as const) {
    const ids = linesOf(layout, statement).map((spec) => spec.lineId)
    const repeated = [...new Set(ids.filter((id, at) => ids.indexOf(id) !== at))].sort()
    if (repeated.length > 0) {
      findings.push({
        rule: 'statement-line-ids-are-unique-within-a-statement',
        detail: `${statement} repeats line id(s) [${repeated.join(', ')}]`,
      })
    }
  }

  return findings
}

/** Throws naming every rule that fired. Called by {@link buildFinancialStatements}. */
export function assertStatementLayout(chart: ChartOfAccounts, layout: StatementLayout): void {
  const findings = statementLayoutFindings(chart, layout)
  if (findings.length === 0) return
  throw new AppError(
    'invariant_violated',
    `The statement layout for chart "${layout.chartId}" is unsound. ` +
      findings.map((finding) => `${finding.rule}: ${finding.detail}`).join('; '),
    { details: { rules: findings.map((finding) => finding.rule) } },
  )
}

// --- the figures ---------------------------------------------------------------------------------

/**
 * Cumulative debits and credits on one account, as `packages/db` reads them.
 *
 * Structurally `TrialBalanceRow` from `packages/db/src/queries/trial-balance.ts` minus the fields a
 * statement does not need. `packages/db` may not import `packages/core` (ADR 0001), so the pair meets in
 * `packages/fixtures`, which is where the two are asserted against one ledger.
 */
export interface AccountFigure {
  readonly accountCode: string
  readonly debitFils: bigint
  readonly creditFils: bigint
}

/** A count and two sums over `journal_line`, taken with no reference to the layout. */
export interface LedgerCensus {
  readonly lineCount: number
  readonly debitFils: bigint
  readonly creditFils: bigint
  /** Every account code posted to in the window. */
  readonly accountCodes: readonly string[]
}

type FigureIndex = ReadonlyMap<string, AccountFigure>

const indexFigures = (figures: readonly AccountFigure[]): FigureIndex =>
  new Map(figures.map((figure) => [figure.accountCode, figure]))

/**
 * The movement between two positions, per account.
 *
 * Subtracted here rather than read from a second query, which is `trial-balance.ts`'s own instruction:
 * "A period report is the difference between two of these, which is a subtraction the caller can do and
 * this function should not guess at." A third read of the ledger for the same quantity is a third thing
 * that can disagree.
 */
export function movementBetween(
  opening: readonly AccountFigure[],
  closing: readonly AccountFigure[],
): readonly AccountFigure[] {
  const before = indexFigures(opening)
  const codes = [...new Set([...before.keys(), ...closing.map((f) => f.accountCode)])].sort()
  const after = indexFigures(closing)
  return codes.map((accountCode) => {
    const from = before.get(accountCode)
    const to = after.get(accountCode)
    return {
      accountCode,
      debitFils: (to?.debitFils ?? 0n) - (from?.debitFils ?? 0n),
      creditFils: (to?.creditFils ?? 0n) - (from?.creditFils ?? 0n),
    }
  })
}

/** One line, with the figure its account codes and direction produce over a window. */
export interface StatementLine extends StatementLineSpec {
  readonly fils: bigint
  /** How many of the claimed accounts had any movement or position. Reported, never asserted upon. */
  readonly accountsWithFigures: number
}

/**
 * `sum(debit) - sum(credit)` or its negation over the accounts a line claims.
 *
 * Exported because it is the arithmetic a drill-down has to reproduce: given the `journal_line` rows for
 * this line's accounts over this line's window, applying this direction to their totals must give the
 * same `bigint`. A caller that summed the rows some other way would be checking its own subtraction.
 */
export function directedTotalFils(
  direction: LineDirection,
  debitFils: bigint,
  creditFils: bigint,
): bigint {
  return direction === 'debit_less_credit' ? debitFils - creditFils : creditFils - debitFils
}

function lineFrom(spec: StatementLineSpec, figures: FigureIndex): StatementLine {
  let debit = 0n
  let credit = 0n
  let present = 0
  for (const code of spec.accountCodes) {
    const figure = figures.get(code as string)
    if (figure === undefined) continue
    present += 1
    debit += figure.debitFils
    credit += figure.creditFils
  }
  return {
    ...spec,
    fils: directedTotalFils(spec.direction, debit, credit),
    accountsWithFigures: present,
  }
}

const sumLines = (lines: readonly StatementLine[], section: string): bigint =>
  lines
    .filter((entry) => entry.section === section)
    .reduce((total, entry) => total + entry.fils, 0n)

// --- the three statements ------------------------------------------------------------------------

export interface ProfitAndLoss {
  readonly from: LocalDate
  readonly to: LocalDate
  readonly lines: readonly StatementLine[]
  readonly totalRevenueFils: bigint
  readonly totalExpensesFils: bigint
  readonly netProfitFils: bigint
}

export interface BalanceSheet {
  readonly asAt: LocalDate
  readonly lines: readonly StatementLine[]
  readonly totalAssetsFils: bigint
  readonly totalLiabilitiesFils: bigint
  readonly totalEquityFils: bigint
  /**
   * `assets - (liabilities + equity)`. Zero whenever the layout is a partition of the chart, because the
   * journal cannot hold an entry whose debits and credits disagree — see the module header.
   */
  readonly differenceFils: bigint
  /**
   * Retained earnings brought forward plus the earnings since the books opened.
   *
   * The quantity the articulation is about, named on the sheet rather than recomputed by the caller: a
   * second summation of the three equity lines is a second answer to "what are retained earnings".
   */
  readonly retainedEarningsFils: bigint
}

export interface CashFlow {
  readonly from: LocalDate
  readonly to: LocalDate
  readonly lines: readonly StatementLine[]
  readonly operatingFils: bigint
  readonly investingFils: bigint
  readonly financingFils: bigint
  readonly netMovementInCashFils: bigint
  readonly openingCashFils: bigint
  /** `openingCash + netMovement`, derived from the NON-cash accounts. */
  readonly closingCashFils: bigint
  /** The cash and bank accounts' own closing position. The second derivation. */
  readonly ledgerCashFils: bigint
  /** `closingCash - ledgerCash`. Zero, or the cash set and the layout have stopped agreeing. */
  readonly differenceFils: bigint
}

export interface Articulation {
  readonly openingRetainedEarningsFils: bigint
  readonly closingRetainedEarningsFils: bigint
  readonly movementFils: bigint
  readonly netProfitFils: bigint
  /**
   * What was posted DIRECTLY to retained earnings inside the period, from the cash flow's own line.
   *
   * Zero in this build — nothing posts a closing entry or a distribution — and reported rather than
   * assumed, because the simple reading of "net profit equals the movement in retained earnings" is only
   * true while it is zero. A closing entry moves profit out of the revenue accounts and into 3030, so the
   * movement and the profit differ by exactly this figure and the difference is not an error.
   */
  readonly directEquityPostingsFils: bigint
  /** `movement - netProfit - directEquityPostings`. Zero identically. */
  readonly differenceFils: bigint
}

export function profitAndLoss(
  layout: StatementLayout,
  movement: readonly AccountFigure[],
  window: { readonly from: LocalDate; readonly to: LocalDate },
): ProfitAndLoss {
  const figures = indexFigures(movement)
  const lines = linesOf(layout, 'profit_and_loss').map((spec) => lineFrom(spec, figures))
  const totalRevenueFils = sumLines(lines, 'revenue')
  const totalExpensesFils = sumLines(lines, 'expenses')
  return {
    from: window.from,
    to: window.to,
    lines,
    totalRevenueFils,
    totalExpensesFils,
    netProfitFils: totalRevenueFils - totalExpensesFils,
  }
}

export function balanceSheet(
  layout: StatementLayout,
  position: readonly AccountFigure[],
  asAt: LocalDate,
): BalanceSheet {
  const figures = indexFigures(position)
  const lines = linesOf(layout, 'balance_sheet').map((spec) => lineFrom(spec, figures))
  const totalAssetsFils = sumLines(lines, 'assets')
  const totalLiabilitiesFils = sumLines(lines, 'liabilities')
  const totalEquityFils = sumLines(lines, 'equity')
  const retained = [
    'retained_earnings_brought_forward',
    'revenue_since_the_books_opened',
    'costs_since_the_books_opened',
  ]
  return {
    asAt,
    lines,
    totalAssetsFils,
    totalLiabilitiesFils,
    totalEquityFils,
    differenceFils: totalAssetsFils - (totalLiabilitiesFils + totalEquityFils),
    retainedEarningsFils: lines
      .filter((entry) => retained.includes(entry.lineId))
      .reduce((total, entry) => total + entry.fils, 0n),
  }
}

export function cashFlow(
  layout: StatementLayout,
  input: {
    readonly movement: readonly AccountFigure[]
    readonly openingPosition: readonly AccountFigure[]
    readonly closingPosition: readonly AccountFigure[]
    readonly from: LocalDate
    readonly to: LocalDate
  },
): CashFlow {
  const figures = indexFigures(input.movement)
  const lines = linesOf(layout, 'cash_flow').map((spec) => lineFrom(spec, figures))
  const operatingFils = sumLines(lines, 'operating')
  const investingFils = sumLines(lines, 'investing')
  const financingFils = sumLines(lines, 'financing')
  const netMovementInCashFils = operatingFils + investingFils + financingFils
  const cashAt = (position: readonly AccountFigure[]): bigint => {
    const index = indexFigures(position)
    return layout.cashAccountCodes.reduce((total, code) => {
      const figure = index.get(code as string)
      if (figure === undefined) return total
      return total + directedTotalFils('debit_less_credit', figure.debitFils, figure.creditFils)
    }, 0n)
  }
  const openingCashFils = cashAt(input.openingPosition)
  const closingCashFils = openingCashFils + netMovementInCashFils
  const ledgerCashFils = cashAt(input.closingPosition)
  return {
    from: input.from,
    to: input.to,
    lines,
    operatingFils,
    investingFils,
    financingFils,
    netMovementInCashFils,
    openingCashFils,
    closingCashFils,
    ledgerCashFils,
    differenceFils: closingCashFils - ledgerCashFils,
  }
}

export function articulation(
  opening: BalanceSheet,
  closing: BalanceSheet,
  pnl: ProfitAndLoss,
  flow: CashFlow,
): Articulation {
  const movementFils = closing.retainedEarningsFils - opening.retainedEarningsFils
  const directEquityPostingsFils =
    flow.lines.find((entry) => entry.lineId === 'postings_to_retained_earnings')?.fils ?? 0n
  return {
    openingRetainedEarningsFils: opening.retainedEarningsFils,
    closingRetainedEarningsFils: closing.retainedEarningsFils,
    movementFils,
    netProfitFils: pnl.netProfitFils,
    directEquityPostingsFils,
    differenceFils: movementFils - pnl.netProfitFils - directEquityPostingsFils,
  }
}

// --- the statement set, and what it says about itself --------------------------------------------

/** One claim the set makes about itself, with the figure that has to be zero. */
export interface StatementIdentity {
  readonly identityId: string
  readonly label: string
  readonly measure: 'fils' | 'accounts' | 'rows'
  readonly differenceFils: bigint
}

/** Whether the accounts the statements claim account for every row in the ledger window. */
export interface LedgerCoverage {
  readonly window: StatementWindow
  readonly lineCount: number
  /** Account codes posted to in the window that no balance-sheet line claims. */
  readonly unclaimedAccountCodes: readonly string[]
  /** `sum(debit) + sum(credit)` over the census, against the same total over the claimed figures. */
  readonly censusMovementFils: bigint
  readonly claimedMovementFils: bigint
  readonly differenceFils: bigint
}

export interface FinancialStatementsInput {
  readonly chart: ChartOfAccounts
  readonly layout: StatementLayout
  readonly period: {
    readonly periodId: string
    readonly startsOn: LocalDate
    readonly endsOn: LocalDate
  }
  /** The day before `startsOn`; the position the period opens from. Resolved by the caller, in SQL. */
  readonly openingAsAt: LocalDate
  readonly openingPosition: readonly AccountFigure[]
  readonly closingPosition: readonly AccountFigure[]
  /** The instant the figures were read at: the lock's own `locked_at` for a closed period. */
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  /** `journal_line` rows dated in the period whose `created_at` is after `sourceAsOf`. */
  readonly rowsWrittenAfterTheSourceInstant: number
  readonly positionCensus: LedgerCensus
  readonly movementCensus: LedgerCensus
}

export interface FinancialStatements {
  readonly formatVersion: typeof STATEMENT_FORMAT_VERSION
  readonly chartId: string
  readonly period: {
    readonly periodId: string
    readonly startsOn: LocalDate
    readonly endsOn: LocalDate
  }
  readonly openingAsAt: LocalDate
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  readonly provisional: readonly ProvisionalMarker[]
  readonly profitAndLoss: ProfitAndLoss
  readonly openingBalanceSheet: BalanceSheet
  readonly closingBalanceSheet: BalanceSheet
  readonly cashFlow: CashFlow
  readonly articulation: Articulation
  readonly coverage: readonly LedgerCoverage[]
  readonly identities: readonly StatementIdentity[]
  readonly rowsWrittenAfterTheSourceInstant: number
  /**
   * Why this set may not be republished as the period's figures. Empty is the only publishable state.
   *
   * ADR 0053's discipline, applied here: the statements are NOT filtered on `created_at <= sourceAsOf`,
   * they are read at the period's own dates and this list says whether that was the same thing. A silent
   * filter would go on reporting the figures as filed after a period had been reopened and posted into,
   * with nothing anywhere saying the ledger behind them had moved.
   */
  readonly notReproducibleReasons: readonly string[]
}

function coverageOf(
  window: StatementWindow,
  census: LedgerCensus,
  claimed: readonly AccountFigure[],
  claimedCodes: ReadonlySet<string>,
): LedgerCoverage {
  const index = indexFigures(claimed)
  const censusMovementFils = census.debitFils + census.creditFils
  let claimedMovementFils = 0n
  for (const code of claimedCodes) {
    const figure = index.get(code)
    if (figure === undefined) continue
    claimedMovementFils += figure.debitFils + figure.creditFils
  }
  return {
    window,
    lineCount: census.lineCount,
    unclaimedAccountCodes: census.accountCodes.filter((code) => !claimedCodes.has(code)).sort(),
    censusMovementFils,
    claimedMovementFils,
    differenceFils: claimedMovementFils - censusMovementFils,
  }
}

/**
 * The three statements for one period, with everything they claim about themselves.
 *
 * Pure, and every date and instant is an argument. That is what makes "re-running the statements for a
 * locked period produces byte-identical output" a property this function HAS rather than one a caller
 * hopes for: there is no clock to read, so two calls with the same arguments cannot differ, and for a
 * closed period the caller's `nowIso` never reaches the arguments at all — `sourceAsOf` is the lock's
 * `locked_at`.
 */
export function buildFinancialStatements(input: FinancialStatementsInput): FinancialStatements {
  assertStatementLayout(input.chart, input.layout)

  const movement = movementBetween(input.openingPosition, input.closingPosition)
  const window = { from: input.period.startsOn, to: input.period.endsOn }
  const pnl = profitAndLoss(input.layout, movement, window)
  const opening = balanceSheet(input.layout, input.openingPosition, input.openingAsAt)
  const closing = balanceSheet(input.layout, input.closingPosition, input.period.endsOn)
  const flow = cashFlow(input.layout, {
    movement,
    openingPosition: input.openingPosition,
    closingPosition: input.closingPosition,
    ...window,
  })
  const articulated = articulation(opening, closing, pnl, flow)

  // Every account the balance sheet claims, which the first layout rule holds equal to the whole chart.
  // Taken from the LINES rather than from the chart, so a layout that dropped an account is what the
  // coverage sees rather than something the chart papers over.
  const claimedCodes = new Set(
    linesOf(input.layout, 'balance_sheet').flatMap((spec) =>
      spec.accountCodes.map((code) => code as string),
    ),
  )
  const coverage = [
    coverageOf(
      STATEMENT_WINDOWS.balance_sheet,
      input.positionCensus,
      input.closingPosition,
      claimedCodes,
    ),
    coverageOf(STATEMENT_WINDOWS.profit_and_loss, input.movementCensus, movement, claimedCodes),
  ]

  const operatingProfitLines = flow.lines
    .filter(
      (entry) =>
        entry.lineId === 'revenue_recognised_in_the_period' ||
        entry.lineId === 'costs_recognised_in_the_period',
    )
    .reduce((total, entry) => total + entry.fils, 0n)

  const identities: StatementIdentity[] = [
    {
      identityId: 'balance_sheet_balances_at_the_opening_date',
      label: 'assets − (liabilities + equity) as at the opening date',
      measure: 'fils',
      differenceFils: opening.differenceFils,
    },
    {
      identityId: 'balance_sheet_balances_at_the_closing_date',
      label: 'assets − (liabilities + equity) as at the closing date',
      measure: 'fils',
      differenceFils: closing.differenceFils,
    },
    {
      identityId: 'net_profit_equals_the_movement_in_retained_earnings',
      label: 'movement in retained earnings − net profit − postings straight to retained earnings',
      measure: 'fils',
      differenceFils: articulated.differenceFils,
    },
    {
      identityId: 'cash_flow_closing_cash_equals_the_ledger_cash_and_bank_balance',
      label: 'closing cash from the non-cash accounts − the cash and bank accounts’ own position',
      measure: 'fils',
      differenceFils: flow.differenceFils,
    },
    {
      identityId: 'cash_flow_operating_opens_with_the_p_and_l_net_profit',
      label: 'the cash flow’s recognised revenue and costs − the profit and loss net profit',
      measure: 'fils',
      differenceFils: operatingProfitLines - pnl.netProfitFils,
    },
    ...coverage.map((entry) => ({
      identityId: `every_account_posted_in_the_${entry.window}_window_is_claimed_by_a_line`,
      label: `account codes posted in the ${entry.window} window that no balance-sheet line claims`,
      measure: 'accounts' as const,
      differenceFils: BigInt(entry.unclaimedAccountCodes.length),
    })),
    ...coverage.map((entry) => ({
      identityId: `the_${entry.window}_window_is_accounted_for_to_the_fil`,
      label: `debits plus credits the lines claim − the same total over journal_line (${entry.window})`,
      measure: 'fils' as const,
      differenceFils: entry.differenceFils,
    })),
  ]

  const notReproducibleReasons: string[] = []
  if (input.lockedPeriodId === null) {
    notReproducibleReasons.push(
      `Accounting period "${input.period.periodId}" (${input.period.startsOn} to ` +
        `${input.period.endsOn}) is not closed, so these figures are as at ${input.sourceAsOf} and the ` +
        'next posting changes them. Close the period to fix them.',
    )
  }
  if (input.rowsWrittenAfterTheSourceInstant > 0) {
    notReproducibleReasons.push(
      `${input.rowsWrittenAfterTheSourceInstant} journal line(s) dated inside the period were written ` +
        `after ${input.sourceAsOf}, so these are not the figures the period was closed on. A period ` +
        'reopened and posted into is re-stated and re-closed, not re-reported.',
    )
  }
  for (const identity of identities.filter((entry) => entry.differenceFils !== 0n)) {
    notReproducibleReasons.push(
      `${identity.identityId} is out by ${identity.differenceFils} (${identity.label}).`,
    )
  }

  const provisional = [input.layout.provisional, input.chart.provisional].filter(
    (marker): marker is ProvisionalMarker => marker !== null,
  )

  return {
    formatVersion: STATEMENT_FORMAT_VERSION,
    chartId: input.layout.chartId,
    period: input.period,
    openingAsAt: input.openingAsAt,
    sourceAsOf: input.sourceAsOf,
    lockedPeriodId: input.lockedPeriodId,
    provisional,
    profitAndLoss: pnl,
    openingBalanceSheet: opening,
    closingBalanceSheet: closing,
    cashFlow: flow,
    articulation: articulated,
    coverage,
    identities,
    rowsWrittenAfterTheSourceInstant: input.rowsWrittenAfterTheSourceInstant,
    notReproducibleReasons,
  }
}

/**
 * Every drillable line across the three statements, with the window each was read over.
 *
 * The population the drill-down property runs over: "every line of all three statements", enumerated here
 * so the property cannot be asserted for a subset that happens to be the sound one.
 */
export function drillableLines(statements: FinancialStatements): readonly {
  readonly statement: StatementId
  readonly window: StatementWindow
  readonly line: StatementLine
  /** `null` for a position line: a position reads from the beginning of the ledger. */
  readonly fromInclusive: LocalDate | null
  readonly toInclusive: LocalDate
}[] {
  const rows: {
    statement: StatementId
    window: StatementWindow
    line: StatementLine
    fromInclusive: LocalDate | null
    toInclusive: LocalDate
  }[] = []
  for (const line of statements.profitAndLoss.lines) {
    rows.push({
      statement: 'profit_and_loss',
      window: STATEMENT_WINDOWS.profit_and_loss,
      line,
      fromInclusive: statements.period.startsOn,
      toInclusive: statements.period.endsOn,
    })
  }
  for (const [sheet, at] of [
    [statements.openingBalanceSheet, statements.openingAsAt],
    [statements.closingBalanceSheet, statements.period.endsOn],
  ] as const) {
    for (const line of sheet.lines) {
      rows.push({
        statement: 'balance_sheet',
        window: STATEMENT_WINDOWS.balance_sheet,
        line,
        fromInclusive: null,
        toInclusive: at,
      })
    }
  }
  for (const line of statements.cashFlow.lines) {
    rows.push({
      statement: 'cash_flow',
      window: STATEMENT_WINDOWS.cash_flow,
      line,
      fromInclusive: statements.period.startsOn,
      toInclusive: statements.period.endsOn,
    })
  }
  return rows
}

import type { Account, AccountCode, AccountType } from './account.ts'
import { accountCode, defineAccount, UnknownAccount } from './account.ts'

/**
 * The provisional standard spa chart of accounts.
 *
 * **Provisional.** Y8-coa is open: the business has an existing chart and the accountant has monthly
 * expectations that nobody has written down yet. What is here is a standard UAE spa chart, chosen so
 * that the answer to Y8-coa is a *mapping* exercise rather than a re-design.
 *
 * It is deliberately wider than the till needs today. P-HR-13 will post monthly gratuity accrual,
 * Y-PAY will post commission and tips, M-TILL-09 will post package sales as deferred revenue, and
 * M-TILL-07 will reconcile the drawer. Every account those units need is already here, because a
 * chart of accounts lands in an append-only journal (ADR 0017): once entries reference codes, adding
 * a code is easy and *renumbering* one means restating history. The cost of six unused accounts now
 * is nil; the cost of a second chart migration in P-HR is a data migration across a journal that by
 * definition cannot be edited.
 *
 * Codes follow the conventional blocks: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue,
 * 5xxx staff cost, 6xxx operating cost.
 */

export interface ProvisionalMarker {
  /** The open question in docs/OPEN-QUESTIONS.md this stands in for. */
  readonly openQuestionId: string
  readonly note: string
}

export interface ChartOfAccounts {
  readonly id: string
  /** `null` once an owner has confirmed the chart. Until then the marker names the open question. */
  readonly provisional: ProvisionalMarker | null
  readonly accounts: readonly Account[]
}

/**
 * Named codes, so a posting rule reads `ACCOUNTS.tipsPayable` rather than `'2040'`.
 *
 * Both forms exist for a reason: accountants and the exported trial balance work in codes, and
 * posting rules that spell codes inline are unreviewable — nobody catches `'2050'` where `'2055'`
 * was meant, and the entry still balances.
 */
export const ACCOUNTS = {
  cashInDrawer: accountCode('1010'),
  pettyCash: accountCode('1015'),
  bankCurrent: accountCode('1020'),
  gatewayClearing: accountCode('1030'),
  cardTerminalClearing: accountCode('1040'),
  tradeReceivables: accountCode('1050'),
  prepaidExpenses: accountCode('1060'),
  inventoryRetail: accountCode('1070'),
  inventoryConsumables: accountCode('1075'),
  recoverableInputVat: accountCode('1080'),
  deposits: accountCode('1090'),
  equipment: accountCode('1100'),
  accumulatedDepreciation: accountCode('1110'),

  tradePayables: accountCode('2010'),
  accruedExpenses: accountCode('2020'),
  outputVatPayable: accountCode('2030'),
  reverseChargeVatPayable: accountCode('2035'),
  tipsPayable: accountCode('2040'),
  packageDeferredRevenue: accountCode('2050'),
  voucherDeferredRevenue: accountCode('2055'),
  wagesPayable: accountCode('2060'),
  wpsPayrollClearing: accountCode('2065'),
  gratuityLiability: accountCode('2070'),
  leaveLiability: accountCode('2075'),
  commissionPayable: accountCode('2080'),
  refundsPayable: accountCode('2085'),
  corporateTaxPayable: accountCode('2090'),

  ownersCapital: accountCode('3010'),
  ownersDrawings: accountCode('3020'),
  retainedEarnings: accountCode('3030'),

  treatmentRevenue: accountCode('4010'),
  packageRedemptionRevenue: accountCode('4020'),
  retailRevenue: accountCode('4030'),
  voucherRedemptionRevenue: accountCode('4040'),
  voucherBreakageRevenue: accountCode('4050'),
  otherOperatingIncome: accountCode('4090'),
  discountsAndAllowances: accountCode('4095'),

  therapistWages: accountCode('5010'),
  commissionExpense: accountCode('5020'),
  gratuityExpense: accountCode('5030'),
  leaveExpense: accountCode('5040'),
  visaAndMedicalFees: accountCode('5050'),
  staffAccommodation: accountCode('5060'),

  rent: accountCode('6010'),
  utilities: accountCode('6020'),
  consumablesUsed: accountCode('6030'),
  costOfRetailGoodsSold: accountCode('6040'),
  laundryAndCleaning: accountCode('6050'),
  repairsAndMaintenance: accountCode('6060'),
  marketing: accountCode('6070'),
  importedServices: accountCode('6075'),
  paymentProcessingFees: accountCode('6080'),
  bankCharges: accountCode('6085'),
  entertainment: accountCode('6090'),
  finesAndPenalties: accountCode('6095'),
  professionalFees: accountCode('6100'),
  insurance: accountCode('6110'),
  licenceAndGovernmentFees: accountCode('6120'),
  depreciation: accountCode('6130'),
  cashOverShort: accountCode('6140'),
  badDebt: accountCode('6150'),
  corporateTaxExpense: accountCode('6160'),
} as const

/**
 * Every account, fully classified. `defineAccount` rejects an omission at construction, so an
 * under-specified row here cannot reach a caller: importing this module is enough to fail.
 */
const STANDARD_SPA_ACCOUNTS: readonly Account[] = [
  // --- 1xxx assets ---------------------------------------------------------------------------
  defineAccount({
    code: ACCOUNTS.cashInDrawer,
    name: 'Cash in drawer',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.pettyCash,
    name: 'Petty cash float',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.bankCurrent,
    name: 'Bank — current account',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // A card sale is cash the business has earned and does not yet hold. Without a clearing account
    // the settlement delay and the processor's fee net off inside "bank", and the drawer can never
    // be reconciled to the takings.
    code: ACCOUNTS.gatewayClearing,
    name: 'Payment gateway clearing',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.cardTerminalClearing,
    name: 'Card terminal clearing',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.tradeReceivables,
    name: 'Trade receivables — corporate accounts',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.prepaidExpenses,
    name: 'Prepaid expenses',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.inventoryRetail,
    name: 'Inventory — retail products',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.inventoryConsumables,
    name: 'Inventory — treatment consumables',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // The only non-expense account that is itself recoverable input VAT: the asset the recovery is
    // claimed against.
    code: ACCOUNTS.recoverableInputVat,
    name: 'Recoverable input VAT',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.deposits,
    name: 'Rent and utility deposits',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.equipment,
    name: 'Furniture, fittings and equipment',
    type: 'asset',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // A contra asset: an asset code carrying a credit balance. This is the account that makes
    // "asset implies debit" wrong, which is why normalBalance is stated on every row.
    code: ACCOUNTS.accumulatedDepreciation,
    name: 'Accumulated depreciation',
    type: 'asset',
    normalBalance: 'credit',
    contra: true,
    vatBox: null,
    inputVatRecoverable: false,
  }),

  // --- 2xxx liabilities ----------------------------------------------------------------------
  defineAccount({
    code: ACCOUNTS.tradePayables,
    name: 'Trade payables',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.accruedExpenses,
    name: 'Accrued expenses',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.outputVatPayable,
    name: 'Output VAT payable',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'output_tax',
    inputVatRecoverable: false,
  }),
  defineAccount({
    // Reverse charge on imported services is the most commonly missed obligation at this size
    // (docs/04 section 4), so it gets its own payable rather than netting into output VAT: a nightly
    // exception report cannot find a missing pair inside an aggregate.
    code: ACCOUNTS.reverseChargeVatPayable,
    name: 'Reverse-charge VAT payable',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'reverse_charge',
    inputVatRecoverable: false,
  }),
  defineAccount({
    // A tip is collected on behalf of a therapist, so it is a liability from the moment it is taken
    // and never revenue. Booking it to revenue overstates the VAT base and the commission base at
    // once.
    code: ACCOUNTS.tipsPayable,
    name: 'Tips payable to therapists',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.packageDeferredRevenue,
    name: 'Deferred revenue — packages',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.voucherDeferredRevenue,
    name: 'Deferred revenue — gift vouchers',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.wagesPayable,
    name: 'Wages and salaries payable',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.wpsPayrollClearing,
    name: 'WPS payroll clearing',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // End-of-service gratuity accrues monthly as a balance-sheet liability (docs/06 C4). Treating it
    // as a cash cost at termination is the specific mistake this account prevents.
    code: ACCOUNTS.gratuityLiability,
    name: 'End-of-service gratuity liability',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.leaveLiability,
    name: 'Accrued annual leave liability',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.commissionPayable,
    name: 'Staff commission payable',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.refundsPayable,
    name: 'Customer refunds payable',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.corporateTaxPayable,
    name: 'Corporate tax payable',
    type: 'liability',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),

  // --- 3xxx equity ---------------------------------------------------------------------------
  defineAccount({
    code: ACCOUNTS.ownersCapital,
    name: "Owner's capital",
    type: 'equity',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // Contra equity: the second account that breaks "type implies side".
    code: ACCOUNTS.ownersDrawings,
    name: "Owner's drawings",
    type: 'equity',
    normalBalance: 'debit',
    contra: true,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.retainedEarnings,
    name: 'Retained earnings',
    type: 'equity',
    normalBalance: 'credit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),

  // --- 4xxx revenue --------------------------------------------------------------------------
  defineAccount({
    code: ACCOUNTS.treatmentRevenue,
    name: 'Treatment revenue',
    type: 'revenue',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.packageRedemptionRevenue,
    name: 'Package redemption revenue',
    type: 'revenue',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.retailRevenue,
    name: 'Retail product revenue',
    type: 'revenue',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.voucherRedemptionRevenue,
    name: 'Gift voucher redemption revenue',
    type: 'revenue',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),
  defineAccount({
    // [UNVERIFIED] Y11-vat-package: whether breakage on an expired voucher is a supply at all is a
    // tax-agent question. Tagged as standard rated because that is the conservative answer; the
    // account exists separately so changing the answer is a re-tag, not a restatement.
    code: ACCOUNTS.voucherBreakageRevenue,
    name: 'Unredeemed voucher breakage',
    type: 'revenue',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.otherOperatingIncome,
    name: 'Other operating income',
    type: 'revenue',
    normalBalance: 'credit',
    contra: false,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),
  defineAccount({
    // Contra revenue. A discount reduces the standard-rated supply, so it carries the same box as the
    // revenue it offsets; netting it into revenue instead loses the gross-sales figure the owner
    // dashboard reports.
    code: ACCOUNTS.discountsAndAllowances,
    name: 'Discounts and allowances',
    type: 'revenue',
    normalBalance: 'debit',
    contra: true,
    vatBox: 'standard_rated_supplies',
    inputVatRecoverable: false,
  }),

  // --- 5xxx staff cost -----------------------------------------------------------------------
  defineAccount({
    code: ACCOUNTS.therapistWages,
    name: 'Therapist wages',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.commissionExpense,
    name: 'Staff commission expense',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.gratuityExpense,
    name: 'End-of-service gratuity expense',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.leaveExpense,
    name: 'Annual leave expense',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // Government fees carry no input VAT to recover, so they are not merely unrecovered — they are
    // classified as carrying none, which keeps them out of the box 9 total.
    code: ACCOUNTS.visaAndMedicalFees,
    name: 'Visa, permit and medical fees',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // Blocked input VAT, and the reclassification M-VAT-02 made (migration 0034). An employee benefit
    // is recoverable only where the business is OBLIGED to provide it: docs/04 §7 names mandatory
    // unemployment and health insurance — which is why 6110 below stays recoverable — and names no
    // obligation to house or transport staff. docs/13 §2 says staff transport at 02:00 "is a safety
    // matter", so the cost is real and the obligation is unconfirmed. OPEN-QUESTIONS Y11-blocked-vat
    // holds the conservative answer: not recoverable. See ../tax/recoverability.ts for the category.
    code: ACCOUNTS.staffAccommodation,
    name: 'Staff accommodation and transport',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'blocked_input_tax',
    inputVatRecoverable: false,
  }),

  // --- 6xxx operating cost -------------------------------------------------------------------
  defineAccount({
    code: ACCOUNTS.rent,
    name: 'Rent',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.utilities,
    name: 'Utilities',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.consumablesUsed,
    name: 'Treatment consumables used',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.costOfRetailGoodsSold,
    name: 'Cost of retail goods sold',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.laundryAndCleaning,
    name: 'Laundry and cleaning',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.repairsAndMaintenance,
    name: 'Repairs and maintenance',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.marketing,
    name: 'Marketing and advertising',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    // The offshore suppliers named in docs/04 section 4 bill from outside the UAE, which makes this
    // the account the reverse-charge exception report watches.
    code: ACCOUNTS.importedServices,
    name: 'Software and imported services',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'reverse_charge',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.paymentProcessingFees,
    name: 'Payment processing fees',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    // Bank charges on exempt financial services carry no input VAT, unlike merchant acquiring fees
    // above. Separating the two is what lets box 9 be derived rather than adjusted by hand.
    code: ACCOUNTS.bankCharges,
    name: 'Bank charges',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // Blocked input VAT (docs/04 section 4). `defineAccount` refuses this row if anyone ever sets
    // inputVatRecoverable true on it. The premises serve complimentary herbal tea (docs/13 §2), so this
    // is a cost from the first month rather than a category held open for completeness.
    code: ACCOUNTS.entertainment,
    name: 'Entertainment and staff hospitality',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'blocked_input_tax',
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.finesAndPenalties,
    name: 'Fines and penalties',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.professionalFees,
    name: 'Professional fees',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.insurance,
    name: 'Insurance',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: 'recoverable_input_tax',
    inputVatRecoverable: true,
  }),
  defineAccount({
    code: ACCOUNTS.licenceAndGovernmentFees,
    name: 'Licence and government fees',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.depreciation,
    name: 'Depreciation',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    // The drawer discrepancy account. Without it a short till is absorbed into revenue or into the
    // therapist's tips, and the variance nobody can see is the variance nobody investigates.
    code: ACCOUNTS.cashOverShort,
    name: 'Cash over and short',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.badDebt,
    name: 'Bad debt written off',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
  defineAccount({
    code: ACCOUNTS.corporateTaxExpense,
    name: 'Corporate tax expense',
    type: 'expense',
    normalBalance: 'debit',
    contra: false,
    vatBox: null,
    inputVatRecoverable: false,
  }),
]

export const STANDARD_SPA_CHART: ChartOfAccounts = Object.freeze({
  id: 'standard-spa-uae',
  provisional: Object.freeze({
    openQuestionId: 'Y8-coa',
    note:
      'Standard UAE spa chart, provisional until the existing chart and the monthly reporting the ' +
      'accountant expects are supplied. Answering Y8-coa should be a mapping exercise, not a ' +
      're-design.',
  }),
  accounts: STANDARD_SPA_ACCOUNTS,
})

/**
 * Lookup index, built once per chart.
 *
 * A `WeakMap` rather than a field on the chart, so a `ChartOfAccounts` stays plain data that
 * M-TILL-02 can read straight out of a database row without having to reconstruct a cache. Rebuilding
 * the index per call would be correct and would also turn a 1,000-run property test into 60,000
 * linear scans.
 */
const indexes = new WeakMap<ChartOfAccounts, ReadonlyMap<string, Account>>()

function indexOf(chart: ChartOfAccounts): ReadonlyMap<string, Account> {
  const existing = indexes.get(chart)
  if (existing) return existing
  const built = new Map<string, Account>(chart.accounts.map((a) => [a.code as string, a]))
  indexes.set(chart, built)
  return built
}

export function findAccount(chart: ChartOfAccounts, code: AccountCode): Account | undefined {
  return indexOf(chart).get(code as string)
}

/** Resolves a code, or throws `UnknownAccount`. Used by `postEntry`, which must never guess. */
export function accountFor(chart: ChartOfAccounts, code: AccountCode): Account {
  const found = findAccount(chart, code)
  if (found === undefined) throw new UnknownAccount(code as string, chart.id)
  return found
}

export function chartCodes(chart: ChartOfAccounts): readonly AccountCode[] {
  return chart.accounts.map((a) => a.code)
}

export function accountsOfType(chart: ChartOfAccounts, type: AccountType): readonly Account[] {
  return chart.accounts.filter((a) => a.type === type)
}

/** Accounts carrying recoverable input VAT, which is the population box 9 is derived from. */
export function recoverableInputVatAccounts(chart: ChartOfAccounts): readonly Account[] {
  return chart.accounts.filter((a) => a.inputVatRecoverable)
}

import { AppError } from '@berelax/shared'
import type { Account, AccountCode } from '../ledger/account.ts'
import { missingAccountFields } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import type { BillTaxTreatment } from '../purchases/bill.ts'

/**
 * Which input VAT may be reclaimed, which is blocked, and which never arose.
 *
 * Pure: the classification is a function of the account, and the account is data. Nothing here reads a
 * clock, a database or a supplier.
 *
 * ## Three positions, stated on every account, none of them defaulted
 *
 * `account.inputVatRecoverable` is `not null` with no default and `account.vatBox` is
 * nullable-but-explicit (0018), and together they state one of three things:
 *
 *   - **blocked** — `vatBox === 'blocked_input_tax'`. The supplier charged VAT and UAE VAT denies
 *     recovery on this category of spend. The VAT is part of the cost.
 *   - **recoverable** — `inputVatRecoverable`. The VAT is claimable against a valid tax invoice.
 *   - **out_of_scope** — neither. No recoverable input VAT arises on this account at all: a government
 *     fee, a fine, a bank charge on an exempt financial service, wages.
 *
 * `defineAccount` refuses the contradictory pair (`blocked_input_tax` **and** recoverable), which is
 * what makes {@link recoverabilityOf} total rather than a guess about precedence.
 *
 * ## The blocked categories are the ones this business incurs, and no others
 *
 * docs/04 §4: "**Blocked input VAT** — entertainment and certain other categories. Needs an account
 * classification so it is excluded from recovery automatically." {@link BLOCKED_INPUT_VAT_CATEGORIES}
 * is that classification, each entry naming the docs line it comes from and the purchase this business
 * actually makes under it. {@link BLOCKED_CATEGORIES_NOT_INCURRED} names the one UAE VAT blocks that
 * this business has no exposure to, so its absence from the chart reads as a decision rather than an
 * oversight — inventing an account for a motor vehicle nobody owns would put a category into the
 * working papers that can only ever be zero, and a zero nobody can explain is indistinguishable from a
 * figure somebody forgot.
 *
 * ## What this module deliberately does not decide
 *
 * **Whether the supplier held a TRN.** A supplier with no TRN supports no claim at all, and that rule
 * is enforced in the database (`bill_recoverable_needs_a_trn`, `bill_blocked_needs_a_trn` and the
 * ZV001 trigger) and explained by `postBill`, which names the supplier and the lines —
 * `isInputVatWithoutTrn` in `@berelax/db` is how a caller recognises it. Restating it here would be a
 * fourth statement of one rule, and this module cannot see a supplier anyway: what matters is the TRN
 * **at the time of the bill**, which is a snapshot on the row.
 *
 * **What a posted line recovered.** That is written on `bill_line` when the bill is recorded and is
 * never recomputed from this module. A return that re-derived recoverability from today's chart would
 * restate a filed period the day an interpretation changes, and Y11-blocked-vat is exactly such an
 * interpretation. Reclassifying an account changes what the next bill records.
 */

/** The three positions an account can take on input VAT recovery. */
export const INPUT_VAT_RECOVERABILITIES = ['recoverable', 'blocked', 'out_of_scope'] as const
export type InputVatRecoverability = (typeof INPUT_VAT_RECOVERABILITIES)[number]

/**
 * The account's position on input VAT recovery, derived from the two classifications it states.
 *
 * Total, and in this order: `defineAccount` refuses `blocked_input_tax` together with
 * `inputVatRecoverable`, so no account can satisfy the first two branches at once and the precedence
 * below is a consequence of the chart rather than a choice this function makes.
 */
export function recoverabilityOf(account: Account): InputVatRecoverability {
  if (account.vatBox === 'blocked_input_tax') return 'blocked'
  if (account.inputVatRecoverable) return 'recoverable'
  return 'out_of_scope'
}

/** True for a category UAE VAT denies recovery on: entertainment, or a non-obligatory staff benefit. */
export function isBlockedCategory(account: Account): boolean {
  return recoverabilityOf(account) === 'blocked'
}

/**
 * One blocked category: the account it posts to, the documentation that puts it there, and what this
 * business buys under it.
 *
 * `openQuestionId` is set wherever the **conservative** reading is what decided the classification, so
 * the provisional part of the answer travels with the data rather than living only in a commit message.
 * See docs/OPEN-QUESTIONS.md.
 */
export interface BlockedInputVatCategory {
  readonly id: string
  readonly account: AccountCode
  /** The line of documentation this category comes from, quoted closely enough to find. */
  readonly source: string
  /** Why UAE VAT blocks recovery here. */
  readonly basis: string
  /** What this business actually incurs under it. A category with no exposure does not belong here. */
  readonly incurred: string
  /** The open question the conservative reading stands in for, or `null` where the answer is settled. */
  readonly openQuestionId: string | null
  /** What is provisional, stated where a reader of the classification will see it. */
  readonly conservativeNote: string | null
}

export const BLOCKED_INPUT_VAT_CATEGORIES: readonly BlockedInputVatCategory[] = [
  Object.freeze({
    id: 'entertainment_and_hospitality',
    account: ACCOUNTS.entertainment,
    source:
      'docs/04-uae-compliance.md §4: "Blocked input VAT — entertainment and certain other categories. ' +
      'Needs an account classification so it is excluded from recovery automatically."',
    basis:
      'UAE VAT denies recovery on entertainment provided to anyone who is not an employee — customers, ' +
      'potential customers and officials — and on hospitality beyond what a business is obliged to ' +
      'provide its own staff.',
    incurred:
      'The premises serve "complimentary herbal tea and shower" (docs/13 §2), so hospitality bought for ' +
      'customers is a cost from the first month rather than a hypothetical line in the chart.',
    openQuestionId: 'Y11-blocked-vat',
    conservativeNote:
      'Entertainment itself is settled: docs/04 names it, and 0018 tagged 6090 blocked_input_tax from ' +
      'the start. What is open is which side of the line the complimentary in-treatment tea falls — an ' +
      'entertainment service, or a consumable used in making a taxable supply. It is coded here, which ' +
      'is the conservative reading: an over-claim is a penalty and an under-claim is money left on the ' +
      'table, and only one of those is a compliance failure.',
  }),
  Object.freeze({
    id: 'employee_benefits_not_obliged',
    account: ACCOUNTS.staffAccommodation,
    source:
      'docs/04-uae-compliance.md §7 names the benefits the business IS obliged to provide — "Mandatory ' +
      'unemployment insurance and employee health insurance" — and names no obligation to house or ' +
      'transport staff. docs/13 §2: "Staff transport at 02:00 is a safety matter."',
    basis:
      'Input VAT on a benefit provided to an employee for their personal benefit is blocked unless the ' +
      'business is obliged to provide it by law or by the employment contract. The obligation is the ' +
      'whole test, which is why mandatory health insurance stays recoverable on 6110 and this account ' +
      'does not.',
    incurred:
      'Nineteen therapists finishing at 02:00 (docs/13 §2, §5), when transport is a safety matter — so ' +
      'staff transport is a real monthly cost, and a recurring one (0031).',
    openQuestionId: 'Y11-blocked-vat',
    conservativeNote:
      'Reclassified from recoverable by migration 0034 on the conservative reading: no document records ' +
      'an obligation to provide accommodation or transport, and a claim made without one is the ' +
      'over-claim. If the tax agent confirms a contractual or legal obligation the answer is an audited ' +
      'reclassification, which applies to the next bill and cannot reach a filed period.',
  }),
]

/**
 * A category UAE VAT blocks that this business has no exposure to, and why the chart has no account for
 * it.
 *
 * Stated rather than silently omitted. A future reader asking "why is there no motor-vehicle block?"
 * gets the answer here instead of concluding it was forgotten and adding an account that can only ever
 * hold zero — and `recoverability.test.ts` asserts the chart really does not carry one, so the entry
 * cannot drift out of agreement with the chart it describes.
 */
export interface BlockedCategoryNotIncurred {
  readonly id: string
  readonly source: string
  readonly reason: string
  /** Words that must not name an account in the chart while this entry stands. */
  readonly absentFromChart: readonly string[]
}

export const BLOCKED_CATEGORIES_NOT_INCURRED: readonly BlockedCategoryNotIncurred[] = [
  Object.freeze({
    id: 'motor_vehicle_available_for_personal_use',
    source:
      'docs/01-scope-and-decisions.md: outcall and mobile therapists were "Dropped by the owner", which ' +
      '"Removes travel-time matrices, geocoding, maps API cost, dispatcher console, zone pricing, ' +
      'vehicle and mileage records, GPS lone-worker tracking and arrival-window booking".',
    reason:
      "UAE VAT blocks recovery on a motor vehicle available for an employee's personal use. The " +
      'business operates no vehicle: there is no fleet, no mileage record and no vehicle account in the ' +
      'chart, so there is nothing to classify. An account invented for it would appear in every VAT201 ' +
      'working paper as a zero nobody can explain.',
    absentFromChart: ['vehicle', 'motor', 'fleet', 'mileage'],
  }),
]

/**
 * The treatment a line **that carries VAT** must be recorded under, given the account it is coded to.
 *
 * The pure twin of `assert_line_matches_account_recoverability()` in `0034_blocked_input_vat.sql`: the
 * database refuses a claim on an account that is not classified recoverable and a blocked line on an
 * account that is not a blocked category, and this is the same rule stated where a caller can *ask* it
 * instead of being refused by it. The two are asserted to agree in
 * `packages/fixtures/src/recoverability.itest.ts`, over every expense account in the chart.
 *
 * It throws for an out-of-scope account rather than returning a treatment, because there is no honest
 * answer: an account carrying no recoverable input VAT has been handed a line with VAT on it, and the
 * mistake is the coding, not the treatment.
 */
export function vatBearingTreatmentFor(
  account: Account,
): Extract<BillTaxTreatment, 'standard_recoverable' | 'blocked_not_recoverable'> {
  const recoverability = recoverabilityOf(account)
  if (recoverability === 'blocked') return 'blocked_not_recoverable'
  if (recoverability === 'recoverable') return 'standard_recoverable'
  throw new AppError(
    'validation',
    `Account ${account.code} (${account.name}) is out of scope for input VAT, so a line on it carries ` +
      'no VAT to treat. Code the line to the account whose category the spend belongs to.',
    { details: { account: account.code as string, recoverability } },
  )
}

/** The blocked accounts of a chart, in code order. The population the disclosure line is derived from. */
export function blockedInputVatAccounts(chart: ChartOfAccounts): readonly Account[] {
  return chart.accounts.filter(isBlockedCategory)
}

/** The category that put this account in the blocked population, or `undefined`. */
export function blockedCategoryFor(code: AccountCode): BlockedInputVatCategory | undefined {
  return BLOCKED_INPUT_VAT_CATEGORIES.find((category) => category.account === code)
}

/**
 * Every expense account that leaves a recovery classification unstated.
 *
 * Empty for a chart built with `defineAccount`, which refuses an omission at construction — so this
 * exists for the boundary the constructor cannot police: a chart read back out of a database, or one
 * assembled by a later unit. `null` counts as stated and `undefined` does not, which is the distinction
 * "nullable but explicit" rests on and the reason this delegates to `missingAccountFields` instead of
 * testing truthiness.
 */
export function expenseAccountsMissingRecoverability(
  chart: ChartOfAccounts,
): readonly { readonly code: string; readonly missing: readonly string[] }[] {
  const classifications = ['vatBox', 'inputVatRecoverable']
  return chart.accounts
    .filter((account) => account.type === 'expense')
    .map((account) => ({
      code: String((account as { code?: unknown }).code ?? '?'),
      missing: missingAccountFields(account).filter((field) => classifications.includes(field)),
    }))
    .filter((row) => row.missing.length > 0)
}

/**
 * Raised when a chart contains an expense account that has not stated its recovery classification.
 *
 * An unclassified expense is the failure this unit exists to make impossible: it drops out of the box 9
 * population silently, so the return is wrong in the direction nobody notices — smaller.
 */
export class UnclassifiedExpenseAccounts extends AppError {
  constructor(rows: readonly { readonly code: string; readonly missing: readonly string[] }[]) {
    super(
      'invariant_violated',
      `${rows.length} expense account(s) leave input VAT recovery unstated: ` +
        rows.map((row) => `${row.code} (${row.missing.join(', ')})`).join('; '),
      { details: { accounts: rows.map((row) => row.code) } },
    )
    this.name = 'UnclassifiedExpenseAccounts'
  }
}

/** Throws {@link UnclassifiedExpenseAccounts} unless every expense account is classified. */
export function assertEveryExpenseAccountClassified(chart: ChartOfAccounts): void {
  const rows = expenseAccountsMissingRecoverability(chart)
  if (rows.length > 0) throw new UnclassifiedExpenseAccounts(rows)
}

/**
 * The three chart-of-accounts codes the gratuity posting rule needs, and the settings that hold them.
 *
 * ## Why the codes are HERE and not in the posting rule
 *
 * The acceptance criterion is that *"debit and credit accounts are resolved from the chart of accounts
 * through settings, with a grep test asserting no account code literal in the job"*, and the reason is
 * `chart_of_accounts` itself: 0018 makes the chart a ROW rather than a constant because it is provisional
 * against **Y8-coa** — "the business has an existing chart and the accountant has monthly expectations
 * nobody has written down yet". A code written into a posting rule would be this build deciding an
 * accountant's classification, in a journal that by definition cannot be edited (ADR 0017), where changing
 * it later means restating history rather than editing a settings screen.
 *
 * ## Why the DEFAULTS are here rather than read from `@berelax/core`'s chart
 *
 * The boundary `./wps.ts` describes, with the same three readers. `@berelax/config` declares the settings
 * and their defaults, `@berelax/db` stores what is written into them, and `@berelax/core` holds the chart
 * these codes must exist in — and `packages/config` depends on this package alone and may not import
 * `@berelax/core`. So the default has to live somewhere both can see, and a string spelled twice is a
 * string that drifts.
 *
 * `packages/fixtures/src/hr-gratuity.test.ts` asserts each constant below equals the matching entry in
 * `@berelax/core`'s `ACCOUNTS` — fixtures being the one package allowed to import both, which is the same
 * device the registry's `OWNER_ACCOUNTANT` list uses to stay equal to the F07 permission matrix. So a
 * renumbered account in the chart fails the build here rather than leaving a setting pointing at a code the
 * chart no longer has.
 *
 * ## These are DEFAULTS and not decisions
 *
 * Each setting is flagged provisional against Y8-coa and appears on the Unconfirmed Assumptions panel, so
 * an accountant mapping the real chart changes three audited settings rather than a migration. The codes
 * themselves are the standard spa chart's, which `@berelax/core` chose so that answering Y8-coa is a
 * mapping exercise rather than a redesign.
 */

/** The expense account a month's gratuity accrual is debited to. */
export const GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY = 'hr.gratuity_expense_account'
/** The balance-sheet liability account the accrual is credited to. */
export const GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY = 'hr.gratuity_liability_account'
/**
 * The payable a leaver's settlement is credited to.
 *
 * A PAYABLE and never cash or bank: a settlement discharges the liability and the money leaves through the
 * payroll run, so crediting cash here would pay it twice — once when the settlement posts and again when
 * the run does.
 */
export const GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY =
  'hr.gratuity_settlement_payable_account'

/** `ACCOUNTS.gratuityExpense` in `@berelax/core`'s standard spa chart. */
export const DEFAULT_GRATUITY_EXPENSE_ACCOUNT = '5030'
/** `ACCOUNTS.gratuityLiability`. */
export const DEFAULT_GRATUITY_LIABILITY_ACCOUNT = '2070'
/** `ACCOUNTS.wagesPayable`. */
export const DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT = '2060'

/** The `OPEN-QUESTIONS.md` id all three stand on, so a reader of any is one grep from the question. */
export const GRATUITY_ACCOUNTS_OPEN_QUESTION_ID = 'Y8-coa'

/**
 * The shape every account-code setting must take: exactly four digits.
 *
 * The same pattern `account.code`'s own CHECK uses in 0018 (`^[0-9]{4}$`). Restated here rather than
 * imported because it is the only thing the settings layer can check without the chart: whether the code
 * EXISTS is a question for the foreign key on `journal_line.account_code`, which refuses a posting naming
 * an account the chart does not contain, and a settings-time chart lookup would be a second answer to that.
 */
export const ACCOUNT_CODE_PATTERN = /^[0-9]{4}$/

/** The `OPEN-QUESTIONS.md` id the gratuity FIGURES stand on. Distinct from the accounts' Y8-coa. */
export const GRATUITY_RULE_OPEN_QUESTION_ID = 'Y9-gratuity'

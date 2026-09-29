import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { commissionPeriodSource } from '../repositories/commission.ts'
import { readPackageLiability } from '../services/redeem-package.ts'
import { DEFERRED_REVENUE_ACCOUNT_CODE } from '../services/sell-package.ts'
import type { UnitOfWork } from '../tx.ts'
import { trialBalanceMovement } from './trial-balance.ts'
import {
  canonicaliseVat201WorkingPapers,
  vat201Boxes,
  vat201BoxForGrouping,
} from './vat201-working-papers.ts'

/**
 * The closed-month reconciliation report: bookings to invoices to payments to journal to VAT boxes, as
 * named lines with a figure on each side and a variance that has to be zero (M-VAT-12).
 *
 * # Which function is the ONE SOURCE of every figure here
 *
 * A reconciliation report is exactly where a second derivation of an existing figure creeps in, and a
 * second derivation of a money figure is worse than a missing one: two numbers, both plausible, with
 * nothing able to say which is the one that was filed. So this module derives as little as it can, and
 * every figure it does not derive is named here with the unit that owns it:
 *
 *   | figure                                    | the one source                          | unit      |
 *   | ----------------------------------------- | --------------------------------------- | --------- |
 *   | ledger movement over the period           | `trialBalanceMovement`                  | M-VAT-01  |
 *   | the deferred package liability            | `readPackageLiability`                  | M-TILL-10 |
 *   | a VAT201 box figure                       | `vat201Boxes`                           | M-VAT-07  |
 *   | which box a grouping maps to              | `vat201BoxForGrouping`                  | M-VAT-07  |
 *   | the canonical bytes of a money artefact   | `canonicaliseVat201WorkingPapers`       | M-VAT-07  |
 *   | the instant a closed period is read at    | `commissionPeriodSource`                | P-HR-11   |
 *   | whether a date is inside a closed period  | `periodStatusOn`, through the above     | M-VAT-06  |
 *
 * `periodStatusOn` is deliberately NOT called from this file. It has one reader per ADR 0026's
 * arrangement, `commissionPeriodSource` is already that reader's caller, and a report permitted by one
 * reading of the lock and refused by another is the defect that arrangement exists to prevent.
 *
 * The **document** aggregates — invoice gross, credit-note gross, tendered, refunded, completed
 * appointments, no-shows, cancellations — have no prior source in this repository. Measured, not assumed:
 * nothing in `packages`, `apps` or `scripts` sums `invoice.gross_total` or `payment.applied_fils` over a
 * period. This module is therefore their first source, and `MONTH_RECONCILIATION_DERIVED_HERE` names them
 * so that a later unit adding a second one fails a test instead of shipping a disagreement.
 *
 * # The one figure this module has to refine, and how the refinement is tied back
 *
 * Three identities need the ledger movement **per journal source** — an invoice's revenue and a package
 * redemption's revenue land on the same accounts and answer to different documents — and
 * `trialBalanceMovement` returns the movement per ACCOUNT with no source dimension. It cannot be given
 * one without changing a function nine `done` units assert against.
 *
 * So {@link ledgerCensus} below computes the movement per (account, source) pair, and
 * `ledger_census_against_the_trial_balance` is a LINE OF THIS REPORT: the census summed over every source,
 * per account, against `trialBalanceMovement`'s own figure for that account. The refinement is therefore
 * not a second answer — it is an answer whose total the report itself holds to the one source, and a wrong
 * date predicate or a dropped join in the census makes that line non-zero rather than making four other
 * lines quietly agree with each other.
 *
 * # As of the lock, and why that is a LINE rather than a filter
 *
 * A period lock is the authority on what a closed month's figures were. `sourceAsOf` is therefore the
 * lock's own `locked_at` for a closed period and the caller's instant for an open one, exactly as
 * `commissionPeriodSource` decides it for a commission run, and it is stored on the report so a
 * regeneration years later reads at the same instant.
 *
 * What this report does NOT do is silently filter every read on `created_at <= sourceAsOf`, and the reason
 * is the one M-VAT-08's header states from the other side. Two of the figures — the package liability and
 * the ledger movement — come from functions that take no such filter, and re-deriving them with one is the
 * second derivation this whole module is arranged to avoid. More importantly, a silent filter would HIDE
 * the case it exists for: a period reopened by migration (ADR 0026) and posted into again would still
 * report the figures as filed, with nothing anywhere saying the ledger behind them had moved. That is the
 * failure that restates a filed return.
 *
 * So the discipline is visible instead: `rows_created_after_the_period_lock` counts, across every document
 * table this report reads, the rows dated inside the period whose `created_at` is later than `sourceAsOf`.
 * Zero is what makes "as of the lock" and "as of now" the same answer. Non-zero is a named variance that
 * says the month has been reopened and the figures are not the ones that were filed.
 *
 * # Every figure is a bigint, and the report never reads a clock
 *
 * `sum()` over the `fils` domain returns numeric and the driver hands it back as a string precisely so
 * nothing can silently round; `./trial-balance.ts` records the four-fils difference a `number` produced
 * out of nothing. Both ends of the period and the evaluation instant are arguments, so the report for a
 * closed month is the same report next year — which is the acceptance line, and impossible to even ask of
 * a query that read `current_date`.
 */

/** The canonical form's own tag. A later shape is INCOMPARABLE to this one rather than merely unequal. */
export const MONTH_RECONCILIATION_FORMAT_VERSION = 'month-recon-1'

/**
 * Every line the report carries, in the order it carries them.
 *
 * Declared once here and asserted against the report the builder actually produced, in the order it
 * produced them — so the ORDER is part of the contract rather than an accident of how the array literal
 * below happens to be written. Two reasons, and the first is the acceptance line: the bytes have to be
 * identical between two runs, and a reordered array is different bytes for identical figures.
 *
 * The second is that `packages/fixtures/src/month-reconciliation.ts` holds the committed worked example
 * and states an expectation per line. `packages/db` may never import `packages/fixtures`, so this list is
 * what the two halves agree through: the worked example requires its expectations to cover exactly these
 * ids, and a line added here without one fails that test rather than being quietly unexamined.
 */
export const MONTH_RECONCILIATION_LINE_IDS = [
  'completed_appointments_without_a_document',
  'invoices_less_credit_notes_against_revenue_and_output_vat',
  'payments_less_refunds_against_tender_accounts',
  'package_liability_movement_against_sales_less_redemptions',
  'package_redemptions_against_revenue_and_output_vat',
  'output_tax_against_the_vat201_box',
  'ledger_census_against_the_trial_balance',
  'no_shows_excluded_from_revenue',
  'cancellations_excluded_from_revenue',
  'treasury_movements_excluded_from_receipts',
  'rows_created_after_the_period_lock',
] as const

export type MonthReconciliationLineId = (typeof MONTH_RECONCILIATION_LINE_IDS)[number]

/**
 * The document aggregates this module is the first and only source of.
 *
 * Named so that the claim in the header is a thing a test can check rather than a sentence. A later unit
 * that needs one of these reads it from here; a second summation of one is a future disagreement about a
 * figure a tax agent has already been handed.
 */
export const MONTH_RECONCILIATION_DERIVED_HERE = [
  'invoice.gross_total over a period',
  'invoice.vat_total over a period',
  'credit_note.gross_total over a period',
  'credit_note.vat_total over a period',
  'payment.applied_fils over a period',
  'refund.amount_fils over a period',
  'package_redemption.released_fils over a period',
  'appointment counts by status over a period',
  'journal_line movement per (account, source) over a period',
] as const

// --- the classification of a journal source -----------------------------------------------------

/**
 * Every value `journal_entry.source` may hold, sorted into the reading each one gets here.
 *
 * A source is in exactly one class, and the classes are not decoration: `sale` and `refund` answer to an
 * invoice and a credit note, `package_sale` and `package_redemption` answer to the package tables, and the
 * rest answer to nothing this report reads and must therefore be EXCLUDED by name rather than by falling
 * off the end of a `where` clause.
 *
 * {@link assertEverySourceIsClassified} reads the permitted list out of `journal_entry`'s own CHECK and
 * refuses a source that appears in neither. That is the direction that matters: a migration adding an
 * eighteenth source would otherwise make every identity here quietly ignore whatever it posted, and the
 * report would keep saying zero variance about a month it had stopped examining (ADR 0002).
 */
export const JOURNAL_SOURCE_CLASSES = {
  /**
   * The entries that move REVENUE and output VAT against a document: a checkout's sale entry, and a
   * credit note's reversal.
   *
   * `reversal` is in this class and `refund` is NOT, which is the one pairing here that is easy to get
   * backwards and was, in this file, until the itest was written. Measured from the two services: a credit
   * note's reversal entry carries `source = 'reversal'` and debits revenue and output VAT
   * (`issue-credit-note.ts` refuses any other source outright), while a refund's entry carries
   * `source = 'refund'` and moves MONEY — `Dr 1050, Cr` the tender account — and touches no revenue
   * account at all. A report that read `refund` as the credit note's entry would compare credit-note gross
   * against nothing and find a variance the size of every credit note in the month.
   *
   * A generic dated correction also posts as `reversal` (ADR 0017). That is harmless rather than
   * overlooked: the identity filters by ACCOUNT as well as by class, so a reversal of a supplier bill
   * lands on purchase accounts and is not reached, while a reversal that really does move revenue with no
   * credit note behind it is a variance, which is the honest answer.
   */
  document_sale: ['sale', 'reversal'],
  /** Money in and out against an issued document: a later capture, and a refund. Tenders and `1050`. */
  receipt: ['payment', 'refund'],
  /** Answered by `package_sale`, `package_redemption` and `package_balance`. */
  package: ['package_sale', 'package_redemption'],
  /**
   * Money moved BETWEEN the business's own accounts, or out of them, after it was received. A banking
   * run and a drawer payout are not receipts, and counting them as receipts would make the tender
   * identity out by every day's banking.
   */
  treasury: ['cash_up', 'payout'],
  /** The purchase side. M-VAT-02 and M-VAT-03 own its reconciliations; this report states none. */
  purchase: ['supplier_bill'],
  /**
   * Everything else the ledger can carry, excluded by name. `voucher_sale` and `voucher_redemption` are
   * here and not in `package` deliberately: no unit has built the voucher tables, so there is no document
   * side to reconcile against and a class claiming one would be a claim about code that does not exist.
   */
  other: [
    'payroll',
    'gratuity_accrual',
    'commission_accrual',
    'voucher_sale',
    'voucher_redemption',
    'depreciation',
    'opening_balance',
    'adjustment',
  ],
} as const satisfies Record<string, readonly string[]>

export type JournalSourceClass = keyof typeof JOURNAL_SOURCE_CLASSES

const classOfSource = (source: string): JournalSourceClass | null => {
  for (const [name, sources] of Object.entries(JOURNAL_SOURCE_CLASSES)) {
    if ((sources as readonly string[]).includes(source)) return name as JournalSourceClass
  }
  return null
}

/**
 * The sources `journal_entry`'s CHECK permits, read from the catalogue rather than repeated here.
 *
 * `pg_get_constraintdef` is text and this parses it, which is the same trade `analytics.partition_bounds`
 * makes for a partition bound and for the same reason: the alternative is a second copy of the list, which
 * agrees with the schema right up until a migration changes one of them. Parsing can fail; a parse that
 * returned an empty set would make the classification check pass over nothing, so an empty result throws.
 */
async function permittedJournalSources(sql: Sql): Promise<readonly string[]> {
  const [row] = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conrelid = 'journal_entry'::regclass
       and conname = 'journal_entry_source_check'
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'journal_entry_source_check is absent, so the permitted journal sources cannot be read. The ' +
        'reconciliation report will not guess at them: a guessed list is how a source added by a later ' +
        'migration comes to be ignored by every identity in this report.',
    )
  }
  const sources = [...row.definition.matchAll(/'([a-z_]+)'::text/g)].map(
    (match) => match[1] as string,
  )
  const unique = [...new Set(sources)].sort()
  if (unique.length === 0) {
    throw new AppError(
      'invariant_violated',
      `journal_entry_source_check was read but no source could be parsed out of it: ${row.definition}`,
    )
  }
  return unique
}

/** Sources the schema permits that no class claims, and classes naming a source the schema does not. */
export interface SourceClassificationCensus {
  readonly unclassified: readonly string[]
  readonly notPermitted: readonly string[]
}

/**
 * The classification, checked against the schema in BOTH directions.
 *
 * Both, because each direction fails differently and only one of them is loud. An unclassified source
 * makes this report ignore what it posted. A class naming a source the schema has dropped makes the
 * classification describe a ledger that no longer exists — which costs nothing today and is how the list
 * comes to be trusted when it should not be.
 */
export async function classifyJournalSources(sql: Sql): Promise<SourceClassificationCensus> {
  const permitted = await permittedJournalSources(sql)
  const claimed = new Set(Object.values(JOURNAL_SOURCE_CLASSES).flat() as readonly string[])
  return {
    unclassified: permitted.filter((source) => classOfSource(source) === null),
    notPermitted: [...claimed].filter((source) => !permitted.includes(source)).sort(),
  }
}

/** Throws when either direction of {@link classifyJournalSources} is non-empty. */
export async function assertEverySourceIsClassified(sql: Sql): Promise<void> {
  const census = await classifyJournalSources(sql)
  if (census.unclassified.length === 0 && census.notPermitted.length === 0) return
  throw new AppError(
    'invariant_violated',
    'The month reconciliation cannot classify every journal source. Unclassified: ' +
      `[${census.unclassified.join(', ')}]; claimed but not permitted: ` +
      `[${census.notPermitted.join(', ')}]. Add each to JOURNAL_SOURCE_CLASSES with the reading it ` +
      'gets, because a source no class claims is a figure every identity in this report ignores.',
  )
}

// --- the shape a caller reads -------------------------------------------------------------------

export interface MonthReconciliationPeriod {
  /** The period identifier an accountant recognises: `2026-08`. It appears in every refusal. */
  readonly periodId: string
  readonly startsOn: string
  /** The last day **of** the period, not the first day after it. */
  readonly endsOn: string
}

/**
 * Which of a line's two figures carries its claim.
 *
 * `fils` for a money identity and `rows` for a count, named on the line rather than inferred from whether
 * the fils happen to be zero: an identity over two zero figures reconciles perfectly and says nothing, and
 * a reader has to be able to tell "no money moved" from "this line is about how many there were".
 */
export type ReconciliationMeasure = 'fils' | 'rows'

/**
 * What a line is for.
 *
 * `identity` claims its two figures are EQUAL, and a non-zero variance in its measure fails the report.
 *
 * `excluded` claims something different, and the difference cost this file a defect its own itest found:
 * an excluded line's left is a population deliberately absent from every identity, so the claim is NOT
 * that the two sides agree — it is that the RIGHT side, the part of that population which reached a
 * document after all, is empty. Read as an equality, one no-show in the month is a variance.
 *
 * `census` is a claim about the report's own REACH rather than about the money: failing it does not make a
 * figure wrong, it makes the figures not the ones the period was closed on. It is therefore kept out of
 * `unexplainedVarianceLines` and drives `notExportableReasons` instead.
 *
 * `stated` is a figure reported so it is not silently dropped, with NO claim attached. Exactly one line
 * uses it — the treasury movement the tender identity excludes by name — and it is a distinct kind rather
 * than an `excluded` line that happens always to hold, because a check that can never fail dressed up as
 * a check is the thing ADR 0002 is about. A reader tells the two apart from the kind alone.
 */
export type ReconciliationLineKind = 'identity' | 'excluded' | 'census' | 'stated'

export interface ReconciliationSide {
  readonly label: string
  /** The money this side accounts for, in integer fils. Zero where the line is about a count. */
  readonly fils: bigint
  /**
   * How many rows this side read: documents, appointments or journal lines, whichever the side is.
   *
   * Named `rowsExamined` and not `rows` because it is a VACUITY counter first and a comparable second: on
   * a `fils` line the two sides count different kinds of thing — three documents against six journal
   * lines — and an earlier version of this file subtracted them and published the difference as a
   * variance. It read as "this line is out by 3" about a line that balanced to the fil.
   */
  readonly rowsExamined: number
}

export interface ReconciliationLine {
  /** Stable across runs and across periods. The name a variance is reported BY. */
  readonly id: MonthReconciliationLineId
  readonly kind: ReconciliationLineKind
  readonly measure: ReconciliationMeasure
  /** What the line claims, in one sentence, for the report and for the screen. */
  readonly claim: string
  /** The documents, the bookings, the report's own reach — whatever the left of the identity is. */
  readonly left: ReconciliationSide
  /** The ledger, or the figure the left is held to. */
  readonly right: ReconciliationSide
  /**
   * How far the claim is out, in the line's own {@link ReconciliationMeasure} — fils, or rows.
   *
   * ONE number and not one per unit, so a reader of the artefact never has to work out which of two
   * variances this line's claim was about. Zero when the claim holds, for every kind.
   */
  readonly variance: bigint
  /** Where each side's figure came from, so a reader never has to guess which function to blame. */
  readonly derivedFrom: string
}

export interface MonthReconciliation {
  readonly formatVersion: typeof MONTH_RECONCILIATION_FORMAT_VERSION
  readonly period: MonthReconciliationPeriod
  /** True when a `period_lock` covers the last day of the period. */
  readonly closed: boolean
  readonly lockedPeriodId: string | null
  /**
   * The instant the figures are read at: the lock's own `locked_at` for a closed period, the caller's
   * instant for an open one. `commissionPeriodSource`'s answer, never a second one.
   */
  readonly sourceAsOf: string
  readonly lines: readonly ReconciliationLine[]
  /** The ids of every `identity` or `excluded` line whose claim does not hold. Empty in a sound month. */
  readonly unexplainedVarianceLines: readonly string[]
  /**
   * How many document and ledger rows the whole report examined.
   *
   * Reported because a report over an empty month has zero variance and proves nothing, which is ADR
   * 0002's subject. The caller asserts a floor; this figure is what makes that possible.
   */
  readonly examinedRows: number
  /** Non-empty when the report may not be handed to an agent, with the reason in each entry. */
  readonly notExportableReasons: readonly string[]
  /**
   * What is unconfirmed about a report that IS exportable, carried into the bytes.
   *
   * Never empty: the last entry names Y11-tax-agent, whose provisional answer is that an FTA-registered
   * agent's review is not optional and that this build does not assert the report's correctness against
   * FTA practice. A caveat is deliberately NOT a `notExportableReason` — see the comment where they are
   * built for why treating a provisional box number as a blocker would make this export uncallable.
   */
  readonly caveats: readonly string[]
}

// --- the arguments ------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertPeriod(period: MonthReconciliationPeriod): void {
  for (const [what, value] of [
    ['startsOn', period.startsOn],
    ['endsOn', period.endsOn],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new AppError(
        'validation',
        `${what} must be an ISO date (YYYY-MM-DD), got "${value}" for period ${period.periodId}`,
      )
    }
  }
  if (period.endsOn < period.startsOn) {
    throw new AppError(
      'validation',
      `period ${period.periodId} ends (${period.endsOn}) before it starts (${period.startsOn})`,
    )
  }
  if (period.periodId.trim() === '') {
    throw new AppError('validation', 'periodId must not be blank')
  }
}

/**
 * The day before the period starts, which is what `trialBalanceMovement` wants as its exclusive `from`.
 *
 * Computed here rather than passing `startsOn`: `trialBalanceMovement`'s `from` is EXCLUSIVE so that
 * twelve monthly movements sum to the annual one, and passing the first day of the month would drop
 * everything posted on it. Dates only — no clock, no timezone — because a period boundary is a calendar
 * fact about which day a figure belongs to and `Date` arithmetic in UTC is exact for that.
 */
function dayBefore(isoDate: string): string {
  const at = Date.parse(`${isoDate}T00:00:00Z`)
  return new Date(at - 86_400_000).toISOString().slice(0, 10)
}

// --- the ledger census -------------------------------------------------------------------------

interface LedgerCensusRow {
  readonly accountCode: string
  readonly accountType: string
  readonly vatBox: string | null
  readonly contra: boolean
  readonly source: string
  readonly debitFils: bigint
  readonly creditFils: bigint
  readonly lineCount: number
}

/**
 * The movement per (account, source) over the period.
 *
 * The refinement the header explains: three identities need to tell an invoice's revenue from a package
 * redemption's, and those land on the same accounts. `account.vat_box` and `account.type` come along so
 * that "revenue" and "output tax" are read off the ROWS rather than written as `4010` and `2030` in this
 * file — M-TILL-13 measured that box 1 is TWO tags and not one, and a report naming the codes would be
 * wrong the first time an account was added to the chart.
 *
 * `entry_date` and never `posted_at`: trading runs 11:00-02:00, so an entry posted at 01:30 belongs to the
 * previous trading date, and cutting on the instant would move a late sale into the next VAT period.
 */
async function ledgerCensus(
  sql: Sql,
  period: MonthReconciliationPeriod,
): Promise<readonly LedgerCensusRow[]> {
  const rows = await sql<
    {
      account_code: string
      account_type: string
      vat_box: string | null
      contra: boolean
      source: string
      debit_fils: string
      credit_fils: string
      line_count: string
    }[]
  >`
    select l.account_code,
           a.type          as account_type,
           a.vat_box,
           a.contra,
           e.source,
           sum(l.debit_fils)::text  as debit_fils,
           sum(l.credit_fils)::text as credit_fils,
           count(*)::text           as line_count
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
      join account a       on a.code = l.account_code
     where e.entry_date between ${period.startsOn}::date and ${period.endsOn}::date
     group by l.account_code, a.type, a.vat_box, a.contra, e.source
     order by l.account_code, e.source
  `
  return rows.map((row) => ({
    accountCode: row.account_code,
    accountType: row.account_type,
    vatBox: row.vat_box,
    contra: row.contra,
    source: row.source,
    // `sum()` over bigint is numeric and the driver returns it as text so nothing rounds. BigInt, never
    // Number: ./trial-balance.ts records the four fils a `number` invented from a ledger that balanced.
    debitFils: BigInt(row.debit_fils),
    creditFils: BigInt(row.credit_fils),
    lineCount: Number(row.line_count),
  }))
}

/** Credit-positive movement — the natural direction for revenue, VAT and a liability. */
const creditMovement = (rows: readonly LedgerCensusRow[]): bigint =>
  rows.reduce((total, row) => total + row.creditFils - row.debitFils, 0n)

/** Debit-positive movement — the natural direction for cash, a bank account and a clearing account. */
const debitMovement = (rows: readonly LedgerCensusRow[]): bigint =>
  rows.reduce((total, row) => total + row.debitFils - row.creditFils, 0n)

const linesIn = (rows: readonly LedgerCensusRow[]): number =>
  rows.reduce((total, row) => total + row.lineCount, 0)

const inClass = (rows: readonly LedgerCensusRow[], name: JournalSourceClass) =>
  rows.filter((row) => classOfSource(row.source) === name)

// --- the document aggregates --------------------------------------------------------------------

interface DocumentTotals {
  readonly invoiceCount: number
  readonly invoiceGrossFils: bigint
  readonly invoiceVatFils: bigint
  readonly creditNoteCount: number
  readonly creditNoteGrossFils: bigint
  readonly creditNoteVatFils: bigint
  readonly paymentCount: number
  readonly paymentAppliedFils: bigint
  readonly refundCount: number
  readonly refundFils: bigint
  readonly redemptionCount: number
  readonly redemptionReleasedFils: bigint
  readonly redemptionVatFils: bigint
}

/**
 * The document side, in one round trip.
 *
 * ## The date each table is cut on, which is three different facts
 *
 * `invoice` and `credit_note` are cut on **`tax_point_date`**, not `issue_date` and not
 * `issue_trading_date`. The tax point is what decides the VAT period (0026): a supply on trading day D
 * invoiced on D+1 keeps its tax point at D, and `issue_trading_date` is NULLABLE by design — an invoice
 * the accountant raises at 10:00 while the premises is shut belongs to no trading date at all, so cutting
 * on it would silently drop that document out of every identity below.
 *
 * `payment` and `refund` are cut on **`trading_date`**, which is the business day the money moved on and
 * the day a cash-up reconciles against. A tender is not a supply and has no tax point.
 *
 * `package_redemption` is cut on **`trading_date`** as well: a redemption issues no document, so the
 * business day it released the liability on is the only date it has.
 */
async function documentTotals(
  sql: Sql,
  period: MonthReconciliationPeriod,
): Promise<DocumentTotals> {
  const [row] = await sql<
    {
      invoice_count: string
      invoice_gross: string
      invoice_vat: string
      credit_note_count: string
      credit_note_gross: string
      credit_note_vat: string
      payment_count: string
      payment_applied: string
      refund_count: string
      refund_total: string
      redemption_count: string
      redemption_released: string
      redemption_vat: string
    }[]
  >`
    select
      (select count(*)::text from invoice
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as invoice_count,
      (select coalesce(sum(gross_total), 0)::text from invoice
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as invoice_gross,
      (select coalesce(sum(vat_total), 0)::text from invoice
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as invoice_vat,
      (select count(*)::text from credit_note
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as credit_note_count,
      (select coalesce(sum(gross_total), 0)::text from credit_note
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as credit_note_gross,
      (select coalesce(sum(vat_total), 0)::text from credit_note
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as credit_note_vat,
      (select count(*)::text from payment
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as payment_count,
      -- applied_fils and never amount_fils: change handed back out of the drawer is not takings, and
      -- the ledger debits what stayed. M-TILL-11's cash-up makes the same distinction in the other
      -- direction and reconciles against both figures rather than one net one.
      (select coalesce(sum(applied_fils), 0)::text from payment
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as payment_applied,
      (select count(*)::text from refund
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as refund_count,
      (select coalesce(sum(amount_fils), 0)::text from refund
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as refund_total,
      (select count(*)::text from package_redemption
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as redemption_count,
      (select coalesce(sum(released_fils), 0)::text from package_redemption
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as redemption_released,
      (select coalesce(sum(vat_fils), 0)::text from package_redemption
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date)
        as redemption_vat
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'the document totals query returned no row')
  }
  return {
    invoiceCount: Number(row.invoice_count),
    invoiceGrossFils: BigInt(row.invoice_gross),
    invoiceVatFils: BigInt(row.invoice_vat),
    creditNoteCount: Number(row.credit_note_count),
    creditNoteGrossFils: BigInt(row.credit_note_gross),
    creditNoteVatFils: BigInt(row.credit_note_vat),
    paymentCount: Number(row.payment_count),
    paymentAppliedFils: BigInt(row.payment_applied),
    refundCount: Number(row.refund_count),
    refundFils: BigInt(row.refund_total),
    redemptionCount: Number(row.redemption_count),
    redemptionReleasedFils: BigInt(row.redemption_released),
    redemptionVatFils: BigInt(row.redemption_vat),
  }
}

/** The accounts the period's own tenders were posted to, read off the rows rather than named here. */
async function tenderAccountCodes(
  sql: Sql,
  period: MonthReconciliationPeriod,
): Promise<readonly string[]> {
  const rows = await sql<{ code: string }[]>`
    select distinct posting_account_code as code from (
      select posting_account_code, trading_date from payment
      union all
      select posting_account_code, trading_date from refund
    ) tendered
     where trading_date between ${period.startsOn}::date and ${period.endsOn}::date
     order by code
  `
  return rows.map((row) => row.code)
}

interface AppointmentCensus {
  readonly completed: number
  readonly completedGrossFils: bigint
  readonly completedWithADocument: number
  readonly noShow: number
  readonly noShowGrossFils: bigint
  readonly noShowWithADocument: number
  readonly cancelled: number
  readonly cancelledGrossFils: bigint
  readonly cancelledWithADocument: number
}

/**
 * The bookings end of the chain: how many appointments the period delivered, and how many of them reached
 * a document.
 *
 * "Reached a document" is an `invoice_appointment` row OR a `package_redemption` row, which are the two
 * ways a delivered treatment is paid for and the only two. A completed appointment with neither is a
 * treatment given away, which is the acceptance line's count and must be zero.
 *
 * The two cancellation states are counted TOGETHER and the enum's nine values are read rather than
 * listed: `cancelled_by_customer` and `cancelled_by_salon` differ in policy and not in whether they are
 * revenue, and a literal list here would silently stop counting a tenth state. `status not in (...)` is
 * the wrong shape for the same reason — it would make a new state a cancellation.
 */
async function appointmentCensus(
  sql: Sql,
  period: MonthReconciliationPeriod,
): Promise<AppointmentCensus> {
  const rows = await sql<
    {
      bucket: string
      appointments: string
      gross_fils: string
      with_a_document: string
    }[]
  >`
    with judged as (
      select a.id,
             a.gross_price_fils,
             case
               when a.status = 'completed' then 'completed'
               when a.status = 'no_show'   then 'no_show'
               when a.status::text like 'cancelled_by_%' then 'cancelled'
               else 'other'
             end as bucket,
             (exists (select 1 from invoice_appointment ia where ia.appointment_id = a.id)
              or exists (select 1 from package_redemption pr where pr.appointment_id = a.id))
               as has_document
        from appointment a
       where a.trading_date between ${period.startsOn}::date and ${period.endsOn}::date
    )
    select bucket,
           count(*)::text                                        as appointments,
           coalesce(sum(gross_price_fils), 0)::text              as gross_fils,
           (count(*) filter (where has_document))::text            as with_a_document
      from judged
     group by bucket
  `
  const bucket = (name: string) => rows.find((row) => row.bucket === name)
  const read = (name: string) => {
    const row = bucket(name)
    return {
      appointments: Number(row?.appointments ?? 0),
      grossFils: BigInt(row?.gross_fils ?? 0),
      withADocument: Number(row?.with_a_document ?? 0),
    }
  }
  const completed = read('completed')
  const noShow = read('no_show')
  const cancelled = read('cancelled')
  return {
    completed: completed.appointments,
    completedGrossFils: completed.grossFils,
    completedWithADocument: completed.withADocument,
    noShow: noShow.appointments,
    noShowGrossFils: noShow.grossFils,
    noShowWithADocument: noShow.withADocument,
    cancelled: cancelled.appointments,
    cancelledGrossFils: cancelled.grossFils,
    cancelledWithADocument: cancelled.withADocument,
  }
}

/**
 * Rows dated inside the period whose `created_at` is after the instant the report reads at.
 *
 * Zero in a month that has been closed and left alone, which is what makes "as of the lock" and "as of
 * now" the same answer for every other line. Non-zero means the period was reopened and posted into, and
 * then every figure in this report is a figure about a month that has changed since it was filed.
 *
 * `${instant}::text::timestamptz` and the `::text` is LOAD-BEARING. postgres.js infers a parameter's type
 * from the cast that follows it, so a bare `::timestamptz` is serialised by the driver's own date
 * serialiser at MILLISECOND precision while the column holds MICROSECONDS — so a `locked_at` of
 * `…:13.123633+00` arrives as `…:13.123+00` and every comparison against the stored value is wrong by up
 * to a millisecond. `repositories/commission.ts` records measuring exactly that, and it cost that unit
 * three failing cases that all looked like a trigger bug.
 */
async function rowsCreatedAfter(
  sql: Sql,
  period: MonthReconciliationPeriod,
  instant: string,
): Promise<number> {
  const [row] = await sql<{ late: string }[]>`
    select (
      (select count(*) from invoice
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date
          and created_at > ${instant}::text::timestamptz)
    + (select count(*) from credit_note
        where tax_point_date between ${period.startsOn}::date and ${period.endsOn}::date
          and created_at > ${instant}::text::timestamptz)
    + (select count(*) from payment
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date
          and created_at > ${instant}::text::timestamptz)
    + (select count(*) from refund
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date
          and created_at > ${instant}::text::timestamptz)
    + (select count(*) from package_sale
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date
          and created_at > ${instant}::text::timestamptz)
    + (select count(*) from package_redemption
        where trading_date between ${period.startsOn}::date and ${period.endsOn}::date
          and created_at > ${instant}::text::timestamptz)
    + (select count(*) from journal_entry
        where entry_date between ${period.startsOn}::date and ${period.endsOn}::date
          and posted_at > ${instant}::text::timestamptz)
    )::text as late
  `
  return Number(row?.late ?? 0)
}

// --- the report ---------------------------------------------------------------------------------

const side = (label: string, fils: bigint, rowsExamined: number): ReconciliationSide => ({
  label,
  fils,
  rowsExamined,
})

/**
 * The variance, which is a different subtraction per kind — see {@link ReconciliationLineKind}.
 *
 * An `identity` is out by left minus right. An `excluded` line is out by whatever its RIGHT side holds:
 * the part of a population that should have reached no document and did. A `stated` line makes no claim
 * and is out by nothing, which is not the same as its two sides being equal.
 */
const varianceOf = (input: Omit<ReconciliationLine, 'variance'>): bigint => {
  if (input.kind === 'stated') return 0n
  const [left, right] =
    input.measure === 'fils'
      ? [input.left.fils, input.right.fils]
      : [BigInt(input.left.rowsExamined), BigInt(input.right.rowsExamined)]
  return input.kind === 'excluded' ? right : left - right
}

const line = (input: Omit<ReconciliationLine, 'variance'>): ReconciliationLine => ({
  ...input,
  variance: varianceOf(input),
})

/** Whether a line's claim holds. One test for every kind, because {@link varianceOf} owns the rest. */
const holds = (row: ReconciliationLine): boolean => row.variance === 0n

/**
 * The report for one period.
 *
 * `nowIso` is the instant an OPEN period is read at and is an argument for the reason every date here is:
 * a report that read a clock could not be regenerated, and regenerating it identically is the acceptance
 * line. For a CLOSED period the argument is ignored in favour of the lock's own `locked_at`, which
 * `commissionPeriodSource` decides — so passing a different `nowIso` to two runs over a closed month
 * cannot move a figure, and `monthReconciliation.itest.ts` asserts exactly that.
 */
export async function monthReconciliation(
  sql: Sql,
  period: MonthReconciliationPeriod,
  nowIso: string,
): Promise<MonthReconciliation> {
  assertPeriod(period)
  await assertEverySourceIsClassified(sql)

  const source = await commissionPeriodSource(sql, { periodEndsOn: period.endsOn, nowIso })
  const [census, documents, appointments, tenderAccounts, movement, boxes, outputTaxBoxNo] =
    await Promise.all([
      ledgerCensus(sql, period),
      documentTotals(sql, period),
      appointmentCensus(sql, period),
      tenderAccountCodes(sql, period),
      trialBalanceMovement(sql, dayBefore(period.startsOn), period.endsOn),
      vat201Boxes(sql, {
        periodId: period.periodId,
        startsOn: period.startsOn,
        endsOn: period.endsOn,
      }),
      // `output_tax` and NOT `standard_rated_supplies`, which is the one name here a reader will
      // expect to be the other way round. `account.vat_box` is the grouping, and M-TILL-13 measured that
      // box 1 is TWO tags: the SUPPLIES sit on the revenue accounts (`standard_rated_supplies`: 4010 and
      // the contra 4095) and the TAX sits on 2030 (`output_tax`). This identity is about the TAX, so it
      // reads the tax tag; asking for the supplies tag with measure `tax` matches no mapping row at all
      // and the box side is then silently zero. Found by this unit's own itest, which is what it is for.
      vat201BoxForGrouping(sql, 'output_tax', 'tax'),
    ])
  const [liabilityAtStart, liabilityAtEnd, lateRows] = await Promise.all([
    readPackageLiability(sql, dayBefore(period.startsOn)),
    readPackageLiability(sql, period.endsOn),
    rowsCreatedAfter(sql, period, source.sourceAsOf),
  ])

  // --- the four account groupings, read off the rows ------------------------------------------
  const revenue = census.filter((row) => row.accountType === 'revenue')
  const outputTax = census.filter((row) => row.vatBox === 'output_tax')
  const packageLiabilityAccounts = census.filter(
    (row) => row.accountType === 'liability' && row.accountCode === DEFERRED_REVENUE_ACCOUNT_CODE,
  )
  const tenders = census.filter((row) => tenderAccounts.includes(row.accountCode))

  const saleSide = [...inClass(revenue, 'document_sale'), ...inClass(outputTax, 'document_sale')]
  const redemptionSide = [...inClass(revenue, 'package'), ...inClass(outputTax, 'package')]
  // Four classes reach a tender account and each has a `payment` or `refund` row behind it: a till
  // checkout debits the drawer inside its own `sale` entry, a later capture posts its own `payment` entry,
  // a refund credits the tender back under `refund`, and a package sale debits it under `package_sale`.
  const receiptSide = [
    ...inClass(tenders, 'document_sale'),
    ...inClass(tenders, 'receipt'),
    ...inClass(tenders, 'package'),
  ]
  const treasurySide = inClass(tenders, 'treasury')
  const censusDebits = census.reduce((total, row) => total + row.debitFils, 0n)
  const censusCredits = census.reduce((total, row) => total + row.creditFils, 0n)
  // The box NUMBER is read, never written: Y11-vat201-boxes is open and a report asserting the literal 1
  // would be asserting the answer instead of the mapping. A grouping that maps to no box leaves the right
  // side zero, and `notExportableReasons` says so rather than the line quietly reconciling against nothing.
  const outputTaxBox = boxes.find((row) => row.boxNo === outputTaxBoxNo)

  const lines: ReconciliationLine[] = [
    line({
      id: 'completed_appointments_without_a_document',
      kind: 'identity',
      measure: 'rows',
      claim:
        'Every appointment the period delivered reached either an invoice or a package redemption. One ' +
        'that reached neither is a treatment given away with nothing recording it.',
      left: side('completed appointments', appointments.completedGrossFils, appointments.completed),
      right: side(
        'of them billed or redeemed',
        appointments.completedGrossFils,
        appointments.completedWithADocument,
      ),
      derivedFrom: 'appointment x invoice_appointment x package_redemption (this module)',
    }),
    line({
      id: 'invoices_less_credit_notes_against_revenue_and_output_vat',
      kind: 'identity',
      measure: 'fils',
      claim:
        'Invoice gross less credit-note gross equals the revenue and output-VAT credited by the entries ' +
        'those documents posted.',
      left: side(
        'invoice gross less credit-note gross',
        documents.invoiceGrossFils - documents.creditNoteGrossFils,
        documents.invoiceCount + documents.creditNoteCount,
      ),
      right: side('revenue and output VAT credited', creditMovement(saleSide), linesIn(saleSide)),
      derivedFrom:
        'invoice/credit_note (this module) against the sale and refund sources of the ledger census',
    }),
    line({
      id: 'payments_less_refunds_against_tender_accounts',
      kind: 'identity',
      measure: 'fils',
      claim:
        'What was tendered less what was refunded equals the net debit to the accounts those tenders ' +
        'were posted to.',
      left: side(
        'tendered less refunded',
        documents.paymentAppliedFils - documents.refundFils,
        documents.paymentCount + documents.refundCount,
      ),
      right: side('cash and bank debited', debitMovement(receiptSide), linesIn(receiptSide)),
      derivedFrom:
        'payment/refund (this module) against the tender accounts those rows name, under the ' +
        'document_sale, receipt and package source classes only',
    }),
    line({
      id: 'package_liability_movement_against_sales_less_redemptions',
      kind: 'identity',
      measure: 'fils',
      claim:
        'The movement in the deferred-revenue liability equals what packages sold less what redemptions ' +
        'released.',
      left: side(
        'sold less redeemed, movement',
        BigInt(liabilityAtEnd.outstandingFils) - BigInt(liabilityAtStart.outstandingFils),
        0,
      ),
      right: side(
        'deferred revenue credited',
        BigInt(liabilityAtEnd.ledgerBalanceFils) - BigInt(liabilityAtStart.ledgerBalanceFils),
        linesIn(packageLiabilityAccounts),
      ),
      derivedFrom: 'readPackageLiability at both ends of the period (M-TILL-10)',
    }),
    line({
      id: 'package_redemptions_against_revenue_and_output_vat',
      kind: 'identity',
      measure: 'fils',
      claim:
        'What redemptions released equals the revenue and output VAT the redemption entries credited. A ' +
        'redemption issues no document, so this is the identity the invoice line above cannot make.',
      left: side(
        'released by redemptions',
        documents.redemptionReleasedFils,
        documents.redemptionCount,
      ),
      right: side(
        'revenue and output VAT credited',
        creditMovement(redemptionSide),
        linesIn(redemptionSide),
      ),
      derivedFrom:
        'package_redemption (this module) against the package sources of the ledger census',
    }),
    line({
      id: 'output_tax_against_the_vat201_box',
      kind: 'identity',
      measure: 'fils',
      claim:
        'The output tax the documents carry equals the tax in the VAT201 box the standard-rated grouping ' +
        'maps to. This is the last step of the chain: bookings to invoices to payments to journal to box.',
      left: side(
        'invoice VAT less credit-note VAT plus redemption VAT',
        documents.invoiceVatFils - documents.creditNoteVatFils + documents.redemptionVatFils,
        documents.invoiceCount + documents.creditNoteCount + documents.redemptionCount,
      ),
      right: side(
        outputTaxBox === undefined
          ? 'no box maps standard-rated tax'
          : `box ${outputTaxBox.boxNo} tax`,
        outputTaxBox?.taxFils ?? 0n,
        outputTaxBox?.lineCount ?? 0,
      ),
      derivedFrom: 'vat201Boxes and vat201BoxForGrouping (M-VAT-07)',
    }),
    line({
      id: 'ledger_census_against_the_trial_balance',
      kind: 'identity',
      measure: 'fils',
      claim:
        'The per-source census this report refines the ledger into, summed back over every source, equals ' +
        'the trial-balance movement for the same period. The refinement is held to the one source.',
      left: side('census debits plus credits', censusDebits + censusCredits, linesIn(census)),
      right: side(
        'trial-balance movement debits plus credits',
        movement.totalDebitFils + movement.totalCreditFils,
        movement.rows.length,
      ),
      derivedFrom: 'this module’s census against trialBalanceMovement (M-VAT-01)',
    }),
    line({
      id: 'no_shows_excluded_from_revenue',
      kind: 'excluded',
      measure: 'rows',
      claim:
        'A no-show is not a supply. Its value appears on this line and in no identity above, and none of ' +
        'these appointments reached a document.',
      left: side('no-shows', appointments.noShowGrossFils, appointments.noShow),
      right: side('of them billed or redeemed', 0n, appointments.noShowWithADocument),
      derivedFrom: 'appointment (this module)',
    }),
    line({
      id: 'cancellations_excluded_from_revenue',
      kind: 'excluded',
      measure: 'rows',
      claim:
        'A cancellation, by either party, is not a supply. Its value appears on this line and in no ' +
        'identity above, and none of these appointments reached a document.',
      left: side('cancellations', appointments.cancelledGrossFils, appointments.cancelled),
      right: side('of them billed or redeemed', 0n, appointments.cancelledWithADocument),
      derivedFrom: 'appointment (this module)',
    }),
    line({
      id: 'treasury_movements_excluded_from_receipts',
      kind: 'stated',
      measure: 'fils',
      claim:
        'Banking a drawer and paying out of it move money the business already had. They are stated here ' +
        'so the tender identity above can exclude them by name rather than by omission.',
      left: side('moved between own accounts', debitMovement(treasurySide), linesIn(treasurySide)),
      right: side('claimed by no identity', 0n, 0),
      derivedFrom: 'the treasury sources of the ledger census (this module)',
    }),
    line({
      id: 'rows_created_after_the_period_lock',
      kind: 'census',
      measure: 'rows',
      claim:
        'Nothing dated inside the period was written after the instant this report reads at. Zero is ' +
        'what makes every figure above the figure that was filed.',
      left: side('rows written after sourceAsOf', 0n, lateRows),
      right: side('permitted', 0n, 0),
      derivedFrom: 'created_at/posted_at against commissionPeriodSource’s sourceAsOf (P-HR-11)',
    }),
  ]

  // The order and the membership, checked against the declared list rather than trusted. A line dropped
  // by an edit to the array above would otherwise leave the report silently one identity short, and
  // `unexplainedVarianceLines` would go on being empty about a month nobody was checking (ADR 0002).
  const built = lines.map((row) => row.id)
  if (built.join('|') !== MONTH_RECONCILIATION_LINE_IDS.join('|')) {
    throw new AppError(
      'invariant_violated',
      `The reconciliation built [${built.join(', ')}], which is not ` +
        `MONTH_RECONCILIATION_LINE_IDS [${MONTH_RECONCILIATION_LINE_IDS.join(', ')}] in order. The ` +
        'bytes have to be identical between two runs, so the order is part of the contract.',
    )
  }

  const unexplained = lines
    .filter((row) => (row.kind === 'identity' || row.kind === 'excluded') && !holds(row))
    .map((row) => row.id)
  const lateLine = lines.find((row) => row.id === 'rows_created_after_the_period_lock')
  if (lateLine === undefined) {
    throw new AppError('invariant_violated', 'the report was built without its as-of census line')
  }
  const examinedRows =
    linesIn(census) +
    documents.invoiceCount +
    documents.creditNoteCount +
    documents.paymentCount +
    documents.refundCount +
    documents.redemptionCount +
    appointments.completed +
    appointments.noShow +
    appointments.cancelled

  const notExportableReasons: string[] = []
  if (unexplained.length > 0) {
    notExportableReasons.push(
      `${unexplained.length} reconciliation line(s) do not hold: ${unexplained.join(', ')}`,
    )
  }
  if (lateLine.variance !== 0n) {
    notExportableReasons.push(
      `${lateRows} row(s) dated inside the period were written after ${source.sourceAsOf}, so these ` +
        'are not the figures the period was closed on',
    )
  }
  if (source.lockedPeriodId === null) {
    notExportableReasons.push(
      `the period ending ${period.endsOn} is not closed: the earliest open date is ` +
        `${source.earliestOpenDate}, so any figure here can still move`,
    )
  }
  if (outputTaxBoxNo === null) {
    notExportableReasons.push(
      'no VAT201 box maps the standard-rated output tax, so the last step of the chain reconciles ' +
        'against nothing ([UNVERIFIED] Y11-vat201-boxes)',
    )
  }

  // A CAVEAT and not a blocker, and the distinction is the unit's whole point. M-VAT-08's `vat_return`
  // may not be FILEABLE while a box number is provisional, which is right for a filing. This report is
  // the working paper handed TO the FTA-registered agent so that the numbering can be confirmed, and
  // Y11-tax-agent records that review as not optional — so a provisional box making the export impossible
  // would make the one artefact the reviewer needs unreachable until the review had already happened.
  // Every box is provisional today, so treating it as a blocker would mean this unit shipped an export
  // nothing could ever call.
  const caveats: string[] = []
  const provisional = boxes.filter((box) => box.isProvisional)
  if (provisional.length > 0) {
    caveats.push(
      `${provisional.length} of ${boxes.length} VAT201 box numbers are placeholders held as rows ` +
        `(${provisional.map((box) => box.boxNo).join(', ')}); answering [UNVERIFIED] Y11-vat201-boxes ` +
        'is an UPDATE of those rows and changes no code',
    )
  }
  caveats.push(
    'An FTA-registered tax agent has not reviewed this reconciliation. [UNVERIFIED] Y11-tax-agent ' +
      'records that review as not optional, and this report is the thing to be reviewed: its arithmetic ' +
      'is asserted by the build and its correctness against FTA practice is not.',
  )

  return {
    formatVersion: MONTH_RECONCILIATION_FORMAT_VERSION,
    period,
    closed: source.lockedPeriodId !== null,
    lockedPeriodId: source.lockedPeriodId,
    sourceAsOf: source.sourceAsOf,
    lines,
    unexplainedVarianceLines: unexplained,
    examinedRows,
    notExportableReasons,
    caveats,
  }
}

// --- the artefact the agent is handed -----------------------------------------------------------

/**
 * The report as bytes, deterministically.
 *
 * `canonicaliseVat201WorkingPapers` is M-VAT-07's and is used rather than copied: it sorts keys
 * recursively, writes every `bigint` as a decimal string and THROWS on a bigint it cannot reach, which is
 * the good failure — a figure silently becoming `null` is how a total disappears from an artefact somebody
 * compares years later. A second canonicaliser in this file would be a second answer to "what are the
 * bytes", and the copy that disagrees is the one the hash was taken over.
 *
 * Its name says `Vat201` and the artefact here is not a VAT201. That is the cost of not copying it, and it
 * is the smaller cost: gate case 131l plants a second serialiser in this file and requires the suite to
 * notice.
 */
export function monthReconciliationBytes(report: MonthReconciliation): string {
  return canonicaliseVat201WorkingPapers(report)
}

/** Every consumer of this module that a caller can reach. Compared against the real export list. */
export const MONTH_RECONCILIATION_CONSUMERS = [
  'monthReconciliation',
  'monthReconciliationBytes',
  'exportMonthReconciliation',
  'classifyJournalSources',
  'assertEverySourceIsClassified',
] as const

/**
 * The one consumer that refuses an unsound report.
 *
 * M-VAT-08's arrangement, restated: the enumeration above is compared against this module's real export
 * list in the itest, so an export added and not classified fails there rather than passing silently, and
 * this is asserted to be the only member of it that refuses.
 */
export const MONTH_RECONCILIATION_CONSUMERS_REQUIRING_SOUNDNESS = [
  'exportMonthReconciliation',
] as const

/** What an export produced, so a caller can hand the bytes on and cite the hash. */
export interface MonthReconciliationExport {
  readonly period: MonthReconciliationPeriod
  /** The canonical bytes, exactly as {@link monthReconciliationBytes} produced them. */
  readonly bytes: string
  /** `sha256` over those bytes, hex. The same shape `vat_return.content_hash` is a CHECK over. */
  readonly contentHash: string
  readonly byteLength: number
  readonly sourceAsOf: string
  readonly examinedRows: number
}

/**
 * Thrown when an export is asked for over a report that is not sound. Carries every reason, never one.
 *
 * Every reason, because the remedies differ and a caller told only the first would fix it, re-run, and be
 * refused again by the second. `details.reasons` is the list, so a screen can print all of them.
 */
export class MonthReconciliationNotExportable extends AppError {
  constructor(period: MonthReconciliationPeriod, reasons: readonly string[]) {
    super(
      'invariant_violated',
      `The reconciliation for ${period.periodId} may not be exported: ${reasons.join('; ')}.`,
      { details: { periodId: period.periodId, reasons: [...reasons] } },
    )
    this.name = 'MonthReconciliationNotExportable'
  }
}

/**
 * The artefact handed to the tax agent, and the audit row that records the handing over.
 *
 * Three things, in this order and inside one transaction:
 *
 *   1. **It refuses an unsound report.** `notExportableReasons` is the report's own list and this is the
 *      only door that reads it. A reconciliation with an unexplained variance is not a document anybody
 *      should be able to send to an FTA-registered agent, and the failure of the alternative is specific:
 *      the agent files from a paper whose own report said it did not add up.
 *   2. **It hashes the bytes it is about to hand over**, not the report object — the bytes are the artefact
 *      and the hash has to be over the thing that leaves the building.
 *   3. **It writes an `audit_event` in the SAME transaction.** Not afterwards: an export recorded by a
 *      second statement is an export that happened without a record whenever the second statement fails,
 *      and `audit_event` is append-only (ADR 0008) so there is no repairing it later. `recordExport` is
 *      used rather than `record` because 0005 indexes the export operation separately — an unusually large
 *      export is the insider-threat signal — and the content hash goes in beside the row count so the
 *      audit trail can be compared against a file somebody still has.
 *
 * The report is passed IN rather than recomputed here, deliberately. Recomputing would read the ledger a
 * second time, at a second instant, and hand over bytes nobody had seen — which is the one thing an
 * export must not do.
 */
export async function exportMonthReconciliation(
  uow: UnitOfWork,
  report: MonthReconciliation,
  exportedFor: string,
): Promise<MonthReconciliationExport> {
  if (exportedFor.trim() === '') {
    throw new AppError(
      'validation',
      'exportMonthReconciliation needs to know who the export is for. A blank recipient makes the audit ' +
        'row say an export happened and not who has the figures, which is the only question asked of it.',
    )
  }
  if (report.notExportableReasons.length > 0) {
    throw new MonthReconciliationNotExportable(report.period, report.notExportableReasons)
  }
  const bytes = monthReconciliationBytes(report)
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  await uow.audit.record({
    action: 'money.month_reconciliation.export',
    entityType: 'month_reconciliation',
    entityId: report.period.periodId,
    operation: 'export',
    after: {
      periodId: report.period.periodId,
      startsOn: report.period.startsOn,
      endsOn: report.period.endsOn,
      lockedPeriodId: report.lockedPeriodId,
      sourceAsOf: report.sourceAsOf,
      formatVersion: report.formatVersion,
      contentHash,
      byteLength: bytes.length,
      examinedRows: report.examinedRows,
      exportedFor,
      // The line ids and nothing else: the figures are in the bytes whose hash is above, and a second
      // copy of them in the audit row is a second statement of a fact that can drift from the artefact.
      lineIds: report.lines.map((line) => line.id),
    },
  })
  return {
    period: report.period,
    bytes,
    contentHash,
    byteLength: bytes.length,
    sourceAsOf: report.sourceAsOf,
    examinedRows: report.examinedRows,
  }
}

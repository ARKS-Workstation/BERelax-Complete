import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { type JournalLineInput, journalError, postJournalEntry } from '../repositories/journal.ts'
import { allocateDocumentNumber } from '../repositories/numbering.ts'
import type { UnitOfWork } from '../tx.ts'
import { OPENING_BALANCE_SQLSTATE } from './opening-balances.ts'

/**
 * Recording a supplier bill: the write path, and the only one.
 *
 * ## What a bill posts
 *
 * **Dr expense (net, plus any blocked VAT, plus any reverse-charge VAT borne) per line, Dr recoverable
 * input VAT (the claim), Dr recoverable input VAT (the reverse-charge claim), Cr reverse-charge VAT
 * payable (the reverse-charge declaration), Cr trade payables (gross).**
 *
 * Debits equal credits by construction rather than by arithmetic luck: a line that carries no VAT has
 * `net === gross`, a recoverable line contributes its net plus its claim, a blocked line contributes
 * its net plus the tax it cannot reclaim — which is its gross — and an imported service contributes its
 * net, the reverse-charge VAT it reclaimed and the reverse-charge VAT it bore, which together are its net
 * plus the whole amount it declared. So the debit side sums to `gross + reverse-charge declared` whatever
 * mix of treatments a bill holds. The deferred balance trigger in `0018_ledger.sql` checks it anyway at
 * COMMIT, because this service is not the only thing that can reach a `psql` prompt.
 *
 * One credit and one VAT debit, not one of each per line. The payable is what is owed to the supplier
 * for this invoice, and a per-line payable is a ledger nobody can pay against; the claim is a period
 * figure, and per-line VAT debits make a VAT201 a thousand rows that are summed anyway.
 *
 * ## Where each rule lives
 *
 * The arithmetic — gross authoritative, net derived, VAT as the remainder — is
 * `packages/core/src/purchases/bill.ts`, and this package may not import it (the dependency runs
 * core ← db). So the caller derives the figures there and passes both `grossFils` and `netFils`; this
 * service **validates the relationship** rather than re-deriving it, which is deliberate. A second
 * `gross × 20 / 21` here would be a second rounding rule, and the day the two disagree is the day a
 * filed return is out by a fils per line.
 *
 * ## The imported-services reverse charge is two entries
 *
 * `imported_services_reverse_charge` is the treatment for a supply bought from an offshore supplier. They
 * charged no UAE VAT — they are not established here and can issue no UAE tax invoice, which is why
 * `supplier_tax_profile` refuses a TRN on an offshore supplier — so the line's `gross === net` and its
 * `vat_fils` is zero. The tax is not absent: the business declares it itself (`Cr 2035`, whose `vat_box`
 * is `reverse_charge`) **and** reclaims it where the category allows recovery (`Dr 1080`, whose `vat_box`
 * is `recoverable_input_tax`). Two entries, never one: a single net-zero figure declares nothing in the
 * output box and claims nothing in the input box, and the ledger balances perfectly either way.
 *
 * Where the input is **blocked** the second entry is absent and the VAT is debited to the expense with the
 * rest of the line — the one case a reverse charge costs real money, and the point at which 0034's
 * classification decides a figure in this unit.
 *
 * The declared figure comes from `reverseChargeOn` in `@berelax/core` and is passed in as
 * `reverseChargeOutputVatFils`, for the same reason `netFils` is: a second rounding rule here would be a
 * second answer, and `bill_line_reverse_charge_output_matches_the_rate` in the database refuses a figure
 * that does not match its rate. The **input** side is not passed in — it is derived from the account's
 * classification, which this service reads anyway, so no caller can claim tax on a category the chart
 * blocks by supplying the wrong figure.
 *
 * ## Blocked input VAT
 *
 * `blocked_not_recoverable` is the treatment for a category UAE VAT denies recovery on — entertainment,
 * or a staff benefit the business is not obliged to provide (docs/04 §4, §7). The supplier charged the
 * tax; it simply cannot be reclaimed, so it is **debited to the expense** and disclosed rather than
 * dropped. Which accounts those are is a property of the chart (`account.vat_box` and
 * `account.input_vat_recoverable`), read from the database here rather than spelled as a list of codes:
 * this package may not import core's `BLOCKED_INPUT_VAT_CATEGORIES`, and a second list of codes would be
 * a second thing to keep in step with the chart the migration seeds.
 *
 * The rule that a supplier with no TRN supports no claim is enforced three times, and each layer
 * covers a hole the others leave:
 *
 *   1. `bill_recoverable_needs_a_trn`, a row-level CHECK, which holds for every role and survives a
 *      trigger being dropped.
 *   2. `bill_line_recoverable_needs_a_tax_invoice`, a trigger raising ZV001 at the offending line.
 *   3. This service, which refuses **before** anything is written and says why in a sentence naming
 *      the supplier and the lines. That is the layer a person reads; a raw `ZV001` in a log tells the
 *      bookkeeper nothing about what to do with the invoice in their hand.
 *
 * ## Fils are numbers on the way in, bigint on the way out of an aggregate
 *
 * Inputs and per-row figures are JavaScript integers, validated here, exactly as `postJournalEntry`
 * takes them. Aggregates over many rows are `bigint` — see `../queries/payables-aging.ts` and
 * `../queries/trial-balance.ts`, which documents the four-fils defect that settled the question.
 */

/** The SQLSTATEs `0028_purchases.sql` raises. Matched on the code, never on the message. */
export const PURCHASES_SQLSTATE = {
  /** A recoverable line on a bill whose supplier held no TRN when it was recorded. */
  inputVatWithoutSupplierTrn: 'ZV001',
  /** The header summary disagrees with the lines, or a bill has none. Raised at COMMIT. */
  billTotalsDoNotMatchLines: 'ZV002',
  /** A supplier with no tax profile, so no explicit residency. */
  supplierHasNoTaxProfile: 'ZV003',
  /** A bill or bill line was UPDATEd or DELETEd. */
  appendOnly: 'ZV004',
  /** A claim on an account the chart does not classify as recoverable (0034). */
  blockedInputVatIsNotRecoverable: 'ZV005',
  /** A blocked line on an account that is not a blocked category (0034). */
  blockedTreatmentNeedsABlockedAccount: 'ZV006',
  /** The reverse-charge input side contradicts the account's recovery classification (0039). */
  reverseChargeInputDoesNotMatchAccount: 'ZV007',
  /** A line owes a reverse charge and accounts for none, or accounts for one it does not owe (0039). */
  reverseChargeDoesNotMatchPlaceOfSupply: 'ZV008',
} as const

/** `23505`: a unique constraint refused the row. Which one is read from the constraint name. */
const UNIQUE_VIOLATION = '23505'
/**
 * `23514`: a CHECK refused the row. Which one is read from the constraint name.
 *
 * Translated for the reverse-charge CHECKs only. The rest are arithmetic this service has already refused
 * in a sentence, so reaching one of those means a caller got past the validation above and the raw message
 * naming the constraint is the more useful of the two — it says which invariant, not which input.
 */
const CHECK_VIOLATION = '23514'

/** Our own numbering series for bills, seeded by 0028 into `document_series`. */
export const BILL_SERIES_CODE = 'SUPP-BILL'

/**
 * The two chart accounts a bill always touches.
 *
 * Spelled here because `packages/db` may not import `ACCOUNTS` from core. The codes are foreign keys
 * to `account`, so a wrong one fails at the INSERT rather than appearing in a trial balance as an
 * account nobody recognises — and `packages/fixtures/src/purchases.itest.ts` asserts these two
 * constants equal core's `ACCOUNTS.recoverableInputVat` and `ACCOUNTS.tradePayables`.
 */
export const RECOVERABLE_INPUT_VAT_ACCOUNT_CODE = '1080'
export const TRADE_PAYABLES_ACCOUNT_CODE = '2010'
/**
 * The third account, and only an offshore bill touches it: the reverse-charge VAT the business declares.
 *
 * Its own payable rather than netting into 2030 output VAT, which is the chart's decision and the reason it
 * gives (0018): "a nightly exception report cannot find a missing pair inside an aggregate".
 */
export const REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE = '2035'

/** Mirrors the CHECK on `bill_line.tax_treatment`, and core's `BILL_TAX_TREATMENTS`. */
export const BILL_TAX_TREATMENTS = [
  'standard_recoverable',
  'blocked_not_recoverable',
  'imported_services_reverse_charge',
  'no_trn_not_recoverable',
  'zero_rated',
  'exempt',
  'out_of_scope',
] as const
export type BillTaxTreatment = (typeof BILL_TAX_TREATMENTS)[number]

/**
 * The one treatment where the business accounts for the VAT itself.
 *
 * Deliberately outside {@link VAT_BEARING_TREATMENTS}: the question that set answers is "did the supplier
 * charge VAT inside this gross", and for an imported service the answer is no. Folding it in would carve
 * tax out of the amount the supplier is owed, and the payment run would underpay every offshore vendor by
 * 5% — and it would put the no-TRN refusal in the way of the one treatment that exists because there is no
 * TRN.
 */
export const IMPORTED_SERVICES_TREATMENT = 'imported_services_reverse_charge' as const

/**
 * The two treatments a supplier charged VAT under, and the one of them that supports a claim.
 *
 * Kept as two named sets rather than compared inline, because the difference between "VAT was charged"
 * and "VAT may be claimed" is the whole of this unit: a blocked line satisfies the first and not the
 * second, and code that tests the wrong one either loses the tax or claims it.
 */
const VAT_BEARING_TREATMENTS: readonly BillTaxTreatment[] = [
  'standard_recoverable',
  'blocked_not_recoverable',
]

/** The three positions the chart takes on input VAT recovery. Mirrors core's `recoverabilityOf`. */
export const INPUT_VAT_RECOVERABILITIES = ['recoverable', 'blocked', 'out_of_scope'] as const
export type InputVatRecoverability = (typeof INPUT_VAT_RECOVERABILITIES)[number]

export const SUPPLIER_RESIDENCIES = ['domestic', 'offshore'] as const
export type SupplierResidency = (typeof SUPPLIER_RESIDENCIES)[number]

export const PLACE_OF_SUPPLY_RULES = [
  'domestic_uae',
  'imported_services_reverse_charge',
  'outside_scope',
] as const
export type PlaceOfSupplyRule = (typeof PLACE_OF_SUPPLY_RULES)[number]

export interface SupplierInput {
  readonly code: string
  readonly legalName: string
  readonly tradingName?: string | null
  /** Explicit. There is no default in the schema and there is none here either. */
  readonly residency: SupplierResidency
  readonly placeOfSupplyRule: PlaceOfSupplyRule
  /** The UAE TRN, or null for a supplier that is not registered. */
  readonly trn?: string | null
}

export interface SupplierRecord {
  readonly supplierId: string
  readonly code: string
  readonly legalName: string
  readonly tradingName: string | null
  readonly residency: SupplierResidency
  readonly placeOfSupplyRule: PlaceOfSupplyRule
  readonly trn: string | null
}

export interface BillLineToPost {
  readonly description: string
  readonly expenseAccountCode: string
  readonly taxTreatment: BillTaxTreatment
  /** The rate the supplier charged, in basis points. Defaults to 0 for a line that carries no VAT. */
  readonly vatRateBp?: number
  /** VAT-inclusive, and authoritative (ADR 0007). */
  readonly grossFils: number
  /** Derived from the gross by `deriveBillLine` in @berelax/core, never re-derived here. */
  readonly netFils: number
  /**
   * The reverse-charge VAT this imported service declares, from `reverseChargeOn` in `@berelax/core`.
   *
   * Required for `imported_services_reverse_charge` and refused for every other treatment. Only the
   * **output** side is passed: the input side is derived from the account's recovery classification, which
   * this service reads from the chart, so a caller cannot claim tax on a category the chart blocks.
   */
  readonly reverseChargeOutputVatFils?: number
}

export interface BillToPost {
  readonly supplierId: string
  /** The supplier's own invoice number. Unique per supplier; a repeat is the double-entry a payables process exists to catch. */
  readonly supplierReference: string
  /** The supplier's invoice date: their tax point. */
  readonly billDate: string
  readonly dueDate: string
  /**
   * The **business day** the entry belongs to, as `YYYY-MM-DD`, already resolved with
   * `resolveTradingDate` from `@berelax/core`.
   *
   * Trading runs 11:00–02:00, so a bill entered at 01:30 belongs to the previous trading date. It also
   * decides which year's numbering range the bill joins, so taking it from an ambient clock would put
   * a New Year's Eve bill in the wrong statutory year roughly once a year.
   */
  readonly entryDate: string
  readonly receivedBy: string
  readonly narrative?: string
  readonly lines: readonly BillLineToPost[]
}

export interface PostedBillLine {
  readonly lineNo: number
  readonly description: string
  readonly expenseAccountCode: string
  readonly taxTreatment: BillTaxTreatment
  readonly vatRateBp: number
  readonly netFils: number
  readonly vatFils: number
  readonly grossFils: number
  readonly recoverableInputVatFils: number
  /** The VAT this line was charged and cannot reclaim. Zero unless the line is blocked. */
  readonly blockedInputVatFils: number
  /** The reverse-charge VAT this line declares. Zero unless it is an imported service. */
  readonly reverseChargeOutputVatFils: number
  /** The same VAT reclaimed. Zero on a blocked or out-of-scope category, where the tax is a cost. */
  readonly reverseChargeInputVatFils: number
  /** `output - input`: the reverse-charge tax the business bore on this line. */
  readonly reverseChargeBorneVatFils: number
  /** What the expense account was debited: the net, plus any blocked or borne reverse-charge VAT. */
  readonly expenseDebitFils: number
}

export interface PostedBill {
  readonly billId: string
  readonly supplierId: string
  readonly supplierReference: string
  /** Our own gapless reference, e.g. `BILL-2026-00001`. */
  readonly displayNumber: string
  readonly seriesCode: string
  readonly periodKey: string
  readonly number: number
  readonly entryId: string
  /** The supplier's TRN as it stood when the bill was recorded, or null. */
  readonly supplierTrn: string | null
  readonly supplierResidency: SupplierResidency
  readonly billDate: string
  readonly dueDate: string
  readonly netFils: number
  readonly vatFils: number
  readonly grossFils: number
  readonly recoverableInputVatFils: number
  /** The non-recoverable disclosure figure: the sum of the blocked lines. */
  readonly blockedInputVatFils: number
  /** The reverse-charge VAT this bill declares: the output side, summed from the lines. */
  readonly reverseChargeOutputVatFils: number
  /** The reverse-charge VAT it reclaims: the input side. Below the output by the tax it bore. */
  readonly reverseChargeInputVatFils: number
  /** `output - input`. Zero where every imported service is on a recoverable category. */
  readonly reverseChargeBorneVatFils: number
  readonly lines: readonly PostedBillLine[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

const constraintName = (err: unknown): string | undefined => {
  const name = (err as { constraint_name?: unknown } | null)?.constraint_name
  return typeof name === 'string' ? name : undefined
}

/**
 * Translates a PostgreSQL error raised by the purchases schema, the ledger or the opening-date guard
 * into an `AppError`, or returns `null` if it is not one of ours.
 *
 * Exported and applied by the caller around its own `withUnitOfWork`, because the two refusals that
 * matter most arrive from **COMMIT** — the deferred balance trigger and the deferred totals trigger —
 * and no function in this module executes the COMMIT:
 *
 * ```ts
 * try {
 *   await withUnitOfWork(sql, actor, (uow) => postBill(uow, bill))
 * } catch (err) {
 *   throw purchaseError(err) ?? err
 * }
 * ```
 *
 * `ZL004` is translated here rather than left to the caller for the reason the brief gives: a bill
 * dated before the books open must be explained, not surfaced as a SQLSTATE. `journalError` does not
 * cover it — 0027 arrived after it — and a bookkeeper reading "ZL004" learns nothing.
 */
export function purchaseError(err: unknown): AppError | null {
  // Idempotent, and it has to be: these errors are translated twice on the one path that counts.
  // `postBill` translates what it can see, and the caller wraps the whole transaction to catch the
  // deferred failures from COMMIT. Without this guard the second pass appends its explanation to a
  // message that already carries it, and the sentence a bookkeeper reads arrives duplicated — which is
  // exactly how the integration test found it.
  if (err instanceof AppError && typeof err.details['sqlState'] === 'string') return err

  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case PURCHASES_SQLSTATE.inputVatWithoutSupplierTrn:
      return new AppError(
        'validation',
        `${message} — record the line as no_trn_not_recoverable: without a tax invoice carrying the ` +
          'supplier TRN the VAT is part of the cost, not a claim.',
        { details: { sqlState: code } },
      )
    case PURCHASES_SQLSTATE.billTotalsDoNotMatchLines:
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case PURCHASES_SQLSTATE.supplierHasNoTaxProfile:
      return new AppError(
        'validation',
        `${message} — a supplier needs an explicit domestic or offshore residency before it can be ` +
          'billed, because that is what decides whether the reverse charge applies.',
        { details: { sqlState: code } },
      )
    case PURCHASES_SQLSTATE.appendOnly:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case PURCHASES_SQLSTATE.blockedInputVatIsNotRecoverable:
      return new AppError(
        'validation',
        `${message} — UAE VAT blocks recovery on this category (docs/04 §4), so record the line as ` +
          'blocked_not_recoverable: the tax is part of the cost, disclosed in the return rather than ' +
          'claimed in it.',
        { details: { sqlState: code } },
      )
    case PURCHASES_SQLSTATE.blockedTreatmentNeedsABlockedAccount:
      return new AppError(
        'validation',
        `${message} — blocked recovery is a property of the category of spend, so it is the account that ` +
          'decides it. Code the line to the blocked account, or record the treatment this account ' +
          'supports.',
        { details: { sqlState: code } },
      )
    case PURCHASES_SQLSTATE.reverseChargeInputDoesNotMatchAccount:
      return new AppError(
        'validation',
        `${message} — the output side of a reverse charge is declared whatever the category, and the ` +
          'input side is claimable only where the chart allows recovery. Both sides or neither: ' +
          'declaring the output and abandoning a claim the business was entitled to is as wrong as ' +
          'claiming one it was not.',
        { details: { sqlState: code } },
      )
    case PURCHASES_SQLSTATE.reverseChargeDoesNotMatchPlaceOfSupply:
      return new AppError(
        'validation',
        `${message} — whether a supply owes the reverse charge is the supplier's place-of-supply rule, ` +
          'and it is stated rather than inferred (0028). An imported service recorded any other way ' +
          'declares its output VAT nowhere, which is the most commonly missed UAE VAT obligation at this ' +
          'size (docs/04 §4).',
        { details: { sqlState: code } },
      )
    case OPENING_BALANCE_SQLSTATE.beforeOpeningBalance:
      return new AppError(
        'conflict',
        `${message} — this bill is dated inside the period the opening balances already summarise, ` +
          'so posting it would count the cost twice. Date it on or after the opening date, or correct ' +
          'the opening balances.',
        { details: { sqlState: code } },
      )
    case CHECK_VIOLATION: {
      // Only the reverse-charge CHECKs are translated. The rest are arithmetic this service refuses in a
      // sentence first, so reaching one means a caller bypassed the service — and then the constraint name
      // is the more useful message, because it names the invariant rather than the input.
      const constraint = constraintName(err)
      if (constraint === 'bill_line_reverse_charge_output_matches_the_rate') {
        return new AppError(
          'validation',
          `${message} — the declared reverse charge is not its rate applied to the consideration. Derive ` +
            'it with reverseChargeOn() from @berelax/core rather than by hand: the database states the ' +
            'same rounding rule so the two can check each other, which is the point of stating it twice.',
          { details: { sqlState: code, constraint } },
        )
      }
      if (constraint === 'bill_reverse_charge_needs_an_offshore_supplier') {
        return new AppError(
          'validation',
          `${message} — a reverse charge belongs to an imported supply. On a domestic one it would ` +
            'declare VAT the supplier already charged and then claim it a second time.',
          { details: { sqlState: code, constraint } },
        )
      }
      return null
    }
    case UNIQUE_VIOLATION:
      // The one unique constraint a person hits: the same supplier invoice entered twice, which pays
      // it twice and claims its VAT twice.
      return constraintName(err) === 'bill_supplier_reference_unique'
        ? new AppError(
            'conflict',
            `This supplier invoice has already been recorded (${message}). A duplicate would pay it ` +
              'twice and claim its VAT twice; if the supplier reissued it, record their credit note.',
            { details: { sqlState: code, constraint: 'bill_supplier_reference_unique' } },
          )
        : new AppError('conflict', message, {
            details: { sqlState: code, constraint: constraintName(err) ?? null },
          })
    default:
      // A locked period, an unbalanced entry, an unknown account or a missing privilege: the ledger's
      // own translation, which this one deliberately does not restate.
      return journalError(err)
  }
}

/** True when `err` is the no-tax-invoice refusal. */
export function isInputVatWithoutTrn(err: unknown): boolean {
  return sqlState(err) === PURCHASES_SQLSTATE.inputVatWithoutSupplierTrn
}

/**
 * True when `err` is a refusal about the account's recovery classification: a claim on an account that
 * does not support one, or a blocked line on an account that is not a blocked category.
 *
 * One predicate over both codes, because a caller answers them identically — the line was coded to the
 * wrong account or recorded under the wrong treatment, and either way a person has to look at the
 * invoice. The two SQLSTATEs stay distinct so the *message* can say which mistake it was.
 */
export function isBlockedRecoverabilityRefusal(err: unknown): boolean {
  const code = sqlState(err)
  return (
    code === PURCHASES_SQLSTATE.blockedInputVatIsNotRecoverable ||
    code === PURCHASES_SQLSTATE.blockedTreatmentNeedsABlockedAccount
  )
}

/**
 * True when `err` is a refusal about the reverse charge: a pair that is due and absent, one that is not due
 * and present, or an input side that contradicts the account.
 *
 * One predicate over both codes, because a caller answers them identically — somebody has to look at the
 * invoice and at the supplier's place-of-supply rule. The two SQLSTATEs stay distinct so the *message* can
 * say which of the two mistakes it was.
 */
export function isReverseChargeRefusal(err: unknown): boolean {
  const code = sqlState(err)
  return (
    code === PURCHASES_SQLSTATE.reverseChargeDoesNotMatchPlaceOfSupply ||
    code === PURCHASES_SQLSTATE.reverseChargeInputDoesNotMatchAccount
  )
}

/** True when `err` is the duplicate-supplier-reference refusal. */
export function isDuplicateSupplierReference(err: unknown): boolean {
  return (
    sqlState(err) === UNIQUE_VIOLATION && constraintName(err) === 'bill_supplier_reference_unique'
  )
}

/**
 * Records a supplier and its tax profile, in one transaction.
 *
 * Both rows or neither: a supplier without a profile has no stated residency, which is how an offshore
 * bill loses its reverse charge. `supplier_has_tax_profile` would refuse it at COMMIT anyway; doing it
 * in one function means no caller has to know that.
 */
export async function recordSupplier(
  uow: UnitOfWork,
  input: SupplierInput,
): Promise<SupplierRecord> {
  if (!SUPPLIER_RESIDENCIES.includes(input.residency)) {
    throw new AppError(
      'validation',
      `Unknown supplier residency "${input.residency}". It is domestic or offshore, stated explicitly.`,
    )
  }
  if (input.residency === 'offshore' && (input.trn ?? null) !== null) {
    throw new AppError(
      'validation',
      `Supplier "${input.code}" is offshore and carries a UAE TRN. An offshore supplier issues no UAE ` +
        'tax invoice; a supplier holding a TRN is domestic.',
    )
  }

  const [row] = await uow.sql<{ supplier_id: string }[]>`
    insert into supplier (code, legal_name, trading_name)
    values (${input.code}, ${input.legalName}, ${input.tradingName ?? null})
    returning supplier_id::text as supplier_id
  `
  if (!row) {
    throw new AppError(
      'invariant_violated',
      `The supplier insert returned no row for "${input.code}"`,
    )
  }

  await uow.sql`
    insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn)
    values (
      ${row.supplier_id}::uuid, ${input.residency}, ${input.placeOfSupplyRule}, ${input.trn ?? null}
    )
  `

  await uow.audit.record({
    action: 'purchases.supplier.recorded',
    entityType: 'supplier',
    entityId: row.supplier_id,
    operation: 'create',
    after: {
      code: input.code,
      legalName: input.legalName,
      residency: input.residency,
      placeOfSupplyRule: input.placeOfSupplyRule,
      // The presence of a TRN, not the number: an audit trail is read by more people than the tax
      // profile is, and the digits add nothing to "this supplier could support a claim".
      hasTrn: (input.trn ?? null) !== null,
    },
  })

  return {
    supplierId: row.supplier_id,
    code: input.code,
    legalName: input.legalName,
    tradingName: input.tradingName ?? null,
    residency: input.residency,
    placeOfSupplyRule: input.placeOfSupplyRule,
    trn: input.trn ?? null,
  }
}

/** One supplier with its tax profile, or `null`. */
export async function findSupplierByCode(sql: Sql, code: string): Promise<SupplierRecord | null> {
  const [row] = await sql<
    {
      supplier_id: string
      code: string
      legal_name: string
      trading_name: string | null
      residency: string | null
      place_of_supply_rule: string | null
      trn: string | null
    }[]
  >`
    select s.supplier_id::text as supplier_id, s.code, s.legal_name, s.trading_name,
           p.residency, p.place_of_supply_rule, p.trn
    from supplier s
    left join supplier_tax_profile p on p.supplier_id = s.supplier_id
    where s.code = ${code}
  `
  if (!row) return null
  if (row.residency === null || row.place_of_supply_rule === null) {
    // A left join, so this is a supplier with no profile rather than no supplier. It should be
    // impossible — `supplier_has_tax_profile` refuses it at COMMIT — and reporting it as "no supplier"
    // would send the reader looking for the wrong thing.
    throw new AppError(
      'invariant_violated',
      `Supplier "${code}" has no tax profile, so its residency is unstated`,
      { details: { sqlState: PURCHASES_SQLSTATE.supplierHasNoTaxProfile } },
    )
  }
  return {
    supplierId: row.supplier_id,
    code: row.code,
    legalName: row.legal_name,
    tradingName: row.trading_name,
    residency: row.residency as SupplierResidency,
    placeOfSupplyRule: row.place_of_supply_rule as PlaceOfSupplyRule,
    trn: row.trn,
  }
}

interface LineFigures {
  readonly netFils: number
  readonly vatFils: number
  readonly grossFils: number
  readonly recoverableInputVatFils: number
  readonly blockedInputVatFils: number
  readonly reverseChargeOutputVatFils: number
  readonly reverseChargeInputVatFils: number
  readonly reverseChargeBorneVatFils: number
  /** The net plus any blocked VAT plus any reverse-charge VAT borne: what the expense is debited. */
  readonly expenseDebitFils: number
  readonly vatRateBp: number
}

/** One account's name and the position the chart takes on recovering input VAT posted to it. */
interface AccountClass {
  readonly name: string
  readonly recoverability: InputVatRecoverability
}

/**
 * Validates one line's figures and derives its claim, its blocked tax and its expense debit.
 *
 * `vat = gross - net` and nothing else, which is the whole of ADR 0007's derivation: the caller
 * supplies both sides and the remainder is the VAT, so `net + vat === gross` cannot fail to hold. The
 * VAT then goes to exactly one place — the claim for a recoverable line, the expense for a blocked one —
 * and to neither for a treatment that carries no VAT at all.
 */
function figuresFor(
  line: BillLineToPost,
  position: string,
  account: AccountClass | undefined,
): LineFigures {
  if (!Number.isInteger(line.grossFils) || !Number.isInteger(line.netFils)) {
    // The `fils` domain is bigint, so PostgreSQL would ROUND a fractional numeric literal rather than
    // refuse it — B-CAT-03 found that the hard way. Half a fils in a purchase ledger surfaces during a
    // VAT reconciliation, by which point it is history.
    throw new AppError(
      'validation',
      `${position} has a fractional amount (gross ${line.grossFils}, net ${line.netFils} fils)`,
    )
  }
  if (line.netFils <= 0) {
    throw new AppError(
      'validation',
      `${position} has a net of ${line.netFils} fils. Zero is a missing amount, not a free supply: it ` +
        'would post nothing and reconcile to nothing while the bill still looked entered.',
    )
  }
  if (line.grossFils < line.netFils) {
    throw new AppError(
      'validation',
      `${position} has a gross (${line.grossFils}) below its net (${line.netFils} fils). Gross is ` +
        'VAT-inclusive and authoritative; net is derived from it.',
    )
  }
  if (!BILL_TAX_TREATMENTS.includes(line.taxTreatment)) {
    throw new AppError(
      'validation',
      `${position} has an unknown tax treatment "${line.taxTreatment}". The ones the database accepts ` +
        `are ${BILL_TAX_TREATMENTS.join(', ')}.`,
    )
  }
  if (line.taxTreatment === IMPORTED_SERVICES_TREATMENT) {
    return importedServiceFiguresFor(line, position, account)
  }
  if (line.reverseChargeOutputVatFils !== undefined) {
    throw new AppError(
      'validation',
      `${position} is ${line.taxTreatment} and states a reverse charge of ` +
        `${line.reverseChargeOutputVatFils} fils. Only an imported service self-accounts VAT: on a ` +
        'domestic supply it would declare tax the supplier already charged and then claim it twice.',
    )
  }

  const vatFils = line.grossFils - line.netFils
  const recoverable = line.taxTreatment === 'standard_recoverable'
  const blocked = line.taxTreatment === 'blocked_not_recoverable'
  const carriesVat = VAT_BEARING_TREATMENTS.includes(line.taxTreatment)
  if (!carriesVat && vatFils !== 0) {
    throw new AppError(
      'validation',
      `${position} is ${line.taxTreatment} but its gross exceeds its net by ${vatFils} fils. An ` +
        'unregistered supplier cannot charge VAT, and a zero-rated, exempt or out-of-scope supply has ' +
        'none — so the whole amount is cost.',
    )
  }
  if (blocked && vatFils === 0) {
    // `blocked_not_recoverable` says the supplier charged VAT that cannot be reclaimed. With no VAT
    // there is nothing blocked, and the treatment would be a catch-all for "not recoverable" — which the
    // other four already say, each for a different reason and each with a different disclosure.
    throw new AppError(
      'validation',
      `${position} is blocked_not_recoverable and its gross equals its net, so no VAT was charged and ` +
        'nothing is blocked. Record why nothing is claimable: no_trn_not_recoverable, zero_rated, ' +
        'exempt or out_of_scope.',
    )
  }
  const vatRateBp = line.vatRateBp ?? (carriesVat ? 500 : 0)
  if (!carriesVat && vatRateBp !== 0) {
    throw new AppError(
      'validation',
      `${position} is ${line.taxTreatment} but carries a rate of ${vatRateBp} bp. A line that cannot ` +
        'carry VAT carries none.',
    )
  }
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) {
    throw new AppError(
      'validation',
      `${position} has a VAT rate of ${vatRateBp} bp, which is not a rate`,
    )
  }

  return {
    netFils: line.netFils,
    vatFils,
    grossFils: line.grossFils,
    recoverableInputVatFils: recoverable ? vatFils : 0,
    blockedInputVatFils: blocked ? vatFils : 0,
    reverseChargeOutputVatFils: 0,
    reverseChargeInputVatFils: 0,
    reverseChargeBorneVatFils: 0,
    // Blocked VAT is part of what the thing cost, so it is debited with the expense rather than to 1080.
    expenseDebitFils: blocked ? line.grossFils : line.netFils,
    vatRateBp,
  }
}

/**
 * The imported-services branch of {@link figuresFor}: both sides of the reverse charge.
 *
 * The **output** side is the caller's figure, validated and never re-derived — `reverseChargeOn` in
 * `@berelax/core` computed it and `bill_line_reverse_charge_output_matches_the_rate` refuses one that does
 * not match its rate, so the arithmetic has exactly two statements and they check each other.
 *
 * The **input** side is derived here, from the account's classification, and deliberately not accepted from
 * the caller: it is the answer to "may this category be recovered", the chart is the authority on it, and
 * this service already reads the chart. A caller able to supply it is a caller able to claim tax on
 * entertainment.
 *
 * An unknown account leaves the input side at zero rather than guessing. The foreign key on
 * `bill_line.expense_account_code` is the refusal to make about a code the chart does not hold; naming it
 * here would report the wrong problem, and ZV007 would refuse the row anyway.
 */
function importedServiceFiguresFor(
  line: BillLineToPost,
  position: string,
  account: AccountClass | undefined,
): LineFigures {
  if (line.grossFils !== line.netFils) {
    throw new AppError(
      'validation',
      `${position} is an imported service whose gross (${line.grossFils}) differs from its net ` +
        `(${line.netFils} fils). An offshore supplier charges no UAE VAT, so there is nothing inside the ` +
        'amount to carve out — the reverse-charge VAT is owed to the FTA, not to the supplier, and adding ' +
        'it to the gross would overpay them by the tax.',
    )
  }
  const declared = line.reverseChargeOutputVatFils
  if (declared === undefined) {
    throw new AppError(
      'validation',
      `${position} is an imported service and states no reverse charge. Derive it with reverseChargeOn() ` +
        'from @berelax/core: the output side is declared whatever the category, and the input side is ' +
        'claimable only where the account allows recovery.',
    )
  }
  if (!Number.isInteger(declared) || declared <= 0) {
    throw new AppError(
      'validation',
      `${position} declares ${declared} fils of reverse-charge VAT. An imported service that declares ` +
        'nothing is the missing pair this treatment exists to make impossible, and a fractional fils is ' +
        'rounded by the fils domain rather than refused by it.',
    )
  }
  const vatRateBp = line.vatRateBp ?? 500
  if (!Number.isInteger(vatRateBp) || vatRateBp <= 0 || vatRateBp > 10_000) {
    throw new AppError(
      'validation',
      `${position} is an imported service at ${vatRateBp} bp. The rate is what the declared figure was ` +
        'computed at and a filed line keeps it; a supply at no rate is out_of_scope, not a nil reverse ' +
        'charge.',
    )
  }
  // Zero where the chart blocks recovery or no input VAT arises, which is the one case a reverse charge
  // costs money: the declaration stands and the tax goes to the expense.
  const claimed = account?.recoverability === 'recoverable' ? declared : 0
  return {
    netFils: line.netFils,
    vatFils: 0,
    grossFils: line.grossFils,
    recoverableInputVatFils: 0,
    blockedInputVatFils: 0,
    reverseChargeOutputVatFils: declared,
    reverseChargeInputVatFils: claimed,
    reverseChargeBorneVatFils: declared - claimed,
    expenseDebitFils: line.netFils + (declared - claimed),
    vatRateBp,
  }
}

/**
 * The classification of every account this bill touches, read once.
 *
 * `account.vat_box` and `account.input_vat_recoverable` are read rather than assumed: the chart is the
 * authority on which categories are blocked, this package may not import core's copy of it, and a list of
 * codes here would be a third statement of the classification to keep in step with the chart.
 *
 * Read BEFORE the figures are derived, because it decides one of them — the reverse-charge input side is
 * the whole declaration on a recoverable category and nothing at all on a blocked one, and that is a chart
 * fact rather than a caller's input.
 *
 * Two mistakes are then refused row by row (ZV005 and ZV006 in `0034_blocked_input_vat.sql`, ZV007 in
 * `0039_reverse_charge.sql`): a claim on an account that is not classified recoverable, and a blocked line
 * on an account that is not a blocked category. `assertLinesMatchAccountRecoverability` is the layer a
 * person reads — it names the account, its name, the classification and the alternative, and it runs before
 * anything is written, where the triggers run after the number has been allocated.
 */
async function readAccountClasses(
  uow: UnitOfWork,
  input: BillToPost,
): Promise<ReadonlyMap<string, AccountClass>> {
  const codes = [...new Set(input.lines.map((line) => line.expenseAccountCode))]
  const rows = await uow.sql<
    { code: string; name: string; vat_box: string | null; input_vat_recoverable: boolean }[]
  >`
    select code, name, vat_box, input_vat_recoverable from account where code = any(${codes})
  `
  return new Map(
    rows.map((row) => [
      row.code,
      {
        name: row.name,
        // The same derivation as recoverabilityOf in @berelax/core and as the CASE in 0034. The
        // contradictory pair is refused by account_blocked_input_vat_is_not_recoverable, so the order
        // of these two tests is a consequence of the chart rather than a precedence decision.
        recoverability: (row.vat_box === 'blocked_input_tax'
          ? 'blocked'
          : row.input_vat_recoverable
            ? 'recoverable'
            : 'out_of_scope') as InputVatRecoverability,
      },
    ]),
  )
}

/**
 * Refuses a line whose treatment contradicts the classification of the account it is coded to.
 *
 * See the note above {@link readAccountClasses} for why the chart rather than a list of codes decides.
 */
function assertLinesMatchAccountRecoverability(
  input: BillToPost,
  figures: readonly LineFigures[],
  classOf: ReadonlyMap<string, AccountClass>,
): void {
  for (const [index, line] of input.lines.entries()) {
    const derived = figures[index] as LineFigures
    const account = classOf.get(line.expenseAccountCode)
    // An unknown code is the foreign key's refusal to make, not this one's: it would name the wrong
    // problem, and `bill_line.expense_account_code references account (code)` names the right one.
    if (account === undefined) continue
    const position = `Bill "${input.supplierReference}" line ${index + 1}`
    if (derived.recoverableInputVatFils > 0 && account.recoverability !== 'recoverable') {
      throw new AppError(
        'validation',
        `${position} claims ${derived.recoverableInputVatFils} fils of input VAT on account ` +
          `${line.expenseAccountCode} (${account.name}), which the chart classifies ` +
          `${account.recoverability} for input VAT recovery. ` +
          (account.recoverability === 'blocked'
            ? 'UAE VAT blocks recovery on this category (docs/04 §4): record the line as ' +
              'blocked_not_recoverable, which posts the VAT to the expense and discloses it.'
            : 'No recoverable input VAT arises on this account, so the amount is cost.'),
        {
          details: {
            sqlState: PURCHASES_SQLSTATE.blockedInputVatIsNotRecoverable,
            account: line.expenseAccountCode,
          },
        },
      )
    }
    if (line.taxTreatment === 'blocked_not_recoverable' && account.recoverability !== 'blocked') {
      throw new AppError(
        'validation',
        `${position} is blocked_not_recoverable on account ${line.expenseAccountCode} ` +
          `(${account.name}), which the chart classifies ${account.recoverability} rather than a ` +
          'blocked category. Blocked recovery is a property of the category of spend, so it is the ' +
          'account that decides it.',
        {
          details: {
            sqlState: PURCHASES_SQLSTATE.blockedTreatmentNeedsABlockedAccount,
            account: line.expenseAccountCode,
          },
        },
      )
    }
  }
}

/**
 * Refuses a bill carrying VAT the supplier could not have charged, before anything is written.
 *
 * Two suppliers cannot charge UAE VAT: one with no TRN, and one that is not established here. Both
 * refusals are the same shape and both are already enforced in the database — `bill_recoverable_needs_a_trn`
 * and `bill_blocked_needs_a_trn` as row-level CHECKs, ZV001 as a trigger at the offending line. This is the
 * layer a person reads.
 */
function assertSupplierCouldChargeVat(
  input: BillToPost,
  figures: readonly LineFigures[],
  supplier: { readonly code: string; readonly residency: string; readonly trn: string | null },
): void {
  // The refusal this unit exists to make legible, raised BEFORE anything is written. The CHECK and the
  // trigger would both catch it; neither can name the supplier and the lines in one sentence, and that
  // sentence is what tells the bookkeeper to re-enter the line as cost rather than chase the invoice.
  //
  // Every line that carries VAT, not only the ones that claim it. Only a registered supplier can charge
  // UAE VAT at all, so a blocked line standing on no tax invoice is the same mistake with a different
  // consequence: it overstates the non-recoverable disclosure instead of the claim, and a tax agent
  // reads both. This is the rule `bill_blocked_needs_a_trn` states in SQL.
  const vatBearing = figures
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter(({ line }) => line.vatFils > 0)
  // "claims" where a line would have gone to 1080 and "carries" where the VAT is only ever cost. One
  // sentence for both cases would have to pick a verb that is wrong for one of them, and the verb is the
  // part the bookkeeper reads first.
  const verb = vatBearing.some(({ line }) => line.recoverableInputVatFils > 0)
    ? 'claims input VAT on'
    : 'carries UAE VAT on'
  if (vatBearing.length > 0 && supplier.trn === null) {
    throw new AppError(
      'validation',
      `Bill "${input.supplierReference}" ${verb} line(s) ` +
        `${vatBearing.map(({ lineNo }) => lineNo).join(', ')}, but supplier "${supplier.code}" held no ` +
        'TRN when the bill was recorded, so there is no valid tax invoice to claim against. Record ' +
        'those lines as no_trn_not_recoverable: the VAT is part of the cost.',
      { details: { supplierCode: supplier.code, lines: vatBearing.map(({ lineNo }) => lineNo) } },
    )
  }
  if (vatBearing.length > 0 && supplier.residency === 'offshore') {
    throw new AppError(
      'validation',
      `Bill "${input.supplierReference}" ${verb} line(s) ` +
        `${vatBearing.map(({ lineNo }) => lineNo).join(', ')} from offshore supplier ` +
        `"${supplier.code}". ` +
        'An offshore supplier charges no UAE VAT, so there is nothing to reclaim from them and nothing ' +
        'to block. Record the line as imported_services_reverse_charge with the VAT it self-accounts: ' +
        'the tax on an imported service is declared and claimed by us, in two entries.',
      { details: { supplierCode: supplier.code, lines: vatBearing.map(({ lineNo }) => lineNo) } },
    )
  }
}

/**
 * Refuses a bill whose lines disagree with the supplier's place-of-supply rule, before anything is written.
 *
 * Its own function because it asks a different question from the two refusals above, and because the rule
 * it reads lives on the SUPPLIER: whether a supply owes the reverse charge is
 * `supplier_tax_profile.place_of_supply_rule`, stated rather than inferred (0028), which no CHECK on the
 * bill can see. `assert_reverse_charge_matches_place_of_supply()` raises ZV008 for the same two cases; this
 * is the layer that names the supplier and the lines in one sentence.
 */
function assertLinesMatchPlaceOfSupply(
  input: BillToPost,
  supplier: {
    readonly code: string
    readonly residency: string
    readonly placeOfSupplyRule: string | null
  },
): void {
  // Both directions, because both are the same question asked from opposite sides. A line that owes a
  // reverse charge and accounts for none is the missing pair, which is the failure this unit exists to
  // prevent; a line that accounts for one it does not owe declares output tax on a supply UAE VAT never
  // reached, which overstates the return in the direction nobody looks for.
  const imported = input.lines
    .map((line, index) => ({ line, lineNo: index + 1 }))
    .filter(({ line }) => line.taxTreatment === IMPORTED_SERVICES_TREATMENT)
  const owesReverseCharge = supplier.placeOfSupplyRule === IMPORTED_SERVICES_TREATMENT
  if (owesReverseCharge && imported.length < input.lines.length) {
    const missing = input.lines
      .map((line, index) => ({ line, lineNo: index + 1 }))
      .filter(({ line }) => line.taxTreatment !== IMPORTED_SERVICES_TREATMENT)
    throw new AppError(
      'validation',
      `Bill "${input.supplierReference}" line(s) ${missing.map(({ lineNo }) => lineNo).join(', ')} are ` +
        `not recorded as imported services, but supplier "${supplier.code}" supplies imported services ` +
        'and the reverse charge on them is ours to account for. Recorded any other way the output VAT is ' +
        'declared nowhere, which is the most commonly missed UAE VAT obligation at this size ' +
        '(docs/04 §4). There is no per-line place of supply here: if part of this invoice really is ' +
        "outside the scope of UAE VAT, the supplier's place-of-supply rule is what has to say so.",
      {
        details: {
          sqlState: PURCHASES_SQLSTATE.reverseChargeDoesNotMatchPlaceOfSupply,
          supplierCode: supplier.code,
          lines: missing.map(({ lineNo }) => lineNo),
        },
      },
    )
  }
  if (!owesReverseCharge && imported.length > 0) {
    throw new AppError(
      'validation',
      `Bill "${input.supplierReference}" records line(s) ` +
        `${imported.map(({ lineNo }) => lineNo).join(', ')} as imported services, but supplier ` +
        `"${supplier.code}" is ${supplier.residency} with a place-of-supply rule of ` +
        `${supplier.placeOfSupplyRule}. A supply outside the scope of UAE VAT owes no reverse charge ` +
        "and a domestic supply carries the supplier's own VAT, so state the place of supply first.",
      {
        details: {
          sqlState: PURCHASES_SQLSTATE.reverseChargeDoesNotMatchPlaceOfSupply,
          supplierCode: supplier.code,
          lines: imported.map(({ lineNo }) => lineNo),
        },
      },
    )
  }
}

/**
 * Records a bill and posts its journal entry, inside `uow`'s transaction.
 *
 * The order of the writes is load-bearing. The number is allocated first, from the locked counter row,
 * so a failure anywhere after it returns the number rather than leaving a hole (ADR 0023). The journal
 * entry is posted second, because it is what the period lock and the opening-date guard refuse — so a
 * bill dated into a closed period fails before a bill row exists, and `bill` and `bill_line` are
 * written last.
 */
export async function postBill(uow: UnitOfWork, input: BillToPost): Promise<PostedBill> {
  for (const [label, value] of [
    ['billDate', input.billDate],
    ['dueDate', input.dueDate],
    ['entryDate', input.entryDate],
  ] as const) {
    if (!ISO_DATE.test(value)) {
      throw new AppError(
        'validation',
        `${label} must be an ISO date (YYYY-MM-DD), received "${value}"`,
      )
    }
  }
  if (input.dueDate < input.billDate) {
    throw new AppError(
      'validation',
      `Bill "${input.supplierReference}" is due ${input.dueDate}, before its invoice date ` +
        `${input.billDate}. A due date behind the invoice makes a new bill 30 days overdue on arrival.`,
    )
  }
  if (input.lines.length === 0) {
    throw new AppError(
      'validation',
      `Bill "${input.supplierReference}" has no lines. An empty bill is a demand for money with no ` +
        'stated reason.',
    )
  }

  // Read before the figures are derived, because the chart decides one of them: the reverse-charge input
  // side is the whole declaration on a recoverable category and nothing at all on a blocked one.
  const classOf = await readAccountClasses(uow, input)
  const figures = input.lines.map((line, index) =>
    figuresFor(
      line,
      `Bill "${input.supplierReference}" line ${index + 1}`,
      classOf.get(line.expenseAccountCode),
    ),
  )

  const [supplier] = await uow.sql<
    {
      code: string
      legal_name: string
      residency: string | null
      place_of_supply_rule: string | null
      trn: string | null
    }[]
  >`
    select s.code, s.legal_name, p.residency, p.place_of_supply_rule, p.trn
    from supplier s
    left join supplier_tax_profile p on p.supplier_id = s.supplier_id
    where s.supplier_id = ${input.supplierId}::uuid
  `
  if (!supplier) {
    throw new AppError('not_found', `No supplier with id ${input.supplierId}`)
  }
  if (supplier.residency === null) {
    throw new AppError(
      'validation',
      `Supplier "${supplier.code}" has no tax profile, so its residency is unstated and a bill from ` +
        'it cannot be treated for VAT. State domestic or offshore first.',
      { details: { sqlState: PURCHASES_SQLSTATE.supplierHasNoTaxProfile } },
    )
  }

  assertSupplierCouldChargeVat(input, figures, {
    code: supplier.code,
    residency: supplier.residency,
    trn: supplier.trn,
  })
  assertLinesMatchPlaceOfSupply(input, {
    code: supplier.code,
    residency: supplier.residency,
    placeOfSupplyRule: supplier.place_of_supply_rule,
  })
  assertLinesMatchAccountRecoverability(input, figures, classOf)

  const netFils = figures.reduce((total, line) => total + line.netFils, 0)
  const grossFils = figures.reduce((total, line) => total + line.grossFils, 0)
  const recoverableInputVatFils = figures.reduce(
    (total, line) => total + line.recoverableInputVatFils,
    0,
  )
  const blockedInputVatFils = figures.reduce((total, line) => total + line.blockedInputVatFils, 0)
  // Both sides, summed separately. A single net figure would be zero for every recoverable import, which is
  // the whole of the failure: nothing declared, nothing claimed, and a ledger that balances.
  const reverseChargeOutputVatFils = figures.reduce(
    (total, line) => total + line.reverseChargeOutputVatFils,
    0,
  )
  const reverseChargeInputVatFils = figures.reduce(
    (total, line) => total + line.reverseChargeInputVatFils,
    0,
  )
  const reverseChargeBorneVatFils = reverseChargeOutputVatFils - reverseChargeInputVatFils
  const vatFils = grossFils - netFils

  // Allocated inside this transaction, so a refusal below returns the number to the range instead of
  // leaving a gap somebody has to explain.
  const allocated = await allocateDocumentNumber(uow, BILL_SERIES_CODE, input.entryDate)

  const narrative =
    input.narrative ??
    `Supplier bill ${allocated.displayNumber} — ${supplier.legal_name} ${input.supplierReference}`

  const journalLines: JournalLineInput[] = figures.map((line, index) => ({
    accountCode: input.lines[index]?.expenseAccountCode as string,
    // The net, plus any blocked VAT. Debiting the net alone would leave the entry short of the payable
    // by exactly the tax that cannot be reclaimed, and the deferred balance trigger would refuse the
    // whole bill at COMMIT with an arithmetic message naming no category.
    debitFils: line.expenseDebitFils,
    creditFils: 0,
    memo: input.lines[index]?.description ?? null,
  }))
  if (recoverableInputVatFils > 0) {
    journalLines.push({
      accountCode: RECOVERABLE_INPUT_VAT_ACCOUNT_CODE,
      debitFils: recoverableInputVatFils,
      creditFils: 0,
      memo: `Recoverable input VAT — TRN ${supplier.trn}`,
    })
  }
  // A separate line from the claim above, although it debits the same account. The two cannot co-occur —
  // an offshore supplier holds no UAE TRN, so no line on its bill can be standard_recoverable — and keeping
  // them apart is what lets the drill-down from the input box say which document supports which claim: a
  // supplier's tax invoice, or our own self-assessment.
  if (reverseChargeInputVatFils > 0) {
    journalLines.push({
      accountCode: RECOVERABLE_INPUT_VAT_ACCOUNT_CODE,
      debitFils: reverseChargeInputVatFils,
      creditFils: 0,
      memo: 'Reverse-charge input VAT on imported services',
    })
  }
  // The output side, never netted against the input. Posting only the difference would leave the output box
  // empty and the input box short by the same amount — a return wrong twice over, on a bill that balances.
  if (reverseChargeOutputVatFils > 0) {
    journalLines.push({
      accountCode: REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE,
      debitFils: 0,
      creditFils: reverseChargeOutputVatFils,
      memo: 'Reverse-charge output VAT on imported services',
    })
  }
  journalLines.push({
    accountCode: TRADE_PAYABLES_ACCOUNT_CODE,
    debitFils: 0,
    creditFils: grossFils,
    memo: narrative,
  })

  const entryId = `JE-${allocated.displayNumber}`
  let posted: { entryId: string }
  try {
    posted = await postJournalEntry(uow, {
      entryId,
      entryDate: input.entryDate,
      narrative,
      source: 'supplier_bill',
      lines: journalLines,
    })
  } catch (err) {
    throw purchaseError(err) ?? err
  }

  let billId: string
  try {
    const [bill] = await uow.sql<{ bill_id: string }[]>`
      insert into bill (
        supplier_id, supplier_reference, series_code, period_key, number, display_number,
        bill_date, due_date, entry_id, net_fils, gross_fils, recoverable_input_vat_fils,
        blocked_input_vat_fils, reverse_charge_output_vat_fils, reverse_charge_input_vat_fils,
        received_by
      ) values (
        ${input.supplierId}::uuid, ${input.supplierReference}, ${allocated.seriesCode},
        ${allocated.periodKey}, ${allocated.number}, ${allocated.displayNumber},
        ${input.billDate}::date, ${input.dueDate}::date, ${posted.entryId},
        ${netFils}, ${grossFils}, ${recoverableInputVatFils}, ${blockedInputVatFils},
        ${reverseChargeOutputVatFils}, ${reverseChargeInputVatFils},
        ${input.receivedBy}
      )
      returning bill_id::text as bill_id
    `
    if (!bill) {
      throw new AppError(
        'invariant_violated',
        `The bill insert returned no row for "${input.supplierReference}"`,
      )
    }
    billId = bill.bill_id

    for (const [index, line] of input.lines.entries()) {
      const derived = figures[index] as LineFigures
      await uow.sql`
        insert into bill_line (
          bill_id, line_no, description, expense_account_code, tax_treatment, vat_rate_bp,
          net_fils, gross_fils, recoverable_input_vat_fils, blocked_input_vat_fils,
          reverse_charge_output_vat_fils, reverse_charge_input_vat_fils
        ) values (
          ${billId}::uuid, ${index + 1}, ${line.description}, ${line.expenseAccountCode},
          ${line.taxTreatment}, ${derived.vatRateBp},
          ${derived.netFils}, ${derived.grossFils}, ${derived.recoverableInputVatFils},
          ${derived.blockedInputVatFils},
          ${derived.reverseChargeOutputVatFils}, ${derived.reverseChargeInputVatFils}
        )
      `
    }
  } catch (err) {
    throw purchaseError(err) ?? err
  }

  const lines: PostedBillLine[] = input.lines.map((line, index) => {
    const derived = figures[index] as LineFigures
    return {
      lineNo: index + 1,
      description: line.description,
      expenseAccountCode: line.expenseAccountCode,
      taxTreatment: line.taxTreatment,
      vatRateBp: derived.vatRateBp,
      netFils: derived.netFils,
      vatFils: derived.vatFils,
      grossFils: derived.grossFils,
      recoverableInputVatFils: derived.recoverableInputVatFils,
      blockedInputVatFils: derived.blockedInputVatFils,
      reverseChargeOutputVatFils: derived.reverseChargeOutputVatFils,
      reverseChargeInputVatFils: derived.reverseChargeInputVatFils,
      reverseChargeBorneVatFils: derived.reverseChargeBorneVatFils,
      expenseDebitFils: derived.expenseDebitFils,
    }
  })

  const result: PostedBill = {
    billId,
    supplierId: input.supplierId,
    supplierReference: input.supplierReference,
    displayNumber: allocated.displayNumber,
    seriesCode: allocated.seriesCode,
    periodKey: allocated.periodKey,
    number: allocated.number,
    entryId: posted.entryId,
    supplierTrn: supplier.trn,
    supplierResidency: supplier.residency as SupplierResidency,
    billDate: input.billDate,
    dueDate: input.dueDate,
    netFils,
    vatFils,
    grossFils,
    recoverableInputVatFils,
    blockedInputVatFils,
    reverseChargeOutputVatFils,
    reverseChargeInputVatFils,
    reverseChargeBorneVatFils,
    lines,
  }

  // `before` is absent, not fabricated: an append-only insert has no prior state, and a fabricated one
  // would be a record of something that never existed (the same asymmetry postJournalEntry documents).
  await uow.audit.record({
    action: 'purchases.bill.posted',
    entityType: 'bill',
    entityId: billId,
    operation: 'create',
    after: result,
  })

  await uow.publish({
    eventType: 'purchases.bill.posted',
    aggregateType: 'bill',
    aggregateId: billId,
    payload: {
      displayNumber: allocated.displayNumber,
      supplierId: input.supplierId,
      supplierReference: input.supplierReference,
      dueDate: input.dueDate,
      grossFils,
      recoverableInputVatFils,
      blockedInputVatFils,
      // Both sides in the event, not the net. A consumer reading one figure could not tell a recoverable
      // import from a bill with no reverse charge at all, which is the distinction the nightly report is for.
      reverseChargeOutputVatFils,
      reverseChargeInputVatFils,
      lineCount: lines.length,
    },
    // Derived from the business fact — this supplier, this invoice — so a retry cannot enqueue twice.
    idempotencyKey: `purchases.bill.posted:${input.supplierId}:${input.supplierReference}`,
  })

  return result
}

/** Reads one bill with its lines in `line_no` order, or `null`. */
export async function readBill(sql: Sql, billId: string): Promise<PostedBill | null> {
  const [bill] = await sql<
    {
      bill_id: string
      supplier_id: string
      supplier_reference: string
      display_number: string
      series_code: string
      period_key: string
      number: string
      entry_id: string
      supplier_trn: string | null
      supplier_residency: string
      bill_date: string
      due_date: string
      net_fils: string
      vat_fils: string
      gross_fils: string
      recoverable_input_vat_fils: string
      blocked_input_vat_fils: string
      reverse_charge_output_vat_fils: string
      reverse_charge_input_vat_fils: string
    }[]
  >`
    select bill_id::text as bill_id, supplier_id::text as supplier_id, supplier_reference,
           display_number, series_code, period_key, number::text as number, entry_id,
           supplier_trn, supplier_residency,
           bill_date::text as bill_date, due_date::text as due_date,
           net_fils::text as net_fils, vat_fils::text as vat_fils, gross_fils::text as gross_fils,
           recoverable_input_vat_fils::text as recoverable_input_vat_fils,
           blocked_input_vat_fils::text as blocked_input_vat_fils,
           reverse_charge_output_vat_fils::text as reverse_charge_output_vat_fils,
           reverse_charge_input_vat_fils::text as reverse_charge_input_vat_fils
    from bill where bill_id = ${billId}::uuid
  `
  if (!bill) return null

  const lines = await sql<
    {
      line_no: number
      description: string
      expense_account_code: string
      tax_treatment: string
      vat_rate_bp: number
      net_fils: string
      vat_fils: string
      gross_fils: string
      recoverable_input_vat_fils: string
      blocked_input_vat_fils: string
      reverse_charge_output_vat_fils: string
      reverse_charge_input_vat_fils: string
    }[]
  >`
    select line_no, description, expense_account_code, tax_treatment, vat_rate_bp,
           net_fils::text as net_fils, vat_fils::text as vat_fils, gross_fils::text as gross_fils,
           recoverable_input_vat_fils::text as recoverable_input_vat_fils,
           blocked_input_vat_fils::text as blocked_input_vat_fils,
           reverse_charge_output_vat_fils::text as reverse_charge_output_vat_fils,
           reverse_charge_input_vat_fils::text as reverse_charge_input_vat_fils
    from bill_line where bill_id = ${billId}::uuid order by line_no
  `

  return {
    billId: bill.bill_id,
    supplierId: bill.supplier_id,
    supplierReference: bill.supplier_reference,
    displayNumber: bill.display_number,
    seriesCode: bill.series_code,
    periodKey: bill.period_key,
    number: Number(bill.number),
    entryId: bill.entry_id,
    supplierTrn: bill.supplier_trn,
    supplierResidency: bill.supplier_residency as SupplierResidency,
    billDate: bill.bill_date,
    dueDate: bill.due_date,
    // The driver returns bigint as a string so a fils amount cannot lose precision in transit; Number()
    // is applied once, here, where the value re-enters TypeScript. Aggregates over many bills stay
    // bigint — see ../queries/payables-aging.ts.
    netFils: Number(bill.net_fils),
    vatFils: Number(bill.vat_fils),
    grossFils: Number(bill.gross_fils),
    recoverableInputVatFils: Number(bill.recoverable_input_vat_fils),
    blockedInputVatFils: Number(bill.blocked_input_vat_fils),
    reverseChargeOutputVatFils: Number(bill.reverse_charge_output_vat_fils),
    reverseChargeInputVatFils: Number(bill.reverse_charge_input_vat_fils),
    reverseChargeBorneVatFils:
      Number(bill.reverse_charge_output_vat_fils) - Number(bill.reverse_charge_input_vat_fils),
    lines: lines.map((line) => ({
      lineNo: line.line_no,
      description: line.description,
      expenseAccountCode: line.expense_account_code,
      taxTreatment: line.tax_treatment as BillTaxTreatment,
      vatRateBp: line.vat_rate_bp,
      netFils: Number(line.net_fils),
      vatFils: Number(line.vat_fils),
      grossFils: Number(line.gross_fils),
      recoverableInputVatFils: Number(line.recoverable_input_vat_fils),
      blockedInputVatFils: Number(line.blocked_input_vat_fils),
      reverseChargeOutputVatFils: Number(line.reverse_charge_output_vat_fils),
      reverseChargeInputVatFils: Number(line.reverse_charge_input_vat_fils),
      // The two sides are stored and the difference is derived, here and nowhere else. A stored third
      // figure could disagree with the pair it is made of, which is the failure that makes a reverse
      // charge look accounted for when one half of it is missing.
      reverseChargeBorneVatFils:
        Number(line.reverse_charge_output_vat_fils) - Number(line.reverse_charge_input_vat_fils),
      // Derived on the way out rather than stored: it is the net plus the blocked tax plus the
      // reverse-charge tax borne, and a stored copy would be a figure that can disagree with those.
      expenseDebitFils:
        Number(line.net_fils) +
        Number(line.blocked_input_vat_fils) +
        (Number(line.reverse_charge_output_vat_fils) - Number(line.reverse_charge_input_vat_fils)),
    })),
  }
}

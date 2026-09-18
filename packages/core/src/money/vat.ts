/**
 * Tax on a document: per-line derivation, totals that are sums, the tax point, and the issuer.
 *
 * `money.ts` answers "what is the VAT in this one gross amount" ({@link splitGross}). This module
 * answers the three questions a *tax invoice* asks, and each one exists because the obvious shortcut
 * is wrong in a way that only shows up on a filed document.
 *
 * ## 1. A document total is a SUM of per-line amounts, never a re-derivation
 *
 * VAT is a per-line fact. Two lines at 11 fils gross carry 1 fils of VAT each — `11 - round(11 * 20 /
 * 21) = 11 - 10 = 1` — so the document's VAT is **2**. Re-deriving from the 22-fils document total
 * gives `22 - round(22 * 20 / 21) = 22 - 21 = 1`, and the two answers differ by a fils on a two-line
 * receipt. Which is right is not a matter of taste: the customer was charged tax on each supply, the
 * line amounts are what appear on the document, and 1 is a figure no line supports.
 *
 * So {@link deriveDocumentTax} sums, and nothing here re-derives a total from a total.
 * {@link vatIfReDerivedFromTotal} exists only so a test can *name* the wrong number and assert it
 * appears nowhere — see the note on that function.
 *
 * ## 2. The tax point is not the issue date
 *
 * The tax point is a property of the **supply**, and the invoice may be written the following day. A
 * treatment at 01:30 belongs to the previous *trading* date (trading runs 11:00-02:00), so the tax
 * point is resolved through {@link resolveTradingDate} rather than by truncating a timestamp — a
 * calendar truncation moves a 01:30 supply into the next day, and therefore potentially into the next
 * VAT period and the next numbering year. {@link resolveTaxPoint} keeps the two dates apart and
 * returns both.
 *
 * ## 3. A tax invoice without a real TRN is not a tax invoice
 *
 * The business's TRN is not known yet (OPEN-QUESTIONS Y1-trn), so the database is seeded with
 * {@link PLACEHOLDER_TRN} — a value chosen to *fail* {@link requireIssuerTrn}. The system therefore
 * cannot issue a document carrying a plausible-looking but invented registration number, which is a
 * misrepresentation to the customer and to the FTA. The placeholder blocks issuance; the real TRN
 * unblocks it, and nothing in between silently passes.
 */
import { AppError } from '@berelax/shared'
import {
  type HoursForDate,
  type OutsideTradingReason,
  resolveTradingDate,
} from '../business-day/resolve.ts'
import {
  type Money,
  multiply,
  splitGross,
  sum,
  UAE_STANDARD_VAT_BP,
  type VatRateBp,
} from '../money.ts'
import { ASIA_DUBAI, type Instant, type LocalDate, type TimeZone, toLocal } from '../time.ts'

// --- per-line derivation -------------------------------------------------------------------------

/** A line as the caller states it: a quantity of something at a VAT-inclusive unit price. */
export interface TaxableLine {
  /** Whole units. A half treatment is a different service, not a fractional quantity. */
  readonly quantity: number
  /** VAT-inclusive unit price. Gross is authoritative (ADR 0007). */
  readonly unitGross: Money
  readonly rateBp: VatRateBp
}

/** A line with its tax derived. `net + vat === gross` exactly, for every input. */
export interface DerivedTaxLine extends TaxableLine {
  /** `unitGross * quantity`. Exact: no rounding happens here. */
  readonly gross: Money
  readonly net: Money
  /** Derived as `gross - net` on THIS line. Never apportioned from a document total. */
  readonly vat: Money
}

/**
 * Derives one line's net and VAT from its gross.
 *
 * The rounding happens once, on the line's own gross — not on the unit price. Rounding per unit and
 * multiplying would make a quantity of 3 at 11 fils carry 3 fils of VAT where the line's own gross of
 * 33 carries 2, and the line would then disagree with itself.
 */
export function deriveTaxLine(line: TaxableLine): DerivedTaxLine {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new AppError(
      'validation',
      `An invoice line needs a whole quantity of at least 1, received ${line.quantity}`,
    )
  }
  const gross = multiply(line.unitGross, line.quantity)
  const { net, vat } = splitGross(gross, line.rateBp)
  return { ...line, gross, net, vat }
}

/** One rate's subtotal. A mixed-rate document needs these; a single-rate one has exactly one. */
export interface RateSubtotal {
  readonly rateBp: VatRateBp
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
}

/** A document's tax: its lines, its totals, and the per-rate analysis a VAT return needs. */
export interface DocumentTax {
  readonly lines: readonly DerivedTaxLine[]
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
  /** Ascending by rate, so two documents with the same rates compare field for field. */
  readonly byRate: readonly RateSubtotal[]
}

/**
 * Derives every line, then totals by **summing the lines**.
 *
 * This is the unit's central claim and the one line of code it rests on: `sum(lines.map(vat))`, not
 * `splitGross(documentGross).vat`. The second is one character shorter and wrong by a fils whenever
 * the per-line roundings do not happen to agree with the aggregate one.
 */
export function deriveDocumentTax(lines: readonly TaxableLine[]): DocumentTax {
  if (lines.length === 0) {
    // A document with no lines states nothing, and its totals would all be zero — which is
    // indistinguishable from a legitimate zero-value document. Refusing here means the
    // `InvoiceWithoutLines` case is caught before a number is ever allocated to it.
    throw new AppError('validation', 'A tax document needs at least one line')
  }
  const derived = lines.map(deriveTaxLine)

  const rates = [...new Set(derived.map((l) => l.rateBp))].sort((a, b) => a - b)
  const byRate = rates.map((rateBp) => {
    const atRate = derived.filter((l) => l.rateBp === rateBp)
    return {
      rateBp,
      net: sum(atRate.map((l) => l.net)),
      vat: sum(atRate.map((l) => l.vat)),
      gross: sum(atRate.map((l) => l.gross)),
    }
  })

  return {
    lines: derived,
    net: sum(derived.map((l) => l.net)),
    vat: sum(derived.map((l) => l.vat)),
    gross: sum(derived.map((l) => l.gross)),
    byRate,
  }
}

/**
 * The VAT a document would show if its total were split instead of its lines. **Never store this.**
 *
 * It is exported for one reason: a test that asserts "the document stores 2" proves nothing unless it
 * also knows that the wrong method yields something else. This function names that number, so
 * `packages/fixtures/src/invoice-document.itest.ts` can assert the re-derived figure appears on no
 * column of the stored document — a stored `vat_total` of 2 beside a generated column yielding 1 is
 * the defect, and it is invisible to a test that only checks `vat_total`.
 *
 * A mixed-rate document has no single rate to re-derive with at all, which is a second reason the
 * aggregate shortcut cannot be written — only a reason nobody notices until a zero-rated line appears.
 */
export function vatIfReDerivedFromTotal(
  gross: Money,
  rateBp: VatRateBp = UAE_STANDARD_VAT_BP,
): Money {
  return splitGross(gross, rateBp).vat
}

// --- the tax point -------------------------------------------------------------------------------

/** The two dates a tax invoice carries, and they are not the same date. */
export interface TaxPointDates {
  readonly kind: 'resolved'
  /** Date of supply: the **trading date** the supply belongs to. The tax point. */
  readonly taxPointDate: LocalDate
  /** Date of issue: the calendar date the document was written, which may be later. */
  readonly issueDate: LocalDate
  /** The trading date the document was issued on, or null when issued outside trading hours. */
  readonly issueTradingDate: LocalDate | null
}

export type TaxPointResolution =
  | TaxPointDates
  | {
      readonly kind: 'unresolved'
      /** Why the supply instant belongs to no trading date. */
      readonly reason: OutsideTradingReason
      readonly calendarDate: LocalDate
    }

export interface TaxPointInput {
  /** When the supply happened — the treatment, not the payment. */
  readonly supplyAt: Instant
  /** When the document is written. The same instant for a till receipt, later for an invoice. */
  readonly issuedAt: Instant
  readonly hoursFor: HoursForDate
  readonly zone?: TimeZone
}

/**
 * Resolves the tax point and the issue date, keeping them separate.
 *
 * A supply at 01:30 on the 19th belongs to the 18th's trading date. Invoiced at noon on the 19th, the
 * document reads `issue_date = 2026-09-19` and `tax_point_date = 2026-09-18`, and the VAT belongs to
 * the period containing the 18th. Storing one date for both is how a supply drifts into the next VAT
 * period — and across a quarter boundary, into the next return.
 *
 * `issueTradingDate` is null when the document is written while the premises is shut, which is the
 * ordinary case for an invoice raised by the accountant at 10:00. It is not an error: the document is
 * still issued on a calendar date, and the numbering follows the tax point rather than the issue.
 */
export function resolveTaxPoint(input: TaxPointInput): TaxPointResolution {
  const zone = input.zone ?? ASIA_DUBAI
  const supply = resolveTradingDate(input.supplyAt, input.hoursFor, zone)
  if (supply.kind === 'outside_trading') {
    return { kind: 'unresolved', reason: supply.reason, calendarDate: supply.calendarDate }
  }
  const issue = resolveTradingDate(input.issuedAt, input.hoursFor, zone)
  return {
    kind: 'resolved',
    taxPointDate: supply.date,
    issueDate: toLocal(input.issuedAt, zone).date,
    issueTradingDate: issue.kind === 'trading' ? issue.date : null,
  }
}

// --- the issuer ----------------------------------------------------------------------------------

/**
 * The TRN seeded in `legal_entity` until the owner supplies the real one (Y1-trn).
 *
 * Chosen to fail {@link requireIssuerTrn} twice over: it says what it is in words, and it is not
 * fifteen digits. A placeholder that *looked* like a TRN would be printed on a document and filed.
 *
 * `0026_invoice.sql` seeds this exact string, and
 * `packages/fixtures/src/invoice-document.itest.ts` asserts the two agree — a placeholder the
 * validator does not recognise is worse than none, because it reads as configured.
 */
export const PLACEHOLDER_TRN = 'TRN-PENDING-Y1-TRN'

/** A UAE Tax Registration Number is exactly fifteen digits. */
export const TRN_PATTERN = /^[0-9]{15}$/

/**
 * Substrings that mark a value as standing in for an answer nobody has given yet.
 *
 * Matched case-insensitively against the whole value. Kept in one place because the same list is
 * implemented as `is_placeholder_text()` in `0026_invoice.sql` — the CHECK constraint has to hold for
 * a `psql` session too — and the two are asserted to agree on a table of spellings by
 * `packages/fixtures/src/invoice-document.itest.ts`.
 */
export const PLACEHOLDER_MARKERS = [
  '[confirm]',
  'to be confirmed',
  'tbc',
  'tbd',
  'pending',
  'placeholder',
  'not configured',
  'unknown',
  'todo',
  'xxx',
] as const

/** True for a blank value or one carrying any {@link PLACEHOLDER_MARKERS} marker. */
export function isPlaceholderText(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true
  const normalised = value.trim().toLowerCase()
  if (normalised === '') return true
  return PLACEHOLDER_MARKERS.some((marker) => normalised.includes(marker))
}

export type TrnRejection = 'missing' | 'placeholder' | 'malformed'

/**
 * Raised when a tax invoice would be issued without a usable TRN.
 *
 * A distinct class rather than a message, because the caller's response is specific and not a retry:
 * tell the owner to enter the TRN. `reason` distinguishes "nobody has entered one" from "somebody
 * entered the placeholder" from "somebody entered something that is not a TRN", and an operator needs
 * to be told which.
 */
export class TrnNotConfigured extends AppError {
  readonly reason: TrnRejection

  constructor(reason: TrnRejection, message: string) {
    super('invariant_violated', message, { details: { reason } })
    this.name = 'TrnNotConfigured'
    this.reason = reason
  }
}

export type TrnCheck =
  | { readonly ok: true; readonly trn: string }
  | { readonly ok: false; readonly reason: TrnRejection }

/** Classifies a TRN without throwing, for a settings screen that wants to explain rather than fail. */
export function checkTrn(value: string | null | undefined): TrnCheck {
  if (value === null || value === undefined || value.trim() === '') {
    return { ok: false, reason: 'missing' }
  }
  const trn = value.trim()
  if (isPlaceholderText(trn)) return { ok: false, reason: 'placeholder' }
  if (!TRN_PATTERN.test(trn)) return { ok: false, reason: 'malformed' }
  return { ok: true, trn }
}

const TRN_MESSAGE: Record<TrnRejection, string> = {
  missing: 'no TRN is configured on legal_entity',
  placeholder: 'the configured TRN is the Y1-trn placeholder, not a registration number',
  malformed: 'the configured TRN is not fifteen digits',
}

/** The TRN, or {@link TrnNotConfigured}. The only way to get a TRN onto a document. */
export function requireIssuerTrn(value: string | null | undefined): string {
  const checked = checkTrn(value)
  if (!checked.ok) {
    throw new TrnNotConfigured(
      checked.reason,
      `TrnNotConfigured: cannot issue a tax invoice because ${TRN_MESSAGE[checked.reason]}. ` +
        'See OPEN-QUESTIONS Y1-trn.',
    )
  }
  return checked.trn
}

/**
 * The issuer's details as they are frozen onto a document.
 *
 * A snapshot, not a join. A relocation or a change of legal name must not rewrite an invoice already
 * filed with the FTA, and a join would do exactly that silently (docs/01, docs/04 §4).
 *
 * The Arabic fields are optional because `legal_entity` and `premises` carry no Arabic columns yet —
 * see the NOTE on M-TILL-04 in `build/manifest.yaml`.
 */
export interface IssuerSnapshot {
  readonly legalName: string
  readonly tradingName: string
  readonly trn: string
  readonly addressLines: readonly string[]
  readonly legalNameAr?: string
  readonly addressLinesAr?: readonly string[]
  readonly phone?: string
  readonly licenceNumber?: string
  readonly emirate: string
}

/** The one-line address as it is stored and printed. Newline-separated, in issue order. */
export function issuerAddressSnapshot(lines: readonly string[]): string {
  return lines.map((line) => line.trim()).join('\n')
}

/**
 * Validates the issuer snapshot, or throws.
 *
 * The same three fields are refused by CHECK constraints in `0026_invoice.sql`, and both layers are
 * deliberate: the constraint holds for a `psql` session and a future repository, this holds for the
 * caller and produces {@link TrnNotConfigured} — which names what to do — rather than SQLSTATE 23514,
 * which names a constraint.
 */
export function requireIssuerSnapshot(snapshot: IssuerSnapshot): IssuerSnapshot {
  requireIssuerTrn(snapshot.trn)
  if (isPlaceholderText(snapshot.legalName)) {
    throw new AppError(
      'invariant_violated',
      `IssuerNotConfigured: legal_entity.legal_name is "${snapshot.legalName}", which is a ` +
        'placeholder. A tax invoice states who supplied the service.',
    )
  }
  if (isPlaceholderText(issuerAddressSnapshot(snapshot.addressLines))) {
    throw new AppError(
      'invariant_violated',
      'IssuerNotConfigured: the premises address is blank or a placeholder. A tax invoice states ' +
        'the supplier address (docs/04 §4).',
    )
  }
  return snapshot
}

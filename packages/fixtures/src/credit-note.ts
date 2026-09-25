import type { AccountCode, EntryId, EntrySource, JournalEntry, LocalDate } from '@berelax/core'
import {
  CREDIT_NOTE_SETTLEMENT_ACCOUNT,
  creditNoteReversal,
  filsFrom,
  type IssuerSnapshot,
  imbalanceFils,
  issuerAddressSnapshot,
  money,
  requireIssuerSnapshot,
  STANDARD_SPA_CHART,
  splitGross,
  type VatRateBp,
} from '@berelax/core'
import type {
  CreditNoteLineInput,
  IssueCreditNoteInput,
  IssuedInvoice,
  JournalEntryInput,
  PostedJournalEntry,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { FIXTURE_ISSUER } from './invoice.ts'

/**
 * The mapping between `@berelax/core`'s credit-note rule and `@berelax/db`'s writer.
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so something has
 * to turn an issued invoice and the entry it posted into the two structural mirrors `issueCreditNote`
 * takes: the note with its lines, and the reversing `JournalEntryInput`. `packages/fixtures` is the
 * package allowed to depend on both, which is what `checkout.ts` in this directory already is for the
 * checkout side, and the till route will call this.
 *
 * ## Which figures are copied and which are derived
 *
 * A line credited **in full** carries the invoice line's own `netFils` and `vatFils`, copied. That is not
 * a convenience: `ZD005` refuses a full credit whose figures are a re-derivation, because the two have to
 * agree to the fils and a `splitGross` of the same gross can differ. A line credited in **part** has its
 * tax derived on the credited gross with `splitGross`, which is the only figure there is — and three
 * partial credits of one unit each legitimately sum to one fils more VAT than the line carries, which is
 * the 11-fils case 0026 exists to keep straight and the reason the full-credit rule is the narrow one.
 *
 * The reversal comes from `creditNoteReversal`, which reads the sale's own supply movements off the
 * entry. Nothing here decides an account.
 */

/** One invoice line to credit, and how much of it. */
export interface CreditedLine {
  /** The `lineNo` of the invoice line. */
  readonly lineNo: number
  /** How much of its quantity. Defaults to all of it, which is the full-credit case. */
  readonly quantity?: number
}

export interface CreditNoteMappingInput {
  /** The document as the database holds it, lines included. */
  readonly invoice: IssuedInvoice
  /** The entry the invoice posted, as the database holds it. */
  readonly saleEntry: PostedJournalEntry
  /** Which lines, and how much of each. Defaults to every line in full. */
  readonly credited?: readonly CreditedLine[]
  /** Allocated by the caller. Core never invents an id, and neither does this. */
  readonly entryId: EntryId
  /** The credit note's OWN date: the period the correction falls in. */
  readonly creditDate: LocalDate
  readonly reason: string
  readonly issuer?: IssuerSnapshot
  /** 'CR-NOTE' unless a test is proving that another series is refused. */
  readonly seriesCode?: string
}

export interface CreditNoteMapping {
  /** What core decided: the reversing entry, dated on the note. */
  readonly reversal: JournalEntry
  /** Ready for `issueCreditNote`. */
  readonly input: IssueCreditNoteInput
}

/**
 * A stored entry, as `@berelax/core` sees it.
 *
 * The reversal rule needs the sale's lines and the chart classification of each account, and the rows
 * `readJournalEntry` returns are the same facts in `packages/db`'s spelling. Branding is applied rather
 * than re-validated: these values came out of a database whose CHECKs already refused a fractional
 * amount, a zero line and an unknown account code.
 */
export function toCoreEntry(entry: PostedJournalEntry): JournalEntry {
  return Object.freeze({
    entryId: entry.entryId as EntryId,
    entryDate: entry.entryDate as LocalDate,
    narrative: entry.narrative,
    source: entry.source as EntrySource,
    currency: 'AED' as const,
    lines: Object.freeze(
      entry.lines.map((line) =>
        Object.freeze({
          account: line.accountCode as AccountCode,
          debitFils: filsFrom(line.debitFils),
          creditFils: filsFrom(line.creditFils),
          currency: 'AED' as const,
          memo: line.memo,
        }),
      ),
    ),
    reverses: entry.reverses === null ? null : (entry.reverses as EntryId),
  })
}

/** Maps an issued document and its entry onto `issueCreditNote`'s input. */
export function creditNoteMapping(options: CreditNoteMappingInput): CreditNoteMapping {
  const issuer = requireIssuerSnapshot(options.issuer ?? FIXTURE_ISSUER)
  const credited: readonly CreditedLine[] =
    options.credited ?? options.invoice.lines.map((line) => ({ lineNo: line.lineNo }))

  const lines: CreditNoteLineInput[] = credited.map((request) => {
    const line = options.invoice.lines.find((candidate) => candidate.lineNo === request.lineNo)
    if (line === undefined) {
      // Refused here rather than by ZD004, because a mapping that silently dropped a line would produce
      // a note whose totals are right about a document it is not correcting.
      throw new AppError(
        'validation',
        `invoice ${options.invoice.displayNumber} has no line ${request.lineNo} to credit`,
      )
    }
    const quantity = request.quantity ?? line.quantity
    const full = quantity === line.quantity
    // A full credit copies; a partial one derives on the credited gross. See the module note.
    const tax = full
      ? { net: line.netFils, vat: line.vatFils }
      : (() => {
          const split = splitGross(
            money(filsFrom(line.unitGrossFils * quantity)),
            line.vatRateBp as VatRateBp,
          )
          return { net: split.net.fils, vat: split.vat.fils }
        })()
    return {
      invoiceLineNo: line.lineNo,
      descriptionEn: line.descriptionEn,
      ...(line.descriptionAr === null ? {} : { descriptionAr: line.descriptionAr }),
      quantity,
      unitGrossFils: line.unitGrossFils,
      vatRateBp: line.vatRateBp,
      netFils: tax.net,
      vatFils: tax.vat,
    }
  })

  const netTotalFils = lines.reduce((total, line) => total + line.netFils, 0)
  const vatTotalFils = lines.reduce((total, line) => total + line.vatFils, 0)
  const grossTotalFils = lines.reduce(
    (total, line) => total + line.unitGrossFils * line.quantity,
    0,
  )

  const reversal = creditNoteReversal(
    {
      entryId: options.entryId,
      entryDate: options.creditDate,
      invoiceEntry: toCoreEntry(options.saleEntry),
      credited: {
        net: money(filsFrom(netTotalFils)),
        vat: money(filsFrom(vatTotalFils)),
        gross: money(filsFrom(grossTotalFils)),
      },
    },
    STANDARD_SPA_CHART,
  )

  const journal: JournalEntryInput = {
    entryId: reversal.entryId as string,
    entryDate: reversal.entryDate as string,
    narrative: reversal.narrative,
    source: reversal.source,
    reverses: reversal.reverses === null ? null : (reversal.reverses as string),
    lines: reversal.lines.map((line) => ({
      accountCode: line.account as string,
      debitFils: line.debitFils,
      creditFils: line.creditFils,
      memo: line.memo,
    })),
  }

  const input: IssueCreditNoteInput = {
    invoiceId: options.invoice.id,
    seriesCode: options.seriesCode ?? 'CR-NOTE',
    issuer: {
      legalName: issuer.legalName,
      tradingName: issuer.tradingName,
      trn: issuer.trn,
      addressSnapshot: issuerAddressSnapshot(issuer.addressLines),
      emirate: issuer.emirate,
      ...(issuer.phone === undefined ? {} : { phone: issuer.phone }),
      ...(issuer.licenceNumber === undefined ? {} : { licenceNumber: issuer.licenceNumber }),
    },
    customer: {
      nameSnapshot: options.invoice.customerNameSnapshot,
      ...(options.invoice.customerId === null ? {} : { customerId: options.invoice.customerId }),
    },
    issueDate: options.creditDate as string,
    issueTradingDate: options.creditDate as string,
    taxPointDate: options.creditDate as string,
    reason: options.reason,
    lines,
    netTotalFils,
    vatTotalFils,
    grossTotalFils,
    reversal: journal,
    provisionalOpenQuestionId: 'Y11-vat-invoice',
    provisionalNote:
      'The mandatory credit-note field list is the tax invoice superset of docs/04 §4, pending review ' +
      'by an FTA-registered tax agent.',
  }

  return { reversal, input }
}

/**
 * The disagreements between the note and its reversal that nothing else can see.
 *
 * Returned as differences that must all be **zero**, for `reconcilePosting`'s reason: a test and a
 * runtime guard then read the same arithmetic rather than two spellings of it, and naming each field
 * individually is what makes a failure say which half is wrong.
 *
 * `0072_credit_note.sql` checks the note against its own lines at COMMIT and 0018 checks the entry's
 * balance at COMMIT, and neither can check the note against the ENTRY's liability line — they are
 * different tables and each trigger sees only its own. `ZD011` closes exactly that gap in SQL; this is
 * the same three differences one layer up, before a statutory number is allocated.
 */
export interface CreditNoteReconciliation {
  /** The note's stated net, less the sum of its lines' net. */
  readonly noteNetVersusLinesFils: number
  readonly noteVatVersusLinesFils: number
  /** The note's gross, less the sum of `unit_gross * quantity` over its lines. */
  readonly noteGrossVersusLinesFils: number
  /** The reversal's `sum(debit) - sum(credit)`. */
  readonly reversalImbalanceFils: number
  /** The note's gross, less what the reversal credits to `1050 Trade receivables`. */
  readonly noteGrossVersusLiabilityFils: number
}

export function creditNoteReconciliation(mapping: CreditNoteMapping): CreditNoteReconciliation {
  const { input, reversal } = mapping
  const liability = reversal.lines
    .filter((line) => line.account === CREDIT_NOTE_SETTLEMENT_ACCOUNT)
    .reduce((total, line) => total + line.creditFils - line.debitFils, 0)
  return {
    noteNetVersusLinesFils:
      input.netTotalFils - input.lines.reduce((total, line) => total + line.netFils, 0),
    noteVatVersusLinesFils:
      input.vatTotalFils - input.lines.reduce((total, line) => total + line.vatFils, 0),
    noteGrossVersusLinesFils:
      input.grossTotalFils -
      input.lines.reduce((total, line) => total + line.unitGrossFils * line.quantity, 0),
    reversalImbalanceFils: imbalanceFils(reversal.lines),
    noteGrossVersusLiabilityFils: input.grossTotalFils - liability,
  }
}

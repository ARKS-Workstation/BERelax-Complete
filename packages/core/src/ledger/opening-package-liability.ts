import { AppError } from '@berelax/shared'
import { releaseThrough } from '../money/package-drawdown.ts'
import type { Fils, Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import type { LocalDate } from '../time.ts'
import type { AccountCode } from './account.ts'
import { ACCOUNTS } from './chart-of-accounts.ts'
import type { EntryDraft, EntryId } from './entry.ts'
import { credit, debit } from './entry.ts'

/**
 * The opening package liability: what a reconstructed package still owes, and the entry that records it.
 *
 * H-MIG-03 imports outstanding packages out of the workbook H-MIG-02 generated. Every figure in that file
 * is a cell a human filled in — there is no incumbent export — so this module computes exactly two things
 * from them and invents nothing:
 *
 *   1. **what is still outstanding**, per row, which is what the liability account has to hold;
 *   2. **whether the file's prices add up to the cash the business says it received**, which is the only
 *      independent check the reconstruction has.
 *
 * Pure, like everything under `packages/core`: no clock, no I/O, and `scripts/check-core-purity.mjs`
 * additionally forbids `Date` and `Intl` under this directory. The opening date is an argument, because
 * the one thing this module must not do is decide which day the books open on.
 *
 * ## Why the outstanding figure is `price - releaseThrough(...)` and not a new subtraction
 *
 * {@link releaseThrough} is `ceil(value × redeemed / total)` and is the ONE statement of what a session of
 * a balance is worth: `package_release_through_fils` in `0083_package_redemption.sql` is the same
 * expression in SQL, ZG009 re-adds it over every balance, and
 * `packages/fixtures/src/package-redemption.itest.ts` holds the two equal over a census rather than by
 * inspection. A reconstruction's sessions were taken before these books existed, so what remains is the
 * price less what those sessions had already released — and computing that any other way would give a
 * different answer in exactly the cases where a price does not divide by a session count, which is most of
 * them. The imported liability would then differ from the liability a redemption computes, by a fils, for
 * ever.
 *
 * ## Why a fully drawn package is a row with no liability rather than no row
 *
 * `sessionsUsed === sessionsTotal` leaves nothing outstanding. The row still belongs in the reconciliation
 * — the business received that cash — and in the report, because the history is what the holder will ask
 * about. {@link openingPackageLiability} therefore answers `outstanding: 0` for it and
 * {@link openingPackageLiabilityPosting} refuses to build an entry, rather than building one for zero: a
 * journal line of zero is refused by `journal_line_exactly_one_side` anyway, and an entry nobody can post
 * is better found here than at the INSERT.
 *
 * ## Why the reconciliation reports the ROWS and not only the difference
 *
 * H-MIG-03's acceptance line is "a supplied cash-received total differing by one fils blocks the import
 * and the variance report lists the contributing rows". A single difference says a reconstruction is wrong
 * and nothing about where to look, and the file is dozens of lines somebody typed from cards in a drawer.
 * So {@link reconcileOpeningPackageCash} carries every row that contributes to the total, with its line
 * number, ordered by what it contributes — largest first, because a single mistyped price is usually the
 * largest contributor and a transposed pair of digits is a big number.
 */

/** One reconstructed package, as the workbook stated it. Figures already parsed, nothing normalised. */
export interface ReconstructedPackage {
  /** The line in the FILE, so a variance report opens the spreadsheet at the row. */
  readonly lineNumber: number
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly purchaseDate: LocalDate
  /** What was handed over, VAT-inclusive gross (ADR 0007). Never the template's price. */
  readonly pricePaid: Money
  readonly sessionsTotal: number
  readonly sessionsUsed: number
  readonly expiresOn: LocalDate
  readonly evidenceKind: string
}

/** What one reconstructed package leaves these books owing. */
export interface OpeningPackageLiability {
  readonly sessionsRemaining: number
  /** The share of the price the sessions already taken had released. Not a liability of these books. */
  readonly consumed: Money
  /** What is still owed, and what `2050 Deferred revenue — packages` has to carry for this row. */
  readonly outstanding: Money
}

/** Raised when a workbook row cannot describe a package at all. */
export class MalformedReconstruction extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `MalformedReconstruction: ${message}`, { details })
    this.name = 'MalformedReconstruction'
  }
}

/**
 * What a reconstructed package still owes.
 *
 * The session counts are re-checked rather than trusted, although H-MIG-02's validator has already refused
 * a row that fails any of them. They are checked because this function is also what the REPORT is built
 * from and what a later unit will call, and a row arriving from anywhere but the validator would otherwise
 * produce a negative liability — which balances, and is wrong.
 */
export function openingPackageLiability(
  input: Pick<ReconstructedPackage, 'pricePaid' | 'sessionsTotal' | 'sessionsUsed'>,
): OpeningPackageLiability {
  const { pricePaid, sessionsTotal, sessionsUsed } = input
  if (!Number.isInteger(sessionsTotal) || sessionsTotal < 1) {
    throw new MalformedReconstruction(
      `a package sold with ${sessionsTotal} session(s) entitles its holder to nothing`,
      { sessionsTotal },
    )
  }
  if (!Number.isInteger(sessionsUsed) || sessionsUsed < 0 || sessionsUsed > sessionsTotal) {
    throw new MalformedReconstruction(
      `${sessionsUsed} of ${sessionsTotal} session(s) taken is not a count this package can have`,
      { sessionsTotal, sessionsUsed },
    )
  }
  if (pricePaid.fils <= 0 || !Number.isInteger(pricePaid.fils)) {
    throw new MalformedReconstruction(
      `a package that took ${pricePaid.fils} fils is a missing figure rather than a free package`,
      { pricePaidFils: pricePaid.fils },
    )
  }

  const consumed = releaseThrough(pricePaid, sessionsTotal, sessionsUsed)
  return {
    sessionsRemaining: sessionsTotal - sessionsUsed,
    consumed,
    outstanding: money(filsFrom(pricePaid.fils - consumed.fils), pricePaid.currency),
  }
}

/**
 * The two accounts the opening posting moves, named rather than spelled at the call site.
 *
 * `3030 Retained earnings` and not cash, and the argument is in `0119_migration_signoff.sql`'s header: the
 * money was received in a period these books do not contain, so the other side of the entry is opening
 * equity. The CASH is H-MIG-07's opening asset and `artifacts/migration/package-liability.json` carries
 * the figure it has to include — debiting it here would double it the moment that unit imports the opening
 * trial balance, which is the one error in an opening position that is undetectable afterwards, because
 * the books still balance.
 */
export const OPENING_PACKAGE_LIABILITY_ACCOUNTS: {
  readonly liability: AccountCode
  readonly counterpart: AccountCode
} = Object.freeze({
  liability: ACCOUNTS.packageDeferredRevenue,
  counterpart: ACCOUNTS.retainedEarnings,
})

/**
 * The opening entry for one reconstructed package.
 *
 *     Dr  3030  Retained earnings            what is still owed
 *       Cr  2050  Deferred revenue — packages    the same
 *
 * `source` is `opening_balance` and that is load-bearing rather than descriptive: `refuse_entry_before_opening`
 * (ZL004, migration 0027) refuses any entry dated before the books open except an opening balance and a
 * reversal, and this is one. It is also what keeps a reconstruction out of every report that groups by
 * source — a prepaid package imported at cutover is not a sale this business made.
 *
 * It is refused for a fully drawn package rather than built for zero: see the module note.
 */
export function openingPackageLiabilityPosting(input: {
  readonly entryId: EntryId
  readonly openingDate: LocalDate
  readonly outstanding: Money
  /** For the narrative, so the entry says which reconstruction it is about without a join. */
  readonly reconstructionId: string
  readonly holderPhoneE164: string
  readonly templateKey: string
}): EntryDraft {
  if (input.outstanding.fils <= 0) {
    throw new MalformedReconstruction(
      `a reconstruction with ${input.outstanding.fils} fils outstanding has no liability to record, so ` +
        'there is no entry to post. A fully drawn package owes nothing and is imported with no sale at ' +
        'all; a journal line of zero is refused by journal_line_exactly_one_side in any case.',
      { reconstructionId: input.reconstructionId, outstandingFils: input.outstanding.fils },
    )
  }
  return {
    entryId: input.entryId,
    entryDate: input.openingDate,
    // The narrative names the reconstruction, the holder's number and the template, because an
    // append-only entry nobody can read is not evidence — and because this is the entry somebody will
    // find when the opening balance sheet is queried and will have to explain.
    narrative:
      `Opening package liability for reconstruction ${input.reconstructionId}: ` +
      `${input.holderPhoneE164} holds an outstanding ${input.templateKey} balance of ` +
      `${String(input.outstanding.fils)} fils, imported at cutover`,
    source: 'opening_balance',
    lines: [
      debit(
        OPENING_PACKAGE_LIABILITY_ACCOUNTS.counterpart,
        input.outstanding,
        'Opening equity: the consideration was received before these books opened',
      ),
      credit(
        OPENING_PACKAGE_LIABILITY_ACCOUNTS.liability,
        input.outstanding,
        'Treatments still owed to the holder',
      ),
    ],
  }
}

/** One row's contribution to the cash reconciliation. */
export interface CashContribution {
  readonly lineNumber: number
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly purchaseDate: LocalDate
  readonly pricePaidFils: Fils
}

/** What the file's prices add up to, against what the business says it received. */
export interface OpeningPackageCashReconciliation {
  readonly rows: number
  /** The sum of `price_paid_fils` over every row of the file. */
  readonly totalPricePaid: Money
  /** What the owner's sign-off says was actually received. */
  readonly cashReceived: Money
  /** `totalPricePaid - cashReceived`. Zero, or the import is blocked. */
  readonly varianceFils: number
  /**
   * Every row that contributes to the total, largest contribution first.
   *
   * The WHOLE population and not a guess at which rows are wrong, because nothing here can know that: the
   * variance is a property of the file against one external figure, and any row could be the mistyped
   * one. Ordering by contribution is what makes the list useful — a transposed pair of digits is a big
   * number, so the row to check first is usually at the top.
   */
  readonly contributions: readonly CashContribution[]
  /** The sum of what is still outstanding, which is what `2050` has to equal after the import. */
  readonly totalOutstanding: Money
  /** Rows admitted on the owner's recollection alone — Y9-package-thin's population. */
  readonly attestedRows: number
  readonly ok: boolean
}

/**
 * Reconciles a whole file's prices against the cash the owner's sign-off attests to.
 *
 * `ok` is `varianceFils === 0` and nothing else. There is deliberately no tolerance, not even one fils:
 * the figures are integer fils (ADR 0007), both sides are sums of integers, and a tolerance would be a
 * number somebody chose — after which the import that was out by the width of the tolerance would
 * complete, and the opening balance sheet would be wrong by it for ever. H-MIG-03's acceptance line names
 * one fils for exactly that reason.
 *
 * The attested count is carried here rather than recomputed by the report, because it is a property of the
 * same pass over the same rows and a second count over a differently-filtered set is how "five of these
 * rest on a recollection" becomes four.
 */
export function reconcileOpeningPackageCash(input: {
  readonly rows: readonly ReconstructedPackage[]
  readonly cashReceived: Money
  /** H-MIG-02's vocabulary value for "no document of any kind". Passed, never spelled here. */
  readonly attestationEvidenceKind: string
}): OpeningPackageCashReconciliation {
  let totalPaid = 0
  let totalOutstanding = 0
  let attested = 0
  const contributions: CashContribution[] = []

  for (const row of input.rows) {
    totalPaid += row.pricePaid.fils
    totalOutstanding += openingPackageLiability(row).outstanding.fils
    if (row.evidenceKind === input.attestationEvidenceKind) attested += 1
    contributions.push({
      lineNumber: row.lineNumber,
      holderPhoneE164: row.holderPhoneE164,
      templateKey: row.templateKey,
      purchaseDate: row.purchaseDate,
      pricePaidFils: row.pricePaid.fils,
    })
  }

  // Sorted by contribution and then by line, so two runs over the same file produce the same report: an
  // order that depends on a stable-sort tie is an order that diffs the first time two rows share a price.
  contributions.sort((left, right) =>
    right.pricePaidFils - left.pricePaidFils !== 0
      ? right.pricePaidFils - left.pricePaidFils
      : left.lineNumber - right.lineNumber,
  )

  const variance = totalPaid - input.cashReceived.fils
  return {
    rows: input.rows.length,
    totalPricePaid: money(filsFrom(totalPaid), input.cashReceived.currency),
    cashReceived: input.cashReceived,
    varianceFils: variance,
    contributions: Object.freeze(contributions),
    totalOutstanding: money(filsFrom(totalOutstanding), input.cashReceived.currency),
    attestedRows: attested,
    ok: variance === 0,
  }
}

/**
 * The variance report, as a person reading a blocked import sees it.
 *
 * One line per contributing row in the shape `<file>:<line>`, which is what every other refusal in this
 * migration prints, so a person correcting a workbook has one format to read. Returns an EMPTY array when
 * the file reconciles, so a caller cannot print a variance report about a reconciliation that balanced.
 */
export function formatOpeningPackageVariance(
  report: OpeningPackageCashReconciliation,
  sourceFile: string,
): readonly string[] {
  if (report.ok) return Object.freeze([])
  const direction = report.varianceFils > 0 ? 'more than' : 'less than'
  return Object.freeze([
    `${sourceFile}: the ${String(report.rows)} row(s) in this file total ` +
      `${String(report.totalPricePaid.fils)} fils, which is ${String(Math.abs(report.varianceFils))} ` +
      `fils ${direction} the ${String(report.cashReceived.fils)} fils the sign-off attests was received. ` +
      'Every row that contributes to the total is listed below, largest first; nothing is imported until ' +
      'they agree to the fils.',
    ...report.contributions.map(
      (row) =>
        `${sourceFile}:${String(row.lineNumber)}  ${String(row.pricePaidFils)} fils  ` +
        `${row.holderPhoneE164}  ${row.templateKey}  purchased ${row.purchaseDate}`,
    ),
  ])
}

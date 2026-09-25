import { AppError } from '@berelax/shared'
import type { Account, AccountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, accountFor } from '../ledger/chart-of-accounts.ts'
import type { EntryDraft, EntryId, EntryLineDraft, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, postEntry } from '../ledger/entry.ts'
import type { Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import type { LocalDate } from '../time.ts'
import { OUTPUT_VAT_ACCOUNT } from './posting.ts'

/**
 * The posting rule for a credit note: the entry that undoes a supply, dated on the NOTE's own date.
 *
 * Pure, like everything else under `packages/core/src/checkout` — no clock, no I/O, and
 * `scripts/check-core-purity.mjs` forbids `Date` and `Intl` in this directory outright. `entryDate` is
 * the credit note's own date, already resolved by the caller, and re-deriving it here would be a
 * second opinion about which period the correction falls in.
 *
 * It lives beside `posting.ts` rather than next to the service that writes it because `packages/db` may
 * never import `packages/core` and because this is arithmetic: which accounts move, in which
 * direction, by how much. `packages/db/src/services/issue-credit-note.ts` takes the structural mirror
 * and writes it; `packages/fixtures/src/credit-note.ts` is the mapping.
 *
 * ## Why this is not `reverseEntry`
 *
 * `ledger/reverse.ts` already builds the exact mirror of an entry, and using it here would be wrong in
 * a way that reconciles: a checkout's entry debits the tender account, so its mirror CREDITS the
 * tender account — which says the cash left the drawer. It has not. A credit note is a document; the
 * money moves when a `refund` row moves it (0068), and a reversal that took the cash out would either
 * double-count against that refund or leave a counted drawer unexplainable by any row.
 *
 * So the reversal mirrors the **supply side only** — every revenue account the sale touched, plus the
 * output VAT — and parks the balance in `1050 Trade receivables`:
 *
 * ```
 *   Dr  4010                 the treatment revenue the sale credited
 *   Dr  2030                 the output VAT the sale charged
 *     Cr  4095              the discount the sale took off, if there was one
 *     Cr  1050              what the document is no longer owed
 * ```
 *
 * `1050` is 0068's choice and not this module's, and it is worth saying why it is followed rather than
 * improved on. `manual-payment.ts` states the whole shape: a payment posts `Dr tender / Cr 1050`, a
 * refund posts `Dr 1050 / Cr tender`, and "the credit note that authorises it posts the other half of
 * the correction (Dr revenue and output VAT, Cr 1050), which is M-TILL-08's". Following it makes an
 * invoice, a full credit note and a full refund net to zero in EVERY account any of the three touched.
 * The account a reader is likely to reach for instead is `2085 Customer refunds payable`, which is the
 * better name for a credited-but-unrefunded amount — a liability rather than a negative receivable —
 * and choosing it HERE alone would leave `2085` and `1050` each carrying a balance nothing clears,
 * because the refund's side is 0068's. Moving both halves is one decision for one unit; see the NOTE on
 * M-TILL-08.
 *
 * The tender accounts and `2040 Gratuities payable` are deliberately untouched. A gratuity is not
 * consideration for a supply and is on no tax invoice, so crediting the supply does not take back a tip
 * the therapist is owed.
 *
 * ## Full and partial, and the one case that is refused
 *
 * A **full** credit — one whose gross equals the whole supply side of the sale — mirrors each of those
 * movements exactly, so the invoice and the note net to zero in every account either of them touched
 * and in every VAT201 box those accounts feed. No amount is re-derived and nothing is apportioned.
 *
 * A **partial** credit posts the note's own net and VAT against the one revenue account the sale used.
 * That is exact while there is only one, and it is refused by {@link PartialCreditNeedsApportionment}
 * when the sale moved more than one revenue account — which in practice means a discounted line. The
 * refusal is deliberate and is not a gap in the arithmetic: splitting a partial credit between
 * `4010 Treatment revenue` and `4095 Discounts and allowances` is a decision about whether a discount
 * is clawed back pro rata, and nobody has made it. A rule invented here would be indistinguishable
 * from a confirmed one for as long as it happened to produce plausible numbers. See the NOTE on
 * M-TILL-08 in `build/manifest.yaml`.
 */

/**
 * Where a credited supply is parked until the money goes back.
 *
 * `1050 Trade receivables`: the account 0068's payment and refund postings clear and re-create, so an
 * invoice, a full credit note and a full refund net to zero in every account. Stated here, once in
 * `packages/db` (`TRADE_RECEIVABLES_ACCOUNT_CODE`, which the write path reads because it may never
 * import this module) and once in SQL (`credit_note_settlement_account_code()`), and the three are held
 * equal by `packages/fixtures/src/credit-note.itest.ts` with a control.
 */
export const CREDIT_NOTE_SETTLEMENT_ACCOUNT: AccountCode = ACCOUNTS.tradeReceivables

/** Raised when a credit note would take off more than the document's supply side carries. */
export class CreditNoteExceedsDocument extends AppError {
  constructor(entryId: string, creditedFils: number, supplyFils: number) {
    super(
      'validation',
      `A credit note of ${creditedFils} fils cannot be raised against entry "${entryId}", whose ` +
        `supply side is ${supplyFils} fils. Crediting more than was supplied is not a correction.`,
      { details: { entryId, creditedFils, supplyFils } },
    )
    this.name = 'CreditNoteExceedsDocument'
  }
}

/** Raised for a credit note whose stated net and VAT do not add up to its stated gross. */
export class CreditNoteTotalsDisagree extends AppError {
  constructor(netFils: number, vatFils: number, grossFils: number) {
    super(
      'invariant_violated',
      `A credit note states net ${netFils} + VAT ${vatFils} fils against a gross of ${grossFils}. ` +
        'VAT is derived as gross minus net so that the three always reconcile (ADR 0007).',
      { details: { netFils, vatFils, grossFils } },
    )
    this.name = 'CreditNoteTotalsDisagree'
  }
}

/** Raised for a credit note of nothing. It would consume a statutory number and correct nothing. */
export class NothingToCredit extends AppError {
  constructor(entryId: string) {
    super(
      'validation',
      `A credit note against entry "${entryId}" credits zero fils. A zero-value correction consumes a ` +
        'statutory number and states nothing.',
      { details: { entryId } },
    )
    this.name = 'NothingToCredit'
  }
}

/**
 * Raised for a PARTIAL credit against a sale that moved more than one revenue account.
 *
 * The apportionment between treatment revenue and the discount contra is an undecided policy, not a
 * missing calculation. A full credit of the same document is always available and needs no rule.
 */
export class PartialCreditNeedsApportionment extends AppError {
  constructor(entryId: string, accounts: readonly string[]) {
    super(
      'validation',
      `A partial credit against entry "${entryId}" cannot be posted: the sale moved ${accounts.length} ` +
        `revenue accounts (${accounts.join(', ')}), and splitting part of a credit between treatment ` +
        'revenue and the discount contra is a decision about whether a discount is clawed back pro ' +
        'rata that nobody has made. Credit the document in full, or record the correction against a ' +
        'document with no discount.',
      { details: { entryId, accounts } },
    )
    this.name = 'PartialCreditNeedsApportionment'
  }
}

/** One account's net movement on the supply side of a sale. Positive is a credit, as posted. */
export interface SupplyMovement {
  readonly account: AccountCode
  /** `sum(credit) - sum(debit)` for this account. Positive for revenue, negative for a contra. */
  readonly netFils: number
}

/** What a credit note states. The three always reconcile: `net + vat === gross` (ADR 0007). */
export interface CreditedTotals {
  readonly net: Money
  readonly vat: Money
  readonly gross: Money
}

export interface CreditNoteReversalInput {
  /** Allocated by the caller. Core never invents an id. */
  readonly entryId: EntryId
  /** The credit note's own date, which is the period the correction falls in. */
  readonly entryDate: LocalDate
  /** The entry the invoice posted. Read, never modified — the journal is append-only. */
  readonly invoiceEntry: JournalEntry
  /** The sums of the credit note's own lines. Never a re-derivation from the document total. */
  readonly credited: CreditedTotals
  readonly narrative?: string
}

/**
 * The supply side of a sale: every revenue account it moved, plus the output VAT.
 *
 * Merged per account and in account-code order, for `checkoutPosting`'s reason: two runs over one
 * entry produce byte-identical working papers, and an insertion-ordered result diffs everywhere the
 * moment a posting order changes. An account whose debits and credits cancel exactly is omitted —
 * `journal_line_exactly_one_side` refuses a zero line, and an account that moved nothing did not take
 * part in the supply.
 *
 * Exported because it is the thing a reader of a credit note wants to see and the thing a test has to
 * be able to assert on separately from the entry built out of it.
 */
export function supplyMovements(
  entry: JournalEntry,
  chart: ChartOfAccounts,
): readonly SupplyMovement[] {
  const byAccount = new Map<string, number>()
  for (const line of entry.lines) {
    const account: Account = accountFor(chart, line.account)
    const isSupply = account.type === 'revenue' || line.account === OUTPUT_VAT_ACCOUNT
    if (!isSupply) continue
    const previous = byAccount.get(line.account) ?? 0
    byAccount.set(line.account, previous + line.creditFils - line.debitFils)
  }
  return Object.freeze(
    [...byAccount.entries()]
      .filter(([, netFils]) => netFils !== 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([account, netFils]) => Object.freeze({ account: account as AccountCode, netFils })),
  )
}

/** `sum(netFils)` over the supply side, which for a checkout is the document's gross. */
export function supplyTotalFils(movements: readonly SupplyMovement[]): number {
  return movements.reduce((total, movement) => total + movement.netFils, 0)
}

/**
 * Builds the entry a credit note posts, dated on the note's own date.
 *
 * Returns an entry whose `reverses` names the invoice's entry and whose `source` is `'reversal'`: both
 * are what `credit_note_reversal_is_dated_on_the_note()` (ZD011) and `journal_entry.source` are for,
 * and a refund and a credited sale produce identical lines, so the classification is the only thing
 * that tells them apart when a customer asks.
 *
 * `postEntry` validates the accounts, the sides and the balance and returns `reverses: null`, so the
 * reversal link is set on a copy of its result rather than by re-implementing that validation —
 * `reverseEntry` does the same for the same reason.
 */
export function creditNoteReversal(
  input: CreditNoteReversalInput,
  chart: ChartOfAccounts,
): JournalEntry {
  const entryId = input.invoiceEntry.entryId as string
  const { net, vat, gross } = input.credited

  if (net.fils + vat.fils !== gross.fils) {
    throw new CreditNoteTotalsDisagree(net.fils, vat.fils, gross.fils)
  }
  if (gross.fils <= 0) throw new NothingToCredit(entryId)

  const movements = supplyMovements(input.invoiceEntry, chart)
  const supply = supplyTotalFils(movements)
  if (gross.fils > supply) throw new CreditNoteExceedsDocument(entryId, gross.fils, supply)

  const lines: EntryLineDraft[] =
    gross.fils === supply ? fullCredit(movements) : partialCredit(entryId, movements, net, vat)

  lines.push(
    credit(
      CREDIT_NOTE_SETTLEMENT_ACCOUNT,
      gross,
      'Credited off the document, owed back until a refund moves it',
    ),
  )

  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.entryDate,
    narrative:
      input.narrative ??
      `Credit note reversal of ${entryId}: ${gross.fils} fils off ${movements.length} supply ` +
        'account(s)',
    source: 'reversal',
    lines,
  }

  const posted = postEntry(draft, chart)
  return Object.freeze({ ...posted, reverses: input.invoiceEntry.entryId })
}

/**
 * The exact mirror of every supply movement. No amount is re-derived and nothing is apportioned, which
 * is what makes "an invoice plus a full credit note nets to zero in every affected account" true by
 * construction rather than by arithmetic that has to be checked.
 */
function fullCredit(movements: readonly SupplyMovement[]): EntryLineDraft[] {
  return movements.map((movement) => {
    const amount = money(filsFrom(Math.abs(movement.netFils)))
    // A movement the sale CREDITED is debited back, and one it debited — a discount contra — is
    // credited back. The sign is the sale's own direction, read off the entry rather than assumed.
    return movement.netFils > 0
      ? debit(movement.account, amount, 'Supply credited by a credit note')
      : credit(movement.account, amount, 'Discount reversed with the supply it reduced')
  })
}

/**
 * The note's own net and VAT, against the single revenue account the sale used.
 *
 * Refused outright when there is more than one. See {@link PartialCreditNeedsApportionment}.
 */
function partialCredit(
  entryId: string,
  movements: readonly SupplyMovement[],
  net: Money,
  vat: Money,
): EntryLineDraft[] {
  const revenue = movements.filter((movement) => movement.account !== OUTPUT_VAT_ACCOUNT)
  if (revenue.length !== 1) {
    throw new PartialCreditNeedsApportionment(
      entryId,
      revenue.map((movement) => movement.account as string),
    )
  }
  const only = revenue[0] as SupplyMovement
  const lines: EntryLineDraft[] = [
    debit(only.account, net, 'Part of a supply credited by a credit note'),
  ]
  // A zero-rated line carries no VAT, and a zero line is a posting that did not happen:
  // `journal_line_exactly_one_side` refuses one. The note's gross still equals its net, so the entry
  // balances with two lines.
  if (vat.fils > 0) {
    lines.push(debit(OUTPUT_VAT_ACCOUNT, vat, 'Output VAT relieved by a credit note'))
  }
  return lines
}

import type { Brand } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import type { Currency, Fils, Money } from '../money.ts'
import { filsFrom } from '../money.ts'
import type { LocalDate } from '../time.ts'
import type { Account, AccountCode, AccountType } from './account.ts'
import { signedBalance } from './account.ts'
import { accountFor, type ChartOfAccounts } from './chart-of-accounts.ts'

/**
 * The double-entry kernel (ADR 0017).
 *
 * `postEntry` is the only way to obtain a `JournalEntry`, and it either returns a balanced entry or
 * throws. There is no "unbalanced but saved" state and no repair path: the journal is append-only,
 * so an entry that reached storage slightly wrong stays slightly wrong forever and every figure
 * derived from it is wrong by the same amount. Corrections are dated reversals — see `reverse.ts`.
 *
 * Everything here is pure. `entryDate` is a `LocalDate` the caller resolved on `business_day`
 * (trading runs 11:00 to 02:00, so a 01:30 sale belongs to the previous trading date), and nothing
 * in this directory may touch `Date` or `Intl` to re-derive it — `scripts/check-core-purity.mjs`
 * enforces that for this directory specifically. Re-deriving a trading date from a calendar date is
 * how the 01:30 sale lands on the wrong day's takings.
 */

/** Identifier for one journal entry. Allocated outside core; the kernel never invents one. */
export type EntryId = Brand<string, 'EntryId'>

export type EntrySide = 'debit' | 'credit'

/**
 * Why the entry exists. Carried on the entry rather than inferred from the accounts, because two
 * different events can produce identical lines: a refund and a cancelled sale look the same in the
 * accounts and are answered differently when a customer asks.
 */
export type EntrySource =
  | 'sale'
  | 'refund'
  | 'payment'
  | 'payout'
  | 'cash_up'
  | 'supplier_bill'
  | 'payroll'
  | 'gratuity_accrual'
  | 'commission_accrual'
  | 'package_sale'
  | 'package_redemption'
  | 'voucher_sale'
  | 'voucher_redemption'
  | 'depreciation'
  | 'opening_balance'
  | 'adjustment'
  | 'reversal'

export interface EntryLineDraft {
  readonly account: AccountCode
  readonly side: EntrySide
  /**
   * Always positive. A `Money`, so a bare `number` and a fractional `aed(1.5)` are both compile
   * errors — see the type-error fixtures in `scripts/test-gates.mjs`. Direction lives in `side`,
   * never in the sign, because a negative debit and a positive credit both balance and only one of
   * them is what the poster meant.
   */
  readonly amount: Money
  readonly memo?: string
}

export interface JournalLine {
  readonly account: AccountCode
  readonly debitFils: Fils
  readonly creditFils: Fils
  readonly currency: Currency
  readonly memo: string | null
}

export interface EntryDraft {
  readonly entryId: EntryId
  /** The business day the entry belongs to, already resolved by the caller. */
  readonly entryDate: LocalDate
  readonly narrative: string
  readonly source: EntrySource
  readonly lines: readonly EntryLineDraft[]
}

export interface JournalEntry {
  readonly entryId: EntryId
  readonly entryDate: LocalDate
  readonly narrative: string
  readonly source: EntrySource
  readonly currency: Currency
  readonly lines: readonly JournalLine[]
  /** The entry this one reverses, or `null`. Set only by `reverseEntry`. */
  readonly reverses: EntryId | null
}

/**
 * Raised when debits and credits do not agree.
 *
 * `invariant_violated` rather than `validation`: a caller cannot fix this by prompting the user
 * differently. Some posting rule computed a set of lines that does not balance, and the correct
 * response is to fail the transaction, not to round something.
 */
export class UnbalancedEntry extends AppError {
  readonly debitFils: number
  readonly creditFils: number
  constructor(entryId: string, debits: number, credits: number) {
    super(
      'invariant_violated',
      `Entry "${entryId}" does not balance: debits ${debits} fils, credits ${credits} fils, ` +
        `difference ${debits - credits} fils`,
      { details: { entryId, debits, credits, difference: debits - credits } },
    )
    this.name = 'UnbalancedEntry'
    this.debitFils = debits
    this.creditFils = credits
  }
}

/** Raised when a draft is structurally unusable, before balance is even considered. */
export class MalformedEntry extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation', message, details === undefined ? undefined : { details })
    this.name = 'MalformedEntry'
  }
}

export function entryId(value: string): EntryId {
  if (value.trim().length === 0) {
    throw new MalformedEntry('An entry id may not be blank')
  }
  return value as EntryId
}

/** A debit line. Reads as it would be spoken, which is what makes a posting rule reviewable. */
export function debit(account: AccountCode, amount: Money, memo?: string): EntryLineDraft {
  return memo === undefined
    ? { account, side: 'debit', amount }
    : { account, side: 'debit', amount, memo }
}

export function credit(account: AccountCode, amount: Money, memo?: string): EntryLineDraft {
  return memo === undefined
    ? { account, side: 'credit', amount }
    : { account, side: 'credit', amount, memo }
}

export function debitTotalFils(lines: readonly JournalLine[]): Fils {
  return filsFrom(lines.reduce((total, line) => total + line.debitFils, 0))
}

export function creditTotalFils(lines: readonly JournalLine[]): Fils {
  return filsFrom(lines.reduce((total, line) => total + line.creditFils, 0))
}

/** `sum(debit_fils) - sum(credit_fils)`. Zero for every entry `postEntry` returns. */
export function imbalanceFils(lines: readonly JournalLine[]): number {
  return debitTotalFils(lines) - creditTotalFils(lines)
}

export function isBalanced(entry: JournalEntry): boolean {
  return imbalanceFils(entry.lines) === 0
}

function toLine(draft: EntryLineDraft, account: Account, id: string): JournalLine {
  const fils = draft.amount.fils
  if (!Number.isInteger(fils)) {
    // Reachable only through a cast past `Money`. Worth checking anyway: the cast is exactly what a
    // hurried caller reaches for, and half a fils in the journal cannot be reconciled by anyone.
    throw new MalformedEntry(
      `Entry "${id}" line on account ${account.code} has a fractional amount (${fils} fils)`,
      { account: account.code, fils },
    )
  }
  if (fils <= 0) {
    throw new MalformedEntry(
      `Entry "${id}" line on account ${account.code} has a non-positive amount (${fils} fils). ` +
        'Direction is expressed by the side, not by the sign.',
      { account: account.code, fils },
    )
  }
  const zero = filsFrom(0)
  return {
    account: account.code,
    debitFils: draft.side === 'debit' ? draft.amount.fils : zero,
    creditFils: draft.side === 'credit' ? draft.amount.fils : zero,
    currency: draft.amount.currency,
    memo: draft.memo ?? null,
  }
}

/**
 * Validates a draft against the chart and returns a balanced, frozen entry.
 *
 * Throws rather than returning a result union, deliberately. A result type is better wherever the
 * caller has something useful to do with the failure; here it does not, and the cost of the union is
 * that an ignored return value posts nothing at all and looks like success.
 */
export function postEntry(draft: EntryDraft, chart: ChartOfAccounts): JournalEntry {
  const id = draft.entryId as string
  if (draft.narrative.trim().length === 0) {
    throw new MalformedEntry(
      `Entry "${id}" has no narrative. An append-only entry nobody can read is not evidence.`,
    )
  }
  if (draft.lines.length < 2) {
    throw new MalformedEntry(
      `Entry "${id}" has ${draft.lines.length} line(s). A double entry needs at least two, and a ` +
        'single line can only balance by being zero.',
      { lines: draft.lines.length },
    )
  }

  const lines = draft.lines.map((line) => toLine(line, accountFor(chart, line.account), id))

  const currency = lines[0]?.currency ?? 'AED'
  for (const line of lines) {
    if (line.currency !== currency) {
      throw new MalformedEntry(
        `Entry "${id}" mixes ${currency} and ${line.currency}. One entry, one currency.`,
      )
    }
  }

  const debits = debitTotalFils(lines)
  const credits = creditTotalFils(lines)
  if (debits !== credits) throw new UnbalancedEntry(id, debits, credits)

  return Object.freeze({
    entryId: draft.entryId,
    entryDate: draft.entryDate,
    narrative: draft.narrative,
    source: draft.source,
    currency,
    lines: Object.freeze(lines.map((line) => Object.freeze(line))),
    reverses: null,
  })
}

// --- trial balance -----------------------------------------------------------------------------

export interface DateWindow {
  /** Inclusive. Omitted means "from the first entry". */
  readonly from?: LocalDate
  /** Inclusive. Omitted means "to the last entry". */
  readonly to?: LocalDate
}

export interface TrialBalanceRow {
  readonly account: AccountCode
  readonly name: string
  readonly type: AccountType
  readonly debitFils: Fils
  readonly creditFils: Fils
  /** Signed in the account's own normal-balance direction, so a normal balance is positive. */
  readonly balance: Money
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[]
  readonly totalDebit: Money
  readonly totalCredit: Money
  /**
   * True when the totals agree. Always true for entries that came through `postEntry`, which is
   * what makes it worth reporting: a false here means something reached the journal another way.
   */
  readonly balanced: boolean
}

/**
 * Aggregates entries per account.
 *
 * The window is compared as `YYYY-MM-DD` strings, which sort correctly and need no date arithmetic.
 * That is not a shortcut — it is the reason this module can be forbidden `Date` entirely.
 */
export function trialBalance(
  entries: readonly JournalEntry[],
  chart: ChartOfAccounts,
  window: DateWindow = {},
): TrialBalance {
  const totals = new Map<string, { debit: number; credit: number }>()

  for (const entry of entries) {
    if (window.from !== undefined && entry.entryDate < window.from) continue
    if (window.to !== undefined && entry.entryDate > window.to) continue
    for (const line of entry.lines) {
      const key = line.account as string
      const running = totals.get(key) ?? { debit: 0, credit: 0 }
      running.debit += line.debitFils
      running.credit += line.creditFils
      totals.set(key, running)
    }
  }

  // Sorted by code so two runs over the same entries produce byte-identical working papers; an
  // insertion-ordered report diffs everywhere the moment a posting order changes.
  const rows = [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, running]) => {
      const account = accountFor(chart, code as AccountCode)
      const debitFils = filsFrom(running.debit)
      const creditFils = filsFrom(running.credit)
      return {
        account: account.code,
        name: account.name,
        type: account.type,
        debitFils,
        creditFils,
        balance: signedBalance(account, debitFils, creditFils),
      }
    })

  const totalDebit = filsFrom(rows.reduce((sum, row) => sum + row.debitFils, 0))
  const totalCredit = filsFrom(rows.reduce((sum, row) => sum + row.creditFils, 0))

  return {
    rows,
    totalDebit: { fils: totalDebit, currency: 'AED' },
    totalCredit: { fils: totalCredit, currency: 'AED' },
    balanced: totalDebit === totalCredit,
  }
}

/** Net movement per account across the given entries, as `debit - credit` in fils. */
export function netByAccount(entries: readonly JournalEntry[]): ReadonlyMap<AccountCode, number> {
  const net = new Map<AccountCode, number>()
  for (const entry of entries) {
    for (const line of entry.lines) {
      net.set(line.account, (net.get(line.account) ?? 0) + line.debitFils - line.creditFils)
    }
  }
  return net
}

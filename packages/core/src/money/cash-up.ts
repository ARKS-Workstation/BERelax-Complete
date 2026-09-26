import { AppError } from '@berelax/shared'
import type { AccountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import type { EntryDraft, EntryId, EntryLineDraft, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, postEntry } from '../ledger/entry.ts'
import type { Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import type { LocalDate } from '../time.ts'

/**
 * The cash-up: what a drawer should hold, what it did hold, and the posting for the difference.
 *
 * Pure. No clock, no I/O; `scripts/check-core-purity.mjs` forbids `Date` and `Intl` in `packages/core`
 * outright, and the business day arrives as a `LocalDate` the caller resolved with `resolveTradingDate`.
 * `packages/db/src/services/cash-session.ts` takes the structural mirror and writes it;
 * `packages/fixtures/src/cash-up.ts` is the mapping, because `packages/db` may never import this module.
 *
 * ## The key is the business day, and a shift across midnight is one session
 *
 * Trading runs 11:00–02:00 (docs/01 decision 22). A shift that opens at 23:00 and ends at 02:00 belongs
 * to ONE business day: 02:00 is the close instant of the 23:00 date's session, so `resolveTradingDate`
 * maps both instants to that date. Nothing in this module derives a date from an instant — that is
 * `business-day/resolve.ts`'s job and a second derivation here would be a second answer — but the
 * consequence is the whole shape of the artefact: `expectedFloat` is computed over the takings of a
 * business day, so a reconciliation keyed on the calendar date would split a late shift across two
 * counts, measure the first against a drawer still in use and the second against a float nobody
 * declared, and balance neither.
 *
 * ## What is counted, and against what
 *
 *     expected = opening float + cash received - change given - cash refunded - drops
 *
 * `cashReceived` and `changeGiven` are kept SEPARATE and are never handed in as one net figure. That is
 * the use 0068 separated `payment.amount_fils` from `payment.change_given_fils` for: a drawer is counted
 * against the notes that went in and the notes that came out, a cash-up sheet is checked against the till
 * roll in both directions, and `applied_fils` alone reconciles against neither. {@link DrawerTakings}
 * therefore has five fields and not three, and `expectedFloat` is the only place they are combined.
 *
 * ## The discrepancy is a signed figure, and it is the artefact
 *
 * `counted - expected`. Negative is SHORT, positive is OVER, and {@link DrawerReconciliation} carries the
 * number rather than a flag: a till out by 5 fils and one out by 500 dirhams are the same boolean and
 * entirely different events, and a boolean cannot be summed over a month to tell a process problem from a
 * person problem. A reconciliation that cannot fail to balance is not a reconciliation.
 *
 * ## A disagreement is recorded, not refused
 *
 * {@link cashUpPosting} builds the entry for a non-zero discrepancy and {@link DrawerBalances} refuses to
 * build one for a zero discrepancy — because `journal_line_exactly_one_side` (0018) refuses a zero-value
 * line, so the only entry a balanced drawer could post is an entry about some other figure.
 *
 * Refusing the CLOSE instead was considered and is wrong. The count is a measurement of the physical
 * world; the expectation is a derivation from rows. When they differ the measurement is the fact, and a
 * refusal would leave the shift with no counted figure at all — destroying the evidence of the
 * discrepancy with the mechanism meant to protect it, and leaving the operator's only way to finish the
 * day being to type the expected number in. That is the silent absorption this unit exists to prevent.
 * So the close is recorded, with a reason, and the difference is posted to `6140 Cash over and short` in
 * the same transaction (`ZU004`).
 */

/** Where a drawer discrepancy is posted. `6140 Cash over and short`. */
export const CASH_OVER_SHORT_ACCOUNT: AccountCode = ACCOUNTS.cashOverShort

/**
 * The five figures a drawer is reconciled from, in integer fils.
 *
 * Plain integers rather than `Money` because four of the five arrive as `bigint` columns and the fifth is
 * a keyed-in count: `filsFromStoredDigits` is where a stored figure becomes a number, and wrapping each
 * one in a `Money` here would add a currency to five quantities that are all the same currency by
 * construction. The one place a `Money` is needed is the posting, where {@link cashUpPosting} builds it.
 */
export interface DrawerTakings {
  /** Declared at the open. The previous close's counted cash, left in the till. */
  readonly openingFloatFils: number
  /** `sum(payment.amount_fils)` for the cash tenders of this business day — the notes that went IN. */
  readonly cashReceivedFils: number
  /** `sum(payment.change_given_fils)` — the notes that came OUT. Never netted into the line above. */
  readonly changeGivenFils: number
  /** `sum(refund.amount_fils)` for the cash refunds of this business day. */
  readonly cashRefundedFils: number
  /** Cash taken out of the drawer mid-shift to the safe or the bank, each one already posted. */
  readonly dropsFils: number
}

/** Which way a drawer is out. Derived from the sign, never stored beside it. */
export type DrawerDirection = 'balanced' | 'over' | 'short'

export interface DrawerReconciliation {
  readonly takings: DrawerTakings
  readonly expectedFils: number
  readonly countedFils: number
  /** `counted - expected`. Negative is short, positive is over. */
  readonly discrepancyFils: number
  readonly direction: DrawerDirection
}

/**
 * Raised when a close arrives with no counted float.
 *
 * The counted float minus the expected float IS the reconciliation, so a close without one records an
 * expectation and no measurement — a shift that was never counted, wearing the word closed. The database
 * refuses the same thing by name (`ZU001`), because this module is not the only thing that can reach a
 * `psql` prompt.
 */
export class CountRequired extends AppError {
  constructor(drawerCode: string, businessDay: string) {
    super(
      'validation',
      `CountRequired: the drawer "${drawerCode}" cannot be closed for business day ${businessDay} ` +
        'with no counted amount. The counted float minus the expected float IS the reconciliation; a ' +
        'close without one records an expectation and no measurement.',
      { details: { drawerCode, businessDay } },
    )
    this.name = 'CountRequired'
  }
}

/**
 * Raised when a posting is asked for a drawer that balanced exactly.
 *
 * `invariant_violated` and not `validation`: the caller cannot fix it by prompting differently. A
 * balanced drawer posts nothing at all — `journal_line_exactly_one_side` (0018) refuses a zero-value
 * line, so an entry here could only be about some other figure, and `ZU004` refuses a balanced session
 * that names one.
 */
export class DrawerBalances extends AppError {
  constructor(drawerCode: string, businessDay: string, countedFils: number) {
    super(
      'invariant_violated',
      `DrawerBalances: the drawer "${drawerCode}" counted ${countedFils} fils on business day ` +
        `${businessDay}, exactly as expected, so there is nothing to post. A balanced drawer posts no ` +
        'entry: a zero-value line is refused, so any entry here would move some other figure.',
      { details: { drawerCode, businessDay, countedFils } },
    )
    this.name = 'DrawerBalances'
  }
}

/** Raised when a drop, or a correction, is asked for with no amount. */
export class NothingToMove extends AppError {
  constructor(what: string, amountFils: number) {
    super(
      'validation',
      `NothingToMove: a ${what} of ${amountFils} fils moves nothing. A zero movement is a record ` +
        'somebody started and did not finish, and a negative one is the opposite movement typed in ' +
        'the wrong place — direction is the side, never the sign.',
      { details: { what, amountFils } },
    )
    this.name = 'NothingToMove'
  }
}

function assertWholeFils(label: string, value: number): void {
  if (!Number.isInteger(value)) {
    // Money is integer fils (ADR 0007). Half a fils reconciled against a drawer cannot be explained by
    // anyone, and it would arrive here from a division somebody forgot to round.
    throw new AppError(
      'validation',
      `${label} must be an integer number of fils, received ${value}`,
      { details: { label, value } },
    )
  }
}

/**
 * What the drawer should hold: `opening + received - change - refunded - drops`.
 *
 * The one statement of the formula on this side of the boundary. The other is
 * `cash_session_expected_float_fils()` in `0076_cash_session.sql`, which both of `cash_session`'s
 * generated columns call, and `packages/fixtures/src/cash-up.itest.ts` holds the two equal over a
 * generated set of takings with a control proving the comparison can fail.
 */
export function expectedFloat(takings: DrawerTakings): number {
  assertWholeFils('openingFloatFils', takings.openingFloatFils)
  assertWholeFils('cashReceivedFils', takings.cashReceivedFils)
  assertWholeFils('changeGivenFils', takings.changeGivenFils)
  assertWholeFils('cashRefundedFils', takings.cashRefundedFils)
  assertWholeFils('dropsFils', takings.dropsFils)
  if (takings.changeGivenFils > takings.cashReceivedFils) {
    // The aggregate of `payment_change_not_more_than_tendered` (0068). More change than was ever
    // tendered would make the expected float larger than the cash that entered the drawer, so the
    // discrepancy would measure the mistake in the inputs rather than the state of the till.
    throw new AppError(
      'invariant_violated',
      `Change given (${takings.changeGivenFils} fils) exceeds cash received ` +
        `(${takings.cashReceivedFils} fils). No drawer can hand back more than it took in.`,
      { details: { takings } },
    )
  }
  return (
    takings.openingFloatFils +
    takings.cashReceivedFils -
    takings.changeGivenFils -
    takings.cashRefundedFils -
    takings.dropsFils
  )
}

/** The direction a discrepancy points. Derived from the sign so the two cannot disagree. */
export function drawerDirection(discrepancyFils: number): DrawerDirection {
  if (discrepancyFils === 0) return 'balanced'
  return discrepancyFils > 0 ? 'over' : 'short'
}

/**
 * The reconciliation: the expectation, the count, and the signed difference between them.
 *
 * `counted` is `undefined` when nobody counted, and that is the {@link CountRequired} case rather than a
 * zero: a zero count is an empty drawer, which is a fact, and no count at all is the absence of one.
 * Treating the two alike is how a close with no count comes to report the float as missing.
 */
export function reconcileDrawer(
  takings: DrawerTakings,
  counted: Money | undefined,
  context: { readonly drawerCode: string; readonly businessDay: LocalDate },
): DrawerReconciliation {
  if (counted === undefined) {
    throw new CountRequired(context.drawerCode, context.businessDay)
  }
  assertWholeFils('countedFloatFils', counted.fils)
  if (counted.fils < 0) {
    throw new AppError(
      'validation',
      `A counted float of ${counted.fils} fils is not a count. A drawer holds no negative cash; an ` +
        'expected figure larger than the count is a SHORT drawer, which is the discrepancy, not the ' +
        'count.',
      { details: { counted: counted.fils } },
    )
  }
  const expectedFils = expectedFloat(takings)
  const discrepancyFils = counted.fils - expectedFils
  return Object.freeze({
    takings: Object.freeze({ ...takings }),
    expectedFils,
    countedFils: counted.fils,
    discrepancyFils,
    direction: drawerDirection(discrepancyFils),
  })
}

export interface CashUpPostingInput {
  readonly entryId: EntryId
  /** The session's business day. The discrepancy is a fact about that shift, so it posts on it. */
  readonly businessDay: LocalDate
  readonly drawerCode: string
  /** The drawer's own cash account, from `cash_drawer.posting_account_code`. Usually `1010`. */
  readonly drawerAccount: AccountCode
  readonly reconciliation: DrawerReconciliation
  /** Why the drawer was out. Mandatory upstream; carried onto the lines so the entry reads alone. */
  readonly countNote: string
  readonly narrative?: string
}

/**
 * The entry a close posts for a non-zero discrepancy.
 *
 * ```
 *   short:  Dr 6140 Cash over and short   |d|      Cr <drawer account>  |d|
 *   over:   Dr <drawer account>            d       Cr 6140               d
 * ```
 *
 * A SHORT drawer is a loss, so `6140` is debited and the drawer account credited down to what is
 * physically there. An OVER drawer is the mirror. The side is derived from the sign of the discrepancy
 * and never passed in: a posting on the wrong side balances exactly as well and states the opposite of
 * what happened, which is the one error in a cash-up that reconciles.
 *
 * The drawer's account comes from the registry rather than being assumed to be `1010`, so a float kept in
 * the safe (`1015`) is not written off against the till's balance.
 *
 * `source` is `'cash_up'`, which already exists in `EntrySource`. It is what tells this entry from a
 * refund when somebody asks in six months: the two can produce identical lines.
 */
export function cashUpPosting(input: CashUpPostingInput, chart: ChartOfAccounts): JournalEntry {
  const { discrepancyFils } = input.reconciliation
  if (discrepancyFils === 0) {
    throw new DrawerBalances(input.drawerCode, input.businessDay, input.reconciliation.countedFils)
  }
  if (input.countNote.trim().length === 0) {
    // The sentence is the only part of a cash-up a person wrote, and `ZU004`'s sibling CHECK
    // (`cash_session_variance_needs_a_reason`) refuses the row without it. Refused here too, so the
    // failure arrives before a journal entry has been built rather than at COMMIT.
    throw new AppError(
      'validation',
      `The drawer "${input.drawerCode}" is out by ${discrepancyFils} fils on business day ` +
        `${input.businessDay} and carries no reason. A discrepancy nobody explained is a discrepancy ` +
        'nobody investigated.',
      { details: { drawerCode: input.drawerCode, discrepancyFils } },
    )
  }

  const amount: Money = money(filsFrom(Math.abs(discrepancyFils)))
  const short = discrepancyFils < 0
  const memo =
    `Drawer "${input.drawerCode}" ${short ? 'short' : 'over'} by ${Math.abs(discrepancyFils)} fils: ` +
    input.countNote
  const lines: EntryLineDraft[] = short
    ? [debit(CASH_OVER_SHORT_ACCOUNT, amount, memo), credit(input.drawerAccount, amount, memo)]
    : [debit(input.drawerAccount, amount, memo), credit(CASH_OVER_SHORT_ACCOUNT, amount, memo)]

  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.businessDay,
    narrative:
      input.narrative ??
      `Cash-up ${input.businessDay} drawer "${input.drawerCode}": counted ` +
        `${input.reconciliation.countedFils} against expected ${input.reconciliation.expectedFils} ` +
        `fils, ${short ? 'short' : 'over'} by ${Math.abs(discrepancyFils)}`,
    source: 'cash_up',
    lines,
  }
  return postEntry(draft, chart)
}

export interface CashDropPostingInput {
  readonly entryId: EntryId
  /** The business day the drop happened on — the session's, because a drop is inside a shift. */
  readonly businessDay: LocalDate
  readonly drawerCode: string
  readonly drawerAccount: AccountCode
  /** `1020 Bank current` for a banking, `1015 Petty cash float` for the safe. */
  readonly destinationAccount: AccountCode
  readonly amount: Money
  readonly reason: string
  readonly narrative?: string
}

/**
 * The entry a mid-shift drop posts: `Dr destination / Cr <drawer account>`.
 *
 * Its own entry, at the time of the drop, rather than a line folded into the close. `1010` is debited by
 * every cash payment as the payment is taken (0068's manual adapter), so a drop that appeared only in the
 * cash-up would leave the drawer account overstated for the rest of the shift — and a trial balance taken
 * mid-shift is exactly when somebody is looking.
 *
 * `source` is `'payout'` and not `'cash_up'`: a drop is not a discrepancy, and `ZU004` requires the
 * session's own entry to be a `cash_up`, so sharing the classification would let a drop satisfy the rule
 * that the variance must be posted.
 */
export function cashDropPosting(input: CashDropPostingInput, chart: ChartOfAccounts): JournalEntry {
  if (input.amount.fils <= 0) throw new NothingToMove('cash drop', input.amount.fils)
  if (input.destinationAccount === input.drawerAccount) {
    throw new AppError(
      'validation',
      `A drop from drawer "${input.drawerCode}" to its own account ${input.drawerAccount} moves ` +
        'nothing and would post a self-cancelling pair of lines that still balances.',
      { details: { drawerCode: input.drawerCode, account: input.drawerAccount } },
    )
  }
  const memo = `Drop from drawer "${input.drawerCode}": ${input.reason}`
  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.businessDay,
    narrative:
      input.narrative ??
      `Cash drop ${input.businessDay} drawer "${input.drawerCode}": ${input.amount.fils} fils to ` +
        input.destinationAccount,
    source: 'payout',
    lines: [
      debit(input.destinationAccount, input.amount, memo),
      credit(input.drawerAccount, input.amount, memo),
    ],
  }
  return postEntry(draft, chart)
}

export interface CashSessionCorrectionInput {
  readonly entryId: EntryId
  /**
   * The business day the CORRECTION posts on, which is not the session's.
   *
   * A discrepancy found on Tuesday against Saturday's drawer is Tuesday's entry, because Saturday may be
   * filed. `earliest_open_date_from()` (0073) is the one definition of where it may go, so this module
   * takes the date rather than computing it — a pure mirror of that function would be a second answer.
   */
  readonly businessDay: LocalDate
  readonly drawerCode: string
  readonly drawerAccount: AccountCode
  /** The session being corrected, for the narrative. Its own business day, for the same. */
  readonly correctsBusinessDay: LocalDate
  /**
   * Signed, in fils. POSITIVE means the drawer held MORE than the close recorded — so the correction
   * debits the drawer and credits `6140` back, reducing the loss the cash-up wrote off.
   */
  readonly amountFils: number
  readonly reason: string
  readonly narrative?: string
}

/**
 * The entry a correction to a CLOSED session posts, dated on its own business day.
 *
 * A closed session cannot be reopened (`ZU002`), so this is the remedy: a new dated entry, with a
 * `cash_session_adjustment` row beside it. The same shape a credit note has to an invoice (0072) and a
 * dated reversal has to a filed period (0073).
 *
 * `source` is `'adjustment'` rather than `'cash_up'` for two reasons, and the second is enforced: a
 * correction is not a count, and `ZU004` matches the session's own entry on `source = 'cash_up'`, so an
 * adjustment classified that way could be mistaken for the cash-up the variance rule is about.
 */
export function cashSessionCorrection(
  input: CashSessionCorrectionInput,
  chart: ChartOfAccounts,
): JournalEntry {
  if (input.amountFils === 0) throw new NothingToMove('cash session correction', input.amountFils)
  assertWholeFils('amountFils', input.amountFils)
  if (input.reason.trim().length === 0) {
    throw new AppError(
      'validation',
      `A correction to the "${input.drawerCode}" drawer's count for ${input.correctsBusinessDay} ` +
        'carries no reason. A correction nobody can review is not evidence.',
      { details: { drawerCode: input.drawerCode } },
    )
  }
  const amount: Money = money(filsFrom(Math.abs(input.amountFils)))
  const more = input.amountFils > 0
  const memo =
    `Correction to the ${input.correctsBusinessDay} count of drawer "${input.drawerCode}": ` +
    input.reason
  const lines: EntryLineDraft[] = more
    ? [debit(input.drawerAccount, amount, memo), credit(CASH_OVER_SHORT_ACCOUNT, amount, memo)]
    : [debit(CASH_OVER_SHORT_ACCOUNT, amount, memo), credit(input.drawerAccount, amount, memo)]
  const draft: EntryDraft = {
    entryId: input.entryId,
    entryDate: input.businessDay,
    narrative:
      input.narrative ??
      `Cash-up correction posted ${input.businessDay} for the ${input.correctsBusinessDay} count of ` +
        `drawer "${input.drawerCode}": ${more ? '+' : '-'}${Math.abs(input.amountFils)} fils`,
    source: 'adjustment',
    lines,
  }
  return postEntry(draft, chart)
}

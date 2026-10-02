/**
 * The chargeback, as a dated event with its own effect on the ledger (Y-PAY-08).
 *
 * ## A chargeback is a third party's decision arriving late
 *
 * The acquirer takes the money back, and tells the business afterwards — sometimes weeks afterwards, and
 * sometimes about a trading day that has already been cashed up, reported and filed. So the one thing a
 * chargeback must never be is an EDIT to the original payment. `payment_intent.captured_fils` is a
 * projection of the append-only transaction rows and `ZY163` holds the two equal; reducing it would
 * restate a capture that happened, and the sale's own entry would then explain money that the header says
 * was never taken.
 *
 * It is therefore a ROW with its own `received_at`, its own `trading_date`, and its own journal entry.
 * The original entry is untouched, which is ADR 0017's rule and `pnpm no-invoice-mutation`'s subject one
 * table along.
 *
 * ## Why a clearing account and not an expense
 *
 * When the money is taken, the business has not lost it — it has lost the use of it while somebody else
 * decides. Posting straight to an expense would recognise a loss that may be reversed next month, and
 * posting nowhere at all would leave `1030 Gateway clearing` carrying money the acquirer has removed.
 *
 * So the received chargeback moves the amount out of `1030` and into `1045 Disputed card receipts`: an
 * asset the business claims and may not get. Then exactly one of two things happens, and the partition is
 * total by construction so `1045` cannot hold a balance for ever:
 *
 *   - **won.** The claim stood. The entry is the dated REVERSAL of the received entry, so the net effect
 *     on the ledger is nought to the fils and `1045` returns to zero. {@link chargebackNetEffectFils} is
 *     that claim as arithmetic.
 *   - **lost.** The money is gone. `1045` is credited and `6150 Bad debt` is debited, which is where an
 *     amount the business is owed and will not receive belongs.
 *
 * ## Every function here is pure and takes its date as an argument
 *
 * `packages/core` reads no clock, and here it is load-bearing rather than tidy: `resolveTradingDate` is
 * what decides whether a chargeback received at 01:30 belongs to the previous trading date, and a second
 * opinion about the instant would move a dispute between business days — and therefore between a cash-up
 * that has been signed and one that has not.
 */
import { AppError } from '@berelax/shared'
import type { HoursForDate } from '../business-day/resolve.ts'
import { resolveTradingDate } from '../business-day/resolve.ts'
import type { Fils, Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import type { Instant, LocalDate, TimeZone } from '../time.ts'
import type { ChartOfAccounts } from './chart-of-accounts.ts'
import { ACCOUNTS } from './chart-of-accounts.ts'
import type { EntryId, JournalEntry } from './entry.ts'
import { credit, debit, postEntry } from './entry.ts'
import { reverseEntry } from './reverse.ts'

/**
 * The account a disputed card receipt sits in while a third party decides.
 *
 * Named here as well as in `ACCOUNTS` for `DEPOSIT_LIABILITY_ACCOUNT`'s reason one subject along: the
 * three entry builders below all read this one binding, so moving the dispute to a different account is a
 * one-line change with one test to update rather than a search for `'1045'`.
 */
export const CHARGEBACK_CLEARING_ACCOUNT = ACCOUNTS.disputedCardReceipts

/** Where a lost dispute lands. An amount the business is owed and will not receive. */
export const CHARGEBACK_LOSS_ACCOUNT = ACCOUNTS.badDebt

/**
 * The three things that can happen, exhaustively.
 *
 * `received` is not a state the dispute stays in: every `received` is eventually `won` or `lost`, and
 * `ZY434` in migration 0135 refuses a resolution with no `received` before it and a second resolution
 * after one. The partition being total is what stops `1045` accumulating a balance nobody can explain.
 */
export const CHARGEBACK_KINDS = ['received', 'won', 'lost'] as const
export type ChargebackKind = (typeof CHARGEBACK_KINDS)[number]

/** A chargeback event, as the ledger needs it. */
export interface ChargebackEvent {
  readonly entryId: EntryId
  /** The business day the event belongs to. From {@link chargebackTradingDate}, never from a clock. */
  readonly entryDate: LocalDate
  /** The intent whose capture is disputed. Carried in the narrative, never used to edit that intent. */
  readonly intentRef: string
  /** The acquirer's own identifier for the dispute, so two notices about one dispute are one dispute. */
  readonly disputeRef: string
  readonly amountFils: number
}

function assertAmount(amountFils: number, what: string): Money {
  if (!Number.isInteger(amountFils) || amountFils <= 0) {
    throw new AppError(
      'validation',
      `${what}: ${amountFils} fils is not a disputed amount. Money is integer fils (ADR 0007), and a ` +
        'dispute over nothing is not a dispute — a zero here would post a balanced entry that moved no ' +
        'money and leave a row claiming a dispute exists.',
      { details: { amountFils } },
    )
  }
  return money(filsFrom(amountFils))
}

/**
 * The entry for a chargeback the acquirer has taken.
 *
 * Debit `1045`, credit `1030`. The money has left the gateway balance and the business now holds a claim
 * instead — which is the honest statement of the position and is why neither side of this entry touches
 * revenue, output VAT or the original sale. A chargeback is not a cancelled sale: the treatment was
 * delivered and the invoice stands. Whether the business keeps the money is somebody else's decision.
 *
 * `source: 'adjustment'`. Not `'refund'`, which would make a dispute indistinguishable from money the
 * business chose to give back — and those are answered differently when a customer asks, which is the
 * reason `EntrySource` exists at all.
 */
export function chargebackReceivedEntry(
  event: ChargebackEvent,
  chart: ChartOfAccounts,
): JournalEntry {
  const amount = assertAmount(event.amountFils, 'chargebackReceivedEntry')
  return postEntry(
    {
      entryId: event.entryId,
      entryDate: event.entryDate,
      narrative:
        `Chargeback received on dispute ${event.disputeRef} against payment ${event.intentRef}. ` +
        'The acquirer has taken the amount back pending its decision; the invoice stands and no ' +
        'revenue is reversed.',
      source: 'adjustment',
      lines: [
        debit(CHARGEBACK_CLEARING_ACCOUNT, amount, `Disputed: ${event.disputeRef}`),
        credit(ACCOUNTS.gatewayClearing, amount, `Withdrawn by acquirer: ${event.disputeRef}`),
      ],
    },
    chart,
  )
}

/**
 * The entry for a dispute the business WINS. **A dated reversal, and nothing re-derived.**
 *
 * `reverseEntry` and not a hand-built mirror, which is the whole reason that function exists: debits and
 * credits swap and the absolute fils are untouched, so a reversal cannot round differently from the
 * original and leave a residue nobody can trace. A hand-built "credit 1045, debit 1030" would be correct
 * today and would be the place the two amounts drifted the day a partial dispute resolution existed.
 *
 * The date is the day the DECISION arrived, not the day the chargeback did. `reverseEntry` refuses a
 * reversal dated before its original (`BackdatedReversal`), which is the right refusal: a decision cannot
 * arrive before the event it is about, and a reversal backdated into a closed period is the failure ADR
 * 0017 exists to prevent.
 */
export function chargebackWonEntry(
  received: JournalEntry,
  on: LocalDate,
  options: { readonly entryId?: EntryId; readonly disputeRef?: string } = {},
): JournalEntry {
  return reverseEntry(received, on, {
    ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
    narrative:
      `Chargeback won${options.disputeRef === undefined ? '' : ` on dispute ${options.disputeRef}`}: ` +
      `reversal of ${received.entryId}. The acquirer returned the amount, so the disputed receipt is ` +
      'unwound to net zero.',
  })
}

/**
 * The entry for a dispute the business LOSES.
 *
 * Credit `1045`, debit `6150 Bad debt`. The claim is extinguished and the amount is an amount the
 * business was owed and will not receive, which is what that account is for. Not a reversal: a reversal
 * would say the chargeback never happened, and it did.
 *
 * Not `4095 Discounts and allowances` either, and the distinction is the one an accountant would ask
 * about: an allowance is something the business GRANTED. A lost dispute is a loss imposed on it.
 */
export function chargebackLostEntry(event: ChargebackEvent, chart: ChartOfAccounts): JournalEntry {
  const amount = assertAmount(event.amountFils, 'chargebackLostEntry')
  return postEntry(
    {
      entryId: event.entryId,
      entryDate: event.entryDate,
      narrative:
        `Chargeback lost on dispute ${event.disputeRef} against payment ${event.intentRef}. The claim ` +
        'is extinguished and the amount is written off; the invoice and its revenue are unchanged.',
      source: 'adjustment',
      lines: [
        debit(CHARGEBACK_LOSS_ACCOUNT, amount, `Dispute lost: ${event.disputeRef}`),
        credit(CHARGEBACK_CLEARING_ACCOUNT, amount, `Claim extinguished: ${event.disputeRef}`),
      ],
    },
    chart,
  )
}

/**
 * The net movement on `1045` across a sequence of a dispute's entries.
 *
 * Nought for a won dispute, to the fils, and the acceptance line asks for exactly that. Expressed as a
 * sum over the LINES rather than as a comparison of two amounts, so it is the ledger's own answer: a pair
 * of entries that balanced individually while moving different amounts on this account would be caught,
 * and that is the only way the identity can fail.
 */
export function chargebackNetEffectFils(entries: readonly JournalEntry[]): number {
  let net = 0
  for (const entry of entries) {
    for (const line of entry.lines) {
      if (line.account !== CHARGEBACK_CLEARING_ACCOUNT) continue
      net += (line.debitFils as number) - (line.creditFils as number)
    }
  }
  return net
}

/** A chargeback that cannot be attributed to a trading date. ADR 0070: a refusal, never a zero. */
export class ChargebackIsOutsideTrading extends AppError {
  constructor(disputeRef: string, reason: string, calendarDate: string) {
    super(
      'conflict',
      `ChargebackIsOutsideTrading: dispute "${disputeRef}" arrived at an instant that belongs to no ` +
        `trading date (${reason}, calendar date ${calendarDate}). It is REFUSED rather than attributed ` +
        'to the calendar date, because a chargeback filed against a day the premises did not trade is a ' +
        'figure in a cash-up that nothing produced — and a date substituted here would reconcile ' +
        'perfectly against the wrong day (ADR 0070). An acquirer’s notice can arrive at any hour, ' +
        'so the remedy is a stated decision about which business day a notice outside trading belongs ' +
        'to, not a fallback chosen in this function.',
      { details: { disputeRef, reason, calendarDate } },
    )
  }
}

/**
 * The trading date a chargeback belongs to, or a refusal.
 *
 * **This is the acceptance line "a chargeback received at 01:30 resolves to the previous trading date".**
 * It is `resolveTradingDate` and nothing else — no arithmetic of its own — because the whole point of
 * that primitive is that trading runs 11:00 to 02:00 and 01:30 is inside the PREVIOUS day's session. A
 * chargeback attributed to the calendar date would land in a cash-up for a day whose session had not
 * started, and the two days' card totals would both be wrong by the same amount in opposite directions.
 *
 * The refusal on `outside_trading` is the ADR 0070 reading and is deliberately not a fallback. Of the two
 * available errors only one is detectable afterwards: a refusal stops the import and names the notice,
 * and a substituted date reconciles against a day nothing happened on.
 */
export function chargebackTradingDate(input: {
  readonly disputeRef: string
  readonly receivedAt: Instant
  readonly hoursFor: HoursForDate
  readonly zone?: TimeZone
}): LocalDate {
  const resolution =
    input.zone === undefined
      ? resolveTradingDate(input.receivedAt, input.hoursFor)
      : resolveTradingDate(input.receivedAt, input.hoursFor, input.zone)
  if (resolution.kind !== 'trading') {
    throw new ChargebackIsOutsideTrading(
      input.disputeRef,
      resolution.reason,
      resolution.calendarDate as string,
    )
  }
  return resolution.date
}

/**
 * What a dispute has taken, NET of what was won back.
 *
 * The figure `RefundablePosition.chargedBackFils` wants, derived from the kinds rather than from a stored
 * total — which is ADR 0057's shape and the reason `ZY433` recomputes it in SQL rather than reading a
 * column. A `lost` dispute leaves the money gone and so does an unresolved one; only a `won` one gives it
 * back, and the two unresolved and lost cases must count the same way, because "we might get it back" is
 * not money the business can refund to somebody else in the meantime.
 */
export function chargedBackNetFils(
  events: readonly { readonly kind: ChargebackKind; readonly amountFils: number }[],
): Fils {
  let net = 0
  for (const event of events) {
    if (event.kind === 'received') net += event.amountFils
    else if (event.kind === 'won') net -= event.amountFils
  }
  // Clamped for `refundableFils`'s reason: a `won` without its `received` is a repaired database, and a
  // negative here would publish as "more refundable than was ever captured".
  return filsFrom(net > 0 ? net : 0)
}

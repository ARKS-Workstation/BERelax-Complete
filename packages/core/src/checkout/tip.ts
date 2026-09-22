import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import type { Money } from '../money.ts'
import type { BasketLineId } from './line.ts'
import { basketLineId, MalformedBasket, requireText } from './line.ts'

/**
 * Tips: money the salon collects and does not earn.
 *
 * A tip is on the basket because the customer hands it over at the same moment as the treatment is paid
 * for, and it is *not* a sale. Two consequences, and both of them are the whole content of this module:
 *
 *   1. **It posts to a liability, never to revenue.** {@link TIP_ACCOUNT} is `2040 Tips payable to
 *      therapists`: the salon owes the money on, so the credit sits with the therapist and not with the
 *      takings. A tip credited to `4010 Treatment revenue` inflates every revenue figure the business
 *      has, overstates the VAT due on it, and then has to be paid out of an account that never received
 *      it.
 *   2. **It carries no VAT.** A voluntary gratuity is not consideration for a supply, so
 *      {@link TipLine.tax} is `null` — not `{ net: 0, vat: 0 }`, which would state a zero-rated supply,
 *      and not `net = gross`, which would put the money in the net turnover it is not part of.
 *
 * `basket.ts` enforces both against the chart of accounts rather than trusting this file: a tip line
 * whose account is not a liability is refused with `account_misclassified`, and gate 67c in
 * `scripts/test-gates.mjs` changes {@link TIP_ACCOUNT} to treatment revenue and watches the property
 * test catch it. The rule only means something if it has been seen to fail.
 *
 * The beneficiary is an **id**, and there is no name field anywhere in this module: a therapist has no
 * display name until an admin sets one (ADR 0020).
 */

/** Where a tip is credited. A liability the salon owes the therapist, not takings. */
export const TIP_ACCOUNT: AccountCode = ACCOUNTS.tipsPayable

export interface TipLine {
  readonly kind: 'tip'
  readonly lineId: BasketLineId
  readonly description: string
  readonly account: AccountCode
  /** What the customer added, gross. Positive, and taxed nowhere. */
  readonly gross: Money
  /**
   * `null`, always — and the type says so, so a line that tries to tax a tip does not compile.
   * Outside the scope of VAT, as distinct from zero-rated. See the module note.
   */
  readonly tax: null
  /** The therapist the tip is for, or `null` when it goes to the pool. An id, never a name. */
  readonly beneficiaryEmployeeId: string | null
}

export interface TipLineInput {
  readonly lineId: string
  readonly gross: Money
  /** Omitted means the pool. */
  readonly beneficiaryEmployeeId?: string
  readonly description?: string
}

export function tipLine(input: TipLineInput): TipLine {
  if (input.gross.fils <= 0) {
    // A zero tip is not a tip, and a negative one is a refund of a tip — a different transaction with a
    // different ledger treatment, which M-TILL-07 owns. Neither may enter as a basket line.
    throw new MalformedBasket(
      'non_positive_amount',
      `a tip of ${input.gross.fils} fils is not a gratuity`,
      { lineId: input.lineId, fils: input.gross.fils },
    )
  }
  return Object.freeze({
    kind: 'tip' as const,
    lineId: basketLineId(input.lineId),
    description:
      input.description === undefined ? 'Gratuity' : requireText(input.description, 'description'),
    account: TIP_ACCOUNT,
    gross: input.gross,
    tax: null,
    beneficiaryEmployeeId:
      input.beneficiaryEmployeeId === undefined
        ? null
        : requireText(input.beneficiaryEmployeeId, 'beneficiaryEmployeeId'),
  })
}

export function isTipLine(line: { readonly kind: string }): line is TipLine {
  return line.kind === 'tip'
}

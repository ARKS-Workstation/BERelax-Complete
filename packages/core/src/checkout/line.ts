import type { Brand } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import type { Money, VatRateBp } from '../money.ts'

/**
 * The vocabulary every basket line shares: its identifiers, its tax shape, and the refusal codes.
 *
 * A separate module from `basket.ts` for one structural reason: `discount.ts` and `tip.ts` both need
 * `BasketLineId`, and `basket.ts` needs both of them. Declaring the ids beside the basket would make
 * that a cycle, and a cycle in a pure domain is the first thing that stops `pnpm boundaries` being
 * able to say anything useful about the direction a dependency runs.
 */

/** Identifies one checkout basket. Allocated outside core — the domain never invents an id. */
export type BasketId = Brand<string, 'BasketId'>

/** Identifies one line within a basket. A discount references its target by this. */
export type BasketLineId = Brand<string, 'BasketLineId'>

/**
 * Everything a basket can refuse for a structural reason, as values.
 *
 * Callers branch on these, never on prose: the till shows a different message for "finish the
 * treatment first" than for "that discount has nowhere to apply", and a string match on the message
 * stops working the first time somebody improves the wording.
 */
export const BASKET_REFUSALS = [
  /** An id or a description arrived blank. A line nobody can identify cannot be reconciled later. */
  'blank_field',
  /** No lines at all. Totals would all be zero, which is indistinguishable from a nil sale. */
  'empty_basket',
  /** Two lines share an id, so a discount's target is ambiguous. */
  'duplicate_line_id',
  /** One appointment appears on two lines — billed once as a charge and once as a redemption. */
  'appointment_billed_twice',
  /** A tip or a charge of zero or less. Zero is a missing amount, not a free one (B-CAT-03). */
  'non_positive_amount',
  /** A discount points at a line id the basket does not contain. */
  'discount_target_missing',
  /** A discount points at a tip, a redemption or another discount. */
  'discount_target_not_chargeable',
  /** A line declares an account whose classification contradicts what the line is. */
  'account_misclassified',
  /** A package redemption line carries an amount. Its value lives on the balance, not here. */
  'redemption_carries_a_price',
] as const

export type BasketRefusal = (typeof BASKET_REFUSALS)[number]

/**
 * Raised when a basket is structurally unusable, before any arithmetic is attempted on it.
 *
 * One class carrying a `refusal` code rather than nine classes, for the reason `TrnNotConfigured`
 * carries a `reason`: the caller's response is chosen from a closed list, and a `catch` that has to
 * name nine types is a `catch` that will name eight.
 */
export class MalformedBasket extends AppError {
  readonly refusal: BasketRefusal

  constructor(refusal: BasketRefusal, message: string, details?: Record<string, unknown>) {
    super('validation', `${refusal}: ${message}`, { details: { refusal, ...details } })
    this.name = 'MalformedBasket'
    this.refusal = refusal
  }
}

/** A non-blank string, or {@link MalformedBasket}. */
export function requireText(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new MalformedBasket('blank_field', `${field} may not be blank`, { field })
  }
  return value
}

export function basketId(value: string): BasketId {
  return requireText(value, 'basketId') as BasketId
}

export function basketLineId(value: string): BasketLineId {
  return requireText(value, 'lineId') as BasketLineId
}

/**
 * One line's tax, or `null` when the line is outside the scope of VAT.
 *
 * `null` is a decision and not an omission, the same distinction `Account.vatBox` makes: a tip and a
 * package redemption are deliberately untaxed on this document, and `{ net: 0, vat: 0 }` would read as
 * a zero-rated *supply* — which is a statement about a taxable transaction and is not what either of
 * them is.
 *
 * `net + vat === gross` holds on every line that has a tax, including a discount line, whose figures
 * are negative.
 */
export interface LineTax {
  readonly net: Money
  readonly vat: Money
  readonly rateBp: VatRateBp
}

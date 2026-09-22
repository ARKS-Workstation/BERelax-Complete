import { AppError } from '@berelax/shared'
import { assertNever } from '../assert-never.ts'
import type { AccountCode } from '../ledger/account.ts'
import { ACCOUNTS } from '../ledger/chart-of-accounts.ts'
import type { Fils, Money, VatRateBp } from '../money.ts'
import { filsFrom, money, roundHalfUp, splitGross, UAE_STANDARD_VAT_BP } from '../money.ts'
import type { BasketLineId } from './line.ts'
import { basketLineId, requireText } from './line.ts'

/**
 * Discounts at the till: an amount, and **why**.
 *
 * ## The reason is not optional and not free text
 *
 * A till that can reduce a price without saying why produces a month-end figure nobody can explain and
 * a control nobody can audit: "revenue is down 4%" has no answer, because goodwill given by a manager,
 * a staff treatment and a campaign are three different facts that arrive as the same number. So the
 * reason is a **closed enum** ({@link DISCOUNT_REASONS}) and it is enforced twice over:
 *
 *   - at compile time, because {@link DiscountLineInput} requires `reason: DiscountReason` — a missing
 *     reason and a reason outside the list are both type errors, proved by the fixtures in
 *     `scripts/test-gates.mjs` (cases 67a and 67b);
 *   - at run time, with {@link DiscountReasonRequired}, because the till's request body is JSON and
 *     arrives as `unknown` however well typed the client was.
 *
 * `note` exists beside the reason and never instead of it. Free text is where a reason code goes to
 * die: it cannot be grouped, and the first person to type "mgr ok" has removed the discount from every
 * report that matters.
 *
 * ## Where a discount posts, and why it is a contra account
 *
 * Every discount line posts to {@link DISCOUNT_ACCOUNT} — `4095 Discounts and allowances`, a **contra
 * revenue** account. Netting the discount off `4010 Treatment revenue` instead would balance exactly as
 * well and would erase the only evidence that a discount was given at all: gross takings and discounts
 * given are two figures, and a single netted number cannot answer how much was discounted this month.
 *
 * ## How much, and on what
 *
 * {@link discountFilsOn} rounds **half-up on the discount** and the caller then subtracts, so the
 * reduced gross is a whole number of fils without a second rounding — the same move `resolvePrice`
 * makes for a promotion, for the same reason. It takes the *running* gross: two discounts on one line
 * compound in declaration order, because two 10% discounts are not 20% off and a till has to be able to
 * say which was applied first.
 *
 * Deriving the tax is `basket.ts`'s job and is deliberately not done here — see
 * {@link vatIfDiscountTaxedSeparately} for the wrong answer this module exists to keep out of the
 * totals.
 */

/**
 * Every reason a price may be reduced at the till. Closed, and closed on purpose.
 *
 * There is no `other`. An `other` bucket is a closed enum with an open door: it absorbs every case
 * nobody wanted to think about, and within a quarter it is the largest category in the report.
 */
export const DISCOUNT_REASONS = [
  /** A manager gave something back to settle a complaint on the spot. */
  'manager_goodwill',
  /** Compensation for a failure in the service that was delivered. */
  'service_recovery',
  /** A staff member, or a staff member's family, at the staff rate. */
  'staff_rate',
  /** An advertised campaign price applied at the desk rather than through the price list. */
  'campaign',
  /** A loyalty entitlement the customer had earned. */
  'loyalty_reward',
  /** A negotiated corporate rate. */
  'corporate_rate',
  /** A competitor's price matched, on the day, for this customer. */
  'price_match',
] as const

export type DiscountReason = (typeof DISCOUNT_REASONS)[number]

/**
 * What each reason means, as data.
 *
 * A `Record` over the union, so a reason added to {@link DISCOUNT_REASONS} and left undescribed fails
 * `pnpm typecheck` naming this file. The prose is not decoration: the same seven labels appear on a
 * report the owner reads, and a label whose meaning lives only in the head of whoever added it is a
 * label that will be used for something else.
 */
export const DISCOUNT_REASON_NOTES: Record<DiscountReason, string> = {
  manager_goodwill: 'Given by a manager to settle a complaint, on the day, at the desk.',
  service_recovery: 'Compensation for a shortfall in the treatment that was delivered.',
  staff_rate: 'The staff or staff-family rate.',
  campaign: 'An advertised campaign price applied at the desk rather than from the price list.',
  loyalty_reward: 'A loyalty entitlement the customer had already earned.',
  corporate_rate: 'A negotiated rate for a corporate account.',
  price_match: "A competitor's price matched for this customer, on this visit.",
}

/**
 * How the reduction is stated.
 *
 * Basis points for a percentage (1000 bp = 10%) and fils for a flat amount — the same two shapes
 * `PromotionLayer` uses, because a till operator and a marketing campaign express a discount the same
 * two ways and a second vocabulary would have to be translated somewhere.
 */
export type DiscountKind = 'percentage_bp' | 'absolute_fils'

/** The contra-revenue account every discount line posts to. */
export const DISCOUNT_ACCOUNT: AccountCode = ACCOUNTS.discountsAndAllowances

/** The amount and the reason, without reference to any particular line. */
export interface DiscountTerms {
  readonly reason: DiscountReason
  readonly kind: DiscountKind
  /** Basis points for `percentage_bp`, fils for `absolute_fils`. A positive integer, always. */
  readonly value: number
  /** What the operator typed, or `null`. Beside the reason code, never instead of it. */
  readonly note: string | null
}

/**
 * A discount as the caller writes it: the terms, and the line it comes off.
 *
 * It carries **no amount**. The figure depends on the running gross of its target, which only
 * `buildBasket` knows, and a caller-supplied amount would be a second opinion about the same
 * multiplication — see `PricedDiscountLine`.
 */
export interface DiscountLine {
  readonly kind: 'discount'
  readonly lineId: BasketLineId
  readonly description: string
  readonly account: AccountCode
  /** The chargeable line this comes off. A discount is never free-floating over a basket. */
  readonly targetLineId: BasketLineId
  readonly terms: DiscountTerms
}

export interface DiscountLineInput {
  readonly lineId: string
  readonly targetLineId: string
  /** From the closed enum. Omitting it is a type error; a value outside the list is a type error. */
  readonly reason: DiscountReason
  readonly kind: DiscountKind
  readonly value: number
  readonly note?: string
  /** What prints on the document. Defaults to the reason's own wording. */
  readonly description?: string
}

/**
 * Raised when a discount arrives without a reason code from {@link DISCOUNT_REASONS}.
 *
 * `validation` and not `invariant_violated`: the caller *can* fix this, by asking the operator which
 * reason applies. The rejected value is carried in `details` because "a discount without a reason" is
 * not enough to find the client that sent `reason: ''`.
 */
export class DiscountReasonRequired extends AppError {
  readonly given: unknown

  constructor(given: unknown) {
    super(
      'validation',
      'DiscountReasonRequired: a discount line must carry a reason code from ' +
        `${DISCOUNT_REASONS.join(', ')} — received ${describe(given)}. A price reduced for no ` +
        'recorded reason is a month-end figure nobody can explain.',
      { details: { given: describe(given), allowed: DISCOUNT_REASONS } },
    )
    this.name = 'DiscountReasonRequired'
    this.given = given
  }
}

/** Raised when a discount would take its line to zero or below. */
export class DiscountExceedsLine extends AppError {
  constructor(lineId: BasketLineId, grossFils: number, discountFils: number) {
    super(
      'invariant_violated',
      `DiscountExceedsLine: ${discountFils} fils off a line of ${grossFils} fils on line ` +
        `"${lineId}" leaves nothing to charge. A full discount is a comp, which is a different ` +
        'transaction with a different ledger treatment, not a sale priced at zero.',
      { details: { lineId, grossFils, discountFils } },
    )
    this.name = 'DiscountExceedsLine'
  }
}

/** Raised when the terms are unusable — before any arithmetic is attempted on them. */
export class MalformedDiscount extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('validation', `MalformedDiscount: ${message}`, { details })
    this.name = 'MalformedDiscount'
  }
}

/** A short, safe rendering of whatever arrived where a reason was expected. */
function describe(given: unknown): string {
  if (typeof given === 'string') return `"${given}"`
  if (given === null) return 'null'
  if (given === undefined) return 'nothing'
  return `a ${typeof given}`
}

export function isDiscountReason(value: unknown): value is DiscountReason {
  return typeof value === 'string' && (DISCOUNT_REASONS as readonly string[]).includes(value)
}

/**
 * The reason, or {@link DiscountReasonRequired}.
 *
 * Takes `unknown` deliberately. Every caller inside the domain is already typed, so this exists for
 * the one that is not: a request body. Narrowing here rather than at the route means the refusal is
 * the same refusal wherever the till is driven from.
 */
export function requireDiscountReason(given: unknown): DiscountReason {
  if (!isDiscountReason(given)) throw new DiscountReasonRequired(given)
  return given
}

export function discountTerms(input: {
  readonly reason: DiscountReason
  readonly kind: DiscountKind
  readonly value: number
  readonly note?: string
}): DiscountTerms {
  const reason = requireDiscountReason(input.reason)
  if (!Number.isInteger(input.value) || input.value <= 0) {
    throw new MalformedDiscount(
      `a discount of ${input.value} is not a reduction. Basis points for percentage_bp, fils for ` +
        'absolute_fils, a positive whole number either way.',
      { kind: input.kind, value: input.value },
    )
  }
  if (input.kind === 'percentage_bp' && input.value > 10_000) {
    throw new MalformedDiscount(
      `${input.value} bp is more than 100%. A discount larger than the price is a refund or a comp.`,
      { kind: input.kind, value: input.value },
    )
  }
  return {
    reason,
    kind: input.kind,
    value: input.value,
    note: input.note === undefined ? null : requireText(input.note, 'note'),
  }
}

/** A discount line, ready to be placed in a basket draft. */
export function discountLine(input: DiscountLineInput): DiscountLine {
  const terms = discountTerms(input)
  return Object.freeze({
    kind: 'discount' as const,
    lineId: basketLineId(input.lineId),
    description:
      input.description === undefined
        ? DISCOUNT_REASON_NOTES[terms.reason]
        : requireText(input.description, 'description'),
    account: DISCOUNT_ACCOUNT,
    targetLineId: basketLineId(input.targetLineId),
    terms,
  })
}

/**
 * The reduction in fils, against the gross the line stands at when this discount is applied.
 *
 * Half-up on the **discount**, then the caller subtracts. Rounding the reduced gross instead would
 * round twice, and the two roundings disagree by a fils on about a third of real prices.
 */
export function discountFilsOn(terms: DiscountTerms, runningGross: Money): Fils {
  switch (terms.kind) {
    case 'percentage_bp':
      return filsFrom(roundHalfUp((runningGross.fils * terms.value) / 10_000))
    case 'absolute_fils':
      return filsFrom(terms.value)
    default:
      return assertNever(terms.kind, 'discountFilsOn kind')
  }
}

/**
 * The VAT a basket would carry if a discount line were taxed on its own gross. **Never store this.**
 *
 * Exported for one reason: a test that asserts "the basket's VAT is 0" proves nothing unless it also
 * knows what the wrong method answers. This names that number.
 *
 * The wrong method is the obvious one — `splitGross(lineGross).vat + splitGross(-discount).vat`, each
 * line taxed on its own figure like any other pair of lines. It is wrong because the two roundings do
 * not cancel: a line of 11 fils discounted by 5 gives `1 + 0 = 1`, while the 6 fils actually charged
 * carries `6 - round(6 * 20 / 21) = 6 - 6 = 0`. One fils of output VAT on an amount the customer was
 * never charged is tax on the **pre-discount** price, which is the defect this whole module is arranged
 * to make unreachable: `basket.ts` derives the discount line's VAT as the *difference* between the
 * tax on the gross before and the tax on the gross after, so the total is the tax on what was charged,
 * exactly, for every input.
 */
export function vatIfDiscountTaxedSeparately(
  lineGross: Money,
  discount: Money,
  rateBp: VatRateBp = UAE_STANDARD_VAT_BP,
): Money {
  const onGross = splitGross(lineGross, rateBp).vat
  const onDiscount = splitGross(money(filsFrom(-Math.abs(discount.fils))), rateBp).vat
  return money(filsFrom(onGross.fils + onDiscount.fils), lineGross.currency)
}

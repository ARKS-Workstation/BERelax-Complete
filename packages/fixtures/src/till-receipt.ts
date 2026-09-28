import type { AppointmentBillingSnapshot, Basket, BasketId } from '@berelax/core'
import {
  buildBasket,
  discountLine,
  filsFrom,
  isDiscountLine,
  isRedemptionLine,
  isServiceLine,
  isTipLine,
  money,
  packageRedemptionLine,
  STANDARD_SPA_CHART,
  serviceLineFromAppointment,
  tipLine,
} from '@berelax/core'

/**
 * The seeded till receipt: one basket carrying all four line kinds (M-TILL-13).
 *
 * The acceptance line is "one seeded receipt fixture contains a tip, a discount with reason, a package
 * redemption and a split tender, and the journal entry for it balances to zero". Three of those four are LINES
 * and belong in a pure builder, which is this; the split tender and the journal are the transaction's, in
 * `till-receipt.itest.ts`.
 *
 * ## Why the document is a SIMPLIFIED invoice, in SIMPL-INV
 *
 * Two independent reasons agree, which is the only comfortable way to choose a numbering series:
 *
 *   - **The rule chooses it.** `requireInvoiceForm` in `@berelax/core` picks the form from the document total
 *     and whether a customer is NAMED ON THE DOCUMENT. This basket is a counter sale: the gross is far below
 *     the AED 10,000 provisional threshold and `basket.customerId` is null, so the answer is
 *     `simplified_invoice`. The package entitlement still belongs to a named customer — an entitlement has to
 *     belong to somebody — and that is not a contradiction: a simplified invoice is precisely the form that
 *     states no customer.
 *   - **Nothing asserts a counter over it.** M-TILL-10's recorded defect 9: its fixture issued into `TAX-INV`
 *     and left the document there, `invoice` refuses DELETE for every role, and
 *     `checkout-finalise.itest.ts` asserts `document_series.next_number = max(invoice.number) + 1` for
 *     `TAX-INV` — so a leaked document broke a test in a file it never touched, and the only thing hiding it
 *     was integration-suite ordering. `SIMPL-INV` has no such assertion anywhere in the repository (measured:
 *     the only `next_number` assertion is the one above). The itest truncates the invoice family in `afterAll`
 *     as well, so the series is a decision and the cleanup is a second line of defence rather than the only
 *     one.
 */

/** A gratuity of AED 15.00. Outside the scope of VAT and on no tax invoice. */
export const TILL_RECEIPT_TIP_FILS = 1_500
/** A discount of AED 20.00, off the charged treatment, with a reason the enum names. */
export const TILL_RECEIPT_DISCOUNT_FILS = 2_000
export const TILL_RECEIPT_DISCOUNT_REASON = 'service_recovery' as const

export interface TillReceiptBasketInput {
  readonly basketId: BasketId
  /** The treatment the customer pays for at the desk. */
  readonly charged: AppointmentBillingSnapshot
  /** The treatment an entitlement covers. Its gross on the basket is zero, by design. */
  readonly redeemedAppointmentId: string
  /** The `package_balance` row the redemption draws down. */
  readonly redeemedBalanceId: string
}

/**
 * The basket the receipt is rendered from: a charged treatment, a discount that says why, a gratuity, and a
 * package redemption.
 *
 * `customerId: null` on purpose — see the module note. Every figure comes out of `@berelax/core`:
 * `serviceLineFromAppointment` reconciles the snapshot against its own net and VAT, `discountLine` refuses a
 * discount with no reason, `tipLine` refuses a non-positive gratuity, `packageRedemptionLine` carries no price
 * at all, and `buildBasket` applies the discount and sums the charges.
 */
export function tillReceiptBasket(input: TillReceiptBasketInput): Basket {
  return buildBasket(
    {
      basketId: input.basketId,
      customerId: null,
      lines: [
        serviceLineFromAppointment('receipt-service', input.charged),
        discountLine({
          lineId: 'receipt-discount',
          targetLineId: 'receipt-service',
          reason: TILL_RECEIPT_DISCOUNT_REASON,
          kind: 'absolute_fils',
          value: TILL_RECEIPT_DISCOUNT_FILS,
          note: 'The room was cold at the start of the treatment',
        }),
        tipLine({ lineId: 'receipt-tip', gross: money(filsFrom(TILL_RECEIPT_TIP_FILS)) }),
        packageRedemptionLine({
          lineId: 'receipt-redemption',
          appointmentId: input.redeemedAppointmentId,
          redeemedBalanceId: input.redeemedBalanceId,
          redeemedUnits: 1,
        }),
      ],
    },
    STANDARD_SPA_CHART,
  )
}

/** Which of the four kinds a basket actually holds. Counted, so "contains all four" is a measurement. */
export interface TillReceiptKindCensus {
  readonly service: number
  readonly discount: number
  readonly tip: number
  readonly redemption: number
}

export function tillReceiptKinds(basket: Basket): TillReceiptKindCensus {
  return {
    service: basket.lines.filter((line) => isServiceLine(line)).length,
    discount: basket.lines.filter((line) => isDiscountLine(line)).length,
    tip: basket.lines.filter((line) => isTipLine(line)).length,
    redemption: basket.lines.filter((line) => isRedemptionLine(line)).length,
  }
}

/**
 * Throws unless the basket holds all four kinds.
 *
 * A function rather than four assertions in one test, so the gate can break the builder and watch this fire —
 * and so the census is a number rather than a `toContain`, which would pass for a basket holding one line of
 * each kind twice and none of another.
 */
export function assertTillReceiptCarriesEveryKind(basket: Basket): TillReceiptKindCensus {
  const census = tillReceiptKinds(basket)
  const missing = Object.entries(census)
    .filter(([, count]) => count === 0)
    .map(([kind]) => kind)
  if (missing.length > 0) {
    throw new Error(
      `The seeded receipt basket is missing ${missing.join(', ')}; the acceptance line names all four ` +
        `(census ${JSON.stringify(census)})`,
    )
  }
  return census
}

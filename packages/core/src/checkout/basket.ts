import { AppError } from '@berelax/shared'
import type { Account, AccountCode, AccountType } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, accountFor } from '../ledger/chart-of-accounts.ts'
import type { AppointmentStatus } from '../lifecycle/transitions.ts'
import { APPOINTMENT_STATUS_ACTIONS, APPOINTMENT_STATUSES } from '../lifecycle/transitions.ts'
import type { Money, VatRateBp } from '../money.ts'
import { add, filsFrom, money, splitGross, sum, ZERO_AED } from '../money.ts'
import type { PriceListId, PromotionId } from '../pricing/resolve-price.ts'
import type { DiscountLine } from './discount.ts'
import {
  DiscountExceedsLine,
  discountFilsOn,
  MalformedDiscount,
  requireDiscountReason,
} from './discount.ts'
import type { BasketId, BasketLineId, LineTax } from './line.ts'
import { basketLineId, MalformedBasket, requireText } from './line.ts'
import type { TipLine } from './tip.ts'
import { isTipLine } from './tip.ts'

/**
 * The checkout basket: what is being paid for, at the prices that were agreed.
 *
 * Pure. No clock, no I/O, no framework, and nothing here reads a price: every figure arrives from a
 * snapshot the caller already holds. `scripts/check-core-purity.mjs` additionally forbids `Date` and
 * `Intl` under this directory — the basket needs no date at all, and the one that matters (the tax
 * point) is resolved from `business_day` by `resolveTaxPoint`, which is a different unit's job.
 *
 * ## The snapshot is copied, never re-resolved
 *
 * A basket line built from a completed appointment **copies** `appointment.gross_price_fils` and the
 * net and VAT stored beside it. It does not call `resolvePrice`, does not read `service_variant`, and
 * does not re-derive the split from the gross. The price the customer agreed was settled when the
 * booking was taken (B-AVAIL-06 snapshots it, exactly so that this can be a copy), and a price rise
 * published on Monday must not restate a treatment delivered on Sunday — nor an invoice already filed.
 * `packages/fixtures/src/checkout-snapshot.itest.ts` changes `service_variant.gross_price_fils` between
 * the snapshot and the checkout and asserts the basket and the issued document are unchanged, with the
 * new price named as the figure that must appear on neither.
 *
 * Re-deriving net and VAT from the snapshotted gross is refused for the same reason and it is a
 * narrower point worth stating: the derivation is `splitGross`, the rounding rule is `half_up`, and if
 * either ever changes, a basket that re-derives would restate a figure that has already been quoted,
 * invoiced and filed. What is checked instead is the invariant that cannot drift — `net + vat === gross`
 * — which is also what `appointment_price_split_exact` checks in the database, so the copy is safe
 * because both ends agree on the one thing that matters.
 *
 * ## Four kinds of line, and the three that are not a sale
 *
 *   - `service` — a treatment delivered, at its snapshotted gross, on a **revenue** account.
 *   - `discount` — a reduction with a reason code, on the **contra revenue** account, carrying a
 *     negative gross. See `discount.ts`.
 *   - `tip` — money collected and not earned, on a **liability** account, outside the scope of VAT.
 *     See `tip.ts`.
 *   - `package_redemption` — a treatment already paid for, so its gross is **zero** and it carries the
 *     balance id it consumed. See {@link packageRedemptionLine}.
 *
 * Every line declares the account it posts to, and {@link buildBasket} checks each one against the
 * chart of accounts (M-TILL-01) rather than trusting the constructor that built it. That is what makes
 * "a tip never lands in a revenue account" a property of the basket instead of a convention about tip
 * lines, and it is why the property test can be broken by editing `tip.ts` — gate 67c does exactly that
 * and watches the test fail.
 *
 * ## How the VAT on a discounted line is derived, and the answer that is wrong
 *
 * The tax on a discount line is the **difference** between the tax on the line's gross before the
 * discount and the tax on the gross after it. Written that way, the basket's VAT total is the tax on
 * what was actually charged — exactly, for every input — while the service line keeps the snapshotted
 * gross it was sold at. Taxing the discount on its own gross instead is the one-line change this
 * arrangement exists to prevent: it leaves output VAT on an amount the customer never paid. The wrong
 * figure has a name, `vatIfDiscountTaxedSeparately`, so a test can assert it appears nowhere.
 */

// --- the appointment snapshot --------------------------------------------------------------------

/**
 * What the till reads off a completed appointment, and all it may read.
 *
 * Every money field is a snapshot. `priceListId` and `promotionId` are carried through because they
 * are the two fields a disputed figure is settled with a year later, and `null` there means
 * "considered, did not apply" — the distinction `ResolvedPrice` makes and the appointment stores.
 */
export interface AppointmentBillingSnapshot {
  readonly appointmentId: string
  readonly serviceVariantId: string
  readonly status: AppointmentStatus
  /** What the customer was told they were buying, as it was worded then. A snapshot, not a join. */
  readonly description: string
  /** VAT-inclusive and authoritative (ADR 0007). Copied, never recomputed. */
  readonly gross: Money
  readonly net: Money
  readonly vat: Money
  readonly vatRateBp: VatRateBp
  readonly priceListId: PriceListId | null
  readonly promotionId: PromotionId | null
  /** Where the takings belong. `4010 Treatment revenue` unless the caller states otherwise. */
  readonly revenueAccount?: AccountCode
}

/**
 * The statuses a basket line may be built from, derived from B-LIFE-01's table rather than restated.
 *
 * It is `['completed']`, and it is read from `APPOINTMENT_STATUS_ACTIONS[status].emitsRevenue` so that
 * the till and the lifecycle cannot come to disagree about which state is money. docs/03 §2: "COMPLETED
 * is what emits revenue events, not CONFIRMED — booking value is a guess, the till knows the truth."
 */
export const BILLABLE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = Object.freeze(
  APPOINTMENT_STATUSES.filter((status) => {
    const action = APPOINTMENT_STATUS_ACTIONS[status]
    return action.reachable && action.emitsRevenue
  }),
)

/** Raised when a basket line is built from an appointment that has not been delivered. */
export class AppointmentNotBillable extends AppError {
  readonly status: AppointmentStatus

  constructor(appointmentId: string, status: AppointmentStatus) {
    super(
      'invariant_violated',
      `AppointmentNotBillable: appointment "${appointmentId}" is ${status}, and only ` +
        `${BILLABLE_APPOINTMENT_STATUSES.join(', ')} may be charged for. A booking that has not ` +
        'happened is a guess about money.',
      { details: { appointmentId, status, billable: BILLABLE_APPOINTMENT_STATUSES } },
    )
    this.name = 'AppointmentNotBillable'
    this.status = status
  }
}

/** Raised when a snapshot's own figures do not agree — before any of them reaches a total. */
export class SnapshotDoesNotReconcile extends AppError {
  constructor(appointmentId: string, message: string, details: Record<string, unknown>) {
    super(
      'invariant_violated',
      `SnapshotDoesNotReconcile: the price snapshot on appointment "${appointmentId}" ${message}`,
      { details: { appointmentId, ...details } },
    )
    this.name = 'SnapshotDoesNotReconcile'
  }
}

// --- the lines ----------------------------------------------------------------------------------

/** A treatment delivered, at the price it was sold for. */
export interface ServiceLine {
  readonly kind: 'service'
  readonly lineId: BasketLineId
  readonly description: string
  readonly account: AccountCode
  readonly appointmentId: string
  readonly serviceVariantId: string
  /**
   * One. Whole units only, and one appointment is one delivery: two treatments are two appointments,
   * and half a treatment is a different service (the same rule `TaxableLine.quantity` states).
   */
  readonly quantity: 1
  readonly gross: Money
  readonly tax: LineTax
  readonly priceListId: PriceListId | null
  readonly promotionId: PromotionId | null
}

/** A treatment already paid for, consuming an entitlement. Gross zero, always. */
export interface PackageRedemptionLine {
  readonly kind: 'package_redemption'
  readonly lineId: BasketLineId
  readonly description: string
  readonly account: AccountCode
  readonly appointmentId: string
  /** The `package_balance` row this redemption consumed. The whole point of the line. */
  readonly redeemedBalanceId: string
  /** Whole entitlements consumed. One treatment normally consumes one. */
  readonly redeemedUnits: number
  /** Zero. The customer paid for this at the time the package was sold. */
  readonly gross: Money
  /** `null`: this document taxes nothing for a redemption. See {@link packageRedemptionLine}. */
  readonly tax: null
}

/** A discount, with the figure {@link buildBasket} worked out for it. */
export interface PricedDiscountLine extends DiscountLine {
  /** Negative: what comes off the target line. */
  readonly gross: Money
  /**
   * The **difference** the discount makes to the target's tax, so the basket's VAT total is the tax on
   * what was charged. Negative, and `net + vat === gross` holds here too.
   */
  readonly tax: LineTax
}

/** A line as the caller assembles it. A discount has no amount yet. */
export type BasketLineDraft = ServiceLine | DiscountLine | TipLine | PackageRedemptionLine

/** A line as the basket holds it. Every line now carries a gross. */
export type BasketLine = ServiceLine | PricedDiscountLine | TipLine | PackageRedemptionLine

export function isServiceLine(line: BasketLineDraft): line is ServiceLine {
  return line.kind === 'service'
}

export function isDiscountLine(line: BasketLineDraft): line is DiscountLine {
  return line.kind === 'discount'
}

export function isRedemptionLine(line: BasketLineDraft): line is PackageRedemptionLine {
  return line.kind === 'package_redemption'
}

/**
 * The lines a discount may come off: the ones that carry a price and a tax.
 *
 * A tip is not a price, a redemption has no price to reduce, and a discount on a discount is two
 * reductions nobody can reconstruct. All three are refused by name rather than ignored.
 */
export function isChargeableLine(line: BasketLineDraft): line is ServiceLine {
  return isServiceLine(line)
}

function requireReconciledSnapshot(snapshot: AppointmentBillingSnapshot): void {
  const { appointmentId, gross, net, vat, vatRateBp } = snapshot
  if (gross.fils <= 0) {
    // B-CAT-03: zero is a missing price, not a free treatment. It passes a non-negative check,
    // invoices as 0.00 and reconciles to nothing — which is why `appointment_price_positive` exists.
    throw new SnapshotDoesNotReconcile(appointmentId, `carries a gross of ${gross.fils} fils`, {
      grossFils: gross.fils,
    })
  }
  if (net.fils + vat.fils !== gross.fils) {
    throw new SnapshotDoesNotReconcile(
      appointmentId,
      `states net ${net.fils} + VAT ${vat.fils} fils against a gross of ${gross.fils}. VAT is the ` +
        'remainder of the gross (ADR 0007), so the two must be exactly equal.',
      { netFils: net.fils, vatFils: vat.fils, grossFils: gross.fils },
    )
  }
  if (!Number.isInteger(vatRateBp) || vatRateBp < 0 || vatRateBp > 10_000) {
    throw new SnapshotDoesNotReconcile(appointmentId, `was taken at ${vatRateBp} basis points`, {
      vatRateBp,
    })
  }
}

/**
 * Builds a line from a completed appointment, copying its snapshotted price.
 *
 * The three refusals are the unit's substance: a treatment that has not been delivered
 * ({@link AppointmentNotBillable}), a snapshot whose own figures disagree
 * ({@link SnapshotDoesNotReconcile}), and a blank description — which is a line nobody can identify on
 * a document that cannot be edited afterwards.
 */
export function serviceLineFromAppointment(
  lineId: string,
  snapshot: AppointmentBillingSnapshot,
): ServiceLine {
  if (!BILLABLE_APPOINTMENT_STATUSES.includes(snapshot.status)) {
    throw new AppointmentNotBillable(snapshot.appointmentId, snapshot.status)
  }
  requireReconciledSnapshot(snapshot)
  return Object.freeze({
    kind: 'service' as const,
    lineId: basketLineId(lineId),
    description: requireText(snapshot.description, 'description'),
    account: snapshot.revenueAccount ?? ACCOUNTS.treatmentRevenue,
    appointmentId: requireText(snapshot.appointmentId, 'appointmentId'),
    serviceVariantId: requireText(snapshot.serviceVariantId, 'serviceVariantId'),
    quantity: 1 as const,
    // Copied, field for field. Not `splitGross(snapshot.gross)` — see the module note.
    gross: snapshot.gross,
    tax: Object.freeze({
      net: snapshot.net,
      vat: snapshot.vat,
      rateBp: snapshot.vatRateBp,
    }),
    priceListId: snapshot.priceListId,
    promotionId: snapshot.promotionId,
  })
}

export interface PackageRedemptionInput {
  readonly lineId: string
  readonly appointmentId: string
  /** The `package_balance` row being consumed. */
  readonly redeemedBalanceId: string
  /** Defaults to one. */
  readonly redeemedUnits?: number
  readonly description?: string
}

/**
 * A treatment delivered against a prepaid entitlement: gross zero, carrying the balance it consumed.
 *
 * Zero because the customer already paid — when the package was sold. The money is sitting in
 * `2050 Deferred revenue — packages`, which is a **liability**: the salon owes treatments, and the
 * redemption releases that liability. This line's job on a checkout is to say *which* entitlement was
 * consumed, and its zero gross is what makes the document's VAT total independent of how many
 * redemptions it contains — a property the basket test asserts over generated baskets, because a
 * redemption that contributed anything to the VAT total would be taxing a supply the customer has
 * already been taxed on.
 *
 * The value of the entitlement and the revenue release are M-TILL-09's, on the balance, and
 * deliberately not restated here: a value copied onto the redemption line would be a second opinion
 * about what the package was worth.
 */
export function packageRedemptionLine(input: PackageRedemptionInput): PackageRedemptionLine {
  const units = input.redeemedUnits ?? 1
  if (!Number.isInteger(units) || units < 1) {
    throw new MalformedBasket(
      'non_positive_amount',
      `a redemption of ${units} entitlements is not a redemption`,
      { lineId: input.lineId, redeemedUnits: units },
    )
  }
  return Object.freeze({
    kind: 'package_redemption' as const,
    lineId: basketLineId(input.lineId),
    description:
      input.description === undefined
        ? 'Redeemed from package'
        : requireText(input.description, 'description'),
    account: ACCOUNTS.packageDeferredRevenue,
    appointmentId: requireText(input.appointmentId, 'appointmentId'),
    redeemedBalanceId: requireText(input.redeemedBalanceId, 'redeemedBalanceId'),
    redeemedUnits: units,
    gross: ZERO_AED,
    tax: null,
  })
}

// --- what each chargeable line is actually taxed on ---------------------------------------------

/**
 * One chargeable line after its discounts: the figure a tax invoice states, and its tax.
 *
 * `gross` is what the customer is charged for this line and `vat` is the tax on exactly that, which is
 * the invoice-ready shape — `invoice_line.unit_gross_fils` is a `fils_nonneg` domain, so a negative
 * discount line cannot be an invoice line at all, and the discount reaches the document as a reduced
 * line price plus its own basket line for the ledger and the report.
 */
export interface ChargeableAmount {
  readonly lineId: BasketLineId
  readonly description: string
  readonly account: AccountCode
  readonly quantity: 1
  /** The snapshotted gross, before anything came off it. */
  readonly grossBeforeDiscount: Money
  /** Positive magnitude of every discount applied to this line. Zero when none was. */
  readonly discount: Money
  /** `grossBeforeDiscount - discount`. What the customer pays for this line. */
  readonly gross: Money
  readonly net: Money
  /** The tax on `gross`. Never on `grossBeforeDiscount`. */
  readonly vat: Money
  readonly rateBp: VatRateBp
  /** The discount lines that reduced it, in the order they were applied. */
  readonly discountLineIds: readonly BasketLineId[]
}

export interface BasketTotals {
  /** Every line's gross, summed. What the tenders must cover (M-TILL-07). */
  readonly grossTotal: Money
  /** Sum of the taxed lines' net. Tips and redemptions contribute nothing. */
  readonly netTotal: Money
  /** Sum of the taxed lines' VAT. Tips and redemptions contribute nothing. */
  readonly vatTotal: Money
  /** `netTotal + vatTotal`: the part of the basket that is a taxable supply. */
  readonly taxableGross: Money
  /** Positive magnitude of every discount. Reported, never netted into revenue. */
  readonly discountTotal: Money
  readonly tipTotal: Money
}

export interface Basket {
  readonly basketId: BasketId
  /** `null` for a cash sale at the desk with no customer record (ADR 0014). */
  readonly customerId: string | null
  /** In the order the caller declared them, with every discount now priced. */
  readonly lines: readonly BasketLine[]
  /** One per chargeable line, after discounts. The invoice is built from these. */
  readonly charges: readonly ChargeableAmount[]
  readonly totals: BasketTotals
}

export interface BasketDraft {
  readonly basketId: BasketId
  readonly customerId?: string | null
  readonly lines: readonly BasketLineDraft[]
}

/** The account a line posts to, resolved against the chart. Throws `UnknownAccount` for a bad code. */
export function accountOf(chart: ChartOfAccounts, line: BasketLineDraft): Account {
  return accountFor(chart, line.account)
}

/** Every line posting to an account the chart classifies as revenue, contra or not. */
export function linesOnRevenueAccounts(
  basket: Basket,
  chart: ChartOfAccounts,
): readonly BasketLine[] {
  return basket.lines.filter((line) => accountOf(chart, line).type === 'revenue')
}

export function tipLines(basket: Basket): readonly TipLine[] {
  return basket.lines.filter(isTipLine)
}

export function redemptionLines(basket: Basket): readonly PackageRedemptionLine[] {
  return basket.lines.filter(isRedemptionLine)
}

export function pricedDiscountLines(basket: Basket): readonly PricedDiscountLine[] {
  return basket.lines.filter((line): line is PricedDiscountLine => line.kind === 'discount')
}

/**
 * What each kind of line requires of its account, and why.
 *
 * Data rather than a `switch`, so the classification each line kind demands is readable in one place —
 * and so that a fifth line kind cannot be added without stating what its account must be.
 */
const REQUIRED_ACCOUNT: Readonly<
  Record<
    BasketLineDraft['kind'],
    { readonly type: AccountType; readonly contra: boolean; readonly why: string }
  >
> = Object.freeze({
  service: {
    type: 'revenue',
    contra: false,
    why: 'a treatment delivered is takings, and takings are revenue',
  },
  discount: {
    type: 'revenue',
    contra: true,
    why:
      'a discount belongs in a contra-revenue account so that gross takings and discounts given stay ' +
      'two figures; netting it off treatment revenue erases the only evidence a discount was given',
  },
  tip: {
    type: 'liability',
    contra: false,
    why:
      'a gratuity is money the salon holds for the therapist, not takings: crediting it to revenue ' +
      'inflates turnover, overstates the VAT on it, and then pays out of an account that never had it',
  },
  package_redemption: {
    type: 'liability',
    contra: false,
    why:
      'the customer paid when the package was sold, so the entitlement is a liability being released, ' +
      'and the revenue it releases is the value on that balance (M-TILL-09), not a figure on this ' +
      'document',
  },
})

function requireAccountClassification(chart: ChartOfAccounts, line: BasketLineDraft): void {
  const account = accountOf(chart, line)
  const required = REQUIRED_ACCOUNT[line.kind]
  if (account.type !== required.type || account.contra !== required.contra) {
    throw new MalformedBasket(
      'account_misclassified',
      `line "${line.lineId}" is a ${line.kind} posting to ${account.code} ${account.name}, which ` +
        `the chart classifies as ${account.contra ? 'contra ' : ''}${account.type}. A ${line.kind} ` +
        `must post to a ${required.contra ? 'contra ' : ''}${required.type} account, because ` +
        `${required.why}.`,
      { lineId: line.lineId, kind: line.kind, account: account.code, type: account.type },
    )
  }
}

/** The amount checks that belong to one line, whatever else the basket contains. */
function requireLineAmounts(line: BasketLineDraft): void {
  if (isRedemptionLine(line) && (line.gross.fils !== 0 || line.tax !== null)) {
    // Reachable only through a cast past `packageRedemptionLine`, which is exactly what a hurried
    // caller reaches for. A redemption that carried a price would charge for a treatment the customer
    // has already paid for, and would tax it a second time.
    throw new MalformedBasket(
      'redemption_carries_a_price',
      `redemption line "${line.lineId}" carries ${line.gross.fils} fils. Its value lives on the ` +
        'balance it consumed, not on this document.',
      { lineId: line.lineId, fils: line.gross.fils },
    )
  }
  if (isTipLine(line) && line.gross.fils <= 0) {
    throw new MalformedBasket(
      'non_positive_amount',
      `tip line "${line.lineId}" carries ${line.gross.fils} fils`,
      { lineId: line.lineId, fils: line.gross.fils },
    )
  }
}

/** One appointment, one line. Charged twice, or charged and redeemed, is the customer paying twice. */
function requireAppointmentOnce(
  seen: Map<string, BasketLineId>,
  line: ServiceLine | PackageRedemptionLine,
): void {
  const already = seen.get(line.appointmentId)
  if (already !== undefined) {
    // The likeliest cause is the second row of a couples booking being in front of the operator — the
    // same mistake `completed` refuses to repeat for, and for the same reason.
    throw new MalformedBasket(
      'appointment_billed_twice',
      `appointment "${line.appointmentId}" is on lines "${already}" and "${line.lineId}"`,
      { appointmentId: line.appointmentId, lines: [already, line.lineId] },
    )
  }
  seen.set(line.appointmentId, line.lineId)
}

function requireDiscountTarget(draft: BasketDraft, line: DiscountLine): void {
  // Re-checked here, and not only in `discountLine`: a line assembled from a request body has been
  // through no constructor at all, and this is the last place before the figure reaches a total.
  requireDiscountReason(line.terms.reason)
  const target = draft.lines.find((candidate) => candidate.lineId === line.targetLineId)
  if (target === undefined) {
    throw new MalformedBasket(
      'discount_target_missing',
      `discount "${line.lineId}" comes off line "${line.targetLineId}", which this basket does not ` +
        'contain',
      { lineId: line.lineId, targetLineId: line.targetLineId },
    )
  }
  if (!isChargeableLine(target)) {
    throw new MalformedBasket(
      'discount_target_not_chargeable',
      `discount "${line.lineId}" comes off "${target.lineId}", which is a ${target.kind}. A discount ` +
        'reduces a price; a tip is not a price, a redemption has none, and a discount on a discount ' +
        'is two reductions nobody can reconstruct.',
      { lineId: line.lineId, targetLineId: target.lineId, targetKind: target.kind },
    )
  }
}

function requireStructure(draft: BasketDraft, chart: ChartOfAccounts): void {
  if (draft.lines.length === 0) {
    // The same refusal `deriveDocumentTax` makes for a document with no lines, for the same reason:
    // every total would be zero, which is indistinguishable from a legitimate nil sale.
    throw new MalformedBasket('empty_basket', `basket "${draft.basketId}" has no lines`)
  }

  const seenLineIds = new Set<string>()
  const seenAppointments = new Map<string, BasketLineId>()
  for (const line of draft.lines) {
    if (seenLineIds.has(line.lineId)) {
      throw new MalformedBasket('duplicate_line_id', `two lines share the id "${line.lineId}"`, {
        lineId: line.lineId,
      })
    }
    seenLineIds.add(line.lineId)
    requireAccountClassification(chart, line)
    requireLineAmounts(line)
    if (isServiceLine(line) || isRedemptionLine(line))
      requireAppointmentOnce(seenAppointments, line)
    if (isDiscountLine(line)) requireDiscountTarget(draft, line)
  }
}

/**
 * Applies one chargeable line's discounts in declaration order, deriving the tax as a difference.
 *
 * The fold is the unit's arithmetic, and every step of it is a subtraction of two `splitGross` results
 * rather than a `splitGross` of a difference:
 *
 *     discount.vat = splitGross(grossAfter).vat - vatBefore
 *     discount.net = splitGross(grossAfter).net - netBefore
 *
 * so the running figures telescope: the sum of the target's own tax and every discount's tax is the tax
 * on the final gross, exactly, with no accumulated rounding. `net + vat === gross` holds on each
 * discount line as a consequence rather than as a second check — the two differences sum to the
 * difference of the grosses, which is the discount, *because* the snapshot itself reconciles.
 */
function applyDiscounts(
  target: ServiceLine,
  discounts: readonly DiscountLine[],
): { readonly charge: ChargeableAmount; readonly priced: readonly PricedDiscountLine[] } {
  const rateBp = target.tax.rateBp
  let runningGross = target.gross
  let runningNet = target.tax.net
  let runningVat = target.tax.vat
  const priced: PricedDiscountLine[] = []

  for (const discount of discounts) {
    const amount = discountFilsOn(discount.terms, runningGross)
    if (amount >= runningGross.fils) {
      // Against the RUNNING gross, so two discounts that together exceed the line are refused on the
      // second rather than producing a negative charge. A full discount is a comp — a different
      // transaction with a different ledger treatment — which is `PromotionExceedsPrice`'s argument.
      throw new DiscountExceedsLine(target.lineId, runningGross.fils, amount)
    }
    if (amount === 0) {
      // A percentage that rounds to nothing against this line. Refused rather than recorded: a reason
      // code on a reduction of zero fils is a discount in every report and no discount on the receipt,
      // and the operator needs to know the figure they chose does nothing here.
      throw new MalformedDiscount(
        `${discount.terms.value} ${discount.terms.kind === 'percentage_bp' ? 'bp' : 'fils'} off ` +
          `${runningGross.fils} fils rounds to nothing, so the discount would reduce no amount.`,
        { lineId: discount.lineId, targetLineId: target.lineId, grossFils: runningGross.fils },
      )
    }
    const nextGross = money(filsFrom(runningGross.fils - amount), runningGross.currency)
    const next = splitGross(nextGross, rateBp)
    priced.push(
      Object.freeze({
        ...discount,
        gross: money(filsFrom(-amount), runningGross.currency),
        tax: Object.freeze({
          net: money(filsFrom(next.net.fils - runningNet.fils), runningGross.currency),
          vat: money(filsFrom(next.vat.fils - runningVat.fils), runningGross.currency),
          rateBp,
        }),
      }),
    )
    runningGross = nextGross
    runningNet = next.net
    runningVat = next.vat
  }

  return {
    charge: Object.freeze({
      lineId: target.lineId,
      description: target.description,
      account: target.account,
      quantity: target.quantity,
      grossBeforeDiscount: target.gross,
      discount: money(filsFrom(target.gross.fils - runningGross.fils), target.gross.currency),
      gross: runningGross,
      net: runningNet,
      vat: runningVat,
      rateBp,
      discountLineIds: Object.freeze(priced.map((line) => line.lineId)),
    }),
    priced,
  }
}

/**
 * Validates a draft and returns the basket, with every discount priced and every total summed.
 *
 * Throws rather than returning a result union, for the reason `postEntry` does: a caller has nothing
 * useful to do with "this basket is malformed" except refuse the checkout, and an ignored result union
 * charges whatever the variable was initialised to.
 *
 * The chart is an argument and has no default, so the accounts a basket is checked against are the ones
 * the caller is posting to — not a copy of the chart this module happened to import.
 */
export function buildBasket(draft: BasketDraft, chart: ChartOfAccounts): Basket {
  requireStructure(draft, chart)

  const discountsByTarget = new Map<string, DiscountLine[]>()
  for (const line of draft.lines) {
    if (!isDiscountLine(line)) continue
    const existing = discountsByTarget.get(line.targetLineId)
    if (existing === undefined) discountsByTarget.set(line.targetLineId, [line])
    else existing.push(line)
  }

  const charges: ChargeableAmount[] = []
  const pricedById = new Map<string, PricedDiscountLine>()
  for (const line of draft.lines) {
    if (!isChargeableLine(line)) continue
    const { charge, priced } = applyDiscounts(line, discountsByTarget.get(line.lineId) ?? [])
    charges.push(charge)
    for (const discount of priced) pricedById.set(discount.lineId, discount)
  }

  // Declaration order is preserved, because the order the operator entered the lines in is the order
  // the receipt reads in, and a basket that reordered itself would make a disputed receipt unmatchable.
  //
  // The cast cannot be undefined: `requireStructure` has already refused a discount whose target is
  // absent or not chargeable, and the loop above prices every discount of every chargeable line. A
  // `?? line` fallback here would silently return an unpriced discount as though it were priced.
  const lines: readonly BasketLine[] = Object.freeze(
    draft.lines.map((line) =>
      isDiscountLine(line) ? (pricedById.get(line.lineId) as PricedDiscountLine) : line,
    ),
  )

  const taxes: LineTax[] = []
  const tips: Money[] = []
  const discounts: Money[] = []
  for (const line of lines) {
    if (line.tax !== null) taxes.push(line.tax)
    if (isTipLine(line)) tips.push(line.gross)
    // Negated per line rather than negating the sum, which would answer -0 for a basket with no
    // discounts at all — and `Object.is(-0, 0)` is false, so a test asserting zero would fail on a
    // basket that is entirely correct.
    if (line.kind === 'discount') discounts.push(money(filsFrom(-line.gross.fils)))
  }

  const netTotal = sum(taxes.map((tax) => tax.net))
  const vatTotal = sum(taxes.map((tax) => tax.vat))

  return Object.freeze({
    basketId: draft.basketId,
    customerId: draft.customerId ?? null,
    lines,
    charges: Object.freeze(charges),
    totals: Object.freeze({
      // The criterion, literally: the total is the SUM OF THE LINES. Not a re-derivation from the
      // charges, which would be a second opinion about the same addition, and not a figure the caller
      // passes in — which is how a basket comes to disagree with the receipt printed from it.
      grossTotal: sum(lines.map((line) => line.gross)),
      netTotal,
      vatTotal,
      taxableGross: add(netTotal, vatTotal),
      discountTotal: sum(discounts),
      tipTotal: sum(tips),
    }),
  })
}

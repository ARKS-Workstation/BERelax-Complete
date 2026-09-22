import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { accountCode } from '../ledger/account.ts'
import { ACCOUNTS, accountFor, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { APPOINTMENT_STATUSES, type AppointmentStatus } from '../lifecycle/transitions.ts'
import type { Money, VatRateBp } from '../money.ts'
import {
  aed,
  filsFrom,
  money,
  splitGross,
  UAE_STANDARD_VAT_BP,
  vatRateBp,
  ZERO_RATED_BP,
} from '../money.ts'
import type {
  AppointmentBillingSnapshot,
  Basket,
  BasketDraft,
  BasketLineDraft,
  PackageRedemptionLine,
  ServiceLine,
} from './basket.ts'
import {
  AppointmentNotBillable,
  BILLABLE_APPOINTMENT_STATUSES,
  buildBasket,
  linesOnRevenueAccounts,
  packageRedemptionLine,
  pricedDiscountLines,
  redemptionLines,
  SnapshotDoesNotReconcile,
  serviceLineFromAppointment,
  tipLines,
} from './basket.ts'
import type { DiscountKind, DiscountLineInput, DiscountReason } from './discount.ts'
import {
  DISCOUNT_REASON_NOTES,
  DISCOUNT_REASONS,
  DiscountExceedsLine,
  DiscountReasonRequired,
  discountLine,
  MalformedDiscount,
  vatIfDiscountTaxedSeparately,
} from './discount.ts'
import { BASKET_REFUSALS, type BasketRefusal, basketId, MalformedBasket } from './line.ts'
import { isTipLine, TIP_ACCOUNT, tipLine } from './tip.ts'

/**
 * The checkout basket: the snapshot is copied, the discount is reasoned, the tip is not revenue, and
 * the redemption is free.
 *
 * Every property here has a **control** beside it that must fail, because a basket that ignored its
 * lines and returned zeros would satisfy "the totals reconcile" on every generated case. Where the
 * control cannot be written as an assertion — the two type errors, and the four shipped-file edits that
 * must make this file go red — it is a known-bad fixture in `scripts/test-gates.mjs`, cases 67a-67f.
 */

const CHART = STANDARD_SPA_CHART

/** AED 262.50: a real menu price, and one that does not divide evenly by 1.05. */
const MENU_GROSS = 26_250

function snapshot(
  overrides: Partial<AppointmentBillingSnapshot> = {},
  grossFils = MENU_GROSS,
  rateBp: VatRateBp = UAE_STANDARD_VAT_BP,
): AppointmentBillingSnapshot {
  const split = splitGross(money(filsFrom(grossFils)), rateBp)
  return {
    appointmentId: 'appt-1',
    serviceVariantId: 'variant-1',
    status: 'completed',
    description: 'Aromatherapy massage, 60 min',
    gross: split.gross,
    net: split.net,
    vat: split.vat,
    vatRateBp: rateBp,
    priceListId: null,
    promotionId: null,
    ...overrides,
  }
}

const serviceLine = (lineId: string, overrides: Partial<AppointmentBillingSnapshot> = {}) =>
  serviceLineFromAppointment(lineId, snapshot(overrides))

const draftOf = (lines: readonly BasketLineDraft[]): BasketDraft => ({
  basketId: basketId('basket-1'),
  lines,
})

const build = (lines: readonly BasketLineDraft[]): Basket => buildBasket(draftOf(lines), CHART)

/** The refusal code a `MalformedBasket` carried, or the error itself if it was something else. */
function refusalFrom(run: () => unknown): BasketRefusal {
  try {
    run()
  } catch (error) {
    if (error instanceof MalformedBasket) return error.refusal
    throw error
  }
  throw new Error('nothing was refused')
}

// -------------------------------------------------------------------------------------------------
// The snapshot
// -------------------------------------------------------------------------------------------------

describe('serviceLineFromAppointment — the snapshotted price is copied', () => {
  it('copies gross, net, VAT and the rate off the appointment', () => {
    const snap = snapshot()
    const line = serviceLineFromAppointment('line-1', snap)
    expect(line.gross.fils).toBe(MENU_GROSS)
    expect(line.tax.net.fils).toBe(25_000)
    expect(line.tax.vat.fils).toBe(1_250)
    expect(line.tax.net.fils + line.tax.vat.fils).toBe(line.gross.fils)
    expect(line.tax.rateBp).toBe(snap.vatRateBp)
    expect(line.account).toBe(ACCOUNTS.treatmentRevenue)
    expect(line.quantity).toBe(1)
  })

  it('copies a split it would not have derived, rather than re-deriving one', () => {
    // The assertion that separates "copies" from "recomputes". These figures reconcile — 25001 + 1249 =
    // 26250, which is what the database's `appointment_price_split_exact` requires — but they are not
    // what `splitGross` answers for 26250. A basket that re-derived would silently publish 25000/1250
    // and restate a figure that has already been quoted and possibly filed.
    const line = serviceLineFromAppointment(
      'line-1',
      snapshot({ net: money(filsFrom(25_001)), vat: money(filsFrom(1_249)) }),
    )
    expect(line.tax.net.fils).toBe(25_001)
    expect(line.tax.vat.fils).toBe(1_249)
    // And the control: the derivation really would have answered something else.
    expect(splitGross(line.gross).net.fils).toBe(25_000)
  })

  it('carries the price list and promotion ids through, null meaning considered and did not apply', () => {
    const line = serviceLineFromAppointment('line-1', snapshot())
    expect(line.priceListId).toBeNull()
    expect(line.promotionId).toBeNull()
  })

  it('bills only the status the lifecycle declares as revenue-emitting', () => {
    expect(BILLABLE_APPOINTMENT_STATUSES).toEqual(['completed'])
    const refused: AppointmentStatus[] = []
    for (const status of APPOINTMENT_STATUSES) {
      if (status === 'completed') continue
      try {
        serviceLineFromAppointment('line-1', snapshot({ status }))
      } catch (error) {
        if (error instanceof AppointmentNotBillable && error.status === status) refused.push(status)
      }
    }
    // All eight of the others, by name — not "at least one threw".
    expect(refused).toEqual(APPOINTMENT_STATUSES.filter((s) => s !== 'completed'))
  })

  it('refuses a snapshot whose net and VAT do not sum to its gross', () => {
    expect(() =>
      serviceLineFromAppointment('line-1', snapshot({ vat: money(filsFrom(1_251)) })),
    ).toThrow(SnapshotDoesNotReconcile)
  })

  it('refuses a zero gross, because zero is a missing price and not a free treatment', () => {
    expect(() =>
      serviceLineFromAppointment(
        'line-1',
        snapshot({ gross: money(filsFrom(0)), net: money(filsFrom(0)), vat: money(filsFrom(0)) }),
      ),
    ).toThrow(SnapshotDoesNotReconcile)
  })

  it('refuses a rate outside 0-10000 basis points', () => {
    expect(() =>
      serviceLineFromAppointment('line-1', snapshot({ vatRateBp: 10_001 as VatRateBp })),
    ).toThrow(SnapshotDoesNotReconcile)
  })

  it('refuses a blank description, an unnameable line on a document nobody can edit', () => {
    expect(
      refusalFrom(() => serviceLineFromAppointment('line-1', snapshot({ description: ' ' }))),
    ).toBe('blank_field')
  })

  it('refuses a blank line id', () => {
    expect(refusalFrom(() => serviceLineFromAppointment('', snapshot()))).toBe('blank_field')
  })
})

// -------------------------------------------------------------------------------------------------
// Discounts
// -------------------------------------------------------------------------------------------------

const discountInput = (overrides: Partial<DiscountLineInput> = {}): DiscountLineInput => ({
  lineId: 'disc-1',
  targetLineId: 'line-1',
  reason: 'manager_goodwill',
  kind: 'percentage_bp',
  value: 1_000,
  ...overrides,
})

describe('the reason code is closed, and required at run time as well as at compile time', () => {
  it('describes every reason, so a new one cannot arrive undescribed', () => {
    // A Record over the union: the typecheck is the coverage assertion, and this asserts the prose is
    // real rather than empty.
    expect(Object.keys(DISCOUNT_REASON_NOTES).sort()).toEqual([...DISCOUNT_REASONS].sort())
    for (const reason of DISCOUNT_REASONS) {
      expect(DISCOUNT_REASON_NOTES[reason].length).toBeGreaterThan(20)
    }
  })

  it('has no catch-all bucket', () => {
    // An `other` reason is a closed enum with an open door: within a quarter it is the largest
    // category in the report and the report answers nothing.
    expect(DISCOUNT_REASONS).not.toContain('other')
  })

  it('refuses every shape of missing reason with DiscountReasonRequired', () => {
    // The type forbids every one of these, so each arrives only from a request body — which is exactly
    // the caller this refusal exists for. Gates 67a and 67b prove the compile-time half.
    for (const given of [undefined, null, '', 'friend_of_the_owner', 42]) {
      expect(() =>
        discountLine(discountInput({ reason: given as unknown as DiscountReason })),
      ).toThrow(DiscountReasonRequired)
    }
  })

  it('names the rejected value, so the client that sent it can be found', () => {
    try {
      discountLine(discountInput({ reason: '' as unknown as DiscountReason }))
      expect.unreachable('a blank reason must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(DiscountReasonRequired)
      expect((error as DiscountReasonRequired).given).toBe('')
      expect((error as DiscountReasonRequired).message).toContain('manager_goodwill')
    }
  })

  it('refuses a reason in the basket too, for a line that came through no constructor', () => {
    const line = discountLine(discountInput())
    const forged = { ...line, terms: { ...line.terms, reason: 'mgr ok' as DiscountReason } }
    expect(() => build([serviceLine('line-1'), forged])).toThrow(DiscountReasonRequired)
  })

  it('keeps the note beside the reason and never instead of it', () => {
    const withNote = discountLine(discountInput({ note: 'Cold room, apologised' }))
    expect(withNote.terms.note).toBe('Cold room, apologised')
    expect(withNote.terms.reason).toBe('manager_goodwill')
    expect(discountLine(discountInput()).terms.note).toBeNull()
  })

  it('refuses a non-positive or fractional value, and more than 100%', () => {
    for (const value of [0, -500, 12.5]) {
      expect(() => discountLine(discountInput({ value }))).toThrow(MalformedDiscount)
    }
    expect(() => discountLine(discountInput({ value: 10_001 }))).toThrow(MalformedDiscount)
    // The control: 10000 bp is exactly 100%, which is refused later and for a different reason —
    // DiscountExceedsLine, because a full discount is a comp.
    expect(() =>
      build([serviceLine('line-1'), discountLine(discountInput({ value: 10_000 }))]),
    ).toThrow(DiscountExceedsLine)
  })
})

describe('a discounted line is taxed on what was charged, never on the pre-discount price', () => {
  it('derives the discount line as the difference, so the totals are the tax on the reduced gross', () => {
    const basket = build([
      serviceLine('line-1'),
      discountLine(discountInput({ value: 1_000, reason: 'campaign' })),
    ])
    const [charge] = basket.charges
    expect(charge?.grossBeforeDiscount.fils).toBe(26_250)
    expect(charge?.discount.fils).toBe(2_625)
    expect(charge?.gross.fils).toBe(23_625)

    // The whole claim, in one line: the basket's VAT is the VAT of the discounted gross.
    expect(basket.totals.vatTotal.fils).toBe(splitGross(money(filsFrom(23_625))).vat.fils)
    expect(basket.totals.netTotal.fils + basket.totals.vatTotal.fils).toBe(23_625)
    expect(basket.totals.grossTotal.fils).toBe(23_625)
    expect(basket.totals.discountTotal.fils).toBe(2_625)

    const [discount] = pricedDiscountLines(basket)
    expect(discount?.gross.fils).toBe(-2_625)
    expect(discount?.tax.net.fils).toBe(-2_500)
    expect(discount?.tax.vat.fils).toBe(-125)
    // net + vat === gross on the discount line as well. It is not checked there — it follows from the
    // fold — which is why it is asserted here.
    expect((discount?.tax.net.fils ?? 0) + (discount?.tax.vat.fils ?? 0)).toBe(discount?.gross.fils)
  })

  it('answers 0 where taxing the discount separately would answer 1 — the 11-fils probe', () => {
    // 11 fils gross is the smallest amount at which the two methods disagree, the same probe M-TILL-04
    // uses for the two-line rounding. Discount 5 fils: 6 fils is charged, and 6 - round(6 * 20 / 21) is
    // 0. Taxing the -5 discount line on its own gross leaves the 1 fils of VAT the 11 carried, on money
    // the customer never paid.
    const line = serviceLineFromAppointment('line-1', snapshot({}, 11))
    expect(line.tax.vat.fils).toBe(1)
    const basket = build([
      line,
      discountLine(discountInput({ kind: 'absolute_fils', value: 5, reason: 'service_recovery' })),
    ])
    expect(basket.charges[0]?.gross.fils).toBe(6)
    expect(basket.totals.vatTotal.fils).toBe(0)

    const wrong = vatIfDiscountTaxedSeparately(money(filsFrom(11)), money(filsFrom(5)))
    expect(wrong.fils).toBe(1)
    expect(basket.totals.vatTotal.fils).not.toBe(wrong.fils)
  })

  it('compounds two discounts on one line in declaration order, and the total is still exact', () => {
    const basket = build([
      serviceLine('line-1'),
      discountLine(discountInput({ lineId: 'disc-1', value: 1_000 })),
      discountLine(discountInput({ lineId: 'disc-2', value: 1_000, reason: 'loyalty_reward' })),
    ])
    // 26250 - 2625 = 23625, then 10% of 23625 = 2363 (half-up), so 21262. Two 10% discounts are not
    // 20%: the order and the running gross are what produce the odd fils, and both are recorded.
    expect(basket.charges[0]?.gross.fils).toBe(21_262)
    expect(basket.charges[0]?.discountLineIds).toEqual(['disc-1', 'disc-2'])
    expect(basket.totals.vatTotal.fils).toBe(splitGross(money(filsFrom(21_262))).vat.fils)
    expect(basket.totals.discountTotal.fils).toBe(2_625 + 2_363)
  })

  it('refuses a discount that would leave nothing to charge', () => {
    expect(() =>
      build([
        serviceLine('line-1'),
        discountLine(discountInput({ kind: 'absolute_fils', value: MENU_GROSS })),
      ]),
    ).toThrow(DiscountExceedsLine)
  })

  it('refuses a kind that is neither of the two, by name', () => {
    // `assertNever` is the exhaustiveness check: a third DiscountKind added without a branch here is a
    // typecheck failure, and a forged one at run time is refused rather than silently discounted by
    // zero. Only reachable past the type, which is the point.
    const line = discountLine(discountInput())
    const forged = {
      ...line,
      terms: { ...line.terms, kind: 'percentage_of_net' as DiscountKind },
    }
    expect(() => build([serviceLine('line-1'), forged])).toThrow(/discountFilsOn kind/)
  })

  it('refuses a percentage that rounds to nothing against its line', () => {
    const line = serviceLineFromAppointment('line-1', snapshot({}, 11))
    expect(() => build([line, discountLine(discountInput({ value: 100 }))])).toThrow(
      MalformedDiscount,
    )
  })

  it('posts to the contra-revenue account, so takings and discounts stay two figures', () => {
    const basket = build([serviceLine('line-1'), discountLine(discountInput())])
    const account = accountFor(
      CHART,
      pricedDiscountLines(basket)[0]?.account ?? accountCode('0000'),
    )
    expect(account.code).toBe(ACCOUNTS.discountsAndAllowances)
    expect(account.type).toBe('revenue')
    expect(account.contra).toBe(true)
  })
})

// -------------------------------------------------------------------------------------------------
// Tips
// -------------------------------------------------------------------------------------------------

describe('tips are collected, not earned', () => {
  it('posts to a liability and taxes nothing', () => {
    const tip = tipLine({ lineId: 'tip-1', gross: aed(50), beneficiaryEmployeeId: 'emp-7' })
    expect(tip.account).toBe(TIP_ACCOUNT)
    expect(accountFor(CHART, tip.account).type).toBe('liability')
    expect(tip.tax).toBeNull()
    expect(tip.beneficiaryEmployeeId).toBe('emp-7')
  })

  it('defaults to the pool rather than inventing a beneficiary', () => {
    expect(tipLine({ lineId: 'tip-1', gross: aed(50) }).beneficiaryEmployeeId).toBeNull()
  })

  it('refuses a zero or negative gratuity', () => {
    for (const fils of [0, -100]) {
      expect(refusalFrom(() => tipLine({ lineId: 'tip-1', gross: money(filsFrom(fils)) }))).toBe(
        'non_positive_amount',
      )
    }
  })

  it('is excluded from the taxable total and included in what the tenders must cover', () => {
    const basket = build([serviceLine('line-1'), tipLine({ lineId: 'tip-1', gross: aed(50) })])
    expect(basket.totals.tipTotal.fils).toBe(5_000)
    expect(basket.totals.taxableGross.fils).toBe(MENU_GROSS)
    expect(basket.totals.vatTotal.fils).toBe(1_250)
    expect(basket.totals.grossTotal.fils).toBe(MENU_GROSS + 5_000)
  })

  it('is refused inside a basket too, if it was forged past the constructor', () => {
    const forged = { ...tipLine({ lineId: 'tip-1', gross: aed(50) }), gross: money(filsFrom(0)) }
    expect(refusalFrom(() => build([serviceLine('line-1'), forged]))).toBe('non_positive_amount')
  })

  it('is recognised by kind, which is how the basket keeps tips out of every taxed total', () => {
    expect(isTipLine(tipLine({ lineId: 'tip-1', gross: aed(50) }))).toBe(true)
    expect(isTipLine(serviceLine('line-1'))).toBe(false)
  })

  it('is refused if it lands on a revenue account', () => {
    // Reachable only past `tipLine`, which fixes the account. The check is here rather than there
    // because the account a line posts to is the basket's business: gate 67c edits TIP_ACCOUNT to
    // treatment revenue and watches this file go red.
    const forged = {
      ...tipLine({ lineId: 'tip-1', gross: aed(50) }),
      account: ACCOUNTS.treatmentRevenue,
    }
    expect(refusalFrom(() => build([serviceLine('line-1'), forged]))).toBe('account_misclassified')
  })
})

// -------------------------------------------------------------------------------------------------
// Package redemption
// -------------------------------------------------------------------------------------------------

describe('a package redemption charges nothing and names the balance it consumed', () => {
  const redemption = (overrides: Partial<Parameters<typeof packageRedemptionLine>[0]> = {}) =>
    packageRedemptionLine({
      lineId: 'red-1',
      appointmentId: 'appt-2',
      redeemedBalanceId: 'balance-9',
      ...overrides,
    })

  it('carries gross zero, no tax, the balance id and a liability account', () => {
    const line = redemption()
    expect(line.gross.fils).toBe(0)
    expect(line.tax).toBeNull()
    expect(line.redeemedBalanceId).toBe('balance-9')
    expect(line.redeemedUnits).toBe(1)
    expect(accountFor(CHART, line.account).type).toBe('liability')
    expect(line.account).toBe(ACCOUNTS.packageDeferredRevenue)
  })

  it('refuses a blank balance id — the line exists to name it', () => {
    expect(refusalFrom(() => redemption({ redeemedBalanceId: '  ' }))).toBe('blank_field')
  })

  it('refuses a fractional or non-positive number of entitlements', () => {
    for (const redeemedUnits of [0, -1, 1.5]) {
      expect(refusalFrom(() => redemption({ redeemedUnits }))).toBe('non_positive_amount')
    }
  })

  it('leaves the VAT total untouched however many there are', () => {
    const base = build([serviceLine('line-1')])
    const many = build([
      serviceLine('line-1'),
      redemption({ lineId: 'red-1', appointmentId: 'appt-2', redeemedBalanceId: 'balance-1' }),
      redemption({ lineId: 'red-2', appointmentId: 'appt-3', redeemedBalanceId: 'balance-2' }),
      redemption({ lineId: 'red-3', appointmentId: 'appt-4', redeemedBalanceId: 'balance-3' }),
    ])
    expect(many.totals.vatTotal.fils).toBe(base.totals.vatTotal.fils)
    expect(many.totals.grossTotal.fils).toBe(base.totals.grossTotal.fils)
    expect(redemptionLines(many)).toHaveLength(3)
  })

  it('is refused if it carries a price', () => {
    // Past the constructor, which has no amount to give it. A redemption with a price charges for a
    // treatment the customer has already paid for, and taxes it twice.
    const forged: PackageRedemptionLine = { ...redemption(), gross: aed(100) }
    expect(refusalFrom(() => build([serviceLine('line-1'), forged]))).toBe(
      'redemption_carries_a_price',
    )
  })
})

// -------------------------------------------------------------------------------------------------
// The structural refusals, each one reachable
// -------------------------------------------------------------------------------------------------

describe('every basket refusal is reachable', () => {
  const cases: Readonly<Record<BasketRefusal, () => unknown>> = {
    blank_field: () => basketId(' '),
    empty_basket: () => build([]),
    duplicate_line_id: () =>
      build([serviceLine('line-1'), serviceLine('line-1', { appointmentId: 'appt-2' })]),
    appointment_billed_twice: () => build([serviceLine('line-1'), serviceLine('line-2')]),
    non_positive_amount: () => tipLine({ lineId: 'tip-1', gross: money(filsFrom(0)) }),
    discount_target_missing: () =>
      build([serviceLine('line-1'), discountLine(discountInput({ targetLineId: 'line-9' }))]),
    discount_target_not_chargeable: () =>
      build([
        serviceLine('line-1'),
        tipLine({ lineId: 'tip-1', gross: aed(50) }),
        discountLine(discountInput({ targetLineId: 'tip-1' })),
      ]),
    account_misclassified: () =>
      build([serviceLine('line-1', { revenueAccount: ACCOUNTS.cashInDrawer })]),
    redemption_carries_a_price: () =>
      build([
        serviceLine('line-1'),
        {
          ...packageRedemptionLine({
            lineId: 'red-1',
            appointmentId: 'appt-2',
            redeemedBalanceId: 'balance-1',
          }),
          gross: aed(1),
        },
      ]),
  }

  for (const refusal of BASKET_REFUSALS) {
    it(`refuses with ${refusal}`, () => {
      expect(refusalFrom(cases[refusal])).toBe(refusal)
    })
  }

  it('covers the whole vocabulary, so a refusal added without a case fails here', () => {
    expect(Object.keys(cases).sort()).toEqual([...BASKET_REFUSALS].sort())
  })

  it('rejects a line posting to an account the chart does not contain', () => {
    expect(() => build([serviceLine('line-1', { revenueAccount: accountCode('9999') })])).toThrow(
      /not in chart/,
    )
  })

  it('prints the wording the operator gave, and a stated default when they gave none', () => {
    // Every line's description reaches a document that cannot be edited afterwards, so the default is
    // stated here rather than left to whatever the caller passed.
    expect(discountLine(discountInput()).description).toBe(DISCOUNT_REASON_NOTES.manager_goodwill)
    expect(discountLine(discountInput({ description: '10% off, manager' })).description).toBe(
      '10% off, manager',
    )
    expect(tipLine({ lineId: 'tip-1', gross: aed(50) }).description).toBe('Gratuity')
    expect(
      tipLine({ lineId: 'tip-1', gross: aed(50), description: 'Gratuity, card' }).description,
    ).toBe('Gratuity, card')
    const redeemed = packageRedemptionLine({
      lineId: 'red-1',
      appointmentId: 'appt-2',
      redeemedBalanceId: 'balance-1',
      description: 'Aromatherapy 60 min, from 10-pack',
    })
    expect(redeemed.description).toBe('Aromatherapy 60 min, from 10-pack')
    expect(
      packageRedemptionLine({
        lineId: 'red-1',
        appointmentId: 'appt-2',
        redeemedBalanceId: 'balance-1',
      }).description,
    ).toBe('Redeemed from package')
  })

  it('preserves declaration order, because the receipt reads in that order', () => {
    const basket = build([
      serviceLine('line-1'),
      tipLine({ lineId: 'tip-1', gross: aed(50) }),
      discountLine(discountInput({ lineId: 'disc-1' })),
    ])
    expect(basket.lines.map((line) => line.lineId)).toEqual(['line-1', 'tip-1', 'disc-1'])
    expect(basket.customerId).toBeNull()
  })
})

// -------------------------------------------------------------------------------------------------
// Properties, over generated baskets
// -------------------------------------------------------------------------------------------------

interface DiscountSpec {
  readonly kind: DiscountKind
  /** Basis points. For `absolute_fils` it is converted to a fraction of the line's own gross. */
  readonly bp: number
  readonly reason: DiscountReason
}

interface LineSpec {
  readonly grossFils: number
  readonly rateBp: VatRateBp
  readonly discounts: readonly DiscountSpec[]
}

interface BasketSpec {
  readonly lines: readonly LineSpec[]
  readonly tips: readonly number[]
  readonly redemptions: number
}

/**
 * Baskets, generated.
 *
 * The bounds are arithmetic, not taste: every generated basket must be *legal*, because a generator
 * that trips a refusal on a randomly varying fraction of its runs is a test that is green until it is
 * not. Two refusals are in range, and both are excluded by the numbers rather than by a filter:
 *
 *   - `DiscountExceedsLine`. Three discounts of at most 3000 bp take at most 90% of the line's own
 *     gross (an absolute one is stated as a fraction of the pre-discount gross, so three of them are
 *     0.9g at worst, and percentages compound to less), which leaves the line positive.
 *   - a discount that rounds to nothing. The smallest reduction is 100 bp of the *running* gross, and
 *     the running gross is at least `0.1 × 10000 = 1000` fils after the worst case above — so the
 *     smallest discount any generated basket can ask for is 10 fils, never 0. A minimum gross of 100
 *     fils would not do: two absolute discounts would leave 40 fils, and 1% of 40 rounds to zero.
 *     `MalformedDiscount` has its own deterministic case above; here it must not fire at all.
 *
 * Rates are mixed: `ZERO_RATED_BP` makes every VAT figure on a line zero, which is the case a basket
 * that derived its totals from the standard rate rather than from the line would get wrong.
 */
const basketSpec: fc.Arbitrary<BasketSpec> = fc.record({
  lines: fc.array(
    fc.record({
      grossFils: fc.integer({ min: 10_000, max: 5_000_000 }),
      rateBp: fc.constantFrom(UAE_STANDARD_VAT_BP, ZERO_RATED_BP, vatRateBp(1_000)),
      discounts: fc.array(
        fc.record({
          kind: fc.constantFrom<DiscountKind>('percentage_bp', 'absolute_fils'),
          bp: fc.integer({ min: 100, max: 3_000 }),
          reason: fc.constantFrom(...DISCOUNT_REASONS),
        }),
        { maxLength: 3 },
      ),
    }),
    { minLength: 1, maxLength: 4 },
  ),
  tips: fc.array(fc.integer({ min: 1, max: 200_000 }), { maxLength: 3 }),
  redemptions: fc.nat({ max: 3 }),
})

function linesFor(spec: BasketSpec, options: { tips: boolean; redemptions: boolean }) {
  const lines: BasketLineDraft[] = []
  spec.lines.forEach((line, i) => {
    const id = `line-${i}`
    lines.push(
      serviceLineFromAppointment(
        id,
        snapshot(
          { appointmentId: `appt-${i}`, serviceVariantId: `variant-${i}` },
          line.grossFils,
          line.rateBp,
        ),
      ),
    )
    line.discounts.forEach((discount, j) => {
      lines.push(
        discountLine({
          lineId: `disc-${i}-${j}`,
          targetLineId: id,
          reason: discount.reason,
          kind: discount.kind,
          // An absolute discount is stated as a fraction of the line's own gross, so the generator
          // cannot produce one larger than the line it comes off.
          value:
            discount.kind === 'percentage_bp'
              ? discount.bp
              : Math.max(1, Math.round((line.grossFils * discount.bp) / 10_000)),
        }),
      )
    })
  })
  if (options.tips) {
    spec.tips.forEach((fils, i) => {
      lines.push(tipLine({ lineId: `tip-${i}`, gross: money(filsFrom(fils)) }))
    })
  }
  if (options.redemptions) {
    for (let i = 0; i < spec.redemptions; i += 1) {
      lines.push(
        packageRedemptionLine({
          lineId: `red-${i}`,
          appointmentId: `redeemed-appt-${i}`,
          redeemedBalanceId: `balance-${i}`,
        }),
      )
    }
  }
  return lines
}

const basketFrom = (spec: BasketSpec, options = { tips: true, redemptions: true }): Basket =>
  build(linesFor(spec, options))

const filsOf = (amounts: readonly Money[]): number =>
  amounts.reduce((total, amount) => total + amount.fils, 0)

describe('property — the totals are the sum of the lines', () => {
  it('sum(line gross) === grossTotal over 1,000 generated baskets', () => {
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const basket = basketFrom(spec)
        return (
          filsOf(basket.lines.map((line) => line.gross)) === basket.totals.grossTotal.fils &&
          basket.totals.netTotal.fils + basket.totals.vatTotal.fils ===
            basket.totals.taxableGross.fils &&
          basket.totals.taxableGross.fils + basket.totals.tipTotal.fils ===
            basket.totals.grossTotal.fils
        )
      }),
      { numRuns: 1_000 },
    )
  })

  it('and a total that dropped the discount lines would differ, wherever there is one', () => {
    // The control. Without it, a `grossTotal` that summed only the service lines would satisfy the
    // property above on every basket that happens to carry no discount.
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const basket = basketFrom(spec)
        const withoutDiscounts = filsOf(
          basket.lines.filter((line) => line.kind !== 'discount').map((line) => line.gross),
        )
        return pricedDiscountLines(basket).length === 0
          ? withoutDiscounts === basket.totals.grossTotal.fils
          : withoutDiscounts > basket.totals.grossTotal.fils
      }),
      { numRuns: 1_000 },
    )
  })

  it('every line that has a tax reconciles, including the negative ones', () => {
    fc.assert(
      fc.property(basketSpec, (spec) =>
        basketFrom(spec).lines.every((line) =>
          line.tax === null ? true : line.tax.net.fils + line.tax.vat.fils === line.gross.fils,
        ),
      ),
      { numRuns: 1_000 },
    )
  })
})

describe('property — no path taxes the pre-discount amount', () => {
  it('the VAT of a discounted basket is the VAT of its discounted grosses, over 1,000 baskets', () => {
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const basket = basketFrom(spec)
        // Derived in one step from the gross actually charged — a different code path from the fold of
        // differences the basket used to get there.
        const fromDiscountedGross = basket.charges.map(
          (charge) => splitGross(charge.gross, charge.rateBp).vat.fils,
        )
        return (
          basket.charges.every(
            (charge, i) =>
              charge.vat.fils === fromDiscountedGross[i] &&
              charge.net.fils + charge.vat.fils === charge.gross.fils &&
              charge.gross.fils === charge.grossBeforeDiscount.fils - charge.discount.fils,
          ) && fromDiscountedGross.reduce((a, b) => a + b, 0) === basket.totals.vatTotal.fils
        )
      }),
      { numRuns: 1_000 },
    )
  })

  it('and the pre-discount VAT is a different figure often enough for that to mean something', () => {
    // The control for the property above, and the reason it is a control: if the two agreed on every
    // generated basket, taxing the pre-discount gross would pass the property as well. This counts the
    // cases where they differ and requires a substantial share of them.
    let differing = 0
    let discounted = 0
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const basket = basketFrom(spec)
        for (const charge of basket.charges) {
          if (charge.discount.fils === 0) continue
          discounted += 1
          if (splitGross(charge.grossBeforeDiscount, charge.rateBp).vat.fils !== charge.vat.fils) {
            differing += 1
          }
        }
        return true
      }),
      { numRuns: 1_000 },
    )
    expect(discounted).toBeGreaterThan(100)
    expect(differing).toBeGreaterThan(discounted / 2)
  })
})

describe('property — a tip is never revenue and never taxed', () => {
  it('no line on a revenue account is a tip, over 1,000 generated baskets', () => {
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const basket = basketFrom(spec)
        const revenue = linesOnRevenueAccounts(basket, CHART)
        return (
          revenue.every((line) => line.kind !== 'tip') &&
          revenue.every((line) => line.kind === 'service' || line.kind === 'discount') &&
          tipLines(basket).every((tip) => accountFor(CHART, tip.account).type === 'liability')
        )
      }),
      { numRuns: 1_000 },
    )
  })

  it('removing every tip changes the gross by exactly the tips and the VAT not at all', () => {
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const withTips = basketFrom(spec)
        const withoutTips = basketFrom(spec, { tips: false, redemptions: true })
        return (
          withTips.totals.vatTotal.fils === withoutTips.totals.vatTotal.fils &&
          withTips.totals.netTotal.fils === withoutTips.totals.netTotal.fils &&
          withTips.totals.taxableGross.fils === withoutTips.totals.taxableGross.fils &&
          withTips.totals.grossTotal.fils - withTips.totals.tipTotal.fils ===
            withoutTips.totals.grossTotal.fils &&
          withTips.totals.tipTotal.fils === filsOf(tipLines(withTips).map((tip) => tip.gross))
        )
      }),
      { numRuns: 1_000 },
    )
  })

  it('and the control: the generator really does produce tips', () => {
    // Otherwise both properties above are true of every basket for the wrong reason.
    let withTips = 0
    fc.assert(
      fc.property(basketSpec, (spec) => {
        if (tipLines(basketFrom(spec)).length > 0) withTips += 1
        return true
      }),
      { numRuns: 500 },
    )
    expect(withTips).toBeGreaterThan(100)
  })
})

describe('property — redemption lines cannot move a total', () => {
  it('the same basket with and without its redemptions has identical totals', () => {
    fc.assert(
      fc.property(basketSpec, (spec) => {
        const withRedemptions = basketFrom(spec)
        const without = basketFrom(spec, { tips: true, redemptions: false })
        const counted = redemptionLines(withRedemptions).length
        return (
          counted === spec.redemptions &&
          withRedemptions.totals.vatTotal.fils === without.totals.vatTotal.fils &&
          withRedemptions.totals.netTotal.fils === without.totals.netTotal.fils &&
          withRedemptions.totals.grossTotal.fils === without.totals.grossTotal.fils &&
          redemptionLines(withRedemptions).every(
            (line) => line.gross.fils === 0 && line.redeemedBalanceId.length > 0,
          )
        )
      }),
      { numRuns: 1_000 },
    )
  })
})

describe('the charges are the invoice-ready shape', () => {
  it('one per chargeable line, carrying the description and account of its line', () => {
    const lines: readonly ServiceLine[] = [
      serviceLine('line-1'),
      serviceLine('line-2', { appointmentId: 'appt-2', description: 'Hot stone, 90 min' }),
    ]
    const basket = build([...lines, tipLine({ lineId: 'tip-1', gross: aed(20) })])
    expect(basket.charges.map((charge) => charge.lineId)).toEqual(['line-1', 'line-2'])
    expect(basket.charges[1]?.description).toBe('Hot stone, 90 min')
    expect(basket.charges.every((charge) => charge.account === ACCOUNTS.treatmentRevenue)).toBe(
      true,
    )
    // No charge for the tip: it is not a supply, and `invoice_line.unit_gross_fils` could hold it
    // while the document would then be stating a zero-rated supply that never happened.
    expect(basket.charges).toHaveLength(2)
    expect(filsOf(basket.charges.map((charge) => charge.gross))).toBe(
      basket.totals.taxableGross.fils,
    )
  })
})

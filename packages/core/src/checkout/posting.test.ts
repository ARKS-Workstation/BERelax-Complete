import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { accountCode } from '../ledger/account.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { EntryId, JournalLine } from '../ledger/entry.ts'
import { entryId, imbalanceFils, isBalanced, MalformedEntry } from '../ledger/entry.ts'
import type { Money, VatRateBp } from '../money.ts'
import { filsFrom, money, splitGross, UAE_STANDARD_VAT_BP } from '../money.ts'
import { localDate } from '../time.ts'
import type { AppointmentBillingSnapshot, Basket, BasketLineDraft } from './basket.ts'
import { buildBasket, packageRedemptionLine, serviceLineFromAppointment } from './basket.ts'
import { discountLine } from './discount.ts'
import { basketId } from './line.ts'
import type { CheckoutPosting, TenderKind, TenderLine } from './posting.ts'
import {
  checkoutPosting,
  MalformedTender,
  NothingToPost,
  OUTPUT_VAT_ACCOUNT,
  reconcilePosting,
  TENDER_ACCOUNT,
  TENDER_KINDS,
  TendersDoNotCoverBasket,
} from './posting.ts'
import { tipLine } from './tip.ts'

/**
 * The posting rule: five accounts, one balanced entry, and three identities that hold to the fils.
 *
 * Every figure asserted below is **computed by hand in this file**, from the price and the rate, and
 * written out as a constant with the arithmetic beside it. That is the point: a test that compared the
 * entry against `checkoutPosting`'s own idea of the total would pass against an implementation that
 * posted the same wrong number twice.
 *
 * Every property has a control beside it that must fail, because an implementation that returned an
 * empty entry would satisfy "debits equal credits" on every generated basket. The controls that cannot
 * be written as assertions — breaking a shipped file and watching this file go red — are known-bad
 * fixtures in `scripts/test-gates.mjs`, cases 81a-81h.
 */

const CHART = STANDARD_SPA_CHART
const ENTRY_ID: EntryId = entryId('je-mtill06-1')
const ENTRY_DATE = localDate('2026-09-19')

// --- the worked example, in full ----------------------------------------------------------------
//
// AED 262.50 is a real menu price and does not divide evenly by 1.05, which is what makes it worth
// using: every figure below is a rounding decision somebody could get wrong.
//
//   gross                 26_250
//   net    = roundHalfUp(26_250 x 10_000 / 10_500) = roundHalfUp(25_000)   = 25_000
//   vat    = 26_250 - 25_000                                                =  1_250
//
// 10% off, rounded half-up on the DISCOUNT (discount.ts), then subtracted:
//
//   discount = roundHalfUp(26_250 x 1_000 / 10_000)                         =  2_625
//   charged  = 26_250 - 2_625                                               = 23_625
//   net'     = roundHalfUp(23_625 x 10_000 / 10_500) = roundHalfUp(22_500)  = 22_500
//   vat'     = 23_625 - 22_500                                              =  1_125
//
// so the DISCOUNT line carries the DIFFERENCE: net -2_500 and VAT -125, which sum to its gross of
// -2_625. Plus a gratuity of AED 30.00, which is taxed nowhere.
const MENU_GROSS = 26_250
const MENU_NET = 25_000
const MENU_VAT = 1_250
const DISCOUNT_GROSS = 2_625
const DISCOUNT_NET = 2_500
const DISCOUNT_VAT = 125
const CHARGED_GROSS = 23_625
const CHARGED_NET = 22_500
const CHARGED_VAT = 1_125
const TIP = 3_000
/** What the customer hands over: the discounted treatment plus the gratuity. */
const TENDERED = CHARGED_GROSS + TIP

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

const basketOf = (lines: readonly BasketLineDraft[], id = 'basket-1'): Basket =>
  buildBasket({ basketId: basketId(id), customerId: 'cust-1', lines }, CHART)

const cash = (fils: number): TenderLine => ({ kind: 'cash', amount: money(filsFrom(fils)) })

const posting = (basket: Basket, tenders: readonly TenderLine[]): CheckoutPosting =>
  checkoutPosting({ entryId: ENTRY_ID, entryDate: ENTRY_DATE, basket, tenders }, CHART)

/** The one line posting to `code`, or `undefined`. Exactly one per account is a property below. */
const lineOn = (p: CheckoutPosting, code: string): JournalLine | undefined =>
  p.entry.lines.find((line) => (line.account as string) === code)

/** The treatment, 10% off, and a gratuity — the basket the worked example describes. */
function workedBasket(): Basket {
  return basketOf([
    serviceLineFromAppointment('line-1', snapshot()),
    discountLine({
      lineId: 'disc-1',
      targetLineId: 'line-1',
      reason: 'service_recovery',
      kind: 'percentage_bp',
      value: 1_000,
      note: 'Room was cold at the start of the treatment',
    }),
    tipLine({ lineId: 'tip-1', gross: money(filsFrom(TIP)), beneficiaryEmployeeId: 'emp-1' }),
  ])
}

describe('the basket the worked example describes, posted', () => {
  it('moves exactly the five accounts, in the directions and amounts computed by hand', () => {
    const p = posting(workedBasket(), [cash(TENDERED)])

    // The control for every figure below: the basket really does hold the hand-computed figures, so an
    // assertion about the ENTRY is about the posting rule rather than about the basket agreeing with
    // itself.
    expect(p.tenderTotal.fils).toBe(TENDERED)
    expect(p.invoiceGross.fils).toBe(CHARGED_GROSS)
    expect(p.invoiceNet.fils).toBe(CHARGED_NET)
    expect(p.invoiceVat.fils).toBe(CHARGED_VAT)
    expect(p.tipTotal.fils).toBe(TIP)

    expect(lineOn(p, ACCOUNTS.cashInDrawer)).toMatchObject({
      debitFils: TENDERED,
      creditFils: 0,
    })
    // The service line's net at the price it was SOLD at — not the discounted net. Gross takings and
    // discounts given are two figures, which is the whole reason 4095 exists.
    expect(lineOn(p, ACCOUNTS.treatmentRevenue)).toMatchObject({
      debitFils: 0,
      creditFils: MENU_NET,
    })
    expect(lineOn(p, ACCOUNTS.discountsAndAllowances)).toMatchObject({
      debitFils: DISCOUNT_NET,
      creditFils: 0,
    })
    // 1_250 credited by the supply and 125 debited by the discount, merged into one line: the VAT on
    // what was actually charged.
    expect(lineOn(p, OUTPUT_VAT_ACCOUNT)).toMatchObject({
      debitFils: 0,
      creditFils: MENU_VAT - DISCOUNT_VAT,
    })
    expect(MENU_VAT - DISCOUNT_VAT).toBe(CHARGED_VAT)
    // The identity that makes the entry balance without a correction anywhere: the discount's net and
    // VAT sum to its own gross, exactly, because `applyDiscounts` derives both as differences.
    expect(DISCOUNT_NET + DISCOUNT_VAT).toBe(DISCOUNT_GROSS)
    expect(MENU_GROSS - DISCOUNT_GROSS).toBe(CHARGED_GROSS)
    expect(lineOn(p, ACCOUNTS.tipsPayable)).toMatchObject({ debitFils: 0, creditFils: TIP })

    // Five accounts and no sixth. A line on an account this test does not name would be money going
    // somewhere nobody asked it to.
    expect(p.entry.lines.map((line) => line.account as string)).toEqual([
      ACCOUNTS.cashInDrawer as string,
      OUTPUT_VAT_ACCOUNT as string,
      ACCOUNTS.tipsPayable as string,
      ACCOUNTS.treatmentRevenue as string,
      ACCOUNTS.discountsAndAllowances as string,
    ])
  })

  it('balances at 29_125 a side, which is the sum computed by hand', () => {
    const p = posting(workedBasket(), [cash(TENDERED)])
    // Debits:  26_625 tendered + 2_500 discount net            = 29_125
    // Credits: 25_000 revenue  + 1_125 output VAT + 3_000 tips  = 29_125
    const debits = TENDERED + DISCOUNT_NET
    const credits = MENU_NET + CHARGED_VAT + TIP
    expect(debits).toBe(29_125)
    expect(credits).toBe(29_125)
    expect(p.entry.lines.reduce((total, line) => total + line.debitFils, 0)).toBe(debits)
    expect(p.entry.lines.reduce((total, line) => total + line.creditFils, 0)).toBe(credits)
    expect(isBalanced(p.entry)).toBe(true)
  })

  it('reconciles on all three identities, and the control detects each one broken', () => {
    const p = posting(workedBasket(), [cash(TENDERED)])
    expect(reconcilePosting(p, CHART)).toEqual({
      imbalanceFils: 0,
      revenueVersusInvoiceNetFils: 0,
      vatVersusInvoiceVatFils: 0,
      tenderVersusInvoiceAndTipsFils: 0,
    })

    // The controls. Each mutates ONE figure of an otherwise correct posting by one fils and asserts the
    // matching field notices — because `{ 0, 0, 0, 0 }` is also what a reconciliation that measured
    // nothing would return.
    const off = (patch: Partial<CheckoutPosting>): CheckoutPosting =>
      ({ ...p, ...patch }) as CheckoutPosting
    expect(
      reconcilePosting(off({ invoiceNet: money(filsFrom(CHARGED_NET + 1)) }), CHART)
        .revenueVersusInvoiceNetFils,
    ).toBe(-1)
    expect(
      reconcilePosting(off({ invoiceVat: money(filsFrom(CHARGED_VAT - 1)) }), CHART)
        .vatVersusInvoiceVatFils,
    ).toBe(1)
    expect(
      reconcilePosting(off({ tipTotal: money(filsFrom(TIP + 1)) }), CHART)
        .tenderVersusInvoiceAndTipsFils,
    ).toBe(-1)
    // And the imbalance, against an entry with a line removed. `imbalanceFils` is the ledger kernel's
    // own measure, so the control proves the reconciliation reads the entry rather than a summary.
    const short = {
      ...p.entry,
      lines: p.entry.lines.filter((line) => (line.account as string) !== ACCOUNTS.tipsPayable),
    }
    expect(reconcilePosting({ ...p, entry: short } as CheckoutPosting, CHART).imbalanceFils).toBe(
      imbalanceFils(short.lines),
    )
    expect(imbalanceFils(short.lines)).toBe(TIP)
  })

  it('names the basket, counts its lines, and dates the entry on the day the caller resolved', () => {
    const p = posting(workedBasket(), [cash(TENDERED)])
    expect(p.entry.entryDate).toBe(ENTRY_DATE)
    expect(p.entry.source).toBe('sale')
    expect(p.entry.narrative).toContain('basket-1')
    expect(p.entry.narrative).toContain('1 treatment(s)')
    expect(p.entry.narrative).toContain('1 discount(s)')
    expect(p.entry.reverses).toBeNull()
  })
})

describe('the 11-fils probe: a discount that relieves exactly the VAT charged', () => {
  /**
   * The smallest amount at which the two possible treatments of a discount's tax disagree.
   *
   * 11 fils gross carries 1 fils of VAT. Take 5 fils off and 6 fils is charged, which carries **none**:
   * roundHalfUp(6 x 10_000 / 10_500) = roundHalfUp(5.714) = 6, so net 6 and VAT 0. The discount line
   * therefore carries net -4 and VAT -1, and the output VAT account's debits and credits cancel exactly.
   *
   * The entry must then have NO line on 2030 at all. A zero line is refused by
   * `journal_line_exactly_one_side` in the database, and an entry carrying "1 fils of output VAT" on a
   * supply the customer paid 6 fils for is the figure M-TILL-05's `vatIfDiscountTaxedSeparately` names
   * so that a test can look for it and not find it.
   */
  const probe = (): Basket =>
    basketOf(
      [
        serviceLineFromAppointment('line-1', snapshot({}, 11)),
        discountLine({
          lineId: 'disc-1',
          targetLineId: 'line-1',
          reason: 'manager_goodwill',
          kind: 'absolute_fils',
          value: 5,
        }),
      ],
      'basket-probe',
    )

  it('omits the output VAT line entirely, rather than posting a zero or a phantom fils', () => {
    const basket = probe()
    // The controls: the basket really is the probe, and the wrong answer really is 1.
    expect(basket.totals.grossTotal.fils).toBe(6)
    expect(basket.totals.netTotal.fils).toBe(6)
    expect(basket.totals.vatTotal.fils).toBe(0)

    const p = posting(basket, [cash(6)])
    expect(lineOn(p, OUTPUT_VAT_ACCOUNT)).toBeUndefined()
    expect(p.entry.lines.map((line) => line.account as string)).toEqual([
      ACCOUNTS.cashInDrawer as string,
      ACCOUNTS.treatmentRevenue as string,
      ACCOUNTS.discountsAndAllowances as string,
    ])
    // Dr 6 cash + Dr 4 discount = 10 = Cr 10 revenue. Computed by hand, as above.
    expect(p.entry.lines.reduce((total, line) => total + line.debitFils, 0)).toBe(10)
    expect(p.entry.lines.reduce((total, line) => total + line.creditFils, 0)).toBe(10)
    expect(reconcilePosting(p, CHART).vatVersusInvoiceVatFils).toBe(0)
    expect(p.invoiceVat.fils).toBe(0)
    // The figure that must appear nowhere. 1 fils is what taxing the discount on its own gross gives.
    expect(p.entry.lines.flatMap((line) => [line.debitFils, line.creditFils])).not.toContain(1)
  })
})

describe('what the rule refuses', () => {
  it('refuses tenders that do not add up to the basket, in both directions', () => {
    const basket = workedBasket()
    for (const tendered of [TENDERED - 1, TENDERED + 1]) {
      const thrown = (() => {
        try {
          posting(basket, [cash(tendered)])
          return null
        } catch (err) {
          return err
        }
      })()
      expect(thrown).toBeInstanceOf(TendersDoNotCoverBasket)
      expect((thrown as TendersDoNotCoverBasket).tenderedFils).toBe(tendered)
      expect((thrown as TendersDoNotCoverBasket).basketFils).toBe(TENDERED)
    }
    // The control: the exact figure is accepted, so the two refusals above are about the difference.
    expect(posting(basket, [cash(TENDERED)]).entry.lines.length).toBe(5)
  })

  it('refuses a basket with no tender at all', () => {
    expect(() => posting(workedBasket(), [])).toThrow(TendersDoNotCoverBasket)
  })

  it('refuses a zero, negative or fractional tender before it reaches a total', () => {
    const basket = workedBasket()
    for (const fils of [0, -TENDERED, 1.5]) {
      expect(() => posting(basket, [{ kind: 'cash', amount: { fils, currency: 'AED' } as Money }])) //
        .toThrow(MalformedTender)
    }
  })

  it('refuses a tender of an unknown kind rather than posting it nowhere', () => {
    // Reachable only through a cast, which is exactly what a JSON request body has been through.
    expect(() =>
      posting(workedBasket(), [
        { kind: 'crypto' as unknown as TenderKind, amount: money(filsFrom(TENDERED)) },
      ]),
    ).toThrow(MalformedTender)
  })

  it('refuses a basket made entirely of package redemptions', () => {
    const basket = basketOf(
      [
        packageRedemptionLine({
          lineId: 'red-1',
          appointmentId: 'appt-9',
          redeemedBalanceId: 'bal-1',
        }),
      ],
      'basket-redeemed',
    )
    // The control: the basket itself is legitimate and totals zero. It is the POSTING that has nothing
    // to do, because releasing 2050 into 4020 is M-TILL-09's and needs the balance, not this document.
    expect(basket.totals.grossTotal.fils).toBe(0)
    expect(basket.charges).toHaveLength(0)
    expect(() => posting(basket, [])).toThrow(NothingToPost)
  })

  it('refuses an account the chart does not contain, through the kernel rather than silently', () => {
    // A tender account outside the chart cannot be produced by TENDER_ACCOUNT, so the fixture reaches
    // past it — and the refusal must still come from `accountFor`, which is the one place a code is
    // checked against the chart the caller passed.
    const basket = workedBasket()
    const chartWithoutCash = {
      ...CHART,
      accounts: CHART.accounts.filter((account) => account.code !== ACCOUNTS.cashInDrawer),
    }
    expect(() =>
      checkoutPosting(
        { entryId: ENTRY_ID, entryDate: ENTRY_DATE, basket, tenders: [cash(TENDERED)] },
        chartWithoutCash,
      ),
    ).toThrow(/1010/)
  })
})

describe('every tender kind has a declared posting account', () => {
  it('maps each kind to an account the chart contains, and card money to the clearing account', () => {
    for (const kind of TENDER_KINDS) {
      const code = TENDER_ACCOUNT[kind]
      expect(code).toBeDefined()
      expect(CHART.accounts.some((account) => account.code === code)).toBe(true)
    }
    // Card money is NOT in the bank. The terminal settles in a batch, net of fees, days later, so
    // debiting 1020 would leave the bank reconciliation out by every unsettled batch.
    expect(TENDER_ACCOUNT.card_in_salon).toBe(ACCOUNTS.cardTerminalClearing)
    expect(TENDER_ACCOUNT.card_in_salon).not.toBe(ACCOUNTS.bankCurrent)
    expect(TENDER_ACCOUNT.cash).toBe(ACCOUNTS.cashInDrawer)
    expect(TENDER_ACCOUNT.bank_transfer).toBe(ACCOUNTS.bankCurrent)
    // The control for the loop: an account code that is NOT in the chart is detected, so the loop is
    // about the mapping rather than about `some` always finding something.
    expect(CHART.accounts.some((account) => account.code === accountCode('9999'))).toBe(false)
  })

  it('splits one basket across several tenders and debits each account its own share', () => {
    const basket = workedBasket()
    const p = posting(basket, [
      cash(1_000),
      { kind: 'card_in_salon', amount: money(filsFrom(20_000)), reference: 'APPROVAL-1' },
      { kind: 'bank_transfer', amount: money(filsFrom(TENDERED - 21_000)), reference: 'TT-1' },
    ])
    expect(lineOn(p, ACCOUNTS.cashInDrawer)?.debitFils).toBe(1_000)
    expect(lineOn(p, ACCOUNTS.cardTerminalClearing)?.debitFils).toBe(20_000)
    expect(lineOn(p, ACCOUNTS.bankCurrent)?.debitFils).toBe(TENDERED - 21_000)
    expect(1_000 + 20_000 + (TENDERED - 21_000)).toBe(TENDERED)
    expect(isBalanced(p.entry)).toBe(true)
    expect(p.tenders.map((tender) => tender.account as string)).toEqual([
      ACCOUNTS.cashInDrawer as string,
      ACCOUNTS.cardTerminalClearing as string,
      ACCOUNTS.bankCurrent as string,
    ])
  })

  it('merges two tenders of one kind into a single line on that account', () => {
    const p = posting(workedBasket(), [cash(1_000), cash(TENDERED - 1_000)])
    const cashLines = p.entry.lines.filter(
      (line) => (line.account as string) === (ACCOUNTS.cashInDrawer as string),
    )
    expect(cashLines).toHaveLength(1)
    expect(cashLines[0]?.debitFils).toBe(TENDERED)
    // Both tenders are still recorded individually — the merge is the JOURNAL's, not the till's.
    expect(p.tenders).toHaveLength(2)
  })
})

describe('over every generated basket', () => {
  /**
   * The generator produces baskets the rule must handle, not baskets that happen to work.
   *
   * Prices are drawn from 1 to 1_000_000 fils and discount percentages from 1 to 4_999 basis points, so
   * a generated case lands on the rounding boundary often. A discount that reduces nothing or exceeds
   * its line is refused by `buildBasket` before this rule sees it, so those draws are discarded rather
   * than asserted about — which is the basket's own contract and is tested in `basket.test.ts`.
   */
  const generated = fc
    .record({
      prices: fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 6 }),
      discountBp: fc.array(fc.integer({ min: 1, max: 4_999 }), { maxLength: 6 }),
      tip: fc.option(fc.integer({ min: 1, max: 50_000 }), { nil: undefined }),
      redemptions: fc.integer({ min: 0, max: 2 }),
    })
    .map(({ prices, discountBp, tip, redemptions }) => {
      const lines: BasketLineDraft[] = []
      prices.forEach((gross, index) => {
        lines.push(
          serviceLineFromAppointment(`line-${index}`, {
            ...snapshot({ appointmentId: `appt-${index}` }, gross),
          }),
        )
      })
      discountBp.forEach((value, index) => {
        const target = index % prices.length
        lines.push(
          discountLine({
            lineId: `disc-${index}`,
            targetLineId: `line-${target}`,
            reason: 'campaign',
            kind: 'percentage_bp',
            value,
          }),
        )
      })
      if (tip !== undefined) {
        lines.push({ ...tipLine({ lineId: 'tip-0', gross: money(filsFrom(tip)) }) })
      }
      for (let index = 0; index < redemptions; index += 1) {
        lines.push(
          packageRedemptionLine({
            lineId: `red-${index}`,
            appointmentId: `appt-red-${index}`,
            redeemedBalanceId: `bal-${index}`,
          }),
        )
      }
      return lines
    })

  const built = generated.map((lines) => {
    try {
      return basketOf(lines, 'basket-gen')
    } catch {
      return null
    }
  })

  it('always balances, and always reconciles on all three identities', () => {
    fc.assert(
      fc.property(built, (basket) => {
        if (basket === null) return true
        const p = posting(basket, [cash(basket.totals.grossTotal.fils)])
        expect(reconcilePosting(p, CHART)).toEqual({
          imbalanceFils: 0,
          revenueVersusInvoiceNetFils: 0,
          vatVersusInvoiceVatFils: 0,
          tenderVersusInvoiceAndTipsFils: 0,
        })
        // The control that stops this passing vacuously: the entry has real lines, and a cash debit
        // equal to the basket. An implementation returning an empty entry would balance perfectly.
        expect(p.entry.lines.length).toBeGreaterThanOrEqual(2)
        expect(lineOn(p, ACCOUNTS.cashInDrawer)?.debitFils).toBe(basket.totals.grossTotal.fils)
        return true
      }),
      { numRuns: 400 },
    )
  })

  it('never puts a gratuity in a revenue account and never taxes one', () => {
    fc.assert(
      fc.property(built, (basket) => {
        if (basket === null) return true
        if (basket.totals.tipTotal.fils === 0) return true
        const p = posting(basket, [cash(basket.totals.grossTotal.fils)])
        expect(lineOn(p, ACCOUNTS.tipsPayable)?.creditFils).toBe(basket.totals.tipTotal.fils)
        // The VAT credited is the tax on the CHARGED supply and owes nothing to the tip, whatever it
        // was. Asserted against the basket's own VAT total, which the tip contributes nothing to.
        expect(p.invoiceVat.fils).toBe(basket.totals.vatTotal.fils)
        expect(p.invoiceGross.fils + basket.totals.tipTotal.fils).toBe(
          basket.totals.grossTotal.fils,
        )
        return true
      }),
      { numRuns: 400 },
    )
  })

  it('posts at most one line per account, and never a zero one', () => {
    fc.assert(
      fc.property(built, (basket) => {
        if (basket === null) return true
        const p = posting(basket, [cash(basket.totals.grossTotal.fils)])
        const codes = p.entry.lines.map((line) => line.account as string)
        expect(new Set(codes).size).toBe(codes.length)
        // Sorted by account code, so two runs over one basket produce identical working papers.
        expect(codes).toEqual([...codes].sort())
        for (const line of p.entry.lines) {
          expect(line.debitFils === 0).not.toBe(line.creditFils === 0)
        }
        return true
      }),
      { numRuns: 400 },
    )
  })

  it('refuses a basket whose redemptions leave nothing to charge for, however many there are', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (redemptions) => {
        const lines: BasketLineDraft[] = []
        for (let index = 0; index < redemptions; index += 1) {
          lines.push(
            packageRedemptionLine({
              lineId: `red-${index}`,
              appointmentId: `appt-red-${index}`,
              redeemedBalanceId: `bal-${index}`,
            }),
          )
        }
        expect(() => posting(basketOf(lines, 'basket-red'), [])).toThrow(NothingToPost)
        return true
      }),
      { numRuns: 20 },
    )
  })
})

describe('a narrative is required, because an append-only entry nobody can read is not evidence', () => {
  it('refuses a blank one rather than posting an unreadable entry', () => {
    expect(() =>
      checkoutPosting(
        {
          entryId: ENTRY_ID,
          entryDate: ENTRY_DATE,
          basket: workedBasket(),
          tenders: [cash(TENDERED)],
          narrative: '   ',
        },
        CHART,
      ),
    ).toThrow(MalformedEntry)
  })

  it('uses the caller’s narrative when it is given one', () => {
    const p = checkoutPosting(
      {
        entryId: ENTRY_ID,
        entryDate: ENTRY_DATE,
        basket: workedBasket(),
        tenders: [cash(TENDERED)],
        narrative: 'Evening till, station 2',
      },
      CHART,
    )
    expect(p.entry.narrative).toBe('Evening till, station 2')
  })
})

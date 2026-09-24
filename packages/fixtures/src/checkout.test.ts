import type { Basket, BasketLineDraft, TenderLine } from '@berelax/core'
import {
  basketId,
  buildBasket,
  discountLine,
  entryId,
  filsFrom,
  instantFromIso,
  money,
  packageRedemptionLine,
  reconcilePosting,
  STANDARD_SPA_CHART,
  serviceLineFromAppointment,
  splitGross,
  tipLine,
  vatIfReDerivedFromTotal,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  assertMappingReconciles,
  type CheckoutMappingInput,
  checkoutMapping,
  reconcileCheckoutMapping,
} from './checkout.ts'

/**
 * The core-to-db mapping: field for field, and reconciled before anything is written.
 *
 * Every figure asserted here is computed by hand from the price and the rate. The two probes are the
 * two documents that matter: one real menu price, where the two possible derivations agree, and the
 * eleven-fils pair, where they do NOT — 22 fils of lines carry 2 fils of VAT and a split of the 22-fils
 * total gives 1. The second probe is the whole reason this file exists, because a mapping that summed
 * the document total instead would pass every assertion on the first.
 */

/** 19:00 on a trading day, invoiced the same evening. Trading runs 11:00-02:00. */
const SUPPLY_AT = instantFromIso('2026-09-19T19:00:00+04:00')
const ISSUED_AT = instantFromIso('2026-09-19T21:30:00+04:00')
/** 01:30 belongs to the PREVIOUS trading date, and the document raised at noon keeps that tax point. */
const SUPPLY_AT_0130 = instantFromIso('2026-09-20T01:30:00+04:00')
const ISSUED_AT_NOON = instantFromIso('2026-09-20T12:00:00+04:00')

const MENU_GROSS = 26_250
const MENU_NET = 25_000
const MENU_VAT = 1_250

function serviceLine(
  lineId: string,
  appointmentId: string,
  grossFils = MENU_GROSS,
): BasketLineDraft {
  const split = splitGross(money(filsFrom(grossFils)))
  return serviceLineFromAppointment(lineId, {
    appointmentId,
    serviceVariantId: 'variant-1',
    status: 'completed',
    description: 'Normal Massage (Asian), 60 min',
    gross: split.gross,
    net: split.net,
    vat: split.vat,
    vatRateBp: split.rateBp,
    priceListId: null,
    promotionId: null,
  })
}

const basketOf = (lines: readonly BasketLineDraft[]): Basket =>
  buildBasket(
    { basketId: basketId('basket-map-1'), customerId: 'cust-1', lines },
    STANDARD_SPA_CHART,
  )

const cash = (fils: number): TenderLine => ({ kind: 'cash', amount: money(filsFrom(fils)) })

function mapping(
  basket: Basket,
  tenders: readonly TenderLine[],
  overrides: Partial<CheckoutMappingInput> = {},
) {
  return checkoutMapping({
    basket,
    tenders,
    entryId: entryId('je-map-1'),
    idempotencyKey: 'till-request-1',
    requestFingerprint: 'fp-1',
    supplyAt: SUPPLY_AT,
    issuedAt: ISSUED_AT,
    origins: basket.charges.map((charge) => ({
      lineId: charge.lineId as string,
      appointmentId: `appt-${charge.lineId}`,
    })),
    ...overrides,
  })
}

describe('one treatment at a real menu price', () => {
  it('copies the charged gross onto the line and sums the lines into the header', () => {
    const basket = basketOf([serviceLine('line-1', 'appt-1')])
    const { input, posting } = mapping(basket, [cash(MENU_GROSS)])

    expect(input.invoice.lines).toEqual([
      {
        descriptionEn: 'Normal Massage (Asian), 60 min',
        quantity: 1,
        unitGrossFils: MENU_GROSS,
        vatRateBp: 500,
        netFils: MENU_NET,
        vatFils: MENU_VAT,
      },
    ])
    expect(input.invoice.netTotalFils).toBe(MENU_NET)
    expect(input.invoice.vatTotalFils).toBe(MENU_VAT)
    expect(input.invoice.grossTotalFils).toBe(MENU_GROSS)
    expect(input.invoice.netTotalFils + input.invoice.vatTotalFils).toBe(MENU_GROSS)
    // And the basket's own figures agree, which is what makes the mapping a copy rather than a
    // second opinion.
    expect(posting.invoiceGross.fils).toBe(MENU_GROSS)
    expect(posting.invoiceVat.fils).toBe(MENU_VAT)
  })

  it('maps the entry field for field and reconciles on every difference', () => {
    const basket = basketOf([serviceLine('line-1', 'appt-1')])
    const built = mapping(basket, [cash(MENU_GROSS)])
    expect(built.input.journal.entryId).toBe('je-map-1')
    expect(built.input.journal.source).toBe('sale')
    expect(built.input.journal.entryDate).toBe('2026-09-19')
    expect(built.input.journal.lines.map((line) => line.accountCode)).toEqual([
      '1010',
      '2030',
      '4010',
    ])
    expect(built.input.journal.lines.map((line) => line.debitFils)).toEqual([MENU_GROSS, 0, 0])
    expect(built.input.journal.lines.map((line) => line.creditFils)).toEqual([
      0,
      MENU_VAT,
      MENU_NET,
    ])
    expect(built.input.tenders).toEqual([
      { tenderKind: 'cash', postingAccountCode: '1010', amountFils: MENU_GROSS },
    ])
    expect(built.input.appointments).toEqual([{ appointmentId: 'appt-line-1', lineNo: 1 }])

    expect(reconcileCheckoutMapping(built)).toEqual({
      documentNetVersusLinesFils: 0,
      documentVatVersusLinesFils: 0,
      documentGrossVersusBasketFils: 0,
      entryImbalanceFils: 0,
      tendersVersusEntryFils: 0,
    })
    expect(reconcilePosting(built.posting, STANDARD_SPA_CHART)).toEqual({
      imbalanceFils: 0,
      revenueVersusInvoiceNetFils: 0,
      vatVersusInvoiceVatFils: 0,
      tenderVersusInvoiceAndTipsFils: 0,
    })
    expect(assertMappingReconciles(built)).toBe(built)
  })

  it('keeps the supply’s trading date as the tax point when the document is raised next day', () => {
    const basket = basketOf([serviceLine('line-1', 'appt-1')])
    const { input, tradingDate } = mapping(basket, [cash(MENU_GROSS)], {
      supplyAt: SUPPLY_AT_0130,
      issuedAt: ISSUED_AT_NOON,
    })
    // 01:30 on the 20th belongs to the 19th's trading date; the document is issued on the 20th.
    expect(input.invoice.taxPointDate).toBe('2026-09-19')
    expect(input.invoice.issueDate).toBe('2026-09-20')
    // The journal is dated on the trading day the MONEY was taken, which is the 20th at noon.
    expect(input.invoice.issueTradingDate).toBe('2026-09-20')
    expect(tradingDate).toBe('2026-09-20')
    expect(input.tradingDate).toBe('2026-09-20')
  })
})

describe('the eleven-fils pair: the mapping must sum the lines, not split the total', () => {
  /**
   * Two lines at 11 fils gross. Per line: 11 - roundHalfUp(11 x 20 / 21) = 11 - 10 = 1 fils of VAT, so
   * the document carries **2**. Splitting the 22-fils total gives 22 - 21 = **1**, which is the figure
   * that must appear nowhere — `vatIfReDerivedFromTotal` names it so a test can look for it.
   */
  const probe = (): Basket =>
    basketOf([serviceLine('line-1', 'appt-1', 11), serviceLine('line-2', 'appt-2', 11)])

  it('stores 2 fils of VAT, and the re-derived 1 appears on no field', () => {
    const basket = probe()
    const { input, posting } = mapping(basket, [cash(22)])

    expect(input.invoice.lines.map((line) => line.vatFils)).toEqual([1, 1])
    expect(input.invoice.vatTotalFils).toBe(2)
    expect(input.invoice.netTotalFils).toBe(20)
    expect(input.invoice.grossTotalFils).toBe(22)

    // The wrong answer, named. Both controls: it really is 1, and it is not what the mapping produced.
    const reDerived = vatIfReDerivedFromTotal(money(filsFrom(22)))
    expect(reDerived.fils).toBe(1)
    expect(input.invoice.vatTotalFils).not.toBe(reDerived.fils)
    // And the journal credits the same 2 fils of output VAT, so the two halves cannot disagree.
    const vatLine = input.journal.lines.find((line) => line.accountCode === '2030')
    expect(vatLine?.creditFils).toBe(2)
    expect(posting.invoiceVat.fils).toBe(2)
    expect(reconcileCheckoutMapping({ ...mapping(basket, [cash(22)]) })).toEqual({
      documentNetVersusLinesFils: 0,
      documentVatVersusLinesFils: 0,
      documentGrossVersusBasketFils: 0,
      entryImbalanceFils: 0,
      tendersVersusEntryFils: 0,
    })
  })
})

describe('discounts, gratuities and redemptions', () => {
  it('states the discounted price on the document and the discount in the journal', () => {
    // 10% off 26_250: discount 2_625, charged 23_625, net 22_500, VAT 1_125 — all by hand.
    const basket = basketOf([
      serviceLine('line-1', 'appt-1'),
      discountLine({
        lineId: 'disc-1',
        targetLineId: 'line-1',
        reason: 'service_recovery',
        kind: 'percentage_bp',
        value: 1_000,
      }),
    ])
    const { input } = mapping(basket, [cash(23_625)])

    // ONE invoice line, at the reduced price. `invoice_line.unit_gross_fils` is a `fils_nonneg` domain,
    // so a negative discount line could not be stored at all.
    expect(input.invoice.lines).toHaveLength(1)
    expect(input.invoice.lines[0]?.unitGrossFils).toBe(23_625)
    expect(input.invoice.lines[0]?.vatFils).toBe(1_125)
    expect(input.invoice.grossTotalFils).toBe(23_625)

    // The journal keeps both figures: revenue at the price it was sold at, and the reduction in 4095.
    const byAccount = new Map(
      input.journal.lines.map((line) => [line.accountCode, line.creditFils - line.debitFils]),
    )
    expect(byAccount.get('4010')).toBe(MENU_NET)
    expect(byAccount.get('4095')).toBe(-(MENU_NET - 22_500))
    expect(byAccount.get('2030')).toBe(1_125)
    expect(assertMappingReconciles(mapping(basket, [cash(23_625)]))).toBeDefined()
  })

  it('leaves the gratuity off the document and in the liability', () => {
    const basket = basketOf([
      serviceLine('line-1', 'appt-1'),
      tipLine({ lineId: 'tip-1', gross: money(filsFrom(3_000)) }),
    ])
    const { input } = mapping(basket, [cash(MENU_GROSS + 3_000)])
    // The document is the taxable supply only: a gratuity is not consideration for one.
    expect(input.invoice.grossTotalFils).toBe(MENU_GROSS)
    expect(input.invoice.lines).toHaveLength(1)
    const byAccount = new Map(
      input.journal.lines.map((line) => [line.accountCode, line.creditFils - line.debitFils]),
    )
    expect(byAccount.get('2040')).toBe(3_000)
    expect(byAccount.get('2030')).toBe(MENU_VAT)
    // The tenders cover both, which is why the reconciliation compares them to the entry and not to the
    // document.
    expect(reconcileCheckoutMapping(mapping(basket, [cash(MENU_GROSS + 3_000)]))).toMatchObject({
      tendersVersusEntryFils: 0,
      documentGrossVersusBasketFils: 0,
    })
  })

  it('links a redeemed appointment with no line number, because the document does not state it', () => {
    const basket = basketOf([
      serviceLine('line-1', 'appt-1'),
      packageRedemptionLine({
        lineId: 'red-1',
        appointmentId: 'appt-redeemed',
        redeemedBalanceId: 'bal-1',
      }),
    ])
    const built = checkoutMapping({
      basket,
      tenders: [cash(MENU_GROSS)],
      entryId: entryId('je-map-2'),
      idempotencyKey: 'till-request-2',
      requestFingerprint: 'fp-2',
      supplyAt: SUPPLY_AT,
      issuedAt: ISSUED_AT,
      origins: [
        { lineId: 'line-1', appointmentId: 'appt-1' },
        { lineId: 'red-1', appointmentId: 'appt-redeemed' },
      ],
    })
    expect(built.input.appointments).toEqual([
      { appointmentId: 'appt-1', lineNo: 1 },
      { appointmentId: 'appt-redeemed' },
    ])
    // Both appointments are protected by `invoice_appointment_appointment_once`, which is the point: a
    // redemption that was also invoiced for cash would charge the customer twice.
    expect(built.input.invoice.lines).toHaveLength(1)
    expect(built.input.invoice.grossTotalFils).toBe(MENU_GROSS)
  })
})

describe('the reconciliation is a check and not a formality', () => {
  it('detects each half broken by one fils, which is the control for the zeros above', () => {
    const basket = basketOf([serviceLine('line-1', 'appt-1')])
    const built = mapping(basket, [cash(MENU_GROSS)])

    const broken = (patch: Record<string, unknown>) =>
      reconcileCheckoutMapping({
        ...built,
        input: { ...built.input, ...patch },
      } as typeof built)

    expect(
      broken({ invoice: { ...built.input.invoice, netTotalFils: MENU_NET + 1 } })
        .documentNetVersusLinesFils,
    ).toBe(1)
    expect(
      broken({ invoice: { ...built.input.invoice, vatTotalFils: MENU_VAT - 1 } })
        .documentVatVersusLinesFils,
    ).toBe(-1)
    expect(
      broken({ invoice: { ...built.input.invoice, grossTotalFils: MENU_GROSS + 1 } })
        .documentGrossVersusBasketFils,
    ).toBe(1)
    expect(
      broken({
        journal: {
          ...built.input.journal,
          lines: built.input.journal.lines.map((line) =>
            line.accountCode === '1010' ? { ...line, debitFils: line.debitFils + 1 } : line,
          ),
        },
      }).entryImbalanceFils,
    ).toBe(1)
    expect(
      broken({
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: MENU_GROSS - 1 }],
      }).tendersVersusEntryFils,
    ).toBe(-1)
  })

  it('throws, naming the field and the difference, when a mapping does not reconcile', () => {
    const basket = basketOf([serviceLine('line-1', 'appt-1')])
    const built = mapping(basket, [cash(MENU_GROSS)])
    const wrong = {
      ...built,
      input: {
        ...built.input,
        invoice: { ...built.input.invoice, vatTotalFils: MENU_VAT + 3 },
      },
    } as typeof built
    expect(() => assertMappingReconciles(wrong)).toThrow(/documentVatVersusLinesFils is out by 3/)
  })

  it('refuses a supply instant that belongs to no trading date', () => {
    const basket = basketOf([serviceLine('line-1', 'appt-1')])
    // 09:00 is before the 11:00 open, so the instant belongs to no trading date at all.
    expect(() =>
      mapping(basket, [cash(MENU_GROSS)], {
        supplyAt: instantFromIso('2026-09-19T09:00:00+04:00'),
        issuedAt: instantFromIso('2026-09-19T09:30:00+04:00'),
      }),
    ).toThrow(/belongs to no trading date/)
  })
})

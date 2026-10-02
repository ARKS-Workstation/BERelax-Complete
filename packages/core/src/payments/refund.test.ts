import { describe, expect, it } from 'vitest'
import {
  CHARGEBACK_CLEARING_ACCOUNT,
  CHARGEBACK_KINDS,
  CHARGEBACK_LOSS_ACCOUNT,
  ChargebackIsOutsideTrading,
  chargebackLostEntry,
  chargebackNetEffectFils,
  chargebackReceivedEntry,
  chargebackTradingDate,
  chargebackWonEntry,
  chargedBackNetFils,
} from '../ledger/chargeback.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { EntryId } from '../ledger/entry.ts'
import { entryId } from '../ledger/entry.ts'
import { BackdatedReversal } from '../ledger/reverse.ts'
import type { LocalDate } from '../time.ts'
import { instantFromIso, localDate } from '../time.ts'
import {
  assertRefundPermitted,
  isRefundPermitted,
  partialRefundPlan,
  REFUNDABLE_INTENT_STATES,
  RefundExceedsRefundable,
  RefundIsNotAFigure,
  RefundOfAnUncapturedIntent,
  refundableFils,
} from './refund.ts'

/**
 * Y-PAY-08's arithmetic: what is refundable, where a dispute posts, and which business day it belongs to.
 *
 * The property suite beside this one covers the SEQUENCES. What this file covers is each claim once, with
 * the control that stops it passing vacuously — and in particular the three refusals the acceptance lines
 * name, each paired with the input that must get past it.
 */

const CHART = STANDARD_SPA_CHART
const DAY: LocalDate = localDate('2099-06-01')
const NEXT_DAY: LocalDate = localDate('2099-06-03')

/** Trading hours as every other suite in this build spells them: 11:00 to 02:00. */
const HOURS = { open: '11:00' as never, close: '02:00' as never }
const hoursFor = (): typeof HOURS => HOURS
const noHours = (): undefined => undefined

describe('refundableFils', () => {
  it('subtracts refunds AND chargebacks from the capture', () => {
    expect(
      refundableFils({ capturedFils: 10_000, refundedFils: 2_000, chargedBackFils: 3_000 }),
    ).toBe(5_000)
  })

  it('counts a disputed amount as gone, which `refunded <= captured` alone does not', () => {
    // The whole reason the cap is three figures. This position satisfies payment_intent's own CHECK
    // perfectly — nothing has been refunded at all — and there is nevertheless nothing left to give back.
    expect(refundableFils({ capturedFils: 10_000, refundedFils: 0, chargedBackFils: 10_000 })).toBe(
      0,
    )
    // And the control: the same capture with no dispute is fully refundable, so the zero above is the
    // dispute's doing and not a function that answers nought.
    expect(refundableFils({ capturedFils: 10_000, refundedFils: 0, chargedBackFils: 0 })).toBe(
      10_000,
    )
  })

  it('clamps at nought rather than publishing a negative remainder', () => {
    expect(refundableFils({ capturedFils: 1_000, refundedFils: 800, chargedBackFils: 800 })).toBe(0)
  })
})

describe('assertRefundable', () => {
  const position = { capturedFils: 10_000, refundedFils: 2_000, chargedBackFils: 0 }

  it('permits a refund of exactly what remains', () => {
    expect(() =>
      assertRefundPermitted({
        intentRef: 'intent-under-test',
        state: 'captured',
        ...position,
        requestedFils: 8_000,
      }),
    ).not.toThrow()
  })

  it('refuses one fil more than remains, and names both figures', () => {
    let caught: unknown
    try {
      assertRefundPermitted({
        intentRef: 'intent-under-test',
        state: 'captured',
        ...position,
        requestedFils: 8_001,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RefundExceedsRefundable)
    expect((caught as RefundExceedsRefundable).refundableFils).toBe(8_000)
    expect((caught as RefundExceedsRefundable).requestedFils).toBe(8_001)
  })

  it('refuses a refund of an intent that captured nothing, for every such state', () => {
    for (const state of [
      'requires_authorisation',
      'requires_customer_action',
      'authorised',
      'voided',
      'failed',
    ]) {
      expect(() =>
        assertRefundPermitted({
          intentRef: 'intent-under-test',
          state,
          capturedFils: 0,
          refundedFils: 0,
          chargedBackFils: 0,
          requestedFils: 1,
        }),
      ).toThrow(RefundOfAnUncapturedIntent)
    }
    // The control: `captured` gets past the state gate, so the refusals above are about the STATE and
    // not about the function throwing for everything. ADR 0056's lifecycle is exhaustive, and this is
    // the one member that admits a refund.
    expect([...REFUNDABLE_INTENT_STATES]).toEqual(['captured'])
    expect(
      isRefundPermitted({
        intentRef: 'intent-under-test',
        state: 'captured',
        capturedFils: 1,
        refundedFils: 0,
        chargedBackFils: 0,
        requestedFils: 1,
      }),
    ).toBe(true)
  })

  it('refuses a refund that is not a figure, including a negative one', () => {
    for (const bad of [0, -1, -5_000, 1.5, Number.NaN]) {
      expect(() =>
        assertRefundPermitted({
          intentRef: 'intent-under-test',
          state: 'captured',
          ...position,
          requestedFils: bad,
        }),
      ).toThrow(RefundIsNotAFigure)
    }
  })

  it('refuses an unknown state rather than admitting it', () => {
    // A sixth state added to ADR 0056's lifecycle must not become refundable by default: the set is
    // stated as a value, so an addition is refused until somebody decides.
    expect(() =>
      assertRefundPermitted({
        intentRef: 'intent-under-test',
        state: 'partially_captured',
        ...position,
        requestedFils: 1,
      }),
    ).toThrow(RefundOfAnUncapturedIntent)
  })
})

describe('partialRefundPlan', () => {
  it('produces a credit note AND a dated reversal, and names what remains', () => {
    const plan = partialRefundPlan({
      request: {
        intentRef: 'intent-under-test',
        state: 'captured',
        capturedFils: 26_250,
        refundedFils: 0,
        chargedBackFils: 0,
        requestedFils: 10_000,
      },
      invoiceId: 'invoice-under-test',
      invoiceLineNo: 2,
      reversesEntryId: 'SALE-1',
    })
    // The acceptance line is about the PAIR existing, so both are fields rather than implications.
    expect(plan.producesCreditNote).toBe(true)
    expect(plan.producesDatedReversal).toBe(true)
    expect(plan.reversesEntryId).toBe('SALE-1')
    expect(plan.refundFils).toBe(10_000)
    expect(plan.remainingRefundableFils).toBe(16_250)
    expect(plan.invoiceLineNo).toBe(2)
  })

  it('refuses rather than planning a refund that cannot be made', () => {
    expect(() =>
      partialRefundPlan({
        request: {
          intentRef: 'intent-under-test',
          state: 'captured',
          capturedFils: 1_000,
          refundedFils: 0,
          chargedBackFils: 1_000,
          requestedFils: 1,
        },
        invoiceId: 'invoice-under-test',
        invoiceLineNo: 1,
        reversesEntryId: 'SALE-1',
      }),
    ).toThrow(RefundExceedsRefundable)
  })
})

describe('a chargeback entry', () => {
  const event = {
    entryId: entryId('CB-1') as EntryId,
    entryDate: DAY,
    intentRef: 'intent-under-test',
    disputeRef: 'D-1',
    amountFils: 4_000,
  }

  it('posts to the disputed-receivable clearing account and to nothing else of substance', () => {
    const entry = chargebackReceivedEntry(event, CHART)
    expect(CHARGEBACK_CLEARING_ACCOUNT).toBe(ACCOUNTS.disputedCardReceipts)
    const accounts = entry.lines.map((l) => l.account).sort()
    expect(accounts).toEqual([ACCOUNTS.gatewayClearing, ACCOUNTS.disputedCardReceipts].sort())
    // A chargeback is NOT a cancelled sale: the treatment was delivered and the invoice stands. So no
    // revenue account and no output VAT appears, and asserting it over the whole chart is what makes
    // that a claim rather than a hope.
    const touched = new Set(entry.lines.map((l) => l.account as string))
    for (const account of CHART.accounts) {
      if (account.type !== 'revenue' && account.code !== ACCOUNTS.outputVatPayable) continue
      expect(touched.has(account.code as string)).toBe(false)
    }
    // And the source distinguishes it from money the business chose to give back.
    expect(entry.source).toBe('adjustment')
    expect(entry.source).not.toBe('refund')
  })

  it('refuses a dispute over nothing', () => {
    for (const bad of [0, -1, 2.5]) {
      expect(() => chargebackReceivedEntry({ ...event, amountFils: bad }, CHART)).toThrow(
        /not a disputed amount/,
      )
    }
  })

  it('unwinds to nought on the clearing account when the dispute is won', () => {
    const received = chargebackReceivedEntry(event, CHART)
    const won = chargebackWonEntry(received, NEXT_DAY, { disputeRef: 'D-1' })
    expect(won.reverses).toBe(received.entryId)
    expect(won.source).toBe('reversal')
    expect(won.entryDate).toBe(NEXT_DAY)
    // To the fils, which is the acceptance line's own wording.
    expect(chargebackNetEffectFils([received, won])).toBe(0)
    // The control: the received entry ALONE moves the full amount, so the nought above is the reversal's
    // doing rather than a function that answers zero.
    expect(chargebackNetEffectFils([received])).toBe(4_000)
  })

  it('refuses a decision dated before the dispute it is about', () => {
    const received = chargebackReceivedEntry(event, CHART)
    expect(() => chargebackWonEntry(received, localDate('2099-05-31'))).toThrow(BackdatedReversal)
  })

  it('writes a lost dispute off to bad debt and not to an allowance', () => {
    const lost = chargebackLostEntry({ ...event, entryId: entryId('CB-1-L') as EntryId }, CHART)
    expect(CHARGEBACK_LOSS_ACCOUNT).toBe(ACCOUNTS.badDebt)
    const accounts = lost.lines.map((l) => l.account)
    expect(accounts).toContain(ACCOUNTS.badDebt)
    expect(accounts).toContain(ACCOUNTS.disputedCardReceipts)
    // An allowance is something the business GRANTED. A lost dispute is a loss imposed on it, and the
    // distinction is the one an accountant would ask about.
    expect(accounts).not.toContain(ACCOUNTS.discountsAndAllowances)
    // It is not a reversal either: a reversal would say the chargeback never happened, and it did.
    expect(lost.reverses).toBeNull()
  })
})

describe('chargedBackNetFils', () => {
  it('counts an unresolved dispute and a lost one the same way', () => {
    expect(chargedBackNetFils([{ kind: 'received', amountFils: 4_000 }])).toBe(4_000)
    expect(
      chargedBackNetFils([
        { kind: 'received', amountFils: 4_000 },
        { kind: 'lost', amountFils: 4_000 },
      ]),
    ).toBe(4_000)
  })

  it('gives the money back only when the dispute is won', () => {
    expect(
      chargedBackNetFils([
        { kind: 'received', amountFils: 4_000 },
        { kind: 'won', amountFils: 4_000 },
      ]),
    ).toBe(0)
  })

  it('has exactly three kinds, so the partition is total', () => {
    expect([...CHARGEBACK_KINDS]).toEqual(['received', 'won', 'lost'])
  })
})

describe('chargebackTradingDate', () => {
  it('resolves 01:30 to the PREVIOUS trading date', () => {
    // The acceptance line, and the reason `resolveTradingDate` is the only arithmetic here: trading runs
    // 11:00 to 02:00, so 01:30 on the 2nd is inside the 1st's session.
    expect(
      chargebackTradingDate({
        disputeRef: 'D-1',
        receivedAt: instantFromIso('2099-06-02T01:30:00+04:00'),
        hoursFor,
      }),
    ).toBe('2099-06-01')
    // The control, and it is the whole claim: the SAME notice two hours later belongs to the 2nd. One
    // assertion alone is satisfied by a function that always answers the previous day.
    expect(
      chargebackTradingDate({
        disputeRef: 'D-1',
        receivedAt: instantFromIso('2099-06-02T11:30:00+04:00'),
        hoursFor,
      }),
    ).toBe('2099-06-02')
  })

  it('refuses an instant that belongs to no trading date, rather than substituting one', () => {
    // ADR 0070. Of the two available errors only one is detectable afterwards: a refusal names the
    // notice, and a substituted date reconciles perfectly against a day nothing happened on.
    expect(() =>
      chargebackTradingDate({
        disputeRef: 'D-1',
        receivedAt: instantFromIso('2099-06-02T09:00:00+04:00'),
        hoursFor,
      }),
    ).toThrow(ChargebackIsOutsideTrading)
    expect(() =>
      chargebackTradingDate({
        disputeRef: 'D-1',
        receivedAt: instantFromIso('2099-06-02T15:00:00+04:00'),
        hoursFor: noHours,
      }),
    ).toThrow(ChargebackIsOutsideTrading)
  })

  it('treats the close instant as outside, which is the half-open convention', () => {
    expect(() =>
      chargebackTradingDate({
        disputeRef: 'D-1',
        receivedAt: instantFromIso('2099-06-02T02:00:00+04:00'),
        hoursFor,
      }),
    ).toThrow(ChargebackIsOutsideTrading)
  })
})

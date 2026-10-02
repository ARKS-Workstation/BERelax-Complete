import { describe, expect, it } from 'vitest'
import { TENDER_ACCOUNT } from '../checkout/posting.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { entryId } from '../ledger/entry.ts'
import type { CancellationVerdict } from '../lifecycle/cancellation-policy.ts'
import { cancellationCharge, classifyCancellation } from '../lifecycle/cancellation-policy.ts'
import { filsFrom, money } from '../money.ts'
import { WHOLE_IN_BASIS_POINTS } from '../reporting/operational-kpis.ts'
import { BASIS_POINTS } from '../seo/query-rows.ts'
import { instantFromIso, localDate } from '../time.ts'
import {
  applyDepositToInvoice,
  assertDepositRedeemable,
  DEPOSIT_LIABILITY_ACCOUNT,
  DEPOSIT_MOVEMENT_KINDS,
  DEPOSIT_PERCENT_WHOLE_BP,
  DEPOSIT_TENDER_KIND,
  DepositBalanceWouldGoNegative,
  DepositIsAppointmentScoped,
  DepositIsNotAPrepaidProduct,
  DepositsAreDisabled,
  depositDueFils,
  depositMovement,
  depositPolicy,
  depositReceiptEntry,
  depositRefundEntry,
  depositRefundOnCancellation,
  depositReleaseTender,
} from './deposit.ts'

/**
 * The deposit, as arithmetic and as two refusals (Y-PAY-06).
 *
 * Every figure asserted below is **computed by hand in this file** from a price and a balance, and the
 * controls are beside the claims: an implementation that returned the balance unchanged would satisfy
 * "nothing is created or destroyed" on every input, so each identity is paired with an assertion about
 * the actual split. The controls that cannot be written here — breaking a shipped file and watching this
 * go red — are known-bad fixtures in `scripts/test-gates.mjs`, cases 154a to 154n.
 *
 * The 500-case property over the posting rule is `deposit.property.test.ts`; what is here is the worked
 * example, the two refusals, and the three things only an exhaustive check can say.
 */

const CHART = STANDARD_SPA_CHART
const ENTRY_DATE = localDate('2026-09-19')

/** AED 262.50, the menu price every other posting test in this build uses. */
const MENU_GROSS = 26_250
/** AED 52.50 — a fifth of it, which is a figure a 2,000bp policy would produce if one existed. */
const DEPOSIT = 5_250

const START = instantFromIso('2026-09-20T15:00:00+04:00')

/** A verdict from the real classifier, so `chargeFils` is the shipped seam's answer and not a literal. */
const verdictAt = (iso: string): CancellationVerdict =>
  classifyCancellation({ startsAt: START, at: instantFromIso(iso), windowHours: 24 })

describe('a deposit is a liability and the receipt touches nothing else', () => {
  it('credits 2045 by the whole amount and debits where the money landed', () => {
    const entry = depositReceiptEntry(
      {
        entryId: entryId('je-ypay06-receipt'),
        entryDate: ENTRY_DATE,
        appointmentId: 'appt-1',
        amount: money(filsFrom(DEPOSIT)),
        tenderKind: 'cash',
      },
      CHART,
    )
    expect(entry.lines).toHaveLength(2)
    const byAccount = new Map(
      entry.lines.map((l) => [l.account as string, l.creditFils - l.debitFils]),
    )
    expect(byAccount.get(ACCOUNTS.customerDepositsHeld)).toBe(DEPOSIT)
    expect(byAccount.get(ACCOUNTS.cashInDrawer)).toBe(-DEPOSIT)
    // The acceptance line: every revenue account untouched, and no output VAT, until the invoice.
    for (const account of CHART.accounts.filter((a) => a.type === 'revenue')) {
      expect(byAccount.get(account.code), `${account.code} must not move`).toBeUndefined()
    }
    expect(byAccount.get(ACCOUNTS.outputVatPayable)).toBeUndefined()
    // The control: the loop above is satisfied by an entry with no lines at all, so the two lines it
    // DOES have are asserted to be the two it should be — and 2045 is a liability, not revenue.
    expect([...byAccount.keys()].sort()).toEqual(
      [ACCOUNTS.cashInDrawer, ACCOUNTS.customerDepositsHeld].sort(),
    )
    expect(CHART.accounts.find((a) => a.code === DEPOSIT_LIABILITY_ACCOUNT)?.type).toBe('liability')
    // `payment` and not `sale`: no supply has been made.
    expect(entry.source).toBe('payment')
  })

  it('refuses a deposit received AS a deposit, which would collect nothing', () => {
    expect(() =>
      depositReceiptEntry(
        {
          entryId: entryId('je-ypay06-self'),
          entryDate: ENTRY_DATE,
          appointmentId: 'appt-1',
          amount: money(filsFrom(DEPOSIT)),
          tenderKind: DEPOSIT_TENDER_KIND,
        },
        CHART,
      ),
    ).toThrow(/cannot be RECEIVED as "deposit_on_account"/)
  })

  it('the release tender debits the liability and nothing that holds cash', () => {
    expect(TENDER_ACCOUNT[DEPOSIT_TENDER_KIND]).toBe(ACCOUNTS.customerDepositsHeld)
    // The control, in the direction a typo would take it: not the drawer, not the bank, and not the
    // package liability — which is the near-enough code decision 19b forbids.
    expect(TENDER_ACCOUNT[DEPOSIT_TENDER_KIND]).not.toBe(ACCOUNTS.cashInDrawer)
    expect(TENDER_ACCOUNT[DEPOSIT_TENDER_KIND]).not.toBe(ACCOUNTS.packageDeferredRevenue)
  })
})

describe('applying a deposit reduces the amount due by exactly the deposit', () => {
  it('splits a document the deposit does not cover', () => {
    // 26_250 gross less a 5_250 deposit leaves 21_000 to collect, and nothing stays held.
    expect(applyDepositToInvoice({ invoiceGrossFils: MENU_GROSS, heldFils: DEPOSIT })).toEqual({
      appliedFils: 5_250,
      amountDueFils: 21_000,
      remainingHeldFils: 0,
    })
  })

  it('caps the application at the document and leaves the excess held', () => {
    // A deposit for a 90-minute treatment against a 60-minute one: 26_250 held, 21_000 billed.
    expect(applyDepositToInvoice({ invoiceGrossFils: 21_000, heldFils: MENU_GROSS })).toEqual({
      appliedFils: 21_000,
      amountDueFils: 0,
      remainingHeldFils: 5_250,
    })
  })

  it('produces no tender when nothing is held, rather than a zero one', () => {
    const nothing = applyDepositToInvoice({ invoiceGrossFils: MENU_GROSS, heldFils: 0 })
    expect(nothing.amountDueFils).toBe(MENU_GROSS)
    expect(depositReleaseTender(nothing, 'ref')).toBeNull()
    // And one when something is.
    const some = applyDepositToInvoice({ invoiceGrossFils: MENU_GROSS, heldFils: DEPOSIT })
    expect(depositReleaseTender(some, 'movement-1')).toEqual({
      kind: DEPOSIT_TENDER_KIND,
      amount: money(filsFrom(DEPOSIT)),
      reference: 'movement-1',
    })
  })

  it('refuses a fractional or negative figure on either side', () => {
    expect(() => applyDepositToInvoice({ invoiceGrossFils: 10.5, heldFils: 0 })).toThrow(
      /is not a figure/,
    )
    expect(() => applyDepositToInvoice({ invoiceGrossFils: 10, heldFils: -1 })).toThrow(
      /is not a liability/,
    )
  })
})

describe('the balance is cumulative and a movement is its difference', () => {
  it('opens at zero, rises on a receipt and falls on an application', () => {
    const received = depositMovement(
      { appointmentId: 'appt-1', heldFils: filsFrom(0) },
      'received',
      DEPOSIT,
    )
    expect(received).toEqual({
      kind: 'received',
      heldBeforeFils: 0,
      heldAfterFils: DEPOSIT,
      movementFils: DEPOSIT,
    })
    const applied = depositMovement(
      { appointmentId: 'appt-1', heldFils: received.heldAfterFils },
      'applied',
      DEPOSIT,
    )
    expect(applied.heldAfterFils).toBe(0)
    expect(applied.movementFils).toBe(-DEPOSIT)
    // The telescoping identity ADR 0057 is about: the movements sum to the cumulative figure.
    expect(received.movementFils + applied.movementFils).toBe(0)
  })

  it('refuses a discharge larger than the balance', () => {
    expect(() =>
      depositMovement({ appointmentId: 'appt-1', heldFils: filsFrom(100) }, 'refunded', 101),
    ).toThrow(DepositBalanceWouldGoNegative)
    // The control: 100 is accepted, so the refusal above is about the ceiling and not about the call.
    expect(
      depositMovement({ appointmentId: 'appt-1', heldFils: filsFrom(100) }, 'refunded', 100)
        .heldAfterFils,
    ).toBe(0)
  })

  it('has three kinds and no way to move a deposit to another appointment', () => {
    // The absence is the decision (0124 §6): a `transferred` kind would be a vocabulary with nothing
    // allowed to write it, which is the member a later reader assumes is in use.
    expect([...DEPOSIT_MOVEMENT_KINDS]).toEqual(['received', 'applied', 'refunded'])
  })
})

describe('a deposit is appointment-scoped, and both refusals are named', () => {
  it('refuses a document that does not bill this appointment', () => {
    expect(() =>
      assertDepositRedeemable('appt-1', {
        kind: 'appointment_invoice',
        invoiceId: 'inv-9',
        billedAppointmentIds: ['appt-2'],
      }),
    ).toThrow(DepositIsAppointmentScoped)
    expect(() =>
      assertDepositRedeemable('appt-1', {
        kind: 'appointment_invoice',
        invoiceId: 'inv-9',
        billedAppointmentIds: [],
      }),
    ).toThrow(/bills no appointment/)
    // The control: the document that DOES bill it is accepted, so the refusal is about the scope and
    // not about the function refusing everything.
    expect(() =>
      assertDepositRedeemable('appt-1', {
        kind: 'appointment_invoice',
        invoiceId: 'inv-9',
        billedAppointmentIds: ['appt-2', 'appt-1'],
      }),
    ).not.toThrow()
  })

  it('refuses a conversion to a package', () => {
    let thrown: unknown
    try {
      assertDepositRedeemable('appt-1', { kind: 'package_sale', packageSaleId: 'pkg-1' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DepositIsNotAPrepaidProduct)
    // The error says WHY, by naming the decision: a later reader has to be able to find it.
    expect((thrown as Error).message).toMatch(/decision 19b/)
    expect((thrown as Error).message).toMatch(/pkg-1/)
  })
})

describe('cancelling inside the window refunds the deposit in full', () => {
  it('returns the whole balance and records the verdict that decided it', () => {
    // 15:00 the next day, cancelled at 20:00 the evening before: 19 hours' notice, inside the 24h window.
    const verdict = verdictAt('2026-09-19T20:00:00+04:00')
    expect(verdict.late).toBe(true)
    expect(verdict.windowHours).toBe(24)
    const refund = depositRefundOnCancellation({ heldFils: DEPOSIT, verdict })
    expect(refund.refundFils).toBe(DEPOSIT)
    expect(refund.retainedFils).toBe(0)
    expect(refund.insideWindow).toBe(true)
    expect(refund.openQuestionId).toBe('Y9-windows')
  })

  it('and outside it, because no fee policy has been agreed', () => {
    // 36 hours' notice. `cancellationCharge()` is the seam and answers zero for every input, so the
    // refund is the same figure — and the FACT that the notice was ample is still carried.
    const verdict = verdictAt('2026-09-19T03:00:00+04:00')
    expect(verdict.late).toBe(false)
    const refund = depositRefundOnCancellation({ heldFils: DEPOSIT, verdict })
    expect(refund.refundFils).toBe(DEPOSIT)
    expect(refund.insideWindow).toBe(false)
    // The assertion that keeps the two cases above from being one: the shipped seam charges nothing, so
    // this file is recording a policy rather than asserting an arithmetic coincidence.
    expect(cancellationCharge().fils).toBe(0)
  })

  it('the control: the subtraction is real, and a fee would reduce the refund', () => {
    // A FIXTURE verdict, not a claim about this business: `cancellationCharge()` is zero above and this
    // is what the arithmetic does the day Y9-windows answers otherwise. Without this case, an
    // implementation that simply returned `heldFils` would pass every assertion in this describe.
    const withFee: CancellationVerdict = {
      ...verdictAt('2026-09-19T20:00:00+04:00'),
      chargeFils: 2_000,
    }
    expect(depositRefundOnCancellation({ heldFils: DEPOSIT, verdict: withFee })).toMatchObject({
      refundFils: DEPOSIT - 2_000,
      retainedFils: 2_000,
    })
    // And it is CAPPED: an uncapped subtraction returns a negative refund, which posts as money
    // arriving from a cancellation.
    const hugeFee: CancellationVerdict = { ...withFee, chargeFils: DEPOSIT + 1 }
    expect(depositRefundOnCancellation({ heldFils: DEPOSIT, verdict: hugeFee })).toMatchObject({
      refundFils: 0,
      retainedFils: DEPOSIT,
    })
  })

  it('posts the refund as a new entry debiting the liability', () => {
    const refund = depositRefundOnCancellation({
      heldFils: DEPOSIT,
      verdict: verdictAt('2026-09-19T20:00:00+04:00'),
    })
    const entry = depositRefundEntry(
      {
        entryId: entryId('je-ypay06-refund'),
        entryDate: ENTRY_DATE,
        appointmentId: 'appt-1',
        refund,
        tenderKind: 'cash',
      },
      CHART,
    )
    expect(entry.source).toBe('refund')
    const byAccount = new Map(
      entry.lines.map((l) => [l.account as string, l.creditFils - l.debitFils]),
    )
    expect(byAccount.get(ACCOUNTS.customerDepositsHeld)).toBe(-DEPOSIT)
    expect(byAccount.get(ACCOUNTS.cashInDrawer)).toBe(DEPOSIT)
    // No revenue recognised on the way out either: a deposit returned was never income.
    for (const account of CHART.accounts.filter((a) => a.type === 'revenue')) {
      expect(byAccount.get(account.code)).toBeUndefined()
    }
  })

  it('refuses an entry for a refund of nothing', () => {
    const nothing = depositRefundOnCancellation({
      heldFils: 0,
      verdict: verdictAt('2026-09-19T20:00:00+04:00'),
    })
    expect(nothing.refundFils).toBe(0)
    expect(() =>
      depositRefundEntry(
        {
          entryId: entryId('je-ypay06-empty'),
          entryDate: ENTRY_DATE,
          appointmentId: 'appt-1',
          refund: nothing,
          tenderKind: 'cash',
        },
        CHART,
      ),
    ).toThrow(/nothing to refund/)
  })
})

describe('the deposit policy refuses rather than answering zero', () => {
  it('is OFF with a zero percentage, which is the answer on file', () => {
    const policy = depositPolicy({ enabled: false, percentBp: 0 })
    expect(policy).toEqual({ enabled: false, percentBp: 0, openQuestionId: 'Y9-deposits' })
    expect(() =>
      depositDueFils({ appointmentId: 'appt-1', grossFils: MENU_GROSS, policy }),
    ).toThrow(DepositsAreDisabled)
    // The refusal names the key and the question, so the person reading it knows what to change.
    expect(() =>
      depositDueFils({ appointmentId: 'appt-1', grossFils: MENU_GROSS, policy }),
    ).toThrow(/payments\.deposit_enabled/)
  })

  it('answers zero when the module is on and the percentage is the one on file', () => {
    // The pair with the case above: "no deposit because the module is off" and "no deposit is due under
    // the policy" are different facts, and only this arrangement can tell them apart.
    const policy = depositPolicy({ enabled: true, percentBp: 0 })
    expect(depositDueFils({ appointmentId: 'appt-1', grossFils: MENU_GROSS, policy })).toBe(0)
  })

  it('rounds DOWN, so the business never asks for more than the policy says', () => {
    // A FIXTURE rate. 26_250 x 1_000 / 10_000 = 2_625 exactly, so a rate that does NOT divide is needed
    // for the direction to be visible: 1_001bp gives 2_627.6250, and the figure asked for is 2_627.
    const policy = depositPolicy({ enabled: true, percentBp: 1_001 })
    expect(depositDueFils({ appointmentId: 'appt-1', grossFils: MENU_GROSS, policy })).toBe(2_627)
    // The control: half-up would be 2_628, so this case distinguishes the two directions.
    expect(depositDueFils({ appointmentId: 'appt-1', grossFils: MENU_GROSS, policy })).not.toBe(
      2_628,
    )
  })

  it('normalises anything that is not a policy to the OFF reading', () => {
    // `Boolean('false')` is true and `Number(null)` is 0, which is why neither is coerced.
    expect(depositPolicy({ enabled: 'true', percentBp: null }).enabled).toBe(false)
    expect(depositPolicy({ enabled: 1, percentBp: '2000' })).toMatchObject({
      enabled: false,
      percentBp: 2_000,
    })
    expect(depositPolicy({ enabled: true, percentBp: 10_001 }).percentBp).toBe(0)
    expect(depositPolicy({ enabled: true, percentBp: 1.5 }).percentBp).toBe(0)
  })

  it('holds its basis-point whole equal to the two core already exports', () => {
    // A third statement of 10,000 (see the constant's own note). This is the check that keeps the three
    // in step, in the one file that may import all of them.
    expect(DEPOSIT_PERCENT_WHOLE_BP).toBe(BASIS_POINTS)
    expect(DEPOSIT_PERCENT_WHOLE_BP).toBe(Number(WHOLE_IN_BASIS_POINTS))
  })
})

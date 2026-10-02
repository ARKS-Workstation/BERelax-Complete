import { DepositIsAppointmentScoped, DepositIsNotAPrepaidProduct } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  applyDepositAtCheckout,
  DEPOSIT_TENDER_KIND,
  depositOfferedAtBooking,
} from '../app/(admin)/checkout/apply-deposit.ts'

/**
 * What the checkout decides about a deposit already held (Y-PAY-06).
 *
 * The module reads nothing and writes nothing, so every claim here is about the figures and the two
 * refusals. The arithmetic itself is `packages/core/src/payments/deposit.test.ts` and the 500-case
 * property beside it; what is proved HERE is the composition — that the scope is checked before a figure
 * is produced, and that the release reaches the till as a tender rather than as a second subtraction.
 */

const APPOINTMENT = '11111111-2222-4333-8444-555555555555'
const OTHER = '11111111-2222-4333-8444-666666666666'
const INVOICE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const MENU_GROSS = 26_250
const DEPOSIT = 5_250

const billing = (...appointmentIds: readonly string[]) =>
  ({
    kind: 'appointment_invoice',
    invoiceId: INVOICE,
    billedAppointmentIds: appointmentIds,
  }) as const

describe('the checkout applies an appointment’s own deposit and nothing else', () => {
  it('reduces the amount due by the deposit and presents it as a tender', () => {
    const decided = applyDepositAtCheckout({
      appointmentId: APPOINTMENT,
      target: billing(APPOINTMENT),
      invoiceGrossFils: MENU_GROSS,
      heldFils: DEPOSIT,
      reference: 'movement-1',
    })
    expect(decided.holding).toBe(true)
    expect(decided.appliedFils).toBe(DEPOSIT)
    // 26_250 less 5_250, computed by hand.
    expect(decided.amountDueFils).toBe(21_000)
    expect(decided.remainingHeldFils).toBe(0)
    expect(decided.release).toEqual({
      kind: DEPOSIT_TENDER_KIND,
      amount: { fils: DEPOSIT, currency: 'AED' },
      reference: 'movement-1',
    })
    // The identity the whole arrangement rests on: the two tenders the till presents sum to the gross,
    // so `TendersDoNotCoverBasket` is satisfied without the checkout being told about deposits at all.
    expect(decided.appliedFils + decided.amountDueFils).toBe(MENU_GROSS)
  })

  it('writes no release when nothing is held, which is the ordinary case today', () => {
    const decided = applyDepositAtCheckout({
      appointmentId: APPOINTMENT,
      target: billing(APPOINTMENT),
      invoiceGrossFils: MENU_GROSS,
      heldFils: 0,
      reference: 'unused',
    })
    expect(decided.holding).toBe(false)
    expect(decided.amountDueFils).toBe(MENU_GROSS)
    expect(decided.release).toBeNull()
  })

  it('leaves the excess held when the deposit is larger than the document', () => {
    const decided = applyDepositAtCheckout({
      appointmentId: APPOINTMENT,
      target: billing(APPOINTMENT),
      invoiceGrossFils: 21_000,
      heldFils: MENU_GROSS,
      reference: 'movement-1',
    })
    expect(decided.amountDueFils).toBe(0)
    expect(decided.appliedFils).toBe(21_000)
    expect(decided.remainingHeldFils).toBe(5_250)
  })

  it('refuses another appointment’s document BEFORE producing a figure', () => {
    // The ordering is the claim. A refusal that arrived after the arithmetic would have shown the
    // operator an amount due, allocated a statutory invoice number against it, and then been rolled back
    // by ZY305 at COMMIT.
    expect(() =>
      applyDepositAtCheckout({
        appointmentId: APPOINTMENT,
        target: billing(OTHER),
        invoiceGrossFils: MENU_GROSS,
        heldFils: DEPOSIT,
        reference: 'movement-1',
      }),
    ).toThrow(DepositIsAppointmentScoped)
  })

  it('refuses a package sale', () => {
    expect(() =>
      applyDepositAtCheckout({
        appointmentId: APPOINTMENT,
        target: { kind: 'package_sale', packageSaleId: 'pkg-1' },
        invoiceGrossFils: MENU_GROSS,
        heldFils: DEPOSIT,
        reference: 'movement-1',
      }),
    ).toThrow(DepositIsNotAPrepaidProduct)
  })

  it('the control: the document that DOES bill the appointment is accepted', () => {
    // Without this, the two refusals above are satisfied by a function that refuses everything.
    expect(() =>
      applyDepositAtCheckout({
        appointmentId: APPOINTMENT,
        target: billing(OTHER, APPOINTMENT),
        invoiceGrossFils: MENU_GROSS,
        heldFils: DEPOSIT,
        reference: 'movement-1',
      }),
    ).not.toThrow()
  })

  it('offers a deposit at booking only when the policy says so', () => {
    expect(depositOfferedAtBooking({ enabled: false, percentBp: 0 })).toMatchObject({
      enabled: false,
      percentBp: 0,
      openQuestionId: 'Y9-deposits',
    })
    // The release path reads NO setting, which is the decision this pair records: a deposit taken before
    // the flag was turned off is still the customer's money and must still be releasable.
    const decided = applyDepositAtCheckout({
      appointmentId: APPOINTMENT,
      target: billing(APPOINTMENT),
      invoiceGrossFils: MENU_GROSS,
      heldFils: DEPOSIT,
      reference: 'movement-1',
    })
    expect(decided.appliedFils).toBe(DEPOSIT)
  })
})

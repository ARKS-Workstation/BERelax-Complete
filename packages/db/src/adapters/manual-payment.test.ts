import { describe, expect, it } from 'vitest'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import * as adapter from './manual-payment.ts'
import {
  manualPaymentAdapter,
  PAYMENT_ADAPTER_MEMBERS,
  PAYMENT_ADAPTER_MEMBERS_ARE_EXACT,
  RefundRequiresCreditNote,
} from './manual-payment.ts'

/**
 * The export surface of the payment adapter, and the shape of the interface — asserted rather than
 * agreed.
 *
 * Two of this unit's acceptance lines are claims about what may *exist* rather than about what happens:
 * "no exported function creates a refund from an invoice alone", and "the interface has no cash-specific
 * member". A convention written in a comment is one that the next `refundInvoice` passes, so both are
 * enumerated here.
 *
 * A unit test on purpose. The constraints, the grants and the two deferred ceilings are asserted against
 * a real PostgreSQL in `manual-payment.itest.ts`; what is checked here is the TypeScript surface, which
 * is the layer a caller reaches for, and it is checked with nothing running.
 */

/** `refundInvoice`, `voidPayment`, `reverseSale` — names that would mean money leaves without a note. */
const REFUND_WITHOUT_A_NOTE = /^(refund|reverse|void|undo|cancel)/i

/** `readInvoiceByDisplayNumber` -> ['read', 'invoice', 'by', 'display', 'number']. */
function segmentsOf(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((segment) => segment !== '')
}

/** A `UnitOfWork` that throws the moment anything touches the database, the audit log or the outbox. */
function refusingUnitOfWork(): { uow: UnitOfWork; touched: () => boolean } {
  let touched = false
  const explode = (what: string) => {
    touched = true
    throw new Error(`the ${what} was reached, and this call was supposed to be refused before that`)
  }
  const uow = {
    sql: ((..._args: unknown[]) => explode('database')) as unknown as Sql,
    audit: {
      record: async () => explode('audit log'),
    },
    publish: async () => explode('outbox'),
  } as unknown as UnitOfWork
  return { uow, touched: () => touched }
}

const REFUND_INPUT = {
  invoiceId: '00000000-0000-4000-8000-00000000f001',
  tradingDate: '2026-09-19',
  entryId: 'je-refund-surface-1',
  tenderKind: 'cash',
  postingAccountCode: '1010',
  amountFils: 5_000,
} as const

describe('the payment adapter exports no way to refund an invoice on its own', () => {
  /**
   * The exported names that may mention money going back, and why each one is allowed.
   *
   * Pinned as an exact SET rather than filtered by a heuristic, because every heuristic has a hole and
   * the hole is where the next `createRefund` goes: a first-segment rule misses it, and a
   * contains-a-verb rule flags the predicate below. An exact set fails on any new name at all, and
   * whoever adds one has to say which of the two kinds it is.
   *
   *   - `RefundRequiresCreditNote`, `RefundExceedsPayments` — the refusals themselves.
   *   - `isRefundExceedingPayments` — a predicate over an error, for a caller wrapping a transaction.
   *
   * None of them creates anything. The only way to create a refund is `PaymentAdapter.refund`, whose
   * input carries `creditNoteId` — and the case below proves that refusal happens before the database is
   * reached at all, which is what makes "from an invoice alone" impossible rather than discouraged.
   */
  const MAY_MENTION_A_REFUND = [
    'RefundExceedsPayments',
    'RefundRequiresCreditNote',
    'isRefundExceedingPayments',
  ]

  it('exports nothing that creates a refund, and the names that mention one are pinned', () => {
    const mentioning = Object.entries(adapter)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .filter((name) => segmentsOf(name).some((segment) => REFUND_WITHOUT_A_NOTE.test(segment)))
      .sort()

    expect(
      mentioning,
      'A refund is authorised by a credit note (docs/04 §4). If this fails, either the new exported ' +
        'function is the defect — add it as a member of PaymentAdapter, whose refund input carries ' +
        'creditNoteId — or it is a refusal, and it belongs in MAY_MENTION_A_REFUND with a reason.',
    ).toEqual([...MAY_MENTION_A_REFUND].sort())
  })

  it('the control: the same scan DOES flag a function named like a bare refund path', () => {
    // Without this the assertion above would pass against a scan that matched nothing — the defect ADR
    // 0003 exists for, and the one that reduced `pnpm boundaries` to zero modules while reporting
    // success.
    const pretend = { refundInvoice: 1, createRefund: 1, voidSale: 1, capture: 1 }
    const flagged = Object.keys(pretend).filter((name) =>
      segmentsOf(name).some((segment) => REFUND_WITHOUT_A_NOTE.test(segment)),
    )
    expect(flagged).toEqual(['refundInvoice', 'createRefund', 'voidSale'])
  })

  it('refuses a refund with no credit note before the database is touched', async () => {
    const { uow, touched } = refusingUnitOfWork()
    // No `creditNoteId` at all.
    await expect(manualPaymentAdapter().refund(uow, REFUND_INPUT)).rejects.toThrow(
      RefundRequiresCreditNote,
    )
    // A blank one, which is the shape a form supplies: an empty string is not a credit note, and
    // `btrim` is why the database would refuse it too.
    await expect(
      manualPaymentAdapter().refund(uow, { ...REFUND_INPUT, creditNoteId: '   ' }),
    ).rejects.toThrow(RefundRequiresCreditNote)
    await expect(
      manualPaymentAdapter().refund(uow, { ...REFUND_INPUT, creditNoteId: null }),
    ).rejects.toThrow(RefundRequiresCreditNote)
    // THE point: nothing was written, and no statutory entry id was used. A refusal after the insert
    // would be a rolled-back transaction rather than a rejected request.
    expect(touched()).toBe(false)
  })

  it('the control: a refund WITH a credit note does reach the database', async () => {
    // Which is what makes the previous case about the credit note rather than about a stub that refuses
    // everything. The stub throws a plain Error, so this must NOT be RefundRequiresCreditNote.
    const { uow, touched } = refusingUnitOfWork()
    await expect(
      manualPaymentAdapter().refund(uow, {
        ...REFUND_INPUT,
        creditNoteId: '00000000-0000-4000-8000-00000000c001',
      }),
    ).rejects.toThrow(/the database was reached/)
    expect(touched()).toBe(true)
  })
})

describe('the PaymentAdapter interface is shaped by what a gateway needs', () => {
  it('names the four things a card gateway does, and nothing about a drawer', () => {
    // `PAYMENT_ADAPTER_MEMBERS_ARE_EXACT` is a type-level assertion that this list equals
    // `keyof PaymentAdapter` in BOTH directions, so a member added to the interface and not to the list
    // fails `tsc`. That is what stops the assertions below going vacuous — an interface does not exist
    // at run time, so a stale list would be checked instead of the interface.
    expect(PAYMENT_ADAPTER_MEMBERS_ARE_EXACT).toBe(true)
    expect([...PAYMENT_ADAPTER_MEMBERS]).toEqual([
      'name',
      'authorise',
      'capture',
      'refund',
      'reconcileWebhook',
    ])
  })

  /**
   * Words that only make sense for money in a drawer.
   *
   * An interface shaped around the till is the shape in which the gateway's adapter becomes four no-op
   * methods and a comment apologising for them — and a gateway that had to implement `openDrawer` would
   * implement it as a lie. `change` is on the list although this unit implements change handling,
   * because change is a property of the TENDER and not a call a gateway makes.
   */
  const CASH_SPECIFIC = /drawer|float|till|coin|note|cash|change|counter/i

  it.each(PAYMENT_ADAPTER_MEMBERS)('%s is not a cash-specific member', (member) => {
    expect(CASH_SPECIFIC.test(member)).toBe(false)
  })

  it('the control: the same scan DOES flag the cash-shaped members it exists to keep out', () => {
    const tempting = ['openDrawer', 'countFloat', 'changeDue', 'cashUp', 'tillReconcile']
    expect(tempting.filter((member) => CASH_SPECIFIC.test(member))).toEqual(tempting)
  })

  it('the manual adapter implements every member, and declares itself by its registry name', () => {
    const manual = manualPaymentAdapter()
    // `tender_type.adapter` is `manual` for all three types today, and this is the value it matches.
    expect(manual.name).toBe('manual')
    for (const member of PAYMENT_ADAPTER_MEMBERS) {
      if (member === 'name') continue
      expect(typeof manual[member], `${member} is implemented`).toBe('function')
    }
  })

  it('answers a mis-routed webhook rather than throwing at it', async () => {
    // A `throw` here would turn a gateway's mis-routed webhook into a 500 that gets retried for a day,
    // and the sender could not tell "wrong adapter" from "the right adapter is broken".
    const { uow } = refusingUnitOfWork()
    const answer = await manualPaymentAdapter().reconcileWebhook(uow, {
      reference: 'PSP-REF-1',
      amountFils: 5_000,
    })
    expect(answer.outcome).toBe('not_mine')
    expect(answer.reason).toContain('no pending authorisation')
  })
})

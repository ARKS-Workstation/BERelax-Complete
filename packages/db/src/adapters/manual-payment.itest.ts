import http from 'node:http'
import https from 'node:https'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import { type IssueInvoiceInput, issueInvoice } from '../repositories/invoice.ts'
import { issueCreditNote } from '../services/issue-credit-note.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  isOverpayment,
  isRefundExceedingPayments,
  manualPaymentAdapter,
  Overpayment,
  PAYMENT_CONSTRAINT,
  PAYMENT_SQLSTATE,
  paymentError,
  RefundExceedsPayments,
  RefundRequiresCreditNote,
  readInvoiceSettlement,
  readTenderTypes,
  TRADE_RECEIVABLES_ACCOUNT_CODE,
} from './manual-payment.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Payments and refunds against a real PostgreSQL.
 *
 * Every claim here is a database rule — a registry foreign key, a generated column, two per-row triggers,
 * two DEFERRED ceilings, a view — and a rule is only a rule once something has been seen to bounce off
 * it. So each refusal is asserted by its SQLSTATE or its named constraint, never as "an error was
 * raised" (ADR 0003), and every refusal has a control beside it that is ACCEPTED, so a renamed column
 * cannot make the whole file pass by rejecting everything.
 *
 * `packages/db` may not import `packages/core`, so every figure below is an integer written out with its
 * arithmetic in a comment. The pair — the registry here and `TENDER_TYPES` in core — is held equal in
 * `packages/fixtures/src/payment.itest.ts`, which is the package allowed to depend on both.
 *
 * ## Two things this file asserts that nothing else can
 *
 * **The `ZT001` ceiling under a caller that does not check first.** The adapter refuses an overpayment
 * before writing, which is the layer a person reads; the trigger is the layer that holds when two tills
 * take payment for one document at the same moment. So the trigger is exercised by INSERTing straight
 * into `payment`, past the adapter — because a test that only went through the adapter would pass with
 * the trigger dropped.
 *
 * **That the adapter needs no network.** `fetch`, `http.request` and `https.request` are replaced by
 * throwing stubs for the duration of one test and the adapter must still succeed, with a control proving
 * the sabotage bites. `net.connect` is deliberately NOT stubbed: the PostgreSQL driver uses it, so
 * stubbing it would test the harness rather than the adapter. The module-graph half of the same claim is
 * `payments-must-not-reach-the-network` in `.dependency-cruiser.cjs`, which sees imports and cannot see
 * a global.
 */

/** Fifteen digits. A test value: the real TRN is unknown (Y1-trn) and the placeholder is refused. */
const TEST_TRN = '100123456700003'

const TILL: Actor = {
  kind: 'staff',
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Till',
}

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: TEST_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

const TAX_POINT = '2026-09-18'
const TRADING_DATE = '2026-09-19'

/**
 * One line at AED 262.50 gross, 5% VAT.
 *
 * net = 26_250 - round(26_250 * 20 / 21) is the wrong way round; the derivation is
 * net = round(26_250 * 20 / 21) = round(25_000) = 25_000 and VAT = 26_250 - 25_000 = **1_250**.
 * Gross is authoritative and VAT is the remainder (ADR 0007), so those three add up exactly.
 */
const GROSS = 26_250
const NET = 25_000
const VAT = 1_250

/**
 * A credit note for `invoiceId`, crediting the whole of its one line.
 *
 * This used to be an invented uuid, because `credit_note` did not exist: 0068 gave `refund` a NOT NULL
 * `credit_note_id` and no foreign key, and recorded that the key was M-TILL-08's to add. 0072 added it,
 * plus `ZD010` — the note must correct THIS document — so a refund can no longer name a note nobody
 * issued, and every probe below now issues a real one. That is the loud failure 0068's NOTE predicted
 * for this unit, arriving in the file it predicted it in.
 *
 * The whole line, at the line's OWN net and VAT: `ZD005` refuses a full credit whose figures are a
 * re-derivation, and the note's gross is what `ZD012` caps the refunds below at.
 */
async function creditNoteFor(invoiceId: string, label: string): Promise<string> {
  const entryId = `je-mtill08-cn-${label}-${RUN}-${nonce}`
  const note = await withUnitOfWork(sql, TILL, (uow) =>
    issueCreditNote(uow, {
      invoiceId,
      seriesCode: 'CR-NOTE',
      issuer: ISSUER,
      customer: { nameSnapshot: 'Customer 0042' },
      issueDate: TRADING_DATE,
      issueTradingDate: TRADING_DATE,
      taxPointDate: TRADING_DATE,
      reason: 'The treatment was not delivered as described',
      lines: [
        {
          invoiceLineNo: 1,
          descriptionEn: 'Asian Normal Massage, 60 minutes',
          quantity: 1,
          unitGrossFils: GROSS,
          vatRateBp: 500,
          netFils: NET,
          vatFils: VAT,
        },
      ],
      netTotalFils: NET,
      vatTotalFils: VAT,
      grossTotalFils: GROSS,
      // Dr 4010 the net, Dr 2030 the VAT, Cr 1050 the gross. What `creditNoteReversal` in
      // @berelax/core builds; written out here because packages/db may not import it.
      reversal: {
        entryId,
        entryDate: TRADING_DATE,
        narrative: 'Credit note reversal',
        source: 'reversal',
        lines: [
          { accountCode: '4010', debitFils: NET, creditFils: 0 },
          { accountCode: '2030', debitFils: VAT, creditFils: 0 },
          { accountCode: '1050', debitFils: 0, creditFils: GROSS },
        ],
      },
    }),
  )
  return note.id
}

function oneTreatment(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: ISSUER,
    customer: { nameSnapshot: 'Customer 0042' },
    issueDate: TRADING_DATE,
    issueTradingDate: TRADING_DATE,
    taxPointDate: TAX_POINT,
    lines: [
      {
        descriptionEn: 'Asian Normal Massage, 60 minutes',
        quantity: 1,
        unitGrossFils: GROSS,
        vatRateBp: 500,
        netFils: NET,
        vatFils: VAT,
      },
    ],
    netTotalFils: NET,
    vatTotalFils: VAT,
    grossTotalFils: GROSS,
    ...overrides,
  }
}

let sql: Sql
/**
 * A per-RUN prefix and a per-TEST counter, so every entry id this file allocates is unique.
 *
 * `journal_entry` is append-only and is truncated by nobody, so an id built from the counter alone
 * collides with the previous run's — which reads as a primary-key violation in a file that has not
 * changed. `checkout-finalisation.itest.ts` takes the same precaution for the same reason.
 */
const RUN = Date.now().toString(36)
let nonce = 0

beforeAll(() => {
  sql = createConnection({ url, max: 8 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/**
 * Empties the document family and puts the series counter back.
 *
 * `truncate` as the OWNER, which fires no row-level DELETE trigger — `invoice` refuses DELETE for every
 * role including the owner (ZI003), so there is no other way to clear it. Every table that references
 * `invoice` is NAMED: PostgreSQL refuses a truncate while a referencing table is missing from the
 * statement, and `refund` is the fourth such table (0068). `credit_note_line` and `credit_note` are here since 0072
 * and come first, because `refund.credit_note_id` is now a real key into the second of them.
 */
beforeEach(async () => {
  await sql.unsafe(
    'truncate credit_note_line, credit_note, refund, checkout_finalisation, payment, ' +
      'invoice_appointment, invoice_line, invoice',
  )
  await sql`
    update document_series
       set next_number = 1, period_key = '', prefix = 'TI-', padding = 5, reset_policy = 'annual'
     where code = 'TAX-INV'
  `
  // The credit-note counter too, since 0072: `refund.credit_note_id` is a real foreign key now, so the
  // refund probes below issue real notes and the display number is UNIQUE across runs.
  await sql`update document_series set next_number = 1, period_key = '' where code = 'CR-NOTE'`
  nonce += 1
})

/** An issued, unpaid document. What a payment is recorded against. */
async function issueUnpaid(): Promise<{ id: string; displayNumber: string }> {
  return withUnitOfWork(sql, TILL, async (uow) => {
    const invoice = await issueInvoice(uow, oneTreatment())
    return { id: invoice.id, displayNumber: invoice.displayNumber }
  })
}

/** The SQLSTATE of a rejected promise, or undefined. Never "an error was raised". */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const translated = (err as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : translated
    return {
      code: typeof code === 'string' ? code : undefined,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

describe('the tender-type registry', () => {
  it('holds every way the business takes money, with an account for each', async () => {
    const types = await readTenderTypes(sql)
    expect(types.map((type) => type.code)).toEqual(['cash', 'card_in_salon', 'bank_transfer'])
    // Card money goes to the terminal clearing account and NOT the bank: the terminal settles in a
    // batch, net of fees, days later.
    expect(types.map((type) => type.postingAccountCode)).toEqual(['1010', '1040', '1020'])
    expect(types.filter((type) => type.givesChange).map((type) => type.code)).toEqual(['cash'])
    expect(types.filter((type) => type.requiresReference).map((type) => type.code)).toEqual([
      'card_in_salon',
      'bank_transfer',
    ])
    // All three are the manual adapter's today, which is the honest answer: there is no gateway yet.
    expect(new Set(types.map((type) => type.adapter))).toEqual(new Set(['manual']))
    expect(types.every((type) => type.retiredAt === null)).toBe(true)
  })

  it('refuses a tender naming a type it does not hold, by the constraint 0063 named', async () => {
    const invoice = await issueUnpaid()
    // The CHECK became a foreign key and KEPT its name, which is the contract: a caller tells "that is
    // not a tender type we take" from every other refusal in the same transaction by this name.
    const refused = await stateOf(
      sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoice.id}, 1, 'gift_card', '1010', 100, ${TRADING_DATE}::date)
      `,
    )
    expect(refused.code).toBe('23503')
    expect(refused.message).toContain(PAYMENT_CONSTRAINT.tenderKindKnown)
    // The control: the same insert with a registered kind is accepted, so the refusal is about the kind.
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           trading_date)
      values (${invoice.id}, 1, 'cash', '1010', 100, ${TRADING_DATE}::date)
    `
  })

  it('refuses change on a type that gives none, and a reference-bearing type with none', async () => {
    const invoice = await issueUnpaid()
    const change = await stateOf(
      sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             change_given_fils, reference, trading_date)
        values (${invoice.id}, 1, 'card_in_salon', '1040', 100, 10, 'APPROVAL-1',
                ${TRADING_DATE}::date)
      `,
    )
    expect(change.code).toBe(PAYMENT_SQLSTATE.changeOnATenderThatGivesNone)

    const missingReference = await stateOf(
      sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoice.id}, 2, 'card_in_salon', '1040', 100, ${TRADING_DATE}::date)
      `,
    )
    expect(missingReference.code).toBe(PAYMENT_SQLSTATE.tenderReference)

    // The controls: a card tender WITH a reference and no change is accepted, and cash with change is.
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           reference, trading_date)
      values (${invoice.id}, 3, 'card_in_salon', '1040', 100, 'APPROVAL-2', ${TRADING_DATE}::date)
    `
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           change_given_fils, trading_date)
      values (${invoice.id}, 4, 'cash', '1010', 100, 10, ${TRADING_DATE}::date)
    `
  })
})

describe('a partial payment', () => {
  it('leaves a receivable equal to gross minus paid, to the fils', async () => {
    const invoice = await issueUnpaid()
    //   gross      26_250
    //   applied    10_000
    //   left       16_250
    const captured = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-partial-${RUN}-${nonce}`,
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: 10_000 }],
      }),
    )
    expect(captured.appliedFils).toBe(10_000)
    expect(captured.changeGivenFils).toBe(0)
    expect(captured.outstandingFils).toBe(GROSS - 10_000)

    const settlement = await readInvoiceSettlement(sql, invoice.id)
    expect(settlement?.grossFils).toBe(GROSS)
    // No gratuity on this document, so the payable total is the gross itself.
    expect(settlement?.payableFils).toBe(GROSS)
    expect(settlement?.appliedFils).toBe(10_000)
    expect(settlement?.outstandingFils).toBe(16_250)
    // Exact, not "about": 26_250 - 10_000.
    expect(settlement?.outstandingFils).toBe(GROSS - 10_000)

    // And the entry: Dr 1010 at what was applied, Cr 1050 at the same figure.
    const lines = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
      select account_code, debit_fils, credit_fils from journal_line
       where entry_id = ${`je-mtill07-partial-${RUN}-${nonce}`} order by line_no
    `
    expect(
      lines.map((line) => [line.account_code, Number(line.debit_fils), Number(line.credit_fils)]),
    ).toEqual([
      ['1010', 10_000, 0],
      [TRADE_RECEIVABLES_ACCOUNT_CODE, 0, 10_000],
    ])
  })

  it('settles the rest in a second capture, and the outstanding figure reaches exactly zero', async () => {
    const invoice = await issueUnpaid()
    await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-first-${RUN}-${nonce}`,
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: 10_000 }],
      }),
    )
    const second = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-second-${RUN}-${nonce}`,
        tenders: [
          {
            tenderKind: 'card_in_salon',
            postingAccountCode: '1040',
            amountFils: GROSS - 10_000,
            reference: `APPROVAL-${nonce}`,
          },
        ],
      }),
    )
    expect(second.outstandingFils).toBe(0)
    // The tender numbers continue rather than restarting: two reads of one document list them in the
    // same order, which is `payment_one_row_per_tender`'s reason for existing.
    expect(second.payments.map((payment) => payment.tenderNo)).toEqual([2])
    const settlement = await readInvoiceSettlement(sql, invoice.id)
    expect(settlement?.appliedFils).toBe(GROSS)
    expect(settlement?.outstandingFils).toBe(0)
  })
})

describe('over-tender change', () => {
  it('records what was handed over and what was handed back as two figures', async () => {
    const invoice = await issueUnpaid()
    //   gross      26_250
    //   tendered   30_000  (a 300-dirham note)
    //   change      3_750
    //   applied    26_250
    const captured = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-change-${RUN}-${nonce}`,
        tenders: [
          {
            tenderKind: 'cash',
            postingAccountCode: '1010',
            amountFils: 30_000,
            changeGivenFils: 3_750,
          },
        ],
      }),
    )
    const payment = captured.payments[0]
    // THE assertion. `amount_fils` is untouched by the change: a drawer is counted against the notes
    // that went in and the notes that came out, and one net figure reconciles against neither.
    expect(payment?.amountFils).toBe(30_000)
    expect(payment?.changeGivenFils).toBe(3_750)
    // Read back from the GENERATED column, not recomputed here.
    expect(payment?.appliedFils).toBe(GROSS)
    expect(payment?.amountFils).not.toBe(payment?.appliedFils)

    const settlement = await readInvoiceSettlement(sql, invoice.id)
    expect(settlement?.tenderedFils).toBe(30_000)
    expect(settlement?.changeGivenFils).toBe(3_750)
    expect(settlement?.appliedFils).toBe(GROSS)
    expect(settlement?.outstandingFils).toBe(0)

    // The journal debits what STAYED, not what was handed over. Debiting 30_000 would put the change in
    // the drawer twice and the entry would not balance against the document.
    const [line] = await sql<{ debit_fils: string }[]>`
      select debit_fils from journal_line
       where entry_id = ${`je-mtill07-change-${RUN}-${nonce}`} and account_code = '1010'
    `
    expect(Number(line?.debit_fils)).toBe(GROSS)
  })

  it('refuses change greater than what was handed over, by name', async () => {
    const invoice = await issueUnpaid()
    const refused = await stateOf(
      sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             change_given_fils, trading_date)
        values (${invoice.id}, 1, 'cash', '1010', 100, 101, ${TRADING_DATE}::date)
      `,
    )
    expect(refused.code).toBe('23514')
    expect(refused.message).toContain(PAYMENT_CONSTRAINT.changeNotMoreThanTendered)
    // The control: change equal to the tender is accepted. It is the reachable case of a document
    // already paid in full being tendered against — nothing is applied and the whole note goes back.
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           change_given_fils, trading_date)
      values (${invoice.id}, 1, 'cash', '1010', 100, 100, ${TRADING_DATE}::date)
    `
  })
})

describe('the overpayment ceiling', () => {
  it('refuses a capture above what the document is payable for, naming the figures', async () => {
    const invoice = await issueUnpaid()
    await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-part-${RUN}-${nonce}`,
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: 26_000 }],
      }),
    )
    // 250 fils outstanding; 251 offered.
    const refused = withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-over-${RUN}-${nonce}`,
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: 251 }],
      }),
    )
    await expect(refused).rejects.toThrow(Overpayment)
    await expect(refused).rejects.toThrow(/250 fils is outstanding and 251 was offered/)

    // The control: 250 exactly is accepted, so the refusal is about the one fils.
    const accepted = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-exact-${RUN}-${nonce}`,
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: 250 }],
      }),
    )
    expect(accepted.outstandingFils).toBe(0)
  })

  it('is held by the database for a caller that does not check first', async () => {
    // Past the adapter entirely, which is the point: the adapter's own refusal is a read followed by a
    // write, and two tills taking payment for one document land in the gap. ZT001 is DEFERRED, so it
    // fires at COMMIT — which is also what lets a tipped checkout write tenders summing above the
    // document's gross inside one transaction.
    const invoice = await issueUnpaid()
    const refused = await stateOf(
      sql.begin(async (tx) => {
        await tx`
          insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                               trading_date)
          values (${invoice.id}, 1, 'cash', '1010', ${GROSS}, ${TRADING_DATE}::date)
        `
        await tx`
          insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                               trading_date)
          values (${invoice.id}, 2, 'cash', '1010', 1, ${TRADING_DATE}::date)
        `
      }),
    )
    expect(refused.code).toBe(PAYMENT_SQLSTATE.overpayment)
    expect(refused.message).toContain('Overpayment')
    // Nothing survived: the ceiling fires at COMMIT, so both rows rolled back together.
    const settlement = await readInvoiceSettlement(sql, invoice.id)
    expect(settlement?.appliedFils).toBe(0)

    // The control: the same two inserts totalling exactly the gross are accepted, so the refusal is
    // about the one fils over rather than about two tenders in one transaction.
    await sql.begin(async (tx) => {
      await tx`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoice.id}, 1, 'cash', '1010', ${GROSS - 1}, ${TRADING_DATE}::date)
      `
      await tx`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoice.id}, 2, 'cash', '1010', 1, ${TRADING_DATE}::date)
      `
    })
    expect((await readInvoiceSettlement(sql, invoice.id))?.appliedFils).toBe(GROSS)
  })

  it('is recognised by isOverpayment and translated by paymentError', async () => {
    const invoice = await issueUnpaid()
    try {
      await sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoice.id}, 1, 'cash', '1010', ${GROSS + 1}, ${TRADING_DATE}::date)
      `
      expect.unreachable('the ceiling did not fire')
    } catch (err) {
      expect(isOverpayment(err)).toBe(true)
      expect(isRefundExceedingPayments(err)).toBe(false)
      expect(paymentError(err)?.kind).toBe('conflict')
    }
  })
})

describe('a refund', () => {
  /** A document paid in full, ready to be refunded. */
  async function paidInFull(): Promise<{ id: string; displayNumber: string }> {
    const invoice = await issueUnpaid()
    await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-paid-${RUN}-${nonce}`,
        tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: GROSS }],
      }),
    )
    return invoice
  }

  it('is refused without a credit note, before anything is written', async () => {
    const invoice = await paidInFull()
    await expect(
      withUnitOfWork(sql, TILL, (uow) =>
        manualPaymentAdapter().refund(uow, {
          invoiceId: invoice.id,
          tradingDate: TRADING_DATE,
          entryId: `je-mtill07-norefund-${RUN}-${nonce}`,
          tenderKind: 'cash',
          postingAccountCode: '1010',
          amountFils: 1_000,
        }),
      ),
    ).rejects.toThrow(RefundRequiresCreditNote)
    expect((await readInvoiceSettlement(sql, invoice.id))?.refundedFils).toBe(0)

    // And the database's own half, reached past the adapter: `credit_note_id` is NOT NULL, so no path
    // writes a refund without one.
    const refused = await stateOf(
      sql`
        insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                            posting_account_code, amount_fils, trading_date)
        values (${invoice.id}, null, 1, 'cash', '1010', 1000, ${TRADING_DATE}::date)
      `,
    )
    expect(refused.code).toBe('23502')
    expect(refused.message).toContain('credit_note_id')
  })

  it('posts a new entry crediting the tender account, never an edit of the sale', async () => {
    const invoice = await paidInFull()
    const creditNote = await creditNoteFor(invoice.id, 'posts')
    const refunded = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().refund(uow, {
        invoiceId: invoice.id,
        creditNoteId: creditNote,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-refund-${RUN}-${nonce}`,
        tenderKind: 'cash',
        postingAccountCode: '1010',
        amountFils: 10_000,
      }),
    )
    expect(refunded.creditNoteId).toBe(creditNote)
    expect(refunded.refundNo).toBe(1)

    const settlement = await readInvoiceSettlement(sql, invoice.id)
    expect(settlement?.refundedFils).toBe(10_000)
    // Refunds are reported BESIDE the outstanding figure, not subtracted from it: a refund follows a
    // credit note, and the credited amount is M-TILL-08's. Subtracting it here would state a receivable
    // for a supply that had been credited in full.
    expect(settlement?.outstandingFils).toBe(0)

    // Dr 1050, Cr 1010 — the reverse of the payment, as its own entry with its own date.
    const lines = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
      select account_code, debit_fils, credit_fils from journal_line
       where entry_id = ${`je-mtill07-refund-${RUN}-${nonce}`} order by line_no
    `
    expect(
      lines.map((line) => [line.account_code, Number(line.debit_fils), Number(line.credit_fils)]),
    ).toEqual([
      [TRADE_RECEIVABLES_ACCOUNT_CODE, 10_000, 0],
      ['1010', 0, 10_000],
    ])
    // The sale's entry is untouched: a correction is a new entry, never an edit (ADR 0017).
    const [sale] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_line where entry_id = ${`je-mtill07-paid-${RUN}-${nonce}`}
    `
    expect(Number(sale?.n)).toBe(2)
    const [source] = await sql<{ source: string }[]>`
      select source from journal_entry where entry_id = ${`je-mtill07-refund-${RUN}-${nonce}`}
    `
    expect(source?.source).toBe('refund')
  })

  it('is refused above what was applied, by the adapter and by the database', async () => {
    const invoice = await paidInFull()
    const creditNote = await creditNoteFor(invoice.id, 'toomuch')
    await expect(
      withUnitOfWork(sql, TILL, (uow) =>
        manualPaymentAdapter().refund(uow, {
          invoiceId: invoice.id,
          creditNoteId: creditNote,
          tradingDate: TRADING_DATE,
          entryId: `je-mtill07-toomuch-${RUN}-${nonce}`,
          tenderKind: 'cash',
          postingAccountCode: '1010',
          amountFils: GROSS + 1,
        }),
      ),
    ).rejects.toThrow(RefundExceedsPayments)

    // Past the adapter, so the trigger is the thing being tested.
    const refused = await stateOf(
      sql`
        insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                            posting_account_code, amount_fils, trading_date)
        values (${invoice.id}, ${creditNote}, 1, 'cash', '1010', ${GROSS + 1},
                ${TRADING_DATE}::date)
      `,
    )
    expect(refused.code).toBe(PAYMENT_SQLSTATE.refundExceedsPayments)

    // The control: the whole amount applied IS refundable, so the refusal is about the one fils.
    await sql`
      insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                          posting_account_code, amount_fils, trading_date)
      values (${invoice.id}, ${creditNote}, 1, 'cash', '1010', ${GROSS}, ${TRADING_DATE}::date)
    `
  })

  it('numbers refunds per document, and refuses a repeated number', async () => {
    const invoice = await paidInFull()
    const creditNote = await creditNoteFor(invoice.id, 'numbers')
    const first = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().refund(uow, {
        invoiceId: invoice.id,
        creditNoteId: creditNote,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-r1-${RUN}-${nonce}`,
        tenderKind: 'cash',
        postingAccountCode: '1010',
        amountFils: 1_000,
      }),
    )
    const second = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().refund(uow, {
        invoiceId: invoice.id,
        creditNoteId: creditNote,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-r2-${RUN}-${nonce}`,
        tenderKind: 'cash',
        postingAccountCode: '1010',
        amountFils: 2_000,
      }),
    )
    expect([first.refundNo, second.refundNo]).toEqual([1, 2])

    const repeated = await stateOf(
      sql`
        insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                            posting_account_code, amount_fils, trading_date)
        values (${invoice.id}, ${creditNote}, 1, 'cash', '1010', 1, ${TRADING_DATE}::date)
      `,
    )
    expect(repeated.code).toBe('23505')
    expect(repeated.message).toContain(PAYMENT_CONSTRAINT.oneRowPerRefund)
  })
})

describe('the manual adapter needs no network', () => {
  it('captures and refunds with fetch and the HTTP clients replaced by throwing stubs', async () => {
    const invoice = await issueUnpaid()

    const realFetch = globalThis.fetch
    const realHttp = http.request
    const realHttps = https.request
    const explode = (): never => {
      throw new Error('the network was reached')
    }
    // `node:net` is deliberately NOT stubbed: the PostgreSQL driver uses it, so stubbing it would test
    // the harness rather than the adapter. What IS stubbed is every way an outbound HTTP call can be
    // made, which is what a gateway adapter in this directory would need.
    globalThis.fetch = explode as unknown as typeof fetch
    ;(http as { request: unknown }).request = explode
    ;(https as { request: unknown }).request = explode
    try {
      // The control FIRST, so a broken sabotage cannot make the rest of this case meaningless: the
      // stubs must actually bite.
      expect(() => globalThis.fetch('https://example.invalid')).toThrow(/the network was reached/)
      expect(() => https.request('https://example.invalid')).toThrow(/the network was reached/)
      expect(() => http.request('http://example.invalid')).toThrow(/the network was reached/)

      const captured = await withUnitOfWork(sql, TILL, (uow) =>
        manualPaymentAdapter().capture(uow, {
          invoiceId: invoice.id,
          tradingDate: TRADING_DATE,
          entryId: `je-mtill07-offline-${RUN}-${nonce}`,
          tenders: [{ tenderKind: 'cash', postingAccountCode: '1010', amountFils: GROSS }],
        }),
      )
      expect(captured.appliedFils).toBe(GROSS)

      // After the capture, which is the order production uses — and inside the stubbed region on
      // purpose: issuing a credit note reaches no network either.
      const creditNote = await creditNoteFor(invoice.id, 'offline')

      const authorised = await manualPaymentAdapter().authorise(sql, {
        invoiceId: invoice.id,
        offeredFils: 1,
      })
      expect(authorised.acceptable).toBe(false)
      expect(authorised.outstandingFils).toBe(0)

      const refunded = await withUnitOfWork(sql, TILL, (uow) =>
        manualPaymentAdapter().refund(uow, {
          invoiceId: invoice.id,
          creditNoteId: creditNote,
          tradingDate: TRADING_DATE,
          entryId: `je-mtill07-offline-refund-${RUN}-${nonce}`,
          tenderKind: 'cash',
          postingAccountCode: '1010',
          amountFils: 5_000,
        }),
      )
      expect(refunded.amountFils).toBe(5_000)

      const answer = await withUnitOfWork(sql, TILL, (uow) =>
        manualPaymentAdapter().reconcileWebhook(uow, { reference: 'PSP-1', amountFils: 1 }),
      )
      expect(answer.outcome).toBe('not_mine')
    } finally {
      // Restored in a `finally`, because a stubbed `fetch` left behind fails whatever suite runs next
      // with an error that has nothing to do with it.
      globalThis.fetch = realFetch
      ;(http as { request: unknown }).request = realHttp
      ;(https as { request: unknown }).request = realHttps
    }
  })
})

describe('authorise', () => {
  it('answers what is outstanding and whether the offer fits', async () => {
    const invoice = await issueUnpaid()
    const whole = await manualPaymentAdapter().authorise(sql, {
      invoiceId: invoice.id,
      offeredFils: GROSS,
    })
    expect(whole).toEqual({
      invoiceId: invoice.id,
      outstandingFils: GROSS,
      offeredFils: GROSS,
      acceptable: true,
    })
    // One fils over is not acceptable, which is the same boundary `ZT001` holds.
    expect(
      (
        await manualPaymentAdapter().authorise(sql, {
          invoiceId: invoice.id,
          offeredFils: GROSS + 1,
        })
      ).acceptable,
    ).toBe(false)
  })

  it('refuses to answer for a document that does not exist', async () => {
    await expect(
      manualPaymentAdapter().authorise(sql, {
        invoiceId: '00000000-0000-4000-8000-00000000dead',
        offeredFils: 1,
      }),
    ).rejects.toThrow(/no invoice/)
  })
})

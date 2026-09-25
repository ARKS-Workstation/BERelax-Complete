import {
  ACCOUNTS,
  filsFrom,
  money,
  reconcileSettlement,
  settleTenders,
  TENDER_KINDS,
  TENDER_TYPES,
} from '@berelax/core'
import type { Actor, IssueInvoiceInput, RegisteredTenderType, Sql } from '@berelax/db'
import {
  createConnection,
  issueInvoice,
  manualPaymentAdapter,
  readInvoiceSettlement,
  readTenderTypes,
  TRADE_RECEIVABLES_ACCOUNT_CODE,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-TILL-07's pair: the tender-type registry in `@berelax/core` and the one in the database are the same
 * registry, and the figures core settles are the figures the database records.
 *
 * `packages/db` may never import `packages/core`, so the account each tender type is debited to is stated
 * twice — `TENDER_ACCOUNT` in `packages/core/src/checkout/posting.ts`, where the posting rule reads it,
 * and `tender_type.posting_account_code`, which is what `payment.posting_account_code` is SNAPSHOTTED
 * from. A snapshot has to be taken from something, and the snapshot is what makes re-mapping a tender
 * type in two years unable to restate a posting already filed. This file is the only place the two can be
 * compared, because `packages/fixtures` is the package allowed to depend on both (brief rule 4) — the
 * same arrangement `checkout-finalisation.itest.ts` has for the posting rule.
 *
 * Three account codes are spelled in SQL and in TypeScript and are held equal here for the same reason:
 * `2040` in `invoice_payable_fils` (via `tips_payable_account_code()`), `1050` in
 * `TRADE_RECEIVABLES_ACCOUNT_CODE`, and each tender type's own account.
 *
 * ## The gratuity coupling, and why it is asserted here
 *
 * `ZT001` caps what may be applied to a document at its gross **plus the gratuity its own posting
 * collected**. Without the second half, every tipped checkout would be an overpayment: a gratuity is not
 * consideration for a supply, so it is on no tax invoice and absent from `invoice.gross_total`, while
 * M-TILL-06's tenders sum to the basket's gross INCLUDING the tip. The end-to-end proof of that is
 * `checkout-finalisation.itest.ts`, which finalises a checkout with a 3,000-fils gratuity and would go
 * red on this ceiling; what is proved here is the arithmetic itself, from a document and an entry built
 * in this file, so a failure says which half is wrong.
 *
 * ## Isolation
 *
 * The documents are this file's own, numbered from the `TAX-INV` series like every other suite's, and the
 * invoice family is truncated in `beforeEach` — `invoice` refuses DELETE for every role (ZI003), so
 * truncate as the OWNER is the only legal removal, and every referencing table is NAMED because
 * PostgreSQL refuses a truncate while one is missing from the statement.
 */

const TEST_TRN = '100123456700003'
const TILL: Actor = { kind: 'staff', label: 'M-TILL-07 pair itest' }
const TRADING_DATE = '2026-09-19'
const TAX_POINT = '2026-09-18'

/**
 * One line at AED 262.50 gross, 5% VAT: net = round(26_250 * 20 / 21) = 25_000, VAT = the remainder,
 * 1_250. Gross is authoritative and VAT is derived (ADR 0007), so the three add up exactly.
 */
const GROSS = 26_250
const NET = 25_000
const VAT = 1_250
/** A gratuity of AED 30.00. On no tax invoice, and handed over all the same. */
const TIP = 3_000

let sql: Sql
/**
 * A per-RUN prefix and a per-TEST counter for every entry id this file allocates.
 *
 * `journal_entry` is append-only and is truncated by nobody, so an id built from a counter alone collides
 * with the previous run's — which reads as a primary-key violation in a file that has not changed.
 * `checkout-finalisation.itest.ts` takes the same precaution for the same reason.
 */
const RUN = Date.now().toString(36)
let nonce = 0

beforeAll(() => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(
    'truncate refund, checkout_finalisation, payment, invoice_appointment, invoice_line, invoice',
  )
  await sql`
    update document_series
       set next_number = 1, period_key = '', prefix = 'TI-', padding = 5, reset_policy = 'annual'
     where code = 'TAX-INV'
  `
  nonce += 1
})

function oneTreatment(): IssueInvoiceInput {
  return {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: {
      legalName: 'BE RELAX SPA - L.L.C - O.P.C',
      tradingName: 'BE RELAX - Massage Center and Spa',
      trn: TEST_TRN,
      addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
      emirate: 'Abu Dhabi',
    },
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
  }
}

async function issueUnpaid(): Promise<{ id: string; displayNumber: string }> {
  return withUnitOfWork(sql, TILL, async (uow) => {
    const invoice = await issueInvoice(uow, oneTreatment())
    return { id: invoice.id, displayNumber: invoice.displayNumber }
  })
}

describe('the tender-type registry is one registry, stated in two places', () => {
  it('agrees with @berelax/core on every type, in both directions', async () => {
    const rows = await readTenderTypes(sql)
    const byCode = new Map<string, RegisteredTenderType>(rows.map((row) => [row.code, row]))

    // Direction 1: every type core knows about is in the database, with the same account and the same
    // three behaviours.
    for (const kind of TENDER_KINDS) {
      const spec = TENDER_TYPES[kind]
      const row = byCode.get(kind)
      expect(row, `the database holds a tender type "${kind}"`).toBeDefined()
      expect(row?.postingAccountCode).toBe(spec.account)
      expect(row?.givesChange).toBe(spec.givesChange)
      expect(row?.requiresReference).toBe(spec.requiresReference)
      expect(row?.settlesImmediately).toBe(spec.settlesImmediately)
      expect(row?.adapter).toBe(spec.adapter)
      expect(row?.sortOrder).toBe(spec.sortOrder)
    }

    // Direction 2: the database holds no type core does not know about. Without this the comparison is
    // satisfied by a database that has grown a fourth tender type nothing can post.
    expect(rows.map((row) => row.code).sort()).toEqual([...TENDER_KINDS].sort())
  })

  it('the control: the comparison would notice a disagreement', async () => {
    // The same assertion, run against a deliberately wrong expectation. Four booleans and a string
    // compared equal is exactly the shape that passes when both sides are read from one source by
    // mistake — which is what this rules out.
    const rows = await readTenderTypes(sql)
    const card = rows.find((row) => row.code === 'card_in_salon')
    expect(card?.postingAccountCode).not.toBe(ACCOUNTS.bankCurrent)
    expect(card?.postingAccountCode).toBe(ACCOUNTS.cardTerminalClearing)
    // And the direction check is not vacuous either: a code the registry does not hold is absent.
    expect(rows.map((row) => row.code)).not.toContain('gift_card')
  })

  it('states the gratuity and receivable account codes once, and they match the chart', async () => {
    // `2040` appears in SQL only inside this function, so the ZT001 ceiling and the chart can be
    // compared in one assertion rather than wherever the literal happened to be typed.
    const [tips] = await sql<{ code: string }[]>`select tips_payable_account_code() as code`
    expect(tips?.code).toBe(ACCOUNTS.tipsPayable)
    // `1050` is spelled in packages/db because that package may not import the chart. Same trade-off as
    // `postBill`'s TRADE_PAYABLES_ACCOUNT_CODE, and the same answer: assert the pair here.
    expect(TRADE_RECEIVABLES_ACCOUNT_CODE).toBe(ACCOUNTS.tradeReceivables)
    // The controls: both would notice the account somebody would reach for instead.
    expect(tips?.code).not.toBe(ACCOUNTS.gratuityLiability)
    expect(TRADE_RECEIVABLES_ACCOUNT_CODE).not.toBe(ACCOUNTS.tradePayables)
  })
})

describe('what core settles is what the database records', () => {
  it('carries a partial payment through to the stored row and the outstanding figure', async () => {
    const invoice = await issueUnpaid()
    //   due       26_250
    //   tendered  10_000
    //   applied   10_000
    //   left      16_250
    const settlement = settleTenders({
      due: money(filsFrom(GROSS)),
      tenders: [{ kind: 'cash', amount: money(filsFrom(10_000)) }],
    })
    expect(reconcileSettlement(settlement).dueVersusAppliedAndOutstandingFils).toBe(0)

    const captured = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-pair-partial-${RUN}-${nonce}`,
        // Mapped field for field from what core settled. Nothing is re-derived on the way.
        tenders: settlement.tenders.map((tender) => ({
          tenderKind: tender.kind,
          postingAccountCode: tender.account as string,
          amountFils: tender.tendered.fils,
          changeGivenFils: tender.changeGiven.fils,
          ...(tender.reference === undefined ? {} : { reference: tender.reference }),
        })),
      }),
    )

    expect(captured.appliedFils).toBe(settlement.applied.fils)
    expect(captured.changeGivenFils).toBe(settlement.changeGiven.fils)
    // The receivable core computed and the receivable the database reports are the same figure.
    expect(captured.outstandingFils).toBe(settlement.outstanding.fils)
    const stored = await readInvoiceSettlement(sql, invoice.id)
    expect(stored?.outstandingFils).toBe(settlement.outstanding.fils)
    expect(stored?.outstandingFils).toBe(16_250)
  })

  it('carries an over-tender through as two figures, not one', async () => {
    const invoice = await issueUnpaid()
    //   due       26_250
    //   tendered  30_000 (a 300-dirham note)
    //   applied   26_250
    //   change     3_750
    const settlement = settleTenders({
      due: money(filsFrom(GROSS)),
      tenders: [{ kind: 'cash', amount: money(filsFrom(30_000)) }],
    })
    expect(settlement.changeGiven.fils).toBe(3_750)

    const captured = await withUnitOfWork(sql, TILL, (uow) =>
      manualPaymentAdapter().capture(uow, {
        invoiceId: invoice.id,
        tradingDate: TRADING_DATE,
        entryId: `je-mtill07-pair-change-${RUN}-${nonce}`,
        tenders: settlement.tenders.map((tender) => ({
          tenderKind: tender.kind,
          postingAccountCode: tender.account as string,
          amountFils: tender.tendered.fils,
          changeGivenFils: tender.changeGiven.fils,
        })),
      }),
    )

    const stored = await readInvoiceSettlement(sql, invoice.id)
    // The three figures survive the round trip separately. A netted implementation would store 26_250
    // as the tender and lose what was in the operator's hand.
    expect(stored?.tenderedFils).toBe(30_000)
    expect(stored?.changeGivenFils).toBe(3_750)
    expect(stored?.appliedFils).toBe(GROSS)
    expect(captured.payments[0]?.amountFils).toBe(30_000)
    expect(captured.payments[0]?.appliedFils).toBe(GROSS)
    expect(stored?.tenderedFils).not.toBe(stored?.appliedFils)
  })
})

describe('the payable total includes the gratuity the document collected', () => {
  /**
   * A document, a balanced entry crediting `2040`, and the `checkout_finalisation` row that links them.
   *
   * Built here rather than through `finaliseCheckout`, so a failure says the ARITHMETIC is wrong rather
   * than that something in the checkout path is. The end-to-end proof is
   * `checkout-finalisation.itest.ts`, which finalises a real checkout carrying a gratuity.
   */
  async function documentWithATip(): Promise<string> {
    const invoice = await issueUnpaid()
    const entry = `je-mtill07-tip-${RUN}-${nonce}`
    // ONE transaction, because the balance invariant in 0018 is a DEFERRED constraint trigger: three
    // implicit transactions would commit an entry with no lines and be refused by name.
    await sql.begin(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entry}, ${TRADING_DATE}::date, 'M-TILL-07 pair probe', 'sale')
      `
      // Dr 1010 at gross + tip, Cr 4010 net, Cr 2030 VAT, Cr 2040 the gratuity. Balanced by
      // construction: 25_000 + 1_250 + 3_000 = 29_250 = 26_250 + 3_000.
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils) values
          (${entry}, 1, '1010', ${GROSS + TIP}, 0),
          (${entry}, 2, '2030', 0, ${VAT}),
          (${entry}, 3, ${ACCOUNTS.tipsPayable}, 0, ${TIP}),
          (${entry}, 4, '4010', 0, ${NET})
      `
      await tx`
        insert into checkout_finalisation (
          idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id, trading_date,
          tender_total_fils
        ) values (
          ${`mtill07-pair-${RUN}-${nonce}`}, ${`fp-${nonce}`}, ${`basket-${nonce}`}, ${invoice.id},
          ${entry}, ${TRADING_DATE}::date, ${GROSS + TIP}
        )
      `
    })
    return invoice.id
  }

  it('lets a tender covering the gross plus the tip be applied in full', async () => {
    const invoiceId = await documentWithATip()
    const settlement = await readInvoiceSettlement(sql, invoiceId)
    expect(settlement?.grossFils).toBe(GROSS)
    // The document's gross plus the gratuity its own entry credited: 26_250 + 3_000.
    expect(settlement?.payableFils).toBe(GROSS + TIP)
    expect(settlement?.outstandingFils).toBe(GROSS + TIP)

    // And the whole amount is accepted, which is what a tipped checkout writes. Without the gratuity in
    // the ceiling this is the insert that would fail with ZT001 for every tipped sale in the business.
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           trading_date)
      values (${invoiceId}, 1, 'cash', '1010', ${GROSS + TIP}, ${TRADING_DATE}::date)
    `
    expect((await readInvoiceSettlement(sql, invoiceId))?.outstandingFils).toBe(0)
  })

  it('the control: one fils above the gross plus the tip is still refused', async () => {
    // Which is what makes the case above about the gratuity rather than about the ceiling being gone.
    const invoiceId = await documentWithATip()
    let code: string | undefined
    try {
      await sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoiceId}, 1, 'cash', '1010', ${GROSS + TIP + 1}, ${TRADING_DATE}::date)
      `
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('ZT001')
  })

  it('a document with no gratuity is payable for its gross alone', async () => {
    // The other control: the gratuity term is read from the entry, so a document without one must not
    // acquire headroom from somewhere else.
    const invoice = await issueUnpaid()
    const settlement = await readInvoiceSettlement(sql, invoice.id)
    expect(settlement?.payableFils).toBe(GROSS)
    expect(settlement?.payableFils).not.toBe(GROSS + TIP)
  })
})

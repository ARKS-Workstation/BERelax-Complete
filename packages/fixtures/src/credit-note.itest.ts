import type { AccountCode } from '@berelax/core'
import {
  ACCOUNTS,
  accountFor,
  CREDIT_NOTE_SETTLEMENT_ACCOUNT,
  entryId,
  localDate,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type { Actor, IssuedInvoice, PostedJournalEntry, Sql } from '@berelax/db'
import {
  createConnection,
  issueCreditNote,
  issueInvoice,
  postJournalEntry,
  readCreditNote,
  readInvoice,
  readInvoiceSettlement,
  readJournalEntry,
  TRADE_RECEIVABLES_ACCOUNT_CODE,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { creditNoteMapping, creditNoteReconciliation } from './credit-note.ts'
import { FIXTURE_ISSUER } from './invoice.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-TILL-08's pair: an invoice and a full credit note net to zero in the rows PostgreSQL holds.
 *
 * `packages/db` may never import `packages/core`, so the two halves of this unit are proved separately —
 * the posting rule in `packages/core/src/checkout/credit-note.test.ts`, the schema and the transaction
 * in `packages/db/src/services/issue-credit-note.itest.ts` — and the PAIR can only be proved here, in
 * the package allowed to depend on both. The same arrangement `checkout-finalisation.itest.ts` has for
 * M-TILL-06.
 *
 * What only this file can show:
 *
 *   - **the acceptance line about netting**, over `journal_line` rather than over the values the writer
 *     returned: every revenue account and the output VAT account back to zero, every VAT201 box back to
 *     zero, and the settlement pair equal and opposite until a refund clears them both;
 *   - that the three copies of the settlement account code — the chart's, `@berelax/db`'s and the
 *     migration's — are one account and not three;
 *   - that a DISCOUNTED document nets its contra account to zero as well, which is the case a credit
 *     note built from the invoice's own figures cannot get right and the reversal built from the SALE's
 *     entry does.
 *
 * ## Isolation
 *
 * Every entry this file posts is dated inside a window no other suite uses, and every total is read
 * through that window — so a stale invoice or a leftover journal row from an earlier file cannot reach an
 * assertion. `customerId` is deliberately null (a cash sale at the desk, ADR 0014), so nothing here
 * leaves a document pointing at a customer another suite deletes.
 */

/**
 * A window no other suite posts into — and a DIFFERENT window for each test in this one.
 *
 * `accountTotals` is the production reader and it takes a date window, so the only way to narrow it to
 * one test is to date that test's entries on their own days. Sharing one window failed exactly the way
 * hazard 12 in the brief describes: `journal_entry` is append-only and nothing truncates it, so the
 * third case in this file read the first two cases' sale entries and found the drawer 9,600 fils down.
 * The alternative — filtering on an entry-id prefix — would have meant not reading the figures through
 * the reader a report uses.
 */
/**
 * Dates in a year no other suite posts into, and a month each so two cases in this file cannot share one.
 *
 * The isolation that actually matters is NOT the date, though, and getting there took two wrong answers.
 * `accountTotals` is the production reader and it narrows by date window — but `journal_entry` is
 * append-only and truncated by nobody, so a window can only ever be unique on a FRESH database: this
 * file's own earlier runs sit in the same 2098 months and made the drawer read 48,600 fils out. A date
 * cannot carry a run id. So the totals below are summed over this run's own entry ids instead, which is
 * hazard 12 in the brief followed rather than argued with: narrow what the reader can SEE.
 */
const month = () => String(nonce).padStart(2, '0')
const supplyDate = () => `2098-${month()}-05`
const creditDate = () => `2098-${month()}-15`
const refundDate = () => `2098-${month()}-25`

const TILL: Actor = { kind: 'staff', label: 'M-TILL-08 pair itest' }

/**
 * One line, three units at 1100 fils gross.
 *
 * Line gross 3300, net = 3300 - round(3300 * 5 / 105) = 3300 - 157 = 3143, VAT 157.
 */
const QUANTITY = 3
const UNIT_GROSS = 1100
const RATE_BP = 500
const GROSS = 3300
const NET = 3143
const VAT = 157

/** A 300-fils discount on the same line: net 286, VAT 14, so the customer is charged 3000 gross. */
const DISCOUNT_NET = 286
const DISCOUNT_VAT = 14
const CHARGED_GROSS = 3000
const CHARGED_NET = 2857
const CHARGED_VAT = 143

let sql: Sql
const RUN = `mtill08-pair-${Date.now().toString(36)}`
let nonce = 0

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // The trading calendar is a TABLE (0011). Nothing here writes an appointment, so no business_day row
  // is needed — the document dates are plain dates and `journal_entry.entry_date` is deliberately not a
  // foreign key into it (0018: the journal must be able to record an accrual dated on a period end).
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(
    'truncate credit_note_line, credit_note, refund, checkout_finalisation, payment, ' +
      'invoice_appointment, invoice_line, invoice',
  )
  await sql`
    update document_series set next_number = 1, period_key = ''
     where code in ('TAX-INV', 'CR-NOTE')
  `
  // Every lock in this file's YEAR, not only the ones it made — it makes none. `journal.itest.ts` locks
  // and unlocks real periods and its `beforeEach` deletes every row of `period_lock`, so whatever its
  // last period-lock case created survives into the files that run after it. A lock over 2098 would
  // refuse every note below with a message about a period nothing here mentions (hazard 12). Scoped to
  // 2098 so it cannot remove a lock another suite relies on.
  await sql`delete from period_lock where starts_on >= '2098-01-01' and ends_on <= '2098-12-31'`
  nonce += 1
  // A month per test, so the twelfth test in this file would silently start sharing a window with the
  // first. Fail here instead, where the cause is stated.
  if (nonce > 12) {
    throw new Error(
      `this file gives each test its own MONTH of 2098 and has run out at test ${nonce}. Widen the ` +
        'year, do not let two tests share a window — that is how the totals below read another case.',
    )
  }
})

interface SoldDocument {
  readonly invoice: IssuedInvoice
  readonly saleEntry: PostedJournalEntry
}

/**
 * An invoice, the entry a cash checkout posts for it, the `checkout_finalisation` row that links the
 * two, and the payment.
 *
 * Written here rather than through `finaliseCheckout` on purpose: that service needs appointments, a
 * booking, a room, a service variant and a trading-day row, all of which
 * `checkout-finalisation.itest.ts` already builds to prove M-TILL-06. What this file is about is the
 * arithmetic of the correction, and the shortest honest setup for that is the document and its entry.
 *
 * `discounted` posts the sale the way `checkoutPosting` does for a discounted line: `Cr 4010` at the
 * LIST net and `Dr 4095` with the discount, so revenue-net-of-contra is what the document states.
 */
async function sell(discounted: boolean): Promise<SoldDocument> {
  const saleEntryId = `${RUN}-${nonce}-sale-${discounted ? 'disc' : 'plain'}`
  const lineGross = discounted ? CHARGED_GROSS : GROSS
  const lineNet = discounted ? CHARGED_NET : NET
  const lineVat = discounted ? CHARGED_VAT : VAT
  const unitGross = discounted ? lineGross / QUANTITY : UNIT_GROSS

  return withUnitOfWork(sql, TILL, async (uow) => {
    const invoice = await issueInvoice(uow, {
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      issuer: {
        legalName: FIXTURE_ISSUER.legalName,
        tradingName: FIXTURE_ISSUER.tradingName,
        trn: FIXTURE_ISSUER.trn,
        addressSnapshot: FIXTURE_ISSUER.addressLines.join('\n'),
        emirate: FIXTURE_ISSUER.emirate,
      },
      customer: { nameSnapshot: 'Customer 0042' },
      issueDate: supplyDate(),
      issueTradingDate: supplyDate(),
      taxPointDate: supplyDate(),
      lines: [
        {
          descriptionEn: 'Asian Normal Massage, 60 minutes',
          quantity: QUANTITY,
          unitGrossFils: unitGross,
          vatRateBp: RATE_BP,
          netFils: lineNet,
          vatFils: lineVat,
        },
      ],
      netTotalFils: lineNet,
      vatTotalFils: lineVat,
      grossTotalFils: lineGross,
    })

    const saleLines = discounted
      ? [
          { accountCode: '1010', debitFils: CHARGED_GROSS, creditFils: 0 },
          { accountCode: '2030', debitFils: 0, creditFils: VAT },
          { accountCode: '2030', debitFils: DISCOUNT_VAT, creditFils: 0 },
          { accountCode: '4010', debitFils: 0, creditFils: NET },
          { accountCode: '4095', debitFils: DISCOUNT_NET, creditFils: 0 },
        ]
      : [
          { accountCode: '1010', debitFils: GROSS, creditFils: 0 },
          { accountCode: '2030', debitFils: 0, creditFils: VAT },
          { accountCode: '4010', debitFils: 0, creditFils: NET },
        ]

    const saleEntry = await postJournalEntry(uow, {
      entryId: saleEntryId,
      entryDate: supplyDate(),
      narrative: `Checkout ${saleEntryId}`,
      source: 'sale',
      lines: saleLines,
    })

    await uow.sql`
      insert into checkout_finalisation
        (idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id, trading_date,
         tender_total_fils)
      values (${saleEntryId}, 'fp', ${saleEntryId}, ${invoice.id}, ${saleEntryId},
              ${supplyDate()}::date, ${lineGross})
    `
    await uow.sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           trading_date)
      values (${invoice.id}, 1, 'cash', '1010', ${lineGross}, ${supplyDate()}::date)
    `

    const stored = await readInvoice(uow.sql, invoice.id)
    return { invoice: stored as IssuedInvoice, saleEntry }
  })
}

/**
 * `sum(credit) - sum(debit)` per account over THIS test's entries.
 *
 * The same arithmetic `accountTotals` does — `coalesce(sum(debit))`, `coalesce(sum(credit))`, grouped by
 * account — with the window replaced by the one predicate a date cannot express. Every entry this case
 * posts is named `<run>-<test>-…`, and nothing else in the database is.
 */
async function netByAccount(): Promise<Map<string, number>> {
  const prefix = `${RUN}-${nonce}-%`
  const rows = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
    select l.account_code,
           coalesce(sum(l.debit_fils), 0)  as debit_fils,
           coalesce(sum(l.credit_fils), 0) as credit_fils
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where e.entry_id like ${prefix}
     group by l.account_code
     order by l.account_code
  `
  return new Map(
    rows.map((row) => [row.account_code, Number(row.credit_fils) - Number(row.debit_fils)]),
  )
}

/** The same, grouped by the VAT201 box each account feeds, read from the `account` table. */
async function netByVatBox(): Promise<Map<string, number>> {
  const boxes = await sql<{ code: string; vat_box: string | null }[]>`
    select code, vat_box from account
  `
  const boxOf = new Map(boxes.map((row) => [row.code, row.vat_box]))
  const out = new Map<string, number>()
  for (const [code, net] of await netByAccount()) {
    const box = boxOf.get(code)
    if (box === null || box === undefined) continue
    out.set(box, (out.get(box) ?? 0) + net)
  }
  return out
}

describe('the settlement account is one account, not three copies of a literal', () => {
  it('the chart, @berelax/db and the migration agree', async () => {
    const [row] = await sql<
      { code: string }[]
    >`select credit_note_settlement_account_code() as code`
    expect(row?.code).toBe(CREDIT_NOTE_SETTLEMENT_ACCOUNT as string)
    expect(row?.code).toBe(TRADE_RECEIVABLES_ACCOUNT_CODE)
    expect(CREDIT_NOTE_SETTLEMENT_ACCOUNT).toBe(ACCOUNTS.tradeReceivables)
    // And it is an account the chart actually classifies, so the agreement is about a real account
    // rather than three copies of the same typo.
    expect(accountFor(STANDARD_SPA_CHART, row?.code as AccountCode).type).toBe('asset')
  })

  it('the control: the comparison would notice a disagreement', async () => {
    // Without this, the case above is satisfied by any three equal strings — including three wrong ones.
    const [row] = await sql<{ code: string }[]>`select tips_payable_account_code() as code`
    expect(row?.code).not.toBe(CREDIT_NOTE_SETTLEMENT_ACCOUNT as string)
    expect(row?.code).toBe(ACCOUNTS.tipsPayable as string)
  })
})

describe('an invoice plus a full credit note', () => {
  it('nets every revenue account and the output VAT to zero, exact to the fils', async () => {
    const sold = await sell(false)

    // The control comes first: before the note, the supply accounts carry the sale.
    const before = await netByAccount()
    expect(before.get(ACCOUNTS.treatmentRevenue as string)).toBe(NET)
    expect(before.get(ACCOUNTS.outputVatPayable as string)).toBe(VAT)

    const mapping = creditNoteMapping({
      invoice: sold.invoice,
      saleEntry: sold.saleEntry,
      entryId: entryId(`${RUN}-${nonce}-note`),
      creditDate: localDate(creditDate()),
      reason: 'The therapist delivered the wrong treatment',
    })
    // Every difference the deferred triggers cannot see, before anything is written.
    expect(creditNoteReconciliation(mapping)).toEqual({
      noteNetVersusLinesFils: 0,
      noteVatVersusLinesFils: 0,
      noteGrossVersusLinesFils: 0,
      reversalImbalanceFils: 0,
      noteGrossVersusLiabilityFils: 0,
    })

    const note = await withUnitOfWork(sql, TILL, (uow) => issueCreditNote(uow, mapping.input))
    expect(note.displayNumber).toBe('CN-2098-00001')

    const after = await netByAccount()
    expect(after.get(ACCOUNTS.treatmentRevenue as string)).toBe(0)
    expect(after.get(ACCOUNTS.outputVatPayable as string)).toBe(0)
    // Nothing else on a revenue account moved at all.
    for (const [code, net] of after) {
      if (accountFor(STANDARD_SPA_CHART, code as AccountCode).type !== 'revenue') continue
      expect(net, `revenue account ${code}`).toBe(0)
    }
    // What is left is the settlement pair, equal and opposite: the drawer is still up by the gross and
    // 1050 carries the same figure the other way. That residue is "money held against a debt now owed
    // back", and the refund below clears it.
    expect(after.get(ACCOUNTS.cashInDrawer as string)).toBe(-GROSS)
    expect(after.get(CREDIT_NOTE_SETTLEMENT_ACCOUNT as string)).toBe(GROSS)
  })

  it('nets every VAT201 box to zero, exact to the fils', async () => {
    const sold = await sell(false)

    const before = await netByVatBox()
    // The control: the boxes the sale feeds are non-zero first, so the zeros below are a cancellation
    // rather than a query that reached nothing.
    expect(before.get('standard_rated_supplies')).toBe(NET)
    expect(before.get('output_tax')).toBe(VAT)
    expect(before.size).toBeGreaterThan(0)

    await withUnitOfWork(sql, TILL, (uow) =>
      issueCreditNote(
        uow,
        creditNoteMapping({
          invoice: sold.invoice,
          saleEntry: sold.saleEntry,
          entryId: entryId(`${RUN}-${nonce}-note-box`),
          creditDate: localDate(creditDate()),
          reason: 'The therapist delivered the wrong treatment',
        }).input,
      ),
    )

    const after = await netByVatBox()
    expect(after.size).toBe(before.size)
    for (const [box, net] of after) expect(net, `VAT201 box ${box}`).toBe(0)
  })

  it('nets the DISCOUNT contra to zero as well, which the document’s own figures cannot do', async () => {
    const sold = await sell(true)
    expect(sold.invoice.grossTotalFils).toBe(CHARGED_GROSS)

    const mapping = creditNoteMapping({
      invoice: sold.invoice,
      saleEntry: sold.saleEntry,
      entryId: entryId(`${RUN}-${nonce}-note-disc`),
      creditDate: localDate(creditDate()),
      reason: 'The therapist delivered the wrong treatment',
    })
    // The note states the CHARGED figures, because that is what the customer was billed. The reversal
    // debits the LIST net and credits the discount back, because that is what the sale posted — which
    // is the whole reason the reversal is built from the entry rather than from the note.
    expect(mapping.input.grossTotalFils).toBe(CHARGED_GROSS)
    const revenueLine = mapping.reversal.lines.find(
      (line) => line.account === ACCOUNTS.treatmentRevenue,
    )
    expect(revenueLine?.debitFils).toBe(NET)
    expect(revenueLine?.debitFils).not.toBe(CHARGED_NET)

    await withIssued(mapping.input)

    const after = await netByAccount()
    expect(after.get(ACCOUNTS.treatmentRevenue as string)).toBe(0)
    expect(after.get(ACCOUNTS.discountsAndAllowances as string)).toBe(0)
    expect(after.get(ACCOUNTS.outputVatPayable as string)).toBe(0)
    for (const [box, net] of await netByVatBox()) expect(net, `VAT201 box ${box}`).toBe(0)
  })

  it('and a full refund nets EVERY account the three documents touched to zero', async () => {
    const sold = await sell(false)
    const note = await withIssued(
      creditNoteMapping({
        invoice: sold.invoice,
        saleEntry: sold.saleEntry,
        entryId: entryId(`${RUN}-${nonce}-note-refund`),
        creditDate: localDate(creditDate()),
        reason: 'The therapist delivered the wrong treatment',
      }).input,
    )

    // The refund, posted the way 0068's adapter posts one: Dr 1050, Cr the tender account. Written here
    // rather than through `manualPaymentAdapter().refund` because the adapter allocates its own
    // `refund_no` and reads its own settlement, and what this case is about is the third entry closing
    // the pair the note left open.
    const refundEntryId = `${RUN}-${nonce}-refund`
    await withUnitOfWork(sql, TILL, async (uow) => {
      await uow.sql`
        insert into refund (invoice_id, credit_note_id, refund_no, tender_kind, posting_account_code,
                            amount_fils, trading_date)
        values (${sold.invoice.id}, ${note.id}, 1, 'cash', '1010', ${GROSS}, ${refundDate()}::date)
      `
      await postJournalEntry(uow, {
        entryId: refundEntryId,
        entryDate: refundDate(),
        narrative: `Refund on ${sold.invoice.displayNumber} against ${note.displayNumber}`,
        source: 'refund',
        lines: [
          { accountCode: TRADE_RECEIVABLES_ACCOUNT_CODE, debitFils: GROSS, creditFils: 0 },
          { accountCode: '1010', debitFils: 0, creditFils: GROSS },
        ],
      })
    })

    const after = await netByAccount()
    // Every account. Not a chosen subset: the acceptance line says "every affected account", and after
    // the money has actually gone back there is nothing left to hold.
    expect(after.size).toBeGreaterThan(2)
    for (const [code, net] of after) expect(net, `account ${code}`).toBe(0)

    // And the settlement view agrees: credited and refunded both the gross, nothing receivable either
    // way, and `outstanding_fils` never moved — which is the decision 0068 asked this unit to take.
    const settlement = await readInvoiceSettlement(sql, sold.invoice.id)
    expect(settlement?.creditedFils).toBe(GROSS)
    expect(settlement?.refundedFils).toBe(GROSS)
    expect(settlement?.receivableFils).toBe(0)
    expect(settlement?.outstandingFils).toBe(0)
  })
})

describe('the stored note is the note core computed', () => {
  it('every line and every total round-trips unchanged', async () => {
    const sold = await sell(false)
    const mapping = creditNoteMapping({
      invoice: sold.invoice,
      saleEntry: sold.saleEntry,
      entryId: entryId(`${RUN}-${nonce}-note-trip`),
      creditDate: localDate(creditDate()),
      reason: 'The therapist delivered the wrong treatment',
    })
    const issued = await withIssued(mapping.input)
    const stored = await readCreditNote(sql, issued.id)

    expect(stored?.netTotalFils).toBe(mapping.input.netTotalFils)
    expect(stored?.vatTotalFils).toBe(mapping.input.vatTotalFils)
    expect(stored?.grossTotalFils).toBe(mapping.input.grossTotalFils)
    expect(stored?.taxPointDate).toBe(creditDate())
    expect(stored?.lines).toHaveLength(1)
    expect(stored?.lines[0]?.vatFils).toBe(VAT)
    // The generated column, computed by the database and not by the mapping.
    expect(stored?.lines[0]?.lineGrossFils).toBe(GROSS)

    // The reversal, as the journal holds it: dated on the NOTE, classified as a reversal, and naming the
    // sale it corrects.
    const entry = await readJournalEntry(sql, stored?.journalEntryId as string)
    expect(entry?.entryDate).toBe(creditDate())
    expect(entry?.entryDate).not.toBe(supplyDate())
    expect(entry?.source).toBe('reversal')
    expect(entry?.reverses).toBe(sold.saleEntry.entryId)
    expect(entry?.lines.map((line) => [line.accountCode, line.debitFils, line.creditFils])).toEqual(
      [
        ['2030', VAT, 0],
        ['4010', NET, 0],
        [TRADE_RECEIVABLES_ACCOUNT_CODE, 0, GROSS],
      ],
    )
  })
})

/** Issues a mapped note in its own unit of work. */
async function withIssued(input: Parameters<typeof issueCreditNote>[1]) {
  return withUnitOfWork(sql, TILL, (uow) => issueCreditNote(uow, input))
}

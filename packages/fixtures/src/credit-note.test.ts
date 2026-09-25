import type { EntryId, JournalEntry, LocalDate } from '@berelax/core'
import {
  ACCOUNTS,
  credit as creditLine,
  debit as debitLine,
  entryId,
  filsFrom,
  localDate,
  money,
  postEntry,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type { IssuedInvoice, PostedJournalEntry } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import { creditNoteMapping, creditNoteReconciliation, toCoreEntry } from './credit-note.ts'
import { FIXTURE_ISSUER } from './invoice.ts'

/**
 * The mapping between core's credit-note rule and the database's writer, with nothing running.
 *
 * What only the integration test can show is that the rows PostgreSQL holds agree with this; what this
 * shows is the arithmetic, including the one case a full and a partial credit legitimately disagree on.
 */

const SALE = entryId('sale-1')
const NOTE = entryId('sale-1-CN1')
const SUPPLY_DATE = '2026-09-18'
/** October: a later period than the supply, which is the whole point of a credit note's own date. */
const CREDIT_DATE = localDate('2026-10-04')

/**
 * One line, three units at 1100 fils gross.
 *
 * Line gross 3300, net = 3300 - round(3300 * 5 / 105) = 3300 - 157 = 3143, VAT 157. One unit on its own
 * is 1100 gross, net 1048, VAT 52 — so three partial credits carry 156 fils of VAT and the line carries
 * 157. That one fils is why a full credit COPIES and only a partial one derives.
 */
const LINE = {
  lineNo: 1,
  descriptionEn: 'Asian Normal Massage, 60 minutes',
  descriptionAr: null,
  quantity: 3,
  unitGrossFils: 1100,
  lineGrossFils: 3300,
  vatRateBp: 500,
  netFils: 3143,
  vatFils: 157,
} as const

const ONE_UNIT_NET = 1048
const ONE_UNIT_VAT = 52

const INVOICE: IssuedInvoice = {
  id: '00000000-0000-4000-8000-00000000inv1'.replace('inv', 'a01'),
  documentKind: 'tax_invoice',
  seriesCode: 'TAX-INV',
  periodKey: '2026',
  number: 1,
  displayNumber: 'TI-2026-00001',
  issuerLegalName: FIXTURE_ISSUER.legalName,
  issuerTradingName: FIXTURE_ISSUER.tradingName,
  issuerTrn: FIXTURE_ISSUER.trn,
  issuerAddressSnapshot: FIXTURE_ISSUER.addressLines.join('\n'),
  issuerEmirate: FIXTURE_ISSUER.emirate,
  issuerPhone: null,
  issuerLicenceNumber: null,
  issuerLegalNameAr: null,
  issuerAddressSnapshotAr: null,
  customerId: null,
  bookingId: null,
  customerNameSnapshot: 'Customer 0042',
  customerTrn: null,
  customerAddressSnapshot: null,
  customerPhone: null,
  issueDate: SUPPLY_DATE,
  issueTradingDate: SUPPLY_DATE,
  taxPointDate: SUPPLY_DATE,
  issuedAt: new Date('2026-09-18T18:00:00Z'),
  currency: 'AED',
  netTotalFils: LINE.netFils,
  vatTotalFils: LINE.vatFils,
  grossTotalFils: LINE.lineGrossFils,
  notes: null,
  lines: [LINE],
}

/** Dr 1010 3300, Cr 4010 3143, Cr 2030 157 — the entry a cash checkout of that invoice posts. */
const SALE_ENTRY: PostedJournalEntry = {
  entryId: SALE as string,
  entryDate: SUPPLY_DATE,
  narrative: 'Checkout basket-1',
  source: 'sale',
  currency: 'AED',
  reverses: null,
  postedAt: new Date('2026-09-18T18:00:00Z'),
  lines: [
    { lineNo: 1, accountCode: '1010', debitFils: 3300, creditFils: 0, currency: 'AED', memo: null },
    { lineNo: 2, accountCode: '2030', debitFils: 0, creditFils: 157, currency: 'AED', memo: null },
    { lineNo: 3, accountCode: '4010', debitFils: 0, creditFils: 3143, currency: 'AED', memo: null },
  ],
}

function map(credited?: readonly { lineNo: number; quantity?: number }[]) {
  return creditNoteMapping({
    invoice: INVOICE,
    saleEntry: SALE_ENTRY,
    entryId: NOTE,
    creditDate: CREDIT_DATE,
    reason: 'The therapist delivered the wrong treatment',
    ...(credited === undefined ? {} : { credited }),
  })
}

describe('a stored entry read as core sees it', () => {
  it('keeps every account, amount and side, and the reversal link', () => {
    const entry = toCoreEntry({ ...SALE_ENTRY, reverses: 'earlier-1' })
    expect(entry.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      ['1010', 3300, 0],
      ['2030', 0, 157],
      ['4010', 0, 3143],
    ])
    expect(entry.reverses).toBe('earlier-1')
    // The control: a null stays null rather than becoming the string 'null', which is what a careless
    // cast produces and what `journal_entry.reverses` would then store.
    expect(toCoreEntry(SALE_ENTRY).reverses).toBeNull()
  })
})

describe('a full credit note', () => {
  it('copies the line’s own net and VAT rather than re-deriving them', () => {
    const { input } = map()
    expect(input.lines).toHaveLength(1)
    expect(input.lines[0]?.quantity).toBe(3)
    // 157, the figure the LINE carries. Three units derived separately give 3 × 52 = 156, and ZD005
    // refuses that on a full credit precisely because the two must agree.
    expect(input.lines[0]?.vatFils).toBe(LINE.vatFils)
    expect(input.lines[0]?.vatFils).not.toBe(ONE_UNIT_VAT * 3)
    expect(input.netTotalFils).toBe(LINE.netFils)
    expect(input.vatTotalFils).toBe(LINE.vatFils)
    expect(input.grossTotalFils).toBe(LINE.lineGrossFils)
  })

  it('mirrors the sale’s supply side and parks the gross in 1050', () => {
    const { reversal, input } = map()
    expect(reversal.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      ['2030', 157, 0],
      ['4010', 3143, 0],
      [ACCOUNTS.tradeReceivables, 0, 3300],
    ])
    // The tender is untouched: the cash is still in the drawer until a refund row moves it.
    expect(reversal.lines.map((line) => line.account as string)).not.toContain('1010')
    expect(input.reversal.entryDate).toBe(CREDIT_DATE as string)
    expect(input.reversal.source).toBe('reversal')
    expect(input.reversal.reverses).toBe(SALE as string)
  })

  it('every reconciliation difference is zero', () => {
    expect(creditNoteReconciliation(map())).toEqual({
      noteNetVersusLinesFils: 0,
      noteVatVersusLinesFils: 0,
      noteGrossVersusLinesFils: 0,
      reversalImbalanceFils: 0,
      noteGrossVersusLiabilityFils: 0,
    })
  })

  it('the control: a mapping whose totals are wrong reports a non-zero difference', () => {
    // Without this, a reconciliation that returned zeros unconditionally would pass the case above for
    // ever — the exact shape of a check that has quietly died (ADR 0002).
    const mapping = map()
    const broken = {
      reversal: mapping.reversal,
      input: { ...mapping.input, vatTotalFils: mapping.input.vatTotalFils + 1 },
    }
    expect(creditNoteReconciliation(broken).noteVatVersusLinesFils).toBe(1)
  })
})

describe('a partial credit note', () => {
  it('derives its tax on the credited gross', () => {
    const { input, reversal } = map([{ lineNo: 1, quantity: 1 }])
    expect(input.lines[0]?.quantity).toBe(1)
    expect(input.lines[0]?.netFils).toBe(ONE_UNIT_NET)
    expect(input.lines[0]?.vatFils).toBe(ONE_UNIT_VAT)
    expect(input.grossTotalFils).toBe(1100)
    expect(reversal.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      ['4010', ONE_UNIT_NET, 0],
      ['2030', ONE_UNIT_VAT, 0],
      [ACCOUNTS.tradeReceivables, 0, 1100],
    ])
    expect(creditNoteReconciliation({ input, reversal }).reversalImbalanceFils).toBe(0)
  })

  it('refuses a line the invoice does not have, before a number is allocated', () => {
    expect(() => map([{ lineNo: 2 }])).toThrow(/has no line 2 to credit/)
  })
})

describe('the reversal reads the sale rather than assuming it', () => {
  it('gives the discount back on a full credit of a discounted document', () => {
    // List 3300 gross (net 3143, VAT 157), a 300-fils discount (net 286, VAT 14), charged 3000 gross:
    // net 2857, VAT 143. The invoice LINE states the charged figures; the entry states the list credit
    // to 4010 and the contra debit to 4095.
    const discounted: PostedJournalEntry = {
      ...SALE_ENTRY,
      lines: [
        {
          lineNo: 1,
          accountCode: '1010',
          debitFils: 3000,
          creditFils: 0,
          currency: 'AED',
          memo: null,
        },
        {
          lineNo: 2,
          accountCode: '2030',
          debitFils: 0,
          creditFils: 157,
          currency: 'AED',
          memo: null,
        },
        {
          lineNo: 3,
          accountCode: '2030',
          debitFils: 14,
          creditFils: 0,
          currency: 'AED',
          memo: null,
        },
        {
          lineNo: 4,
          accountCode: '4010',
          debitFils: 0,
          creditFils: 3143,
          currency: 'AED',
          memo: null,
        },
        {
          lineNo: 5,
          accountCode: '4095',
          debitFils: 286,
          creditFils: 0,
          currency: 'AED',
          memo: null,
        },
      ],
    }
    const charged = {
      ...LINE,
      unitGrossFils: 1000,
      lineGrossFils: 3000,
      netFils: 2857,
      vatFils: 143,
    }
    const { reversal } = creditNoteMapping({
      invoice: {
        ...INVOICE,
        netTotalFils: 2857,
        vatTotalFils: 143,
        grossTotalFils: 3000,
        lines: [charged],
      },
      saleEntry: discounted,
      entryId: NOTE,
      creditDate: CREDIT_DATE,
      reason: 'The therapist delivered the wrong treatment',
    })
    expect(reversal.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      // 157 credited less 14 relieved by the discount.
      ['2030', 143, 0],
      // The LIST net, not the charged net: the sale credited 3143 there and a correction gives that
      // back. The discount is given back too, on the other side.
      ['4010', 3143, 0],
      ['4095', 0, 286],
      [ACCOUNTS.tradeReceivables, 0, 3000],
    ])
  })

  it('refuses a PARTIAL credit of a discounted document by name', () => {
    // The apportionment between 4010 and 4095 is an undecided policy, not a missing calculation. See
    // the NOTE on M-TILL-08.
    const discounted = postEntry(
      {
        entryId: SALE,
        entryDate: SUPPLY_DATE as unknown as LocalDate,
        narrative: 'One treatment with a discount, cash',
        source: 'sale',
        lines: [
          debitLine(ACCOUNTS.cashInDrawer, money(filsFrom(3000))),
          creditLine(ACCOUNTS.treatmentRevenue, money(filsFrom(3143))),
          creditLine(ACCOUNTS.outputVatPayable, money(filsFrom(143))),
          debitLine(ACCOUNTS.discountsAndAllowances, money(filsFrom(286))),
        ],
      },
      STANDARD_SPA_CHART,
    )
    const stored: PostedJournalEntry = {
      entryId: discounted.entryId as string,
      entryDate: discounted.entryDate as string,
      narrative: discounted.narrative,
      source: discounted.source,
      currency: 'AED',
      reverses: null,
      postedAt: new Date('2026-09-18T18:00:00Z'),
      lines: discounted.lines.map((line, index) => ({
        lineNo: index + 1,
        accountCode: line.account as string,
        debitFils: line.debitFils,
        creditFils: line.creditFils,
        currency: 'AED',
        memo: line.memo,
      })),
    }
    expect(() =>
      creditNoteMapping({
        invoice: {
          ...INVOICE,
          netTotalFils: 2857,
          vatTotalFils: 143,
          grossTotalFils: 3000,
          lines: [
            { ...LINE, unitGrossFils: 1000, lineGrossFils: 3000, netFils: 2857, vatFils: 143 },
          ],
        },
        saleEntry: stored,
        entryId: NOTE,
        creditDate: CREDIT_DATE,
        reason: 'One of three units was not delivered',
        credited: [{ lineNo: 1, quantity: 1 }],
      }),
    ).toThrow(/cannot be posted/)
  })
})

describe('the entry ids stay the caller’s', () => {
  it('the reversal carries the id it was given, not one derived here', () => {
    // Core allocates no ids, and neither does this: a derived id would collide the second time a
    // document is credited, and `credit_note_one_reversal_per_entry` would refuse the second note for a
    // reason that says nothing about what went wrong.
    const mine = entryId('whatever-the-caller-chose') as EntryId
    const mapping = creditNoteMapping({
      invoice: INVOICE,
      saleEntry: SALE_ENTRY,
      entryId: mine,
      creditDate: CREDIT_DATE,
      reason: 'The therapist delivered the wrong treatment',
    })
    expect(mapping.input.reversal.entryId).toBe('whatever-the-caller-chose')
    const reversal: JournalEntry = mapping.reversal
    expect(reversal.entryId).toBe(mine)
  })
})

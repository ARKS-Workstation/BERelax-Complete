import { describe, expect, it } from 'vitest'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { EntryId, JournalEntry } from '../ledger/entry.ts'
import { credit, debit, entryId, imbalanceFils, postEntry } from '../ledger/entry.ts'
import { filsFrom, type Money, money } from '../money.ts'
import { localDate } from '../time.ts'
import {
  CREDIT_NOTE_SETTLEMENT_ACCOUNT,
  CreditNoteExceedsDocument,
  CreditNoteTotalsDisagree,
  creditNoteReversal,
  NothingToCredit,
  PartialCreditNeedsApportionment,
  supplyMovements,
  supplyTotalFils,
} from './credit-note.ts'

/**
 * The credit note's posting rule.
 *
 * Every figure below is written out with its arithmetic, because the point of most of these cases is
 * that a figure is NOT re-derived: the whole claim of a full credit is that it carries the sale's own
 * amounts, and a test that recomputed them would pass against a rule that recomputed them too.
 */

/**
 * A `Money` of integer FILS.
 *
 * Not `aed()`, which takes dirhams and multiplies by a hundred: every figure in this file is a fils
 * amount read off an invoice line, and `aed(1000)` for "1000 fils" is a hundredfold error that still
 * balances — which is exactly the shape of mistake ADR 0007 exists to make impossible.
 */
const f = (fils: number): Money => money(filsFrom(fils))

const SALE = entryId('sale-1')
const NOTE = entryId('sale-1-CN1')
const SALE_DATE = localDate('2026-09-18')
/** October, so the reversal lands in a period the invoice never reached. */
const NOTE_DATE = localDate('2026-10-04')

/** 1000 fils gross at 5%: net = 1000 - round(1000 * 5 / 105) = 1000 - 48 = 952. */
const GROSS = f(1000)
const NET = f(952)
const VAT = f(48)

/** Dr 1010 cash 1000, Cr 4010 952, Cr 2030 48. The ordinary undiscounted checkout. */
function plainSale(): JournalEntry {
  return postEntry(
    {
      entryId: SALE,
      entryDate: SALE_DATE,
      narrative: 'One treatment, cash',
      source: 'sale',
      lines: [
        debit(ACCOUNTS.cashInDrawer, GROSS, 'Tendered (cash)'),
        credit(ACCOUNTS.treatmentRevenue, NET, 'Treatments delivered'),
        credit(ACCOUNTS.outputVatPayable, VAT, 'Output VAT on supplies'),
      ],
    },
    STANDARD_SPA_CHART,
  )
}

/**
 * A discounted sale, on `posting.ts`'s shape: 4010 is credited at the LIST net and 4095 debited with
 * the discount's net, so revenue-net-of-contra is what the document states.
 *
 * List 1000 gross (net 952, VAT 48), a 200-fils discount (net 190, VAT 10), so the customer was
 * charged 800 gross: net 762, VAT 38. Dr 1010 800, Cr 4010 952, Cr 2030 48, Dr 4095 190, Dr 2030 10.
 * The supply side nets to 952 - 190 + 48 - 10 = 800.
 */
function discountedSale(): JournalEntry {
  return postEntry(
    {
      entryId: SALE,
      entryDate: SALE_DATE,
      narrative: 'One treatment with a discount, cash',
      source: 'sale',
      lines: [
        debit(ACCOUNTS.cashInDrawer, f(800), 'Tendered (cash)'),
        credit(ACCOUNTS.treatmentRevenue, f(952), 'Treatments delivered'),
        credit(ACCOUNTS.outputVatPayable, f(48), 'Output VAT on supplies'),
        debit(ACCOUNTS.discountsAndAllowances, f(190), 'Discounts and allowances'),
        debit(ACCOUNTS.outputVatPayable, f(10), 'VAT relieved by discounts'),
      ],
    },
    STANDARD_SPA_CHART,
  )
}

/** Net movement per account across a set of entries, positive in the credit direction. */
function netByAccount(entries: readonly JournalEntry[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of entries) {
    for (const line of entry.lines) {
      const previous = out.get(line.account as string) ?? 0
      out.set(line.account as string, previous + line.creditFils - line.debitFils)
    }
  }
  return out
}

function reversalOf(
  entry: JournalEntry,
  credited: { net: Money; vat: Money; gross: Money },
  id: EntryId = NOTE,
): JournalEntry {
  return creditNoteReversal(
    { entryId: id, entryDate: NOTE_DATE, invoiceEntry: entry, credited },
    STANDARD_SPA_CHART,
  )
}

describe('the supply side of a sale', () => {
  it('is the revenue accounts and the output VAT, and not the tender', () => {
    const movements = supplyMovements(plainSale(), STANDARD_SPA_CHART)
    expect(movements.map((m) => m.account)).toEqual([
      ACCOUNTS.outputVatPayable,
      ACCOUNTS.treatmentRevenue,
    ])
    expect(supplyTotalFils(movements)).toBe(1000)
  })

  it('the control: the tender account IS on the entry, so its absence above is a filter', () => {
    // Without this, a `supplyMovements` that returned an empty list would satisfy the case above's
    // "not the tender" half trivially — and the sum would be 0, which no assertion there rejects.
    const accounts = plainSale().lines.map((line) => line.account as string)
    expect(accounts).toContain(ACCOUNTS.cashInDrawer as string)
    expect(supplyTotalFils(supplyMovements(plainSale(), STANDARD_SPA_CHART))).toBeGreaterThan(0)
  })

  it('carries the discount contra with its own sign, and nets to what was charged', () => {
    const movements = supplyMovements(discountedSale(), STANDARD_SPA_CHART)
    expect(new Map(movements.map((m) => [m.account as string, m.netFils]))).toEqual(
      new Map([
        // 48 credited less 10 relieved by the discount.
        [ACCOUNTS.outputVatPayable as string, 38],
        [ACCOUNTS.treatmentRevenue as string, 952],
        [ACCOUNTS.discountsAndAllowances as string, -190],
      ]),
    )
    expect(supplyTotalFils(movements)).toBe(800)
  })

  it('omits an account whose debits and credits cancel exactly', () => {
    // The reachable case is a discount that relieves precisely the VAT the supply carried: 2030 is
    // credited 48 and debited 48. A zero line is refused by `journal_line_exactly_one_side`, so a
    // movement of zero has to be dropped here rather than posted.
    const cancelled = postEntry(
      {
        entryId: SALE,
        entryDate: SALE_DATE,
        narrative: 'A supply given away entirely',
        source: 'sale',
        lines: [
          credit(ACCOUNTS.treatmentRevenue, f(952), 'Treatments delivered'),
          credit(ACCOUNTS.outputVatPayable, f(48), 'Output VAT on supplies'),
          debit(ACCOUNTS.discountsAndAllowances, f(952), 'Discounts and allowances'),
          debit(ACCOUNTS.outputVatPayable, f(48), 'VAT relieved by discounts'),
        ],
      },
      STANDARD_SPA_CHART,
    )
    const movements = supplyMovements(cancelled, STANDARD_SPA_CHART)
    expect(movements.map((m) => m.account as string)).toEqual([
      ACCOUNTS.treatmentRevenue as string,
      ACCOUNTS.discountsAndAllowances as string,
    ])
    expect(supplyTotalFils(movements)).toBe(0)
  })
})

describe('a full credit note', () => {
  it('parks the credit in 1050, pinned by a literal', () => {
    // Pinned against the LITERAL and not against `ACCOUNTS`: every other assertion in this file reads
    // the constant, so a change to it would move them all with it and this suite would report a pass
    // about a reversal parking money somewhere else. 1050 is 0068's choice — a payment clears that
    // receivable and a refund re-creates it — and moving it is one decision across three files rather
    // than an edit here.
    expect(CREDIT_NOTE_SETTLEMENT_ACCOUNT).toBe('1050')
  })

  it('mirrors every supply movement and parks the gross in 1050', () => {
    const reversal = reversalOf(plainSale(), { net: NET, vat: VAT, gross: GROSS })
    expect(reversal.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      [ACCOUNTS.outputVatPayable, 48, 0],
      [ACCOUNTS.treatmentRevenue, 952, 0],
      [CREDIT_NOTE_SETTLEMENT_ACCOUNT, 0, 1000],
    ])
    expect(imbalanceFils(reversal.lines)).toBe(0)
  })

  it('touches neither the tender account nor the gratuity account', () => {
    // The whole reason this is not `reverseEntry`: the mirror of a checkout CREDITS the tender, which
    // says the cash left the drawer. It has not — a `refund` row moves it (0068).
    const tipped = postEntry(
      {
        entryId: SALE,
        entryDate: SALE_DATE,
        narrative: 'One treatment and a tip, cash',
        source: 'sale',
        lines: [
          debit(ACCOUNTS.cashInDrawer, f(1100), 'Tendered (cash)'),
          credit(ACCOUNTS.treatmentRevenue, NET, 'Treatments delivered'),
          credit(ACCOUNTS.outputVatPayable, VAT, 'Output VAT on supplies'),
          credit(ACCOUNTS.tipsPayable, f(100), 'Gratuities collected'),
        ],
      },
      STANDARD_SPA_CHART,
    )
    const accounts = reversalOf(tipped, { net: NET, vat: VAT, gross: GROSS }).lines.map(
      (line) => line.account as string,
    )
    expect(accounts).not.toContain(ACCOUNTS.cashInDrawer as string)
    expect(accounts).not.toContain(ACCOUNTS.tipsPayable as string)
    // The control: both ARE on the sale, so their absence is this rule filtering rather than an
    // entry that never had them.
    const sold = tipped.lines.map((line) => line.account as string)
    expect(sold).toContain(ACCOUNTS.cashInDrawer as string)
    expect(sold).toContain(ACCOUNTS.tipsPayable as string)
  })

  it('is dated on the note, not on the sale, and names the entry it reverses', () => {
    const reversal = reversalOf(plainSale(), { net: NET, vat: VAT, gross: GROSS })
    expect(reversal.entryDate).toBe(NOTE_DATE)
    expect(reversal.entryDate).not.toBe(SALE_DATE)
    expect(reversal.source).toBe('reversal')
    expect(reversal.reverses).toBe(SALE)
  })

  it('nets the invoice to zero in every account either document touched, bar the settlement pair', () => {
    const sale = plainSale()
    const reversal = reversalOf(sale, { net: NET, vat: VAT, gross: GROSS })
    const net = netByAccount([sale, reversal])
    expect(net.get(ACCOUNTS.treatmentRevenue as string)).toBe(0)
    expect(net.get(ACCOUNTS.outputVatPayable as string)).toBe(0)
    // What is left is exactly the money held against a debt now owed back: the drawer is still up by
    // the gross and 1050 carries the same figure on the other side. 0068's refund posts `Dr 1050 / Cr`
    // the tender, so it clears both — asserted against real rows in
    // packages/fixtures/src/credit-note.itest.ts.
    expect(net.get(ACCOUNTS.cashInDrawer as string)).toBe(-1000)
    expect(net.get(CREDIT_NOTE_SETTLEMENT_ACCOUNT as string)).toBe(1000)
  })

  it('nets a DISCOUNTED invoice to zero in the contra account as well', () => {
    const sale = discountedSale()
    // The charged figures: 800 gross, net 762, VAT 38.
    const reversal = reversalOf(sale, { net: f(762), vat: f(38), gross: f(800) })
    const net = netByAccount([sale, reversal])
    expect(net.get(ACCOUNTS.treatmentRevenue as string)).toBe(0)
    expect(net.get(ACCOUNTS.discountsAndAllowances as string)).toBe(0)
    expect(net.get(ACCOUNTS.outputVatPayable as string)).toBe(0)
    // And the reversal did NOT post the charged net against 4010: it mirrored the list net and gave
    // the discount back, which is the difference a partial credit cannot make for itself.
    const revenueLine = reversal.lines.find((line) => line.account === ACCOUNTS.treatmentRevenue)
    expect(revenueLine?.debitFils).toBe(952)
    expect(revenueLine?.debitFils).not.toBe(762)
  })
})

describe('a partial credit note', () => {
  it('posts its own net and VAT against the one revenue account the sale used', () => {
    // Half the supply: 500 gross, net = 500 - round(500 * 5 / 105) = 500 - 24 = 476, VAT 24.
    const reversal = reversalOf(plainSale(), {
      net: f(476),
      vat: f(24),
      gross: f(500),
    })
    expect(reversal.lines.map((line) => [line.account, line.debitFils, line.creditFils])).toEqual([
      [ACCOUNTS.treatmentRevenue, 476, 0],
      [ACCOUNTS.outputVatPayable, 24, 0],
      [CREDIT_NOTE_SETTLEMENT_ACCOUNT, 0, 500],
    ])
    expect(imbalanceFils(reversal.lines)).toBe(0)
  })

  it('posts two lines and no zero VAT line for a zero-rated supply', () => {
    const zeroRated = postEntry(
      {
        entryId: SALE,
        entryDate: SALE_DATE,
        narrative: 'A zero-rated supply',
        source: 'sale',
        lines: [
          debit(ACCOUNTS.cashInDrawer, f(1000), 'Tendered (cash)'),
          credit(ACCOUNTS.treatmentRevenue, f(1000), 'Treatments delivered'),
        ],
      },
      STANDARD_SPA_CHART,
    )
    const reversal = reversalOf(zeroRated, { net: f(400), vat: f(0), gross: f(400) })
    expect(reversal.lines).toHaveLength(2)
    expect(reversal.lines.map((line) => line.account as string)).not.toContain(
      ACCOUNTS.outputVatPayable as string,
    )
    expect(imbalanceFils(reversal.lines)).toBe(0)
  })

  it('is refused against a discounted sale, naming both revenue accounts', () => {
    expect(() => reversalOf(discountedSale(), { net: f(381), vat: f(19), gross: f(400) })).toThrow(
      PartialCreditNeedsApportionment,
    )
    try {
      reversalOf(discountedSale(), { net: f(381), vat: f(19), gross: f(400) })
      expect.unreachable('a partial credit of a discounted sale must be refused')
    } catch (err) {
      expect((err as Error).message).toContain(ACCOUNTS.treatmentRevenue as string)
      expect((err as Error).message).toContain(ACCOUNTS.discountsAndAllowances as string)
    }
  })

  it('the control: a FULL credit of the same discounted sale is accepted', () => {
    // Without this, the refusal above would be consistent with a rule that refuses every credit of a
    // discounted document, which is not what it is for.
    expect(() =>
      reversalOf(discountedSale(), { net: f(762), vat: f(38), gross: f(800) }),
    ).not.toThrow()
  })
})

describe('what a credit note is refused for', () => {
  it('a gross above the document', () => {
    expect(() => reversalOf(plainSale(), { net: f(953), vat: f(48), gross: f(1001) })).toThrow(
      CreditNoteExceedsDocument,
    )
  })

  it('a gross of zero', () => {
    expect(() => reversalOf(plainSale(), { net: f(0), vat: f(0), gross: f(0) })).toThrow(
      NothingToCredit,
    )
  })

  it('net plus VAT that does not equal the gross', () => {
    expect(() => reversalOf(plainSale(), { net: f(952), vat: f(47), gross: f(1000) })).toThrow(
      CreditNoteTotalsDisagree,
    )
  })

  it('the control: the exact boundary — one fils less, and the same shapes are accepted', () => {
    // 1000 is the document, so 1000 must pass and 1001 must not. A ceiling asserted only from the
    // outside is satisfied by a rule that refuses everything.
    expect(() => reversalOf(plainSale(), { net: NET, vat: VAT, gross: GROSS })).not.toThrow()
    expect(() => reversalOf(plainSale(), { net: f(951), vat: f(48), gross: f(999) })).not.toThrow()
  })
})

describe('the narrative', () => {
  it('is the caller’s when one is given, and a stated default when not', () => {
    const given = creditNoteReversal(
      {
        entryId: NOTE,
        entryDate: NOTE_DATE,
        invoiceEntry: plainSale(),
        credited: { net: NET, vat: VAT, gross: GROSS },
        narrative: 'Credit note CN-2026-00001: the wrong treatment was delivered',
      },
      STANDARD_SPA_CHART,
    )
    expect(given.narrative).toBe('Credit note CN-2026-00001: the wrong treatment was delivered')
    // The default names the entry it corrects and the amount, because an append-only entry nobody can
    // read is not evidence — `postEntry` refuses a blank one outright.
    const derived = reversalOf(plainSale(), { net: NET, vat: VAT, gross: GROSS })
    expect(derived.narrative).toContain(SALE as string)
    expect(derived.narrative).toContain('1000 fils')
    expect(derived.narrative).not.toBe(given.narrative)
  })
})

describe('the reversal is deterministic', () => {
  it('two runs over one sale produce byte-identical lines', () => {
    // `checkoutPosting` sorts by account code for this reason: an insertion-ordered entry diffs
    // everywhere the moment a basket's line order changes, and a working paper that diffs is a
    // working paper nobody reconciles.
    const shuffled = postEntry(
      {
        entryId: SALE,
        entryDate: SALE_DATE,
        narrative: 'The same sale, lines declared in another order',
        source: 'sale',
        lines: [
          credit(ACCOUNTS.outputVatPayable, VAT, 'Output VAT on supplies'),
          debit(ACCOUNTS.cashInDrawer, GROSS, 'Tendered (cash)'),
          credit(ACCOUNTS.treatmentRevenue, NET, 'Treatments delivered'),
        ],
      },
      STANDARD_SPA_CHART,
    )
    const a = reversalOf(plainSale(), { net: NET, vat: VAT, gross: GROSS })
    const b = reversalOf(shuffled, { net: NET, vat: VAT, gross: GROSS })
    expect(JSON.stringify(b.lines)).toBe(JSON.stringify(a.lines))
  })
})

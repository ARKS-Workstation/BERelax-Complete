import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { isBalanced, postEntry } from '../ledger/entry.ts'
import { aed, filsFrom, money, splitGross, UAE_STANDARD_VAT_BP, vatRateBp } from '../money.ts'
import { localDate } from '../time.ts'
import {
  BILL_TAX_TREATMENTS,
  billDebitTotal,
  billEntryDraft,
  deriveBill,
  deriveBillLine,
  isRecoverable,
  RECOVERABLE_INPUT_VAT_ACCOUNT,
  TRADE_PAYABLES_ACCOUNT,
} from './bill.ts'

/**
 * M-VAT-01, the pure half: what a supplier bill costs and what of it may be reclaimed.
 *
 * The three properties worth testing are the ones a VAT return is built on — `net + vat === gross` for
 * every input, only a standard-rated line carrying VAT, and a claim that equals the line's own VAT — and
 * each is paired with the wrong answer it is easy to produce instead.
 */

const ENTRY_DATE = localDate('2026-09-18')

describe('gross is authoritative and VAT is the remainder', () => {
  it('splits a 5% line so that net + vat is exactly the gross', () => {
    const line = deriveBillLine({
      description: 'Rent, September',
      account: ACCOUNTS.rent,
      gross: aed(105),
      treatment: 'standard_recoverable',
    })
    expect(line.net.fils).toBe(10_000)
    expect(line.vat.fils).toBe(500)
    expect(line.gross.fils).toBe(10_500)
    expect(line.net.fils + line.vat.fils).toBe(line.gross.fils)
    expect(line.recoverableInputVat.fils).toBe(500)
    expect(line.rateBp).toBe(UAE_STANDARD_VAT_BP)
  })

  it('keeps net + vat === gross on an amount that does not divide, where independent rounding fails', () => {
    // 10501 fils at 5%: net rounds to 10001 and the VAT is the remainder, 500. Rounding the VAT
    // independently gives round(10501 × 500 / 10500) = 500 and a net of 10001 — which sums to 10501 by
    // luck here and does not for every input, which is the whole reason the remainder is used.
    const line = deriveBillLine({
      description: 'Consumables',
      account: ACCOUNTS.consumablesUsed,
      gross: money(filsFrom(10_501)),
      treatment: 'standard_recoverable',
    })
    expect(line.net.fils).toBe(10_001)
    expect(line.vat.fils).toBe(500)
    expect(line.net.fils + line.vat.fils).toBe(10_501)
  })

  it('holds net + vat === gross for every gross from 1 fils to 10 million', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (grossFils) => {
        const line = deriveBillLine({
          description: 'Property',
          account: ACCOUNTS.rent,
          gross: money(filsFrom(grossFils)),
          treatment: 'standard_recoverable',
        })
        expect(line.net.fils + line.vat.fils).toBe(grossFils)
        expect(line.vat.fils).toBeGreaterThanOrEqual(0)
        expect(line.recoverableInputVat.fils).toBe(line.vat.fils)
      }),
      { numRuns: 500 },
    )
  })
})

describe('only a standard-rated line carries VAT', () => {
  it('leaves net equal to gross for every non-recoverable treatment, and claims nothing', () => {
    for (const treatment of BILL_TAX_TREATMENTS.filter((t) => !isRecoverable(t))) {
      const line = deriveBillLine({
        description: `A ${treatment} supply`,
        account: ACCOUNTS.licenceAndGovernmentFees,
        gross: aed(200),
        treatment,
      })
      expect(line.net.fils).toBe(20_000)
      expect(line.vat.fils).toBe(0)
      expect(line.gross.fils).toBe(20_000)
      expect(line.recoverableInputVat.fils).toBe(0)
      expect(line.rateBp).toBe(0)
    }
  })

  it('refuses a rate on a line that cannot carry VAT, rather than ignoring it', () => {
    // A 5% rate on a line recorded `exempt` is a preparer who described the line wrongly, and it is the
    // description that decides what is claimed. Silently zeroing the rate would record their mistake.
    expect(() =>
      deriveBillLine({
        description: 'Government fee',
        account: ACCOUNTS.licenceAndGovernmentFees,
        gross: aed(100),
        treatment: 'exempt',
        rateBp: UAE_STANDARD_VAT_BP,
      }),
    ).toThrow(/carries a rate of 500 bp/)

    // The control: the same line at an explicit zero rate is accepted, so the refusal above is about
    // the rate and not about passing one at all.
    expect(
      deriveBillLine({
        description: 'Government fee',
        account: ACCOUNTS.licenceAndGovernmentFees,
        gross: aed(100),
        treatment: 'exempt',
        rateBp: vatRateBp(0),
      }).vat.fils,
    ).toBe(0)
  })

  it('refuses a recoverable line at a zero rate, which is a zero-rated line misdescribed', () => {
    expect(() =>
      deriveBillLine({
        description: 'Export service',
        account: ACCOUNTS.professionalFees,
        gross: aed(100),
        treatment: 'standard_recoverable',
        rateBp: vatRateBp(0),
      }),
    ).toThrow(/at 0 bp/)
  })

  it('refuses a blank description and a non-positive gross', () => {
    expect(() =>
      deriveBillLine({
        description: '   ',
        account: ACCOUNTS.rent,
        gross: aed(100),
        treatment: 'exempt',
      }),
    ).toThrow(/needs a description/)
    expect(() =>
      deriveBillLine({
        description: 'Nothing at all',
        account: ACCOUNTS.rent,
        gross: money(filsFrom(0)),
        treatment: 'exempt',
      }),
    ).toThrow(/gross of 0 fils/)
  })
})

describe('a bill totals its derived lines', () => {
  const mixed = deriveBill([
    {
      description: 'Electricity',
      account: ACCOUNTS.utilities,
      gross: aed(525),
      treatment: 'standard_recoverable',
    },
    {
      description: 'Municipality fee',
      account: ACCOUNTS.licenceAndGovernmentFees,
      gross: aed(100),
      treatment: 'out_of_scope',
    },
  ])

  it('sums the lines and derives the VAT as gross - net', () => {
    expect(mixed.gross.fils).toBe(62_500)
    expect(mixed.net.fils).toBe(50_000 + 10_000)
    expect(mixed.vat.fils).toBe(2_500)
    expect(mixed.net.fils + mixed.vat.fils).toBe(mixed.gross.fils)
    expect(mixed.recoverableInputVat.fils).toBe(2_500)
  })

  it('totals the line VATs rather than splitting the total gross, which is a different figure', () => {
    // Two 11-fils lines: each nets to 10 with 1 fils of VAT, so the bill carries 2 fils of VAT on a
    // 22-fils gross. Splitting the TOTAL gross instead gives net 21 and VAT 1 — off by a fils, and it is
    // the per-line figure that appears on the supplier's invoice and in the VAT201 detail.
    const perLine = deriveBill([
      {
        description: 'A',
        account: ACCOUNTS.rent,
        gross: money(filsFrom(11)),
        treatment: 'standard_recoverable',
      },
      {
        description: 'B',
        account: ACCOUNTS.rent,
        gross: money(filsFrom(11)),
        treatment: 'standard_recoverable',
      },
    ])
    expect(perLine.vat.fils).toBe(2)
    expect(splitGross(money(filsFrom(22))).vat.fils).toBe(1)
  })

  it('refuses a bill with no lines', () => {
    expect(() => deriveBill([])).toThrow(/at least one line/)
  })
})

describe('the journal entry a bill posts', () => {
  const bill = deriveBill([
    {
      description: 'Rent, September',
      account: ACCOUNTS.rent,
      gross: aed(10_500),
      treatment: 'standard_recoverable',
    },
    {
      description: 'Laundry',
      account: ACCOUNTS.laundryAndCleaning,
      gross: aed(300),
      treatment: 'no_trn_not_recoverable',
    },
  ])

  const draft = billEntryDraft({
    entryId: 'JE-BILL-2026-00001',
    entryDate: ENTRY_DATE,
    narrative: 'Supplier bill BILL-2026-00001',
    bill,
  })

  it('debits each expense at net, debits the recoverable VAT once, and credits payables at gross', () => {
    expect(draft.source).toBe('supplier_bill')
    expect(draft.lines.map((line) => [line.account, line.side, line.amount.fils])).toEqual([
      [ACCOUNTS.rent, 'debit', 1_000_000],
      [ACCOUNTS.laundryAndCleaning, 'debit', 30_000],
      [RECOVERABLE_INPUT_VAT_ACCOUNT, 'debit', 50_000],
      [TRADE_PAYABLES_ACCOUNT, 'credit', 1_080_000],
    ])
  })

  it('balances through the ledger kernel, and the debit side is the gross', () => {
    const entry = postEntry(draft, STANDARD_SPA_CHART)
    expect(isBalanced(entry)).toBe(true)
    expect(billDebitTotal(bill).fils).toBe(bill.gross.fils)
  })

  it('omits the VAT debit entirely when nothing is recoverable, rather than posting a zero line', () => {
    // A zero line is not a posting, it is a line somebody forgot to fill in — and
    // journal_line_exactly_one_side in 0018 refuses it, so a draft carrying one could never be stored.
    const noClaim = deriveBill([
      {
        description: 'Cleaning',
        account: ACCOUNTS.laundryAndCleaning,
        gross: aed(300),
        treatment: 'no_trn_not_recoverable',
      },
    ])
    const entry = postEntry(
      billEntryDraft({
        entryId: 'JE-BILL-2026-00002',
        entryDate: ENTRY_DATE,
        narrative: 'Supplier bill BILL-2026-00002',
        bill: noClaim,
      }),
      STANDARD_SPA_CHART,
    )
    expect(entry.lines).toHaveLength(2)
    expect(entry.lines.map((line) => line.account)).toEqual([
      ACCOUNTS.laundryAndCleaning,
      TRADE_PAYABLES_ACCOUNT,
    ])
    expect(isBalanced(entry)).toBe(true)
  })

  it('names the two accounts a bill always touches, so a posting rule never spells a code', () => {
    expect(RECOVERABLE_INPUT_VAT_ACCOUNT).toBe(ACCOUNTS.recoverableInputVat)
    expect(TRADE_PAYABLES_ACCOUNT).toBe(ACCOUNTS.tradePayables)
  })
})

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
  carriesVat,
  deriveBill,
  deriveBillLine,
  isBlocked,
  RECOVERABLE_INPUT_VAT_ACCOUNT,
  selfAccountsVat,
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

describe('only a VAT-bearing treatment carries VAT', () => {
  it('leaves net equal to gross for every treatment that carries none, and claims nothing', () => {
    // Two of the seven treatments carry VAT THE SUPPLIER CHARGED: a recoverable line and a blocked one.
    // For the rest there is nothing to carve out — an unregistered supplier cannot charge VAT at all, and
    // a zero-rated, exempt or out-of-scope supply has none.
    //
    // `imported_services_reverse_charge` is left out of this loop and has its own tests in
    // `../tax/reverse-charge.test.ts`: it also leaves net equal to gross, because an offshore supplier
    // charges no UAE VAT — but it keeps its rate and self-accounts a pair of its own, so "claims nothing"
    // is false for it in the one way that matters.
    for (const treatment of BILL_TAX_TREATMENTS.filter(
      (t) => !carriesVat(t) && !selfAccountsVat(t),
    )) {
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
      expect(line.blockedInputVat.fils).toBe(0)
      expect(line.expenseDebit.fils).toBe(20_000)
      expect(line.rateBp).toBe(0)
    }
    // The control, and the reason the loop means anything: the two treatments left out of it DO carve
    // VAT out of the same gross. A `carriesVat` that answered false for everything would satisfy the
    // loop above, and a treatment quietly dropped out of the VAT-bearing pair is a line whose tax
    // disappears from both the claim and the disclosure.
    for (const treatment of BILL_TAX_TREATMENTS.filter(carriesVat)) {
      const line = deriveBillLine({
        description: `A ${treatment} supply`,
        account: isBlocked(treatment) ? ACCOUNTS.entertainment : ACCOUNTS.rent,
        gross: aed(200),
        treatment,
      })
      expect(line.net.fils, treatment).toBe(19_048)
      expect(line.vat.fils, treatment).toBe(952)
      expect(line.rateBp, treatment).toBe(UAE_STANDARD_VAT_BP)
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

describe('blocked input VAT is charged, not recoverable, and part of the cost', () => {
  /**
   * The entertainment bill the acceptance names: 5% charged on a category UAE VAT denies recovery on.
   *
   * 21,000 fils gross at 5% is 20,000 net and 1,000 of VAT exactly, so the figures are checkable by eye
   * and any change to the split shows up immediately.
   */
  const entertainment = deriveBillLine({
    description: 'Herbal tea and refreshments for the treatment rooms',
    account: ACCOUNTS.entertainment,
    gross: money(filsFrom(21_000)),
    treatment: 'blocked_not_recoverable',
  })

  it('carves the VAT out of the gross and then claims none of it', () => {
    expect(entertainment.net.fils).toBe(20_000)
    expect(entertainment.vat.fils).toBe(1_000)
    expect(entertainment.net.fils + entertainment.vat.fils).toBe(entertainment.gross.fils)
    // The whole point: the tax exists, and the claim does not.
    expect(entertainment.recoverableInputVat.fils).toBe(0)
    expect(entertainment.blockedInputVat.fils).toBe(1_000)
    // The control: the identical gross on a recoverable treatment claims all of it, so the zero above is
    // the treatment rather than the arithmetic.
    const recoverable = deriveBillLine({
      description: 'Rent',
      account: ACCOUNTS.rent,
      gross: money(filsFrom(21_000)),
      treatment: 'standard_recoverable',
    })
    expect(recoverable.recoverableInputVat.fils).toBe(1_000)
    expect(recoverable.blockedInputVat.fils).toBe(0)
  })

  it('debits the expense with the gross, because tax nobody can reclaim is cost', () => {
    expect(entertainment.expenseDebit.fils).toBe(21_000)
    // And the figure the wrong answer would produce, named so it can be asserted absent: debiting the
    // net would leave the entry 1,000 fils short of the payable, which the deferred balance trigger in
    // 0018 refuses at COMMIT with an arithmetic message that names no category.
    expect(entertainment.expenseDebit.fils - entertainment.net.fils).toBe(1_000)
  })

  it('posts a mixed bill that balances, with the blocked VAT nowhere near account 1080', () => {
    // One bill, two categories — the ordinary case a per-BILL treatment could not express: consumables
    // that are recoverable and refreshments that are not.
    const mixed = deriveBill([
      {
        description: 'Treatment consumables',
        account: ACCOUNTS.consumablesUsed,
        gross: money(filsFrom(10_500)),
        treatment: 'standard_recoverable',
      },
      {
        description: 'Customer refreshments',
        account: ACCOUNTS.entertainment,
        gross: money(filsFrom(4_200)),
        treatment: 'blocked_not_recoverable',
      },
    ])
    expect(mixed.gross.fils).toBe(14_700)
    expect(mixed.net.fils).toBe(10_000 + 4_000)
    expect(mixed.vat.fils).toBe(700)
    expect(mixed.recoverableInputVat.fils).toBe(500)
    expect(mixed.blockedInputVat.fils).toBe(200)
    // The VAT partitions exactly: every fils of it is either claimed or disclosed, never both and never
    // neither. This is the equality the deferred totals trigger in 0034 proves against the stored rows.
    expect(mixed.recoverableInputVat.fils + mixed.blockedInputVat.fils).toBe(mixed.vat.fils)

    const mixedDraft = billEntryDraft({
      entryId: 'JE-BILL-2026-00003',
      entryDate: ENTRY_DATE,
      narrative: 'Supplier bill BILL-2026-00003',
      bill: mixed,
    })
    expect(mixedDraft.lines.map((line) => [line.account, line.side, line.amount.fils])).toEqual([
      [ACCOUNTS.consumablesUsed, 'debit', 10_000],
      // The gross, not the net: the 200 fils of blocked VAT is inside this figure.
      [ACCOUNTS.entertainment, 'debit', 4_200],
      [RECOVERABLE_INPUT_VAT_ACCOUNT, 'debit', 500],
      [TRADE_PAYABLES_ACCOUNT, 'credit', 14_700],
    ])
    expect(isBalanced(postEntry(mixedDraft, STANDARD_SPA_CHART))).toBe(true)
    expect(billDebitTotal(mixed).fils).toBe(mixed.gross.fils)
    // Only the recoverable half reaches 1080. A report that read `vat` instead of `recoverableInputVat`
    // would claim 700 here, which is the over-claim this treatment exists to prevent.
    const claimed = mixedDraft.lines
      .filter((line) => line.account === RECOVERABLE_INPUT_VAT_ACCOUNT)
      .reduce((total, line) => total + line.amount.fils, 0)
    expect(claimed).toBe(500)
    expect(claimed).not.toBe(mixed.vat.fils)
  })

  it('posts no VAT debit at all for a bill that is entirely blocked', () => {
    const blockedOnly = deriveBill([
      {
        description: 'Staff transport, night shift',
        account: ACCOUNTS.staffAccommodation,
        gross: money(filsFrom(52_500)),
        treatment: 'blocked_not_recoverable',
      },
    ])
    expect(blockedOnly.recoverableInputVat.fils).toBe(0)
    expect(blockedOnly.blockedInputVat.fils).toBe(2_500)
    const entry = postEntry(
      billEntryDraft({
        entryId: 'JE-BILL-2026-00004',
        entryDate: ENTRY_DATE,
        narrative: 'Supplier bill BILL-2026-00004',
        bill: blockedOnly,
      }),
      STANDARD_SPA_CHART,
    )
    expect(entry.lines.map((line) => line.account)).toEqual([
      ACCOUNTS.staffAccommodation,
      TRADE_PAYABLES_ACCOUNT,
    ])
    expect(isBalanced(entry)).toBe(true)
  })

  it('refuses a blocked line at a zero rate, which is a line with nothing blocked', () => {
    // `blocked_not_recoverable` says the supplier charged VAT that cannot be reclaimed. At zero rate
    // there is no such VAT, and the treatment would be a preparer using it as a catch-all for "not
    // recoverable" — which the other four treatments already say, each for a different reason.
    expect(() =>
      deriveBillLine({
        description: 'Customer refreshments',
        account: ACCOUNTS.entertainment,
        gross: aed(100),
        treatment: 'blocked_not_recoverable',
        rateBp: vatRateBp(0),
      }),
    ).toThrow(/blocked_not_recoverable at 0 bp/)
  })

  it('holds claim + blocked === vat for every gross, which is what makes the disclosure complete', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        // Every treatment but the reverse charge, which partitions a tax NOBODY charged: its two figures
        // are its own self-assessment and its `vat` is zero by construction, so it satisfies the identity
        // below trivially and is proved properly in `../tax/reverse-charge.test.ts`.
        fc.constantFrom(...BILL_TAX_TREATMENTS.filter((t) => !selfAccountsVat(t))),
        (grossFils, treatment) => {
          const line = deriveBillLine({
            description: 'Anything',
            account: isBlocked(treatment) ? ACCOUNTS.entertainment : ACCOUNTS.rent,
            gross: money(filsFrom(grossFils)),
            treatment,
            ...(carriesVat(treatment) ? {} : { rateBp: vatRateBp(0) }),
          })
          expect(line.recoverableInputVat.fils + line.blockedInputVat.fils).toBe(line.vat.fils)
          expect(line.expenseDebit.fils + line.recoverableInputVat.fils).toBe(line.gross.fils)
          // Never both: a fils of tax cannot be claimed and disclosed at once.
          expect(line.recoverableInputVat.fils === 0 || line.blockedInputVat.fils === 0).toBe(true)
        },
      ),
      { numRuns: 500 },
    )
  })
})

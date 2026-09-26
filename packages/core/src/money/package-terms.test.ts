import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { TenderLine } from '../checkout/posting.ts'
import { accountCode } from '../ledger/account.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { JournalEntry } from '../ledger/entry.ts'
import { entryId, imbalanceFils, isBalanced } from '../ledger/entry.ts'
import { aed, filsFrom, money } from '../money.ts'
import { localDate } from '../time.ts'
import type { PackageSaleLineDraft } from './package-terms.ts'
import {
  allocateByWeight,
  MalformedPackage,
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  PACKAGE_TERMS_OPEN_QUESTION,
  PackageTendersDoNotCoverPrice,
  PROVISIONAL_PACKAGE_TERMS,
  packageSalePosting,
  probePackageSalePosting,
  UNREDEEMED_BALANCE_POLICIES,
} from './package-terms.ts'
import { TenderReferenceMissing } from './tender.ts'

const DAY = localDate('2026-09-26')
const CHART = STANDARD_SPA_CHART

const line = (id: string, sessions: number, listFils: number): PackageSaleLineDraft => ({
  lineId: id,
  sessionCount: sessions,
  listGross: money(filsFrom(listFils)),
})

const cash = (fils: number): TenderLine => ({ kind: 'cash', amount: money(filsFrom(fils)) })

const sell = (options: {
  price: number
  lines: readonly PackageSaleLineDraft[]
  tenders?: readonly TenderLine[]
  id?: string
}) =>
  packageSalePosting(
    {
      entryId: entryId(options.id ?? 'PKG-0001'),
      entryDate: DAY,
      priceGross: money(filsFrom(options.price)),
      lines: options.lines,
      tenders: options.tenders ?? [cash(options.price)],
      packageLabel: 'Six-treatment course',
    },
    CHART,
  )

/** Debits minus credits on one account, off the entry's own lines. */
const onAccount = (entry: JournalEntry, code: string) =>
  entry.lines
    .filter((l) => (l.account as string) === code)
    .reduce((running, l) => running + l.debitFils - l.creditFils, 0)

describe('the provisional package terms', () => {
  it('are the strictest safe option on all three, and name their open question', () => {
    expect(PROVISIONAL_PACKAGE_TERMS.validityMonths).toBe(6)
    expect(PROVISIONAL_PACKAGE_TERMS.transferable).toBe(false)
    expect(PROVISIONAL_PACKAGE_TERMS.unredeemedBalancePolicy).toBe('retained')
    expect(PACKAGE_TERMS_OPEN_QUESTION).toBe('Y9-package-policy')
    // The control: `retained` is a real member of the vocabulary rather than a string nobody validates,
    // so this test is about the CHOICE and not about a typo that happens to be untested.
    expect([...UNREDEEMED_BALANCE_POLICIES]).toEqual(['retained', 'forfeited'])
  })
})

describe('allocateByWeight — the price split across the lines', () => {
  it('splits a discounted two-line package in proportion, to the fils', () => {
    // Hand-computed. Five 60-minute massages at 200.00 and three facials at 300.00 list at 1,900.00 and
    // are sold for 1,500.00.
    //   line 1: 150000 x 100000 / 190000 = 78947 remainder  70000
    //   line 2: 150000 x  90000 / 190000 = 71052 remainder 120000
    // The floors come to 149,999, so the single fils left goes to the LARGER remainder: line 2.
    const shares = allocateByWeight(money(filsFrom(150_000)), [100_000, 90_000])
    expect(shares.map((share) => share.fils)).toEqual([78_947, 71_053])
    expect(shares.reduce((running, share) => running + share.fils, 0)).toBe(150_000)
  })

  it('distributes the indivisible remainder rather than losing it', () => {
    // 100 fils across three equal lines. Naive independent rounding gives 33/33/33 and loses one fils —
    // which is the fils that makes the deferred-revenue balance disagree with the cash taken.
    const shares = allocateByWeight(money(filsFrom(100)), [1, 1, 1])
    expect(shares.map((s) => s.fils)).toEqual([34, 33, 33])
    expect(shares.reduce((running, s) => running + s.fils, 0)).toBe(100)
  })

  it('allocates by position when every weight is zero, rather than losing the price', () => {
    const shares = allocateByWeight(money(filsFrom(10)), [0, 0, 0])
    expect(shares.reduce((running, s) => running + s.fils, 0)).toBe(10)
  })

  it('refuses a fractional or negative weight, and an empty allocation', () => {
    expect(() => allocateByWeight(aed(1), [1, -1])).toThrow(MalformedPackage)
    expect(() => allocateByWeight(aed(1), [1.5])).toThrow(MalformedPackage)
    expect(() => allocateByWeight(aed(1), [])).toThrow(MalformedPackage)
  })

  it('stays exact past 2^53, where the product of price and weight does not fit a double', () => {
    // 10^8 fils (1,000,000.00 AED) weighted by 10^8 is 10^16, past Number.MAX_SAFE_INTEGER. Computed in
    // a double the products round and the shares stop summing to the total. Both figures are individually
    // legal, which is why the BigInt is not a precaution but a requirement.
    const total = 100_000_000
    const shares = allocateByWeight(money(filsFrom(total)), [100_000_000, 99_999_999, 3])
    expect(shares.reduce((running, s) => running + s.fils, 0)).toBe(total)
    // The control: the same arithmetic done in doubles does NOT sum to the total, so the assertion above
    // is about the BigInt and not about a case any implementation would pass.
    const weights = [100_000_000, 99_999_999, 3]
    const denominator = weights.reduce((a, b) => a + b, 0)
    const naive = weights.map((w) => Math.floor((total * w) / denominator))
    expect(naive.reduce((a, b) => a + b, 0)).not.toBe(total)
  })

  /**
   * The property, with its coverage COUNTED (brief rule 22).
   *
   * "The shares sum to the price" is trivially true for any allocation when the price divides the weights
   * exactly — the interesting arm is the one where the floors come to LESS than the price and the
   * remainder has to be distributed. So that arm is counted, and the count is asserted against a floor
   * measured over eight runs of 500 — 436 436 425 438 439 420 419 426, lowest 419. Without the count, a
   * generator that only ever produced divisible cases would make this property pass for an implementation
   * that drops the remainder entirely.
   *
   * 30_000 ms, explicitly: 500 cases of BigInt arithmetic take about 0.4 s alone and `vitest.config.ts`
   * declares no `testTimeout`, so the inherited 5,000 ms is a performance budget on a correctness test
   * (brief rule 21).
   */
  it('sums to the price exactly, and the remainder arm is actually exercised', () => {
    let remainderCases = 0
    let flooredShort = 0
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.array(fc.integer({ min: 0, max: 400_000 }), { minLength: 1, maxLength: 8 }),
        (price, weights) => {
          const shares = allocateByWeight(money(filsFrom(price)), weights)
          expect(shares).toHaveLength(weights.length)
          expect(shares.reduce((running, s) => running + s.fils, 0)).toBe(price)
          for (const share of shares) expect(share.fils).toBeGreaterThanOrEqual(0)

          const totalWeight = weights.reduce((a, b) => a + b, 0)
          const effective = totalWeight === 0 ? weights.map(() => 1) : weights
          const denominator = totalWeight === 0 ? weights.length : totalWeight
          const floors = effective.map((w) =>
            Number((BigInt(price) * BigInt(w)) / BigInt(denominator)),
          )
          const flooredTotal = floors.reduce((a, b) => a + b, 0)
          if (flooredTotal < price) {
            remainderCases += 1
            flooredShort += price - flooredTotal
          }
          return true
        },
      ),
      { numRuns: 500 },
    )
    // Half the lowest observed count. A floor set just under the observed minimum becomes its own flake.
    expect(
      remainderCases,
      `only ${remainderCases} of 500 cases had a remainder to distribute`,
    ).toBeGreaterThan(190)
    // And the remainder really was non-zero in those cases, so the arm is about distribution rather than
    // about a subtraction that happened to be counted.
    expect(flooredShort).toBeGreaterThan(0)
  }, 30_000)
})

describe('packageSalePosting — a sale is a liability, not a supply', () => {
  it('debits the tender and credits 2050 at the full gross, and nothing else moves', () => {
    const posting = sell({ price: 150_000, lines: [line('l1', 5, 100_000), line('l2', 3, 90_000)] })
    expect(posting.entry.lines).toHaveLength(2)
    expect(onAccount(posting.entry, ACCOUNTS.cashInDrawer as string)).toBe(150_000)
    expect(onAccount(posting.entry, ACCOUNTS.packageDeferredRevenue as string)).toBe(-150_000)
    expect(posting.entry.source).toBe('package_sale')
    expect(isBalanced(posting.entry)).toBe(true)
    expect(imbalanceFils(posting.entry.lines)).toBe(0)
    expect(PACKAGE_DEFERRED_REVENUE_ACCOUNT).toBe(accountCode('2050'))
  })

  it('posts exactly zero to every revenue account and zero to output VAT', () => {
    const posting = sell({ price: 150_000, lines: [line('l1', 5, 100_000), line('l2', 3, 90_000)] })
    const probe = probePackageSalePosting(posting.entry, CHART)
    expect(probe.revenueMovementFils).toBe(0)
    expect(probe.outputVatMovementFils).toBe(0)
    expect(probe.deferredRevenueFils).toBe(150_000)
    expect([...probe.accountsTouched]).toEqual(['1010', '2050'])
  })

  it('the probe would CATCH revenue recognised on a sale, including a self-cancelling pair', () => {
    // The control for the assertion above, and the reason the probe measures debits PLUS credits.
    //
    // This entry credits 4010 Treatment revenue and debits 4095 Discounts and allowances by the same
    // figure. Its NET revenue movement is zero and it HAS recognised revenue on a package sale. A probe
    // summing `credit - debit` — which is how this one was first written — reported it as clean.
    const smuggled: JournalEntry = {
      ...sell({ price: 100_000, lines: [line('l1', 1, 100_000)] }).entry,
      lines: [
        {
          account: ACCOUNTS.cashInDrawer,
          debitFils: filsFrom(100_000),
          creditFils: filsFrom(0),
          currency: 'AED',
          memo: null,
        },
        {
          account: ACCOUNTS.packageDeferredRevenue,
          debitFils: filsFrom(0),
          creditFils: filsFrom(100_000),
          currency: 'AED',
          memo: null,
        },
        {
          account: ACCOUNTS.treatmentRevenue,
          debitFils: filsFrom(0),
          creditFils: filsFrom(7_000),
          currency: 'AED',
          memo: null,
        },
        {
          account: ACCOUNTS.discountsAndAllowances,
          debitFils: filsFrom(7_000),
          creditFils: filsFrom(0),
          currency: 'AED',
          memo: null,
        },
      ],
    }
    const probe = probePackageSalePosting(smuggled, CHART)
    expect(probe.revenueMovementFils).toBe(14_000)
    // And the net, which is what a weaker probe would have reported.
    const net = smuggled.lines
      .filter((l) => (l.account as string).startsWith('4'))
      .reduce((running, l) => running + l.creditFils - l.debitFils, 0)
    expect(net).toBe(0)
  })

  it('the probe would CATCH output VAT charged on a sale', () => {
    const vatted: JournalEntry = {
      ...sell({ price: 105_000, lines: [line('l1', 1, 105_000)] }).entry,
      lines: [
        {
          account: ACCOUNTS.cashInDrawer,
          debitFils: filsFrom(105_000),
          creditFils: filsFrom(0),
          currency: 'AED',
          memo: null,
        },
        {
          account: ACCOUNTS.packageDeferredRevenue,
          debitFils: filsFrom(0),
          creditFils: filsFrom(100_000),
          currency: 'AED',
          memo: null,
        },
        {
          account: ACCOUNTS.outputVatPayable,
          debitFils: filsFrom(0),
          creditFils: filsFrom(5_000),
          currency: 'AED',
          memo: null,
        },
      ],
    }
    const probe = probePackageSalePosting(vatted, CHART)
    expect(probe.outputVatMovementFils).toBe(5_000)
    expect(probe.deferredRevenueFils).toBe(100_000)
  })

  it('merges two tenders on one account into one line and sorts the lines by account code', () => {
    const posting = sell({
      price: 60_000,
      lines: [line('l1', 2, 60_000)],
      tenders: [
        cash(10_000),
        cash(20_000),
        { kind: 'card_in_salon', amount: money(filsFrom(30_000)), reference: 'AUTH-77' },
      ],
    })
    expect(posting.entry.lines.map((l) => l.account as string)).toEqual(['1010', '1040', '2050'])
    expect(onAccount(posting.entry, '1010')).toBe(30_000)
    // 1040 Card terminal clearing and NOT 1020: the terminal settles in a batch, net of fees, days later.
    expect(onAccount(posting.entry, '1040')).toBe(30_000)
    expect(onAccount(posting.entry, '1020')).toBe(0)
    expect(posting.tenders).toHaveLength(3)
  })

  it('refuses tenders that do not cover the price, in both directions', () => {
    const lines = [line('l1', 2, 60_000)]
    expect(() => sell({ price: 60_000, lines, tenders: [cash(59_999)] })).toThrow(
      PackageTendersDoNotCoverPrice,
    )
    expect(() => sell({ price: 60_000, lines, tenders: [cash(60_001)] })).toThrow(
      PackageTendersDoNotCoverPrice,
    )
    expect(() => sell({ price: 60_000, lines, tenders: [] })).toThrow(PackageTendersDoNotCoverPrice)
    // The control: the exact figure IS accepted, so the two refusals are about the difference.
    expect(sell({ price: 60_000, lines, tenders: [cash(60_000)] }).priceGross.fils).toBe(60_000)
  })

  it('refuses a card tender with no reference, through M-TILL-07 own registry', () => {
    expect(() =>
      sell({
        price: 10_000,
        lines: [line('l1', 1, 10_000)],
        tenders: [{ kind: 'card_in_salon', amount: money(filsFrom(10_000)) }],
      }),
    ).toThrow(TenderReferenceMissing)
    // The control: cash requires none, so the refusal is about the tender type.
    expect(() => sell({ price: 10_000, lines: [line('l1', 1, 10_000)] })).not.toThrow()
  })

  it('refuses a package with no lines, a zero session count and a zero price', () => {
    expect(() => sell({ price: 10_000, lines: [] })).toThrow(MalformedPackage)
    expect(() => sell({ price: 10_000, lines: [line('l1', 0, 10_000)] })).toThrow(MalformedPackage)
    expect(() => sell({ price: 0, lines: [line('l1', 1, 0)], tenders: [cash(0)] })).toThrow()
  })

  it('opens one balance per line, carrying the line id it came from', () => {
    const posting = sell({
      price: 150_000,
      lines: [line('a', 5, 100_000), line('b', 3, 90_000)],
    })
    expect(posting.balances.map((b) => b.lineId)).toEqual(['a', 'b'])
    expect(posting.balances.map((b) => b.sessionsTotal)).toEqual([5, 3])
    expect(posting.balances.map((b) => b.valueGross.fils)).toEqual([78_947, 71_053])
    expect(posting.sessionsTotal).toBe(8)
  })

  /**
   * The whole posting rule as a property, with both interesting arms COUNTED (brief rule 22).
   *
   * The two arms that can make the identities fail are a MULTI-LINE package, where the allocation has to
   * distribute a remainder, and a MULTI-TENDER sale, where the debit side is a merge. A generator that
   * mostly produced one line paid with one tender would make every identity below hold for an
   * implementation that could not allocate at all. Measured over eight runs of 300: multi-line
   * 239 231 247 255 246 225 252 238 (lowest 225) and multi-tender 204 198 203 185 209 186 177 206
   * (lowest 177). Both floors are set at about half, because a floor just under the observed minimum
   * becomes its own flake.
   *
   * 30_000 ms for the reason the allocation property gives.
   */
  it('holds all four identities over generated packages, and both arms are exercised', () => {
    let multiLine = 0
    let multiTender = 0
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            sessions: fc.integer({ min: 1, max: 6 }),
            listFils: fc.integer({ min: 1_000, max: 500_000 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.integer({ min: 1_000, max: 2_000_000 }),
        // How the price is split across up to three tenders, as shares of it.
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 3 }),
        (drafts, price, tenderShares) => {
          const lines = drafts.map((draft, index) =>
            line(`l${index + 1}`, draft.sessions, draft.listFils),
          )
          const splits = allocateByWeight(money(filsFrom(price)), tenderShares)
          const tenders: TenderLine[] = splits
            .filter((split) => split.fils > 0)
            .map((split, index) =>
              index % 2 === 0
                ? { kind: 'cash', amount: split }
                : { kind: 'bank_transfer', amount: split, reference: `TRF-${index}` },
            )
          // A share that rounded to zero is dropped, so the remaining tenders no longer cover the price.
          // Topped up onto the first rather than skipping the case, which would bias the generator.
          const short = price - tenders.reduce((running, t) => running + t.amount.fils, 0)
          const first = tenders[0]
          if (short > 0 && first !== undefined) {
            tenders[0] = { ...first, amount: money(filsFrom(first.amount.fils + short)) }
          }
          if (lines.length > 1) multiLine += 1
          if (tenders.length > 1) multiTender += 1

          const posting = packageSalePosting(
            {
              entryId: entryId('PKG-PROP'),
              entryDate: DAY,
              priceGross: money(filsFrom(price)),
              lines,
              tenders,
              packageLabel: 'generated',
            },
            CHART,
          )
          const probe = probePackageSalePosting(posting.entry, CHART)
          expect(imbalanceFils(posting.entry.lines)).toBe(0)
          expect(probe.deferredRevenueFils).toBe(price)
          expect(probe.revenueMovementFils).toBe(0)
          expect(probe.outputVatMovementFils).toBe(0)
          expect(posting.balances.reduce((running, b) => running + b.valueGross.fils, 0)).toBe(
            price,
          )
          expect(posting.balances).toHaveLength(lines.length)
          return true
        },
      ),
      { numRuns: 300 },
    )
    expect(
      multiLine,
      `only ${multiLine} of 300 generated packages had more than one line`,
    ).toBeGreaterThan(115)
    expect(
      multiTender,
      `only ${multiTender} of 300 generated sales used more than one tender`,
    ).toBeGreaterThan(90)
  }, 30_000)
})

describe('the refusals a caller can only reach with a malformed package', () => {
  it('refuses a negative list value on a line', () => {
    // The WEIGHT, not an amount posted — so a negative one would make one share negative and another
    // larger than the price, and both would still sum to it.
    expect(() =>
      sell({ price: 10_000, lines: [line('l1', 1, 10_000), line('l2', 1, -5_000)] }),
    ).toThrow(MalformedPackage)
  })

  it('refuses a zero-amount tender even when the tenders TOTAL the price', () => {
    // The total is right and one of the tenders is not a payment. Caught inside the per-tender pass,
    // which is the only place it can be: the coverage check on the total has already passed.
    expect(() =>
      sell({
        price: 60_000,
        lines: [line('l1', 2, 60_000)],
        tenders: [cash(0), cash(60_000)],
      }),
    ).toThrow(PackageTendersDoNotCoverPrice)
    // The control: the same two tenders with the zero replaced by a real figure ARE accepted, and merge
    // onto one account.
    expect(
      sell({
        price: 60_000,
        lines: [line('l1', 2, 60_000)],
        tenders: [cash(10_000), cash(50_000)],
      }).entry.lines,
    ).toHaveLength(2)
  })

  it('uses a supplied narrative and otherwise names the package and counts its parts', () => {
    const given = packageSalePosting(
      {
        entryId: entryId('PKG-NARR'),
        entryDate: DAY,
        priceGross: money(filsFrom(10_000)),
        lines: [line('l1', 1, 10_000)],
        tenders: [cash(10_000)],
        packageLabel: 'Six-treatment course',
        narrative: 'Course sold at reception',
      },
      CHART,
    )
    expect(given.entry.narrative).toBe('Course sold at reception')
    const derived = sell({ price: 10_000, lines: [line('l1', 1, 10_000)] })
    expect(derived.entry.narrative).toBe(
      'Package sale: Six-treatment course, 1 line(s), 1 tender(s)',
    )
  })

  it('refuses a tender kind the registry does not declare', () => {
    expect(() =>
      sell({
        price: 10_000,
        lines: [line('l1', 1, 10_000)],
        tenders: [
          { kind: 'crypto' as unknown as TenderLine['kind'], amount: money(filsFrom(10_000)) },
        ],
      }),
    ).toThrow(/UnknownTenderType/)
  })
})

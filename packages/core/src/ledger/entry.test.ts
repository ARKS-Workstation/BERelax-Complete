import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { aed, aedFrom, type Fils, filsFrom, money } from '../money.ts'
import { localDate } from '../time.ts'
import { accountCode } from './account.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from './chart-of-accounts.ts'
import type { EntryDraft, EntryLineDraft, JournalEntry, JournalLine } from './entry.ts'
import {
  credit,
  creditTotalFils,
  debit,
  debitTotalFils,
  entryId,
  imbalanceFils,
  isBalanced,
  MalformedEntry,
  netByAccount,
  postEntry,
  trialBalance,
  UnbalancedEntry,
} from './entry.ts'

const CHART = STANDARD_SPA_CHART
const DAY = localDate('2026-10-02')

/** AED 262.50 gross: a real menu price, and one that does not divide evenly by 1.05. */
const GROSS = money(filsFrom(26_250))
const NET = money(filsFrom(25_000))
const VAT = money(filsFrom(1_250))

function sale(id = 'JE-0001'): EntryDraft {
  return {
    entryId: entryId(id),
    entryDate: DAY,
    narrative: 'Aromatherapy 60 min, card',
    source: 'sale',
    lines: [
      debit(ACCOUNTS.gatewayClearing, GROSS, 'Card settlement'),
      credit(ACCOUNTS.treatmentRevenue, NET),
      credit(ACCOUNTS.outputVatPayable, VAT),
    ],
  }
}

describe('postEntry — the shape of a posted entry', () => {
  it('returns a balanced, frozen entry', () => {
    const entry = postEntry(sale(), CHART)
    expect(imbalanceFils(entry.lines)).toBe(0)
    expect(isBalanced(entry)).toBe(true)
    expect(Object.isFrozen(entry)).toBe(true)
    expect(Object.isFrozen(entry.lines)).toBe(true)
  })

  it('keeps gross authoritative: net plus VAT is exactly gross', () => {
    // ADR 0007. The VAT line is the remainder, never rounded independently, so the entry balances
    // for every price rather than for almost every price.
    const entry = postEntry(sale(), CHART)
    expect(NET.fils + VAT.fils).toBe(GROSS.fils)
    expect(debitTotalFils(entry.lines)).toBe(GROSS.fils)
    expect(creditTotalFils(entry.lines)).toBe(GROSS.fils)
  })

  it('splits each line onto one side only, with zero on the other', () => {
    const entry = postEntry(sale(), CHART)
    for (const line of entry.lines) {
      expect(line.debitFils === 0 || line.creditFils === 0).toBe(true)
      expect(line.debitFils + line.creditFils).toBeGreaterThan(0)
    }
  })

  it('carries the memo as null when none was given, never as undefined', () => {
    const entry = postEntry(sale(), CHART)
    expect(entry.lines[0]?.memo).toBe('Card settlement')
    expect(entry.lines[1]?.memo).toBeNull()
  })

  it('marks a fresh entry as reversing nothing', () => {
    expect(postEntry(sale(), CHART).reverses).toBeNull()
  })

  it('preserves the business day it was given without re-deriving it', () => {
    // A 01:30 sale belongs to the previous trading date. The caller resolved that; this module has
    // no clock and no Date, so it cannot disagree.
    expect(postEntry({ ...sale(), entryDate: localDate('2026-10-01') }, CHART).entryDate).toBe(
      '2026-10-01',
    )
  })
})

describe('postEntry — what it refuses', () => {
  it('throws UnbalancedEntry rather than returning a value', () => {
    const draft: EntryDraft = {
      ...sale(),
      lines: [debit(ACCOUNTS.gatewayClearing, GROSS), credit(ACCOUNTS.treatmentRevenue, NET)],
    }
    expect(() => postEntry(draft, CHART)).toThrow(UnbalancedEntry)
    expect(() => postEntry(draft, CHART)).toThrow(/difference 1250 fils/)
  })

  it('throws in the other direction too, when credits exceed debits', () => {
    // An over-credited entry is the refund-shaped mistake, and an implementation that compared
    // `debits > credits` rather than `!==` would let it through.
    const draft: EntryDraft = {
      ...sale(),
      lines: [debit(ACCOUNTS.cashInDrawer, aed(9)), credit(ACCOUNTS.treatmentRevenue, aed(10))],
    }
    expect(() => postEntry(draft, CHART)).toThrow(UnbalancedEntry)
    expect(() => postEntry(draft, CHART)).toThrow(/difference -100 fils/)
  })

  it('reports the imbalance as invariant_violated, not as a validation message', () => {
    // A caller cannot fix this by prompting differently: a posting rule produced lines that do not
    // balance, and the right answer is to fail the transaction rather than round something.
    try {
      postEntry(
        {
          ...sale(),
          lines: [debit(ACCOUNTS.cashInDrawer, aed(10)), credit(ACCOUNTS.rent, aed(9))],
        },
        CHART,
      )
      expect.unreachable('postEntry returned an unbalanced entry')
    } catch (error) {
      expect(error).toBeInstanceOf(UnbalancedEntry)
      expect((error as UnbalancedEntry).kind).toBe('invariant_violated')
      expect((error as UnbalancedEntry).debitFils).toBe(1_000)
      expect((error as UnbalancedEntry).creditFils).toBe(900)
    }
  })

  it('refuses an account the chart does not contain', () => {
    const draft: EntryDraft = {
      ...sale(),
      lines: [debit(accountCode('9999'), aed(10)), credit(ACCOUNTS.treatmentRevenue, aed(10))],
    }
    expect(() => postEntry(draft, CHART)).toThrow(/Account "9999" is not in chart/)
  })

  it('refuses a single-line entry', () => {
    expect(() =>
      postEntry({ ...sale(), lines: [debit(ACCOUNTS.cashInDrawer, aed(10))] }, CHART),
    ).toThrow(MalformedEntry)
  })

  it('refuses an entry with no lines at all', () => {
    expect(() => postEntry({ ...sale(), lines: [] }, CHART)).toThrow(/has 0 line\(s\)/)
  })

  it('refuses a blank narrative', () => {
    // An append-only entry nobody can read is not evidence, which is the whole reason the journal is
    // append-only.
    expect(() => postEntry({ ...sale(), narrative: '   ' }, CHART)).toThrow(/no narrative/)
  })

  it('refuses a non-positive amount, because direction lives in the side', () => {
    const negative: EntryLineDraft = {
      account: ACCOUNTS.cashInDrawer,
      side: 'debit',
      amount: money(-1_000 as Fils),
    }
    expect(() =>
      postEntry({ ...sale(), lines: [negative, credit(ACCOUNTS.rent, aed(10))] }, CHART),
    ).toThrow(/non-positive amount/)
    expect(() =>
      postEntry(
        {
          ...sale(),
          lines: [
            { account: ACCOUNTS.cashInDrawer, side: 'debit', amount: money(0 as Fils) },
            credit(ACCOUNTS.rent, aed(10)),
          ],
        },
        CHART,
      ),
    ).toThrow(/non-positive amount/)
  })

  it('refuses a fractional amount that was cast past the type', () => {
    // `aed(1.5)` is a compile error and `aedFrom(1.5)` throws, so the only route to a fractional
    // fils is a cast — which is exactly what a hurried caller reaches for.
    const fractional: EntryLineDraft = {
      account: ACCOUNTS.cashInDrawer,
      side: 'debit',
      amount: money(10.5 as Fils),
    }
    expect(() =>
      postEntry({ ...sale(), lines: [fractional, credit(ACCOUNTS.rent, aed(10))] }, CHART),
    ).toThrow(/fractional amount/)
    expect(() => aedFrom(1.5)).toThrow()
  })

  it('refuses an entry that mixes currencies', () => {
    const foreign: EntryLineDraft = {
      account: ACCOUNTS.rent,
      side: 'credit',
      amount: { fils: filsFrom(1_000), currency: 'USD' as never },
    }
    expect(() =>
      postEntry({ ...sale(), lines: [debit(ACCOUNTS.cashInDrawer, aed(10)), foreign] }, CHART),
    ).toThrow(/One entry, one currency/)
  })

  it('refuses a blank entry id', () => {
    expect(() => entryId('  ')).toThrow(MalformedEntry)
  })
})

// --- property-based -----------------------------------------------------------------------------

/**
 * The accounts used by the generated entries.
 *
 * Precomputed outside the property. Resolving them per run would be correct and would also turn
 * 1,000 runs into tens of thousands of chart scans for no added coverage — the resolver has its own
 * tests.
 */
const CODES = [
  ACCOUNTS.cashInDrawer,
  ACCOUNTS.gatewayClearing,
  ACCOUNTS.treatmentRevenue,
  ACCOUNTS.outputVatPayable,
  ACCOUNTS.tipsPayable,
  ACCOUNTS.commissionExpense,
  ACCOUNTS.gratuityLiability,
  ACCOUNTS.packageDeferredRevenue,
  ACCOUNTS.cashOverShort,
] as const

/**
 * Builds a balanced set of lines from two independent shapes: a list of debit amounts, and a
 * partition of their total into credit amounts.
 *
 * The partition is what makes this worth running. Generating N debit/credit *pairs* would produce
 * entries that balance line by line, and every such entry would balance even under an implementation
 * that summed only the first line of each side.
 */
const balancedLines = fc
  .tuple(
    fc.array(fc.integer({ min: 1, max: 5_000_000 }), { minLength: 1, maxLength: 6 }),
    fc.array(fc.nat(), { minLength: 0, maxLength: 5 }),
    fc.array(fc.nat(), { minLength: 12, maxLength: 12 }),
  )
  .map(([debits, rawCuts, picks]) => {
    const total = debits.reduce((a, b) => a + b, 0)
    const cuts = [
      ...new Set(rawCuts.map((raw) => 1 + (raw % Math.max(total - 1, 1))).filter((c) => c < total)),
    ].sort((a, b) => a - b)
    const credits: number[] = []
    let previous = 0
    for (const cut of cuts) {
      credits.push(cut - previous)
      previous = cut
    }
    credits.push(total - previous)

    const pick = (i: number): (typeof CODES)[number] => {
      const raw = picks[i % picks.length] ?? 0
      return CODES[raw % CODES.length] ?? ACCOUNTS.cashInDrawer
    }

    const lines: EntryLineDraft[] = [
      ...debits.map((amount, i) => debit(pick(i), money(filsFrom(amount)))),
      ...credits.map((amount, i) => credit(pick(i + debits.length), money(filsFrom(amount)))),
    ]
    return { lines, total }
  })

describe('property — every constructed entry balances', () => {
  it('satisfies sum(debit_fils) - sum(credit_fils) === 0 over 1,000 generated entries', () => {
    fc.assert(
      fc.property(balancedLines, ({ lines, total }) => {
        const entry = postEntry(
          {
            entryId: entryId('JE-P'),
            entryDate: DAY,
            narrative: 'generated',
            source: 'adjustment',
            lines,
          },
          CHART,
        )
        return (
          imbalanceFils(entry.lines) === 0 &&
          debitTotalFils(entry.lines) === total &&
          creditTotalFils(entry.lines) === total &&
          entry.lines.length === lines.length
        )
      }),
      { numRuns: 1_000 },
    )
  })

  it('throws UnbalancedEntry for 1,000 generated entries that do not balance', () => {
    // The control for the property above. Without it, a `postEntry` that ignored its lines entirely
    // and returned a constant would satisfy the balance property on every run.
    fc.assert(
      fc.property(balancedLines, fc.integer({ min: 1, max: 5_000 }), ({ lines }, delta) => {
        const first = lines[0]
        if (first === undefined) return true
        // The perturbation is strictly positive so the line stays a valid amount: the entry must
        // then fail on balance and on nothing else, which is what makes the assertion below
        // specific to `UnbalancedEntry` rather than to "something threw".
        const broken = [
          debit(first.account, money(filsFrom(first.amount.fils + delta))),
          ...lines.slice(1),
        ]
        try {
          postEntry(
            {
              entryId: entryId('JE-P'),
              entryDate: DAY,
              narrative: 'generated',
              source: 'adjustment',
              lines: broken,
            },
            CHART,
          )
          return false
        } catch (error) {
          return error instanceof UnbalancedEntry
        }
      }),
      { numRuns: 1_000 },
    )
  })
})

// --- trial balance ------------------------------------------------------------------------------

describe('trialBalance', () => {
  const tip = postEntry(
    {
      entryId: entryId('JE-0002'),
      entryDate: localDate('2026-10-03'),
      narrative: 'Tip added at checkout',
      source: 'sale',
      lines: [debit(ACCOUNTS.cashInDrawer, aed(20)), credit(ACCOUNTS.tipsPayable, aed(20))],
    },
    CHART,
  )
  const entries = [postEntry(sale(), CHART), tip]

  it('totals debits and credits equally', () => {
    const tb = trialBalance(entries, CHART)
    expect(tb.totalDebit).toEqual(tb.totalCredit)
    expect(tb.balanced).toBe(true)
    expect(tb.totalDebit.fils).toBe(GROSS.fils + 2_000)
  })

  it("reports each balance in the account's own normal direction", () => {
    const tb = trialBalance(entries, CHART)
    const revenue = tb.rows.find((r) => r.account === ACCOUNTS.treatmentRevenue)
    const clearing = tb.rows.find((r) => r.account === ACCOUNTS.gatewayClearing)
    // Revenue is credit-normal, so its balance is positive despite being a credit.
    expect(revenue?.balance.fils).toBe(NET.fils)
    expect(clearing?.balance.fils).toBe(GROSS.fils)
  })

  it('sorts by code, so two runs produce identical working papers', () => {
    const codes = trialBalance(entries, CHART).rows.map((r) => r.account as string)
    expect(codes).toEqual([...codes].sort())
    expect(codes).toEqual(['1010', '1030', '2030', '2040', '4010'])
  })

  it('honours an inclusive date window', () => {
    const firstDayOnly = trialBalance(entries, CHART, { from: DAY, to: DAY })
    expect(firstDayOnly.rows.map((r) => r.account as string)).toEqual(['1030', '2030', '4010'])
    expect(firstDayOnly.balanced).toBe(true)

    const fromSecondDay = trialBalance(entries, CHART, { from: localDate('2026-10-03') })
    expect(fromSecondDay.rows.map((r) => r.account as string)).toEqual(['1010', '2040'])

    const untilFirstDay = trialBalance(entries, CHART, { to: DAY })
    expect(untilFirstDay.rows.map((r) => r.account as string)).toEqual(['1030', '2030', '4010'])
  })

  it('names each row, so the working papers do not read as bare codes', () => {
    const row = trialBalance(entries, CHART).rows.find((r) => r.account === ACCOUNTS.tipsPayable)
    expect(row?.name).toBe('Tips payable to therapists')
    expect(row?.type).toBe('liability')
  })

  it('reports an unbalanced journal as unbalanced', () => {
    // The control. `balanced` is true for everything postEntry produces, so a test that only ever
    // saw true could not tell the flag from a constant. This forges an entry that never went
    // through postEntry, which is the only way such a row could exist — a hand-written INSERT, or
    // a row read back from a database whose constraint trigger was missing.
    const forged: JournalEntry = {
      entryId: entryId('JE-FORGED'),
      entryDate: DAY,
      narrative: 'forged',
      source: 'adjustment',
      currency: 'AED',
      reverses: null,
      lines: [
        {
          account: ACCOUNTS.cashInDrawer,
          debitFils: filsFrom(1_000),
          creditFils: filsFrom(0),
          currency: 'AED',
          memo: null,
        },
      ] satisfies JournalLine[],
    }
    const tb = trialBalance([forged], CHART)
    expect(tb.balanced).toBe(false)
    expect(isBalanced(forged)).toBe(false)
  })

  it('returns an empty balanced report for no entries', () => {
    const tb = trialBalance([], CHART)
    expect(tb.rows).toEqual([])
    expect(tb.balanced).toBe(true)
  })
})

describe('netByAccount', () => {
  it('nets debits against credits per account', () => {
    const net = netByAccount([postEntry(sale(), CHART)])
    expect(net.get(ACCOUNTS.gatewayClearing)).toBe(GROSS.fils)
    expect(net.get(ACCOUNTS.treatmentRevenue)).toBe(-NET.fils)
    expect(net.get(ACCOUNTS.cashInDrawer)).toBeUndefined()
  })

  it('accumulates across entries touching the same account', () => {
    const second = postEntry(
      {
        ...sale('JE-0003'),
        lines: [
          debit(ACCOUNTS.gatewayClearing, aed(10)),
          credit(ACCOUNTS.treatmentRevenue, aed(10)),
        ],
      },
      CHART,
    )
    const net = netByAccount([postEntry(sale(), CHART), second])
    expect(net.get(ACCOUNTS.gatewayClearing)).toBe(GROSS.fils + 1_000)
  })
})

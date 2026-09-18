import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { filsFrom, money } from '../money.ts'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import type { AccountCode } from './account.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from './chart-of-accounts.ts'
import type { EntryLineDraft, JournalEntry } from './entry.ts'
import {
  credit,
  creditTotalFils,
  debit,
  debitTotalFils,
  entryId,
  imbalanceFils,
  netByAccount,
  postEntry,
  UnbalancedEntry,
} from './entry.ts'
import { BackdatedReversal, reversalEntryId, reverseEntry, reverses } from './reverse.ts'

const CHART = STANDARD_SPA_CHART

const SALE = postEntry(
  {
    entryId: entryId('JE-0001'),
    entryDate: localDate('2026-10-02'),
    narrative: 'Aromatherapy 60 min, card',
    source: 'sale',
    lines: [
      debit(ACCOUNTS.gatewayClearing, money(filsFrom(26_250)), 'Card settlement'),
      credit(ACCOUNTS.treatmentRevenue, money(filsFrom(25_000))),
      credit(ACCOUNTS.outputVatPayable, money(filsFrom(1_250))),
    ],
  },
  CHART,
)

describe('reverseEntry — the correction mechanism', () => {
  const reversal = reverseEntry(SALE, localDate('2026-11-05'))

  it('swaps every debit and credit, leaving the absolute fils untouched', () => {
    // Re-deriving the amounts instead — recomputing VAT on the reversal, say — could round
    // differently from the original and leave a one-fils residue nobody can trace to a transaction.
    expect(reversal.lines).toHaveLength(SALE.lines.length)
    reversal.lines.forEach((line, i) => {
      const original = SALE.lines[i]
      expect(original).toBeDefined()
      expect(line.account).toBe(original?.account)
      expect(line.debitFils).toBe(original?.creditFils)
      expect(line.creditFils).toBe(original?.debitFils)
    })
  })

  it('carries the date it was given, not the original date and not today', () => {
    expect(reversal.entryDate).toBe('2026-11-05')
    expect(reversal.entryDate).not.toBe(SALE.entryDate)
  })

  it('balances', () => {
    expect(imbalanceFils(reversal.lines)).toBe(0)
    expect(debitTotalFils(reversal.lines)).toBe(creditTotalFils(SALE.lines))
  })

  it('records what it reverses, both ways round', () => {
    expect(reversal.reverses).toBe(SALE.entryId)
    expect(reverses(reversal, SALE)).toBe(true)
    expect(reverses(SALE, reversal)).toBe(false)
  })

  it('marks itself as a reversal rather than repeating the original source', () => {
    expect(SALE.source).toBe('sale')
    expect(reversal.source).toBe('reversal')
  })

  it('derives an id and a narrative that name the original', () => {
    expect(reversal.entryId).toBe(reversalEntryId(SALE.entryId))
    expect(reversal.entryId as string).toBe('JE-0001-R')
    expect(reversal.narrative).toContain('JE-0001')
    expect(reversal.narrative).toContain(SALE.narrative)
  })

  it('accepts a supplied id and narrative, because ids are allocated outside core', () => {
    const named = reverseEntry(SALE, localDate('2026-11-05'), {
      entryId: entryId('JE-0099'),
      narrative: 'Cancelled after the therapist called in sick',
    })
    expect(named.entryId as string).toBe('JE-0099')
    expect(named.narrative).toBe('Cancelled after the therapist called in sick')
  })

  it('carries the memo through unchanged', () => {
    expect(reversal.lines[0]?.memo).toBe('Card settlement')
  })

  it('freezes the result, as postEntry does', () => {
    expect(Object.isFrozen(reversal)).toBe(true)
    expect(Object.isFrozen(reversal.lines)).toBe(true)
  })

  it('allows a reversal dated on the original day, for a period still open', () => {
    // Standard practice: correct in the period if it is open, in the current period if it is closed.
    // Only the caller knows which, so the kernel permits both and forbids only the impossible one.
    expect(reverseEntry(SALE, SALE.entryDate).entryDate).toBe(SALE.entryDate)
  })

  it('refuses a reversal dated before the entry it corrects', () => {
    expect(() => reverseEntry(SALE, localDate('2026-10-01'))).toThrow(BackdatedReversal)
    expect(() => reverseEntry(SALE, localDate('2026-10-01'))).toThrow(/may not predate/)
  })

  it('refuses to reverse an entry that never balanced', () => {
    // Only reachable for an entry built without postEntry: a hand-written row, or one read back from
    // a database whose balance trigger was missing. The journal is the one place where trusting the
    // caller costs more than checking.
    const forged = { ...SALE, lines: [SALE.lines[0]] } as unknown as JournalEntry
    expect(() => reverseEntry(forged, localDate('2026-11-05'))).toThrow(UnbalancedEntry)
  })
})

// --- property-based -----------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * Dates built from their components as strings.
 *
 * No `Date` anywhere: this directory is forbidden it, and days 1 to 28 of any month are valid in
 * every month, so no calendar arithmetic is needed to keep the generated dates real.
 */
const localDateArb = fc
  .tuple(
    fc.integer({ min: 2024, max: 2030 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => localDate(`${y}-${pad(m)}-${pad(d)}`))

/** Three dates in non-decreasing order: the entry date, then two reversal dates. */
const orderedDates = fc
  .tuple(localDateArb, localDateArb, localDateArb)
  .map((dates) => [...dates].sort() as [LocalDate, LocalDate, LocalDate])

const CODES: readonly AccountCode[] = [
  ACCOUNTS.cashInDrawer,
  ACCOUNTS.gatewayClearing,
  ACCOUNTS.treatmentRevenue,
  ACCOUNTS.outputVatPayable,
  ACCOUNTS.tipsPayable,
  ACCOUNTS.commissionExpense,
  ACCOUNTS.gratuityLiability,
  ACCOUNTS.packageDeferredRevenue,
]

/** A balanced entry: n debits, and a partition of their total into credits. */
const entryArb = fc
  .tuple(
    fc.array(fc.integer({ min: 1, max: 2_000_000 }), { minLength: 1, maxLength: 5 }),
    fc.array(fc.nat(), { minLength: 0, maxLength: 4 }),
    fc.array(fc.nat(), { minLength: 10, maxLength: 10 }),
    orderedDates,
  )
  .map(([debits, rawCuts, picks, dates]) => {
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

    const pick = (i: number): AccountCode =>
      CODES[(picks[i % picks.length] ?? 0) % CODES.length] ?? ACCOUNTS.cashInDrawer

    const lines: EntryLineDraft[] = [
      ...debits.map((amount, i) => debit(pick(i), money(filsFrom(amount)))),
      ...credits.map((amount, i) => credit(pick(i + debits.length), money(filsFrom(amount)))),
    ]
    const entry = postEntry(
      {
        entryId: entryId('JE-P'),
        entryDate: dates[0],
        narrative: 'generated',
        source: 'adjustment',
        lines,
      },
      CHART,
    )
    return { entry, d1: dates[1], d2: dates[2] }
  })

describe('property — reversal', () => {
  it('swaps sides with identical absolute fils and takes the date it is given', () => {
    fc.assert(
      fc.property(entryArb, ({ entry, d1 }) => {
        const reversal = reverseEntry(entry, d1)
        if (reversal.entryDate !== d1) return false
        if (reversal.lines.length !== entry.lines.length) return false
        return reversal.lines.every((line, i) => {
          const original = entry.lines[i]
          return (
            original !== undefined &&
            line.account === original.account &&
            line.debitFils === original.creditFils &&
            line.creditFils === original.debitFils
          )
        })
      }),
      { numRuns: 1_000 },
    )
  })

  it('restores the per-account net when reversed twice', () => {
    fc.assert(
      fc.property(entryArb, ({ entry, d1, d2 }) => {
        const twice = reverseEntry(reverseEntry(entry, d1), d2)
        const before = netByAccount([entry])
        const after = netByAccount([twice])
        if (before.size !== after.size) return false
        for (const [account, net] of before) {
          if (after.get(account) !== net) return false
        }
        return true
      }),
      { numRuns: 1_000 },
    )
  })

  it('leaves the ledger flat when an entry and its reversal are both in the journal', () => {
    // The accounting meaning of the swap: posting a correction must move every account back to where
    // it was, not merely balance on its own.
    fc.assert(
      fc.property(entryArb, ({ entry, d1 }) => {
        const net = netByAccount([entry, reverseEntry(entry, d1)])
        return [...net.values()].every((value) => value === 0)
      }),
      { numRuns: 1_000 },
    )
  })

  it('detects a reversal that copied instead of swapping', () => {
    // The control. The three properties above compare a reversal against its original; if the
    // comparison were wrong, a "reversal" that simply re-posted the entry would satisfy all of them
    // and would double every figure in the journal instead of clearing it.
    fc.assert(
      fc.property(entryArb, ({ entry, d1 }) => {
        const copy: JournalEntry = { ...entry, entryDate: d1, reverses: entry.entryId }
        const sidesSwapped = copy.lines.every((line, i) => {
          const original = entry.lines[i]
          return original !== undefined && line.debitFils === original.creditFils
        })
        if (sidesSwapped) return false
        // A generated entry can land every line on the same account and net to nothing on its own.
        // Doubling nothing is still nothing, so those cases say nothing about the flatness check and
        // are excluded rather than counted as a pass.
        const moves = [...netByAccount([entry]).values()].some((value) => value !== 0)
        if (!moves) return true
        return [...netByAccount([entry, copy]).values()].some((value) => value !== 0)
      }),
      { numRuns: 1_000 },
    )
  })

  it('shows the copy failing on a concrete entry, not only on generated ones', () => {
    const copy: JournalEntry = { ...SALE, entryDate: localDate('2026-11-05') }
    const net = netByAccount([SALE, copy])
    expect(net.get(ACCOUNTS.gatewayClearing)).toBe(2 * 26_250)
    expect(
      netByAccount([SALE, reverseEntry(SALE, localDate('2026-11-05'))]).get(
        ACCOUNTS.gatewayClearing,
      ),
    ).toBe(0)
  })
})

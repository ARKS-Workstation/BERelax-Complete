import { describe, expect, it } from 'vitest'
import { filsFrom, money } from '../money.ts'
import { localDate } from '../time.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from './chart-of-accounts.ts'
import { credit, debit, entryId, postEntry } from './entry.ts'
import {
  type AccountingPeriod,
  accountingPeriodsOverlap,
  CorrectionIntoClosedPeriod,
  closedPeriodContaining,
  parsePeriodId,
  periodContains,
  planCorrection,
  UnrecognisedPeriodId,
} from './period.ts'
import { BackdatedReversal } from './reverse.ts'

const AUGUST_SALE = postEntry(
  {
    entryId: entryId('JE-AUG-0001'),
    entryDate: localDate('2026-08-20'),
    narrative: 'Aromatherapy 60 min, card',
    source: 'sale',
    lines: [
      debit(ACCOUNTS.gatewayClearing, money(filsFrom(26_250)), 'Card settlement'),
      credit(ACCOUNTS.treatmentRevenue, money(filsFrom(25_000))),
      credit(ACCOUNTS.outputVatPayable, money(filsFrom(1_250))),
    ],
  },
  STANDARD_SPA_CHART,
)

/** August and September both filed, so the earliest open date is neither of them. */
const CLOSED: readonly AccountingPeriod[] = [parsePeriodId('2026-08'), parsePeriodId('2026-09')]

describe('parsePeriodId', () => {
  it('reads a month, including a month whose length the parser has to know', () => {
    expect(parsePeriodId('2026-08')).toMatchObject({
      startsOn: '2026-08-01',
      endsOn: '2026-08-31',
    })
    // 30 days, so a parser that assumed 31 would hand back a range that runs into July.
    expect(parsePeriodId('2026-06').endsOn).toBe('2026-06-30')
    // The two February cases, which are the whole reason the leap rule is written out.
    expect(parsePeriodId('2026-02').endsOn).toBe('2026-02-28')
    expect(parsePeriodId('2028-02').endsOn).toBe('2028-02-29')
    // A century year that is NOT a leap year, and one that is. Both matter for a five-year record
    // that outlives the software, and getting them from an array would have got both wrong.
    expect(parsePeriodId('2100-02').endsOn).toBe('2100-02-28')
    expect(parsePeriodId('2400-02').endsOn).toBe('2400-02-29')
  })

  it('reads a quarter as three whole months', () => {
    expect(parsePeriodId('2026-Q1')).toMatchObject({
      startsOn: '2026-01-01',
      endsOn: '2026-03-31',
    })
    expect(parsePeriodId('2026-Q3')).toMatchObject({
      startsOn: '2026-07-01',
      endsOn: '2026-09-30',
    })
    expect(parsePeriodId('2026-Q4').endsOn).toBe('2026-12-31')
  })

  it('refuses a shape it cannot read rather than guessing a range', () => {
    // Each of these is a period somebody could plausibly write, and a parser that returned a range
    // for one of them would return a range somebody then CLOSED.
    for (const bad of ['2026-H1', 'FY26', '2026-13', '2026-00', '2026-Q5', '2026', '2026-8']) {
      expect(() => parsePeriodId(bad)).toThrow(UnrecognisedPeriodId)
    }
  })

  it('CONTROL: the shapes it accepts are not accepted by accident', () => {
    // The control for the case above. If the regexes had degenerated to "match anything", the refusals
    // would all have failed — but if they had degenerated to "match nothing", every refusal would pass
    // and the two accepting cases would be the only thing to notice. Assert the count from both ends.
    const accepted = ['2026-01', '2026-12', '2026-Q1', '2026-Q4'].filter((id) => {
      try {
        parsePeriodId(id)
        return true
      } catch {
        return false
      }
    })
    expect(accepted).toHaveLength(4)
  })
})

describe('periodContains and accountingPeriodsOverlap', () => {
  const august = parsePeriodId('2026-08')

  it('includes both ends, because ends_on is the last day OF the period', () => {
    expect(periodContains(august, localDate('2026-08-01'))).toBe(true)
    expect(periodContains(august, localDate('2026-08-31'))).toBe(true)
    // An exclusive end would leave the last day of every filed period open, which is the day the
    // cash-up runs.
    expect(periodContains(august, localDate('2026-07-31'))).toBe(false)
    expect(periodContains(august, localDate('2026-09-01'))).toBe(false)
  })

  it('treats adjacent periods as not overlapping and a shared day as overlapping', () => {
    const q3 = parsePeriodId('2026-Q3')
    const q4 = parsePeriodId('2026-Q4')
    expect(accountingPeriodsOverlap(q3, q4)).toBe(false)
    expect(accountingPeriodsOverlap(q4, q3)).toBe(false)
    // Q3 contains August entirely, which is the overlap `period_lock_no_overlap` refuses.
    expect(accountingPeriodsOverlap(q3, august)).toBe(true)
    expect(accountingPeriodsOverlap(august, q3)).toBe(true)
    // One shared day is an overlap. A comparison written with `<` instead of `<=` passes every case
    // above and fails only this one.
    expect(
      accountingPeriodsOverlap(august, {
        periodId: 'touching',
        startsOn: localDate('2026-08-31'),
        endsOn: localDate('2026-10-31'),
      }),
    ).toBe(true)
  })
})

describe('closedPeriodContaining', () => {
  it('finds the period a date is filed inside, and nothing for an open date', () => {
    expect(closedPeriodContaining(localDate('2026-08-20'), CLOSED)?.periodId).toBe('2026-08')
    expect(closedPeriodContaining(localDate('2026-09-30'), CLOSED)?.periodId).toBe('2026-09')
    expect(closedPeriodContaining(localDate('2026-10-01'), CLOSED)).toBeNull()
    // The control: with no periods closed, nothing is closed. A function that returned the first
    // element regardless would pass every assertion above.
    expect(closedPeriodContaining(localDate('2026-08-20'), [])).toBeNull()
  })

  it('is deterministic given a list that overlaps, which only a hand-built one can', () => {
    // `period_lock_no_overlap` makes this unrepresentable in the database. It is asserted anyway,
    // because the argument here is an array a caller assembled and the answer must not depend on the
    // order it was assembled in.
    const q3 = parsePeriodId('2026-Q3')
    const august = parsePeriodId('2026-08')
    expect(closedPeriodContaining(localDate('2026-08-20'), [q3, august])?.periodId).toBe('2026-Q3')
    expect(closedPeriodContaining(localDate('2026-08-20'), [august, q3])?.periodId).toBe('2026-Q3')
  })
})

describe('planCorrection — corrections are dated reversals into an open period', () => {
  it('builds the reversal on an open date and marks it deferred', () => {
    const plan = planCorrection(AUGUST_SALE, localDate('2026-10-01'), CLOSED)

    expect(plan.on).toBe('2026-10-01')
    expect(plan.deferred).toBe(true)
    expect(plan.reversal.entryDate).toBe('2026-10-01')
    expect(plan.reversal.reverses).toBe('JE-AUG-0001')
    expect(plan.reversal.source).toBe('reversal')
    // Swapped, not re-derived: the original's debit is the reversal's credit at the same fils.
    expect(plan.reversal.lines[0]?.creditFils).toBe(AUGUST_SALE.lines[0]?.debitFils)
    expect(plan.reversal.lines[0]?.debitFils).toBe(AUGUST_SALE.lines[0]?.creditFils)
  })

  it('refuses a correction dated inside a closed period, naming that period', () => {
    // The first of the two cases that decide this design: the correction is dated in the period it
    // corrects, and that period has since been filed.
    let caught: unknown
    try {
      planCorrection(AUGUST_SALE, localDate('2026-08-25'), CLOSED)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CorrectionIntoClosedPeriod)
    expect((caught as CorrectionIntoClosedPeriod).message).toContain('"2026-08"')
    // September closed AFTER the August entry was posted, and a correction dated there is refused for
    // the same reason with the other period named. That is the second case.
    expect(() => planCorrection(AUGUST_SALE, localDate('2026-09-15'), CLOSED)).toThrow(
      /"2026-09" is closed/,
    )
  })

  it('CONTROL: the same correction is accepted once nothing is closed', () => {
    // Without this, every refusal above would also pass for a `planCorrection` that refused
    // unconditionally.
    const plan = planCorrection(AUGUST_SALE, localDate('2026-08-25'), [])
    expect(plan.on).toBe('2026-08-25')
    expect(plan.deferred).toBe(true)
  })

  it('still refuses a backdated correction, which is reverseEntry own rule and not a new one', () => {
    // An open date BEFORE the entry is open and still wrong: the correction would appear in a period
    // the original never reached. `planCorrection` must not have become a way around that.
    expect(() => planCorrection(AUGUST_SALE, localDate('2026-07-01'), CLOSED)).toThrow(
      BackdatedReversal,
    )
  })

  it('marks a same-day correction as not deferred', () => {
    // The control for `deferred`: a field that were always true would pass every case above.
    const plan = planCorrection(AUGUST_SALE, localDate('2026-08-20'), [])
    expect(plan.deferred).toBe(false)
    expect(plan.on).toBe(AUGUST_SALE.entryDate)
  })
})

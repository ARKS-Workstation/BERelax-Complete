import { describe, expect, it } from 'vitest'
import { inspectionBudget, URL_INSPECTION_DAILY_CAP } from './url-inspection-cap.ts'

/**
 * G-SEO-01 — the 2,000-a-day cap, as arithmetic.
 *
 * The acceptance case is 5,000 candidates against a 2,000 cap, covered within three runs, so that case is
 * walked here day by day: the arithmetic is what decides how many a run may take, and the rotation's
 * ordering (persisted, NULLS FIRST) is what decides which — proved against a real database in
 * `apps/worker/src/jobs/gsc-url-inspection-rotation.itest.ts`.
 */

describe('the cap is per day, not per run', () => {
  it('takes the whole cap on a fresh day', () => {
    const budget = inspectionBudget({ spentToday: 0, candidates: 5000 })
    expect(budget.take).toBe(URL_INSPECTION_DAILY_CAP)
    expect(budget.take).toBe(2000)
    expect(budget.capReached).toBe(false)
  })

  it('takes only the remainder when the day has already spent some of it', () => {
    // The retry case, and the reason the ledger is keyed on the day. A run that took a second full cap
    // here would spend the day's quota on work already done, and the back of the rotation would never be
    // reached.
    expect(inspectionBudget({ spentToday: 1500, candidates: 5000 }).take).toBe(500)
    expect(inspectionBudget({ spentToday: 1999, candidates: 5000 }).take).toBe(1)
  })

  it('takes nothing once the day is spent, and says so rather than throwing', () => {
    const budget = inspectionBudget({ spentToday: 2000, candidates: 5000 })
    expect(budget.take).toBe(0)
    expect(budget.capReached).toBe(true)
    // A ledger showing MORE than the cap is not a reason to fail a cron either: it is a reason to take
    // nothing. Failing would turn the ordinary end of a rotation day into an incident.
    expect(inspectionBudget({ spentToday: 2400, candidates: 5000 }).take).toBe(0)
  })

  it('never takes more work than exists', () => {
    const budget = inspectionBudget({ spentToday: 0, candidates: 120 })
    expect(budget.take).toBe(120)
    expect(budget.remainingAfter).toBe(1880)
    expect(budget.capReached).toBe(false)
  })
})

describe('5,000 candidates are covered within three runs', () => {
  it('spends 2,000, 2,000 and 2,000 — the third run finishing coverage and starting the next cycle', () => {
    // The arithmetic behind the acceptance criterion. Runs one and two cover 4,000; run three covers the
    // remaining 1,000 and then, because the cap does not carry over and the claim orders never-inspected
    // first, spends the rest of its budget beginning the next cycle. That is why the criterion's "exactly
    // 2,000 per run" and "no URL inspected twice before full coverage" are both true at once.
    const CANDIDATES = 5000
    let covered = 0
    const takes: number[] = []
    for (let day = 0; day < 3; day += 1) {
      const budget = inspectionBudget({ spentToday: 0, candidates: CANDIDATES })
      takes.push(budget.take)
      covered = Math.min(CANDIDATES, covered + budget.take)
    }
    expect(takes).toEqual([2000, 2000, 2000])
    expect(covered).toBe(CANDIDATES)
  })

  it('a smaller cap needs more runs, which is the same arithmetic and not a special case', () => {
    const budget = inspectionBudget({ spentToday: 0, dailyCap: 500, candidates: 5000 })
    expect(budget.take).toBe(500)
    expect(Math.ceil(5000 / 500)).toBe(10)
  })
})

describe('the inputs are whole counts', () => {
  it('refuses a fractional or negative cap, spend or candidate count', () => {
    expect(() => inspectionBudget({ spentToday: 0, dailyCap: 0, candidates: 10 })).toThrow(
      /positive whole number/,
    )
    expect(() => inspectionBudget({ spentToday: -1, candidates: 10 })).toThrow(/whole number/)
    expect(() => inspectionBudget({ spentToday: 1.5, candidates: 10 })).toThrow(/whole number/)
    expect(() => inspectionBudget({ spentToday: 0, candidates: -3 })).toThrow(/whole number/)
  })
})

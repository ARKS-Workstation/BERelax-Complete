import { describe, expect, it } from 'vitest'
import {
  BOOK_BUDGET,
  BOOK_BUDGET_METRICS,
  type BookBudgetMeasurement,
  bookBudgetLimit,
  formatBookBudgetFindings,
  judgeBookBudget,
} from './budget.ts'

/**
 * The judgement half of `/book`'s budget.
 *
 * The measurement is `apps/web/src/book-flow.itest.ts`'s, against a real `next start`. This file covers
 * the part that has to be right for the measurement to mean anything: that a breach is REPORTED, that the
 * report carries the measured value, and that a page exactly at the limit is inside it.
 */

/** A measurement comfortably inside every declared limit. */
const inside: BookBudgetMeasurement = {
  inp: 40,
  'time-to-first-slot': 320,
  'first-party-js': 60 * 1024,
}

describe('the declared budget', () => {
  it('declares one limit per metric, with a reason and a unit', () => {
    expect(BOOK_BUDGET).toHaveLength(BOOK_BUDGET_METRICS.length)
    expect(BOOK_BUDGET.map((entry) => entry.metric).sort()).toEqual([...BOOK_BUDGET_METRICS].sort())
    for (const entry of BOOK_BUDGET) {
      // A budget with no stated reason gets raised the first time it fails, which makes it decoration —
      // `scripts/check-budgets.mjs` records exactly this about `build/budgets.json`.
      expect(entry.why.length, entry.metric).toBeGreaterThan(80)
      expect(['ms', 'bytes']).toContain(entry.unit)
      expect(entry.limit, entry.metric).toBeGreaterThan(0)
    }
  })

  it('carries the two numbers the acceptance names', () => {
    // Against the acceptance line rather than against itself: "INP under 200 ms and
    // time-to-first-slot-rendered under 1 s".
    expect(bookBudgetLimit('inp')).toBe(200)
    expect(bookBudgetLimit('time-to-first-slot')).toBe(1000)
  })

  it('throws for a metric it does not declare', () => {
    // Not typeable away: a caller reading a metric name out of a manifest or a query string reaches this.
    expect(() => bookBudgetLimit('lcp' as never)).toThrow(/no book budget declared/)
  })
})

describe('the judgement', () => {
  it('finds nothing when every measurement is inside its limit', () => {
    expect(judgeBookBudget(inside)).toEqual([])
    expect(formatBookBudgetFindings(judgeBookBudget(inside))).toBe('')
  })

  it('treats a measurement exactly at the limit as inside it', () => {
    // `>` and not `>=`. One millisecond is not a distinction a lab measurement on a loaded container can
    // resolve, and a budget that fires on the number it declares is a budget somebody raises.
    const exact: BookBudgetMeasurement = {
      inp: 200,
      'time-to-first-slot': 1000,
      'first-party-js': 110 * 1024,
    }
    expect(judgeBookBudget(exact)).toEqual([])
  })

  it('reports every breach rather than the first, each with the measured value', () => {
    const over: BookBudgetMeasurement = {
      inp: 260,
      'time-to-first-slot': 1400,
      'first-party-js': 140 * 1024,
    }
    const findings = judgeBookBudget(over)
    expect(findings.map((finding) => finding.metric).sort()).toEqual(
      [...BOOK_BUDGET_METRICS].sort(),
    )
    const printed = formatBookBudgetFindings(findings)
    // The first question anybody asks of a breached budget is by how much, so the measured value and the
    // limit are both in the message. A failure that says only "over budget" costs somebody a second build.
    expect(printed).toContain('260ms against a budget of 200ms')
    expect(printed).toContain('1400ms against a budget of 1000ms')
    expect(printed).toContain('140.0KB')
    expect(printed).toContain('[book-budget-over]')
  })

  it('judges the same measurement against a lowered limit, which is how the itest proves it fires', () => {
    // The wiring, not the arithmetic. `book-flow.itest.ts` measures the running application, asserts it is
    // inside the real limits, then re-judges THAT measurement against these — so the failure it proves
    // carries the page's real numbers. A synthetic measurement would prove neither.
    const lowered = BOOK_BUDGET.map((entry) => ({ ...entry, limit: 1 }))
    const findings = judgeBookBudget(inside, lowered)
    expect(findings).toHaveLength(BOOK_BUDGET.length)
    expect(findings.every((finding) => finding.limit === 1)).toBe(true)
    expect(findings.map((finding) => finding.measured)).toEqual(
      BOOK_BUDGET.map((entry) => inside[entry.metric]),
    )
  })
})

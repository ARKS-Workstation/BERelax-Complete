import { WALK_IN_SPEED_BUDGET_MS, WALK_IN_SPEED_PERCENTILE } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { MINIMUM_WALK_IN_SAMPLES, percentileMs, walkInSpeedVerdict } from './walk-in-speed.ts'

describe('the nearest-rank percentile', () => {
  it('answers an observation and never a number between two', () => {
    const samples = Array.from({ length: 20 }, (_, at) => (at + 1) * 100)
    // The 19th of 20 ascending samples, which is an observation. An interpolated p95 would answer 1,950
    // — a figure nothing observed, about how long a desk waited.
    expect(percentileMs(samples, 95)).toBe(1_900)
    expect(samples).toContain(percentileMs(samples, 95))
  })

  it('refuses an empty set rather than answering zero', () => {
    // A zero here would pass the ten-second budget with room to spare.
    expect(percentileMs([], 95)).toBeNull()
    expect(percentileMs([1, 2, 3], 0)).toBeNull()
    expect(percentileMs([1, 2, 3], 101)).toBeNull()
  })

  it('is order-independent', () => {
    const ascending = [100, 200, 300, 400]
    expect(percentileMs([...ascending].reverse(), 50)).toBe(percentileMs(ascending, 50))
  })
})

describe('the verdict', () => {
  const samples = (count: number, ms: number) => Array.from({ length: count }, () => ms)

  it('is not_measured below the sample floor, whatever the figures look like', () => {
    expect(MINIMUM_WALK_IN_SAMPLES).toBe(20)
    const verdict = walkInSpeedVerdict(samples(3, 10))
    // Three bookings at 10 ms each would read as comfortably inside the budget, and a p95 over three
    // samples passes or fails on one of them.
    expect(verdict.kind).toBe('not_measured')
    expect(verdict.kind === 'not_measured' && verdict.reason).toContain('slowest observation')
  })

  it('distinguishes within_budget from over_budget at the boundary', () => {
    expect(walkInSpeedVerdict(samples(20, WALK_IN_SPEED_BUDGET_MS)).kind).toBe('within_budget')
    expect(walkInSpeedVerdict(samples(20, WALK_IN_SPEED_BUDGET_MS + 1)).kind).toBe('over_budget')
  })

  it('reports no figure at all when it is not measured', () => {
    // The control the committed report rests on: a `not_measured` verdict carries no p95, so nothing
    // downstream can render one — the arrangement R-REP-07 needs, reached by the value never existing.
    const verdict = walkInSpeedVerdict([])
    expect(verdict).not.toHaveProperty('p95Ms')
    expect(verdict.budgetMs).toBe(WALK_IN_SPEED_BUDGET_MS)
  })

  it('uses the shared percentile and budget rather than literals of its own', () => {
    expect(WALK_IN_SPEED_PERCENTILE).toBe(95)
    expect(WALK_IN_SPEED_BUDGET_MS).toBe(10_000)
    const over = walkInSpeedVerdict(samples(20, 10_500), { budgetMs: 11_000 })
    expect(over.kind).toBe('within_budget')
  })
})

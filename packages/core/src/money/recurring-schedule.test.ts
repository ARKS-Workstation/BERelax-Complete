import { describe, expect, it } from 'vitest'
import { aed, filsFrom, type Money, money } from '../money.ts'
import { localDate } from '../time.ts'
import {
  addMonths,
  classifyVariance,
  expectedInstances,
  forwardSchedule,
  isPeriodOverdue,
  isRecurringCostRefusal,
  isRecurringPeriodKey,
  LAST_ANCHOR_DAY_OF_MONTH,
  lowExpectation,
  monthsBetween,
  periodMonthsFor,
  prudentExpectation,
  RECURRING_CADENCES,
  RECURRING_COST_KINDS,
  RECURRING_COST_REFUSALS,
  type RecurringCadence,
  type RecurringCost,
  type RecurringCostInput,
  recurringDueDate,
  recurringPeriodKey,
  validateRecurringCost,
} from './recurring-schedule.ts'

/**
 * M-VAT-04 — the recurring cost register's arithmetic.
 *
 * The frozen clock of the fixture world is 18 September 2026, and every date below is relative to it
 * rather than to the machine's. Nothing here reads a clock, which is the whole point: the same inputs
 * give the same schedule in Ramadan, on a leap day and in CI.
 */
const TODAY = localDate('2026-09-18')

/** A fixed cost anchored on the 1st: rent, the shape the register exists for. */
const fixedInput: RecurringCostInput = {
  code: 'test-rent',
  cadence: 'monthly',
  firstDueDate: localDate('2026-01-01'),
  kind: 'fixed',
  expectedAmount: aed(21_000),
  toleranceBp: 0,
}

/** A variable cost with a band: the utility recharge that swings with the season. */
const variableInput: RecurringCostInput = {
  code: 'test-utilities',
  cadence: 'monthly',
  firstDueDate: localDate('2026-01-20'),
  kind: 'variable',
  expectedMin: aed(2_000),
  expectedMax: aed(4_000),
  toleranceBp: 500,
}

const fixed = validateRecurringCost(fixedInput)
const variable = validateRecurringCost(variableInput)

/** The refusal a call raised, by name, or undefined when it was accepted. */
function refusalOf(run: () => unknown): string | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    for (const name of Object.values(RECURRING_COST_REFUSALS)) {
      if (isRecurringCostRefusal(error, name)) return name
    }
    return `unrecognised: ${(error as Error).message}`
  }
}

describe('acceptance — a monthly cost generates one period per month over 24 months, no gaps', () => {
  it('produces exactly 24 instances with 24 distinct consecutive keys', () => {
    const instances = expectedInstances(fixed, {
      from: localDate('2026-01-01'),
      to: localDate('2028-01-01'),
    })
    expect(instances).toHaveLength(24)
    expect(new Set(instances.map((instance) => instance.periodKey)).size).toBe(24)
    // No gaps, asserted as the sequence rather than as a count: 24 rows could be 24 Septembers.
    const expectedKeys = Array.from({ length: 24 }, (_, index) => {
      const month = (index % 12) + 1
      return `${2026 + Math.floor(index / 12)}-${String(month).padStart(2, '0')}`
    })
    expect(instances.map((instance) => instance.periodKey)).toEqual(expectedKeys)
    expect(instances.map((instance) => instance.occurrence)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    )
  })

  it('is the same list on a second call, so nothing about it depends on being called once', () => {
    const window = { from: localDate('2026-01-01'), to: localDate('2028-01-01') } as const
    expect(expectedInstances(fixed, window)).toEqual(expectedInstances(fixed, window))
  })

  it('finds the window even when the anchor is years behind it', () => {
    // The control for the arithmetic that starts the series near the window. A loop from occurrence 0
    // bounded by a constant number of steps would report this cost as expecting nothing at all, which
    // is the failure the register exists to remove.
    const ancient = validateRecurringCost({ ...fixedInput, firstDueDate: localDate('2019-03-01') })
    const instances = expectedInstances(ancient, {
      from: localDate('2026-09-18'),
      to: localDate('2027-09-18'),
    })
    expect(instances).toHaveLength(12)
    expect(instances[0]?.dueDate).toBe('2026-10-01')
    expect(instances.at(-1)?.dueDate).toBe('2027-09-01')
  })

  it('holds exactly 12 monthly occurrences whatever day of the month the cost falls on', () => {
    // The reason the window is half-open. A window bounded on calendar months gives eleven occurrences
    // for a cost due on the 1st and twelve for one due on the 20th, purely because of the report date.
    for (const day of ['01', '14', '18', '28']) {
      const cost = validateRecurringCost({
        ...fixedInput,
        firstDueDate: localDate(`2026-01-${day}`),
      })
      expect(
        expectedInstances(cost, { from: TODAY, to: addMonths(TODAY, 12) }),
        `anchored on the ${day}`,
      ).toHaveLength(12)
    }
  })

  it('stops at the final due date rather than forecasting a contract that has ended', () => {
    const ending = validateRecurringCost({ ...fixedInput, finalDueDate: localDate('2026-06-01') })
    const instances = expectedInstances(ending, {
      from: localDate('2026-01-01'),
      to: localDate('2028-01-01'),
    })
    expect(instances.map((instance) => instance.dueDate)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
    ])
  })

  it('returns nothing for a contract that ended before the window opened', () => {
    const over = validateRecurringCost({ ...fixedInput, finalDueDate: localDate('2026-03-01') })
    expect(expectedInstances(over, { from: TODAY, to: addMonths(TODAY, 12) })).toEqual([])
  })

  it('refuses a window that ends before it starts', () => {
    expect(() =>
      expectedInstances(fixed, { from: localDate('2026-06-01'), to: localDate('2026-01-01') }),
    ).toThrow(/ends 2026-01-01, before it starts/)
  })
})

describe('the cadence arithmetic', () => {
  it('steps one, three and twelve months', () => {
    expect(RECURRING_CADENCES.map(periodMonthsFor)).toEqual([1, 3, 12])
  })

  it('raises rather than returning nothing for a cadence it cannot step', () => {
    // A NULL or an undefined here would make every due date unusable and the cost would simply vanish
    // from the forecast, which is the one failure a cost register must not have.
    expect(refusalOf(() => periodMonthsFor('fortnightly' as RecurringCadence))).toBe(
      RECURRING_COST_REFUSALS.unknownCadence,
    )
  })

  it('anchors every occurrence on the first due date rather than chaining from the last', () => {
    // Anchored, so a missing row cannot shift every later date. Occurrence 13 is computable without
    // occurrences 1 to 12 existing.
    expect(recurringDueDate(localDate('2026-01-15'), 'monthly', 13)).toBe('2027-02-15')
    expect(recurringDueDate(localDate('2026-02-10'), 'quarterly', 3)).toBe('2026-11-10')
    expect(recurringDueDate(localDate('2026-11-05'), 'annual', 2)).toBe('2028-11-05')
  })

  it('steps backwards for a negative occurrence, because the window may open before the anchor', () => {
    expect(recurringDueDate(localDate('2026-01-15'), 'monthly', -1)).toBe('2025-12-15')
  })

  it('clamps a day that does not exist in the target month, exactly as PostgreSQL does', () => {
    // Unreachable through validation — an anchor past the 28th is refused — and defined anyway, so the
    // agreement test can compare the two implementations over the days validation rules out as well.
    expect(recurringDueDate(localDate('2026-01-31'), 'monthly', 1)).toBe('2026-02-28')
    expect(recurringDueDate(localDate('2028-01-31'), 'monthly', 1)).toBe('2028-02-29')
  })

  it('refuses a fractional occurrence', () => {
    expect(() => recurringDueDate(localDate('2026-01-15'), 'monthly', 1.5)).toThrow(
      /whole number of periods/,
    )
  })

  it('keys a period by the calendar month of its due date, for every cadence', () => {
    expect(recurringPeriodKey(localDate('2026-09-18'))).toBe('2026-09')
    expect(recurringPeriodKey(recurringDueDate(localDate('2026-11-05'), 'annual', 1))).toBe(
      '2027-11',
    )
    expect(isRecurringPeriodKey('2026-09')).toBe(true)
    expect(isRecurringPeriodKey('2026-13')).toBe(false)
    expect(isRecurringPeriodKey('2026-Q3')).toBe(false)
  })

  it('counts whole months between two dates, ignoring the day', () => {
    expect(monthsBetween(localDate('2026-01-31'), localDate('2026-02-01'))).toBe(1)
    expect(monthsBetween(localDate('2026-09-18'), localDate('2025-09-18'))).toBe(-12)
  })

  it('adds months with the same clamp the due dates use', () => {
    expect(addMonths(localDate('2026-09-18'), 12)).toBe('2027-09-18')
    expect(addMonths(localDate('2026-01-31'), 1)).toBe('2026-02-28')
    expect(addMonths(localDate('2026-03-15'), -3)).toBe('2025-12-15')
  })

  it('treats a period due today as not yet late', () => {
    // An off-by-one here reports arrears that do not exist, the same way it would in the payables aging.
    expect(isPeriodOverdue(TODAY, TODAY)).toBe(false)
    expect(isPeriodOverdue(localDate('2026-09-17'), TODAY)).toBe(true)
    expect(isPeriodOverdue(localDate('2026-09-19'), TODAY)).toBe(false)
  })
})

describe('acceptance — a variable cost needs a range and a fixed cost needs an amount', () => {
  it('refuses a variable cost with no expected range, by name', () => {
    expect(
      refusalOf(() =>
        validateRecurringCost({ ...variableInput, expectedMin: null, expectedMax: null }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.expectedRangeRequired)
  })

  it('refuses a variable cost that states only one end of the range', () => {
    expect(refusalOf(() => validateRecurringCost({ ...variableInput, expectedMax: null }))).toBe(
      RECURRING_COST_REFUSALS.expectedRangeRequired,
    )
    expect(refusalOf(() => validateRecurringCost({ ...variableInput, expectedMin: null }))).toBe(
      RECURRING_COST_REFUSALS.expectedRangeRequired,
    )
  })

  it('refuses a fixed cost with no expected amount, by name', () => {
    expect(refusalOf(() => validateRecurringCost({ ...fixedInput, expectedAmount: null }))).toBe(
      RECURRING_COST_REFUSALS.expectedAmountRequired,
    )
  })

  it('refuses a definition that states both shapes, in either direction', () => {
    // A half-filled definition is worse than a missing one: whichever non-null column a reader reached
    // for first would decide the variance, and two readers would disagree.
    expect(
      refusalOf(() =>
        validateRecurringCost({ ...fixedInput, expectedMin: aed(1), expectedMax: aed(2) }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.expectedAmountRequired)
    expect(
      refusalOf(() => validateRecurringCost({ ...variableInput, expectedAmount: aed(3_000) })),
    ).toBe(RECURRING_COST_REFUSALS.expectedRangeRequired)
  })

  it('refuses an inverted band', () => {
    expect(
      refusalOf(() =>
        validateRecurringCost({
          ...variableInput,
          expectedMin: aed(4_000),
          expectedMax: aed(2_000),
        }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.expectedRangeInverted)
  })

  it('refuses a zero expectation, on either shape', () => {
    expect(refusalOf(() => validateRecurringCost({ ...fixedInput, expectedAmount: zero() }))).toBe(
      RECURRING_COST_REFUSALS.expectedAmountNotPositive,
    )
    expect(refusalOf(() => validateRecurringCost({ ...variableInput, expectedMin: zero() }))).toBe(
      RECURRING_COST_REFUSALS.expectedAmountNotPositive,
    )
  })

  it('refuses a kind that is neither fixed nor variable', () => {
    expect(RECURRING_COST_KINDS).toEqual(['fixed', 'variable'])
    expect(
      refusalOf(() =>
        validateRecurringCost({
          ...fixedInput,
          kind: 'seasonal' as RecurringCostInput['kind'],
        }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.expectedAmountRequired)
  })

  it('refuses a tolerance that is not a fraction, and accepts both ends of the range', () => {
    for (const toleranceBp of [-1, 10_001, 2.5]) {
      expect(refusalOf(() => validateRecurringCost({ ...fixedInput, toleranceBp }))).toBe(
        RECURRING_COST_REFUSALS.toleranceOutOfRange,
      )
    }
    expect(validateRecurringCost({ ...fixedInput, toleranceBp: 0 }).expectation.toleranceBp).toBe(0)
    expect(
      validateRecurringCost({ ...fixedInput, toleranceBp: 10_000 }).expectation.toleranceBp,
    ).toBe(10_000)
  })

  it('refuses an anchor whose day does not exist in every month, and accepts the 28th', () => {
    expect(
      refusalOf(() =>
        validateRecurringCost({ ...fixedInput, firstDueDate: localDate('2026-01-31') }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.anchorDayOutsideEveryMonth)
    expect(
      validateRecurringCost({
        ...fixedInput,
        firstDueDate: localDate(`2026-01-${LAST_ANCHOR_DAY_OF_MONTH}`),
      }).firstDueDate,
    ).toBe('2026-01-28')
  })

  it('refuses an unknown cadence on the definition', () => {
    expect(
      refusalOf(() =>
        validateRecurringCost({ ...fixedInput, cadence: 'weekly' as RecurringCadence }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.unknownCadence)
  })

  it('refuses a contract that ends before its first period falls due', () => {
    expect(
      refusalOf(() =>
        validateRecurringCost({ ...fixedInput, finalDueDate: localDate('2025-12-01') }),
      ),
    ).toBe(RECURRING_COST_REFUSALS.contractEndsBeforeItStarts)
  })

  it('accepts an open-ended contract and reports it as open-ended', () => {
    expect(validateRecurringCost(fixedInput).finalDueDate).toBeNull()
    expect(validateRecurringCost({ ...fixedInput, finalDueDate: null }).finalDueDate).toBeNull()
  })

  it('does not mistake some other error for one of its refusals', () => {
    // The control for `refusalOf` itself. Without it, a test that expected a refusal and got an
    // unrelated throw would still pass.
    expect(refusalOf(() => recurringDueDate(localDate('2026-01-15'), 'monthly', 1.5))).toMatch(
      /^unrecognised:/,
    )
    expect(refusalOf(() => undefined)).toBeUndefined()
  })
})

describe('acceptance — the variance, at the tolerance boundary on both sides', () => {
  /** A fixed cost with a 1% tolerance: 21,000 AED expected, so 210 AED of grace. */
  const withGrace = validateRecurringCost({ ...fixedInput, toleranceBp: 100 })

  it('is zero and within tolerance when the bill is exactly the contracted amount', () => {
    const verdict = classifyVariance(withGrace.expectation, aed(21_000))
    expect(verdict.delta.fils).toBe(0)
    // 1% of 21,000 AED is 210 AED, which is 21,000 fils of grace.
    expect(verdict.tolerance.fils).toBe(21_000)
    expect(verdict.overTolerance).toBe(false)
    expect(verdict.direction).toBe('within')
  })

  it('is within tolerance exactly ON the boundary, and over it one fils past', () => {
    const tolerance = classifyVariance(withGrace.expectation, aed(21_000)).tolerance.fils
    const onBoundary = money(filsFrom(2_100_000 + tolerance))
    const pastBoundary = money(filsFrom(2_100_000 + tolerance + 1))
    expect(classifyVariance(withGrace.expectation, onBoundary).overTolerance).toBe(false)
    expect(classifyVariance(withGrace.expectation, pastBoundary).overTolerance).toBe(true)
    expect(classifyVariance(withGrace.expectation, pastBoundary).delta.fils).toBe(tolerance + 1)
  })

  it('applies the same boundary below the expectation, with a negative delta', () => {
    const tolerance = classifyVariance(withGrace.expectation, aed(21_000)).tolerance.fils
    const onBoundary = money(filsFrom(2_100_000 - tolerance))
    const pastBoundary = money(filsFrom(2_100_000 - tolerance - 1))
    expect(classifyVariance(withGrace.expectation, onBoundary).overTolerance).toBe(false)
    const under = classifyVariance(withGrace.expectation, pastBoundary)
    expect(under.overTolerance).toBe(true)
    // Signed. A rent 200 short is a credit to chase; folding the sign away would file it with a rent
    // 200 over, which is the opposite conversation.
    expect(under.delta.fils).toBe(-(tolerance + 1))
    expect(under.direction).toBe('below')
  })

  it('alerts on any difference at all when the tolerance is zero', () => {
    expect(classifyVariance(fixed.expectation, aed(21_000)).overTolerance).toBe(false)
    const oneFilsOver = classifyVariance(fixed.expectation, money(filsFrom(2_100_001)))
    expect(oneFilsOver.overTolerance).toBe(true)
    expect(oneFilsOver.delta.fils).toBe(1)
    expect(oneFilsOver.direction).toBe('above')
  })

  it('raises nothing anywhere inside a variable cost band, including at both edges', () => {
    // This is the line that stops a seasonal cost alerting every month, which is the whole reason a
    // band is declared for it rather than a number.
    for (const gross of [aed(2_000), aed(3_000), aed(4_000)]) {
      const verdict = classifyVariance(variable.expectation, gross)
      expect(verdict.delta.fils, `at ${gross.fils} fils`).toBe(0)
      expect(verdict.overTolerance).toBe(false)
      expect(verdict.direction).toBe('within')
    }
  })

  it('measures a variable cost from the band edge it crossed, not from the middle', () => {
    // 5% of the 4,000 AED top of the band is 200 AED of grace beyond the band itself.
    expect(classifyVariance(variable.expectation, aed(4_200)).overTolerance).toBe(false)
    const over = classifyVariance(variable.expectation, money(filsFrom(420_001)))
    expect(over.overTolerance).toBe(true)
    expect(over.delta.fils).toBe(20_001)
    expect(over.tolerance.fils).toBe(20_000)
    expect(over.direction).toBe('above')

    const under = classifyVariance(variable.expectation, money(filsFrom(189_999)))
    expect(under.overTolerance).toBe(true)
    expect(under.delta.fils).toBe(-10_001)
    // The bottom edge, so 5% of 2,000 AED rather than of 4,000.
    expect(under.tolerance.fils).toBe(10_000)
    expect(under.direction).toBe('below')
  })

  it('rounds the tolerance half up, so a fractional threshold cannot be lost downwards', () => {
    // 21,000 AED at 1 bp is 210 fils exactly; 21,001 at 1 bp is 210.01, which rounds to 210. The half
    // case: 5,000 fils at 1 bp is 0.5, and half-up makes that 1 fils of grace rather than none.
    const half = validateRecurringCost({
      ...fixedInput,
      expectedAmount: money(filsFrom(5_000)),
      toleranceBp: 1,
    })
    expect(classifyVariance(half.expectation, money(filsFrom(5_001))).tolerance.fils).toBe(1)
    expect(classifyVariance(half.expectation, money(filsFrom(5_001))).overTolerance).toBe(false)
    expect(classifyVariance(half.expectation, money(filsFrom(5_002))).overTolerance).toBe(true)
  })

  it('reports the prudent and the optimistic figure for each shape', () => {
    // A forecast built on the middle of every band is short of cash in about half the months it covers.
    expect(prudentExpectation(variable.expectation)).toEqual(aed(4_000))
    expect(lowExpectation(variable.expectation)).toEqual(aed(2_000))
    expect(prudentExpectation(fixed.expectation)).toEqual(aed(21_000))
    expect(lowExpectation(fixed.expectation)).toEqual(aed(21_000))
  })
})

describe('the forward schedule', () => {
  const costs: readonly RecurringCost[] = [
    fixed,
    variable,
    validateRecurringCost({
      code: 'test-insurance',
      cadence: 'quarterly',
      firstDueDate: localDate('2026-10-01'),
      kind: 'fixed',
      expectedAmount: aed(3_000),
      toleranceBp: 250,
    }),
    validateRecurringCost({
      code: 'test-licence',
      cadence: 'annual',
      firstDueDate: localDate('2026-11-05'),
      kind: 'fixed',
      expectedAmount: aed(12_000),
      toleranceBp: 0,
    }),
  ]

  it('gives each cadence its own number of occurrences over twelve months', () => {
    const schedule = forwardSchedule(costs, TODAY, 12)
    const byCode = new Map<string, number>()
    for (const row of schedule.rows) byCode.set(row.code, (byCode.get(row.code) ?? 0) + 1)
    expect(Object.fromEntries(byCode)).toEqual({
      'test-rent': 12,
      'test-utilities': 12,
      'test-insurance': 4,
      'test-licence': 1,
    })
  })

  it('totals the prudent figure and the optimistic one separately', () => {
    const schedule = forwardSchedule(costs, TODAY, 12)
    // 12 x 21,000 + 12 x 4,000 (top of band) + 4 x 3,000 + 1 x 12,000 = 324,000 AED.
    expect(schedule.total).toEqual(aed(324_000))
    // The same horizon at the bottom of the band: 12 x 2,000 instead of 12 x 4,000.
    expect(schedule.lowTotal).toEqual(aed(300_000))
    expect(schedule.total.fils).toBe(
      schedule.rows.reduce((total, row) => total + row.expected.fils, 0),
    )
  })

  it('is ordered by due date and then by code, so a printed forecast diffs only where a figure moved', () => {
    const rows = forwardSchedule(costs, TODAY, 12).rows
    const keys = rows.map((row) => `${row.dueDate}|${row.code}`)
    expect(keys).toEqual([...keys].sort())
  })

  it('is empty for a register with no costs, rather than throwing', () => {
    const empty = forwardSchedule([], TODAY, 12)
    expect(empty.rows).toEqual([])
    expect(empty.total.fils).toBe(0)
  })

  it('refuses a horizon of less than one month', () => {
    for (const months of [0, -1, 1.5]) {
      expect(() => forwardSchedule(costs, TODAY, months)).toThrow(/at least one month/)
    }
  })

  it('defaults to twelve months, because that is the horizon the forecast is read over', () => {
    expect(forwardSchedule(costs, TODAY).months).toBe(12)
    expect(forwardSchedule(costs, TODAY)).toEqual(forwardSchedule(costs, TODAY, 12))
  })
})

/** Zero AED, built the long way: `aed(0)` is legal and reads as an amount somebody meant. */
function zero(): Money {
  return money(filsFrom(0))
}

import { describe, expect, it } from 'vitest'
import { accountCode } from '../ledger/account.ts'
import { STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { entryId, imbalanceFils, postEntry } from '../ledger/entry.ts'
import { reverseEntry } from '../ledger/reverse.ts'
import { localDate } from '../time.ts'
import {
  accrualMonthFromKey,
  accrualMonthKey,
  accrueGratuityMonth,
  assertGratuityRules,
  closedPeriodLabourAdjustmentEntry,
  completedServiceYears,
  correctGratuityOverAccrual,
  employedDaysInMonth,
  GRATUITY_ACCRUAL_SOURCE,
  type GratuityAccounts,
  type GratuityRules,
  gratuityAccrualEntry,
  gratuityDaysPerYearOn,
  gratuityLiabilityAt,
  gratuityMonthContributions,
  gratuityRulesFor,
  gratuitySettlementEntry,
  MONTH_LENGTH_LCM,
  monthAfter,
  UnusableGratuityRules,
} from './gratuity.ts'

/**
 * Worked examples for end-of-service gratuity, each named for the rule it encodes.
 *
 * ## Every figure here comes from the RULE ROW and none from this file's knowledge
 *
 * docs/04 §7 says one thing about gratuity — that it is an accruing balance-sheet liability accrued
 * monthly — and no rate, band, cap or wage basis anywhere. So {@link PROVISIONAL_V1} below is the seeded
 * `gratuity_rule` version 1 restated as a fixture, and every expectation is derived from ITS numbers in
 * the test's own words. That is what lets a test name the rule it encodes: change 21 to 22 in the rule and
 * the test that says "21 days ... for the first five years" fails by name rather than by arithmetic.
 *
 * `hr-gratuity.itest.ts` compares this fixture against the row the migration actually seeds in both
 * directions, so the pair cannot drift — the shape `ledger-chart.itest.ts` uses for the chart.
 */

/** The seeded version 1, restated. Every field provisional against `Y9-gratuity`. */
const PROVISIONAL_V1: GratuityRules = {
  effectiveFrom: localDate('1900-01-01'),
  daysPerYearFirstBand: 21,
  daysPerYearAfterBand: 30,
  bandBoundaryYears: 5,
  dailyWageDaysDivisor: 30,
  wageBasis: 'basic',
  probationMonths: 6,
  accruesDuringProbation: false,
  unpaidLeaveDaysExcluded: true,
}

/**
 * The same policy with probation and the unpaid-leave exclusion switched off.
 *
 * Used to isolate the pro-rating arithmetic from the probation exclusion. Without it every part-month
 * example would also be testing which months probation removed, and a failure could not say which of the
 * two was wrong.
 */
const NO_PROBATION: GratuityRules = {
  ...PROVISIONAL_V1,
  probationMonths: 0,
  accruesDuringProbation: true,
}

/** AED 3,000 a month, so a day of wage is exactly AED 100 under the rule's 30-day divisor. */
const WAGE = 300_000
/** A day of that wage: `WAGE ÷ dailyWageDaysDivisor`. Spelled so the expectations read as days. */
const DAY = WAGE / PROVISIONAL_V1.dailyWageDaysDivisor

const ACCOUNTS: GratuityAccounts = {
  expense: accountCode('5030'),
  liability: accountCode('2070'),
}

const liability = (args: {
  rules?: GratuityRules
  employedFrom: string
  employedUntil?: string | null
  asOf: string
  wageFils?: number
  unpaid?: ReadonlyMap<string, number>
}) =>
  gratuityLiabilityAt({
    rules: args.rules ?? PROVISIONAL_V1,
    service: {
      employedFrom: localDate(args.employedFrom),
      employedUntil:
        args.employedUntil === undefined
          ? null
          : args.employedUntil === null
            ? null
            : localDate(args.employedUntil),
      ...(args.unpaid === undefined ? {} : { unpaidLeaveDaysByMonth: args.unpaid }),
    },
    asOf: localDate(args.asOf),
    wageFils: args.wageFils ?? WAGE,
  })

describe('MONTH_LENGTH_LCM', () => {
  /**
   * The constant is load-bearing: it is what makes a part month's contribution an exact integer instead of
   * a per-month rounding. A typo in the literal would not fail anything else — the arithmetic would still
   * run — it would silently bias every part month, so the constant is recomputed here rather than trusted.
   */
  it('is the lowest common multiple of every possible month length, recomputed not trusted', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
    const lcm = [28, 29, 30, 31].reduce((acc, n) => (acc * n) / gcd(acc, n), 1)
    expect(MONTH_LENGTH_LCM).toBe(lcm)
    // The control: the scale for every month length must be a whole number, which is the only property
    // the arithmetic actually relies on. A constant that divided three of the four evenly would pass an
    // equality test written against itself.
    for (const days of [28, 29, 30, 31]) {
      expect(Number.isInteger(MONTH_LENGTH_LCM / days)).toBe(true)
    }
    // And the deliberately-wrong control: 377_580 ÷ 4 is a whole number too, so "divides evenly" alone is
    // not the property. A value one lower fails for every month length, which is what makes the check real.
    expect([28, 29, 30, 31].every((days) => Number.isInteger((MONTH_LENGTH_LCM - 1) / days))).toBe(
      false,
    )
  })
})

describe('the accrual rate by service length', () => {
  it('earns 21 days of wage per year of service for the first 5 years (rule v1 first band)', () => {
    // At four years and eleven months the fifth anniversary has not arrived, so the first band still holds.
    expect(
      gratuityDaysPerYearOn(PROVISIONAL_V1, localDate('2020-01-01'), localDate('2024-12-31')),
    ).toBe(PROVISIONAL_V1.daysPerYearFirstBand)
  })

  it('earns 30 days of wage per year of service after 5 years (rule v1 second band)', () => {
    // The day the fifth anniversary lands, and not a day earlier.
    expect(
      gratuityDaysPerYearOn(PROVISIONAL_V1, localDate('2020-01-01'), localDate('2025-01-01')),
    ).toBe(PROVISIONAL_V1.daysPerYearAfterBand)
    expect(
      gratuityDaysPerYearOn(PROVISIONAL_V1, localDate('2020-01-01'), localDate('2024-12-31')),
    ).not.toBe(PROVISIONAL_V1.daysPerYearAfterBand)
  })

  it('counts a completed year by stepping whole years, so 29 February completes on 28 February', () => {
    // Dividing a day count by 365.25 would put this on 1 March, which creates a day of service that did
    // not happen — and at a band boundary it creates nine days of wage.
    expect(completedServiceYears(localDate('2024-02-29'), localDate('2025-02-28'))).toBe(1)
    expect(completedServiceYears(localDate('2024-02-29'), localDate('2025-02-27'))).toBe(0)
  })

  it('refuses a service question dated before the employment started', () => {
    expect(() => completedServiceYears(localDate('2025-01-01'), localDate('2024-12-31'))).toThrow(
      UnusableGratuityRules,
    )
  })
})

describe('worked example: UNDER ONE YEAR of service', () => {
  /**
   * Engaged 1 January 2025, liability read at 31 December 2025.
   *
   * Twelve calendar months, six of them inside the six-month probation the rule says does not accrue, so
   * six months earn at 21 days a year: `6/12 × 21 = 10.5` days of wage.
   */
  it('accrues 10.5 days of wage: six earning months at 21 days a year, six inside probation', () => {
    const result = liability({ employedFrom: '2025-01-01', asOf: '2025-12-31' })
    expect(result.earningMonths).toBe(6)
    expect(result.probationMonths).toBe(6)
    // Stated as days × a day of wage, so the expectation names the rule rather than repeating a total.
    expect(result.fils).toBe(10.5 * DAY)
    expect(result.fils).toBe(105_000)
  })

  it('accrues nothing at all while every month is still inside probation', () => {
    const result = liability({ employedFrom: '2025-01-01', asOf: '2025-06-30' })
    expect(result.fils).toBe(0)
    expect(result.probationMonths).toBe(6)
    // And the control that makes the zero mean something: the SAME service with accrual running during
    // probation is not zero. Without it, a bug that returned zero for everything would pass.
    expect(
      liability({ rules: NO_PROBATION, employedFrom: '2025-01-01', asOf: '2025-06-30' }).fils,
    ).toBe((6 / 12) * 21 * DAY)
  })

  it('earns the month probation ends in, because a boundary mid-month must not cost a whole month', () => {
    // Probation ends 1 July 2025. June's month end is before it and July's is not.
    const contributions = gratuityMonthContributions({
      rules: PROVISIONAL_V1,
      service: { employedFrom: localDate('2025-01-01') },
      asOf: localDate('2025-07-31'),
    })
    const june = contributions.find((m) => m.accrualMonth === '2025-06-01')
    const july = contributions.find((m) => m.accrualMonth === '2025-07-01')
    expect(june?.withinProbation).toBe(true)
    expect(july?.withinProbation).toBe(false)
  })
})

describe('worked example: ONE TO FIVE YEARS of service', () => {
  /**
   * Engaged 1 January 2020, liability read at 31 December 2024 — five calendar years, all of it inside the
   * first band because the fifth anniversary falls on 1 January 2025. Six probation months earn nothing,
   * so 54 months at 21 days a year: `54/12 × 21 = 94.5` days of wage.
   */
  it('accrues 94.5 days of wage: 54 earning months at 21 days a year, still the first band', () => {
    const result = liability({ employedFrom: '2020-01-01', asOf: '2024-12-31' })
    expect(result.earningMonths).toBe(54)
    expect(result.fils).toBe(94.5 * DAY)
    expect(result.fils).toBe(945_000)
    // Every month earned at the FIRST band rate. The control on the band: if any month had tipped into the
    // second band this count would drop, and the total alone would not say which month did it.
    expect(
      result.contributions.filter((m) => m.daysPerYear === PROVISIONAL_V1.daysPerYearFirstBand)
        .length,
    ).toBe(60)
  })
})

describe('worked example: OVER FIVE YEARS of service', () => {
  /**
   * Engaged 1 January 2020, liability read at 31 December 2026 — seven calendar years. Six probation
   * months earn nothing; 54 months earn at 21 days a year up to December 2024; the 24 months from January
   * 2025 earn at 30. `54/12 × 21 + 24/12 × 30 = 94.5 + 60 = 154.5` days of wage.
   */
  it('accrues 154.5 days of wage: 54 months at 21 a year then 24 at 30 a year', () => {
    const result = liability({ employedFrom: '2020-01-01', asOf: '2026-12-31' })
    expect(result.fils).toBe(154.5 * DAY)
    expect(result.fils).toBe(1_545_000)
    const second = result.contributions.filter(
      (m) => m.daysPerYear === PROVISIONAL_V1.daysPerYearAfterBand,
    )
    expect(second.length).toBe(24)
    // The band changes at the month containing the fifth anniversary and not one month either side. This
    // is the assertion a shift of the boundary by a month would fail; the total would move by nine days
    // of wage and still look like a plausible figure.
    expect(second.at(0)?.accrualMonth).toBe('2025-01-01')
  })

  it('a month straddling the band boundary earns at the HIGHER rate for the whole month', () => {
    // Engaged mid-month, so the fifth anniversary falls inside a month rather than on its first day. The
    // build's prudent reading — flagged on Y9-gratuity — is that the whole month earns at 30.
    const contributions = gratuityMonthContributions({
      rules: NO_PROBATION,
      service: { employedFrom: localDate('2020-06-15') },
      asOf: localDate('2025-06-30'),
    })
    const straddling = contributions.find((m) => m.accrualMonth === '2025-06-01')
    expect(straddling?.daysPerYear).toBe(PROVISIONAL_V1.daysPerYearAfterBand)
    // The control: the month BEFORE the anniversary is still the first band, so the boundary has not been
    // moved wholesale.
    expect(contributions.find((m) => m.accrualMonth === '2025-05-01')?.daysPerYear).toBe(
      PROVISIONAL_V1.daysPerYearFirstBand,
    )
  })
})

describe('a part month and the unpaid-leave exclusion', () => {
  it('pro-rates a part month on its own days: 17 of July 31 days', () => {
    expect(
      employedDaysInMonth({
        accrualMonth: localDate('2025-07-01'),
        employedFrom: localDate('2025-07-15'),
      }),
    ).toBe(17)
    const result = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-07-15',
      asOf: '2025-07-31',
    })
    // 21/12 days of wage, scaled by 17/31 of the month, rounded up to the fil.
    expect(result.fils).toBe(Math.ceil((WAGE * 21 * 17) / (12 * 30 * 31)))
    expect(result.fils).toBe(9_597)
  })

  it('excludes approved unpaid-leave days when the rule says so, and does not when it does not', () => {
    const unpaid = new Map([['2025-07-01', 5]])
    const excluded = liability({
      rules: { ...NO_PROBATION, unpaidLeaveDaysExcluded: true },
      employedFrom: '2025-07-15',
      asOf: '2025-07-31',
      unpaid,
    })
    const included = liability({
      rules: { ...NO_PROBATION, unpaidLeaveDaysExcluded: false },
      employedFrom: '2025-07-15',
      asOf: '2025-07-31',
      unpaid,
    })
    // 12 paid days of the 17 employed.
    expect(excluded.fils).toBe(Math.ceil((WAGE * 21 * 12) / (12 * 30 * 31)))
    expect(excluded.fils).toBe(6_775)
    // The control that makes the flag mean something: the same unpaid days with the flag off change
    // nothing, so a flag that was being ignored would fail here rather than passing both ways.
    expect(included.fils).toBe(9_597)
    expect(excluded.fils).toBeLessThan(included.fils)
  })

  it('never lets unpaid days exceed the days employed, so a month cannot earn negatively', () => {
    const result = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-07-15',
      asOf: '2025-07-31',
      unpaid: new Map([['2025-07-01', 99]]),
    })
    expect(result.fils).toBe(0)
    expect(result.contributions.at(-1)?.paidDays).toBe(0)
  })

  it('stops at a leaver’s last day rather than awarding the rest of the month', () => {
    const full = liability({ rules: NO_PROBATION, employedFrom: '2025-07-01', asOf: '2025-07-31' })
    const part = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-07-01',
      employedUntil: '2025-07-10',
      asOf: '2025-07-31',
    })
    expect(part.contributions.at(-1)?.employedDays).toBe(10)
    expect(part.fils).toBeLessThan(full.fils)
  })

  it('truncates a mid-month question rather than awarding the whole month', () => {
    // A liability read on the 10th must not include the 11th to the 31st, or every month-to-date figure
    // on a screen would be a month-end one.
    const midMonth = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-07-01',
      asOf: '2025-07-10',
    })
    expect(midMonth.contributions.at(-1)?.employedDays).toBe(10)
  })
})

describe('the rounding, and why it is up', () => {
  it('rounds the cumulative liability UP to the fil', () => {
    // A wage of 100,001 fils over one earning month at 21 days a year is 5,833.391… fils.
    const result = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-07-01',
      asOf: '2025-07-31',
      wageFils: 100_001,
    })
    const exact = (100_001 * 21) / (12 * 30)
    expect(result.fils).toBe(Math.ceil(exact))
    expect(result.fils).toBe(5_834)
    // The control: it is not merely "an integer near the answer". Rounding DOWN would give 5,833, and a
    // liability one fil short is the direction that leaves money owed with no figure showing it.
    expect(result.fils).not.toBe(Math.floor(exact))
  })

  it('never drifts: any run of monthly movements sums to the cumulative figure at the end', () => {
    // The whole reason the cumulative figure is the primitive (ADR 0057). Twelve independently-rounded
    // twelfths would not sum to the year, and the residue would be permanent in an append-only journal.
    let already = 0
    for (let month = 1; month <= 12; month += 1) {
      const key = `2025-${String(month).padStart(2, '0')}`
      const accrual = accrueGratuityMonth({
        rules: NO_PROBATION,
        service: { employedFrom: localDate('2025-01-01') },
        accrualMonth: accrualMonthFromKey(key),
        wageFils: 100_001,
        alreadyAccruedFils: already,
      })
      already += accrual.movementFils
    }
    const whole = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-01-01',
      asOf: '2025-12-31',
      wageFils: 100_001,
    })
    expect(already).toBe(whole.fils)
  })
})

describe('accrueGratuityMonth', () => {
  it('is zero for a month already accrued, by arithmetic rather than by a flag', () => {
    const first = accrueGratuityMonth({
      rules: NO_PROBATION,
      service: { employedFrom: localDate('2025-01-01') },
      accrualMonth: localDate('2025-01-01'),
      wageFils: WAGE,
      alreadyAccruedFils: 0,
    })
    const again = accrueGratuityMonth({
      rules: NO_PROBATION,
      service: { employedFrom: localDate('2025-01-01') },
      accrualMonth: localDate('2025-01-01'),
      wageFils: WAGE,
      alreadyAccruedFils: first.movementFils,
    })
    expect(first.movementFils).toBeGreaterThan(0)
    expect(again.movementFils).toBe(0)
    expect(again.overAccrued).toBe(false)
  })

  it('reports an over-accrual rather than posting a negative line', () => {
    // A wage corrected DOWNWARD after months of accrual. Direction lives in the side of a journal line,
    // never in the sign, so this is a correction and not a posting.
    const accrual = accrueGratuityMonth({
      rules: NO_PROBATION,
      service: { employedFrom: localDate('2025-01-01') },
      accrualMonth: localDate('2025-06-01'),
      wageFils: WAGE,
      alreadyAccruedFils: 999_999,
    })
    expect(accrual.overAccrued).toBe(true)
    expect(accrual.movementFils).toBeLessThan(0)
  })

  it('carries a wage rise as a catch-up in the month it is known, restating nothing', () => {
    // The property that matters for P-HR-12's immutable run: a wage change lands as one movement and no
    // earlier entry needs rewriting.
    const service = { employedFrom: localDate('2025-01-01') }
    const atOldWage = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-01-01',
      asOf: '2025-05-31',
    })
    const june = accrueGratuityMonth({
      rules: NO_PROBATION,
      service,
      accrualMonth: localDate('2025-06-01'),
      wageFils: WAGE * 2,
      alreadyAccruedFils: atOldWage.fils,
    })
    const wholeAtNewWage = liability({
      rules: NO_PROBATION,
      employedFrom: '2025-01-01',
      asOf: '2025-06-30',
      wageFils: WAGE * 2,
    })
    expect(atOldWage.fils + june.movementFils).toBe(wholeAtNewWage.fils)
    // And it is bigger than an ordinary month, which is what makes it a catch-up rather than a coincidence.
    expect(june.movementFils).toBeGreaterThan(wholeAtNewWage.fils / 6)
  })

  it('refuses a negative already-accrued figure', () => {
    expect(() =>
      accrueGratuityMonth({
        rules: NO_PROBATION,
        service: { employedFrom: localDate('2025-01-01') },
        accrualMonth: localDate('2025-01-01'),
        wageFils: WAGE,
        alreadyAccruedFils: -1,
      }),
    ).toThrow(UnusableGratuityRules)
  })

  it('refuses a fractional or negative wage', () => {
    for (const wageFils of [1.5, -1]) {
      expect(() =>
        liability({
          rules: NO_PROBATION,
          employedFrom: '2025-01-01',
          asOf: '2025-01-31',
          wageFils,
        }),
      ).toThrow(UnusableGratuityRules)
    }
  })
})

describe('the rule version in force', () => {
  const v2: GratuityRules = {
    ...PROVISIONAL_V1,
    effectiveFrom: localDate('2026-01-01'),
    daysPerYearFirstBand: 25,
  }

  it('picks the latest version taking effect at or before the date', () => {
    expect(
      gratuityRulesFor([PROVISIONAL_V1, v2], localDate('2025-12-31')).daysPerYearFirstBand,
    ).toBe(21)
    expect(
      gratuityRulesFor([PROVISIONAL_V1, v2], localDate('2026-01-01')).daysPerYearFirstBand,
    ).toBe(25)
  })

  it('is order-independent, because a policy list arrives in whatever order a query returned it', () => {
    expect(
      gratuityRulesFor([v2, PROVISIONAL_V1], localDate('2025-12-31')).daysPerYearFirstBand,
    ).toBe(21)
  })

  it('refuses a date no version governs rather than accruing against no policy', () => {
    expect(() => gratuityRulesFor([v2], localDate('2025-12-31'))).toThrow(UnusableGratuityRules)
  })
})

describe('assertGratuityRules', () => {
  it('accepts the seeded version', () => {
    expect(() => assertGratuityRules(PROVISIONAL_V1)).not.toThrow()
  })

  it('refuses a version that earns nothing in either band', () => {
    // A rate set that entitles nobody to anything satisfies any reconciliation written against it, which
    // is the shape 0066 refuses for an all-empty sick-leave tier set.
    expect(() =>
      assertGratuityRules({
        ...PROVISIONAL_V1,
        daysPerYearFirstBand: 0,
        daysPerYearAfterBand: 0,
      }),
    ).toThrow(UnusableGratuityRules)
  })

  it.each([
    ['daysPerYearFirstBand', { daysPerYearFirstBand: 367 }],
    ['daysPerYearAfterBand', { daysPerYearAfterBand: -1 }],
    ['bandBoundaryYears', { bandBoundaryYears: 0 }],
    ['dailyWageDaysDivisor', { dailyWageDaysDivisor: 0 }],
    ['dailyWageDaysDivisor', { dailyWageDaysDivisor: 32 }],
    ['probationMonths', { probationMonths: 61 }],
  ])('refuses %s outside its bounds', (_field, patch) => {
    expect(() => assertGratuityRules({ ...PROVISIONAL_V1, ...patch })).toThrow(
      UnusableGratuityRules,
    )
  })

  it('refuses a wage basis outside the closed set', () => {
    expect(() => assertGratuityRules({ ...PROVISIONAL_V1, wageBasis: 'total' as never })).toThrow(
      UnusableGratuityRules,
    )
  })
})

describe('the journal entry an accrual posts', () => {
  const draft = () =>
    gratuityAccrualEntry({
      entryId: entryId('GR-2025-07-T07'),
      entryDate: localDate('2025-07-31'),
      accounts: ACCOUNTS,
      amountFils: 105_000,
      accrualMonth: localDate('2025-07-01'),
      staffReference: 'Therapist 07',
    })

  it('is one balanced entry: expense debit, liability credit, summing to zero fils', () => {
    const entry = postEntry(draft(), STANDARD_SPA_CHART)
    expect(entry.lines).toHaveLength(2)
    expect(imbalanceFils(entry.lines)).toBe(0)
    expect(entry.source).toBe(GRATUITY_ACCRUAL_SOURCE)
    const [expense, liabilityLine] = entry.lines
    expect(expense?.debitFils).toBe(105_000)
    expect(expense?.creditFils).toBe(0)
    expect(liabilityLine?.creditFils).toBe(105_000)
    expect(liabilityLine?.debitFils).toBe(0)
  })

  it('names the employee by staff_reference and never by a person’s name (ADR 0020)', () => {
    const entry = postEntry(draft(), STANDARD_SPA_CHART)
    expect(entry.narrative).toContain('Therapist 07')
  })

  it('names the month that EARNED it, which is not the month it is dated in', () => {
    const entry = postEntry(
      gratuityAccrualEntry({
        entryId: entryId('GR-2025-07-T07-CATCHUP'),
        // Dated in September, for July, because July's period is locked.
        entryDate: localDate('2025-09-30'),
        accounts: ACCOUNTS,
        amountFils: 105_000,
        accrualMonth: localDate('2025-07-01'),
        staffReference: 'Therapist 07',
        lockedPeriodId: '2025-07',
      }),
      STANDARD_SPA_CHART,
    )
    expect(entry.entryDate).toBe('2025-09-30')
    expect(entry.narrative).toContain('2025-07-01')
    expect(entry.narrative).toContain('2025-07')
    expect(entry.narrative).toContain('locked')
  })

  it('refuses a zero or negative amount, because a zero-fils entry balances and posts nothing', () => {
    for (const amountFils of [0, -1]) {
      expect(() =>
        gratuityAccrualEntry({
          entryId: entryId('GR-BAD'),
          entryDate: localDate('2025-07-31'),
          accounts: ACCOUNTS,
          amountFils,
          accrualMonth: localDate('2025-07-01'),
          staffReference: 'Therapist 07',
        }),
      ).toThrow(UnusableGratuityRules)
    }
  })
})

describe('correcting an over-accrual', () => {
  const original = postEntry(
    gratuityAccrualEntry({
      entryId: entryId('GR-2025-07-T07'),
      entryDate: localDate('2025-07-31'),
      accounts: ACCOUNTS,
      amountFils: 105_000,
      accrualMonth: localDate('2025-07-01'),
      staffReference: 'Therapist 07',
    }),
    STANDARD_SPA_CHART,
  )

  it('is a dated reversal plus a replacement entry, never an edit', () => {
    const correction = correctGratuityOverAccrual({
      original: original.entryId,
      replacementEntryId: entryId('GR-2025-07-T07-C1'),
      on: localDate('2025-08-31'),
      accounts: ACCOUNTS,
      correctedFils: 90_000,
      accrualMonth: localDate('2025-07-01'),
      staffReference: 'Therapist 07',
    })
    expect(correction.reversalOf).toBe(original.entryId)
    const reversal = reverseEntry(original, localDate('2025-08-31'))
    expect(reversal.reverses).toBe(original.entryId)
    expect(imbalanceFils(reversal.lines)).toBe(0)
    // The reversal swaps the sides and keeps the absolute fils, so the pair nets to nothing.
    expect(reversal.lines[0]?.creditFils).toBe(105_000)

    const replacement = postEntry(correction.replacement as never, STANDARD_SPA_CHART)
    expect(imbalanceFils(replacement.lines)).toBe(0)
    expect(replacement.lines[0]?.debitFils).toBe(90_000)
    // The three entries together leave exactly the corrected figure on the liability account. Netted by
    // ACCOUNT rather than by line index, so the assertion survives a posting rule that reorders its lines
    // — and so it is asserting about the liability rather than about whatever line happened to be second.
    const netOnLiability = [original, reversal, replacement]
      .flatMap((entry) => entry.lines)
      .filter((line) => line.account === ACCOUNTS.liability)
      .reduce((net, line) => net + line.creditFils - line.debitFils, 0)
    expect(netOnLiability).toBe(90_000)
  })

  it('has no replacement when the corrected figure is zero — the reversal is the whole correction', () => {
    const correction = correctGratuityOverAccrual({
      original: original.entryId,
      replacementEntryId: entryId('GR-2025-07-T07-C1'),
      on: localDate('2025-08-31'),
      accounts: ACCOUNTS,
      correctedFils: 0,
      accrualMonth: localDate('2025-07-01'),
      staffReference: 'Therapist 07',
    })
    expect(correction.replacement).toBeNull()
  })

  it('refuses a negative corrected figure: the reduction is the reversal, not a sign', () => {
    expect(() =>
      correctGratuityOverAccrual({
        original: original.entryId,
        replacementEntryId: entryId('GR-BAD'),
        on: localDate('2025-08-31'),
        accounts: ACCOUNTS,
        correctedFils: -1,
        accrualMonth: localDate('2025-07-01'),
        staffReference: 'Therapist 07',
      }),
    ).toThrow(UnusableGratuityRules)
  })

  it('cannot be backdated before the entry it corrects', () => {
    expect(() => reverseEntry(original, localDate('2025-07-30'))).toThrow()
  })
})

describe('a leaver’s settlement', () => {
  it('discharges the liability against a payable and never touches cash', () => {
    const entry = postEntry(
      gratuitySettlementEntry({
        entryId: entryId('GR-SETTLE-T07'),
        entryDate: localDate('2026-03-31'),
        liabilityAccount: ACCOUNTS.liability,
        payableAccount: accountCode('2060'),
        amountFils: 945_000,
        staffReference: 'Therapist 07',
        employedUntil: localDate('2026-03-20'),
      }),
      STANDARD_SPA_CHART,
    )
    expect(imbalanceFils(entry.lines)).toBe(0)
    // The liability is DEBITED — reduced — and a payable credited. A cash or bank account here would pay
    // the money twice, because the payroll run pays the payable.
    expect(entry.lines[0]?.account).toBe(ACCOUNTS.liability)
    expect(entry.lines[0]?.debitFils).toBe(945_000)
    expect(entry.lines[1]?.account).toBe('2060')
    expect(entry.source).not.toBe(GRATUITY_ACCRUAL_SOURCE)
  })

  it('nets the liability to exactly zero when it discharges the accrued figure', () => {
    const accrued = liability({ employedFrom: '2020-01-01', asOf: '2024-12-31' })
    const entry = postEntry(
      gratuitySettlementEntry({
        entryId: entryId('GR-SETTLE-T08'),
        entryDate: localDate('2025-01-31'),
        liabilityAccount: ACCOUNTS.liability,
        payableAccount: accountCode('2060'),
        amountFils: accrued.fils,
        staffReference: 'Therapist 08',
        employedUntil: localDate('2024-12-31'),
      }),
      STANDARD_SPA_CHART,
    )
    const debitedToLiability = entry.lines
      .filter((line) => line.account === ACCOUNTS.liability)
      .reduce((total, line) => total + line.debitFils, 0)
    expect(accrued.fils - debitedToLiability).toBe(0)
  })
})

describe('the closed-period labour adjustment (P-HR-07’s re-pointed gap)', () => {
  const adjustment = (patch: Record<string, unknown> = {}) =>
    closedPeriodLabourAdjustmentEntry({
      entryId: entryId('ADJ-T07-2025-07-04'),
      entryDate: localDate('2025-09-30'),
      workedOn: localDate('2025-07-04'),
      lockedPeriodId: '2025-07',
      wagesExpenseAccount: accountCode('5010'),
      wagesPayableAccount: accountCode('2060'),
      amountFils: 40_000,
      staffReference: 'Therapist 07',
      reason: 'Covered a double shift; the front desk never recorded a clock-out.',
      ...patch,
    } as never)

  it('accrues wages against a payable, in the open period, naming the locked one', () => {
    const entry = postEntry(adjustment(), STANDARD_SPA_CHART)
    expect(imbalanceFils(entry.lines)).toBe(0)
    expect(entry.entryDate).toBe('2025-09-30')
    expect(entry.narrative).toContain('2025-07')
    expect(entry.narrative).toContain('2025-07-04')
    expect(entry.narrative).toContain('locked')
    // It credits a PAYABLE, so the next payroll run discharges it and no completed run is rewritten —
    // which is the constraint P-HR-12 handed over (ZY141/ZY142), satisfied by not needing it.
    expect(entry.lines[1]?.account).toBe('2060')
    // `adjustment` and not `payroll`: a reader filtering the journal for payroll must not find it there
    // and conclude a run covered it.
    expect(entry.source).toBe('adjustment')
  })

  it('carries the authoriser’s own reason into the narrative, because nothing else records the work', () => {
    const entry = postEntry(adjustment(), STANDARD_SPA_CHART)
    expect(entry.narrative).toContain('never recorded a clock-out')
  })

  it('refuses a blank reason', () => {
    expect(() => adjustment({ reason: '   ' })).toThrow(UnusableGratuityRules)
  })

  it('refuses an entry dated on or before the work', () => {
    // On or before the work means either inside the locked period, where it cannot post, or evidence that
    // the period was open and an audited punch correction was the right answer.
    for (const entryDate of [localDate('2025-07-04'), localDate('2025-07-03')]) {
      expect(() => adjustment({ entryDate })).toThrow(UnusableGratuityRules)
    }
  })

  it('refuses a zero or negative amount: this table only ever adjusts UPWARD', () => {
    for (const amountFils of [0, -40_000]) {
      expect(() => adjustment({ amountFils })).toThrow(UnusableGratuityRules)
    }
  })
})

describe('month keys', () => {
  it('round-trips a YYYY-MM key', () => {
    expect(accrualMonthKey(localDate('2025-07-01'))).toBe('2025-07')
    expect(accrualMonthFromKey('2025-07')).toBe('2025-07-01')
  })

  it('refuses a looser month spelling, so one month cannot have two keys', () => {
    for (const key of ['2025-7', '2025', '2025-07-01', 'July']) {
      expect(() => accrualMonthFromKey(key)).toThrow(UnusableGratuityRules)
    }
  })

  it('monthAfter steps to the first of the next month, clamping December to January', () => {
    expect(monthAfter(localDate('2025-07-15'))).toBe('2025-08-01')
    expect(monthAfter(localDate('2025-12-31'))).toBe('2026-01-01')
  })
})

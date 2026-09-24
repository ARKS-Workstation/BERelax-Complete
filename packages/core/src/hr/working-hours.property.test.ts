import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addMinutes, fromLocal, type Instant, localDate, localTime } from '../time.ts'
import { WORKED_MINUTE_BUCKETS, type WorkedMinuteBucket, type WorkingHoursRules } from './rates.ts'
import { splitWorkedMinutes } from './working-hours.ts'

/**
 * The bucket split's invariants, over randomised shifts inside the trading window.
 *
 * Three statements, and the first is the unit's acceptance criterion:
 *
 *   1. **The buckets partition the minutes.** For any shift inside 11:00–02:00 and any rule set, the four
 *      bucket counts sum to the worked minutes exactly, and every one of them is a non-negative integer.
 *      No minute may be counted twice and none may be lost, whatever combination of night window,
 *      overtime boundary and public holiday it falls under.
 *   2. **The overtime eligibility is the day's allowance and not the shift's.** Checked against an oracle
 *      written from the definition — `max(0, worked − allowance remaining)` — rather than by calling the
 *      code under test again.
 *   3. **The weighting is exactly the multipliers times the minutes**, in whole basis-point-minutes. A
 *      float anywhere in the chain shows up here as a value that is not an integer.
 *
 * ## The checker is proved able to fail
 *
 * Four mutants at the bottom — a split that counts a night minute as overtime as well, one that loses a
 * minute, one carrying a fractional minute, and one that gave each shift its own daily allowance — are put
 * through the same checks, which must report a problem for each. A property suite whose checker cannot
 * fail asserts nothing, however many cases it runs; and every one of these four is a plausible
 * implementation rather than a strawman.
 *
 * ## Cost
 *
 * The trading day's opening instant is computed for four dates OUTSIDE the property, and everything
 * generated inside it is an offset in minutes from one of them. That is the lesson
 * `../availability/solve.property.test.ts` records: a previous unit built its windows inside the property,
 * called `Intl` four million times and timed out, and the fix was to generate only what varies.
 */
/** 11:00 on four trading dates, precomputed. 900 minutes later is 02:00 the next calendar day. */
const OPENINGS: readonly Instant[] = ['2026-06-01', '2026-06-05', '2026-11-30', '2027-01-31'].map(
  (date) => fromLocal(localDate(date), localTime('11:00')),
)

/** The trading window is 11:00–02:00, which is 900 minutes. */
const WINDOW_MINUTES = 900

interface Split {
  readonly totalMinutes: number
  readonly minutes: Readonly<Record<WorkedMinuteBucket, number>>
  readonly multiplierBp: Readonly<Record<WorkedMinuteBucket, number>>
  readonly weightedMinuteBp: number
  readonly overtimeMinutes: number
}

/**
 * Every way a split can be wrong that does not need the clock to detect.
 *
 * Returns the problems as strings so a failure names what is wrong rather than only that something is.
 */
function problemsWith(
  split: Split,
  expected: { readonly totalMinutes: number; readonly overtimeMinutes: number },
): readonly string[] {
  const problems: string[] = []
  let summed = 0
  for (const bucket of WORKED_MINUTE_BUCKETS) {
    const minutes = split.minutes[bucket]
    if (!Number.isInteger(minutes))
      problems.push(`${bucket} is ${minutes}, not a whole minute count`)
    if (minutes < 0) problems.push(`${bucket} is negative: ${minutes}`)
    summed += minutes
  }
  if (summed !== split.totalMinutes) {
    problems.push(`the buckets sum to ${summed} but the shift is ${split.totalMinutes} minutes`)
  }
  if (split.totalMinutes !== expected.totalMinutes) {
    problems.push(`the shift is ${split.totalMinutes} minutes, expected ${expected.totalMinutes}`)
  }
  if (split.overtimeMinutes !== expected.overtimeMinutes) {
    problems.push(
      `${split.overtimeMinutes} minutes are overtime-eligible, expected ${expected.overtimeMinutes}`,
    )
  }
  let weighted = 0
  for (const bucket of WORKED_MINUTE_BUCKETS) {
    weighted += split.minutes[bucket] * split.multiplierBp[bucket]
  }
  if (weighted !== split.weightedMinuteBp) {
    problems.push(`weighted ${split.weightedMinuteBp} does not equal ${weighted} from the buckets`)
  }
  if (!Number.isInteger(split.weightedMinuteBp)) {
    problems.push(`weighted ${split.weightedMinuteBp} is not a whole basis-point-minute`)
  }
  return problems
}

/** The eligibility oracle, from the definition rather than from the implementation. */
const eligibleMinutes = (worked: number, alreadyWorked: number, allowance: number): number =>
  Math.max(0, worked - Math.max(0, allowance - alreadyWorked))

const rulesArbitrary = fc
  .record({
    ordinaryMinutesPerDay: fc.integer({ min: 1, max: 1440 }),
    ordinaryMinutesPerWeek: fc.integer({ min: 1, max: 10_080 }),
    weekStartsOn: fc.integer({ min: 0, max: 6 }),
    overtimeDailyCapMinutes: fc.integer({ min: 0, max: 1440 }),
    minimumRestMinutes: fc.integer({ min: 0, max: 1440 }),
    // Every uplift at or above the ordinary rate, which is what 0059's CHECK enforces. Ties are generated
    // on purpose: version 1 has night and public holiday equal, and a tie is where a partition most
    // easily becomes a double count.
    overtimeBp: fc.integer({ min: 10_000, max: 30_000 }),
    nightBp: fc.integer({ min: 10_000, max: 30_000 }),
    publicHolidayBp: fc.integer({ min: 10_000, max: 30_000 }),
    // A wrapping window and a non-wrapping one both get generated, because both are legal rows.
    nightFromMinutes: fc.integer({ min: 0, max: 1439 }),
    nightLengthMinutes: fc.integer({ min: 1, max: 1439 }),
  })
  .map((raw): WorkingHoursRules => {
    const hhmm = (minutes: number): string =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    return {
      effectiveFrom: localDate('1900-01-01'),
      ordinaryMinutesPerDay: raw.ordinaryMinutesPerDay,
      ordinaryMinutesPerWeek: raw.ordinaryMinutesPerWeek,
      weekStartsOn: raw.weekStartsOn,
      overtimeDailyCapMinutes: raw.overtimeDailyCapMinutes,
      minimumRestMinutes: raw.minimumRestMinutes,
      nightWindow: {
        from: localTime(hhmm(raw.nightFromMinutes)),
        until: localTime(hhmm((raw.nightFromMinutes + raw.nightLengthMinutes) % 1440)),
      },
      multiplierBp: {
        ordinary: 10_000,
        overtime: raw.overtimeBp,
        night: raw.nightBp,
        publicHoliday: raw.publicHolidayBp,
      },
    }
  })

describe('the bucket split, over randomised shifts inside the trading window', () => {
  it('partitions the worked minutes exactly, with integer arithmetic throughout', () => {
    fc.assert(
      fc.property(
        fc.nat({ max: OPENINGS.length - 1 }),
        fc.integer({ min: 0, max: WINDOW_MINUTES - 1 }),
        fc.integer({ min: 1, max: WINDOW_MINUTES }),
        fc.integer({ min: 0, max: 900 }),
        fc.boolean(),
        rulesArbitrary,
        (dayIndex, startOffset, requested, alreadyWorked, isPublicHoliday, rules) => {
          const opensAt = OPENINGS[dayIndex] as Instant
          // Clipped to the close, so every generated shift really is inside 11:00-02:00.
          const durationMinutes = Math.min(requested, WINDOW_MINUTES - startOffset)
          const period = {
            startsAt: addMinutes(opensAt, startOffset),
            endsAt: addMinutes(opensAt, startOffset + durationMinutes),
          }
          const split = splitWorkedMinutes({
            period,
            rules,
            isPublicHoliday,
            minutesAlreadyWorked: alreadyWorked,
          })
          const problems = problemsWith(split, {
            totalMinutes: durationMinutes,
            overtimeMinutes: eligibleMinutes(
              durationMinutes,
              alreadyWorked,
              rules.ordinaryMinutesPerDay,
            ),
          })
          expect(problems, problems.join('; ')).toEqual([])
          return true
        },
      ),
      { numRuns: 300 },
    )
    // 30 seconds, not vitest's default 5.
    //
    // The fourth instance of one shape in this session, and the third in a file whose author had no reason
    // to suspect it: 300 generated shifts through the bucket splitter passes in about two seconds alone and
    // timed out at 5,000 ms under v8 coverage instrumentation with three sibling verify runs on the box. It
    // is a CORRECTNESS property — the buckets partition the worked minutes exactly — and nothing about it
    // is a claim about speed, so inheriting a performance budget makes it fail for a reason its own name
    // does not mention. See `search-analytics.test.ts`, `gender-match.property.test.ts` and
    // `availability-perf.itest.ts` for the same decision and the same reasoning. `numRuns` stays at 300
    // because the acceptance line asks for the coverage; the timeout moves instead.
  }, 30_000)
})

describe('the checker is able to fail', () => {
  const base: Split = {
    totalMinutes: 480,
    minutes: { publicHoliday: 0, night: 240, overtime: 0, ordinary: 240 },
    multiplierBp: { publicHoliday: 15_000, night: 15_000, overtime: 12_500, ordinary: 10_000 },
    weightedMinuteBp: 240 * 15_000 + 240 * 10_000,
    overtimeMinutes: 0,
  }
  const expected = { totalMinutes: 480, overtimeMinutes: 0 }

  it('accepts the correct split, so the mutants below are rejected for being wrong', () => {
    expect(problemsWith(base, expected)).toEqual([])
  })

  it('rejects a split that counts a night minute as overtime as well', () => {
    const mutant: Split = {
      ...base,
      minutes: { ...base.minutes, overtime: 240 },
      weightedMinuteBp: 240 * 15_000 + 240 * 12_500 + 240 * 10_000,
      overtimeMinutes: 240,
    }
    expect(problemsWith(mutant, expected).join('; ')).toMatch(/buckets sum to 720/)
  })

  it('rejects a split that loses a minute', () => {
    const mutant: Split = {
      ...base,
      minutes: { ...base.minutes, ordinary: 239 },
      weightedMinuteBp: 240 * 15_000 + 239 * 10_000,
    }
    expect(problemsWith(mutant, expected).join('; ')).toMatch(/buckets sum to 479/)
  })

  it('rejects a split carrying a fractional minute', () => {
    const mutant: Split = {
      ...base,
      minutes: { ...base.minutes, ordinary: 239.5, night: 240.5 },
      weightedMinuteBp: 240.5 * 15_000 + 239.5 * 10_000,
    }
    expect(problemsWith(mutant, expected).join('; ')).toMatch(/not a whole minute count/)
  })

  it('rejects a split that gave the shift its own daily allowance', () => {
    // The mutant a per-shift reading of the allowance produces: the eligibility is computed as though no
    // minutes had been worked earlier in the day, so an employee on two five-hour shifts works no
    // overtime at all.
    const mutant: Split = { ...base, overtimeMinutes: 0 }
    expect(problemsWith(mutant, { totalMinutes: 480, overtimeMinutes: 120 }).join('; ')).toMatch(
      /overtime-eligible, expected 120/,
    )
  })
})

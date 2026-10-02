import { describe, expect, it } from 'vitest'
import { localDate } from '../time.ts'
import type { LeaveEntitlementRules } from './leave-accrual.ts'
import { accrueMonth, HUNDREDTHS_PER_DAY, leaveYearStart } from './leave-accrual.ts'

/**
 * H-MIG-06's first acceptance line, as COMMITTED worked examples: *"leave accrual computed forward from
 * an imported non-zero opening balance matches a committed worked example exactly"*.
 *
 * ## What makes an example "committed", and why that is the point
 *
 * Every figure below is written out as a literal that was computed BY HAND from the policy, not produced
 * by running the code and pasting the answer. That distinction is the whole value of the file. A test
 * whose expectations came from the implementation asserts that the implementation has not changed, which
 * is a useful thing and is not what this acceptance line asks for: an imported opening balance is a
 * figure somebody will one day dispute, and the defence of it has to be an arithmetic a person can
 * redo on paper.
 *
 * So each case carries its own derivation in a comment, in the policy's own terms, and the expectation is
 * that derivation's result. If the engine changes, these fail; if the POLICY changes, they fail and the
 * derivations are what say which figures move.
 *
 * ## The policy they are computed against
 *
 * `SEEDED_POLICY` below is migration 0066's version 1, field for field — 30 calendar days a year, 2.5 a
 * month, accruing from day one and during probation, a 30-day carry-over cap, the leave year anchored on
 * the employment anniversary. It is restated here rather than read, because `packages/core` performs no
 * I/O (brief rule 4) — and `packages/fixtures/src/staff-import.itest.ts` is what holds this literal equal
 * to the row the database actually has, so the restatement cannot drift silently.
 *
 * ## Why the opening balance is an addend and never an input to the accrual
 *
 * `accrueMonth` does not take a balance and must not: a month's accrual is a function of the policy and
 * the days the employment covered, so an opening balance that reached it could only be used to cap or
 * taper the figure — which is a policy nobody has stated. The balance is therefore the first term of a
 * SUM, and that is what makes "accrual computed forward from an imported balance" checkable at all: the
 * balance is one number, the accrual is another, and nothing mixes them.
 */

/** Migration 0066 version 1, field for field. Held equal to the row by the pairing suite. */
const SEEDED_POLICY: LeaveEntitlementRules = {
  effectiveFrom: localDate('1900-01-01'),
  annualEntitlementDays: 30,
  monthlyAccrualHundredths: 250,
  probationMonths: 6,
  accruesDuringProbation: true,
  carryOverCapHundredths: 3000,
  carryOverExpiresAfterOneLeaveYear: false,
  leaveYearStartsOnAnniversary: true,
  unpaidLeaveReducesAccrual: true,
  absentDayReducesAccrual: true,
  sickLeave: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
}

const VERSIONS = [SEEDED_POLICY]

/** Months `YYYY-MM-01`, from `from` inclusive, `count` of them. */
function monthsFrom(from: string, count: number): string[] {
  const [year, month] = from.split('-').map(Number) as [number, number]
  const out: string[] = []
  for (let i = 0; i < count; i += 1) {
    const total = month - 1 + i
    const y = year + Math.floor(total / 12)
    const m = (total % 12) + 1
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
  }
  return out
}

/** The sum of `count` whole months of accrual from `from`, with no reduced days anywhere. */
function accrueForward(args: {
  readonly employedFrom: string
  readonly from: string
  readonly count: number
}): number {
  return monthsFrom(args.from, args.count).reduce(
    (total, month) =>
      total +
      accrueMonth({
        versions: VERSIONS,
        employedFrom: localDate(args.employedFrom),
        accrualMonth: localDate(month),
      }).hundredths,
    0,
  )
}

describe('accrual forward from an imported opening balance', () => {
  /*
    Example 1 — the plain case, and the one an owner will check first.

    Somebody engaged on 2024-03-01 has an imported balance of 14.00 days as at 2026-09-30. Twelve whole
    months are then accrued, 2026-10 through 2027-09.

    By hand: every one of those twelve is a WHOLE month of employment, so each earns the whole monthly
    figure — 250 hundredths, with no pro-rating and therefore no rounding anywhere. Twelve of them is
    250 × 12 = 3000, which is the annual entitlement exactly (0066 ties the two: 30 × 100 = 250 × 12).
    The balance is 1400 + 3000 = 4400 hundredths, which is 44.00 days.
  */
  it('1400 + twelve whole months is 4400 hundredths', () => {
    const accrued = accrueForward({ employedFrom: '2024-03-01', from: '2026-10-01', count: 12 })
    expect(accrued).toBe(3000)
    expect(1400 + accrued).toBe(4400)
    // Stated in days as well, because 44.00 is the figure a person reads off a screen and 4400 is not.
    expect((1400 + accrued) / HUNDREDTHS_PER_DAY).toBe(44)
  })

  /*
    Example 2 — a part month, which is where the rounding direction shows.

    Somebody engaged on 2026-09-16 has an imported balance of 2.50 days as at 2026-09-30. September 2026
    has 30 days and the employment covers the 16th to the 30th, which is 15 of them.

    By hand: 250 × 15 / 30 = 125 exactly — no rounding, because 15 is half of 30 and 250 is even. The
    first full month, October, earns 250. So the balance after September and October is
    250 + 125 + 250 = 625 hundredths, 6.25 days.

    September is accrued here and the imported balance is as at 2026-09-30, which would double-count it
    if the two were added blindly. They are not: the forward accrual starts at OCTOBER, and the September
    figure is asserted on its own to show the pro-rating is the policy's and not this file's.
  */
  it('a part month pro-rates on days, exactly, with no rounding', () => {
    const september = accrueMonth({
      versions: VERSIONS,
      employedFrom: localDate('2026-09-16'),
      accrualMonth: localDate('2026-09-01'),
    })
    expect(september.daysInMonth).toBe(30)
    expect(september.employedDays).toBe(15)
    expect(september.hundredths).toBe(125)

    const october = accrueForward({ employedFrom: '2026-09-16', from: '2026-10-01', count: 1 })
    expect(october).toBe(250)
    expect(250 + october).toBe(500)
  })

  /*
    Example 3 — the rounding direction, stated as a figure rather than as a sentence.

    Somebody engaged on 2026-02-02 accrues for February 2026, which has 28 days and whose employment
    covers the 2nd to the 28th: 27 days.

    By hand: 250 × 27 / 28 = 241.07…, and `ceilDiv` rounds UP, so 242. Rounding DOWN would give 241.
    The direction is a decision recorded in `leave-accrual.ts` — "of two errors, the one to make is the
    visible one that does not take something away" — and this is the case that would silently reverse if
    somebody changed it, because 241 is just as plausible as 242 on a screen.
  */
  it('rounds a pro-rated month UP, so 27/28 of 250 is 242 and not 241', () => {
    const february = accrueMonth({
      versions: VERSIONS,
      employedFrom: localDate('2026-02-02'),
      accrualMonth: localDate('2026-02-01'),
    })
    expect(february.accruingDays).toBe(27)
    expect(february.hundredths).toBe(242)
    expect(february.hundredths).not.toBe(241)
  })

  /*
    Example 4 — unpaid days reduce the month, and the reduction is on the DAYS and not on the figure.

    A whole 31-day month with 4 unpaid leave days accrues on 27 days.

    By hand: 250 × 27 / 31 = 217.74…, rounded up is 218. The wrong arithmetic — reducing the FIGURE by
    four thirty-firsts of itself after computing it — gives the same answer here, so the case also
    asserts the intermediate `accruingDays`, which the two readings disagree about and which is what
    `leave_movement` would have to be explained by.
  */
  it('reduces the month on the days, not on the figure', () => {
    const month = accrueMonth({
      versions: VERSIONS,
      employedFrom: localDate('2024-03-01'),
      accrualMonth: localDate('2026-10-01'),
      unpaidLeaveDays: 4,
    })
    expect(month.daysInMonth).toBe(31)
    expect(month.employedDays).toBe(31)
    expect(month.reducedDays).toBe(4)
    expect(month.accruingDays).toBe(27)
    expect(month.hundredths).toBe(218)
  })

  /*
    Example 5 — the leave year the imported balance opens, which is what the importer stores.

    The policy anchors the leave year on the employment anniversary. Somebody engaged on 2024-03-01 with
    a balance as at 2026-09-30 is in the leave year that opened on 2026-03-01 — the third anniversary,
    because 2026-03-01 is on or before the as-at date and 2027-03-01 is after it.

    This is the figure `insertImportedStaff` writes into `leave_movement.leave_year_start`, computed by
    this function and handed over, because `packages/db` may not import `packages/core` and re-deriving
    it in SQL would be "a second reading of that policy which disagrees for every employee not engaged on
    1 January".
  */
  it('anchors the leave year on the anniversary, which is the date the importer stores', () => {
    expect(leaveYearStart(SEEDED_POLICY, localDate('2024-03-01'), localDate('2026-09-30'))).toBe(
      '2026-03-01',
    )
    // The control: a calendar anchor would answer 2026-01-01, which is the figure this must NOT be.
    expect(
      leaveYearStart(SEEDED_POLICY, localDate('2024-03-01'), localDate('2026-09-30')),
    ).not.toBe('2026-01-01')
    expect(
      leaveYearStart(
        { ...SEEDED_POLICY, leaveYearStartsOnAnniversary: false },
        localDate('2024-03-01'),
        localDate('2026-09-30'),
      ),
    ).toBe('2026-01-01')
  })

  /*
    Example 6 — a ZERO opening balance is not an example of anything, and the arithmetic says so.

    Twelve months forward from zero is 3000 hundredths, which is indistinguishable from twelve months
    forward from an opening balance of zero days that somebody actually confirmed. That is the reason
    ZY372 refuses an unmarked zero: the two are the same number and only the provisional mark tells them
    apart.
  */
  it('cannot tell an unconfirmed zero from a confirmed one, which is why ZY372 exists', () => {
    const accrued = accrueForward({ employedFrom: '2024-03-01', from: '2026-10-01', count: 12 })
    expect(0 + accrued).toBe(accrued)
    expect(accrued).toBe(3000)
  })
})

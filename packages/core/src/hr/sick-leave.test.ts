import { describe, expect, it } from 'vitest'
import {
  assertSickLeaveTiers,
  SICK_LEAVE_PAY_BANDS,
  type SickLeaveTiers,
  sickLeaveEntitlementDays,
  sickLeavePayBandOn,
  splitSickLeaveDays,
} from './sick-leave.ts'

/**
 * P-HR-08 — the sick-leave tiers, at every boundary the acceptance criterion names.
 *
 * Each case's name states the rule it encodes, because the figures are a policy the business has not
 * confirmed (Y9-leave-detail) and a test named "returns half pay for 16" would say nothing about which
 * rule had changed when it goes red.
 *
 * The six boundary days are 15, 16, 45, 46, 90 and 91, and they are boundaries **because** the bands are
 * 15 / 30 / 45: day 15 is the last full-pay day, day 16 the first half-pay day, day 45 the last half-pay
 * day, day 46 the first unpaid day, day 90 the last day of any entitlement and day 91 the first with
 * none. Every one of them is asserted together with the day on the other side of it, because an
 * off-by-one moves both and asserting only the inside of a band cannot see it.
 *
 * The tier set below mirrors the version 0066 seeds. Restated here rather than read, because
 * `packages/core` may not touch a database; that the seeded row really carries these figures is asserted
 * against PostgreSQL by `apps/worker/src/jobs/leave-accrual.itest.ts`.
 */
const V1: SickLeaveTiers = { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 }

describe('the sick-leave pay band, at every boundary of the 15 / 30 / 45 tiers', () => {
  it('pays the FIRST day of an illness in full, because the bands are counted from day 1', () => {
    expect(sickLeavePayBandOn(V1, 1)).toBe('full_pay')
  })

  it('pays day 15 in full: the full-pay band is 15 days, so its last day is the 15th', () => {
    expect(sickLeavePayBandOn(V1, 15)).toBe('full_pay')
  })

  it('pays day 16 at half: the half-pay band opens the day after the 15 full-pay days', () => {
    expect(sickLeavePayBandOn(V1, 16)).toBe('half_pay')
  })

  it('pays day 45 at half: 15 full plus 30 half reaches exactly day 45', () => {
    expect(sickLeavePayBandOn(V1, 45)).toBe('half_pay')
  })

  it('pays day 46 nothing but keeps it sick leave: the unpaid band opens after day 45', () => {
    expect(sickLeavePayBandOn(V1, 46)).toBe('unpaid')
  })

  it('keeps day 90 inside the entitlement: 15 + 30 + 45 is 90 days of sick leave in all', () => {
    expect(sickLeavePayBandOn(V1, 90)).toBe('unpaid')
  })

  it('reports day 91 as EXHAUSTED rather than unpaid: the entitlement ends at day 90', () => {
    expect(sickLeavePayBandOn(V1, 91)).toBe('exhausted')
  })

  it('distinguishes exhausted from unpaid, which are the same money and different facts', () => {
    // The control for the pair above. Both bands pay nothing, so a function that collapsed them would
    // agree with every figure on a payslip and tell an employee they are still on sick leave when they
    // are not.
    expect(sickLeavePayBandOn(V1, 90)).not.toBe(sickLeavePayBandOn(V1, 91))
  })

  it('sums the three bands rather than holding a fourth figure for the total', () => {
    expect(sickLeaveEntitlementDays(V1)).toBe(90)
    // The control: the total must MOVE with a band. A stored total is the version of this that ships and
    // then disagrees with the bands by a day.
    expect(sickLeaveEntitlementDays({ ...V1, unpaidDays: 44 })).toBe(89)
  })

  it('refuses day 0, because a zero-based caller would be paid a day that does not exist', () => {
    expect(() => sickLeavePayBandOn(V1, 0)).toThrow(/counted from 1/)
    expect(() => sickLeavePayBandOn(V1, -1)).toThrow(/counted from 1/)
    expect(() => sickLeavePayBandOn(V1, 1.5)).toThrow(/counted from 1/)
  })

  it('answers every day of the entitlement with one of the four declared bands', () => {
    // Guards the exhaustiveness the boundary cases assume: a gap between two bands would show up as
    // `undefined` here and nowhere else.
    for (let day = 1; day <= 120; day += 1) {
      expect(SICK_LEAVE_PAY_BANDS).toContain(sickLeavePayBandOn(V1, day))
    }
  })
})

describe('a second certificate for the same illness continues the count', () => {
  it('splits a 20-day absence from day 1 into 15 full and 5 half', () => {
    // By hand: days 1-15 are full pay, days 16-20 are the first five half-pay days.
    expect(splitSickLeaveDays({ tiers: V1, days: 20 })).toEqual({
      full_pay: 15,
      half_pay: 5,
      unpaid: 0,
      exhausted: 0,
    })
  })

  it('pays a 20-day continuation of the same illness ENTIRELY at half, never at full again', () => {
    // 15 days already taken, so this absence starts at day 16 and every one of its 20 days is inside the
    // half-pay band, which runs to day 45.
    const split = splitSickLeaveDays({ tiers: V1, days: 20, daysAlreadyTaken: 15 })
    expect(split).toEqual({ full_pay: 0, half_pay: 20, unpaid: 0, exhausted: 0 })
    // The control, and the defect this argument exists to prevent: a split that restarted the count would
    // pay the first 15 of these at full pay, which for one long illness written on three certificates is
    // three times the entitlement and looks right on each payslip.
    expect(split.full_pay).not.toBe(splitSickLeaveDays({ tiers: V1, days: 20 }).full_pay)
  })

  it('crosses two boundaries in one absence: day 40 to day 50 is 6 half and 5 unpaid', () => {
    // By hand: days 40-45 are the last six half-pay days, days 46-50 are the first five unpaid ones.
    expect(splitSickLeaveDays({ tiers: V1, days: 11, daysAlreadyTaken: 39 })).toEqual({
      full_pay: 0,
      half_pay: 6,
      unpaid: 5,
      exhausted: 0,
    })
  })

  it('reports the days past day 90 as exhausted rather than dropping them', () => {
    // Days 89, 90 are unpaid; 91-93 are past the entitlement. The three must still be COUNTED: an
    // absence whose days vanished from the split would reconcile against nothing.
    const split = splitSickLeaveDays({ tiers: V1, days: 5, daysAlreadyTaken: 88 })
    expect(split).toEqual({ full_pay: 0, half_pay: 0, unpaid: 2, exhausted: 3 })
    const total = Object.values(split).reduce((a, b) => a + b, 0)
    expect(total).toBe(5)
  })

  it('splits zero days into zero of everything, so a nil absence is not a missing answer', () => {
    expect(splitSickLeaveDays({ tiers: V1, days: 0 })).toEqual({
      full_pay: 0,
      half_pay: 0,
      unpaid: 0,
      exhausted: 0,
    })
  })

  it('refuses a fractional or negative absence and a fractional continuation', () => {
    expect(() => splitSickLeaveDays({ tiers: V1, days: 2.5 })).toThrow(/whole number of days/)
    expect(() => splitSickLeaveDays({ tiers: V1, days: -1 })).toThrow(/whole number of days/)
    expect(() => splitSickLeaveDays({ tiers: V1, days: 1, daysAlreadyTaken: -1 })).toThrow(
      /Days already taken/,
    )
  })
})

describe('a tier set the band arithmetic cannot be right about is refused', () => {
  it('accepts the seeded tiers, so the refusals below are about the tier sets and not the guard', () => {
    expect(() => assertSickLeaveTiers(V1)).not.toThrow()
  })

  it('refuses an all-zero tier set, which would answer exhausted to every day of every illness', () => {
    // The vacuity this guard exists for: every boundary assertion above would pass against a tier set
    // entitling nobody to anything, because they would all read `exhausted`.
    expect(() => assertSickLeaveTiers({ fullPayDays: 0, halfPayDays: 0, unpaidDays: 0 })).toThrow(
      /entitling nobody/,
    )
  })

  it('refuses a negative or fractional band', () => {
    expect(() => assertSickLeaveTiers({ ...V1, halfPayDays: -1 })).toThrow(/half-pay band/)
    expect(() => assertSickLeaveTiers({ ...V1, fullPayDays: 15.5 })).toThrow(/full-pay band/)
    expect(() => assertSickLeaveTiers({ ...V1, unpaidDays: 4000 })).toThrow(/unpaid band/)
  })

  it('accepts a tier set with an EMPTY band, because a policy may have no unpaid tier', () => {
    // Not every band is compulsory. The guard refuses a tier set with nothing in it at all, which is a
    // different claim, and this case is the control that keeps the two apart.
    const noUnpaid: SickLeaveTiers = { fullPayDays: 15, halfPayDays: 30, unpaidDays: 0 }
    expect(() => assertSickLeaveTiers(noUnpaid)).not.toThrow()
    expect(sickLeavePayBandOn(noUnpaid, 45)).toBe('half_pay')
    expect(sickLeavePayBandOn(noUnpaid, 46)).toBe('exhausted')
  })
})

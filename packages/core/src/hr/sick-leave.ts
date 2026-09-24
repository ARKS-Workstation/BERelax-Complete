import { AppError } from '@berelax/shared'

/**
 * The sick-leave pay tiers: which band a given day of one illness is paid in. Pure.
 *
 * docs/04 §7 names them and gives no numbers — "sick-leave tiers (full / half / unpaid) after probation",
 * with the section's own standing caveat that every figure is to be confirmed with MOHRE. The figures
 * therefore live in `leave_entitlement_rule` (migration 0066) flagged provisional against
 * Y9-leave-detail, and this module holds only the **shape** of the rule: three consecutive bands over a
 * one-based day count, and a fourth answer for the day after the last of them.
 *
 * ## Why `unpaid` and `exhausted` are different answers
 *
 * They are the same amount of money and they are not the same fact. `unpaid` is sick leave: the absence
 * is authorised, the employment continues, and the day is one the employer may not treat as absence
 * without leave. `exhausted` means the statutory entitlement for that illness is used up, and what
 * happens on the next day is a different decision entirely — one nothing in this build makes.
 * Collapsing the two into "no pay" is the mistake this enum exists to refuse: a payroll run would agree
 * with itself and an HR screen would tell somebody they are still on sick leave when they are not.
 *
 * ## Why the day is one-based and the bands are half-open in the count
 *
 * "Day 1" is the first day of the illness, which is how every medical certificate and every labour rule
 * counts. So with 15 full-pay days, day 15 is full pay and day 16 is the first half-pay day — the
 * boundary the acceptance criterion names, and the one an off-by-one produces silently: a zero-based
 * reading pays 16 days at full pay and every figure downstream still looks ordinary.
 *
 * ## Why this module holds no total
 *
 * {@link sickLeaveEntitlementDays} sums the three bands rather than storing a fourth figure. A stored
 * total is a second opinion about the same thing, and the version of that mistake which ships is a
 * total that disagrees with the bands by one day after somebody changes a band.
 *
 * Pure: three integers and a day number in, a band out. No clock, no dates, no I/O.
 */

/**
 * The pay bands, dearest first.
 *
 * The order is the order a split is reported in, so two splits of the same illness compare field by
 * field — the same reason `WORKED_MINUTE_BUCKETS` is ordered in `./rates.ts`.
 */
export const SICK_LEAVE_PAY_BANDS = ['full_pay', 'half_pay', 'unpaid', 'exhausted'] as const

export type SickLeavePayBand = (typeof SICK_LEAVE_PAY_BANDS)[number]

/**
 * The three band lengths, in whole days, from one row of `leave_entitlement_rule`.
 *
 * Whole days and not hours: sick leave is certificated by the day, and a fractional sick day is a
 * concept no certificate, no rule and no payslip in this system has.
 */
export interface SickLeaveTiers {
  /** Days paid in full, starting at day 1. */
  readonly fullPayDays: number
  /** Days paid at half, immediately after the full-pay band. */
  readonly halfPayDays: number
  /** Days of authorised unpaid sick leave, immediately after the half-pay band. */
  readonly unpaidDays: number
}

/** The longest illness this module will answer about, as a guard rather than a rule. */
const IMPLAUSIBLE_DAYS = 3660

/**
 * Refuses a tier set the band arithmetic cannot be right about.
 *
 * A second implementation of 0066's CHECKs rather than a claim that the database has already checked,
 * for the reason `assertWorkingHoursRules` gives: most tier sets the maths sees in a test were built in
 * the test, and an all-zero tier set makes every boundary assertion pass by answering `exhausted` to
 * everything.
 */
export function assertSickLeaveTiers(tiers: SickLeaveTiers): void {
  const bands: readonly (readonly [string, number])[] = [
    ['The full-pay band', tiers.fullPayDays],
    ['The half-pay band', tiers.halfPayDays],
    ['The unpaid band', tiers.unpaidDays],
  ]
  for (const [label, days] of bands) {
    if (!Number.isInteger(days) || days < 0 || days > IMPLAUSIBLE_DAYS) {
      throw new AppError(
        'validation',
        `${label} must be a whole number of days between 0 and ${IMPLAUSIBLE_DAYS}, got ${days}`,
      )
    }
  }
  if (tiers.fullPayDays + tiers.halfPayDays + tiers.unpaidDays === 0) {
    throw new AppError(
      'validation',
      'A sick-leave tier set with no days in any band is not a tier set: every day of every illness ' +
        'would answer `exhausted`, which passes any boundary test written against it while entitling ' +
        'nobody to anything. 0066 refuses the same row.',
    )
  }
}

/** The days of one illness the three bands cover between them. Summed, never stored. */
export function sickLeaveEntitlementDays(tiers: SickLeaveTiers): number {
  assertSickLeaveTiers(tiers)
  return tiers.fullPayDays + tiers.halfPayDays + tiers.unpaidDays
}

/**
 * The band a given day of one illness falls in. `dayOfIllness` is one-based.
 *
 * The bands are consecutive and exhaustive, so the answer is always one of the four and there is no
 * arithmetic that can fall between two of them. Day 0 and a fraction are **refused** rather than
 * answered: a zero-based caller is the off-by-one this module is most likely to be handed, and
 * answering it `full_pay` would make the mistake invisible for the first fifteen days.
 */
export function sickLeavePayBandOn(tiers: SickLeaveTiers, dayOfIllness: number): SickLeavePayBand {
  assertSickLeaveTiers(tiers)
  if (!Number.isInteger(dayOfIllness) || dayOfIllness < 1) {
    throw new AppError(
      'validation',
      `A day of illness is a whole number counted from 1, got ${dayOfIllness}. A zero-based caller ` +
        'would be answered full_pay for a day that does not exist, and the resulting off-by-one pays ' +
        'one day too many at every band boundary.',
    )
  }
  if (dayOfIllness <= tiers.fullPayDays) return 'full_pay'
  if (dayOfIllness <= tiers.fullPayDays + tiers.halfPayDays) return 'half_pay'
  if (dayOfIllness <= sickLeaveEntitlementDays(tiers)) return 'unpaid'
  return 'exhausted'
}

/**
 * How many days of a sick absence fall in each band, given how many days of the same illness are
 * already taken.
 *
 * `daysAlreadyTaken` is what makes this the tiered function the acceptance criterion asks for rather
 * than a lookup: an illness is certificated in instalments, and a second certificate for the same
 * illness continues the count instead of restarting it. Restarting it is the defect — it pays the first
 * fifteen days of every certificate at full pay, which for a long illness broken into three notes is
 * three times the entitlement, and every individual payslip looks correct.
 *
 * Counted day by day rather than by subtracting band boundaries. The boundary arithmetic is perhaps
 * twenty times faster and its correctness is an argument; the walk's correctness is a reading, it is
 * bounded by the entitlement plus the days asked for, and this is the same trade
 * `splitWorkedMinutes` in `./working-hours.ts` records for the same reason.
 */
export function splitSickLeaveDays(args: {
  readonly tiers: SickLeaveTiers
  readonly days: number
  readonly daysAlreadyTaken?: number
}): Readonly<Record<SickLeavePayBand, number>> {
  const { tiers, days, daysAlreadyTaken = 0 } = args
  assertSickLeaveTiers(tiers)
  if (!Number.isInteger(days) || days < 0 || days > IMPLAUSIBLE_DAYS) {
    throw new AppError(
      'validation',
      `A sick absence must be a whole number of days between 0 and ${IMPLAUSIBLE_DAYS}, got ${days}`,
    )
  }
  if (
    !Number.isInteger(daysAlreadyTaken) ||
    daysAlreadyTaken < 0 ||
    daysAlreadyTaken > IMPLAUSIBLE_DAYS
  ) {
    throw new AppError(
      'validation',
      `Days already taken of the same illness must be a whole number between 0 and ` +
        `${IMPLAUSIBLE_DAYS}, got ${daysAlreadyTaken}`,
    )
  }
  const split: Record<SickLeavePayBand, number> = {
    full_pay: 0,
    half_pay: 0,
    unpaid: 0,
    exhausted: 0,
  }
  for (let offset = 0; offset < days; offset += 1) {
    split[sickLeavePayBandOn(tiers, daysAlreadyTaken + offset + 1)] += 1
  }
  return split
}

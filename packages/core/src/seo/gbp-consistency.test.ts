import { describe, expect, it } from 'vitest'
import {
  describeGoogleProvenance,
  formatDayHours,
  type GbpConsistencyInput,
  type GbpDayHours,
  type GbpFactProvenance,
  type GbpServicePrice,
  gbpConsistencyReport,
  parseClockTime,
  parseGrossAedToFils,
} from './gbp-consistency.ts'

/**
 * The comparison, over the divergence the acceptance criterion names.
 *
 * Every figure here is an argument. The module holds no hours and no price, which is the scan in
 * `packages/fixtures/src/seo-nap-literals.test.ts`; these are the test's own inputs, which is what a test
 * is for.
 */

/** Trading as docs/13 §2 and `premises_hours` have it: daily, opening at 11, closing after midnight. */
const SITE_HOURS: readonly GbpDayHours[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  isClosed: false,
  open: { hours: 11, minutes: 0 },
  close: { hours: 2, minutes: 0 },
}))

/** The same week with the profile's closing time an hour early, which is the seeded divergence. */
const GBP_HOURS_ONE_HOUR_EARLY: readonly GbpDayHours[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  isClosed: false,
  open: { hours: 11, minutes: 0 },
  close: { hours: 1, minutes: 0 },
}))

const SITE_PRICES: readonly GbpServicePrice[] = [
  {
    serviceKey: 'swedish-massage',
    label: 'Swedish massage',
    durationMinutes: 60,
    grossFils: 35_000,
  },
  {
    serviceKey: 'hot-oil-massage',
    label: 'Hot oil massage',
    durationMinutes: 90,
    grossFils: 45_000,
  },
]

/** One service 50 AED cheaper on the profile. 50 AED is 5,000 fils (ADR 0007). */
const GBP_PRICES: readonly GbpServicePrice[] = [
  {
    serviceKey: 'swedish-massage',
    label: 'Swedish massage',
    durationMinutes: 60,
    grossFils: 30_000,
  },
  {
    serviceKey: 'hot-oil-massage',
    label: 'Hot oil massage',
    durationMinutes: 90,
    grossFils: 45_000,
  },
]

const SNAPSHOT: Extract<GbpFactProvenance, { side: 'google' }> = {
  side: 'google',
  authority: 'manual_snapshot',
  claimedBy: 'staff/BR-0001',
  claimedAtIso: '2026-10-02T06:00:00.000Z',
}

const API: Extract<GbpFactProvenance, { side: 'google' }> = {
  side: 'google',
  authority: 'business_information_v1',
}

const inputWith = (
  provenance: Extract<GbpFactProvenance, { side: 'google' }>,
): GbpConsistencyInput => ({
  website: { hours: SITE_HOURS, prices: SITE_PRICES },
  google: { provenance, hours: GBP_HOURS_ONE_HOUR_EARLY, prices: GBP_PRICES },
})

describe('the GBP-versus-website comparison', () => {
  it('reports exactly two findings for a whole-week hours divergence plus one price', () => {
    const report = gbpConsistencyReport(inputWith(SNAPSHOT))
    expect(report.findings).toHaveLength(2)
    expect(report.findings.map((finding) => finding.rule)).toEqual([
      'opening_hours_disagree',
      'service_price_disagrees',
    ])
    // Seven days disagreeing in the same way is ONE finding covering all of them. Without this the
    // report is eight rows for two problems, which is the cry-wolf shape ADR 0085 names.
    expect(report.findings[0]?.subject).toBe('every day')
    expect(report.coverage.daysCompared).toBe(7)
    expect(report.coverage.pricesCompared).toBe(2)
  })

  it('quotes both values and names which source each came from', () => {
    const [hours, price] = gbpConsistencyReport(inputWith(SNAPSHOT)).findings
    expect(hours?.website.value).toBe('11:00-02:00 (the next day)')
    expect(hours?.google.value).toBe('11:00-01:00 (the next day)')
    expect(hours?.website.provenance).toEqual({
      side: 'website',
      authority: 'premises_hours_row',
    })
    expect(hours?.google.provenance).toEqual(SNAPSHOT)
    expect(price?.website.value).toContain('350.00')
    expect(price?.google.value).toContain('300.00')
    expect(price?.website.value).toContain('AED')
    expect(price?.website.provenance).toEqual({ side: 'website', authority: 'price_in_force' })
    expect(price?.subject).toBe('Swedish massage (60 minutes)')
  })

  it('reports nothing when the two sides agree, which is the control', () => {
    // Without this, "two findings" is satisfied by a comparison that reports two findings about anything.
    const report = gbpConsistencyReport({
      website: { hours: SITE_HOURS, prices: SITE_PRICES },
      google: { provenance: API, hours: SITE_HOURS, prices: SITE_PRICES },
    })
    expect(report.findings).toEqual([])
    expect(report.coverage.daysCompared).toBe(7)
  })

  it('groups two different mistakes as two findings, not one', () => {
    const mixed: readonly GbpDayHours[] = GBP_HOURS_ONE_HOUR_EARLY.map((day, index) =>
      index < 2 ? day : { dayOfWeek: day.dayOfWeek, isClosed: true },
    )
    const report = gbpConsistencyReport({
      website: { hours: SITE_HOURS, prices: SITE_PRICES },
      google: { provenance: API, hours: mixed, prices: SITE_PRICES },
    })
    const hours = report.findings.filter((finding) => finding.rule === 'opening_hours_disagree')
    expect(hours).toHaveLength(2)
    expect(hours.map((finding) => finding.subject)).toEqual([
      'Sunday, Monday',
      'Tuesday, Wednesday, Thursday, Friday, Saturday',
    ])
    expect(hours[1]?.google.value).toBe('closed')
  })

  it('does not compare a day or a price only one side holds: it reports it as coverage', () => {
    const report = gbpConsistencyReport({
      website: { hours: SITE_HOURS, prices: SITE_PRICES },
      google: {
        provenance: API,
        hours: SITE_HOURS.slice(0, 5),
        prices: [SITE_PRICES[0] as GbpServicePrice],
      },
    })
    expect(report.findings).toEqual([])
    expect(report.coverage.daysCompared).toBe(5)
    expect(report.coverage.daysOnlyOnOneSide).toEqual(['Friday', 'Saturday'])
    expect(report.coverage.pricesOnlyOnOneSide).toEqual(['hot-oil-massage@90'])
  })

  it('says a manual snapshot is a claim and an API read is an observation', () => {
    const claimed = describeGoogleProvenance(SNAPSHOT)
    expect(claimed).toContain('staff/BR-0001')
    expect(claimed).toContain('2026-10-02T06:00:00.000Z')
    expect(claimed).toContain('rather than an observation')
    // The control: the API arm must NOT carry the hedge, or the distinction is cosmetic.
    expect(describeGoogleProvenance(API)).not.toContain('rather than an observation')
    expect(describeGoogleProvenance(API)).toContain('read from the Business Profile API')
  })

  it('refuses a time of day it cannot read rather than comparing it as midnight', () => {
    expect(parseClockTime('11:00')).toEqual({ hours: 11, minutes: 0 })
    expect(parseClockTime('02:00:00')).toEqual({ hours: 2, minutes: 0 })
    expect(() => parseClockTime('11pm')).toThrow('is not a time of day')
    expect(() => parseClockTime('25:00')).toThrow('is not a time of day')
    expect(() => parseClockTime('')).toThrow('is not a time of day')
  })

  it('refuses an amount it cannot read exactly rather than manufacturing a divergence', () => {
    expect(parseGrossAedToFils('350')).toBe(35_000)
    expect(parseGrossAedToFils(' 349.50 ')).toBe(34_950)
    expect(parseGrossAedToFils('0')).toBe(0)
    for (const bad of ['AED 350', '1,350', '350.', '350.5', '350.555', '-350', '', 'three fifty']) {
      expect(() => parseGrossAedToFils(bad), bad).toThrow('is not an amount in AED')
    }
  })

  it('makes the midnight crossing visible, because the pair reads backwards without it', () => {
    expect(
      formatDayHours({
        dayOfWeek: 0,
        isClosed: false,
        open: { hours: 11, minutes: 0 },
        close: { hours: 2, minutes: 0 },
      }),
    ).toBe('11:00-02:00 (the next day)')
    expect(
      formatDayHours({
        dayOfWeek: 0,
        isClosed: false,
        open: { hours: 11, minutes: 0 },
        close: { hours: 23, minutes: 30 },
      }),
    ).toBe('11:00-23:30')
  })
})

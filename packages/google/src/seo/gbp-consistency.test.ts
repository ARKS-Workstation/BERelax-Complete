import type { PremisesFacts } from '@berelax/db'
import { GBP_REGULAR_PERIODS, type GbpBusinessPeriod } from '@berelax/providers/google'
import { describe, expect, it } from 'vitest'
import {
  googleHoursFrom,
  manualSnapshotForm,
  snapshotPricesFrom,
  websiteHoursFrom,
  websitePricesFrom,
} from './gbp-consistency.ts'

/**
 * The conversions, which are where this unit would be wrong without anybody noticing.
 *
 * The day mapping is the one worth a test of its own: `premises_hours.day_of_week` is 0 for **Sunday**
 * and the API's periods are named days. An off-by-one would compare Monday's profile hours against
 * Sunday's premises hours, report seven findings about a week that agrees, and look exactly like a real
 * divergence. The `.itest.ts` beside this file drives the same code against the real rows.
 */

/** Only the fields the conversions read. A whole `PremisesFacts` here would be a second seed. */
const factsWith = (hours: PremisesFacts['hours'], prices: PremisesFacts['prices']): PremisesFacts =>
  ({
    premises: {},
    legal: null,
    hours,
    exceptions: [],
    prices,
    onRequest: [],
  }) as unknown as PremisesFacts

const TRADING_ROW = {
  openTime: '11:00:00',
  closeTime: '02:00:00',
  crossesMidnight: true,
  isClosed: false,
}

describe('the GBP consistency conversions', () => {
  it('maps a named API day onto premises_hours.day_of_week, where 0 is Sunday', () => {
    const sundayOnly: readonly GbpBusinessPeriod[] = [
      {
        openDay: 'SUNDAY',
        openTime: { hours: 11, minutes: 0 },
        closeDay: 'MONDAY',
        closeTime: { hours: 2, minutes: 0 },
      },
    ]
    const week = googleHoursFrom(sundayOnly, [0, 1])
    expect(week[0]).toEqual({
      dayOfWeek: 0,
      isClosed: false,
      open: { hours: 11, minutes: 0 },
      close: { hours: 2, minutes: 0 },
    })
    // A day the profile has no period for is a day it is closed, not a day with no opinion.
    expect(week[1]).toEqual({ dayOfWeek: 1, isClosed: true })
  })

  it('reports only the days it was asked about, so the two sides line up', () => {
    expect(googleHoursFrom(GBP_REGULAR_PERIODS, [0, 1, 2])).toHaveLength(3)
    expect(googleHoursFrom(GBP_REGULAR_PERIODS, [])).toEqual([])
  })

  it('drops the times from a closed day rather than comparing them', () => {
    // `premises_hours` holds an open and a close even when `is_closed` is true, and a comparison that
    // read them would report a divergence about a day nobody is open on.
    const week = websiteHoursFrom(factsWith([{ dayOfWeek: 3, ...TRADING_ROW, isClosed: true }], []))
    expect(week).toEqual([{ dayOfWeek: 3, isClosed: true }])
  })

  it('reads the price in force through the stored-digits reader, not through Number()', () => {
    const prices = websitePricesFrom(
      factsWith(
        [],
        [
          {
            style: 'swedish',
            treatmentKey: 'swedish',
            slug: 'swedish-massage',
            publicDisplayName: 'Swedish massage',
            durationMinutes: 60,
            grossPriceFils: '35000',
          },
        ],
      ),
    )
    expect(prices).toEqual([
      {
        serviceKey: 'swedish-massage',
        label: 'Swedish massage',
        durationMinutes: 60,
        grossFils: 35_000,
      },
    ])
    // A column reformatted on the way here is refused rather than rounded (ADR 0007).
    expect(() =>
      websitePricesFrom(
        factsWith(
          [],
          [
            {
              style: 'swedish',
              treatmentKey: 'swedish',
              slug: 'swedish-massage',
              publicDisplayName: 'Swedish massage',
              durationMinutes: 60,
              grossPriceFils: '3.5e4',
            },
          ],
        ),
      ),
    ).toThrow('does not survive a round trip')
  })

  it('refuses a snapshot of a price point the site does not publish', () => {
    const website = websitePricesFrom(
      factsWith(
        [],
        [
          {
            style: 'swedish',
            treatmentKey: 'swedish',
            slug: 'swedish-massage',
            publicDisplayName: 'Swedish massage',
            durationMinutes: 60,
            grossPriceFils: '35000',
          },
        ],
      ),
    )
    expect(
      snapshotPricesFrom(
        {
          claimedBy: 'staff/BR-0001',
          claimedAtIso: '2026-10-02T06:00:00.000Z',
          days: [],
          prices: [{ serviceKey: 'swedish-massage', durationMinutes: 60, grossAedText: '300' }],
        },
        website,
      ),
    ).toEqual([
      {
        serviceKey: 'swedish-massage',
        label: 'Swedish massage',
        durationMinutes: 60,
        grossFils: 30_000,
      },
    ])
    expect(() =>
      snapshotPricesFrom(
        {
          claimedBy: 'staff/BR-0001',
          claimedAtIso: '2026-10-02T06:00:00.000Z',
          days: [],
          prices: [{ serviceKey: 'not-on-the-menu', durationMinutes: 60, grossAedText: '300' }],
        },
        website,
      ),
    ).toThrow('not a published price point')
  })

  it('builds the form from the facts and carries no value from the website side', () => {
    const facts = factsWith(
      [{ dayOfWeek: 0, ...TRADING_ROW }],
      [
        {
          style: 'swedish',
          treatmentKey: 'swedish',
          slug: 'swedish-massage',
          publicDisplayName: 'Swedish massage',
          durationMinutes: 60,
          grossPriceFils: '35000',
        },
      ],
    )
    const form = manualSnapshotForm(facts, 'because the API is not available')
    expect(form.fields.map((field) => field.name)).toEqual([
      'open-0',
      'close-0',
      'closed-0',
      'price-swedish-massage-60',
    ])
    const rendered = JSON.stringify(form)
    // A pre-filled Google column is answered by pressing Enter, and the check then reports "consistent"
    // about a profile nobody looked at.
    expect(rendered).not.toContain('11:00')
    expect(rendered).not.toContain('350')
    expect(rendered).not.toContain('35000')
  })
})

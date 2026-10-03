import { FUNNEL_STAGES, FUNNEL_TERMINAL_STAGE } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  conversionRateOf,
  EMPTY_FUNNEL_COUNTS,
  type FunnelCountRow,
  funnelCountsFrom,
  funnelOrderViolations,
  showAdjustedConversionOf,
} from './funnel-counts.ts'

const row = (
  stage: FunnelCountRow['stage'],
  entered: number,
  excluded = 0,
  gapEntered = 0,
): FunnelCountRow => ({ stage, entered, excluded, gapEntered })

/** 100 landings down to 10 paid, with 5 of the 20 confirmed bookings no-showing. */
const JOURNEY: readonly FunnelCountRow[] = [
  row('landing', 100),
  row('service_viewed', 70),
  row('price_viewed', 50),
  row('cta_click', 30),
  row('booking_created', 22),
  row('confirmed', 20, 5),
  row('attended', 15),
  row('paid', 10),
]

describe('the empty counts', () => {
  it('hold every stage of the taxonomy, derived rather than written out', () => {
    expect(Object.keys(EMPTY_FUNNEL_COUNTS).sort()).toEqual([...FUNNEL_STAGES].sort())
    for (const stage of FUNNEL_STAGES) {
      expect(EMPTY_FUNNEL_COUNTS[stage]).toEqual({ entered: 0, excluded: 0, gapEntered: 0 })
    }
  })
})

describe('folding the rows a query returned', () => {
  it('TOTALS rows for one stage rather than overwriting them', () => {
    // The read is grouped by origination as well as by stage, so one stage arrives several times. A fold
    // that assigned would answer with whichever tuple sorted last — a number that looks right and is a
    // fraction of the truth.
    const counts = funnelCountsFrom([
      row('landing', 40, 0, 7),
      row('landing', 60, 0, 3),
      row('paid', 4),
      row('paid', 6),
    ])
    expect(counts['landing']).toEqual({ entered: 100, excluded: 0, gapEntered: 10 })
    expect(counts['paid'].entered).toBe(10)
    // And a stage no row mentioned is zero rather than absent.
    expect(counts['attended']).toEqual({ entered: 0, excluded: 0, gapEntered: 0 })
  })
})

describe('conversion', () => {
  it('is paid over landing', () => {
    const conversion = conversionRateOf(funnelCountsFrom(JOURNEY))
    expect(conversion.kind).toBe('rate')
    if (conversion.kind !== 'rate') throw new Error('unreachable')
    expect(conversion.numerator).toBe(10)
    expect(conversion.denominator).toBe(100)
    expect(conversion.perMille).toBe(100)
  })

  it('is NEVER booking_created over landing — there is no parameter for it', () => {
    // The control. `booking_created` is 22 of 100, which is 220 per mille: more than twice the real
    // figure, and the one every advertising platform's own dashboard will show the business. If this
    // module could be asked for it, somebody eventually would.
    const conversion = conversionRateOf(funnelCountsFrom(JOURNEY))
    if (conversion.kind !== 'rate') throw new Error('unreachable')
    expect(conversion.perMille).not.toBe(220)
    // And the numerator is derived from the taxonomy rather than written here, so a ninth stage moves it.
    expect(FUNNEL_TERMINAL_STAGE).toBe('paid')
    expect(conversion.numerator).toBe(funnelCountsFrom(JOURNEY)['paid'].entered)
    // One argument, so there is nothing to pass a stage through.
    expect(conversionRateOf.length).toBe(1)
  })

  it('has no figure at all for a window with no landing', () => {
    const conversion = conversionRateOf(funnelCountsFrom([row('paid', 3)]))
    expect(conversion.kind).toBe('no_denominator')
    if (conversion.kind !== 'no_denominator') throw new Error('unreachable')
    expect(conversion.why).toContain('no session landed')
  })
})

describe('the show-adjusted conversion', () => {
  it('excludes a no-show from the denominator and from the numerator', () => {
    const counts = funnelCountsFrom(JOURNEY)
    const adjusted = showAdjustedConversionOf(counts)
    if (adjusted.kind !== 'rate') throw new Error('unreachable')
    // 20 confirmed, 5 of them no-shows, so 15 turned up; 10 paid. Three assertions on one fixture: the
    // no-shows are in `confirmed.entered`, they are in `confirmed.excluded`, and they are in neither
    // side of this rate.
    expect(counts['confirmed'].entered).toBe(20)
    expect(counts['confirmed'].excluded).toBe(5)
    expect(adjusted.denominator).toBe(15)
    expect(adjusted.numerator).toBe(10)
    expect(adjusted.perMille).toBe(667)
    // The control that makes the subtraction load-bearing: the unadjusted figure over `confirmed` would
    // be 10/20, and a reader shown that would conclude half the diary does not pay.
    expect(adjusted.perMille).not.toBe(500)
  })

  it('and the no-show contributes to confirmed but to neither attended nor paid', () => {
    // The other half of the same acceptance line, over counts that hold nothing else: one booking,
    // confirmed, no-showed.
    const counts = funnelCountsFrom([
      row('landing', 1),
      row('booking_created', 1),
      row('confirmed', 1, 1),
    ])
    expect(counts['confirmed'].entered).toBe(1)
    expect(counts['attended'].entered).toBe(0)
    expect(counts['paid'].entered).toBe(0)
    const adjusted = showAdjustedConversionOf(counts)
    expect(adjusted.kind).toBe('no_denominator')
    if (adjusted.kind !== 'no_denominator') throw new Error('unreachable')
    expect(adjusted.why).toContain('no-shows')
    // And the plain conversion is a real zero over a real denominator, which is a different statement
    // from "no figure": one session landed and did not pay.
    const conversion = conversionRateOf(counts)
    if (conversion.kind !== 'rate') throw new Error('unreachable')
    expect(conversion.perMille).toBe(0)
  })
})

describe('the funnel order', () => {
  it('reports a bucket larger than the one before it rather than refusing it', () => {
    expect(funnelOrderViolations(funnelCountsFrom(JOURNEY))).toEqual([])
    // The case this build expects: `landing` counts only CONSENTED sessions, and a pre-consent visit
    // contributes to no session at all (ADR 0066), so the second bucket can legitimately exceed the
    // first. Reported, not refused, because A-FIRST-10 renders it as data quality and not as drop-off.
    const violations = funnelOrderViolations(
      funnelCountsFrom([row('landing', 10), row('service_viewed', 12)]),
    )
    expect(violations).toEqual([{ stage: 'service_viewed', previous: 'landing' }])
  })
})

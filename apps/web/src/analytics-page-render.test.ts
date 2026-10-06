import { filsFrom, money } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { headlineValue } from '../app/(admin)/analytics/panels/panel.ts'
import {
  ANALYTICS_PANEL_IDS,
  type AnalyticsPageData,
  type DataQualityPanel,
  headlineCount,
  type PanelHeadline,
  type TimeOfDayPanel,
} from '../app/(admin)/analytics/queries.ts'
import { type AnalyticsPageView, renderAnalyticsPageHtml } from '../app/(admin)/analytics/render.ts'
import {
  GOOGLE_REAUTH_BANNER_ATTRIBUTE,
  renderAdminBanner,
} from './components/admin/google-reauth-banner.ts'
import { MESSAGES_DELAYED_BANNER_ATTRIBUTE } from './components/admin/messages-delayed-banner.ts'

/**
 * The /analytics document's bytes (A-FIRST-10). Pure: a view in, a document out, no database.
 *
 * ## What this file proves and what it deliberately leaves to the itest
 *
 * Here: the nine panels are the nine the spine declares, the headline attribute carries the figure the
 * panel's own type says it has, the time-of-day chart prints the buckets in the order it was GIVEN, a
 * share with no denominator reads "no data" and a share that genuinely is nought reads 0.0%, and both
 * admin banners are emitted.
 *
 * In `analytics-page.itest.ts`: that the numbers are the right numbers — each panel's query run
 * independently and compared against the attribute — and that the ORDER of the hourly buckets is the
 * trading window's rather than the calendar's. That split is deliberate: this file cannot assert the
 * bucket order is correct, because the order is the query's and a renderer that preserved a wrong order
 * faithfully would pass here. What it CAN assert is that the renderer does not introduce one, which is
 * the half that would otherwise be nobody's.
 *
 * ## The control every positive case here rests on
 *
 * `ANALYTICS_PANEL_IDS.length` is asserted to be nine. Without that, "every id in the spine renders a
 * panel" is satisfied by a spine with one entry in it, which is the vacuous pass ADR 0003 is about.
 */

const DATE = '2026-10-15'

/** A `no_data` headline, which is the state most of these fixtures want. */
const noData = (why: string): PanelHeadline => ({ kind: 'no_data', why })

/**
 * Fifteen buckets in TRADING order, 11:00 through 01:00.
 *
 * Written out rather than generated, which is the one duplication this file permits and for the reason
 * `taxonomy.test.ts` gives about its own lists: it is what makes a change to the window show up in a
 * review as changed lines. The sequence crosses midnight in the middle, which is the whole subject.
 */
const TRADING_HOURS = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1] as const

const timeOfDay = (hours: readonly number[] = TRADING_HOURS): TimeOfDayPanel => ({
  buckets: hours.map((hour, index) => ({ hour, sessions: index + 1, paid: index % 3 })),
  opensAtHour: 11,
  closesAtHour: 2,
  headline: headlineCount(hours.length, 'hourly buckets'),
})

const dataQuality = (overrides: Partial<DataQualityPanel> = {}): DataQualityPanel => {
  const botFiltered: PanelHeadline = {
    kind: 'rate',
    numerator: 24,
    denominator: 1031,
    perMille: 23,
  }
  return {
    botFiltered,
    refCapture: { kind: 'rate', numerator: 7, denominator: 19, perMille: 368 },
    gapSessions: 4,
    preConsentLandings: 61n,
    headline: botFiltered,
    ...overrides,
  }
}

function pageData(overrides: Partial<AnalyticsPageData> = {}): AnalyticsPageData {
  return {
    tradingDate: DATE,
    funnel: {
      rows: [
        { stage: 'landing', entered: 100, excluded: 0, gapEntered: 4, droppedFromPrevious: null },
        {
          stage: 'service_viewed',
          entered: 60,
          excluded: 0,
          gapEntered: 2,
          droppedFromPrevious: 40,
        },
        { stage: 'price_viewed', entered: 40, excluded: 0, gapEntered: 1, droppedFromPrevious: 20 },
        { stage: 'cta_click', entered: 20, excluded: 0, gapEntered: 0, droppedFromPrevious: 20 },
        {
          stage: 'booking_created',
          entered: 10,
          excluded: 0,
          gapEntered: 0,
          droppedFromPrevious: 10,
        },
        { stage: 'confirmed', entered: 9, excluded: 2, gapEntered: 0, droppedFromPrevious: 1 },
        { stage: 'attended', entered: 7, excluded: 0, gapEntered: 0, droppedFromPrevious: 2 },
        { stage: 'paid', entered: 6, excluded: 0, gapEntered: 0, droppedFromPrevious: 1 },
      ],
      conversion: { kind: 'rate', numerator: 6, denominator: 100, perMille: 60 },
      showAdjusted: { kind: 'rate', numerator: 6, denominator: 7, perMille: 857 },
      orderViolations: [],
      headline: { kind: 'rate', numerator: 6, denominator: 100, perMille: 60 },
    },
    origination: {
      rows: [
        { source: 'google', medium: 'organic', campaign: '', sessions: 70, paid: 4 },
        { source: 'instagram', medium: 'social', campaign: 'ramadan', sessions: 30, paid: 2 },
        // A tuple with a conversion and no sessions: the full outer join's reason for being.
        { source: 'tiktok', medium: 'social', campaign: '', sessions: 0, paid: 1 },
      ],
      headline: headlineCount(3, 'origination tuples'),
    },
    landingPages: {
      rows: [{ path: '/treatments/deep-tissue', sessions: 55, paid: 3 }],
      headline: headlineCount(1, 'landing pages'),
    },
    interactions: {
      rows: [{ eventName: 'cta_click', path: '/book', events: 31, sessions: 18 }],
      headline: headlineCount(31, 'interactions'),
    },
    devices: {
      rows: [{ segment: 'mobile', sessions: 80, paid: 5 }],
      headline: headlineCount(1, 'kinds'),
    },
    breakpoints: {
      rows: [{ segment: 'sm', sessions: 80, paid: 5 }],
      headline: headlineCount(1, 'kinds'),
    },
    timeOfDay: timeOfDay(),
    sourceRevenue: {
      rows: [
        {
          source: 'google',
          medium: 'organic',
          campaign: '',
          paidInvoices: 3,
          gross: money(filsFrom(52_500)),
          net: money(filsFrom(50_000)),
          vat: money(filsFrom(2_500)),
        },
      ],
      headline: headlineCount(1, 'sources with revenue'),
    },
    dataQuality: dataQuality(),
    ...overrides,
  }
}

const view = (overrides: Partial<AnalyticsPageView> = {}): AnalyticsPageView => ({
  chrome: {
    googleReauth: null,
    sendBacklog: null,
    role: 'owner' as const,
    returnTo: `/analytics?date=${DATE}`,
  },
  data: pageData(),
  direction: 'ltr',
  ...overrides,
})

/** Every `data-panel` value, in document order. The spine's claim, read off the bytes. */
function panelIdsIn(html: string): string[] {
  return [...html.matchAll(/data-panel="([a-z-]+)"/g)].map((match) => match[1] ?? '')
}

/** One panel's `data-headline`, or null when the attribute is absent. */
function headlineAttribute(html: string, id: string): string | null {
  const section = html.slice(html.indexOf(`data-panel="${id}"`))
  const end = section.indexOf('</section>')
  const scoped = section.slice(0, end === -1 ? undefined : end)
  return /data-headline="(-?\d+)"/.exec(scoped)?.[1] ?? null
}

describe('the nine panels are the nine the spine declares', () => {
  it('declares nine, which is the control for every case below', () => {
    expect(ANALYTICS_PANEL_IDS).toHaveLength(9)
    expect(new Set(ANALYTICS_PANEL_IDS).size).toBe(9)
  })

  it('renders one section per id, in the spine order and no others', () => {
    expect(panelIdsIn(renderAnalyticsPageHtml(view()))).toEqual([...ANALYTICS_PANEL_IDS])
  })

  it('gives every panel a labelled region, which is what keeps nine sections out of axe', () => {
    const html = renderAnalyticsPageHtml(view())
    for (const id of ANALYTICS_PANEL_IDS) {
      expect(html, id).toContain(`aria-labelledby="panel-${id}-heading"`)
      expect(html, id).toContain(`<h2 id="panel-${id}-heading">`)
    }
  })
})

describe('the headline attribute carries the figure and nothing else', () => {
  it('prints the per-mille rate for a rate and the count for a count', () => {
    const html = renderAnalyticsPageHtml(view())
    const data = pageData()
    // Programmatic rather than written out: the expected value comes from the same function the
    // renderer uses, so a change to either side cannot pass by agreeing with a literal in this file.
    expect(headlineAttribute(html, 'funnel')).toBe(String(headlineValue(data.funnel.headline)))
    expect(headlineAttribute(html, 'origination')).toBe(
      String(headlineValue(data.origination.headline)),
    )
    expect(headlineAttribute(html, 'interactions')).toBe(
      String(headlineValue(data.interactions.headline)),
    )
    expect(headlineValue(data.funnel.headline)).toBe(60)
  })

  it('omits the attribute entirely for a panel with no figure', () => {
    const html = renderAnalyticsPageHtml(
      view({
        data: pageData({
          interactions: { rows: [], headline: noData('nothing was collected') },
        }),
      }),
    )
    expect(headlineAttribute(html, 'interactions')).toBeNull()
    expect(html).toContain('data-headline-state="no-data"')
    // The reason is rendered, because a reader looking at a gap needs the reason and not the gap.
    expect(html).toContain('nothing was collected')
  })

  it('renders an em dash and never 0% for a row with no denominator', () => {
    // The tiktok tuple in the fixture has a conversion and no sessions: the full outer join's reason for
    // being, and the one row on the page whose share has nothing to be a share of. `0%` there would say
    // it converted nobody, which is the opposite of what the row says.
    const html = renderAnalyticsPageHtml(view())
    const row = html.slice(html.indexOf('data-origination="tiktok/social/"'))
    const cells = [...row.slice(0, row.indexOf('</tr>')).matchAll(/<td class="num">([^<]*)<\/td>/g)]
    expect(cells.at(-1)?.[1]).toBe('—')
    // And the control: a row that HAS a denominator prints the percentage.
    const google = html.slice(html.indexOf('data-origination="google/organic/"'))
    const googleCells = [
      ...google.slice(0, google.indexOf('</tr>')).matchAll(/<td class="num">([^<]*)<\/td>/g),
    ]
    expect(googleCells.at(-1)?.[1]).toBe('5.7%')
  })

  it('renders a genuine nought as 0.0% and not as no data, which is the control', () => {
    // Without this, "no data instead of 0%" is satisfied by a page that cannot show a zero at all — and
    // nought paid conversions on a day with four hundred landings is a real and alarming figure.
    const html = renderAnalyticsPageHtml(
      view({
        data: pageData({
          funnel: {
            ...pageData().funnel,
            headline: { kind: 'rate', numerator: 0, denominator: 400, perMille: 0 },
          },
        }),
      }),
    )
    expect(headlineAttribute(html, 'funnel')).toBe('0')
    expect(html).toContain('0.0% — 0 of 400')
  })
})

describe('the time-of-day chart', () => {
  it('renders fifteen buckets, contiguous, in the order it was given', () => {
    const html = renderAnalyticsPageHtml(view())
    const hours = [...html.matchAll(/data-bucket-index="(\d+)" data-hour="(\d+)"/g)].map(
      (match) => [Number(match[1]), Number(match[2])] as const,
    )
    expect(hours).toHaveLength(15)
    expect(hours.map(([index]) => index)).toEqual([...Array(15).keys()])
    expect(hours.map(([, hour]) => hour)).toEqual([...TRADING_HOURS])
  })

  it('holds no bucket for an hour the premises is shut', () => {
    const html = renderAnalyticsPageHtml(view())
    for (const shut of [3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(html, `an hour the premises is shut has a bucket: ${shut}`).not.toContain(
        `data-hour="${shut}"`,
      )
    }
  })

  it('crosses midnight with no gap: 23:00 is followed immediately by 00:00 and then 01:00', () => {
    const html = renderAnalyticsPageHtml(view())
    const hours = [...html.matchAll(/data-hour="(\d+)"/g)].map((match) => Number(match[1]))
    const midnight = hours.indexOf(0)
    expect(hours[midnight - 1]).toBe(23)
    expect(hours[midnight + 1]).toBe(1)
    expect(midnight).toBe(13)
  })

  it('does not re-sort what it is given, which is the claim this file can make', () => {
    /*
      The renderer's only job here is to preserve the sequence, so a chart in the wrong order is the
      QUERY's defect and the itest is where that is caught. This case is what says the renderer does not
      introduce one.

      The input is REVERSED trading order, which is neither sorted nor the real order. The first version
      of this case handed it the calendar order — and the calendar order is already ascending, so a
      renderer that sorted produced exactly the expected array and the case passed. Gate 192a caught it:
      the mutation that inserts a `toSorted` was rejected by two other cases in this file and not by the
      one written for it.
    */
    const unsorted = [...TRADING_HOURS].toReversed()
    expect(unsorted).not.toEqual([...unsorted].toSorted((a, b) => a - b))
    const html = renderAnalyticsPageHtml(
      view({ data: pageData({ timeOfDay: timeOfDay(unsorted) }) }),
    )
    const hours = [...html.matchAll(/data-hour="(\d+)"/g)].map((match) => Number(match[1]))
    expect(hours).toEqual(unsorted)
  })
})

describe('the data-quality strip', () => {
  it('shows both integers behind each share', () => {
    const html = renderAnalyticsPageHtml(view())
    expect(html).toContain('data-figure="bot-filtered"')
    expect(html).toContain('data-numerator="24" data-denominator="1031" data-per-mille="23"')
    expect(html).toContain('2.3% — 24 of 1,031')
    expect(html).toContain('data-figure="ref-capture"')
    expect(html).toContain('data-numerator="7" data-denominator="19" data-per-mille="368"')
  })

  it("reads 'no data' rather than 0% when no ref code was issued", () => {
    const html = renderAnalyticsPageHtml(
      view({
        data: pageData({
          dataQuality: dataQuality({
            refCapture: noData('no ref code was issued on this trading date'),
          }),
        }),
      }),
    )
    const strip = html.slice(html.indexOf('data-figure="ref-capture"'))
    const figure = strip.slice(0, strip.indexOf('</div>'))
    expect(figure).toContain('data-figure-state="no-data"')
    expect(figure).toContain('no data')
    expect(figure).not.toContain('0.0%')
    expect(figure).not.toContain('data-per-mille')
  })

  it('carries the two populations no panel above can show', () => {
    const html = renderAnalyticsPageHtml(view())
    expect(html).toContain('data-figure="gap-sessions" data-sessions="4"')
    expect(html).toContain('data-figure="pre-consent-landings" data-landings="61"')
  })
})

describe('the funnel panel', () => {
  it('leaves the first stage drop-off empty rather than nought', () => {
    const html = renderAnalyticsPageHtml(view())
    const landing = html.slice(html.indexOf('data-stage="landing"'))
    const row = landing.slice(0, landing.indexOf('</tr>'))
    // The LAST cell, which is the drop-off column. The first version of this case asserted the row
    // contained no `>0<` anywhere, which failed on the legitimate nought in the excluded column — a
    // zero that IS a figure. The claim is about one cell, so the assertion has to be about one cell.
    const cells = [...row.matchAll(/<td class="num">([^<]*)<\/td>/g)].map((match) => match[1])
    expect(cells.at(-1)).toBe('—')
    // And the control: a stage that HAS a drop-off prints the number rather than the dash.
    const second = html.slice(html.indexOf('data-stage="service_viewed"'))
    const secondCells = [
      ...second.slice(0, second.indexOf('</tr>')).matchAll(/<td class="num">([^<]*)<\/td>/g),
    ].map((match) => match[1])
    expect(secondCells.at(-1)).toBe('40')
  })

  it('prints a negative drop-off as a negative number and explains it', () => {
    // `landing` counts only consented sessions, so a later stage legitimately exceeding an earlier one
    // is a measurement artefact to be explained rather than clamped (ADR 0066).
    const base = pageData()
    const html = renderAnalyticsPageHtml(
      view({
        data: pageData({
          funnel: {
            ...base.funnel,
            rows: base.funnel.rows.map((row) =>
              row.stage === 'service_viewed'
                ? { ...row, entered: 120, droppedFromPrevious: -20 }
                : row,
            ),
            orderViolations: [{ stage: 'service_viewed', previous: 'landing' }],
          },
        }),
      }),
    )
    expect(html).toContain('-20')
    expect(html).toContain('data-order-violations="1"')
    expect(html).toContain('service_viewed exceeds landing')
  })

  it('shows the show-adjusted rate beside the headline, because one number cannot say both', () => {
    expect(renderAnalyticsPageHtml(view())).toContain('85.7% (6 of 7 kept confirmations)')
  })
})

describe('the document', () => {
  it('emits both admin banners inside <main>, which is what the walk refuses to be without', () => {
    const chrome: AnalyticsPageView['chrome'] = {
      googleReauth: {
        state: 'broken',
        headline: 'Needs re-authorising',
        detail: 'The grant has expired.',
        dismissible: false,
        connectionId: 'connection-1',
        googleEmail: null,
      },
      sendBacklog: { queued: 31, threshold: 20 },
      role: 'owner' as const,
      returnTo: `/analytics?date=${DATE}`,
    }
    const html = renderAnalyticsPageHtml(view({ chrome }))
    expect(html).toContain(`${GOOGLE_REAUTH_BANNER_ATTRIBUTE}="broken"`)
    expect(html).toContain(`${MESSAGES_DELAYED_BANNER_ATTRIBUTE}="31"`)
    // Inside the landmark: a region outside every landmark is reachable only through "all content".
    expect(html.indexOf('<main>')).toBeLessThan(html.indexOf(GOOGLE_REAUTH_BANNER_ATTRIBUTE))
    // And the one call emits exactly what the shared renderer emits, so this document cannot drift from
    // the other nine.
    expect(html).toContain(renderAdminBanner(chrome))
  })

  it('states noindex in the document as well as on the response', () => {
    expect(renderAnalyticsPageHtml(view())).toContain(
      '<meta name="robots" content="noindex, nofollow, noarchive">',
    )
  })

  it('mirrors the layout for the RTL cell of the capture matrix and keeps lang="en"', () => {
    const rtl = renderAnalyticsPageHtml(view({ direction: 'rtl' }))
    expect(rtl).toContain('<html lang="en" dir="rtl">')
    expect(renderAnalyticsPageHtml(view())).toContain('<html lang="en" dir="ltr">')
  })

  it('names the trading date in the heading and in an attribute', () => {
    const html = renderAnalyticsPageHtml(view())
    expect(html).toContain(`data-trading-date="${DATE}"`)
    expect(html).toContain(`trading date ${DATE}`)
  })

  it('escapes what a dimension carries, because a campaign name is somebody else’s string', () => {
    const base = pageData()
    const html = renderAnalyticsPageHtml(
      view({
        data: pageData({
          origination: {
            ...base.origination,
            rows: [
              {
                source: '<img src=x onerror=alert(1)>',
                medium: 'social',
                campaign: '"><script>alert(1)</script>',
                sessions: 3,
                paid: 0,
              },
            ],
          },
        }),
      }),
    )
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;img')
  })
})

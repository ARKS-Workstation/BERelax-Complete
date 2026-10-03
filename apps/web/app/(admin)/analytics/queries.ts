import {
  conversionRateOf,
  type FunnelRate,
  filsFromStoredDigits,
  funnelCountsFrom,
  funnelOrderViolations,
  type Money,
  money,
  showAdjustedConversionOf,
} from '@berelax/core'
import { funnelCountRows, type Sql } from '@berelax/db'
import { FUNNEL_STAGES, type FunnelStage, isFunnelStage } from '@berelax/shared'

/**
 * The nine panels' reads (A-FIRST-10), and the one rule that shapes all of them.
 *
 * ## Every panel owns its own query, and the headline is computed from THAT query
 *
 * The acceptance line is *"each headline number equals the value returned by its own query, compared
 * programmatically"*. The only way to make that a check rather than a reviewer's attention is for the
 * figure the page prints and the figure a test computes to come from the same function — so each panel
 * here is `readXPanel(sql, window)` returning its rows AND its {@link PanelHeadline}, and
 * `analytics-page.itest.ts` calls the same nine functions and compares against the `data-headline`
 * attribute parsed out of the rendered document. A panel whose headline were assembled in the renderer
 * could not be compared with anything, which is how a dashboard comes to show a number nothing produced.
 *
 * ## Why there is no rate in floating point anywhere
 *
 * Per mille integers, and `FunnelRate` from `@berelax/core` wherever the figure is a ratio, for the reason
 * `funnel-counts.ts` gives: a percentage computed in floating point and rendered to one decimal place
 * disagrees with the two integers it came from, and somebody then has to work out which of the three is
 * wrong. Every rate on this page therefore carries its numerator and its denominator, and the renderer
 * prints both — which is also the data-quality strip's acceptance line in so many words.
 *
 * ## Why "no data" is a value and never a zero
 *
 * {@link PanelHeadline} has a `no_data` variant carrying the reason. ADR 0002: a report that cannot
 * distinguish "none" from "nothing was measured" is worse than no report. The strip's acceptance line
 * names the specific case — *"renders 'no data' rather than 0% when no codes were issued"* — and it is the
 * general rule here, not a special case for one panel: a day with no sessions has no bot-filtered share,
 * no conversion rate and no device split, and a page of zeroes would read as a day the business failed.
 *
 * ## Why these take `Sql` and read nothing else
 *
 * No clock, no connection, no session. The suite drives them inside a transaction it rolls back —
 * `analytics.event` and `analytics.funnel_step` are append-only for every role but `berelax_retention`
 * (ZY065), so a fixture cohort can only be removed by a rollback, and that is possible exactly because
 * these functions take the handle they are given.
 */

/** The window every panel is read over: one trading date. */
export interface AnalyticsWindow {
  /** `YYYY-MM-DD`, a date `public.business_day` holds. Required, never defaulted — see `route.ts`. */
  readonly tradingDate: string
}

/**
 * One panel's headline figure, or the named reason there is not one.
 *
 * Three variants and not a nullable number. `rate` carries both integers because a share with no
 * denominator is not checkable, `count` carries a unit because a bare integer on a dashboard is a figure
 * whose subject the reader has to guess, and `no_data` carries the reason because "0" and "nothing was
 * measured" are different facts (ADR 0002).
 */
export type PanelHeadline =
  | { readonly kind: 'count'; readonly value: number; readonly unit: string }
  | {
      readonly kind: 'rate'
      readonly numerator: number
      readonly denominator: number
      readonly perMille: number
    }
  | { readonly kind: 'no_data'; readonly why: string }

/** A `FunnelRate` as a headline, so "no denominator" keeps the reason the core resolver gave it. */
export const headlineFromRate = (rate: FunnelRate): PanelHeadline =>
  rate.kind === 'rate'
    ? {
        kind: 'rate',
        numerator: rate.numerator,
        denominator: rate.denominator,
        perMille: rate.perMille,
      }
    : { kind: 'no_data', why: rate.why }

/**
 * A count headline, with the zero case kept distinguishable from the no-rows case by the CALLER.
 *
 * A separate helper rather than a branch inside each panel, because the decision "is nought a figure
 * here" differs per panel and has to be made deliberately: nought paid conversions on a day with four
 * hundred landings is a real and alarming figure, and nought sessions is not a figure at all.
 */
export const headlineCount = (value: number, unit: string): PanelHeadline => ({
  kind: 'count',
  value,
  unit,
})

/** The nine panel ids, in the order they appear on the page. The page's own spine. */
export const ANALYTICS_PANEL_IDS = [
  'funnel',
  'origination',
  'landing-pages',
  'interactions',
  'devices',
  'breakpoints',
  'time-of-day',
  'source-revenue',
  'data-quality',
] as const
export type AnalyticsPanelId = (typeof ANALYTICS_PANEL_IDS)[number]

// --- 1. the funnel ---------------------------------------------------------------------------------

export interface FunnelRow {
  readonly stage: FunnelStage
  readonly entered: number
  readonly excluded: number
  readonly gapEntered: number
  /**
   * How many of the previous stage's arrivals did not reach this one, and null for the first stage.
   *
   * Null rather than zero, and the difference is the whole of "per-step drop-off": the first stage has no
   * previous stage, so it has no drop-off, and a zero there would read as "nobody was lost before the
   * funnel started" — a claim about a step that does not exist.
   *
   * It may be NEGATIVE, and that is reported rather than clamped. `landing` counts only consented
   * sessions while a pre-consent visit contributes to none (ADR 0066), so a later stage can legitimately
   * exceed an earlier one; `funnelOrderViolations` in `@berelax/core` names those pairs and the
   * data-quality strip is where they are explained. A `Math.max(0, …)` here would hide a measurement
   * defect behind a tidy chart.
   */
  readonly droppedFromPrevious: number | null
}

export interface FunnelPanel {
  readonly rows: readonly FunnelRow[]
  readonly conversion: FunnelRate
  readonly showAdjusted: FunnelRate
  /** Stage pairs where a later bucket exceeds an earlier one. Explained, never corrected. */
  readonly orderViolations: readonly { readonly stage: string; readonly previous: string }[]
  readonly headline: PanelHeadline
}

/**
 * The funnel, with per-step drop-off.
 *
 * Reads through `funnelCountRows` (A-FIRST-09) rather than writing a tenth copy of the funnel query, and
 * folds with `funnelCountsFrom` rather than summing here: that read is grouped by origination as well as
 * by stage, so a reducer that assigned instead of adding would answer with whichever tuple sorted last.
 * The acceptance line *"conversion is paid ÷ landing"* is `conversionRateOf`'s, which takes no stage
 * parameter at all — so this panel cannot ask for the wrong numerator.
 *
 * Bots are excluded, which is `funnelCountRows`' default and A-FIRST-04's deferral discharged. The
 * data-quality strip reports how many sessions that removed, so the exclusion is visible rather than
 * silent.
 */
export async function readFunnelPanel(sql: Sql, at: AnalyticsWindow): Promise<FunnelPanel> {
  const groups = await funnelCountRows(sql, { tradingDate: at.tradingDate })
  const counts = funnelCountsFrom(
    groups.flatMap((group) =>
      isFunnelStage(group.stage)
        ? [
            {
              stage: group.stage,
              entered: group.entered,
              excluded: group.excluded,
              gapEntered: group.gapEntered,
            },
          ]
        : [],
    ),
  )
  const rows: FunnelRow[] = FUNNEL_STAGES.map((stage, index) => {
    const previousStage = index === 0 ? undefined : FUNNEL_STAGES[index - 1]
    const previous = previousStage === undefined ? undefined : counts[previousStage]
    return {
      stage,
      entered: counts[stage].entered,
      excluded: counts[stage].excluded,
      gapEntered: counts[stage].gapEntered,
      droppedFromPrevious: previous === undefined ? null : previous.entered - counts[stage].entered,
    }
  })
  const conversion = conversionRateOf(counts)
  return {
    rows,
    conversion,
    showAdjusted: showAdjustedConversionOf(counts),
    orderViolations: funnelOrderViolations(counts),
    headline: headlineFromRate(conversion),
  }
}

// --- 2. traffic and conversion by source / medium / campaign ---------------------------------------

export interface OriginationRow {
  readonly source: string
  readonly medium: string
  readonly campaign: string
  readonly sessions: number
  readonly paid: number
}

export interface OriginationPanel {
  readonly rows: readonly OriginationRow[]
  readonly headline: PanelHeadline
}

/**
 * Traffic and conversion by origination tuple, from the two rollups that are keyed on it.
 *
 * A FULL OUTER JOIN and not an inner one. `daily_traffic` holds a tuple that produced sessions and
 * `daily_funnel` holds one that reached a stage, and the two sets are not the same: a campaign whose
 * sessions were all bots has traffic and no conversions, and a conversion attributed to a tuple whose
 * sessions were filed under a different trading date has a `paid` row and no traffic. An inner join drops
 * the first and the page would show a shorter list with no sign that anything was missing — which is the
 * failure A-MEAS-07's own LEFT JOIN comment records one table over.
 *
 * `sessions` is the NON-BOT figure: `daily_traffic.bot_sessions` is a subset of `sessions`, so the
 * subtraction is exact and agrees with the funnel's own exclusion. The bot count itself is the
 * data-quality strip's.
 */
export async function readOriginationPanel(
  sql: Sql,
  at: AnalyticsWindow,
): Promise<OriginationPanel> {
  const rows = await sql<
    { source: string; medium: string; campaign: string; sessions: string; paid: string }[]
  >`
    with traffic as (
      select source, medium, campaign,
             sum(sessions - bot_sessions)::text as sessions
        from analytics.daily_traffic
       where trading_date = ${at.tradingDate}::date
       group by source, medium, campaign
    ), paid as (
      select source, medium, campaign, sum(entered - excluded)::text as paid
        from analytics.daily_funnel
       where trading_date = ${at.tradingDate}::date
         and step = 'paid'
       group by source, medium, campaign
    )
    select coalesce(t.source, p.source)     as source,
           coalesce(t.medium, p.medium)     as medium,
           coalesce(t.campaign, p.campaign) as campaign,
           coalesce(t.sessions, '0')        as sessions,
           coalesce(p.paid, '0')            as paid
      from traffic t
      full outer join paid p
        on p.source = t.source and p.medium = t.medium and p.campaign = t.campaign
     order by (coalesce(t.sessions, '0'))::bigint desc,
              coalesce(t.source, p.source), coalesce(t.medium, p.medium),
              coalesce(t.campaign, p.campaign)
  `
  const mapped = rows.map((row) => ({
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    sessions: Number(row.sessions),
    paid: Number(row.paid),
  }))
  return {
    rows: mapped,
    headline:
      mapped.length === 0
        ? {
            kind: 'no_data',
            why: 'no session was attributed to any origination on this trading date, so there is no traffic to split.',
          }
        : headlineCount(mapped.length, 'origination tuples'),
  }
}

// --- 3. landing-page performance -------------------------------------------------------------------

export interface LandingPageRow {
  readonly path: string
  readonly sessions: number
  readonly paid: number
}

export interface LandingPagePanel {
  readonly rows: readonly LandingPageRow[]
  readonly headline: PanelHeadline
}

/**
 * Landing-page performance: sessions that ENTERED on a path, and how many of them paid.
 *
 * Read off `analytics.session.landing_path` rather than off the first `page_view` event, because the two
 * can disagree and only one of them survives retention: raw events are dropped at 90 days and the session
 * row's landing path is not. A panel computed from the events would quietly change its answer as the
 * window aged out.
 *
 * `paid` is a count of DISTINCT sessions, not of funnel-step rows: `analytics.funnel_step` is keyed per
 * session and step, so the distinction cannot bite today — and `count(distinct …)` is what keeps this
 * figure a share of `sessions` if it ever grows a second row per session.
 */
export async function readLandingPagePanel(
  sql: Sql,
  at: AnalyticsWindow,
): Promise<LandingPagePanel> {
  const rows = await sql<{ path: string; sessions: string; paid: string }[]>`
    select s.landing_path as path,
           count(distinct s.session_id)::text as sessions,
           count(distinct f.session_id)::text as paid
      from analytics.session s
      left join analytics.funnel_step f
        on f.session_id = s.session_id and f.step = 'paid' and f.excluded_reason is null
     where s.trading_date = ${at.tradingDate}::date
       and s.bot = false
     group by s.landing_path
     order by count(distinct s.session_id) desc, s.landing_path
  `
  const mapped = rows.map((row) => ({
    path: row.path,
    sessions: Number(row.sessions),
    paid: Number(row.paid),
  }))
  return {
    rows: mapped,
    headline:
      mapped.length === 0
        ? {
            kind: 'no_data',
            why: 'no human session landed on this trading date, so no landing page has a figure.',
          }
        : headlineCount(mapped.length, 'landing pages'),
  }
}

// --- 4. ranked interactions ------------------------------------------------------------------------

export interface InteractionRow {
  readonly eventName: string
  readonly path: string
  readonly events: number
  readonly sessions: number
}

export interface InteractionPanel {
  readonly rows: readonly InteractionRow[]
  readonly headline: PanelHeadline
}

/**
 * Interactions, ranked, with `page_view` deliberately absent.
 *
 * A page view is a NAVIGATION and not an interaction: it is what the funnel's `landing` stage counts, it
 * is on every row of the event table, and including it would put one bucket at the top of this ranking
 * for ever while the four things a reader wants ranked sat underneath it. The four that remain are the
 * taxonomy's interaction events, and the list is derived — `event_name <> 'page_view'` rather than an
 * `in (…)` of four names, so a sixth event added to `ANALYTICS_EVENT_NAMES` appears here on the day it is
 * collected instead of being silently absent.
 *
 * Both figures, because they answer different questions: `events` is volume and `sessions` is reach, and a
 * single visitor pressing one call-to-action eleven times is a rank a volume-only panel would report as
 * eleven people.
 */
export async function readInteractionPanel(
  sql: Sql,
  at: AnalyticsWindow,
): Promise<InteractionPanel> {
  const rows = await sql<{ eventName: string; path: string; events: string; sessions: string }[]>`
    select e.event_name as "eventName",
           e.path       as path,
           count(*)::text as events,
           count(distinct e.session_id)::text as sessions
      from analytics.event e
      join analytics.session s on s.session_id = e.session_id
     where s.trading_date = ${at.tradingDate}::date
       and s.bot = false
       and e.event_name <> 'page_view'
     group by e.event_name, e.path
     order by count(*) desc, e.event_name, e.path
  `
  const mapped = rows.map((row) => ({
    eventName: row.eventName,
    path: row.path,
    events: Number(row.events),
    sessions: Number(row.sessions),
  }))
  return {
    rows: mapped,
    headline:
      mapped.length === 0
        ? {
            kind: 'no_data',
            why: 'no interaction was collected on this trading date — which on a day with sessions is a measurement question rather than a quiet day.',
          }
        : headlineCount(
            mapped.reduce((total, row) => total + row.events, 0),
            'interactions',
          ),
  }
}

// --- 5 and 6. the device split and the breakpoint split --------------------------------------------

export interface SegmentRow {
  readonly segment: string
  readonly sessions: number
  readonly paid: number
}

export interface SegmentPanel {
  readonly rows: readonly SegmentRow[]
  readonly headline: PanelHeadline
}

/**
 * The device split, from the rollup that is keyed on it.
 *
 * `daily_traffic` carries `device_kind` in its primary key, so this is a read of the rollup; the
 * breakpoint is NOT in any rollup and is read off the sessions, which is why the two panels are two
 * functions rather than one parameterised by a column name. A single function taking a column would be a
 * function taking SQL from its caller.
 */
export async function readDeviceSplitPanel(sql: Sql, at: AnalyticsWindow): Promise<SegmentPanel> {
  const rows = await sql<{ segment: string; sessions: string; paid: string }[]>`
    with traffic as (
      select device_kind as segment, sum(sessions - bot_sessions) as sessions
        from analytics.daily_traffic
       where trading_date = ${at.tradingDate}::date
       group by device_kind
    ), paid as (
      select s.device_kind as segment, count(distinct f.session_id) as paid
        from analytics.session s
        join analytics.funnel_step f
          on f.session_id = s.session_id and f.step = 'paid' and f.excluded_reason is null
       where s.trading_date = ${at.tradingDate}::date
         and s.bot = false
       group by s.device_kind
    )
    select t.segment                     as segment,
           t.sessions::text              as sessions,
           coalesce(p.paid, 0)::text     as paid
      from traffic t
      left join paid p on p.segment = t.segment
     order by t.sessions desc, t.segment
  `
  return segmentPanelFrom(
    rows,
    'no session with a device was rolled up for this trading date, so there is no device split.',
  )
}

/**
 * The breakpoint split, read off the sessions.
 *
 * There is no breakpoint rollup and this does not invent one: `analytics.session.breakpoint` is the
 * column A-FIRST-01 records and `session_trading_date_idx` is the index this read uses. The figure is
 * therefore a live read rather than a rollup, and that difference is stated on the panel — a reader
 * comparing it against the device split needs to know that one of the two survives a raw-event purge and
 * the other is recomputed from rows retention keeps for 90 days.
 */
export async function readBreakpointSplitPanel(
  sql: Sql,
  at: AnalyticsWindow,
): Promise<SegmentPanel> {
  const rows = await sql<{ segment: string; sessions: string; paid: string }[]>`
    select s.breakpoint as segment,
           count(distinct s.session_id)::text as sessions,
           count(distinct f.session_id)::text as paid
      from analytics.session s
      left join analytics.funnel_step f
        on f.session_id = s.session_id and f.step = 'paid' and f.excluded_reason is null
     where s.trading_date = ${at.tradingDate}::date
       and s.bot = false
     group by s.breakpoint
     order by count(distinct s.session_id) desc, s.breakpoint
  `
  return segmentPanelFrom(
    rows,
    'no human session is on file for this trading date, so there is no breakpoint split.',
  )
}

function segmentPanelFrom(
  rows: readonly { segment: string; sessions: string; paid: string }[],
  why: string,
): SegmentPanel {
  const mapped = rows.map((row) => ({
    segment: row.segment,
    sessions: Number(row.sessions),
    paid: Number(row.paid),
  }))
  return {
    rows: mapped,
    headline:
      mapped.length === 0 ? { kind: 'no_data', why } : headlineCount(mapped.length, 'kinds'),
  }
}

// --- 7. time of day --------------------------------------------------------------------------------

export interface HourBucket {
  /** The hour of the day in Asia/Dubai, 0-23. The LABEL is the renderer's. */
  readonly hour: number
  readonly sessions: number
  readonly paid: number
}

export interface TimeOfDayPanel {
  readonly buckets: readonly HourBucket[]
  readonly opensAtHour: number
  readonly closesAtHour: number
  readonly headline: PanelHeadline
}

/**
 * Conversion by hour, across the trading window and only across it.
 *
 * ## Why the buckets come from `business_day` and are not fifteen literals
 *
 * The acceptance line asks for *"exactly 15 contiguous hourly buckets from 11:00 through 01:00 in
 * business-day order, with no 03:00-10:00 bucket and no gap across midnight"*. Fifteen is what the
 * seeded premises' 11:00-02:00 window produces, and it is DERIVED from `business_day.opens_at` and
 * `closes_at` for the trading date rather than written down: a day whose hours were overridden would
 * otherwise get a chart of fifteen buckets, two of them outside the hours the premises was open, and
 * nothing would say so. `business_day.crosses_midnight` is a generated column and the wrap is read off the
 * same two instants, so the order below cannot disagree with the calendar.
 *
 * ## Why every bucket is present even at nought
 *
 * `generate_series` over the window and a LEFT JOIN, so an hour nobody visited is a bucket with nought in
 * it rather than an absent row. That is what "contiguous" means and it is the only way the chart can be
 * read: a missing 22:00 shifts every later column left, and the reader sees a quiet midnight rather than
 * an hour with no data. The absence of a 03:00-10:00 bucket is the same mechanism from the other side —
 * those hours are not in the series because the premises is shut, and a nought there would claim the
 * business was open and empty.
 */
export async function readTimeOfDayPanel(sql: Sql, at: AnalyticsWindow): Promise<TimeOfDayPanel> {
  const [day] = await sql<{ opensAtHour: number; closesAtHour: number; hours: number }[]>`
    select extract(hour from (opens_at  at time zone 'Asia/Dubai'))::int as "opensAtHour",
           extract(hour from (closes_at at time zone 'Asia/Dubai'))::int as "closesAtHour",
           (duration_seconds / 3600)::int                                as hours
      from business_day
     where trading_date = ${at.tradingDate}::date
  `
  if (day === undefined) {
    /*
     * No `business_day` row means the calendar does not hold this date, and there is no window to bucket
     * by. Refused rather than defaulted to 11:00-02:00: a default would be this module's third opinion
     * about the trading window — `business_day` has one and ZY222 enforces it — and it would render a
     * chart of fifteen hours for a date the premises never opened on.
     */
    return {
      buckets: [],
      opensAtHour: 0,
      closesAtHour: 0,
      headline: {
        kind: 'no_data',
        why: `the calendar holds no business day for ${at.tradingDate}, so there is no trading window to bucket by.`,
      },
    }
  }
  const rows = await sql<{ hour: number; sessions: string; paid: string }[]>`
    with window_hours as (
      select generate_series(0, ${day.hours} - 1) as offset_hours
    ), buckets as (
      select offset_hours,
             ((select opens_at from business_day where trading_date = ${at.tradingDate}::date)
               + make_interval(hours => offset_hours)) as bucket_start
        from window_hours
    )
    select extract(hour from (b.bucket_start at time zone 'Asia/Dubai'))::int as hour,
           count(distinct s.session_id)::text as sessions,
           count(distinct f.session_id)::text as paid
      from buckets b
      left join analytics.session s
        on s.trading_date = ${at.tradingDate}::date
       and s.bot = false
       and s.started_at >= b.bucket_start
       and s.started_at <  b.bucket_start + make_interval(hours => 1)
      left join analytics.funnel_step f
        on f.session_id = s.session_id and f.step = 'paid' and f.excluded_reason is null
     group by b.offset_hours, b.bucket_start
     order by b.offset_hours
  `
  const buckets = rows.map((row) => ({
    hour: row.hour,
    sessions: Number(row.sessions),
    paid: Number(row.paid),
  }))
  const sessions = buckets.reduce((total, bucket) => total + bucket.sessions, 0)
  return {
    buckets,
    opensAtHour: day.opensAtHour,
    closesAtHour: day.closesAtHour,
    headline:
      sessions === 0
        ? {
            kind: 'no_data',
            why: 'no human session began inside the trading window on this date, so no hour has a share of it.',
          }
        : headlineCount(buckets.length, 'hourly buckets'),
  }
}

// --- 8. revenue by source, joined to paid bookings -------------------------------------------------

export interface SourceRevenueRow {
  readonly source: string
  readonly medium: string
  readonly campaign: string
  readonly paidInvoices: number
  /**
   * Gross, net and VAT as `Money` — integer fils, gross authoritative (ADR 0007).
   *
   * `Money` and not a number, and built through `filsFromStoredDigits` rather than `Number(row.x)`: the
   * driver returns a `bigint` column as a string precisely so nothing rounds a money figure, and
   * `Number()` at the consumer would put the rounding straight back. The helper refuses a value that does
   * not survive the round trip rather than publishing it.
   */
  readonly gross: Money
  readonly net: Money
  readonly vat: Money
}

export interface SourceRevenuePanel {
  readonly rows: readonly SourceRevenueRow[]
  readonly headline: PanelHeadline
}

/**
 * Revenue by origination, from `analytics.daily_source_revenue`.
 *
 * `Money` the whole way through and never a `number`. The column is `bigint` precisely so a figure past
 * 2^53 fils cannot silently lose precision on the way through JavaScript, and a panel that read it with
 * `Number()` would be the place that threw that away — `filsFromStoredDigits` refuses such a value rather
 * than publishing it. The HEADLINE is therefore a count of tuples and not a sum of money: `PanelHeadline`'s
 * `count` is a `number`, and putting fils in it would be the same defect one layer up. The money itself is
 * rendered by `@berelax/core`'s own formatter.
 *
 * This is the rollup A-FIRST-09 writes from settled invoices joined to the attributed session, which is
 * the acceptance line's *"revenue by source joined to paid bookings"*. It is a different panel from
 * A-MEAS-07's `panels/revenue-by-source.ts`, which is about what was PUSHED to an advertising destination
 * and whether that reconciles — two questions that would be one number on a careless dashboard.
 */
export async function readSourceRevenuePanel(
  sql: Sql,
  at: AnalyticsWindow,
): Promise<SourceRevenuePanel> {
  const rows = await sql<
    {
      source: string
      medium: string
      campaign: string
      paidInvoices: number
      grossFils: string
      netFils: string
      vatFils: string
    }[]
  >`
    select source, medium, campaign,
           paid_invoices  as "paidInvoices",
           gross_fils::text as "grossFils",
           net_fils::text   as "netFils",
           vat_fils::text   as "vatFils"
      from analytics.daily_source_revenue
     where trading_date = ${at.tradingDate}::date
     order by gross_fils desc, source, medium, campaign
  `
  const mapped = rows.map((row) => ({
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    paidInvoices: row.paidInvoices,
    gross: money(filsFromStoredDigits(row.grossFils, 'daily_source_revenue.gross_fils')),
    net: money(filsFromStoredDigits(row.netFils, 'daily_source_revenue.net_fils')),
    vat: money(filsFromStoredDigits(row.vatFils, 'daily_source_revenue.vat_fils')),
  }))
  return {
    rows: mapped,
    headline:
      mapped.length === 0
        ? {
            kind: 'no_data',
            why: 'no invoice was settled against an attributed session on this trading date, so no source has revenue.',
          }
        : headlineCount(mapped.length, 'sources with revenue'),
  }
}

// --- 9. the data-quality strip ---------------------------------------------------------------------

export interface DataQualityPanel {
  /**
   * The bot-filtered share: crawler sessions over all sessions, with both integers.
   *
   * `no_data` when the rollup holds no session for the date — not 0%. A day with no traffic has no
   * bot-filtered share, and 0% on that day would read as "we checked and there were no crawlers".
   */
  readonly botFiltered: PanelHeadline
  /** The ref-capture rate: codes claimed over codes issued. `no_data` when none were issued. */
  readonly refCapture: PanelHeadline
  /** Sessions filed under this date out of the 02:00-11:00 gap (`Y5-funnel-gap-bucket`). */
  readonly gapSessions: number
  /** Landings recorded before any consent, which contribute to no session at all (ADR 0066). */
  readonly preConsentLandings: bigint
  readonly headline: PanelHeadline
}

/**
 * The strip, and the one acceptance line that is about a ZERO.
 *
 * *"renders 'no data' rather than 0% when no codes were issued"*. `daily_ref_capture` has a CHECK holding
 * `codes_claimed <= codes_issued`, so a zero denominator cannot carry a non-zero numerator — which means
 * the only honest answer for a day nobody issued a code on is that there is no rate. A 0% would say the
 * loop was offered and refused.
 *
 * Both figures carry their numerator and their denominator, which is the other half of the same line, and
 * they are carried as integers rather than as a formatted percentage so the renderer cannot be the place a
 * rate and its two inputs come to disagree.
 *
 * The two FIGURES beside them are the two populations this page cannot show in the funnel and must not
 * leave unsaid: the daytime-gap cohort, and the pre-consent landings. `analytics.pre_consent_landing` is
 * the identifier-free counter A-FIRST-05 keeps for exactly this, and it is why a later funnel stage can
 * legitimately exceed `landing` — which is the explanation the funnel panel's order violations point at.
 */
export async function readDataQualityPanel(
  sql: Sql,
  at: AnalyticsWindow,
): Promise<DataQualityPanel> {
  const [traffic] = await sql<{ sessions: string; botSessions: string; gapSessions: string }[]>`
    select coalesce(sum(sessions), 0)::text     as sessions,
           coalesce(sum(bot_sessions), 0)::text as "botSessions",
           coalesce(sum(gap_sessions), 0)::text as "gapSessions"
      from analytics.daily_traffic
     where trading_date = ${at.tradingDate}::date
  `
  const [capture] = await sql<{ issued: string; claimed: string }[]>`
    select coalesce(sum(codes_issued), 0)::text  as issued,
           coalesce(sum(codes_claimed), 0)::text as claimed
      from analytics.daily_ref_capture
     where trading_date = ${at.tradingDate}::date
  `
  const [preConsent] = await sql<{ landings: string }[]>`
    select coalesce(sum(landings), 0)::text as landings
      from analytics.pre_consent_landing
     where bucket_date = ${at.tradingDate}::date
  `
  if (traffic === undefined || capture === undefined || preConsent === undefined) {
    // An aggregate over an empty table returns one row, so this cannot happen — and it is named rather
    // than coalesced to zero, because `0` here would be the strip reporting a clean day for a read that
    // did not happen. `alerts.ts` records the same rule: a reader that cannot read must not return zero.
    throw new Error(
      'A data-quality aggregate returned no row, which an aggregate over an empty table cannot. The ' +
        'strip has nothing to report and must not report nought.',
    )
  }
  const sessions = Number(traffic.sessions)
  const botSessions = Number(traffic.botSessions)
  const issued = Number(capture.issued)
  const claimed = Number(capture.claimed)
  const botFiltered: PanelHeadline =
    sessions === 0
      ? {
          kind: 'no_data',
          why: 'no session was rolled up for this trading date, so there is no share for crawlers to be of.',
        }
      : {
          kind: 'rate',
          numerator: botSessions,
          denominator: sessions,
          perMille: Math.round((botSessions * 1000) / sessions),
        }
  const refCapture: PanelHeadline =
    issued === 0
      ? {
          kind: 'no_data',
          why: 'no ref code was issued on this trading date, so there is no capture rate. A 0% would say the loop was offered and refused.',
        }
      : {
          kind: 'rate',
          numerator: claimed,
          denominator: issued,
          perMille: Math.round((claimed * 1000) / issued),
        }
  return {
    botFiltered,
    refCapture,
    gapSessions: Number(traffic.gapSessions),
    preConsentLandings: BigInt(preConsent.landings),
    // The strip's own headline is the bot-filtered share: it is the figure that says whether anything
    // else on the page can be believed.
    headline: botFiltered,
  }
}

// --- the page --------------------------------------------------------------------------------------

export interface AnalyticsPageData {
  readonly tradingDate: string
  readonly funnel: FunnelPanel
  readonly origination: OriginationPanel
  readonly landingPages: LandingPagePanel
  readonly interactions: InteractionPanel
  readonly devices: SegmentPanel
  readonly breakpoints: SegmentPanel
  readonly timeOfDay: TimeOfDayPanel
  readonly sourceRevenue: SourceRevenuePanel
  readonly dataQuality: DataQualityPanel
}

/**
 * All nine panels for one trading date.
 *
 * Sequential and not `Promise.all`, for the reason `observeAlerts` gives: every admin route in this build
 * opens a two-connection pool, and a fan-out of eleven statements would make `sorry, too many clients
 * already` a property of somebody else's test run. Eleven short queries serialised cost a page load.
 */
export async function readAnalyticsPage(sql: Sql, at: AnalyticsWindow): Promise<AnalyticsPageData> {
  return {
    tradingDate: at.tradingDate,
    funnel: await readFunnelPanel(sql, at),
    origination: await readOriginationPanel(sql, at),
    landingPages: await readLandingPagePanel(sql, at),
    interactions: await readInteractionPanel(sql, at),
    devices: await readDeviceSplitPanel(sql, at),
    breakpoints: await readBreakpointSplitPanel(sql, at),
    timeOfDay: await readTimeOfDayPanel(sql, at),
    sourceRevenue: await readSourceRevenuePanel(sql, at),
    dataQuality: await readDataQualityPanel(sql, at),
  }
}

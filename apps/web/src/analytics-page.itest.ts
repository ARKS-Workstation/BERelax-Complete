import { createHash, randomUUID } from 'node:crypto'
import { createConnection, rollUpTradingDate, type Sql } from '@berelax/db'
import { createFixturePrincipal, FIXTURE_NOW } from '@berelax/fixtures'
import {
  blockingViolations,
  type Capture,
  type CaptureHarness,
  createCaptureHarness,
  DIRECTIONS,
  describeViolation,
  THEMES,
  VIEWPORTS,
} from '@berelax/harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { headlineValue } from '../app/(admin)/analytics/panels/panel.ts'
import {
  ANALYTICS_PANEL_IDS,
  readAnalyticsPage,
  readBreakpointSplitPanel,
  readDataQualityPanel,
  readDeviceSplitPanel,
  readFunnelPanel,
  readInteractionPanel,
  readLandingPagePanel,
  readOriginationPanel,
  readSourceRevenuePanel,
  readTimeOfDayPanel,
} from '../app/(admin)/analytics/queries.ts'
import { renderAnalyticsPageHtml } from '../app/(admin)/analytics/render.ts'
import { ANALYTICS_PERMISSION, GET } from '../app/(admin)/analytics/route.ts'
import { NOINDEX_ROBOTS_TAG, ROBOTS_HEADER, sitemapEntries } from './routes/registry.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The /analytics dashboard against a real database and a real browser (A-FIRST-10).
 *
 * ## Why the fixture cohort lives inside a rolled-back transaction
 *
 * `analytics.event` and `analytics.funnel_step` are append-only for every role but `berelax_retention`
 * (ZY065), so a cohort inserted on the pool could never be removed and every later run of this file would
 * accumulate one — which would make the figures it asserts grow, and the suite would pass once. A rollback
 * is the only cleanup the state permits, which is the rule working rather than a difficulty, and it is
 * possible exactly because every panel reader takes the `Sql` it is given.
 *
 * The two things that CANNOT be driven inside that transaction are the route and the browser: the route
 * opens its own connection from `DATABASE_URL`, and the capture harness renders bytes with no database at
 * all. So they are driven separately — the route against whatever the committed database holds, which is
 * why its assertions are about the response and the audit DELTA rather than about a figure.
 *
 * ## Why the headline comparison is programmatic
 *
 * The acceptance line is *"each headline number equals the value returned by its own query, compared
 * programmatically"*. Each panel's reader is called a SECOND time here, independently of the page, and the
 * figure it returns is compared against the `data-headline` attribute parsed out of the rendered document.
 * Nothing in this file writes an expected number down: a literal would be a third statement of a figure,
 * and a third statement of a figure drifts.
 *
 * The non-vacuity control is the one that matters. A page of nine `no data` panels would satisfy a
 * comparison of nulls against nulls, so the cohort is asserted to produce a FIGURE on every one of the
 * nine, and the spine is asserted to hold nine ids.
 *
 * ## The trading date
 *
 * The newest business day that has CLOSED, which is the arrangement `agent-console.itest.ts` uses: a day
 * still open has a trading window the clock is inside, so a bucket count would change between the two
 * halves of this file. Everything written against it is rolled back.
 */
let sql: Sql
let harness: CaptureHarness
let tradingDate = ''
let captures: Capture[] = []
let recaptures: Capture[] = []

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const [day] = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate"
      from public.business_day
     where closes_at <= now()
     order by closes_at desc, trading_date desc
     limit 1
  `
  if (day === undefined) {
    // Named rather than non-null-asserted: `(day?.x as string)` throws several frames from the query
    // that actually found nothing, and the remedy is `pnpm seed` rather than a change to this file.
    throw new Error('the trading calendar holds no day that has closed; run `pnpm seed`')
  }
  tradingDate = day.tradingDate
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await harness?.close()
})

/**
 * The fifteen human sessions, one per hour of the trading window, each with an attribution.
 *
 * One per hour so every bucket of the time-of-day chart has something in it: a chart over an empty cohort
 * is fifteen noughts, and fifteen noughts in the right order is indistinguishable from fifteen noughts in
 * the wrong one. Three devices and three breakpoints by rotation, so both split panels have more than one
 * row, and two origination tuples so the full outer join has two sides.
 */
async function insertWindowSessions(tx: Sql, visitorId: string): Promise<readonly string[]> {
  const devices = ['mobile', 'tablet', 'desktop'] as const
  const breakpoints = ['sm', 'md', 'lg'] as const
  const landings = ['/book', '/treatments/deep-tissue'] as const
  const origins = [
    { source: 'google', medium: 'organic', campaign: '' },
    { source: 'instagram', medium: 'social', campaign: 'ramadan' },
  ] as const

  const sessionIds: string[] = []
  for (let hour = 0; hour < 15; hour += 1) {
    const [row] = await tx<{ sessionId: string }[]>`
      insert into analytics.session (
        visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
        device_kind, breakpoint, bot,
        consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
        consent_analytics_storage
      )
      select ${visitorId}::uuid,
             b.opens_at + make_interval(hours => ${hour}),
             b.opens_at + make_interval(hours => ${hour}),
             b.trading_date, 'trading', ${landings[hour % landings.length] ?? '/book'},
             ${devices[hour % devices.length] ?? 'desktop'},
             ${breakpoints[hour % breakpoints.length] ?? 'lg'}, false, true, true, true, true
        from public.business_day b
       where b.trading_date = ${tradingDate}::date
      returning session_id::text as "sessionId"
    `
    if (row === undefined) throw new Error(`inserting fixture session ${hour} returned no row`)
    sessionIds.push(row.sessionId)
    const origin = origins[hour % origins.length] ?? origins[0]
    await tx`
      insert into analytics.attribution
        (session_id, basis, source, medium, campaign, resolver_version, resolved_at)
      select ${row.sessionId}::uuid, 'utm', ${origin.source}, ${origin.medium},
             ${origin.campaign}, 'fixture-1', b.opens_at
        from public.business_day b where b.trading_date = ${tradingDate}::date
    `
  }
  return sessionIds
}

/**
 * The crawler, and the session filed out of the 02:00-11:00 gap.
 *
 * The crawler is what makes the bot-filtered share a figure rather than a nought, and it is what every
 * other panel has to be shown EXCLUDING. The gap session carries `trading_date_basis = 'before_opening'`
 * with an instant three hours BEFORE the window opens, which is the only combination ZY222 permits for
 * one: `analytics.assert_session_trading_basis` compares the basis against `business_day`'s own instants,
 * so a `started_at` inside the window with that basis is refused by the server.
 */
async function insertEdgeSessions(tx: Sql, visitorId: string): Promise<void> {
  await tx`
    insert into analytics.session (
      visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
      device_kind, breakpoint, bot, bot_kind,
      consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
      consent_analytics_storage
    )
    select ${visitorId}::uuid, b.opens_at, b.opens_at, b.trading_date, 'trading',
           '/book', 'desktop', 'lg', true, 'declared_crawler', true, true, true, true
      from public.business_day b where b.trading_date = ${tradingDate}::date
  `
  await tx`
    insert into analytics.session (
      visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
      device_kind, breakpoint, bot,
      consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
      consent_analytics_storage
    )
    select ${visitorId}::uuid,
           b.opens_at - make_interval(hours => 3), b.opens_at - make_interval(hours => 3),
           b.trading_date, 'before_opening', '/book', 'mobile', 'sm', false,
           true, true, true, true
      from public.business_day b where b.trading_date = ${tradingDate}::date
  `
}

/**
 * The funnel: a narrowing subset per stage, and one confirmed booking excluded as a no-show.
 *
 * The exclusion is what gives the show-adjusted denominator something to subtract, and it is the one
 * figure that distinguishes the two rates `funnel-counts.ts` exports — a cohort with no no-show would make
 * both of them the same number and neither assertion would be about anything.
 */
async function insertFunnel(tx: Sql, sessionIds: readonly string[]): Promise<void> {
  const stages = [
    'landing',
    'service_viewed',
    'price_viewed',
    'cta_click',
    'booking_created',
    'confirmed',
    'attended',
    'paid',
  ] as const
  const reach = [15, 12, 10, 8, 6, 5, 4, 3]
  for (const [index, stage] of stages.entries()) {
    for (const sessionId of sessionIds.slice(0, reach[index] ?? 0)) {
      const excluded = stage === 'confirmed' && sessionId === sessionIds[4]
      await tx`
        insert into analytics.funnel_step (session_id, step, occurred_at, excluded_reason, created_at)
        select ${sessionId}::uuid, ${stage}::analytics.funnel_step_name,
               b.opens_at + make_interval(hours => ${index}),
               ${excluded ? 'no_show' : null}, now()
          from public.business_day b where b.trading_date = ${tradingDate}::date
      `
    }
  }
}

/**
 * The interactions, `page_view` among them.
 *
 * Nine page views as well as the three events the ranking is about, because the panel's claim is that
 * page_view is ABSENT from the ranking — a fixture that collected none could not show that, and the
 * assertion would pass against a panel with no predicate at all.
 */
async function insertInteractions(
  tx: Sql,
  sessionIds: readonly string[],
  sentinel: string,
): Promise<void> {
  const interactions = [
    { name: 'page_view', path: '/book', count: 9 },
    { name: 'cta_click', path: '/book', count: 7 },
    { name: 'service_viewed', path: '/treatments/deep-tissue', count: 4 },
    { name: 'price_viewed', path: '/treatments/deep-tissue', count: 2 },
  ] as const
  for (const interaction of interactions) {
    for (let n = 0; n < interaction.count; n += 1) {
      const sessionId = sessionIds[n % sessionIds.length] ?? sessionIds[0]
      await tx`
        insert into analytics.event
          (session_id, occurred_at, received_at, event_name, path, client_event_id)
        select ${sessionId as string}::uuid,
               b.opens_at + make_interval(hours => ${n % 15}),
               b.opens_at + make_interval(hours => ${n % 15}),
               ${interaction.name}, ${interaction.path}, ${`${sentinel}:${interaction.name}:${n}`}
          from public.business_day b where b.trading_date = ${tradingDate}::date
      `
    }
  }
}

/**
 * The rollups: the three the nightly pass derives, plus three rows it cannot.
 *
 * `rollUpTradingDate` is CALLED rather than imitated. A hand-written `daily_traffic` row would make the
 * origination panel agree with this file rather than with the sessions, which is the only thing that panel
 * is about.
 *
 * The three written directly are the ones the pass cannot produce from this cohort.
 * `daily_source_revenue` is built from settled invoices joined to an attributed session and no seeded
 * invoice is attributed to a fixture session, so the rollup correctly produces nothing — the row goes in
 * AFTER the pass, which deletes the date's rows before rebuilding them. `daily_ref_capture` and
 * `pre_consent_landing` are written by other units' jobs. What this file asserts about those panels is
 * therefore that they READ the rollup and render it correctly; whether the rollup derives the right figure
 * is A-FIRST-09's suite and not this one's.
 */
async function insertRollups(tx: Sql): Promise<void> {
  await rollUpTradingDate(tx, {
    tradingDate,
    computedAtIso: new Date(FIXTURE_NOW).toISOString(),
  })
  await tx`
    insert into analytics.daily_source_revenue
      (trading_date, source, medium, campaign, paid_invoices, gross_fils, vat_fils, net_fils,
       computed_at)
    values (${tradingDate}::date, 'google', 'organic', '', 3, 52500, 2500, 50000, now())
  `
  await tx`
    insert into analytics.daily_ref_capture
      (trading_date, trading_date_basis, codes_issued, codes_claimed, computed_at)
    values (${tradingDate}::date, 'trading', 19, 7, now())
    on conflict (trading_date, trading_date_basis) do update
      set codes_issued = 19, codes_claimed = 7
  `
  await tx`
    insert into analytics.pre_consent_landing (bucket_date, bucket_basis, path, landings)
    values (${tradingDate}::date, 'trading', '/book', 61)
    on conflict (bucket_date, bucket_basis, path) do update
      set landings = greatest(analytics.pre_consent_landing.landings, 61)
  `
}

/**
 * The cohort, and the work, inside one transaction that is always rolled back.
 *
 * The rollback is thrown as a sentinel error rather than arranged with a savepoint, because
 * `sql.begin` has no other way to refuse the commit — and it is caught by identity rather than by type, so
 * a real failure inside the body is re-thrown with its own message instead of being swallowed as cleanup.
 */
async function withCohort<T>(
  body: (tx: Sql, at: { tradingDate: string }) => Promise<T>,
): Promise<T> {
  let carried: T | undefined
  const sentinel = `A-FIRST-10 rolled this analytics cohort back ${randomUUID()}`
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      const [visitor] = await tx<{ visitorId: string }[]>`
        insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
        returning visitor_id::text as "visitorId"
      `
      if (visitor === undefined) throw new Error('inserting a fixture visitor returned no row')
      const sessionIds = await insertWindowSessions(tx, visitor.visitorId)
      await insertEdgeSessions(tx, visitor.visitorId)
      await insertFunnel(tx, sessionIds)
      await insertInteractions(tx, sessionIds, sentinel)
      await insertRollups(tx)
      carried = await body(tx, { tradingDate })
      throw new Error(sentinel)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== sentinel) throw error
  }
  if (carried === undefined) throw new Error('the cohort body returned nothing')
  return carried
}

describe('acceptance — all nine panels render, and every headline is its own query’s figure', () => {
  it('compares the rendered headline against a second, independent call of each panel’s reader', async () => {
    const result = await withCohort(async (tx, at) => {
      const html = renderAnalyticsPageHtml({
        chrome: {
          googleReauth: null,
          sendBacklog: null,
          role: 'owner' as const,
          returnTo: '/analytics',
        },
        data: await readAnalyticsPage(tx, at),
        direction: 'ltr',
      })
      // Called AGAIN, independently of the page, which is what makes the comparison a check rather than
      // a tautology: the page's own data object is not consulted.
      const independent: Record<string, number | null> = {
        funnel: headlineValue((await readFunnelPanel(tx, at)).headline),
        origination: headlineValue((await readOriginationPanel(tx, at)).headline),
        'landing-pages': headlineValue((await readLandingPagePanel(tx, at)).headline),
        interactions: headlineValue((await readInteractionPanel(tx, at)).headline),
        devices: headlineValue((await readDeviceSplitPanel(tx, at)).headline),
        breakpoints: headlineValue((await readBreakpointSplitPanel(tx, at)).headline),
        'time-of-day': headlineValue((await readTimeOfDayPanel(tx, at)).headline),
        'source-revenue': headlineValue((await readSourceRevenuePanel(tx, at)).headline),
        'data-quality': headlineValue((await readDataQualityPanel(tx, at)).headline),
      }
      return { html, independent }
    })

    const rendered = new Map(
      [...result.html.matchAll(/data-panel="([a-z-]+)"[^>]*?data-headline="(-?\d+)"/g)].map(
        (match) => [match[1] ?? '', Number(match[2])],
      ),
    )
    expect([...rendered.keys()].sort()).toEqual([...ANALYTICS_PANEL_IDS].sort())
    for (const id of ANALYTICS_PANEL_IDS) {
      // The non-vacuity control, per panel: a `no data` panel has no attribute, so a page of nine of
      // them would make the comparison below an equality of nothing against nothing.
      expect(
        result.independent[id],
        `${id} produced no figure on the fixture cohort`,
      ).not.toBeNull()
      expect(rendered.get(id), `${id}'s headline disagrees with its own query`).toBe(
        result.independent[id],
      )
    }
  }, 60_000)

  it('excludes the crawler from every panel and counts it only in the strip', async () => {
    const { funnel, dataQuality, devices } = await withCohort(
      async (tx, at) => await readAnalyticsPage(tx, at),
    )
    // Sixteen human sessions exist (fifteen in the window plus the gap one) and seventeen rows; the
    // funnel's first bucket counts the fifteen that reached `landing`.
    const landing = funnel.rows.find((row) => row.stage === 'landing')
    expect(landing?.entered).toBe(15)
    expect(dataQuality.botFiltered.kind).toBe('rate')
    if (dataQuality.botFiltered.kind !== 'rate') throw new Error('unreachable')
    expect(dataQuality.botFiltered.numerator).toBe(1)
    expect(dataQuality.botFiltered.denominator).toBe(17)
    // And the control: the device split's sessions add up to the non-crawler count, so the exclusion is
    // the same exclusion everywhere rather than a predicate one panel forgot.
    expect(devices.rows.reduce((total, row) => total + row.sessions, 0)).toBe(16)
  }, 60_000)

  it('ranks interactions and holds page_view out of them', async () => {
    const { interactions } = await withCohort(async (tx, at) => await readAnalyticsPage(tx, at))
    expect(interactions.rows.map((row) => row.eventName)).toEqual([
      'cta_click',
      'service_viewed',
      'price_viewed',
    ])
    expect(interactions.rows.map((row) => row.events)).toEqual([7, 4, 2])
    // The control: the page_view rows ARE in the database, so their absence is the predicate rather
    // than the fixture.
    const [all] = await withCohort(
      async (tx) =>
        await tx<{ count: string }[]>`
          select count(*)::text as count from analytics.event where event_name = 'page_view'
        `,
    )
    expect(Number(all?.count ?? 0)).toBeGreaterThanOrEqual(9)
  }, 60_000)

  it('reports the funnel’s drop-off per step, with the first step empty', async () => {
    const funnel = await withCohort(async (tx, at) => await readFunnelPanel(tx, at))
    expect(funnel.rows.map((row) => row.droppedFromPrevious)).toEqual([null, 3, 2, 2, 2, 1, 1, 1])
    expect(funnel.conversion).toEqual({
      kind: 'rate',
      numerator: 3,
      denominator: 15,
      perMille: 200,
    })
    // The show-adjusted denominator subtracts the excluded confirmation from both sides.
    expect(funnel.showAdjusted).toEqual({
      kind: 'rate',
      numerator: 3,
      denominator: 4,
      perMille: 750,
    })
  }, 60_000)
})

describe('acceptance — fifteen contiguous hourly buckets in business-day order', () => {
  it('generates them from business_day, crossing midnight with no gap and no daytime bucket', async () => {
    const panel = await withCohort(async (tx, at) => await readTimeOfDayPanel(tx, at))
    expect(panel.buckets).toHaveLength(15)
    expect(panel.opensAtHour).toBe(11)
    expect(panel.closesAtHour).toBe(2)
    const hours = panel.buckets.map((bucket) => bucket.hour)
    // The SEQUENCE and not the set: a chart in calendar order holds the same fifteen hours.
    expect(hours).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1])
    for (const shut of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(hours, `${shut}:00 is outside the trading window`).not.toContain(shut)
    }
    // Every bucket has something in it, which is what makes "contiguous" a claim about data rather than
    // about a `generate_series` nobody joined anything to.
    expect(panel.buckets.every((bucket) => bucket.sessions === 1)).toBe(true)
  }, 60_000)
})

describe('acceptance — the data-quality strip', () => {
  it('shows both shares with their integers, and no rate where there is no denominator', async () => {
    const strip = await withCohort(async (tx, at) => await readDataQualityPanel(tx, at))
    expect(strip.refCapture).toEqual({
      kind: 'rate',
      numerator: 7,
      denominator: 19,
      perMille: 368,
    })
    expect(strip.gapSessions).toBe(1)
    expect(strip.preConsentLandings).toBeGreaterThanOrEqual(61n)
  }, 60_000)

  it("answers 'no data' rather than 0% for a trading date with no codes issued", async () => {
    // A second closed day, which the cohort writes nothing to — so its ref-capture denominator is a real
    // nought rather than one this test arranged by deleting rows.
    const [other] = await sql<{ tradingDate: string }[]>`
      select b.trading_date::text as "tradingDate"
        from public.business_day b
        left join analytics.daily_ref_capture r on r.trading_date = b.trading_date
       where b.closes_at <= now() and r.trading_date is null
       order by b.closes_at desc
       limit 1
    `
    if (other === undefined) throw new Error('every closed day already has a ref-capture row')
    const strip = await readDataQualityPanel(sql, { tradingDate: other.tradingDate })
    expect(strip.refCapture.kind).toBe('no_data')
    if (strip.refCapture.kind !== 'no_data') throw new Error('unreachable')
    expect(strip.refCapture.why).toContain('no ref code was issued')
  }, 60_000)
})

describe('acceptance — noindex, absent from every sitemap, and 403 for a role without report:read', () => {
  it('is in no sitemap, which is a property of the registry and not of a builder', () => {
    // `sitemapEntries` is the only source W-SITE-08's builder may read, so absence here is absence from
    // every sitemap the application can produce.
    expect(sitemapEntries().map((entry) => entry.path)).not.toContain('/analytics')
    expect(sitemapEntries().some((entry) => entry.path.startsWith('/analytics'))).toBe(false)
    // The control: the builder's source is not empty, so the assertion above is about something.
    expect(sitemapEntries().length).toBeGreaterThan(0)
  })

  it('redirects a request with no session, which is the guard and not this route', async () => {
    const response = await GET(new Request(`https://example.invalid/analytics?date=${tradingDate}`))
    expect(response.status).toBe(303)
  }, 30_000)

  it('refuses a request with no ?date, naming the parameter rather than defaulting', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      const response = await GET(request(principal.sessionToken, ''))
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('?date=YYYY-MM-DD')
      // Even the refusal carries the policy, because a 400 is still a response from an admin path.
      expect(response.headers.get(ROBOTS_HEADER)).toBe(NOINDEX_ROBOTS_TAG)
    } finally {
      await principal.cleanup()
    }
  }, 30_000)

  it('answers a role that holds report:read, with noindex on the response', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      const response = await GET(request(principal.sessionToken, `?date=${tradingDate}`))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get(ROBOTS_HEADER)).toBe(NOINDEX_ROBOTS_TAG)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const html = await response.text()
      expect(html).toContain(`data-trading-date="${tradingDate}"`)
      // Nine panels on the served bytes, not only on a render this file composed itself.
      expect([...html.matchAll(/data-panel="/g)]).toHaveLength(ANALYTICS_PANEL_IDS.length)
    } finally {
      await principal.cleanup()
    }
  }, 60_000)

  it('answers 403 to a receptionist and writes the denial to audit_event', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'receptionist' })
    try {
      // A DELTA and never a total: `audit_event` is append-only (ADR 0008), so a count would pass on a
      // fresh database and fail on the second run of this file.
      const before = await denialCount()
      const response = await GET(request(principal.sessionToken, `?date=${tradingDate}`))
      expect(response.status).toBe(403)
      expect(await response.text()).toContain(ANALYTICS_PERMISSION)
      expect(await denialCount()).toBe(before + 1)
      const [row] = await sql<{ actorId: string; operation: string; after: unknown }[]>`
        select actor_id::text as "actorId", operation, after_state as after
          from audit_event
         where action = 'analytics_dashboard.denied'
         order by occurred_at desc, id desc
         limit 1
      `
      expect(row?.operation).toBe('denied')
      expect(row?.actorId).toBe(principal.employeeId)
      expect(row?.after).toMatchObject({ role: 'receptionist', permission: ANALYTICS_PERMISSION })
    } finally {
      await principal.cleanup()
    }
  }, 60_000)

  it('writes NO denial for a role that is allowed, which is the control', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'manager' })
    try {
      const before = await denialCount()
      const response = await GET(request(principal.sessionToken, `?date=${tradingDate}`))
      expect(response.status).toBe(200)
      expect(await denialCount()).toBe(before)
    } finally {
      await principal.cleanup()
    }
  }, 60_000)
})

function request(token: string | null, query: string): Request {
  if (token === null) throw new Error('the fixture principal was minted without a session')
  return new Request(`https://example.invalid/analytics${query}`, {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` },
  })
}

async function denialCount(): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from audit_event where action = 'analytics_dashboard.denied'
  `
  return Number(row?.count ?? 0)
}

describe('acceptance — axe, and a pixel diff of zero on a second run', () => {
  beforeAll(async () => {
    const data = await withCohort(async (tx, at) => await readAnalyticsPage(tx, at))
    const source = {
      name: 'admin-analytics',
      html: (options: { direction: 'ltr' | 'rtl'; theme: 'light' | 'dark' }) =>
        renderAnalyticsPageHtml({
          chrome: {
            googleReauth: null,
            sendBacklog: null,
            role: 'owner' as const,
            returnTo: '/analytics',
          },
          data,
          direction: options.direction,
        }),
    }
    harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })
    captures = await harness.capture(source)
    // The SAME source rendered again, which is what "zero pixel diff on an unchanged rerun" is about:
    // the page is pure, so two renders are byte-identical and the images have to be too.
    recaptures = await harness.capture(source)
  }, 300_000)

  it('captures three viewports, two themes and two directions', () => {
    expect(captures).toHaveLength(VIEWPORTS.length * THEMES.length * DIRECTIONS.length)
    expect(captures).toHaveLength(12)
  })

  it('reports no serious or critical violation in any cell', () => {
    const blocking = captures.flatMap((capture) => blockingViolations(capture.violations))
    expect(blocking.map(describeViolation)).toEqual([])
  })

  it('produces byte-identical images on the second run', () => {
    expect(recaptures.map((capture) => hash(capture.png))).toEqual(
      captures.map((capture) => hash(capture.png)),
    )
  })

  it('renders every cell differently, so no axis of the matrix is decorative', () => {
    // The control. If light and dark, or LTR and RTL, produced the same bytes then the diff assertion
    // above would hold for a harness that was ignoring an axis.
    const hashes = captures.map((capture) => hash(capture.png))
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})

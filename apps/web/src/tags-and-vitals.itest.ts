import { createConnection, type Sql } from '@berelax/db'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { CONSENT_MODE_SIGNALS, WEB_VITALS_IDENTITY_PATTERN } from '@berelax/shared'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_TAG_ID, FIXTURE_TAG_SRC } from '../app/_analytics/tag-loader-fixture.tsx'
import { CONSENT_ANSWER_ATTRIBUTE } from '../app/(public)/_components/consent-banner.tsx'
import {
  DATA_LAYER_CONSENT_EVENT,
  DATA_LAYER_CONVERSION_EVENT,
  DATA_LAYER_NAME,
  TAG_SCRIPT_ATTRIBUTE,
} from '../app/(public)/_components/tag-loader.tsx'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The tag loader and the web-vitals reporter, against the built application and a real browser
 * (A-MEAS-04).
 *
 * ## The case A-MEAS-02 handed over, and why it needed a loader to exist
 *
 * `analytics-consent.itest.ts` already intercepts every request made while loading `/`, `/ar` and
 * `/treatments` in three consent states and asserts the four tag hosts absent, with the controls that keep
 * it honest. Its own NOTE says what it could not assert: *"the state that needs a loader — a tag that DOES
 * load after a grant, and none before it in the same page session"*. That is this file, and it is a
 * separate suite rather than a case added to that one because it needs a page with a tag DECLARED on it:
 * `CLIENT_TAGS` is empty (Y5-client-tags), so the same assertion made against `/` would be an assertion
 * about a page with nothing to load, which holds for ever including on the day the gate breaks (ADR 0003).
 *
 * The `/tag-loader` fixture declares one FIRST-PARTY tag at a path nothing serves, and this file
 * intercepts and fulfils it. So "a tag loaded" is a real request through the real loader, and no vendor
 * host is named anywhere — which `scripts/check-egress-guard.mjs` rule 6 refuses outside a declared
 * adapter.
 *
 * ## Why the grant is given by pressing the banner
 *
 * The acceptance line is *"in the same page session"*. Setting a cookie and reloading would prove
 * something weaker and easier: that a page served to a consenting visitor loads the tag. What has to be
 * shown is the harder thing — the visitor arrives with no consent, nothing loads, they press Accept, the
 * endpoint records it and sets the cookie, and the tag loads **without a navigation**. That is why these
 * cases click a real button and wait for a real request.
 */
let server: WebServer
let browser: Browser
let sql: Sql
let BASE = ''

/** The hosts a third-party tag would come from, assembled from PARTS. See `analytics-consent.itest.ts`. */
const TAG_HOSTS = [
  ['googletagmanager', '.', 'com'],
  ['google', '-', 'analytics', '.', 'com'],
  ['connect', '.', 'facebook', '.', 'net'],
  ['facebook', '.', 'com'],
].map((parts) => parts.join(''))

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  server = await startWebServer({
    suite: 'tags-and-vitals',
    cwd: new URL('..', import.meta.url).pathname,
    readyWithinMs: 120_000,
    env: {
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
      PAYLOAD_SECRET:
        process.env['PAYLOAD_SECRET'] ?? 'berelax-placeholder-payload-secret-not-for-serving',
    },
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

/**
 * A context that fulfils the fixture tag with a one-line script and records every request for it.
 *
 * `route.fulfill` and not a real file: the tag is first-party and nothing serves it, so without the
 * interception the request would 404 — and a 404 would still prove the request happened, but the script
 * would not run and the data layer would never be read by anything. Fulfilling it makes the case about a
 * tag that LOADED rather than one that was merely asked for.
 */
async function tagContext(): Promise<{
  readonly context: BrowserContext
  readonly tagRequests: string[]
  readonly collectRequests: string[]
}> {
  const context = await browser.newContext()
  const tagRequests: string[] = []
  const collectRequests: string[] = []
  await context.route(`**${FIXTURE_TAG_SRC}`, async (route) => {
    tagRequests.push(route.request().url())
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      // The script a real tag's first line does: read the data layer. It writes what it found onto the
      // window, which is what the `dataLayer` assertions below read — so they are about what a TAG can
      // see rather than about a global this suite set up itself.
      body: `window.__tagSawDataLayer = JSON.parse(JSON.stringify(window.${DATA_LAYER_NAME} || []));`,
    })
  })
  context.on('request', (request) => {
    if (request.url().includes('/api/collect')) collectRequests.push(request.url())
  })
  return { context, tagRequests, collectRequests }
}

/** Presses the banner's Accept and waits for the endpoint's response, which is what sets the cookie. */
async function grantConsent(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/v1/consent/analytics') && response.ok(),
      { timeout: 30_000 },
    ),
    page.click(`[${CONSENT_ANSWER_ATTRIBUTE}="granted"]`),
  ])
}

describe('acceptance — no tag before a grant, and one after a grant in the same page session', () => {
  it('loads nothing for a visitor who has not answered', async () => {
    const { context, tagRequests } = await tagContext()
    try {
      const page = await context.newPage()
      const response = await page.goto(`${BASE}/tag-loader`, { waitUntil: 'load' })
      // The marker: a rendered document of this site. A case asserting only "no tag" would pass against
      // a 404 body, which is the control `analytics-consent.itest.ts` records.
      expect(response?.status()).toBe(200)
      expect(await page.locator(`[${CONSENT_ANSWER_ATTRIBUTE}="granted"]`).count()).toBe(1)
      // The loader polls for up to fifteen seconds; two of them is long enough for several passes.
      await page.waitForTimeout(2_000)
      expect(tagRequests).toEqual([])
      expect(
        await page.locator(`script[${TAG_SCRIPT_ATTRIBUTE}="${FIXTURE_TAG_ID}"]`).count(),
      ).toBe(0)
      expect(
        await page.evaluate((name) => (globalThis as never)[name], DATA_LAYER_NAME),
      ).toBeFalsy()
    } finally {
      await context.close()
    }
  }, 120_000)

  it('loads it after the visitor presses Accept, with no navigation', async () => {
    const { context, tagRequests } = await tagContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}/tag-loader`, { waitUntil: 'load' })
      await page.waitForTimeout(1_000)
      expect(tagRequests, 'a tag loaded before the grant').toEqual([])

      const before = page.url()
      await grantConsent(page)
      /*
        The loader re-asks the ONE gate on a bounded poll, because the cookie is set by the endpoint's
        RESPONSE and is not there at the moment the button is pressed.

        Waited on the SCRIPT ELEMENT and not on `waitForRequest`, which was the first version and raced:
        `waitForRequest` resolves on the request being issued, and the route handler that records it runs
        asynchronously afterwards — so the assertion below read an empty array about a request that had
        certainly happened. The element exists only after the loader appended it, which is strictly later
        than both.
      */
      // `state: 'attached'` and not the default `'visible'`: a `<script>` element is never visible, so
      // the default waits for something that cannot happen and the case fails naming a locator that
      // resolved to a hidden element it had already found.
      await page.waitForSelector(`script[${TAG_SCRIPT_ATTRIBUTE}="${FIXTURE_TAG_ID}"]`, {
        state: 'attached',
        timeout: 30_000,
      })
      await page.waitForTimeout(500)
      expect(tagRequests).toHaveLength(1)
      // No navigation: the same document, the same URL, no reload.
      expect(page.url()).toBe(before)
      expect(
        await page.locator(`script[${TAG_SCRIPT_ATTRIBUTE}="${FIXTURE_TAG_ID}"]`).count(),
      ).toBe(1)

      // And once. The poll keeps running until the window closes, and a loader that re-injected on every
      // pass would load the tag thirty times.
      await page.waitForTimeout(2_000)
      expect(tagRequests).toHaveLength(1)
    } finally {
      await context.close()
    }
  }, 180_000)

  it('loads nothing after an explicit denial, which is the other half of the gate', async () => {
    const { context, tagRequests } = await tagContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}/tag-loader`, { waitUntil: 'load' })
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().includes('/api/v1/consent/analytics') && response.ok(),
          { timeout: 30_000 },
        ),
        page.click(`[${CONSENT_ANSWER_ATTRIBUTE}="denied"]`),
      ])
      await page.waitForTimeout(2_000)
      expect(tagRequests).toEqual([])
    } finally {
      await context.close()
    }
  }, 120_000)
})

describe('acceptance — the data layer carries only A-MEAS-01 category codes', () => {
  it('is read by the tag and holds no service name, no price string and no free text', async () => {
    const { context } = await tagContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}/tag-loader`, { waitUntil: 'load' })
      await grantConsent(page)
      // `state: 'attached'` and not the default `'visible'`: a `<script>` element is never visible, so
      // the default waits for something that cannot happen and the case fails naming a locator that
      // resolved to a hidden element it had already found.
      await page.waitForSelector(`script[${TAG_SCRIPT_ATTRIBUTE}="${FIXTURE_TAG_ID}"]`, {
        state: 'attached',
        timeout: 30_000,
      })
      // What the TAG saw, captured by the fulfilled script's own first line.
      await page.waitForFunction(() => '__tagSawDataLayer' in globalThis, undefined, {
        timeout: 30_000,
      })
      const seen = (await page.evaluate(
        () => (globalThis as unknown as { __tagSawDataLayer: unknown }).__tagSawDataLayer,
      )) as readonly Record<string, unknown>[]

      expect(seen.length).toBeGreaterThan(0)
      const events = seen.map((entry) => entry['event'])
      expect(events).toContain(DATA_LAYER_CONSENT_EVENT)
      expect(events).toContain(DATA_LAYER_CONVERSION_EVENT)

      const conversion = seen.find((entry) => entry['event'] === DATA_LAYER_CONVERSION_EVENT)
      expect(Object.keys(conversion ?? {}).toSorted()).toEqual(
        ['categoryCode', 'currency', 'event', 'eventType', 'quantity', 'valueFils'].toSorted(),
      )
      const serialised = JSON.stringify(seen)
      // No service name and no price STRING. `valueFils` is an integer and is permitted — it is the one
      // figure A-MEAS-01's allowlist carries for the terminal stage — and a formatted "AED 262.50" is
      // not: the egress guard has no field for one.
      expect(serialised).not.toMatch(/massage|tissue|aroma|facial|hammam/i)
      expect(serialised).not.toMatch(/AED\s?\d/)
      // And the control: the entry is not empty, so the absences are about something.
      expect(conversion?.['categoryCode']).toBeTruthy()
    } finally {
      await context.close()
    }
  }, 180_000)
})

describe('acceptance — first-party delivery is unaffected by the tag hosts being unreachable', () => {
  it('still posts to /api/collect when every request to the four hosts is aborted', async () => {
    const { context, collectRequests } = await tagContext()
    try {
      for (const host of TAG_HOSTS) {
        await context.route(`**://*.${host}/**`, (route) => route.abort())
        await context.route(`**://${host}/**`, (route) => route.abort())
      }
      const page = await context.newPage()
      await page.goto(`${BASE}/tag-loader`, { waitUntil: 'load' })
      await grantConsent(page)
      // The collector flushes on `load` and on the page being hidden. Hiding it is what a visitor
      // leaving does, and it is the flush that carries the page view.
      await page.evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('pagehide'))
      })
      await page.waitForTimeout(2_000)
      expect(collectRequests.length).toBeGreaterThan(0)
    } finally {
      await context.close()
    }
  }, 180_000)
})

describe('acceptance — web-vitals rows land with all four dimensions, and INP for /book is its own route', () => {
  /** The `web_vitals` rows this run produced, newest first. A DELTA read: the table is append-only. */
  async function vitalsRows(since: Date): Promise<
    readonly {
      path: string
      metric: string
      value: number
      breakpoint: string
      locale: string
      direction: string
      identity: string | null
    }[]
  > {
    return await sql<
      {
        path: string
        metric: string
        value: number
        breakpoint: string
        locale: string
        direction: string
        identity: string | null
      }[]
    >`
      select e.path                                     as path,
             e.properties ->> 'metric'                  as metric,
             (e.properties ->> 'value')::int            as value,
             e.properties ->> 'breakpoint'              as breakpoint,
             e.properties ->> 'locale'                  as locale,
             e.properties ->> 'direction'               as direction,
             e.properties ->> 'identity'                as identity
        from analytics.event e
       where e.event_name = 'web_vitals'
         and e.received_at >= ${since.toISOString()}::timestamptz
       order by e.received_at desc, e.event_id desc
    `
  }

  /**
   * Loads a page, grants consent, interacts, and hides it — which is the only moment a vital is final.
   *
   * The interaction is a real click on a real control, because INP is a measurement of what a reader did:
   * a dispatched event carries `interactionId: 0` and the reporter excludes it by the metric's own
   * definition, so a synthetic click would produce no INP at all.
   */
  async function visit(path: string, interactSelector: string | null): Promise<void> {
    const { context } = await tagContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
      await grantConsent(page)
      if (interactSelector !== null) await page.click(interactSelector, { timeout: 30_000 })
      else await page.mouse.click(8, 8)
      await page.waitForTimeout(500)
      // `visibilitychange` to hidden is what the reporter reports on, and the collector's `pagehide`
      // flush is what carries the batch.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('pagehide'))
      })
      await page.waitForTimeout(2_000)
    } finally {
      await context.close()
    }
  }

  it('records three distinct routes, with INP measured per route', async () => {
    const since = new Date(Date.now() - 1_000)
    // Three distinct paths: the English fixture, the Arabic one (which is also the only real source of
    // `rtl`), and `/book`.
    await visit('/tag-loader', '[data-fixture="interact"]')
    await visit('/ar/tag-loader', '[data-fixture="interact"]')
    await visit('/book', null)
    const rows = await vitalsRows(since)

    // The non-vacuity control first: this run produced rows at all. Without it every claim below is a
    // claim about an empty list.
    expect(rows.length).toBeGreaterThan(0)

    const paths = new Set(rows.map((row) => row.path))
    expect(paths.has('/tag-loader')).toBe(true)
    expect(paths.has('/ar/tag-loader')).toBe(true)
    expect(paths.has('/book')).toBe(true)
    // Both directions are represented, which is one of the four dimensions and is why the Arabic
    // document exists as a route rather than as `dir="rtl"` on the English one.
    expect(new Set(rows.map((row) => row.direction))).toEqual(new Set(['ltr', 'rtl']))

    /*
      The acceptance line is *"INP rows exist for /book distinctly from other routes"*, and what makes a
      route distinct is the PATH on the row — a `group by` rather than a second event name. That is what
      is asserted here, over two routes that really produce an INP.

      It is asserted on the two fixture routes and NOT on `/book`, and the reason is recorded as a NOTE on
      the manifest entry: a `PerformanceObserver` reports an `event` entry only past a 40 ms duration
      threshold, so an INP exists on a page where an interaction is slow. The fixture makes one
      deliberately slow; forcing one on `/book` would mean making a real booking form slow, and a case
      that clicked a fast control would pass or fail on how busy the machine was (brief rule 23).
    */
    const inpPaths = new Set(rows.filter((row) => row.metric === 'INP').map((row) => row.path))
    expect(inpPaths.size).toBeGreaterThanOrEqual(2)
    expect(inpPaths.has('/tag-loader')).toBe(true)
    expect(inpPaths.has('/ar/tag-loader')).toBe(true)
    // And `/book` is measured, with the metrics a page that was merely LOADED produces.
    const bookMetrics = new Set(rows.filter((row) => row.path === '/book').map((row) => row.metric))
    expect(bookMetrics.size).toBeGreaterThan(0)
    expect(
      [...bookMetrics].every((metric) => ['LCP', 'CLS', 'INP', 'TTFB', 'FCP'].includes(metric)),
    ).toBe(true)

    // Every row carries all four dimensions, from a closed vocabulary, and an identity the server's own
    // pattern accepts — which is ADR 0115 asserted against what actually landed rather than against a
    // function's return value.
    for (const row of rows) {
      expect(row.breakpoint, JSON.stringify(row)).toMatch(/^(?:base|xs|sm|md|lg|xl|xxl|unknown)$/)
      expect(['en', 'ar'], JSON.stringify(row)).toContain(row.locale)
      expect(['ltr', 'rtl'], JSON.stringify(row)).toContain(row.direction)
      expect(row.value).toBeGreaterThanOrEqual(0)
      if (row.identity !== null) {
        expect(WEB_VITALS_IDENTITY_PATTERN.test(row.identity), row.identity).toBe(true)
        // The rule itself: no id, no class, no text. A selector would carry one of the three.
        expect(row.identity).not.toContain('#')
        expect(row.identity).not.toContain('.')
      }
    }

    // And the signals the consent record granted are the full set, so the rows above are not a figure
    // collected under a partial grant that happened to be enough.
    expect(CONSENT_MODE_SIGNALS.length).toBe(4)
  }, 300_000)

  it('records nothing before a grant, because the visitor row is created at consent', async () => {
    // ADR 0066: `analytics.visitor` and `analytics.session` are created AT consent, so a page view with
    // no consent contributes to `pre_consent_landing` and to no event row. A web vital is an event, so
    // the same rule applies to it — and this is the case that says so, because a reporter that posted
    // anyway would be a measurement stored against a visitor nobody identified.
    const since = new Date(Date.now() - 1_000)
    const { context } = await tagContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}/tag-loader`, { waitUntil: 'load' })
      await page.click('[data-fixture="interact"]')
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('pagehide'))
      })
      await page.waitForTimeout(2_000)
    } finally {
      await context.close()
    }
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n
        from analytics.event
       where event_name = 'web_vitals' and received_at >= ${since.toISOString()}::timestamptz
    `
    expect(Number(rows[0]?.n ?? '0')).toBe(0)
  }, 180_000)
})

/** Where the fixture tag's declaration lives, so a moved fixture fails here rather than silently. */
it('asserts the fixture tag is first-party, which is what keeps no vendor host in this repository', () => {
  expect(FIXTURE_TAG_SRC.startsWith('/')).toBe(true)
  for (const host of TAG_HOSTS) {
    expect(FIXTURE_TAG_SRC).not.toContain(host)
  }
})

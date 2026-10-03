import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tradingDayBuckets } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { installAdminBrowserCookie, installAdminCookie } from '@berelax/harness/admin-session'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_SESSION_COOKIE } from '../src/session-cookie.ts'

/**
 * R-REP-08 — the role-scoped dashboard in a real browser.
 *
 * The claims here are the ones no substring assertion can make: axe needs a rendered DOM, and a pixel
 * diff needs two renders of one page. The ROWS — the scope in the query, the forbidden columns absent
 * from the serialised payload, the drill-down identity, the export's audit row and its alert — are
 * `apps/web/src/dashboards.itest.ts`'s, and that file's header says why the split is two files: `next
 * start` serves whatever `.next` was last built, so a suite driving the handler over HTTP asserts
 * against a stale build on every commit that did not rebuild.
 *
 * The band `dashboards` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## Why `.itest.ts` and not `.spec.ts`
 *
 * The manifest names this file `dashboards.spec.ts`. `vitest.integration.config.ts` includes
 * `apps/**` then `/*.itest.ts` (written apart because the two together close this comment, and a
 * zero-width space between them is what `pnpm invisibles` refuses — CVE-2021-42574) and nothing
 * else, so a `.spec.ts` here would be a suite nothing runs — which is
 * worse than no suite, because it would look like coverage. The two files already in this directory,
 * `collector.itest.ts` and `walk-in-speed.itest.ts`, are the convention.
 *
 * ## It writes NOTHING, deliberately
 *
 * The window is a seeded trading day with no appointment, document, journal entry or shift on it. Three
 * things follow, and the third is the reason:
 *
 *   * the trading buckets still come from `reporting.dim_date`, which the seed populates, so the
 *     contiguity claim is about real hours;
 *   * the tiles render a figure of nought, which for a day with no deliveries is the correct figure and
 *     not a refusal — `room_occupied_minutes` over no appointments really is zero minutes;
 *   * **nothing has to be cleaned up.** `journal_entry` refuses DELETE for every role including the
 *     owner (ZL001), so a committed probe would double every figure on a second run — M-TILL-10's
 *     recorded defect — and a browser cannot see an uncommitted one. A read-only suite has neither
 *     problem. The only row it creates is its own principal, which `FixturePrincipal.cleanup` removes.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (brief rule 12), so the day is SEARCHED FOR rather than fixed: a date another suite has posted into
 * would make the figures move between runs and the pixel diff fail for a reason that proves nothing.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const PATH = '/reports'
const SCREENS = join(new URL('../../../artifacts/screens', import.meta.url).pathname)

let sql: Sql
let server: WebServer | undefined
let browser: Browser
let adminPrincipal: FixturePrincipal | undefined
let restoreAdminFetch: () => void = () => {}
let restoreAdminBrowser: () => void = () => {}
let BASE = ''
/** The quiet trading day and its own open window, read off `business_day`. */
let day = { tradingDate: '', openMinutes: 0, opensAtHour: 0 }

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // The views are created against an empty `business_day` and `pnpm seed` runs afterwards, so on a
  // fresh database they hold nothing until a pass runs. `reporting.refresh_run` is append-only (ZY184)
  // and every claim this file makes is about the page rather than about that table.
  await sql`select * from reporting.refresh_all('nightly')`

  const [row] = await sql<{ tradingDate: string; openMinutes: number; opensAtHour: number }[]>`
    select d.trading_date::text                                        as "tradingDate",
           (extract(epoch from (d.closes_at - d.opens_at)) / 60)::int   as "openMinutes",
           extract(hour from (d.opens_at at time zone 'Asia/Dubai'))::int as "opensAtHour"
      from business_day d
     where not exists (select 1 from appointment a where a.trading_date = d.trading_date)
       and not exists (select 1 from invoice i where i.tax_point_date = d.trading_date)
       and not exists (select 1 from journal_entry e where e.entry_date = d.trading_date)
       and not exists (select 1 from shift s where s.trading_date = d.trading_date)
     order by d.trading_date
     offset 20 limit 1
  `
  if (row === undefined) {
    throw new Error(
      'no trading date in business_day is free of appointments, documents, journal entries and shifts. ' +
        '`pnpm seed` writes 149 trading days (brief rule 24).',
    )
  }
  day = row

  server = await startWebServer({
    suite: 'dashboards',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: PATH,
    readyWithinMs: 90_000,
    env: {
      // This route calls `loadConfig()`, so the two values it needs are declared rather than assumed.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  // The session, before anything is fetched and before the browser is launched:
  // `installAdminBrowserCookie` patches `chromium.launch`, so it has to run first.
  adminPrincipal = await createFixturePrincipal(sql, { role: 'owner' })
  const adminToken = adminPrincipal.sessionToken ?? ''
  restoreAdminFetch = installAdminCookie({
    origin: BASE,
    cookie: `${ADMIN_SESSION_COOKIE}=${adminToken}`,
  })
  restoreAdminBrowser = installAdminBrowserCookie(chromium, {
    origin: BASE,
    name: ADMIN_SESSION_COOKIE,
    token: adminToken,
  })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 180_000)

afterAll(async () => {
  restoreAdminFetch()
  restoreAdminBrowser()
  await adminPrincipal?.cleanup()
  await browser?.close()
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
  readonly direction: 'ltr' | 'rtl'
}

/** Three viewports x two themes x two directions. The phone, the front desk and the laptop. */
const CELLS: readonly Cell[] = (['light', 'dark'] as const).flatMap((theme) =>
  (['ltr', 'rtl'] as const).flatMap((direction) =>
    [
      { width: 390, height: 844 },
      { width: 768, height: 1024 },
      { width: 1440, height: 900 },
    ].map((viewport) => ({ ...viewport, theme, direction })),
  ),
)

const urlFor = (cell: Cell): string =>
  `${BASE}${PATH}?from=${day.tradingDate}&to=${day.tradingDate}` +
  // The instant is FIXED, so two renders of this page are the same bytes. The page prints the instant
  // it was read at, and a page printing `new Date()` could not be photographed twice.
  `&at=${encodeURIComponent('2026-09-25T06:00:00.000Z')}` +
  (cell.direction === 'rtl' ? '&dir=rtl' : '')

async function withCell<T>(cell: Cell, body: (page: Page) => Promise<T>): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: cell.direction === 'rtl' ? 'ar-AE' : 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(urlFor(cell), { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    const answer = await body(page)
    // A broken listener would otherwise arrive as a timeout waiting for an attribute, which names the
    // assertion rather than the cause.
    expect(pageErrors, `${cell.theme} ${cell.width} ${cell.direction}`).toEqual([])
    return answer
  } finally {
    await context.close()
  }
}

const DESK: Cell = { width: 1440, height: 900, theme: 'light', direction: 'ltr' }

describe('acceptance — the trading window renders as contiguous buckets in business-day order', () => {
  it('draws one element per hour, in document order, including the empty ones', async () => {
    const expected = tradingDayBuckets({
      opensAtHour: day.opensAtHour,
      openMinutes: day.openMinutes,
    })
    const drawn = await withCell(DESK, (page) =>
      page.$$eval('[data-bucket-hour]', (nodes) =>
        nodes.map((node) => ({
          hour: Number(node.getAttribute('data-bucket-hour')),
          index: Number(node.getAttribute('data-bucket-index')),
          empty: node.getAttribute('data-bucket-empty'),
        })),
      ),
    )
    // Document order IS the claim: the hours run forward across midnight, so 00:00 and 01:00 are last.
    expect(drawn.map((bucket) => bucket.hour)).toEqual(expected.map((bucket) => bucket.startHour))
    expect(drawn.map((bucket) => bucket.index)).toEqual(expected.map((bucket) => bucket.index))
    // Fifteen on the standard seeded day, and whatever the day's own hours give on an override.
    expect(drawn.length).toBe(expected.length)
    // The window has no deliveries on it, so every bucket is empty — which is what makes the
    // contiguity claim about the WINDOW rather than about which hours happened to have a treatment.
    expect(drawn.every((bucket) => bucket.empty === 'true')).toBe(true)
    const flag = await withCell(DESK, (page) =>
      page.getAttribute('[data-buckets-contiguous]', 'data-buckets-contiguous'),
    )
    expect(flag).toBe('true')
  }, 300_000)
})

describe('acceptance — axe reports zero serious or critical violations', () => {
  it('audits every cell of the matrix', async () => {
    const violations = []
    for (const cell of CELLS) {
      const result = await withCell(cell, (page) =>
        auditPage(page, {
          page: PATH,
          viewport: {
            name: String(cell.width),
            width: cell.width,
            height: cell.height,
            scale: 1,
            why: 'the dashboard matrix',
          },
          theme: cell.theme,
          direction: cell.direction,
        }),
      )
      violations.push(...blockingViolations(result.violations))
    }
    expect(violations.map(describeViolation)).toEqual([])
  }, 900_000)

  it('reports the two defects a known-bad version of this page has, by rule id', async () => {
    // The control on the audit itself: a sweep reporting zero because axe never ran would pass the case
    // above for ever (ADR 0003). An unlabelled button and body text on the decorative gold are the two
    // failures docs/08 fences off.
    const violations = await withCell(DESK, async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Export these rows'
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: `${PATH} (known-bad)`,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
  }, 300_000)
})

describe('acceptance — the same dashboard photographed twice is byte-identical', () => {
  it('captures 3 viewports x 2 themes x 2 directions with zero pixel diff between the runs', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `dashboards__${cell.theme}-${cell.width}__${cell.direction}`
      /*
        Through `captureUntilStable` rather than comparing capture one to capture two, because that
        also asserts paint had settled by the first capture. The page reads from a database and prints
        an instant; the instant is pinned with `?at=` and the window with `?from=`/`?to=`, so the only
        thing that could differ between two renders is paint.
      */
      const stable = await captureUntilStable(
        () =>
          withCell(cell, (page) =>
            page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
          ),
        { label },
      )
      expect(stable.png.byteLength, label).toBeGreaterThan(1000)
      expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
      shots.set(label, stable.png)
      writeFileSync(join(SCREENS, `${label}.png`), stable.png)
    }
    expect(shots.size).toBe(12)
    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function that returned the same bytes every time would pass every assertion above.
    const differs = (a: string, b: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(a) ?? new Uint8Array()),
        Buffer.from(shots.get(b) ?? new Uint8Array()),
      )
    expect(differs('dashboards__light-390__ltr', 'dashboards__dark-390__ltr')).not.toBe(0)
    expect(differs('dashboards__light-390__ltr', 'dashboards__light-1440__ltr')).not.toBe(0)
    expect(differs('dashboards__light-390__ltr', 'dashboards__light-390__rtl')).not.toBe(0)
  }, 900_000)
})

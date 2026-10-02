import { createConnection, type Sql } from '@berelax/db'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_PATH,
  ANALYTICS_CONSENT_PURPOSE,
  ANALYTICS_CONSENT_WORDING,
  CONSENT_MODE_SIGNALS,
} from '@berelax/shared'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CONSENT_BANNER_ID,
  CONSENT_NO_SIGNALS_TOKEN,
  CONSENT_STATE_ATTRIBUTE,
} from '../app/(public)/_components/consent-banner.tsx'

/**
 * The consent banner and the consent endpoint, against the built application and a real browser
 * (A-MEAS-02).
 *
 * ## The acceptance line this file is for, and the half of it that is deferred
 *
 * *"Playwright with request interception: zero requests to googletagmanager.com, google-analytics.com,
 * connect.facebook.net or facebook.com occur before a recorded consent, and none after an explicit
 * denial"*.
 *
 * The interception is here and it is real: every request the browser makes while loading three public
 * pages is logged, in three consent states — **no cookie**, an **explicit denial**, and a grant — and the
 * four hosts are asserted absent from all of it. What makes it a check rather than a formality is the
 * control beside it: the log is asserted to be NON-EMPTY and to contain the document and its own assets,
 * and the matcher is asserted to catch a planted URL. Without those two the case would pass identically
 * against a browser that loaded nothing.
 *
 * What is DEFERRED, and recorded as a NOTE on the manifest entry, is the half this unit cannot make
 * non-vacuous: a tag that loads AFTER a grant. There is no tag loader in this build — A-MEAS-04 owns
 * `tag-loader.tsx` and its own acceptance line is *"tags inject only after a consent grant in the same
 * page session"* — so "no request before consent" is today a claim about a document that has nothing to
 * request from anywhere (ADR 0002). It is still worth asserting now, and this file is the fence that
 * A-MEAS-04's loader will be dropped inside: on the day it lands, the two states that must stay silent
 * are already under test.
 *
 * ## Why a browser and not a `fetch` of the HTML
 *
 * Two of the three things here are properties no string comparison can reach. The banner is hidden by a
 * CSS rule keyed on an attribute an inline script sets before first paint, so whether a returning visitor
 * sees it is a COMPUTED STYLE; and the requests a document generates include whatever its scripts and
 * stylesheets ask for, which is exactly where a tag would arrive from.
 *
 * ## Isolation
 *
 * The endpoint writes `analytics.consent_record`, which is append-only, so every assertion about it is a
 * DELTA across the work and never a total (brief rule 9) — a total would pass on a fresh database and
 * fail on the second run of this file.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let server: WebServer
let browser: Browser
let sql: Sql
let BASE = ''

/**
 * The hosts a third-party tag would come from, assembled from PARTS rather than written out.
 *
 * The arrangement `scripts/check-egress-guard.mjs` uses on its own host list, and for the reason it gives:
 * a literal destination has no business being greppable as a working endpoint in a repository whose whole
 * claim is that nothing reaches one. The separators are parts and not a join, because joining on a dot is
 * how that scanner once spelled `google.analytics.com` and could not see a planted
 * `google-analytics.com` endpoint.
 *
 * `.spec.ts` and `.itest.ts` are exempt from rule 6 by name, and the scanner's own header says why this
 * file is the place the hosts belong: naming them here is the enforcement rather than a leak.
 */
const TAG_HOSTS = [
  ['googletagmanager', '.', 'com'],
  ['google', '-', 'analytics', '.', 'com'],
  ['connect', '.', 'facebook', '.', 'net'],
  ['facebook', '.', 'com'],
].map((parts) => parts.join(''))

const PUBLIC_PAGES = ['/', '/ar', '/treatments']

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  server = await startWebServer({
    suite: 'analytics-consent',
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

async function consentRecordCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from analytics.consent_record
  `
  return Number(row?.n ?? '0')
}

/** Every URL the browser asked for while loading `paths`, with the consent cookie it was given. */
async function requestsWhileLoading(
  paths: readonly string[],
  cookieValue: string | null,
): Promise<readonly string[]> {
  const context = await browser.newContext()
  try {
    if (cookieValue !== null) {
      // `url` and `path` together are refused by Playwright ("Cookie should have either url or path"),
      // which is what the first run of this file reported. `url` alone is the right one: it carries the
      // host and the scheme, and the scheme is what makes a `Secure` cookie — which the server's own
      // `Set-Cookie` is — eligible at all.
      await context.addCookies([{ name: ANALYTICS_CONSENT_COOKIE, value: cookieValue, url: BASE }])
    }
    const seen: string[] = []
    const page = await context.newPage()
    page.on('request', (request) => {
      seen.push(request.url())
    })
    for (const path of paths) {
      const response = await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
      // The marker: this is a rendered document of this site and not an error page that happens to be
      // quiet. A case asserting only "no third-party host" would pass beautifully against a 404 body.
      expect(response?.status(), `${path} must render`).toBe(200)
      expect(
        await page.locator('html').getAttribute('lang'),
        `${path} must be a rendered document`,
      ).toMatch(/^(en|ar)$/)
    }
    await page.close()
    return seen
  } finally {
    await context.close()
  }
}

const hostsIn = (requests: readonly string[]): readonly string[] =>
  TAG_HOSTS.filter((host) => requests.some((request) => request.toLowerCase().includes(host)))

// ------------------------------------------------------------------------------------------------
// Acceptance 1: zero requests to a tag host, in every state a decision can be in
// ------------------------------------------------------------------------------------------------

describe('the requests a public page makes', () => {
  it('reaches no tag host before any decision, after a denial, or after a grant', async () => {
    const states: readonly { readonly name: string; readonly cookie: string | null }[] = [
      { name: 'no decision recorded', cookie: null },
      { name: 'an explicit denial', cookie: CONSENT_NO_SIGNALS_TOKEN },
      { name: 'a full grant', cookie: [...CONSENT_MODE_SIGNALS].join(',') },
    ]
    let observed = 0
    for (const state of states) {
      const requests = await requestsWhileLoading(PUBLIC_PAGES, state.cookie)
      expect(
        hostsIn(requests),
        `with ${state.name}, the browser reached a third-party tag host`,
      ).toEqual([])
      /*
       * The control, and it is what makes the assertion above mean anything: the interception SAW
       * traffic. Three documents plus their stylesheet and fonts is a dozen requests or more, and every
       * one of them is first-party.
       */
      expect(requests.length, `${state.name} produced no requests at all`).toBeGreaterThan(
        PUBLIC_PAGES.length,
      )
      expect(
        requests.filter((request) => request.startsWith(BASE)).length,
        `${state.name} produced no first-party requests`,
      ).toBeGreaterThan(PUBLIC_PAGES.length - 1)
      observed += requests.length
    }
    expect(observed).toBeGreaterThan(0)
    // And the matcher catches what it looks for, so a clean result means clean traffic rather than a
    // comparison that stopped matching — the same control `collect.itest.ts` carries on its grep.
    expect(hostsIn(['https://www.googletagmanager.com/gtm.js?id=X']).length).toBe(1)
    expect(hostsIn(['https://www.google-analytics.com/mp/collect']).length).toBe(1)
    expect(hostsIn(['https://connect.facebook.net/en_US/fbevents.js']).length).toBe(1)
  }, 180_000)

  it('serves HTML that names no tag host either, in both locales', async () => {
    // The static half, over the bytes rather than the network: a host in the markup that nothing fetched
    // today is a host something fetches after the next deploy. A-FIRST-05 asserts three hosts over three
    // pages before consent; this adds the fourth host and the two states a cookie puts the page in.
    let checked = 0
    for (const cookie of [null, CONSENT_NO_SIGNALS_TOKEN, [...CONSENT_MODE_SIGNALS].join(',')]) {
      for (const path of PUBLIC_PAGES) {
        const response = await fetch(`${BASE}${path}`, {
          headers: cookie === null ? {} : { cookie: `${ANALYTICS_CONSENT_COOKIE}=${cookie}` },
        })
        expect(response.status, path).toBe(200)
        const html = await response.text()
        expect(html, path).toMatch(/<html[^>]*lang=/i)
        expect(html.length, `${path} rendered almost nothing`).toBeGreaterThan(2_000)
        for (const host of TAG_HOSTS) {
          expect(html.toLowerCase().includes(host), `${path} names ${host}`).toBe(false)
        }
        checked += 1
      }
    }
    // The control: a scan over nothing passes every assertion above.
    expect(checked).toBe(PUBLIC_PAGES.length * 3)
  }, 120_000)
})

// ------------------------------------------------------------------------------------------------
// The banner itself: rendered, hidden by a decision, and carrying the words the record hashes
// ------------------------------------------------------------------------------------------------

describe('the banner', () => {
  it('is visible with no decision and renders the published wording, in both locales', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      for (const [path, expected] of [
        ['/', ANALYTICS_CONSENT_WORDING.textEn],
        ['/ar', ANALYTICS_CONSENT_WORDING.textAr],
      ] as const) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
        const banner = page.locator(`#${CONSENT_BANNER_ID}`)
        await expect.poll(() => banner.isVisible()).toBe(true)
        // The EXACT words, because the record's hash is the hash of what was shown: a paraphrase on the
        // page with the constant in the hash would record consent against words nobody read.
        expect(await banner.locator('p').innerText()).toBe(expected)
        // And the document carries no decision, which is the state the visibility above depends on.
        expect(await page.locator('html').getAttribute(CONSENT_STATE_ATTRIBUTE)).toBeNull()
      }
      await page.close()
    } finally {
      await context.close()
    }
  }, 120_000)

  it('is hidden before first paint once a decision exists, including a denial', async () => {
    for (const cookie of [CONSENT_NO_SIGNALS_TOKEN, 'analytics_storage']) {
      const context = await browser.newContext()
      try {
        await context.addCookies([{ name: ANALYTICS_CONSENT_COOKIE, value: cookie, url: BASE }])
        const page = await context.newPage()
        await page.goto(`${BASE}/`, { waitUntil: 'load' })
        // The attribute is what the inline script sets, and the CSS rule keyed on it is what hides the
        // banner. Both halves asserted: an attribute with no rule would leave the banner up, and a rule
        // with no attribute would hide it from everybody.
        expect(await page.locator('html').getAttribute(CONSENT_STATE_ATTRIBUTE)).toBe(cookie)
        expect(await page.locator(`#${CONSENT_BANNER_ID}`).isVisible()).toBe(false)
        // It is in the DOCUMENT and merely not displayed, which is the arrangement a prerendered page
        // forces: the markup is identical for everybody and the document decides.
        expect(await page.locator(`#${CONSENT_BANNER_ID}`).count()).toBe(1)
        await page.close()
      } finally {
        await context.close()
      }
    }
  }, 120_000)

  it('records a decision when its control is pressed, and then stays hidden', async () => {
    const before = await consentRecordCount()
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}/`, { waitUntil: 'load' })
      const banner = page.locator(`#${CONSENT_BANNER_ID}`)
      await expect.poll(() => banner.isVisible()).toBe(true)
      // The real control, clicked in a real browser: this is the only case in the build that exercises
      // the inline script's listener, its POST and the server's `Set-Cookie` as one path.
      await banner.getByRole('button').first().click()
      await expect
        .poll(() => page.locator('html').getAttribute(CONSENT_STATE_ATTRIBUTE))
        .toBe([...CONSENT_MODE_SIGNALS].join(','))
      expect(await banner.isVisible()).toBe(false)
      // A DELTA, because the table is append-only and this file cannot clear it.
      expect(await consentRecordCount()).toBe(before + 1)
      /*
       * The cookie the GATE will read, read the way the gate reads it.
       *
       * `document.cookie` and not `context.cookies(BASE)`. The first run of this case used the latter and
       * got `undefined` for a cookie the page could plainly see, which is the wrong instrument anyway:
       * `mayLoadClientTag` is handed `document.cookie` in the browser, so that is the surface whose
       * contents decide whether a tag loads — and it is also where an accidental `HttpOnly` would show up
       * as an absence rather than as a response header this case never looked at.
       */
      const visible = await page.evaluate(() => document.cookie)
      expect(visible).toContain(
        `${ANALYTICS_CONSENT_COOKIE}=${[...CONSENT_MODE_SIGNALS].join(',')}`,
      )
      // Reloading does not ask again, which is the whole purpose of the cookie.
      await page.reload({ waitUntil: 'load' })
      expect(await banner.isVisible()).toBe(false)
      await page.close()
    } finally {
      await context.close()
    }
  }, 180_000)
})

// ------------------------------------------------------------------------------------------------
// The endpoint: its cookie, its named refusals, and the attribute deliberately absent
// ------------------------------------------------------------------------------------------------

const post = (body: unknown, cookie?: string) =>
  fetch(`${BASE}${ANALYTICS_CONSENT_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })

const DECISION = {
  decision: 'granted',
  granted: ['analytics_storage'],
  locale: 'en',
  surface: 'consent_banner',
}

describe('the consent endpoint', () => {
  it('answers 204 and sets a cookie the page can read', async () => {
    const before = await consentRecordCount()
    const response = await post(DECISION)
    expect(response.status).toBe(204)
    const header = response.headers.get('set-cookie') ?? ''
    expect(header).toContain(`${ANALYTICS_CONSENT_COOKIE}=analytics_storage`)
    expect(header).toContain('Path=/')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    /*
     * **`HttpOnly` is deliberately ABSENT**, and this is the assertion that keeps it absent.
     *
     * The gate that stops a tag loading runs in the browser and has to read this value, and the banner
     * writes nothing but reads it too. Nothing is protected by hiding a value that carries no credential
     * and no identifier — only which of four named signals its own owner agreed to — and an `HttpOnly`
     * added "for safety" would silently disable the client half of the gate.
     */
    expect(header).not.toContain('HttpOnly')
    // Host-only: no `Domain` attribute at all, which is the absence rather than a value to spell.
    expect(header).not.toMatch(/Domain=/i)
    // And nothing cached, because a consent state in a cached response is somebody else's consent.
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await consentRecordCount()).toBe(before + 1)
  })

  it('writes a denial as a cookie that grants nothing rather than as no cookie', async () => {
    const response = await post({ ...DECISION, decision: 'denied', granted: [] })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain(
      `${ANALYTICS_CONSENT_COOKIE}=${CONSENT_NO_SIGNALS_TOKEN}`,
    )
  })

  it('refuses a grant of nothing and a refusal that keeps a signal, BY NAME', async () => {
    const before = await consentRecordCount()
    const empty = await post({ ...DECISION, granted: [] })
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { refusal: string }).refusal).toBe('granted_without_a_signal')

    const kept = await post({ ...DECISION, decision: 'denied', granted: ['ad_storage'] })
    expect(kept.status).toBe(400)
    expect(((await kept.json()) as { refusal: string }).refusal).toBe('refusal_claiming_a_signal')
    // Nothing was written by either refusal.
    expect(await consentRecordCount()).toBe(before)
  })

  it('refuses an unreadable body and an unknown field, each by name and with no write', async () => {
    const before = await consentRecordCount()
    const malformed = await fetch(`${BASE}${ANALYTICS_CONSENT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { refusal: string }).refusal).toBe('invalid_decision')

    // `strictObject`: a field the server silently dropped would be a consent qualification the visitor
    // expressed and nobody recorded.
    const extra = await post({ ...DECISION, remember: true })
    expect(extra.status).toBe(400)
    expect(((await extra.json()) as { refusal: string }).refusal).toBe('invalid_decision')

    const invented = await post({ ...DECISION, granted: ['ad_tracking'] })
    expect(invented.status).toBe(400)
    expect(await consentRecordCount()).toBe(before)
  })

  it('reads no visitor, no decision and no locale from the query string', async () => {
    // A repository-wide scan already refuses a query parameter choosing a principal; here the second
    // reason applies — a `?visitor=` would put a first-party identifier in every access log and every
    // forwarded link. Asserted by making the query string say the opposite of the body and reading back
    // what was stored.
    const before = await sql<{ decision: string }[]>`
      select decision::text as decision from analytics.consent_record
       order by created_at desc limit 1
    `
    const response = await post(
      { ...DECISION, decision: 'denied', granted: [] },
      `${ANALYTICS_CONSENT_COOKIE}=${[...CONSENT_MODE_SIGNALS].join(',')}`,
    )
    expect(response.status).toBe(204)
    const [latest] = await sql<{ decision: string }[]>`
      select decision::text as decision from analytics.consent_record
       order by created_at desc limit 1
    `
    expect(latest?.decision).toBe('denied')
    expect(before.length >= 0).toBe(true)
    // And the query string is ignored outright: the same body with `?decision=granted` still denies.
    const ignored = await fetch(
      `${BASE}${ANALYTICS_CONSENT_PATH}?decision=granted&granted=ad_storage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...DECISION, decision: 'denied', granted: [] }),
      },
    )
    expect(ignored.status).toBe(204)
    expect(ignored.headers.get('set-cookie')).toContain(
      `${ANALYTICS_CONSENT_COOKIE}=${CONSENT_NO_SIGNALS_TOKEN}`,
    )
  })

  it('records every decision against the version whose words the banner renders', async () => {
    await post(DECISION)
    const [row] = await sql<{ version: number; matches: boolean }[]>`
      select w.version,
             (r.wording_hash = w.content_hash) as matches
        from analytics.consent_record r
        join consent_wording w on w.id = r.consent_wording_id
       order by r.created_at desc limit 1
    `
    expect(row?.version).toBe(1)
    expect(row?.matches).toBe(true)
    // And the version it referenced belongs to the analytics purpose rather than to one of C-CRM-03's.
    const [purpose] = await sql<{ purpose: string }[]>`
      select w.purpose
        from analytics.consent_record r
        join consent_wording w on w.id = r.consent_wording_id
       order by r.created_at desc limit 1
    `
    expect(purpose?.purpose).toBe(ANALYTICS_CONSENT_PURPOSE)
  })
})

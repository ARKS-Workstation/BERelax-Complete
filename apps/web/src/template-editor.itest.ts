import { ARABIC_150 } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WORKED_EXAMPLE_BODY } from '../app/(admin)/messaging/templates/editor/render.ts'

/**
 * C-AUTO-02's last acceptance line, driven against the built application.
 *
 * "Playwright: the template editor reports UCS-2, 3 segments and a non-zero fils cost for the docs/04
 * section 5 worked example of a 150-character Arabic body, **updating on input**; that example is a
 * committed test case."
 *
 * Everything except the words "updating on input" is asserted without a browser by
 * `apps/web/src/template-editor-render.test.ts`, because the rendering is pure. This file exists for the
 * two claims that only a real browser can settle: the figures are replaced **in the same document** when
 * an author types, and the page they are replaced on has no serious or critical accessibility violation.
 *
 * ## No database
 *
 * The editor reads no row. That is a property of the surface rather than a shortcut — it prices a body and
 * writes nothing — so the probe path is the route itself, and a slow or absent database cannot present as
 * a server that never started.
 */

let BASE = ''
let server: WebServer
let browser: Browser

beforeAll(async () => {
  server = await startWebServer({
    suite: 'template-editor',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/messaging/templates/editor',
    readyWithinMs: 90_000,
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
})

const PATH = '/messaging/templates/editor'

async function withPage<T>(body: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    await page.goto(`${BASE}${PATH}`, { waitUntil: 'networkidle' })
    return await body(page)
  } finally {
    await context.close()
  }
}

/** The three figures the acceptance line names, read from the rendered DOM. */
async function figures(page: Page): Promise<Record<string, string>> {
  const entries = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-figure]')].map((node) => [
        node.getAttribute('data-figure'),
        node.textContent,
      ]),
    ),
  )
  return entries as Record<string, string>
}

describe('acceptance — the worked example is the committed one', () => {
  it('is the same 150-character Arabic body the fixtures package commits', () => {
    // Two spellings of one example is two examples. `packages/fixtures` seeds messages with ARABIC_150
    // and the inbox itest asserts the stored cost of it; this screen has to be pricing the same body.
    expect(WORKED_EXAMPLE_BODY).toBe(ARABIC_150)
    expect(WORKED_EXAMPLE_BODY).toHaveLength(150)
  })
})

describe('acceptance — the route answers HTML, noindex, and the figures', () => {
  it('serves the editor with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy: `/messaging` is a prefix in ADMIN_GROUP_PREFIXES, so the
    // screens W-SYS-01 adds beside this one arrive noindex rather than needing to be remembered.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const html = await response.text()
    expect(html).toContain('data-figure="encoding">UCS-2<')
    expect(html).toContain('data-figure="segments">3<')
    expect(html).toContain('data-figure="cost">90 fils<')
  }, 60_000)

  it('prices a posted body without JavaScript, which is where the figures come from', async () => {
    // The progressive-enhancement path, and the control on the claim that the browser computes nothing:
    // the numbers arrive from the server for a form submission with no script involved at all.
    const response = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: 'Your appointment is confirmed for 8pm.' }),
    })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('data-figure="encoding">GSM-7<')
    expect(html).toContain('data-figure="segments">1<')
    expect(html).toContain('data-figure="cost">12 fils<')
  }, 60_000)

  it('answers the JSON the inline script asks for, and refuses a body that is not text', async () => {
    const priced = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: ARABIC_150 }),
    })
    expect(priced.status).toBe(200)
    expect(await priced.json()).toMatchObject({
      encoding: 'UCS-2',
      segments: '3',
      cost: '90 fils',
    })
    // The refusal, because `String(42)` would price "42" as if somebody had typed it. 400 rather than
    // 500: the only input here is the caller's own.
    const refused = await fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 42 }),
    })
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain('must be a string')
  }, 60_000)
})

describe('acceptance — the figures update on input', () => {
  it('repaints UCS-2, 3 segments and a non-zero cost as the body changes, in one document', async () => {
    await withPage(async (page) => {
      // What the acceptance line asks for, on load.
      const initial = await figures(page)
      expect(initial['encoding']).toBe('UCS-2')
      expect(initial['segments']).toBe('3')
      expect(initial['cost']).toBe('90 fils')
      expect(Number.parseInt(initial['cost'] ?? '', 10)).toBeGreaterThan(0)
      // Nothing has been repainted yet: the figures above are the server's, so a script that never ran
      // could not be mistaken for one that did.
      expect(await page.getAttribute('html', 'data-preview-renders')).toBe('0')

      // Typing an English body over it. `fill` dispatches `input`, which is the event the page listens
      // for — no button is pressed and no form is submitted.
      await page.fill('#body', 'Your appointment is confirmed for 8pm.')
      await page.waitForFunction(
        () => document.querySelector('[data-figure="encoding"]')?.textContent === 'GSM-7',
      )
      const english = await figures(page)
      expect(english['segments']).toBe('1')
      expect(english['cost']).toBe('12 fils')
      expect(english['forced']).toContain('inside the GSM-7 alphabet')

      // And the single Arabic character that is the whole of docs/04 §5: one character, and the body is
      // UCS-2 again at 70 characters a segment rather than 160.
      await page.fill('#body', 'Your appointment is confirmed for 8pm. م')
      await page.waitForFunction(
        () => document.querySelector('[data-figure="encoding"]')?.textContent === 'UCS-2',
      )
      const flipped = await figures(page)
      expect(flipped['segments']).toBe('1')
      expect(flipped['forced']).toBe('م')
      expect(flipped['cost']).toBe('30 fils')
      // Every figure is repainted, including the split. A server-rendered one would still be describing
      // the 150-character Arabic body the page opened on, under numbers that had moved on.
      expect(flipped['split']).toBe('one segment — nothing is split')

      // In the SAME document: the counter would be back to zero after a navigation, and the page never
      // submitted the form.
      // Two paints for two changes, exactly: `fill` dispatches one `input` event, and an equality rather
      // than a floor is also the assertion that the sequence guard is not painting a stale answer on top
      // of a fresh one.
      expect(await page.getAttribute('html', 'data-preview-renders')).toBe('2')
      // Nothing failed on the way: the script records a fetch failure rather than leaving stale figures
      // on screen, and a stale figure is the one thing this page must not show.
      expect(await page.getAttribute('html', 'data-preview-error')).toBeNull()
    })
  }, 120_000)

  it('leaves the figures alone when the body does not change, which is the control', async () => {
    // Without this, a page that painted the same three values on any event would pass the case above.
    await withPage(async (page) => {
      await page.fill('#body', 'a'.repeat(161))
      await page.waitForFunction(
        () => document.querySelector('[data-figure="segments"]')?.textContent === '2',
      )
      const two = await figures(page)
      expect(two['encoding']).toBe('GSM-7')
      expect(two['cost']).toBe('24 fils')
      // One character fewer is one segment and half the price, which is the decision this screen exists
      // to put in front of somebody.
      await page.fill('#body', 'a'.repeat(160))
      await page.waitForFunction(
        () => document.querySelector('[data-figure="segments"]')?.textContent === '1',
      )
      expect((await figures(page))['cost']).toBe('12 fils')
    })
  }, 120_000)
})

describe('acceptance — axe reports nothing serious or critical', () => {
  it('audits the editor, and the same audit catches a deliberately broken control', async () => {
    await withPage(async (page) => {
      const clean = await auditPage(page, {
        page: PATH,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'C-AUTO-02 acceptance' },
        theme: 'light',
        direction: 'ltr',
      })
      expect(blockingViolations(clean.violations).map(describeViolation)).toEqual([])

      // The control on the audit itself. A sweep that reported zero because axe never ran would pass the
      // assertion above for ever (ADR 0003), so the same page is audited again with an unlabelled button
      // in it.
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
      })
      const broken = await auditPage(page, {
        page: `${PATH} (known-bad)`,
        viewport: { name: '1440', width: 1440, height: 900, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      expect(broken.violations.map((violation) => violation.id)).toContain('button-name')
    })
  }, 180_000)
})

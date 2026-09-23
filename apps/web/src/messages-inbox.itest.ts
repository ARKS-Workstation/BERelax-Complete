import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, createPostgresMessageStore, type Sql } from '@berelax/db'
import { ARABIC_150, type SeededMessagingFixture, seedMessagingFixture } from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-MSG-04 — the admin Messages inbox, driven against the built application.
 *
 * Three claims live here and nowhere else, because none of them can be checked by reading source: the
 * route answers HTML with the noindex header the registry says it carries, **axe** reports nothing
 * serious or critical on a rendered DOM, and the same route photographed twice produces **byte-identical
 * images** — which is what "zero pixel diff on a repeat run" means for a page whose content comes out of
 * a database.
 *
 * ## Why three viewports and two themes, and no direction axis
 *
 * The inbox is a route handler serving one English document, and that is a decision rather than an
 * omission: W-SITE-01's registry requires every *document* to be served in both locales, so a `page.tsx`
 * would need an Arabic admin document and the W-SYS-01 shell — see the route's own header, and
 * G-CONN-05's NOTE for the same call one directory along. The acceptance criterion asks for 3 x 2 for
 * exactly that reason. The twelve-cell matrix with its RTL half belongs to the public routes.
 *
 * ## Isolation
 *
 * The inbox reader is global by design — an admin opens it to see everything — so every assertion here
 * narrows it with `?template=` to this run's own seeded rows. `message` cannot be cleaned up: a receipt
 * is the evidence for a status, `message_delivery_receipt` refuses DELETE and its foreign key is ON
 * DELETE RESTRICT. Narrowing is the isolation (CONTRIBUTING-AGENT-BRIEF §12), and it is also what makes
 * the screenshots deterministic: a page showing every message in a shared database would diff the moment
 * another unit sent one.
 */

/** A port from the same range as the other web itests, chosen at random for the same reason. */
/**
 * Assigned in `beforeAll`, because the port is ACQUIRED rather than drawn — see
 * `packages/harness/src/server.ts`. This file used `stdio: 'ignore'`, so a collision here threw the
 * child's own explanation away and reported only that it had exited.
 */
let BASE = ''
const SCREENS = new URL('../../../artifacts/screens', import.meta.url).pathname

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`

let server: WebServer
let browser: Browser
let sql: Sql
let fixture: SeededMessagingFixture
/** The URL under test: this run's rows only. */
let path: string
/**
 * The same inbox, narrowed to this run's email template.
 *
 * A second path rather than one page showing both, because the reader takes one template key — and the
 * HTML preview pane is the thing this page exists to prove, so it is audited and photographed on its own
 * rather than below four SMS rows where a 390px screenshot would not reach it.
 */
let emailPath: string

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const store = createPostgresMessageStore(sql)
  fixture = await seedMessagingFixture(sql, store, RUN)
  // A delivered receipt and an unrecognised one, so the screenshot shows both halves of the receipts
  // table: what the vendor said, and what this system made of it.
  const [first] = fixture.messages
  if (first === undefined) throw new Error('The fixture seeded no messages')
  await store.applyReceipt({
    vendor: 'smsala',
    providerMessageId: first.providerMessageId,
    vendorStatus: 'delivered',
    mapped: 'delivered',
    occurredAtIso: '2099-03-01T08:00:12.000Z',
    reason: null,
  })
  await store.applyReceipt({
    vendor: 'smsala',
    providerMessageId: first.providerMessageId,
    vendorStatus: 'DELIVRD',
    mapped: null,
    occurredAtIso: '2099-03-01T08:00:20.000Z',
    reason: null,
  })
  path = `/settings/messages?template=${encodeURIComponent(fixture.smsTemplateKey)}`
  emailPath = `/settings/messages?template=${encodeURIComponent(fixture.emailTemplateKey)}`

  server = await startWebServer({
    suite: 'messages-inbox',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/settings/messages',
    readyWithinMs: 90_000,
    env: {
      // This route calls `loadConfig()`, which is the first web itest to drive one that does — the OTP
      // route's tests build their handler in process with `parseConfig`. So the two values it needs are
      // declared here rather than assumed: CI exports both, and a local run that exported only
      // TEST_DATABASE_URL would otherwise get a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      // The database the fixture seeded, which is not necessarily the one DATABASE_URL names.
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  // The shared list, not a hand-written one: `--disable-skia-runtime-opts` and `--disable-lcd-text` are
  // what make the repeat capture below byte-identical, and this file used to launch without them. See
  // `packages/harness/src/determinism.ts`.
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
}

/** Three viewports x two themes. The phone, the front desk and the laptop; light and dark. */
const CELLS: readonly Cell[] = (['light', 'dark'] as const).flatMap((theme) =>
  [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ].map((viewport) => ({ ...viewport, theme })),
)

async function withCell<T>(
  cell: Cell,
  body: (page: Page) => Promise<T>,
  pagePath: string = path,
): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
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
    await page.goto(`${BASE}${pagePath}`, { waitUntil: 'networkidle' })
    // The harness's determinism CSS, for the reason `determinism.ts` gives: this file asserts a
    // byte-identical repeat capture and used to launch and render without any of it.
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/**
 * The rendered background, as the engine resolved it.
 *
 * Read rather than asserted against a literal: a hex or `rgb()` in this file would be an un-tokened
 * colour and `pnpm colours` would reject it, rightly — the token layer is the only place a literal
 * belongs. The claim is the one that matters anyway: the dark cell really is darker than the light one,
 * so the theme axis is a rendered difference rather than a filename.
 */
async function backgroundLuminance(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const colour = globalThis.getComputedStyle(document.body).backgroundColor
    const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  })
}

describe('acceptance — the route answers HTML, noindex, and shows the send', () => {
  it('serves the inbox with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${path}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy, not hand-written per route: `/settings/messages` is inside
    // the admin group's prefix, exactly like the two Google routes beside it.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const html = await response.text()
    // The fixture's own rows, and the numbers the acceptance criterion asks to be visible.
    expect(html).toContain(fixture.smsTemplateKey)
    expect(html).toContain('UCS-2')
    expect(html).toContain('27 fils')
    expect(html).toContain('Nothing here left the building')
    // The vendor's word and the mapping, both.
    expect(html).toContain('DELIVRD')
    expect(html).toContain('vendor_status_unrecognised')
    // The Arabic body is rendered as Arabic, not as escapes.
    expect(html).toContain(ARABIC_150.slice(0, 20))
    // The control on the filter: a template nobody sent renders the designed empty state rather than a
    // page of somebody else's messages.
    const empty = await fetch(`${BASE}/settings/messages?template=nothing-${RUN}`)
    expect(await empty.text()).toContain('No messages recorded yet')
  }, 120_000)

  it('renders the HTML part of a Resend email in a sandboxed preview pane', async () => {
    const response = await fetch(`${BASE}${emailPath}`)
    expect(response.status).toBe(200)
    const html = await response.text()
    // The pane, and what makes it safe to show: no script, no form, no origin, and one document.
    expect(html).toContain('<iframe class="preview" sandbox=""')
    expect(html).toContain('title="HTML preview of Your tax invoice"')
    // The bytes Resend was given, escaped into the attribute rather than injected into this page.
    expect(html).toContain('srcdoc="&lt;!doctype html&gt;')
    expect(html).toContain('email via resend')
    // Email is not segment-billed, which is the other half of the same row.
    expect(html).toContain('>Segments</dt><dd>0<')
    expect(html).toContain('>Cost</dt><dd>0 fils<')
    // The control: the SMS page has no pane at all, so the iframe belongs to the email row rather than
    // to the layout.
    const sms = await fetch(`${BASE}${path}`)
    expect(await sms.text()).not.toContain('<iframe')
  }, 60_000)

  it('drops an unknown status filter rather than pretending to apply it, and bounds the limit', async () => {
    const key = encodeURIComponent(fixture.smsTemplateKey)
    const ignored = await fetch(`${BASE}/settings/messages?template=${key}&status=posted`)
    const ignoredHtml = await ignored.text()
    // `posted` is not one of the four statuses. It is dropped, and the page says what it IS showing —
    // a filtered view that quietly is not filtered is worse than an error.
    expect(ignoredHtml).not.toContain('status posted')
    expect(ignoredHtml).toContain(`template ${fixture.smsTemplateKey}`)
    // The control: a status that IS in the set is applied and named.
    const applied = await fetch(`${BASE}/settings/messages?template=${key}&status=delivered`)
    const appliedHtml = await applied.text()
    expect(appliedHtml).toContain('status delivered')
    expect(appliedHtml).toContain('>Messages listed</dt><dd>1<')
    // The limit is bounded, so an unbounded read cannot be asked for from the address bar.
    const bounded = await fetch(`${BASE}/settings/messages?template=${key}&limit=99999`)
    expect(await bounded.text()).toContain('newest 200')
  }, 60_000)
})

describe('acceptance — axe reports nothing serious or critical, in six renders', () => {
  it('audits 390/768/1440 x light/dark, and each render is the cell it claims to be', async () => {
    // Six, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over three renders.
    expect(CELLS).toHaveLength(6)
    const luminance: Record<string, number> = {}
    const audited: string[] = []
    for (const cell of CELLS) {
      const label = `${cell.theme} ${cell.width}px`
      const { violations, width, lum } = await withCell(cell, async (page) => {
        const result = await auditPage(page, {
          page: '/settings/messages',
          viewport: {
            name: `${cell.width}`,
            width: cell.width,
            height: cell.height,
            scale: 1,
            why: 'B-MSG-04 acceptance',
          },
          theme: cell.theme,
          direction: 'ltr',
        })
        return {
          violations: result.violations,
          width: await page.evaluate(() => globalThis.innerWidth),
          lum: await backgroundLuminance(page),
        }
      })
      expect(width, `${label}: viewport`).toBe(cell.width)
      luminance[label] = lum
      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${label}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      audited.push(label)
    }
    expect(audited).toHaveLength(6)
    // The theme axis is real: the dark cell resolved a darker ground at every width. Without this, six
    // identical light renders would satisfy every assertion above.
    for (const width of [390, 768, 1440]) {
      expect(luminance[`dark ${width}px`], `dark ${width}px is darker than light`).toBeLessThan(
        luminance[`light ${width}px`] ?? 0,
      )
    }
  }, 600_000)

  it('audits the preview pane itself, where an untitled frame would be a violation', async () => {
    // The iframe is the one element on this surface that axe has a rule of its own for, and it is the
    // element the acceptance criterion names. Two cells rather than six: the pane is not responsive, and
    // the six-cell sweep above already covers the page around it.
    for (const cell of [
      { width: 390, height: 844, theme: 'light' as const },
      { width: 1440, height: 900, theme: 'dark' as const },
    ]) {
      const { violations, frames } = await withCell(
        cell,
        async (page) => ({
          violations: (
            await auditPage(page, {
              page: '/settings/messages (email)',
              viewport: {
                name: `${cell.width}`,
                width: cell.width,
                height: cell.height,
                scale: 1,
                why: 'B-MSG-04 preview pane',
              },
              theme: cell.theme,
              direction: 'ltr',
            })
          ).violations,
          frames: await page.evaluate(() => document.querySelectorAll('iframe').length),
        }),
        emailPath,
      )
      // The pane really is on the page, so a clean audit is not a clean audit of nothing.
      expect(frames, `${cell.theme} ${cell.width}px`).toBe(1)
      expect(
        blockingViolations(violations).map(describeViolation),
        `${cell.theme} ${cell.width}px`,
      ).toEqual([])
    }
  }, 300_000)

  it('reports the two defects a known-bad version of this page has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the
    // test above for ever (ADR 0003), so the same route is audited again with an unlabelled button and
    // body text on the decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const violations = await withCell({ width: 390, height: 844, theme: 'light' }, async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Resend this message'
        // The decorative gold on the sand surface: 2.90:1, and the reason --color-decor-gold never
        // carries text. Read from the token layer rather than typed, so this file states no colour.
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: '/settings/messages (known-bad)',
        viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 120_000)
})

describe('acceptance — the same route photographed twice is byte-identical', () => {
  it('captures 3 viewports x 2 themes twice, with zero pixel diff between the runs', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `${cell.theme}-${cell.width}`
      /*
        The claim is about the PAGE: it renders from a database, and a document printing a relative time or
        a generated id could not render identically twice. Through `captureUntilStable` rather than
        comparing capture one to capture two, because that also asserts paint had settled by the first
        capture — untrue at load 10 on a four-core box, where this flapped a byte at a time while passing
        in isolation every time. The helper throws `[screenshot-never-stabilised]` when no two CONSECUTIVE
        captures ever agree, which is exactly what a clock in the render produces.
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
      writeFileSync(join(SCREENS, `messages-inbox__${label}__ltr.png`), stable.png)
    }
    expect(shots.size).toBe(6)

    // The preview pane, photographed twice as well: an iframe is the part of this page most likely to
    // render differently on a second pass, because it is a second document.
    const shoot = () =>
      withCell(
        { width: 390, height: 844, theme: 'light' },
        (page) => page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
        emailPath,
      )
    const previewOne = await shoot()
    const previewTwo = await shoot()
    writeFileSync(join(SCREENS, 'messages-inbox-email__light-390__ltr.png'), previewOne)
    expect(Buffer.compare(Buffer.from(previewOne), Buffer.from(previewTwo))).toBe(0)
    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function that returned the same bytes every time would pass every assertion above.
    expect(
      Buffer.compare(
        Buffer.from(shots.get('light-390') ?? new Uint8Array()),
        Buffer.from(shots.get('dark-390') ?? new Uint8Array()),
      ),
    ).not.toBe(0)
    expect(
      Buffer.compare(
        Buffer.from(shots.get('light-390') ?? new Uint8Array()),
        Buffer.from(shots.get('light-1440') ?? new Uint8Array()),
      ),
    ).not.toBe(0)
  }, 600_000)
})

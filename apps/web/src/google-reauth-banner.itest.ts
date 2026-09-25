import {
  type ConnectionSnapshot,
  deriveConnectionHealth,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type Instant,
  instantFromIso,
  type ReauthBannerView,
  reauthBannerFor,
} from '@berelax/core'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderCredentialsHtml } from '../app/(admin)/hr/credentials/render.ts'
import { renderReassignmentQueueHtml } from '../app/(admin)/hr/reassignment/render.ts'
import { renderInboxHtml } from '../app/(admin)/settings/messages/render.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * G-CONN-08 — the banner, in a browser, on three admin documents.
 *
 * ## Why a browser is the only place two of these claims can be made
 *
 * *"The DOM contains no dismiss control within it"* is an ABSENCE claim, and absence is what a substring
 * assertion gets wrong: `expect(html).not.toContain('<button')` is satisfied by a `<button>` inside an HTML
 * comment, by an element the page's own CSS has collapsed to nothing, and by a document that failed to
 * render at all. `querySelectorAll(...).length === 0` against a parser, beside a positive control, is the
 * claim.
 *
 * And *"non-dismissible"* is not only about controls. A banner in the document with `display: none` on it is
 * dismissed as thoroughly as one that was removed, and no assertion over source text can see it — the rule
 * might be in the page's own stylesheet, in a token, in a media query. So this file asks the BROWSER: the
 * element has a non-zero box, `visibility` is `visible`, `opacity` is `1`, and it is inside the viewport's
 * scroll height. The known-bad control adds exactly that `display: none` and requires the check to fail.
 *
 * ## Why no server, and therefore no port band
 *
 * Every renderer here is pure — rows and sentences in, a document out — so `page.setContent` renders the
 * exact bytes the route serves. No `next start`, no port to draw, no temp root to leave behind (brief rules
 * 18 and 19), which is the arrangement `google-connection-card.itest.ts` and `manage-booking.itest.ts`
 * already use. `packages/harness/src/ports.ts` is NOT touched by this unit and this suite declares no band;
 * a band declared and unused fails `apps/web/src/test-ports.test.ts` by name.
 *
 * ## Why these three documents
 *
 * The acceptance line asks for three sampled admin routes. These three are the ones whose views are cheap
 * enough to build by hand, which keeps this file a claim about the BANNER rather than about a diary's axes
 * or a compliance calendar's occurrences. That every one of the ten admin documents renders it is asserted
 * in `google-reauth-banner.test.ts` by walking the filesystem, which is the stronger direction: it fails for
 * a document that does not exist yet.
 */

const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
}

/** Three viewports and two themes. No direction axis — there is no Arabic admin route to photograph. */
const CELLS: readonly Cell[] = [390, 768, 1440].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => ({
    width,
    height: width === 390 ? 844 : 900,
    theme,
  })),
)

let browser: Browser

beforeAll(async () => {
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 120_000)

afterAll(async () => {
  await browser.close()
})

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    status: 'active',
    consentAt: (NOW - 30 * DAY) as Instant,
    lastOkAt: (NOW - HOUR) as Instant,
    grantedScopes: [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    capabilities: [
      { capability: 'gbp_reviews', health: 'ok' },
      { capability: 'gsc', health: 'ok' },
    ],
    consentScreenInTesting: false,
    gbpAccessGranted: true,
    ...overrides,
  }
}

const bannerFor = (overrides: Partial<ConnectionSnapshot>): ReauthBannerView | null =>
  reauthBannerFor({
    health: deriveConnectionHealth(snapshot(overrides), NOW),
    connectionId: 'connection-gconn08-itest',
    // `.invalid` is reserved by RFC 2606, so a fixture address can never become a real one, and the local
    // part is a ROLE rather than a person (brief rule 10).
    googleEmail: 'google-admin@example.invalid',
  })

const chrome = (banner: ReauthBannerView | null, returnTo: string): AdminChrome => ({
  googleReauth: banner,
  returnTo,
})

/**
 * The three documents, each built from the cheapest view that renders.
 *
 * Empty lists on purpose: what is under test is the chrome, and rows would make every assertion below
 * depend on a fixture nobody is asserting about.
 */
function documents(banner: ReauthBannerView | null): readonly { name: string; html: string }[] {
  return [
    {
      name: '/settings/messages',
      html: renderInboxHtml({
        chrome: chrome(banner, '/settings/messages'),
        entries: [],
        filter: { templateKey: null, recipient: null, status: null, limit: 50 },
        smsProvider: 'fake',
        emailProvider: 'fake',
      }),
    },
    {
      name: '/hr/credentials',
      html: renderCredentialsHtml({
        chrome: chrome(banner, '/hr/credentials'),
        rows: [],
        profileVersion: 1,
        mandatoryTypes: [],
        nonExpiringTypes: [],
        expiringSoonDays: 60,
        evaluatedAtIso: '2026-09-25T10:00:00.000Z',
      }),
    },
    {
      name: '/hr/reassignment',
      html: renderReassignmentQueueHtml({
        chrome: chrome(banner, '/hr/reassignment'),
        entries: [],
        readAtIso: '2026-09-25T10:00:00.000Z',
      }),
    },
  ]
}

async function inPage<T>(html: string, body: (page: Page) => Promise<T>, cell?: Cell): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell?.width ?? 1440, height: cell?.height ?? 900 },
    deviceScaleFactor: 1,
    colorScheme: cell?.theme ?? 'light',
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/** What the browser says about the banner: is it there, is it visible, and can anything dismiss it. */
const inspect = (page: Page) =>
  page.evaluate(() => {
    const banner = document.querySelector('[data-google-reauth]')
    if (banner === null) return null
    const style = globalThis.getComputedStyle(banner)
    const box = banner.getBoundingClientRect()
    return {
      state: banner.getAttribute('data-google-reauth'),
      dismissible: banner.getAttribute('data-dismissible'),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      width: box.width,
      height: box.height,
      // Every kind of control a person could press, inside the banner. Counted rather than matched, so a
      // second one is as visible as a first.
      controls: banner.querySelectorAll('details, summary, button, input, form, [role="button"]')
        .length,
      // Anything that could remove it without a click.
      scripts: document.querySelectorAll('script').length,
      hidden: banner.hasAttribute('hidden') || banner.getAttribute('aria-hidden'),
      // The one link it does carry.
      reconnect:
        banner.querySelector('a[data-action="reconnect-google"]')?.getAttribute('href') ?? null,
      text: banner.textContent ?? '',
      // Inside a landmark, so a screen reader reaches it by navigating regions rather than by reading all.
      insideMain: document.querySelector('main [data-google-reauth]') !== null,
    }
  })

describe('acceptance — with status=broken the banner is present on three admin documents', () => {
  it('renders on all three, in the same state, with no dismiss control in any of them', async () => {
    const broken = bannerFor({ status: 'needs_reauth' })
    let checked = 0
    for (const document of documents(broken)) {
      const seen = await inPage(document.html, inspect)
      expect(seen, `${document.name}: no banner in the parsed DOM`).not.toBeNull()
      if (seen === null) continue
      expect(seen.state, document.name).toBe('broken')
      expect(seen.dismissible, document.name).toBe('false')
      // THE assertion. Zero controls of any kind, asserted against a parser rather than against a string.
      expect(seen.controls, `${document.name}: ${seen.controls} control(s) inside the banner`).toBe(
        0,
      )
      expect(seen.hidden, document.name).toBeFalsy()
      // No script anywhere in the document, so nothing can remove it after the fact. These admin documents
      // ship no client bundle, and this is where that becomes a property rather than a habit.
      expect(seen.scripts, `${document.name}: ${seen.scripts} script(s)`).toBe(0)
      expect(seen.insideMain, `${document.name}: the banner is outside <main>`).toBe(true)
      expect(seen.text).toContain('Needs re-authorising')
      expect(seen.text).toContain('nothing is lost')
      expect(seen.reconnect, document.name).toContain('returnTo=')
      checked += 1
    }
    // Counted, because a loop over an empty list passes every assertion inside it.
    expect(checked).toBe(3)
  }, 180_000)

  it('is laid out with a real box, at every viewport and in both themes', async () => {
    // The claim a substring assertion cannot make: the element is not merely in the document, it is on the
    // screen. A `display: none` in the page's own stylesheet — in a token, in a media query, added by
    // somebody tidying — is a dismissal, and this is what sees it.
    const broken = bannerFor({ status: 'needs_reauth' })
    const [first] = documents(broken)
    if (first === undefined) throw new Error('no documents')
    let measured = 0
    for (const cell of CELLS) {
      const seen = await inPage(first.html, inspect, cell)
      const where = `${cell.width} ${cell.theme}`
      expect(seen, where).not.toBeNull()
      if (seen === null) continue
      expect(seen.display, where).not.toBe('none')
      expect(seen.visibility, where).toBe('visible')
      expect(seen.opacity, where).toBe('1')
      expect(seen.width, `${where}: zero width`).toBeGreaterThan(100)
      expect(seen.height, `${where}: zero height`).toBeGreaterThan(20)
      measured += 1
    }
    expect(measured).toBe(6)
  }, 300_000)

  it('is caught when the page hides it, which is the control on the measurement above', async () => {
    // The known-bad fixture for the visibility check (ADR 0003). Without it, a measurement that never ran
    // would report a pass for ever — and this is the exact dismissal the acceptance line forbids.
    const broken = bannerFor({ status: 'needs_reauth' })
    const [first] = documents(broken)
    if (first === undefined) throw new Error('no documents')
    const hidden = await inPage(first.html, async (page) => {
      await page.addStyleTag({ content: '.google-reauth { display: none !important; }' })
      return await inspect(page)
    })
    expect(hidden?.display).toBe('none')
    expect(hidden?.height).toBe(0)
  }, 120_000)

  it('is absent on the same three documents when the connection is healthy', async () => {
    // The control on presence. Without it, a renderer that emitted the banner unconditionally would satisfy
    // every assertion above — and a red band on every admin page of a working business is its own defect.
    let checked = 0
    for (const document of documents(null)) {
      const seen = await inPage(document.html, inspect)
      expect(seen, `${document.name}: a banner on a healthy connection`).toBeNull()
      checked += 1
    }
    expect(checked).toBe(3)
  }, 180_000)
})

describe('acceptance — with status=degraded the banner carries a dismiss control', () => {
  it('renders exactly one, and it is a native collapse that records nothing', async () => {
    const degraded = bannerFor({
      capabilities: [{ capability: 'gsc', health: 'permission_missing' }],
    })
    const [first] = documents(degraded)
    if (first === undefined) throw new Error('no documents')
    // The context is kept open here rather than going through `inPage`, because the claim is about the
    // browser's COOKIE JAR after the click and `document.cookie` throws on a `setContent` document —
    // `SecurityError: Access is denied for this document`, which would be read as "no cookies" by a
    // try/catch and is not the same statement at all.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      const page = await context.newPage()
      await page.setContent(first.html, { waitUntil: 'load' })
      const before = await inspect(page)
      // Press it, the way an operator would. `<details>` collapses with no script.
      await page.click('summary[data-action="dismiss-google-reauth"]')
      const collapsed = await page.evaluate(() => ({
        open: document.querySelector('[data-google-reauth] details')?.hasAttribute('open') ?? null,
        stillThere: document.querySelector('[data-google-reauth]') !== null,
      }))
      expect(before?.state).toBe('degraded')
      expect(before?.dismissible).toBe('true')
      expect(before?.controls).toBeGreaterThan(0)
      expect(collapsed.open).toBe(false)
      // The section is still in the document: the collapse hides the detail, not the warning.
      expect(collapsed.stillThere).toBe(true)
      // And nothing was written anywhere a later page load could read, which is why the collapse cannot
      // survive one. Asked of the browser's own jar and its own storage, not of the page.
      expect(await context.cookies()).toEqual([])
      const state = await context.storageState()
      expect(state.cookies).toEqual([])
      expect(state.origins).toEqual([])
    } finally {
      await context.close()
    }
  }, 180_000)

  it('renders it again on the next document, because nothing recorded the collapse', async () => {
    // The acceptance line's "reappears after a client-side navigation". There is no client-side navigation
    // on these documents — no bundle, no router — so the honest form of the claim is that the NEXT
    // document renders it expanded, which it must, because the collapse had nowhere to live.
    const degraded = bannerFor({
      capabilities: [{ capability: 'gsc', health: 'permission_missing' }],
    })
    const [, second] = documents(degraded)
    if (second === undefined) throw new Error('no second document')
    const seen = await inPage(second.html, (page) =>
      page.evaluate(
        () => document.querySelector('[data-google-reauth] details')?.hasAttribute('open') ?? null,
      ),
    )
    expect(seen).toBe(true)
  }, 120_000)
})

describe('acceptance — axe reports nothing serious or critical on the banner', () => {
  it('audits a document carrying it at 390/768/1440 x light/dark', async () => {
    expect(CELLS).toHaveLength(6)
    const broken = bannerFor({ status: 'needs_reauth' })
    const [first] = documents(broken)
    if (first === undefined) throw new Error('no documents')
    const luminance: Record<string, number> = {}
    let audited = 0
    for (const cell of CELLS) {
      const where = `${cell.width} ${cell.theme}`
      const seen = await inPage(
        first.html,
        async (page) => {
          const result = await auditPage(page, {
            page: `${first.name} (with the re-auth banner)`,
            viewport: {
              name: String(cell.width),
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'G-CONN-08 acceptance',
            },
            theme: cell.theme,
            direction: 'ltr',
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            lum: await page.evaluate(() => {
              const colour = globalThis.getComputedStyle(document.body).backgroundColor
              const parts = colour.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255]
              return 0.2126 * (parts[0] ?? 0) + 0.7152 * (parts[1] ?? 0) + 0.0722 * (parts[2] ?? 0)
            }),
          }
        },
        cell,
      )
      expect(seen.width, `${where}: viewport`).toBe(cell.width)
      luminance[where] = seen.lum
      const blocking = blockingViolations(seen.violations)
      expect(
        blocking.map(describeViolation),
        `${where}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      audited += 1
    }
    expect(audited).toBe(6)
    // The theme axis is real, or six identical light renders would satisfy the six assertions above.
    for (const width of [390, 768, 1440]) {
      expect(luminance[`${width} dark`], `${width}: dark is darker than light`).toBeLessThan(
        luminance[`${width} light`] ?? 0,
      )
    }
  }, 600_000)

  it('reports a defect injected into the banner, by rule id', async () => {
    // The control on the audit (ADR 0003): a sweep that reported zero because axe never ran would pass the
    // case above for ever. The defect is injected INTO the banner, so the audit is shown to reach it.
    const broken = bannerFor({ status: 'needs_reauth' })
    const [first] = documents(broken)
    if (first === undefined) throw new Error('no documents')
    const violations = await inPage(first.html, async (page) => {
      await page.evaluate(() => {
        const banner = document.querySelector('[data-google-reauth]')
        const button = document.createElement('button')
        button.type = 'button'
        banner?.append(button)
        const text = document.createElement('p')
        text.textContent = 'Reconnect Google'
        // The decorative gold on the sand surface: 2.90:1, which is why --color-decor-gold never carries
        // text. Read from the token layer, so this file states no colour (`pnpm colours`).
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        banner?.append(text)
      })
      const result = await auditPage(page, {
        page: `${first.name} (known-bad)`,
        viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
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

describe('acceptance — the banner photographed twice is byte-identical', () => {
  it('captures six cells twice with zero pixel diff', async () => {
    const broken = bannerFor({ status: 'needs_reauth' })
    const [first] = documents(broken)
    if (first === undefined) throw new Error('no documents')
    let compared = 0
    for (const cell of CELLS) {
      const shot = async (): Promise<Uint8Array> =>
        await inPage(
          first.html,
          async (page) => {
            const { png } = await captureUntilStable(
              async () => await page.screenshot({ fullPage: true }),
              { label: `reauth-banner ${cell.width} ${cell.theme}` },
            )
            return png
          },
          cell,
        )
      // Two independent browser contexts, so the comparison is about the page rather than one context.
      const before = await shot()
      const after = await shot()
      expect(
        Buffer.compare(Buffer.from(before), Buffer.from(after)),
        `${cell.width} ${cell.theme}`,
      ).toBe(0)
      expect(before.byteLength, `${cell.width} ${cell.theme}: empty image`).toBeGreaterThan(1000)
      compared += 1
    }
    expect(compared).toBe(6)
  }, 600_000)

  it('and a document whose banner changed produces different bytes', async () => {
    // The control. "Byte-identical" is worth nothing unless a real change is visible, and the change used is
    // the one this unit is about: the broken banner against the dismissible one.
    const cell = CELLS[0]
    if (cell === undefined) throw new Error('no cells')
    const shot = async (banner: ReauthBannerView | null): Promise<Uint8Array> => {
      const [first] = documents(banner)
      if (first === undefined) throw new Error('no documents')
      return await inPage(
        first.html,
        async (page) => {
          const { png } = await captureUntilStable(
            async () => await page.screenshot({ fullPage: true }),
            { label: 'reauth-banner control' },
          )
          return png
        },
        cell,
      )
    }
    const broken = await shot(bannerFor({ status: 'needs_reauth' }))
    const degraded = await shot(
      bannerFor({ capabilities: [{ capability: 'gsc', health: 'permission_missing' }] }),
    )
    expect(Buffer.compare(Buffer.from(broken), Buffer.from(degraded))).not.toBe(0)
  }, 300_000)
})

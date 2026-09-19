import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { captureFilename, THEMES, VIEWPORTS } from '@berelax/harness/matrix'
import { buildDerivatives, storeOriginal } from '@berelax/media'
import { CROPS, cropRectFor } from '@berelax/media/ladders'
import { sharp } from '@berelax/media/sharp'
import { PREVIEW_CSS_WIDTHS, pictureSourcesFor, selectedRungFor } from '@berelax/media/srcset'
import { IMMUTABLE_CACHE_CONTROL, publicKeyFor } from '@berelax/media/storage'
import { getPayload, type Payload } from 'payload'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import config from '../payload.config.ts'
import { SlotPicture } from './components/media/slot-picture.tsx'
import { appMediaStorage, mediaOutboxRoot } from './media/storage.ts'

/**
 * W-SYS-10 — the breakpoint preview, driven against the built application.
 *
 * Every claim in this unit's acceptance list is a claim about a rendered document, a response status or a
 * byte count in a bucket, and not one of them can be checked by reading source:
 *
 *   - whether the preview's `srcset` **is** the production component's is a comparison of two strings each
 *     produced by a different renderer;
 *   - whether the reported rung is the one a browser requests is a property of Chromium's own `srcset`
 *     selection, read back from `currentSrc`;
 *   - whether the weights are real is a comparison with `statSync` on the objects in the outbox;
 *   - whether a bad publish is blocked at the API is a POST that never went near the page;
 *   - whether the page reaches a third-party origin is a request log.
 *
 * ## Why there is a noise fixture, and why it is not photography
 *
 * "The state appears for an oversized fixture" needs a hero whose real AVIF is over docs/08 §8's 95KB/170KB.
 * **No asset in this repository is**: the four heroes measure 40–63KB on the widest mobile rung and 89–114KB
 * on the widest desktop rung, which is why `packages/fixtures/src/media-derivatives.itest.ts` passes. So the
 * oversized fixture is high-entropy `feTurbulence` noise rendered to a JPEG — exactly the technique gate 28b
 * in `scripts/test-gates.mjs` already uses to make this same budget fail, and for the same reason: AVIF
 * spends bytes on detail, and nothing in the photo library has enough. The *in-budget* fixture is a real
 * repository asset (`assets/media/photos/hero-team.jpg`), and the replacement that clears the over-budget
 * state is that same real photograph.
 *
 * ## Isolation
 *
 * Four media rows and three admin accounts, all created here and all addressed by the ids Payload minted, so
 * nothing in this file asserts a total over a shared table (CONTRIBUTING-AGENT-BRIEF §12). The outbox is
 * shared with the other media suites only in the sense that they use `mkdtemp`; the object keys here are
 * under this run's own media ids. One test replaces a row's original in place, and the assertions about the
 * over-budget version therefore live in that same test — a sibling test asserting against the same row
 * would depend on which ran first, and the first version of this file did exactly that and reported 200
 * where 422 was expected.
 */
const PORT = 4400 + Math.floor(Math.random() * 300)
const BASE = `http://127.0.0.1:${PORT}`
const SCREENS = new URL('../../../artifacts/screens', import.meta.url).pathname
const REPO = new URL('../../../', import.meta.url).pathname

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** Long enough for Payload's own policy, and obviously a test value. */
const PASSWORD = 'a-long-enough-test-password'

/**
 * The in-budget fixture, and the one the over-budget fixture is replaced with.
 *
 * A real repository asset. `photos/hero-team.jpg` is 1672x941 with a declared focal point of 50,45 — the
 * same file `build/budgets.json` measures the hero budget against, so the weights this preview reports are
 * the weights that budget is about.
 */
const HERO_ASSET = 'assets/media/photos/hero-team.jpg'
const HERO_FOCAL = { x: 50, y: 45 }

/**
 * Alt text for the fixtures.
 *
 * Both describe what is actually in the frame and neither invents a person: nobody in this repository has a
 * display name (ADR 0020), and the junk filter would reject a placeholder anyway.
 */
const HERO_ALT = 'Treatment room with a linen-draped bed, a stone basin and a single orchid stem'
const NOISE_ALT = 'Fractal noise test pattern standing in for a room photograph in this slot'

/** Junk alt, written straight into the row. See `withHandEditedAlt` for why it has to be written in SQL. */
const JUNK_ALT = 'image image image image'

/**
 * A deliberately oversized original: fractal noise, which AVIF cannot compress.
 *
 * 1400x1100 clears the hero slot's 1280x720 minimum, and its 1.27 native ratio is far outside the slot's
 * 1.778 — so it needs a declared focal point, which it has. Rendered through sharp because the slot accepts
 * JPEG and PNG only: an SVG is a document that can carry script, and `ORIGINAL_MIME_TYPES` refuses one.
 *
 * `baseFrequency` is 0.9 and not gate 28b's 0.2, and the difference is measured rather than chosen. At 0.2
 * the mobile 1080 rung encodes to 88,246 bytes against a 97,280 budget — **under it**, because this fixture
 * goes through a JPEG before AVIF sees it and that first pass smooths exactly the high-frequency detail the
 * budget is spent on. Gate 28b feeds sharp the SVG directly and gets 214KB from 0.2. At 0.9 the same
 * round-trip measures 234,554 bytes on the mobile rung and 443,874 on the desktop one, which is 2.4x and
 * 2.5x their budgets: over by a margin no encoder revision will quietly close.
 */
async function noiseOriginal(): Promise<Buffer> {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1100">',
    '<filter id="n">',
    '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="7"/>',
    '</filter>',
    '<rect width="1400" height="1100" filter="url(#n)"/>',
    '</svg>',
  ].join('')
  return await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer()
}

interface Fixture {
  readonly mediaId: string
  readonly contentHash: string
  readonly width: number
  readonly height: number
  readonly focal: { readonly x: number; readonly y: number }
}

let server: ChildProcess
let browser: Browser
let payload: Payload
let heroFixture: Fixture
let noiseFixture: Fixture
let junkFixture: Fixture
/** Cookies per role, so every request in this file arrives as somebody. */
const cookies = new Map<string, string>()

const storage = () => appMediaStorage()

async function waitForServer(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // A child that has exited is not a server that is slow to start, and waiting the full timeout on one
    // turns a crash into a timeout nobody can read.
    if (server.exitCode !== null) {
      throw new Error(`next start exited with ${server.exitCode} before answering on ${BASE}`)
    }
    try {
      const response = await fetch(`${BASE}/robots.txt`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start on ${BASE} within ${timeoutMs}ms`)
}

async function ensureStaff(role: string): Promise<string> {
  const email = `wsys10-${role}@berelax.test`
  await payload.delete({ collection: 'cms_user', where: { email: { equals: email } } })
  await payload.create({
    collection: 'cms_user',
    data: { email, password: PASSWORD, role },
    overrideAccess: true,
  })
  return email
}

/** Signs in over HTTP and returns the session cookie, so the routes see Payload's own session. */
async function signIn(email: string): Promise<string> {
  const response = await fetch(`${BASE}/cms-api/cms_user/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!response.ok) throw new Error(`login for ${email} answered ${response.status}`)
  const body = (await response.json()) as { readonly token?: string }
  if (typeof body.token !== 'string') throw new Error(`login for ${email} returned no token`)
  return `payload-token=${body.token}`
}

/** Creates a hero row from real bytes, then stores the original and builds the whole ladder. */
async function seedFixture(source: Buffer, filename: string, alt: string): Promise<Fixture> {
  const created = await payload.create({
    collection: 'media',
    data: { slot: 'hero', alt, focalX: HERO_FOCAL.x, focalY: HERO_FOCAL.y },
    file: { data: source, mimetype: 'image/jpeg', name: filename, size: source.length },
    overrideAccess: true,
  })
  const mediaId = String(created.id)
  return await buildFixture(mediaId, source, created as Record<string, unknown>)
}

async function buildFixture(
  mediaId: string,
  source: Buffer,
  row: Record<string, unknown>,
): Promise<Fixture> {
  const focal = {
    x: typeof row['focalX'] === 'number' ? row['focalX'] : 50,
    y: typeof row['focalY'] === 'number' ? row['focalY'] : 50,
  }
  // The production pair: the upload writes the original to the private bucket, the job builds the ladder.
  // Doing it with those two functions rather than with a fixture writer is what makes the byte counts this
  // preview reports the byte counts the site would serve.
  await storeOriginal({
    mediaId,
    extension: 'jpg',
    source,
    contentType: 'image/jpeg',
    storage: storage(),
  })
  const built = await buildDerivatives({
    mediaId,
    slot: 'hero',
    source,
    focal,
    storage: storage(),
  })
  return {
    mediaId,
    contentHash: built.contentHash,
    width: typeof row['width'] === 'number' ? row['width'] : 0,
    height: typeof row['height'] === 'number' ? row['height'] : 0,
    focal,
  }
}

function previewPath(fixture: Fixture): string {
  return `/settings/media/preview/${fixture.mediaId}`
}

beforeAll(async () => {
  payload = await getPayload({ config })

  const [owner, manager, receptionist] = await Promise.all([
    ensureStaff('owner'),
    ensureStaff('manager'),
    ensureStaff('receptionist'),
  ])

  const heroBytes = readFileSync(join(REPO, HERO_ASSET))
  heroFixture = await seedFixture(heroBytes, 'hero-team.jpg', HERO_ALT)
  noiseFixture = await seedFixture(await noiseOriginal(), 'noise-fixture.jpg', NOISE_ALT)
  // A third row whose alt is broken in the database rather than through Payload — see the test that uses it.
  junkFixture = await seedFixture(heroBytes, 'hero-team.jpg', HERO_ALT)

  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
      // The preview reads objects out of the bucket, so the adapter has to be the one the ladder was built
      // into. `real` throws by name rather than serving 404s (see src/media/storage.ts).
      MEDIA_STORAGE: 'fake',
      // The same secret the in-process Payload above signed the session with. Without it the spawned
      // server rejects every cookie this file presents and every assertion reads as a 401.
      PAYLOAD_SECRET:
        process.env['PAYLOAD_SECRET'] ?? 'berelax-placeholder-payload-secret-not-for-serving',
    },
  })
  await waitForServer()

  cookies.set('owner', await signIn(owner))
  cookies.set('manager', await signIn(manager))
  cookies.set('receptionist', await signIn(receptionist))

  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 900_000)

afterAll(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

async function get(path: string, role = 'owner'): Promise<Response> {
  const cookie = cookies.get(role)
  return await fetch(`${BASE}${path}`, {
    headers: cookie === undefined ? {} : { cookie },
    redirect: 'manual',
  })
}

interface Cell {
  readonly viewport: (typeof VIEWPORTS)[number]
  readonly theme: (typeof THEMES)[number]
}

/**
 * Three viewports x two themes, taken from H04's own matrix rather than written out here.
 *
 * `VIEWPORTS` and `THEMES` are `@berelax/harness/matrix`'s, so a viewport added to the harness adds a
 * required cell here rather than leaving this surface photographed at the old three widths. The direction
 * axis is deliberately absent: this route is a locale-neutral handler serving one English document and the
 * acceptance criterion asks for 3 x 2, which is the same call the Messages inbox made.
 *
 * `deviceScaleFactor` stays 1 even though the harness declares 2 for the phone and the tablet, and that is a
 * decision about what the page CLAIMS: every rung and every weight on it is what a DPR-1 browser requests
 * (`selectedRungFor(cssWidth, 1)`). Photographing it at 2x would load the rung above each badge's figure, so
 * the screenshot would show images the page does not describe. The page says so in as many words.
 */
const CELLS: readonly Cell[] = THEMES.flatMap((theme) =>
  VIEWPORTS.map((viewport) => ({ viewport, theme })),
)

/**
 * The widest declared viewport, for every assertion that is not about a viewport.
 *
 * Read out of the matrix rather than written, and it throws rather than falling back: a harness with no
 * viewports would otherwise make every test here run at Playwright's default size and still pass.
 */
const DESKTOP = ((): (typeof VIEWPORTS)[number] => {
  const widest = [...VIEWPORTS].sort((left, right) => right.width - left.width)[0]
  if (widest === undefined) throw new Error('@berelax/harness/matrix declares no viewport')
  return widest
})()

interface Visit {
  readonly page: Page
  readonly context: BrowserContext
  /** Every request the page made, as an absolute URL. */
  readonly requested: string[]
  /** Requests whose origin is not this application's. Asserted empty. */
  readonly foreign: string[]
}

async function open(
  path: string,
  options: { readonly role?: string; readonly cell?: Cell } = {},
): Promise<Visit> {
  const cell = options.cell ?? { viewport: DESKTOP, theme: 'light' as const }
  const context = await browser.newContext({
    viewport: { width: cell.viewport.width, height: cell.viewport.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  const cookie = cookies.get(options.role ?? 'owner')
  if (cookie !== undefined) {
    const [name, value] = cookie.split('=')
    await context.addCookies([
      { name: name ?? '', value: value ?? '', domain: '127.0.0.1', path: '/' },
    ])
  }
  const page = await context.newPage()
  const requested: string[] = []
  const foreign: string[] = []
  // Every request, not only the document's: "zero network requests to third-party origins" is a claim about
  // the whole page, and a font or an analytics beacon would be exactly the violation. A foreign origin is
  // aborted rather than allowed, so a test that discovered one could not also leak to it.
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url()
    requested.push(requestUrl)
    if (new URL(requestUrl).origin !== BASE) {
      foreign.push(requestUrl)
      await route.abort()
      return
    }
    await route.continue()
  })
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      [...document.images].map(
        (image) =>
          image.complete ||
          new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', resolve, { once: true })
          }),
      ),
    )
    /*
     * Two frames, so the paint the screenshot captures is a committed one.
     *
     * `img.complete` says the bytes arrived, not that they were decoded and painted, and the inline script
     * sets each frame's scale and height after that. One rAF schedules the work; the second runs after the
     * frame carrying it has been committed. Without this the first pass of the byte-identical assertion can
     * photograph a layout the second pass photographs settled — which failed once under the load of a
     * full `pnpm verify` and passed every time the file was run on its own.
     */
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve(null))
      })
    })
  })
  return { page, context, requested, foreign }
}

/** One cell photographed, with the two facts that prove the render really was that cell. */
interface Shot {
  readonly png: Uint8Array
  readonly innerWidth: number
  readonly backgroundLuminance: number
}

/**
 * Renders one cell and returns the bytes plus what the engine resolved.
 *
 * The luminance is read rather than compared with a literal: a hex in this file would be an un-tokened
 * colour and `pnpm colours` would reject it, rightly. The claim that matters is the comparative one — the
 * dark cell really is darker — which is what makes the theme axis a rendered difference and not a filename.
 */
async function shoot(path: string, cell: Cell): Promise<Shot> {
  const visit = await open(path, { cell })
  try {
    return {
      innerWidth: await visit.page.evaluate(() => globalThis.innerWidth),
      backgroundLuminance: await visit.page.evaluate(() => {
        const colour = globalThis.getComputedStyle(document.body).backgroundColor
        const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
      }),
      png: await visit.page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
    }
  } finally {
    await visit.context.close()
  }
}

/**
 * A publish attempt that never went near the preview.
 *
 * A bare POST with a JSON body and a session cookie: no referer, no form, nothing the page produced. If the
 * endpoint trusted the UI in any way — a flag the preview set, a weight in the request — this is the request
 * that would slip through.
 */
async function attemptPublish(mediaId: string, role = 'owner'): Promise<Response> {
  return await fetch(`${BASE}/api/v1/media/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookies.get(role) ?? '' },
    body: JSON.stringify({ mediaId }),
  })
}

function outboxBytes(path: string): number {
  return statSync(join(mediaOutboxRoot(), 'public', publicKeyFor(path))).size
}

describe('acceptance — the srcset is the production component’s, string for string', () => {
  it('renders the same srcset the production <picture> does, for the same media id', async () => {
    const visit = await open(previewPath(heroFixture))
    try {
      const ref = {
        mediaId: heroFixture.mediaId,
        contentHash: heroFixture.contentHash,
        slot: 'hero',
      }
      /*
       * The production component, rendered here by React, and the preview, rendered by the route handler's
       * string builder. Two renderers on purpose: they share `pictureSourcesFor` and nothing else, so the
       * two strings being byte-identical is evidence rather than a tautology. (The handler cannot use
       * `react-dom/server` at all — Next 16.3.5 refuses it anywhere in the app graph.)
       */
      const production = renderToStaticMarkup(
        createElement(SlotPicture, { media: ref, alt: HERO_ALT }),
      )
      const productionSrcsets = [...production.matchAll(/srcSet="([^"]+)"|srcset="([^"]+)"/g)].map(
        (match) => match[1] ?? match[2] ?? '',
      )
      expect(productionSrcsets, 'the production component rendered no srcset').toHaveLength(6)
      /*
       * And the production component reserves its box per CROP, not per slot. `slotAspectRatio('hero')` is
       * 16:9 and the ladder serves 4:5 below 768px, so one ratio would reserve the wrong box on a phone and
       * reflow when the photograph landed — on phones only. Asserted here because no route renders this
       * component yet, so there is nowhere else the markup is looked at.
       */
      expect(production).toContain('aspect-ratio:var(--slot-picture-ratio)')
      expect(production).toContain(`--slot-picture-ratio:${CROPS.mobile.ratio.join(' / ')}`)
      expect(production).toContain(`@media ${CROPS.desktop.media}`)
      expect(production).toContain(`--slot-picture-ratio:${CROPS.desktop.ratio.join(' / ')}`)

      const previewSrcsets = await visit.page.$$eval('picture source', (nodes) =>
        nodes.map((node) => node.getAttribute('srcset') ?? ''),
      )
      /*
       * Seven rows, each offering its own crop's three formats — 21 elements over six distinct strings, and
       * the six must be the production component's six in the production component's order. The preview drops
       * the `media` attribute and resolves the crop per row instead, because a `<source media>` query is
       * evaluated against the *viewport*: in a 1440px admin window every row would otherwise match
       * `(min-width: 768px)` and show the 16:9 crop, including the rows labelled 360, 390 and 414. The
       * `srcset` strings are untouched, which is what this assertion is about.
       */
      expect(previewSrcsets).toHaveLength(PREVIEW_CSS_WIDTHS.length * 3)
      const unique = [...new Set(previewSrcsets)]
      expect(unique).toHaveLength(6)
      expect(unique).toEqual(productionSrcsets)

      // And the same six, again, from the panel the editor reads — so the page cannot show one string and
      // serve another.
      for (const source of pictureSourcesFor(ref)) {
        const shown = await visit.page.textContent(
          `[data-testid="srcset-${source.crop}-${source.format}"]`,
        )
        expect(shown, `${source.crop}/${source.format}`).toBe(source.srcset)
        expect(productionSrcsets, `${source.crop}/${source.format}`).toContain(source.srcset)
      }

      /*
       * The control, and the reason this test is not vacuous: a *lookalike* builder — the same rungs, the
       * same order, the same descriptors, and the crop segment left out of the filename, which is exactly
       * the spelling docs/08 writes — must NOT match. Without this, two builders that both returned the
       * empty string would satisfy every assertion above.
       */
      const lookalike = CROPS.mobile.widths
        .map((width) => `/m/${ref.mediaId}/${ref.contentHash}/hero-${width}.avif ${width}w`)
        .join(', ')
      expect(productionSrcsets).not.toContain(lookalike)
      expect(unique).not.toContain(lookalike)
    } finally {
      await visit.context.close()
    }
  }, 180_000)
})

describe('acceptance — real derivative URLs at the seven CSS widths', () => {
  it('reports the rung a browser actually requests, at every width', async () => {
    const visit = await open(previewPath(heroFixture))
    try {
      expect(PREVIEW_CSS_WIDTHS).toEqual([360, 390, 414, 768, 1024, 1440, 1600])
      for (const cssWidth of PREVIEW_CSS_WIDTHS) {
        const expected = selectedRungFor(cssWidth)
        const row = visit.page.locator(`[data-testid="rung-${cssWidth}"]`)
        expect(await row.count(), `${cssWidth}px row`).toBe(1)
        const badge = row.locator('.weight')
        expect(await badge.getAttribute('data-crop'), `${cssWidth}px crop`).toBe(expected.crop)
        expect(Number(await badge.getAttribute('data-rung')), `${cssWidth}px rung`).toBe(
          expected.width,
        )
        /*
         * `currentSrc` is the URL Chromium resolved out of the `srcset` — the one thing in this whole unit
         * that no amount of reading source can establish. If `selectedRungFor` ever disagreed with HTML's
         * selection algorithm (it disagrees with `nearestRung` at 1600, deliberately), this is where it
         * would be caught rather than in a weight report that is wrong on the widest screens.
         */
        expect(await row.locator('picture').getAttribute('data-crop'), `${cssWidth}px crop`).toBe(
          expected.crop,
        )
        const current = await row
          .locator('img')
          .evaluate((img) => (img as HTMLImageElement).currentSrc)
        expect(current, `${cssWidth}px currentSrc`).toContain(
          `hero-${expected.crop}-${expected.width}.`,
        )
        expect(current, `${cssWidth}px content address`).toContain(`/${heroFixture.contentHash}/`)
      }
    } finally {
      await visit.context.close()
    }
  }, 180_000)

  it('serves every one of those URLs same-origin, immutable, from the bucket', async () => {
    // The derivative origin is this unit's too: before it, every URL the pipeline produced was a path
    // nothing answered, and the preview would have been seven broken images.
    for (const cssWidth of [360, 1440]) {
      const rung = selectedRungFor(cssWidth)
      const path = `/m/${heroFixture.mediaId}/${heroFixture.contentHash}/hero-${rung.crop}-${rung.width}.avif`
      const response = await fetch(`${BASE}${path}`)
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type'), path).toBe('image/avif')
      expect(response.headers.get('cache-control'), path).toBe(IMMUTABLE_CACHE_CONTROL)
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body.byteLength, path).toBe(outboxBytes(path))
    }
    // The control: a rung nobody built is a 404, not an invented rendition. 500 is not a declared width.
    const undeclared = `/m/${heroFixture.mediaId}/${heroFixture.contentHash}/hero-mobile-500.avif`
    expect((await fetch(`${BASE}${undeclared}`)).status).toBe(404)
    // And a path that is not a derivative path at all never reaches the bucket.
    expect((await fetch(`${BASE}/m/not-a-uuid/deadbeef/hero-mobile-414.avif`)).status).toBe(404)
  }, 120_000)
})

describe('acceptance — per-rung transferred bytes, and the over-budget state', () => {
  it('displays the real object size for every rung, not an estimate', async () => {
    const visit = await open(previewPath(heroFixture))
    try {
      const badges = await visit.page.$$eval('.weight', (nodes) =>
        nodes.map((node) => ({
          crop: node.getAttribute('data-crop') ?? '',
          rung: Number(node.getAttribute('data-rung')),
          bytes: Number(node.getAttribute('data-bytes')),
          budget: node.getAttribute('data-budget') ?? '',
          state: node.getAttribute('data-state') ?? '',
          figure: node.querySelector('.weight-figure')?.textContent ?? '',
        })),
      )
      expect(badges).toHaveLength(PREVIEW_CSS_WIDTHS.length)
      for (const badge of badges) {
        const path = `/m/${heroFixture.mediaId}/${heroFixture.contentHash}/hero-${badge.crop}-${badge.rung}.avif`
        // The number on the page is the size of the object in the bucket. An estimate could not be this.
        expect(badge.bytes, path).toBe(outboxBytes(path))
        expect(badge.figure, path).toContain(`${badge.bytes} bytes`)
        // The hero is the one slot docs/08 §8 gives a figure, so the budget is present and the state is a
        // comparison rather than "unbudgeted".
        expect(badge.budget, path).not.toBe('')
        expect(badge.state, path).toBe('within')
      }
      expect(await visit.page.getAttribute('html', 'data-over-budget-rungs')).toBe('0')
    } finally {
      await visit.context.close()
    }
  }, 180_000)

  it('renders the over-budget state for an oversized fixture, and clears it when it is replaced', async () => {
    const over = await open(previewPath(noiseFixture))
    try {
      // At least one rung of the noise fixture really is over the budget, and the page says which.
      const flagged = await over.page.$$eval('.weight[data-state="over"]', (nodes) =>
        nodes.map((node) => ({
          crop: node.getAttribute('data-crop') ?? '',
          rung: Number(node.getAttribute('data-rung')),
          bytes: Number(node.getAttribute('data-bytes')),
          budget: Number(node.getAttribute('data-budget')),
        })),
      )
      expect(flagged.length, 'no rung was reported over budget').toBeGreaterThan(0)
      for (const rung of flagged) {
        expect(rung.bytes).toBeGreaterThan(rung.budget)
        const path = `/m/${noiseFixture.mediaId}/${noiseFixture.contentHash}/hero-${rung.crop}-${rung.rung}.avif`
        expect(rung.bytes, path).toBe(outboxBytes(path))
      }
      expect(
        Number(await over.page.getAttribute('html', 'data-over-budget-rungs')),
      ).toBeGreaterThan(0)
      // The visible flag, not only the data attribute.
      expect(await over.page.locator('.over-flag').count()).toBeGreaterThan(0)
    } finally {
      await over.context.close()
    }

    /*
     * The second, independent assertion over the same state: the API refuses this row on its own, from a
     * request the UI never sent. It is here rather than in a test of its own because the replacement below
     * changes this row — a separate test would have asserted against whichever version happened to run
     * first, which is exactly the shape of failure CONTRIBUTING-AGENT-BRIEF §12 is about, and it is how the
     * first version of this file passed the UI half and reported 200 from the API.
     */
    const refused = await attemptPublish(noiseFixture.mediaId)
    expect(refused.status).toBe(422)
    const body = (await refused.json()) as {
      readonly error: string
      readonly rules: string[]
      readonly messages: string[]
      readonly measuredBytes: number[]
    }
    expect(body.error).toBe('publication_refused')
    // By rule name, and with the measured weight against the budget in the message — not a bare non-2xx.
    expect(body.rules).toContain('media-slot-over-byte-budget')
    expect(body.messages.join('\n')).toMatch(/measures \d+ bytes.*against the \d+ bytes/)
    expect(Math.max(...body.measuredBytes)).toBeGreaterThan(95 * 1024)

    // Replace the fixture: a new original for the same row, re-measured through Payload and rebuilt through
    // the job. The content address changes, so every URL on the page changes with it.
    const heroBytes = readFileSync(join(REPO, HERO_ASSET))
    const updated = await payload.update({
      collection: 'media',
      id: noiseFixture.mediaId,
      data: { focalX: HERO_FOCAL.x, focalY: HERO_FOCAL.y },
      file: {
        data: heroBytes,
        mimetype: 'image/jpeg',
        name: 'hero-team.jpg',
        size: heroBytes.length,
      },
      overrideAccess: true,
    })
    const replaced = await buildFixture(
      noiseFixture.mediaId,
      heroBytes,
      updated as Record<string, unknown>,
    )
    expect(replaced.contentHash).not.toBe(noiseFixture.contentHash)

    const cleared = await open(previewPath(replaced))
    try {
      expect(await cleared.page.locator('.weight[data-state="over"]').count()).toBe(0)
      expect(await cleared.page.locator('.over-flag').count()).toBe(0)
      expect(await cleared.page.getAttribute('html', 'data-over-budget-rungs')).toBe('0')
      expect(await cleared.page.textContent('[data-testid="content-hash"]')).toBe(
        replaced.contentHash,
      )
    } finally {
      await cleared.context.close()
    }

    // And the API tracks the replacement too, which is the control on the 422 above: the same row, the same
    // endpoint, a different photograph, and now a pass.
    const allowed = await attemptPublish(noiseFixture.mediaId)
    expect(allowed.status).toBe(200)
  }, 900_000)
})

describe('acceptance — focalX re-crops within the same render, and the two crops differ', () => {
  it('shows numerically different crop boxes for the 4:5 and 16:9 crops of one asset', async () => {
    const visit = await open(previewPath(heroFixture))
    try {
      const read = async (crop: string) => ({
        left: Number(
          await visit.page.getAttribute(`[data-testid="crop-${crop}"]`, 'data-crop-left'),
        ),
        top: Number(await visit.page.getAttribute(`[data-testid="crop-${crop}"]`, 'data-crop-top')),
        width: Number(
          await visit.page.getAttribute(`[data-testid="crop-${crop}"]`, 'data-crop-width'),
        ),
        height: Number(
          await visit.page.getAttribute(`[data-testid="crop-${crop}"]`, 'data-crop-height'),
        ),
      })
      const mobile = await read('mobile')
      const desktop = await read('desktop')
      // Numerically, as the acceptance criterion asks — not a screenshot.
      expect(mobile).not.toEqual(desktop)
      expect(mobile.width).not.toBe(desktop.width)
      // And each is `cropRectFor`, the window the derivative job extracts. A preview whose numbers were its
      // own would show an editor a crop the site does not serve.
      const source = { width: heroFixture.width, height: heroFixture.height }
      expect(mobile).toEqual(cropRectFor(source, 'mobile', heroFixture.focal))
      expect(desktop).toEqual(cropRectFor(source, 'desktop', heroFixture.focal))
    } finally {
      await visit.context.close()
    }
  }, 180_000)

  it('re-crops when focalX moves, without leaving the page', async () => {
    const visit = await open(previewPath(heroFixture))
    try {
      const before = await visit.page.getAttribute('[data-testid="crop-mobile"]', 'data-crop-left')
      const repaintsBefore = Number(await visit.page.getAttribute('html', 'data-focal-repaints'))
      expect(repaintsBefore).toBeGreaterThan(0)

      // A sentinel on `window`. A navigation would destroy it, so its survival is what "within the same
      // render" means operationally — the page was not re-fetched.
      await visit.page.evaluate(() => {
        ;(globalThis as unknown as Record<string, unknown>)['__wsys10'] = 'same-render'
      })

      const target = heroFixture.focal.x === 0 ? 100 : 0
      await visit.page.fill('#focalX', String(target))
      await visit.page.dispatchEvent('#focalX', 'input')

      expect(
        await visit.page.evaluate(
          () => (globalThis as unknown as Record<string, unknown>)['__wsys10'],
        ),
      ).toBe('same-render')
      const after = await visit.page.getAttribute('[data-testid="crop-mobile"]', 'data-crop-left')
      expect(after).not.toBe(before)
      expect(Number(await visit.page.getAttribute('html', 'data-focal-repaints'))).toBeGreaterThan(
        repaintsBefore,
      )
      // The number is still `cropRectFor`'s: the sweep the browser indexed was computed on the server by
      // the same function the job crops with.
      expect(Number(after)).toBe(
        cropRectFor({ width: heroFixture.width, height: heroFixture.height }, 'mobile', {
          x: target,
          y: heroFixture.focal.y,
        }).left,
      )
      // The visible numbers moved with the data attributes, not only the attributes.
      expect(await visit.page.textContent('[data-testid="crop-mobile"] .crop-numbers')).toContain(
        `taken at ${after},`,
      )
      // The control: the 16:9 window is the whole frame for this asset, so it has nowhere to go — and a
      // slider that moved it would be showing a crop the job does not take.
      expect(await visit.page.getAttribute('[data-testid="crop-desktop"]', 'data-crop-left')).toBe(
        '0',
      )
    } finally {
      await visit.context.close()
    }
  }, 180_000)
})

describe('acceptance — a bad publish is blocked in the UI and at the API', () => {
  /**
   * Breaks the alt text in the database, not through Payload.
   *
   * Payload refuses junk alt at the door — `assertMediaRowAcceptable` runs on create *and* on update
   * (W-SYS-09) — so there is no way to store `image image image image` through the admin at all. That is
   * exactly why `publicationRefusals` exists: W-SYS-09's own note says the column is a Payload `select` and
   * "a database edited by hand, or a migration from an earlier role list, can put anything in it". This
   * writes that row, which is the case the publication check is the second line of defence for.
   */
  async function withHandEditedAlt<T>(
    mediaId: string,
    alt: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const { createConnection } = await import('@berelax/db')
    const sql = createConnection({ url: url as string, max: 2 })
    const previous =
      (await sql`select alt from payload.media where id = ${mediaId}`) as unknown as {
        alt: string | null
      }[]
    try {
      await sql`update payload.media set alt = ${alt} where id = ${mediaId}`
      return await body()
    } finally {
      await sql`update payload.media set alt = ${previous[0]?.alt ?? null} where id = ${mediaId}`
      await sql.end({ timeout: 5 })
    }
  }

  it('refuses an alt failure at the API, and shows it in the UI, for the same row', async () => {
    await withHandEditedAlt(junkFixture.mediaId, JUNK_ALT, async () => {
      // 1. The API, on its own.
      const response = await attemptPublish(junkFixture.mediaId)
      expect(response.status).toBe(422)
      const body = (await response.json()) as { readonly rules: string[] }
      expect(body.rules).toContain('media-slot-alt-fails-validation')

      // 2. The UI, independently: the button is disabled and the reason is named. Two assertions over one
      // state, which is what stops the UI being the only guard — or the only thing tested.
      const visit = await open(previewPath(junkFixture))
      try {
        expect(await visit.page.getAttribute('html', 'data-publish-blocked')).toBe('true')
        expect(await visit.page.locator('[data-testid="publish"]').isDisabled()).toBe(true)
        expect(
          await visit.page
            .locator('ul.refusals li[data-rule="media-slot-alt-fails-validation"]')
            .count(),
        ).toBe(1)
        expect(await visit.page.textContent('[data-testid="publish-blocked-reason"]')).toContain(
          '/api/v1/media/publish',
        )
      } finally {
        await visit.context.close()
      }
    })
  }, 300_000)

  it('allows the publish when nothing is wrong, in both the UI and the API', async () => {
    // The control for both guards. Without it a UI that disabled the button always, and an endpoint that
    // answered 422 always, would satisfy every assertion above.
    const visit = await open(previewPath(heroFixture))
    try {
      expect(await visit.page.getAttribute('html', 'data-publish-blocked')).toBe('false')
      expect(await visit.page.locator('[data-testid="publish"]').isEnabled()).toBe(true)
      expect(await visit.page.locator('ul.refusals').count()).toBe(0)
    } finally {
      await visit.context.close()
    }

    const response = await attemptPublish(heroFixture.mediaId)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      readonly allowed: boolean
      readonly published: boolean
      readonly message: string
    }
    expect(body.allowed).toBe(true)
    // And it does not claim to have published anything: there is no state machine to publish into yet
    // (W-SITE-10), and a stub that looked like it worked is what docs/12 §1 prohibits.
    expect(body.published).toBe(false)
    expect(body.message).toContain('W-SITE-10')
  }, 180_000)

  it('refuses the publish for a role that may edit but not publish, and for nobody at all', async () => {
    // `content:publish` is the owner's alone in the F07 matrix, and this endpoint asks the matrix rather
    // than naming a role. A manager may open the preview and may not publish from it.
    const manager = await attemptPublish(heroFixture.mediaId, 'manager')
    expect(manager.status).toBe(403)
    expect((await manager.json()) as { permission: string }).toMatchObject({
      permission: 'content:publish',
    })

    const anonymous = await fetch(`${BASE}/api/v1/media/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: heroFixture.mediaId }),
    })
    expect(anonymous.status).toBe(401)

    // And the UI says so rather than offering a button that would 403.
    const visit = await open(previewPath(heroFixture), { role: 'manager' })
    try {
      expect(await visit.page.locator('[data-testid="publish"]').isDisabled()).toBe(true)
      expect(await visit.page.textContent('[data-testid="publish-permission-note"]')).toContain(
        'content:publish',
      )
    } finally {
      await visit.context.close()
    }
  }, 180_000)
})

describe('acceptance — noindex, 403 for the receptionist, 200 for editor and above', () => {
  it('answers 403 for a receptionist and 200 for every role that may write content', async () => {
    const forbidden = await get(previewPath(heroFixture), 'receptionist')
    expect(forbidden.status).toBe(403)
    // The permission, named, because the matrix is the reason and not a role list in this route.
    expect(await forbidden.text()).toContain('content:write')

    for (const role of ['manager', 'owner']) {
      const allowed = await get(previewPath(heroFixture), role)
      expect(allowed.status, role).toBe(200)
      expect(allowed.headers.get('content-type'), role).toContain('text/html')
    }

    // Nobody at all is a 401 rather than a 403: the distinction is what makes an access log readable.
    const anonymous = await fetch(`${BASE}${previewPath(heroFixture)}`, { redirect: 'manual' })
    expect(anonymous.status).toBe(401)
  }, 120_000)

  it('carries the registry’s robots header and is never cached', async () => {
    const response = await get(previewPath(heroFixture))
    // Derived from the registry by the proxy, not written per route: the preview sits inside the admin
    // group's `/settings` prefix, like the Messages inbox and the two Google routes.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')
    // Belt as well as braces, for a crawler that reads the document rather than the headers.
    expect(await response.text()).toContain(
      '<meta name="robots" content="noindex, nofollow, noarchive">',
    )
    // The control: a public route does not carry it, so the header is a policy and not a default.
    expect((await fetch(`${BASE}/`)).headers.get('x-robots-tag')).toBeNull()
  }, 60_000)
})

describe('acceptance — zero network requests to third-party origins', () => {
  it('makes every request to this application, and would notice one that was not', async () => {
    const visit = await open(previewPath(heroFixture))
    try {
      // Not vacuous: the page really did load images and a stylesheet-free document.
      const images = visit.requested.filter((request) => request.includes('/m/'))
      expect(images.length, 'the preview loaded no derivative at all').toBeGreaterThan(0)
      expect(visit.foreign, `third-party requests: ${visit.foreign.join(', ')}`).toEqual([])
      // The styles are inlined and the type stack is system-ui, so there is no font request and no
      // stylesheet request to make. Stated as an assertion, because a webfont added later is exactly the
      // regression this criterion is about.
      expect(visit.requested.filter((request) => /\.(woff2?|ttf|otf)$/.test(request))).toEqual([])
      expect(await visit.page.locator('link[rel="stylesheet"]').count()).toBe(0)
      expect(
        await visit.page.locator('link[rel="preconnect"], link[rel="dns-prefetch"]').count(),
      ).toBe(0)

      /*
       * The control on the recorder itself. A `page.route` handler that silently missed subresources would
       * make the assertion above pass for ever (ADR 0003), so a request to a third-party origin is injected
       * and must be caught and aborted.
       */
      await visit.page.evaluate(() => {
        const image = document.createElement('img')
        image.src = 'https://fonts.gstatic.com/s/whatever.woff2'
        document.body.append(image)
      })
      await visit.page.waitForFunction(() =>
        [...document.images].some((image) => image.src.includes('fonts.gstatic.com')),
      )
      await expect.poll(() => visit.foreign.length, { timeout: 15_000 }).toBeGreaterThan(0)
      expect(visit.foreign.join(',')).toContain('fonts.gstatic.com')
    } finally {
      await visit.context.close()
    }
  }, 180_000)
})

describe('acceptance — the screenshot harness captures 3 viewports x 2 themes', () => {
  it('captures six cells, each the cell it claims, byte-identical on a repeat run', async () => {
    mkdirSync(SCREENS, { recursive: true })
    // Six, stated rather than counted after the fact: a matrix that lost an axis would report a pass over
    // three renders. No direction axis — this surface is English-only, for the reason the route's header
    // gives and the registry entry repeats.
    expect(CELLS).toHaveLength(6)
    const shots = new Map<string, Uint8Array>()
    const luminance: Record<string, number> = {}

    for (const cell of CELLS) {
      const label = `${cell.theme}-${cell.viewport.width}`
      const first = await shoot(previewPath(heroFixture), cell)
      expect(first.innerWidth, label).toBe(cell.viewport.width)
      expect(first.png.byteLength, label).toBeGreaterThan(1000)
      luminance[label] = first.backgroundLuminance
      shots.set(label, first.png)
      // The harness's own filename, so the gallery can parse it back: page__viewport__theme__direction.
      writeFileSync(
        join(
          SCREENS,
          captureFilename({
            page: 'media-breakpoint-preview',
            viewport: cell.viewport,
            theme: cell.theme,
            direction: 'ltr',
          }),
        ),
        first.png,
      )

      // The repeat run, immediately: byte equality is a zero pixel diff and then some, and a page rendering
      // a database row, a byte count and seven scaled frames could not do it if anything on it were derived
      // from a clock or a fresh identifier.
      const second = await shoot(previewPath(heroFixture), cell)
      expect(Buffer.compare(Buffer.from(first.png), Buffer.from(second.png)), label).toBe(0)
    }
    expect(shots.size).toBe(6)

    // The theme axis is a rendered difference rather than a filename: the dark cell resolved a darker
    // ground at every width.
    for (const width of [390, 768, 1440]) {
      expect(luminance[`dark-${width}`] ?? 0, `dark-${width} is darker than light`).toBeLessThan(
        luminance[`light-${width}`] ?? 0,
      )
    }
    // The control on the comparison: two different cells are not identical bytes.
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
  }, 900_000)

  it('has no serious or critical axe violation in any of the six cells', async () => {
    for (const cell of CELLS) {
      const label = `${cell.theme} ${cell.viewport.name}`
      const visit = await open(previewPath(heroFixture), { cell })
      try {
        const result = await auditPage(visit.page, {
          page: '/settings/media/preview',
          // The harness's own viewport descriptor, with the scale this page is actually rendered at.
          viewport: { ...cell.viewport, scale: 1 },
          theme: cell.theme,
          direction: 'ltr',
        })
        const blocking = blockingViolations(result.violations)
        expect(blocking.map(describeViolation), label).toEqual([])
      } finally {
        await visit.context.close()
      }
    }
  }, 900_000)
})

describe('the preview says so when there is nothing built to preview', () => {
  it('renders the not-built state rather than seven broken images', async () => {
    // A row with no original in the bucket: the normal state of every upload until
    // `media.build-derivatives` has run, which nothing enqueues yet (the NOTE on W-SYS-09).
    const heroBytes = readFileSync(join(REPO, HERO_ASSET))
    const created = await payload.create({
      collection: 'media',
      data: { slot: 'hero', alt: HERO_ALT, focalX: HERO_FOCAL.x, focalY: HERO_FOCAL.y },
      file: {
        data: heroBytes,
        mimetype: 'image/jpeg',
        name: 'hero-team.jpg',
        size: heroBytes.length,
      },
      overrideAccess: true,
    })
    const response = await get(`/settings/media/preview/${String(created.id)}`)
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('data-testid="no-derivatives"')
    expect(html).toContain('media.build-derivatives')
    // No image at all, rather than a URL nothing serves.
    expect(html).not.toContain('<picture')

    // And the API refuses to publish it, by name: an incomplete ladder is a hole in a srcset.
    const refused = await attemptPublish(String(created.id))
    expect(refused.status).toBe(409)
    expect(JSON.stringify(await refused.json())).toContain('[media-original-absent]')
  }, 300_000)
})

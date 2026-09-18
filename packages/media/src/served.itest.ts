import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, chromium } from 'playwright'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDerivatives, type DerivativeBuildResult } from './derivatives.ts'
import { CROPS } from './ladders.ts'
import { mediaImageLoader } from './loader.ts'
import { createFakeMediaStorage } from './storage/fake.ts'
import {
  derivativeHeaders,
  IMMUTABLE_CACHE_CONTROL,
  type MediaStorage,
  publicKeyFor,
} from './storage/port.ts'
import { derivativePath, PRIVATE_ORIGINALS_PREFIX } from './url.ts'

/**
 * What a browser actually asks for, and what it gets back.
 *
 * Neither claim in W-SYS-05's fifth and seventh acceptance lines can be checked by reading source. "Every
 * image request URL is in the declared set" is about the URL the browser *resolved* out of a `srcset`,
 * which is chosen by viewport, DPR and format support; and `Cache-Control: public, max-age=31536000,
 * immutable` is a response header, not a string in a file.
 *
 * So a real Chromium loads a real page whose `srcset` is built by the real loader, and every request is
 * intercepted and served from the fake bucket through `derivativeHeaders`. No server: `page.route`
 * fulfils the document and the images, which is also what makes the request log complete — a request this
 * test does not recognise is aborted and recorded rather than reaching the network.
 *
 * **Scope.** This is the loader and the declared set, not a crawl of the site's routes. `apps/web` has two
 * placeholder pages and no image on either, so a route crawl today would pass by having nothing to find.
 * That half is `W-SITE`'s, and W-SYS-05's acceptance list carries a `NOTE:` saying so.
 */
const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const ORIGIN = 'http://media.test'

/** Small on purpose: this test is about URLs and headers, not about encoder quality. */
async function smallOriginal(): Promise<Buffer> {
  const width = 800
  const height = 500
  const raw = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3
      raw[i] = 220 + Math.round((20 * x) / width)
      raw[i + 1] = 214 + Math.round((24 * y) / height)
      raw[i + 2] = 206 + Math.round((12 * (x + y)) / (width + height))
    }
  }
  return await sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

interface Visit {
  readonly requested: string[]
  readonly unknown: string[]
  readonly headers: Map<string, Record<string, string>>
}

let browser: Browser
let outbox: string
let storage: MediaStorage
let built: DerivativeBuildResult
let declared: Set<string>

beforeAll(async () => {
  outbox = mkdtempSync(join(tmpdir(), 'berelax-served-'))
  storage = createFakeMediaStorage({ outbox, now: () => '2026-09-18T10:00:00.000Z' })
  built = await buildDerivatives({
    mediaId: MEDIA_ID,
    slot: 'hero',
    source: await smallOriginal(),
    storage,
  })
  declared = new Set(built.outputs.map((output) => output.path))
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  rmSync(outbox, { recursive: true, force: true })
})

async function visit(html: string): Promise<Visit> {
  const context = await browser.newContext({
    viewport: { width: 414, height: 800 },
    deviceScaleFactor: 1,
  })
  const page = await context.newPage()
  const requested: string[] = []
  const unknown: string[] = []
  const headers = new Map<string, Record<string, string>>()

  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    requested.push(url.pathname)
    if (url.pathname === '/') {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
      return
    }
    const stored = await storage.head({ bucket: 'public', key: publicKeyFor(url.pathname) })
    if (stored === undefined) {
      // Not in the bucket. Aborted rather than faked, so a URL nothing ever built cannot pass unnoticed.
      unknown.push(url.pathname)
      await route.abort()
      return
    }
    // The headers come from the production helper, not from this test. Otherwise the assertion below is
    // about a string the test wrote down.
    const served = derivativeHeaders(url.pathname)
    await route.fulfill({
      status: 200,
      headers: { ...served },
      body: Buffer.from(await storage.get({ bucket: 'public', key: publicKeyFor(url.pathname) })),
    })
  })

  page.on('response', (response) => {
    headers.set(new URL(response.url()).pathname, response.headers())
  })

  await page.goto(`${ORIGIN}/`, { waitUntil: 'load' })
  await context.close()
  return { requested, unknown, headers }
}

/** The markup the site will use: an art-directed `<picture>` whose widths are not rungs. */
function heroMarkup(): string {
  const base = built.outputs.find(
    (output) => output.crop === 'mobile' && output.format === 'avif',
  )?.path
  const fallback = built.outputs.find(
    (output) => output.crop === 'mobile' && output.format === 'jpg' && output.width === 414,
  )?.path
  // Deliberately widths that are *not* rungs. The loader has to map each to the nearest one; if it echoed
  // them back the browser would request four objects that do not exist.
  const srcset = [360, 719, 900, 1290]
    .map((width) => `${mediaImageLoader({ src: base ?? '', width })} ${width}w`)
    .join(', ')
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>media</title></head><body>',
    '<picture>',
    `<source type="image/avif" media="${CROPS.mobile.media}" srcset="${srcset}" sizes="100vw">`,
    `<img src="${fallback}" alt="" width="414" height="518" fetchpriority="high" decoding="sync">`,
    '</picture>',
    '</body></html>',
  ].join('')
}

describe('what the browser requests', () => {
  it('requests only URLs in the declared set', async () => {
    const visited = await visit(heroMarkup())
    const images = visited.requested.filter((path) => path !== '/')
    // Without this the assertion below is vacuous: a page that loaded no image at all satisfies "every
    // image request is declared".
    expect(images.length).toBeGreaterThan(0)
    for (const path of images) {
      expect(declared, path).toContain(path)
    }
    expect(visited.unknown).toEqual([])
  })

  it('never requests an original or a Spaces CDN host', async () => {
    const visited = await visit(heroMarkup())
    for (const path of visited.requested) {
      expect(path).not.toContain(`/${PRIVATE_ORIGINALS_PREFIX}/`)
      expect(path).not.toContain('digitaloceanspaces.com')
    }
  })

  it('serves a derivative with a year of immutable caching', async () => {
    const visited = await visit(heroMarkup())
    const served = [...visited.headers.entries()].filter(([path]) => path !== '/')
    expect(served.length).toBeGreaterThan(0)
    for (const [path, headers] of served) {
      expect(headers['cache-control'], path).toBe(IMMUTABLE_CACHE_CONTROL)
      expect(headers['content-type'], path).toMatch(/^image\/(avif|webp|jpeg)$/)
    }
  })

  it('sees a URL outside the declared set when there is one', async () => {
    // The control for the capture itself. A request log that silently missed `<img src>` would make all
    // three assertions above pass forever, which is the ADR 0003 failure mode. 500 is not a rung, so this
    // path was never built.
    const undeclaredPath = derivativePath({
      mediaId: MEDIA_ID,
      contentHash: built.contentHash,
      slot: 'hero',
      crop: 'mobile',
      width: 500,
      format: 'avif',
    })
    expect(declared.has(undeclaredPath)).toBe(false)
    const visited = await visit(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>bad</title></head>` +
        `<body><img src="${undeclaredPath}" alt=""></body></html>`,
    )
    expect(visited.requested).toContain(undeclaredPath)
    expect(visited.unknown).toEqual([undeclaredPath])
  })
})

import { type ChildProcess, spawn } from 'node:child_process'
import { DARK_PALETTE, LIGHT_PALETTE } from '@berelax/ui'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * W-SYS-01 — the app shell, proved against the thing it actually produces.
 *
 * Every claim in this unit is about rendered output: which theme the body is painted in, which fonts
 * the browser asks for, whether an Arabic route is recalibrated. None of them can be checked by
 * reading the source, and all of them are the kind that silently stop being true — a token renamed, a
 * preload added, an `@import` reordered.
 *
 * So the built application is started and driven. It is slower than a unit test and it is the only
 * honest way to assert any of this.
 */
const PORT = 3123
const BASE = `http://127.0.0.1:${PORT}`

let server: ChildProcess
let browser: Browser

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start on ${BASE} within ${timeoutMs}ms`)
}

beforeAll(async () => {
  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'production' },
  })
  await waitForServer()
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

/**
 * The two grounds, as the browser reports them.
 *
 * Taken from the generated palette rather than written as literals: the claim under test is that the
 * rendered page resolves to the token, and a hand-typed `rgb(253, 250, 245)` here would be a second
 * copy of a value `scripts/palette.py` already owns. It is still a real assertion — the page has to get
 * from a token definition, through three stylesheet imports and a theme attribute, to a painted pixel.
 */
function rgbOf(hex: string): string {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
  return `rgb(${channels.join(', ')})`
}

const LIGHT_GROUND = rgbOf(LIGHT_PALETTE.ground)
const DARK_GROUND = rgbOf(DARK_PALETTE.ground)

async function bodyBackground(options: {
  colorScheme?: 'light' | 'dark'
  attribute?: 'light' | 'dark'
  path?: string
}): Promise<string> {
  const context = await browser.newContext({ colorScheme: options.colorScheme ?? 'light' })
  try {
    const page = await context.newPage()
    await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
    if (options.attribute !== undefined) {
      await page.addInitScript(
        ({ value }: { value: string }) => {
          globalThis.localStorage.setItem('berelax:theme', value)
        },
        { value: options.attribute },
      )
    }
    await page.goto(`${BASE}${options.path ?? '/'}`, { waitUntil: 'networkidle' })
    return await page.evaluate(
      () => globalThis.getComputedStyle(globalThis.document.body).backgroundColor,
    )
  } finally {
    await context.close()
  }
}

describe('acceptance — the theme resolves to the derived palette', () => {
  it('paints the light ground by default', async () => {
    expect(await bodyBackground({})).toBe(LIGHT_GROUND)
  }, 60_000)

  it('paints the dark ground under a dark system preference', async () => {
    expect(await bodyBackground({ colorScheme: 'dark' })).toBe(DARK_GROUND)
  }, 60_000)

  it('honours an explicit dark choice on a light device', async () => {
    expect(await bodyBackground({ colorScheme: 'light', attribute: 'dark' })).toBe(DARK_GROUND)
  }, 60_000)

  it('keeps an explicit light choice under a dark system preference', async () => {
    // The `:not([data-theme="light"])` guard on the media query. Without it, choosing light on a dark
    // phone does nothing at all, which is the single most reported theme bug there is.
    expect(await bodyBackground({ colorScheme: 'dark', attribute: 'light' })).toBe(LIGHT_GROUND)
  }, 60_000)

  it('applies the theme before first paint, not after hydration', async () => {
    // The blocking inline script. A page that corrects itself on hydration shows the wrong theme for
    // a frame, and on a dark-mode phone that frame is a flash of white.
    const context = await browser.newContext({ colorScheme: 'light' })
    try {
      const page = await context.newPage()
      await page.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f)' })
      await page.addInitScript(() => {
        globalThis.localStorage.setItem('berelax:theme', 'dark')
      })
      // `domcontentloaded`, before React has hydrated anything.
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      expect(
        await page.evaluate(() => globalThis.document.documentElement.getAttribute('data-theme')),
      ).toBe('dark')
    } finally {
      await context.close()
    }
  }, 60_000)
})

const KIB = 1024

interface FontRequest {
  readonly url: string
  readonly bytes: number
}

describe('acceptance — fonts', () => {
  /**
   * Every font byte a route actually pulls down, measured from the wire rather than from disk.
   *
   * Disk size is the wrong number twice over: it counts files the route never asks for, and it misses
   * that `unicode-range` is the mechanism doing the work. Only the network answers "what does a first
   * visit cost?", which is the question a font budget is asking.
   */
  async function fontRequests(path: string): Promise<FontRequest[]> {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const pending: Promise<FontRequest>[] = []
      page.on('response', (response) => {
        const url = response.url()
        if (
          !/\.(woff2?|ttf|otf)(\?|$)/.test(url) &&
          !/fonts\.(googleapis|gstatic)\.com/.test(url)
        ) {
          return
        }
        pending.push(
          response
            .body()
            .then((body) => ({ url, bytes: body.length }))
            .catch(() => ({ url, bytes: 0 })),
        )
      })
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
      // `networkidle` has fired, so every font response has at least started; awaiting the bodies here
      // rather than in the handler keeps the listener synchronous.
      return await Promise.all(pending)
    } finally {
      await context.close()
    }
  }

  function totalBytes(requests: readonly FontRequest[]): number {
    return requests.reduce((sum, request) => sum + request.bytes, 0)
  }

  it('preloads exactly two faces on an English route', async () => {
    // A preload is a promise the browser needs this file immediately. Four of them compete with the
    // LCP image for the same early bandwidth, and the two that are not above the fold win some of it.
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(BASE, { waitUntil: 'networkidle' })
      const preloads = await page.evaluate(() =>
        [...globalThis.document.querySelectorAll('link[rel="preload"][as="font"]')].map((link) =>
          link.getAttribute('href'),
        ),
      )
      expect(preloads).toHaveLength(2)
    } finally {
      await context.close()
    }
  }, 60_000)

  it('makes no request to a third-party font origin', async () => {
    // A third-party origin costs DNS, TLS and a connection before the first byte — 100-300ms on a
    // cold mobile connection, in the render-blocking path.
    const requests = await fontRequests('/')
    expect(
      requests.filter((request) => /fonts\.(googleapis|gstatic)\.com/.test(request.url)),
    ).toEqual([])
  }, 60_000)

  it('requests no Arabic font on an English route', async () => {
    // 92KB of glyphs the page does not contain, which is most of a mobile font budget.
    const requests = await fontRequests('/')
    expect(requests.filter((request) => /arabic/i.test(request.url))).toEqual([])
  }, 60_000)

  it('keeps the Latin faces an English route pulls down under 120KB', async () => {
    // A budget rather than a measurement: 120KB is roughly a second of the render-blocking path on a
    // slow 3G connection, and font bytes are spent before any content is legible.
    const requests = await fontRequests('/')
    expect(requests.length).toBeGreaterThan(0)
    expect(totalBytes(requests)).toBeLessThanOrEqual(120 * KIB)
  }, 60_000)

  it('keeps the Arabic route under 100KB, having shipped the weights it actually renders', async () => {
    // The Arabic route pays for the Arabic cuts, and there is no variable cut published — so the only
    // lever is not shipping a weight nothing draws. `theme/arabic.css` sets body copy to 500, so 500
    // and 600 are shipped and 400 is not; with 400 in the set, CSS weight matching resolved a request
    // for 500 downwards to 400 and the recalibration silently did nothing.
    const requests = await fontRequests('/ar')
    const arabic = requests.filter((request) => /arabic/i.test(request.url))
    expect(arabic.length).toBeGreaterThan(0)
    expect(totalBytes(arabic)).toBeLessThanOrEqual(100 * KIB)
  }, 60_000)
})

describe('acceptance — the Arabic route is recalibrated, not translated', () => {
  it('mirrors the layout and drops the tracking', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(`${BASE}/ar`, { waitUntil: 'networkidle' })
      const computed = await page.evaluate(() => {
        const main = globalThis.document.querySelector('main')
        if (main === null) throw new Error('no main element')
        const style = globalThis.getComputedStyle(main)
        const bodyStyle = globalThis.getComputedStyle(globalThis.document.body)
        return {
          locale: globalThis.document.documentElement.getAttribute('lang'),
          direction: style.direction,
          letterSpacing: style.letterSpacing,
          textTransform: style.textTransform,
          fontWeight: bodyStyle.fontWeight,
          scalar: globalThis
            .getComputedStyle(globalThis.document.documentElement)
            .getPropertyValue('--font-size-scalar'),
          lineHeight: bodyStyle.lineHeight,
          fontSize: bodyStyle.fontSize,
        }
      })
      // On `<html>`, not on a wrapper: every rule in `theme/arabic.css` is inherited from the document
      // element, and a wrapper leaves `body` Latin — which is how an earlier draft rendered mirrored
      // Arabic in Arial at the Latin line-height and failed nothing.
      expect(computed.locale).toBe('ar')
      expect(computed.direction).toBe('rtl')
      // Letter-spacing on a cursive script pulls the joins apart. It is never applied to Arabic.
      expect(computed.letterSpacing).toBe('normal')
      expect(computed.textTransform).toBe('none')
      // Arabic runs optically smaller at the same point size. docs/08 §3.
      expect(Number.parseFloat(computed.scalar)).toBeCloseTo(1.06, 5)
      expect(
        Number.parseFloat(computed.lineHeight) / Number.parseFloat(computed.fontSize),
      ).toBeGreaterThanOrEqual(1.85)
      // The Arabic face reads lighter than the Latin one at the same nominal weight, and 500 is a cut
      // that is actually shipped — with 400 and 600 in the set it resolved downwards to 400.
      expect(computed.fontWeight).toBe('500')
    } finally {
      await context.close()
    }
  }, 60_000)
})

describe('acceptance — Tailwind ships none of its own palette', () => {
  it('defines no default palette variable in the generated stylesheet', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto(BASE, { waitUntil: 'networkidle' })
      const css = await page.evaluate(() =>
        [...globalThis.document.styleSheets]
          .flatMap((sheet) => {
            try {
              return [...sheet.cssRules].map((rule) => rule.cssText)
            } catch {
              return []
            }
          })
          .join('\n'),
      )
      // `--color-*: initial` removes the namespace. If any of these survive, it did not.
      expect(css).not.toContain('--color-red-500')
      expect(css).not.toContain('--color-slate-')
      expect(css).not.toContain('--color-gray-')
      // Ours are there.
      expect(css).toContain('--color-ink')
      expect(css).toContain('--color-accent-gold')
    } finally {
      await context.close()
    }
  }, 60_000)
})

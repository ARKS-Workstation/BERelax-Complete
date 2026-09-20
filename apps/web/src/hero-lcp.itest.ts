import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { testPort } from '@berelax/harness/ports'
import { encodeRendition } from '@berelax/media'
import { CROPS, type CropName, type DerivativeFormat } from '@berelax/media/ladders'
import { cropForViewportWidth, selectedRungFor, srcsetFor } from '@berelax/media/srcset'
import { derivativeHeaders, publicKeyFor } from '@berelax/media/storage'
import { derivativePath } from '@berelax/media/url'
import { heroVideoSources } from '@berelax/media/video'
import { LIGHT_PALETTE, MOTION_STORAGE_KEY, THEME_STORAGE_KEY } from '@berelax/ui'
import { HERO_CROSS_FADE_MS, HERO_MIN_DOWNLINK_KBPS } from '@berelax/ui/media'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HERO_DEMO_ASSET, heroDemoMedia, STAND_IN_NOTE } from './media/hero-demo-asset.ts'
import { appMediaStorage, repositoryRoot } from './media/storage.ts'

/**
 * W-SYS-07 — the hero, in a browser, because not one of its claims can be read off source.
 *
 * "The largest-contentful-paint entry's element is the `<img>`" is a claim about a `PerformanceObserver`;
 * "at the moment that entry is recorded the video has no `currentSrc`" is a claim about two elements at
 * one instant, and it is false five hundred milliseconds later by design; "the head contains exactly two
 * art-directed preloads" is a claim about what React hoisted; and the attach, the cross-fade, the
 * tap-to-play reveal and the slow-connection hold are claims about what happens over seconds.
 *
 * ## Three things this browser cannot do, and what is done instead
 *
 * **1. It has no H.264 and no HEVC decoder.** Measured here rather than assumed:
 * `canPlayType('video/mp4; codecs="avc1.640028"')` returns the empty string in Playwright's Chromium,
 * which is built without proprietary codecs, and so does `hvc1`. Both of the pipeline's codecs are
 * therefore unplayable in the browser this suite runs in.
 *
 * **2. There is no footage.** `Y12-hero-video`: twenty-five committed files and not one frame of video, no
 * ffmpeg in this container, and consequently no rendition in any bucket to serve.
 *
 * **3. Serving the wrong bytes for a content type kills the renderer.** Fulfilling the `.mp4` request with
 * WebM bytes under `content-type: video/mp4` was tried first and hangs the page until Playwright reports
 * the target closed — Chromium picks its demuxer from the type. So the fixture is served as what it is.
 *
 * What the attach tests therefore do is replace the hero's **input**: the `data-hero-sources` attribute is
 * rewritten, in the HTML response, to one source this browser can decode — a VP8 WebM recorded by the
 * browser itself from a canvas, so no binary fixture is committed and no encoder is needed. Everything
 * after that is real: the island's own timing, its own `matchMedia` crop choice, a real network request, a
 * real decode, a real `playing` event, the real CSS transition and the real control. What is NOT proved
 * here is that a *pipeline* rendition decodes, which needs footage, an encoder and a browser with the
 * codec — and which `probe.ts` already checks at the byte level on the writing side.
 *
 * The four pipeline sources the page really declares are asserted separately, as data, against
 * `heroVideoSources()`.
 *
 * ## No determinism flags, deliberately
 *
 * Nothing here compares two screenshots, so `DETERMINISTIC_LAUNCH_ARGS` would be the wrong trade:
 * `--hide-scrollbars` changes the width a page is laid out at, and this file measures a control's box and
 * the crop a viewport is served. `DETERMINISM_CSS` is worse for this unit specifically — it hides `video`
 * outright, so a screenshot could never be evidence that a video is playing.
 */

/**
 * A random port in this suite's own range.
 *
 * The range is `@berelax/harness/ports`' to hand out, not this file's to pick. The comment this replaces
 * listed the neighbours and, in listing them, wrote down two overlaps as though they were the arrangement:
 * "primitives and messages 3800, kitchen sink and breakpoint preview 4400". Two worktrees running at once
 * must not have one suite's `next start` answer for another.
 */
const PORT = testPort('hero-lcp')
const BASE = `http://127.0.0.1:${PORT}`
const ROUTE = '/hero-demo'
const ROUTE_AR = '/ar/hero-demo'

/** The phone the booking happens on, and the laptop. The two crops' sides of the ladder's breakpoint. */
const PHONE = 390
const DESKTOP = 1440

let server: ChildProcess
let browser: Browser
/** A VP8 WebM recorded by the browser, standing in for a rendition this browser could decode. */
let fixtureVideo: Buffer

const media = heroDemoMedia()

/** The poster's derivative path for one rung, whether or not the bucket holds it yet. */
function posterPath(crop: CropName, width: number, format: DerivativeFormat = 'avif'): string {
  return derivativePath({
    mediaId: media.poster.mediaId,
    contentHash: media.poster.contentHash,
    slot: 'hero',
    crop,
    width,
    format,
  })
}

/**
 * Puts one rung in the bucket, through the production encoder, if it is not there already.
 *
 * The derivative job is enqueued by an upload path that is not wired yet (W-SYS-09's note), so nothing has
 * ever run it for this photograph — and an `<img>` whose bytes 404 is not an LCP candidate at all, which
 * would make the first assertion in this file quietly untestable. `encodeRendition` is the same function
 * `buildDerivatives` and `pnpm budgets` call, so what the browser downloads here is byte-identical to what
 * the site will serve.
 */
async function ensureRung(crop: CropName, width: number, format: DerivativeFormat): Promise<void> {
  const path = posterPath(crop, width, format)
  const storage = appMediaStorage()
  const key = publicKeyFor(path)
  if ((await storage.head({ bucket: 'public', key })) !== undefined) return
  const source = readFileSync(join(repositoryRoot(), 'assets', 'media', HERO_DEMO_ASSET))
  const bytes = await encodeRendition({ source, crop, width, format, focal: media.focal })
  const headers = derivativeHeaders(path)
  await storage.put({
    bucket: 'public',
    key,
    body: bytes,
    contentType: headers['content-type'],
    cacheControl: headers['cache-control'],
  })
}

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}${ROUTE}`)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start on ${BASE}${ROUTE} within ${timeoutMs}ms`)
}

/** Records a second of VP8 from a canvas. No committed binary, no encoder, no footage claimed. */
async function recordFixtureVideo(): Promise<Buffer> {
  const page = await browser.newPage()
  try {
    await page.goto('about:blank')
    // The two frame colours are the palette's own ground and ink, passed in rather than typed: `pnpm
    // colours` refuses a literal hex anywhere outside the token layer, and it is right to — a colour
    // nobody derived is a colour nobody measured, even in a fixture.
    const base64 = await page.evaluate(
      async ({ light, dark }: { light: string; dark: string }) => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 80
        const context = canvas.getContext('2d')
        const stream = canvas.captureStream(25)
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
        const chunks: Blob[] = []
        recorder.ondataavailable = (event) => chunks.push(event.data)
        const stopped = new Promise<void>((resolve) => {
          recorder.onstop = () => resolve()
        })
        recorder.start()
        // Alternating frames, so the recording has something to compress and the decoder something to
        // decode: a constant colour encodes to almost nothing and can finish before `playing` fires.
        for (let frame = 0; frame < 30; frame += 1) {
          if (context !== null) {
            context.fillStyle = frame % 2 === 0 ? light : dark
            context.fillRect(0, 0, 64, 80)
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        recorder.stop()
        await stopped
        const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer())
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary)
      },
      { light: LIGHT_PALETTE.ground, dark: LIGHT_PALETTE.ink },
    )
    return Buffer.from(base64, 'base64')
  } finally {
    await page.close()
  }
}

beforeAll(async () => {
  // The rungs this suite's two viewports are actually served, computed by the same selection rule the
  // browser uses rather than listed — a hard-coded width here would silently stop matching the ladder.
  for (const width of [PHONE, DESKTOP]) {
    const rung = selectedRungFor(width)
    await ensureRung(rung.crop, rung.width, 'avif')
  }
  // The desktop preload's `href` fallback, which is the narrowest desktop rung.
  await ensureRung('desktop', CROPS.desktop.widths[0] ?? 1024, 'avif')

  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  let output = ''
  server.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  server.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  await waitForServer()
  // The server that answered must be OURS: a reachable port plus a dead child is another checkout's
  // application answering for this one, and every assertion below would then be about its build.
  if (server.exitCode !== null) {
    throw new Error(
      `next start exited with ${server.exitCode} yet ${BASE} answered — something else is serving that ` +
        `port and these assertions would run against it:\n${output}`,
    )
  }
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
  fixtureVideo = await recordFixtureVideo()
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

interface PageOptions {
  readonly width?: number
  readonly path?: string
  readonly theme?: 'light' | 'dark'
  readonly reducedMotion?: 'reduce' | 'no-preference'
  readonly reducedTransparency?: boolean
  /** Resource timings the slow-connection gate will read instead of the real ones. */
  readonly timings?: { readonly transferSize: number; readonly duration: number }
  /** Make `play()` reject with the named DOMException, as an autoplay policy does. */
  readonly refusePlay?: string
  /** Serve a source this browser can decode, in place of the four the page declares. */
  readonly playableFixture?: boolean
}

/**
 * The observers every page in this file carries, installed before the document's first script.
 *
 * All three record rather than assert, because each is about an instant that has passed by the time a test
 * can ask: the LCP entry is emitted before `load`, the poster attribute would be set and unset between
 * frames, and "at first paint" is one frame long.
 */
const OBSERVERS = `
(() => {
  const w = globalThis
  w.__lcp = []
  w.__posterEverSet = false
  w.__firstPaint = null
  w.__opacity = []

  const hero = () => document.querySelector('.be-hero')
  const video = () => document.querySelector('video')

  // 0. When the document finished loading, and when the first <source> appeared. docs/08 §6 defers the
  //    attach to an idle callback after load; the two timestamps are what make "after" a measurement.
  w.__loadAt = null
  w.__firstSourceAt = null
  addEventListener('load', () => {
    w.__loadAt = performance.now()
  })

  // 1. Every largest-contentful-paint entry, with the state of the video AT THAT MOMENT. Reading the
  //    video afterwards would read it after the island had run, which is the opposite of the claim.
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const element = entry.element
      const v = video()
      w.__lcp.push({
        tag: element ? element.tagName : null,
        className: element ? String(element.className) : null,
        currentSrc: element && element.currentSrc ? element.currentSrc : null,
        naturalWidth: element ? element.naturalWidth ?? null : null,
        naturalHeight: element ? element.naturalHeight ?? null : null,
        size: entry.size,
        videoCurrentSrc: v ? v.currentSrc : null,
        videoHasSrcAttribute: v ? v.hasAttribute('src') : null,
        videoHasPosterAttribute: v ? v.hasAttribute('poster') : null,
        videoSourceCount: v ? v.querySelectorAll('source').length : null,
        heroState: hero() ? hero().getAttribute('data-hero-state') : null,
      })
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true })

  // 2. A poster attribute at any point in the page's life, including one set and removed between frames.
  const checkPoster = () => {
    // Every video on the page, not just the hero's: a poster anywhere is the failure, and it is also what
    // lets the test prove this watch is registered by showing it one.
    for (const v of document.querySelectorAll('video')) {
      if (v.hasAttribute('poster')) w.__posterEverSet = true
    }
    const v = video()
    if (w.__firstSourceAt === null && v && v.querySelector('source') !== null) {
      w.__firstSourceAt = performance.now()
    }
  }
  // \`document\`, not \`document.documentElement\`: an init script runs BEFORE the document element exists,
  // so observing it throws \`parameter 1 is not of type 'Node'\` — and the throw took the rest of this
  // script with it, leaving the poster watch and the paint observer unregistered while
  // \`__posterEverSet\` stayed \`false\` and read as a pass. A vacuous observer is ADR 0002 with a
  // MutationObserver attached, and it is why every observer here records into a list a test then asserts
  // is non-empty.
  new MutationObserver(checkPoster).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['poster'],
  })
  document.addEventListener('DOMContentLoaded', checkPoster)

  // 3. Everything above the fold at first paint: a running animation, or a computed opacity below 1.
  const snapshot = () => {
    const animations = []
    const faded = []
    const visible = (element) => {
      const rect = element.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0
    }
    const name = (element) =>
      element.tagName.toLowerCase() +
      (element.id ? '#' + element.id : '') +
      (element.className ? '.' + String(element.className).split(' ').join('.') : '')
    for (const element of document.querySelectorAll('*')) {
      if (!visible(element)) continue
      const opacity = Number(getComputedStyle(element).opacity)
      if (Number.isFinite(opacity) && opacity < 1) faded.push(name(element) + ' @ ' + opacity)
    }
    for (const animation of document.getAnimations()) {
      const target = animation.effect && animation.effect.target
      if (!target || !visible(target)) continue
      if (animation.playState !== 'running') continue
      animations.push(name(target) + ' <- ' + (animation.animationName || animation.transitionProperty))
    }
    w.__firstPaint = { animations, faded }
  }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-contentful-paint') requestAnimationFrame(snapshot)
    }
  }).observe({ type: 'paint', buffered: true })

  // 4. The cross-fade, sampled. A transition is over in 320ms and cannot be caught by a round trip.
  w.__transitions = []
  const sample = () => {
    const v = video()
    const h = hero()
    if (v && h) {
      w.__opacity.push({
        t: Math.round(performance.now()),
        opacity: Number(getComputedStyle(v).opacity),
        state: h.getAttribute('data-hero-state'),
        duration: getComputedStyle(v).transitionDuration,
      })
      // The transition the engine actually created, caught while it is running. A sample list can step
      // over a fade that starts and ends between two frames; this cannot.
      for (const animation of v.getAnimations()) {
        w.__transitions.push({
          property: animation.transitionProperty ?? null,
          ms: animation.effect ? Number(animation.effect.getTiming().duration) : null,
          state: h.getAttribute('data-hero-state'),
        })
      }
    }
    if (w.__opacity.length < 900) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
})()
`

interface LcpEntry {
  readonly tag: string | null
  readonly className: string | null
  readonly currentSrc: string | null
  readonly naturalWidth: number | null
  readonly naturalHeight: number | null
  readonly size: number
  readonly videoCurrentSrc: string | null
  readonly videoHasSrcAttribute: boolean | null
  readonly videoHasPosterAttribute: boolean | null
  readonly videoSourceCount: number | null
  readonly heroState: string | null
}

async function withPage<T>(options: PageOptions, body: (page: Page) => Promise<T>): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? DESKTOP, height: 900 },
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
    ...(options.theme === undefined ? {} : { colorScheme: options.theme }),
  })
  try {
    // esbuild compiles this suite with `keepNames`, rewriting every named function as `__name(fn, 'fn')`,
    // and Playwright serialises a callback's *compiled* source into the page. The same line as every other
    // browser suite here.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    if (options.theme !== undefined) {
      await context.addInitScript(
        ({ key, value }: { key: string; value: string }) => {
          globalThis.localStorage.setItem(key, value)
        },
        { key: THEME_STORAGE_KEY, value: options.theme },
      )
    }
    if (options.refusePlay !== undefined) {
      await context.addInitScript(
        ({ name }: { name: string }) => {
          // An autoplay policy rejects the promise `play()` returns and does nothing else: no error
          // event, no `error` property, no state change. That is exactly what this reproduces.
          HTMLMediaElement.prototype.play = () =>
            Promise.reject(new DOMException('Autoplay refused by this fixture', name))
        },
        { name: options.refusePlay },
      )
    }
    if (options.timings !== undefined) {
      await context.addInitScript(
        ({ transferSize, duration }: { transferSize: number; duration: number }) => {
          const real = performance.getEntriesByType.bind(performance)
          performance.getEntriesByType = (type: string) =>
            type === 'resource'
              ? ([{ name: 'fixture', entryType: 'resource', transferSize, duration }] as never)
              : real(type as never)
        },
        options.timings,
      )
    }
    await context.addInitScript({ content: OBSERVERS })
    const page = await context.newPage()
    if (options.reducedTransparency === true) {
      // Playwright emulates `prefers-reduced-motion` and `prefers-color-scheme` and not this one, so it
      // goes through the protocol it would use anyway.
      const session = await context.newCDPSession(page)
      await session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
      })
    }
    if (options.playableFixture === true) {
      await page.route('**/*-video-*.mp4', async (route) => {
        await route.fulfill({
          status: 200,
          // The bytes are VP8 in a WebM container and the header says so. Lying about the type here hangs
          // the renderer — Chromium selects its demuxer from the content type — which was measured before
          // it was written down.
          headers: { 'content-type': 'video/webm', 'accept-ranges': 'bytes' },
          body: fixtureVideo,
        })
      })
      await page.route(`${BASE}${options.path ?? ROUTE}`, async (route) => {
        const response = await route.fetch()
        const html = await response.text()
        const attribute = /data-hero-sources="[^"]*"/
        expect(html).toMatch(attribute)
        // One source, typed as what the fixture really is, at the URL the pipeline really declares — so
        // the request the island makes is still for a rendition path and the island's own code is
        // unchanged.
        const replacement = JSON.stringify([
          {
            src: heroVideoSources(media.video)[0]?.src ?? '',
            type: 'video/webm; codecs="vp8"',
            media: CROPS.desktop.media,
          },
        ]).replaceAll('"', '&quot;')
        await route.fulfill({
          response,
          body: html.replace(attribute, `data-hero-sources="${replacement}"`),
        })
      })
    }
    await page.bringToFront()
    await page.goto(`${BASE}${options.path ?? ROUTE}`, { waitUntil: 'load' })
    // The poster has to have arrived for any of this to be about the poster: an `<img>` whose bytes 404 is
    // not an LCP candidate, and every assertion below would then be about a heading.
    await page.waitForFunction(() => {
      const img = document.querySelector('.be-hero img')
      return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/** Waits for the hero to settle into one of the states given, and returns it. */
async function heroState(page: Page, states: readonly string[], timeout = 15_000): Promise<string> {
  await page.waitForFunction(
    (wanted: readonly string[]) => {
      const hero = document.querySelector('.be-hero')
      const state = hero?.getAttribute('data-hero-state') ?? ''
      return wanted.includes(state)
    },
    states,
    { timeout },
  )
  return await page.evaluate(
    () => document.querySelector('.be-hero')?.getAttribute('data-hero-state') ?? '',
  )
}

describe('acceptance — the LCP element is the hero img, and the video has no resource when it is recorded', () => {
  for (const width of [PHONE, DESKTOP]) {
    it(`records the img at ${width}px, with an empty video beside it`, async () => {
      const entries = await withPage({ width }, async (page) => {
        return await page.evaluate(() => (globalThis as unknown as { __lcp: LcpEntry[] }).__lcp)
      })
      // The control on the observer itself: an empty list would satisfy every assertion below, and is
      // exactly what a page with no LCP candidate produces.
      expect(
        entries.length,
        'no largest-contentful-paint entry was recorded at all',
      ).toBeGreaterThan(0)
      const last = entries.at(-1)
      expect(last?.tag, JSON.stringify(entries)).toBe('IMG')
      // Not merely "an IMG": the hero's own poster, at the rung this viewport is served. Any other image
      // on the page would satisfy the tag assertion and say nothing about the hero, and an earlier draft
      // asserted `className` here — which on this `<img>` is the empty string, so it could not fail.
      expect(new URL(last?.currentSrc ?? 'about:blank').pathname).toBe(
        posterPath(cropForViewportWidth(width), selectedRungFor(width).width),
      )
      expect(last?.size).toBeGreaterThan(10_000)
      // The whole point, at the instant the entry was recorded rather than afterwards.
      for (const entry of entries) {
        expect(entry.tag, 'a VIDEO became the LCP element').not.toBe('VIDEO')
        expect(entry.videoCurrentSrc, 'the video had a resource when LCP was recorded').toBe('')
        expect(entry.videoHasSrcAttribute).toBe(false)
        expect(entry.videoHasPosterAttribute).toBe(false)
        expect(entry.videoSourceCount).toBe(0)
        // And the island had not yet run, which is why: `still` is the state the server renders.
        expect(entry.heroState).toBe('still')
      }
    }, 60_000)
  }
})

describe('acceptance — the video element itself', () => {
  it('never carries a poster, and declares preload none, muted, loop and playsinline', async () => {
    const seen = await withPage({ playableFixture: true }, async (page) => {
      const state = await heroState(page, ['playing', 'paused', 'held'])
      const attributes = await page.evaluate(() => {
        const video = document.querySelector('video')
        return {
          preload: video?.getAttribute('preload') ?? null,
          hasPoster: video?.hasAttribute('poster') ?? null,
          muted: video?.muted ?? null,
          mutedAttribute: video?.hasAttribute('muted') ?? null,
          loop: video?.hasAttribute('loop') ?? null,
          playsinline: video?.hasAttribute('playsinline') ?? null,
          autoplay: video?.hasAttribute('autoplay') ?? null,
          posterEverSet: (globalThis as unknown as { __posterEverSet: boolean }).__posterEverSet,
        }
      })
      // The control on the watch itself, run after the reading above so it cannot affect it: set a poster
      // on a video this page does not use, and watch the flag flip.
      const watchWorks = await page.evaluate(async () => {
        const probe = document.createElement('video')
        document.body.append(probe)
        probe.setAttribute('poster', '/probe.jpg')
        await new Promise((resolve) => setTimeout(resolve, 50))
        const seen = (globalThis as unknown as { __posterEverSet: boolean }).__posterEverSet
        probe.remove()
        return seen
      })
      return { state, attributes: { ...attributes, watchWorks } }
    })
    // Attached and playing, so these are the attributes of a video that has actually been used rather
    // than of one nothing ever touched.
    expect(seen.state).toBe('playing')
    // The watch has to have been REGISTERED for its answer to mean anything: an observer that threw at
    // document-start leaves this flag `false` for ever, which reads exactly like a pass. It is proved by
    // setting a poster from the test and watching the flag flip.
    expect(seen.attributes.watchWorks, 'the poster watch never saw a poster it was shown').toBe(
      true,
    )
    expect(seen.attributes.posterEverSet, 'a poster attribute existed at some point').toBe(false)
    expect(seen.attributes.hasPoster).toBe(false)
    // `preload` is raised to `auto` by the island when it attaches; what the document ships is `none`,
    // and the fetched HTML is where that is visible.
    const html = await (await fetch(`${BASE}${ROUTE}`)).text()
    expect(html).toContain('preload="none"')
    expect(seen.attributes.muted).toBe(true)
    expect(seen.attributes.mutedAttribute).toBe(true)
    expect(seen.attributes.loop).toBe(true)
    expect(seen.attributes.playsinline).toBe(true)
    // Never autoplay: the island calls `play()` itself, so a refusal is a promise it can catch rather
    // than a silent no-op it cannot see.
    expect(seen.attributes.autoplay).toBe(false)
  }, 60_000)

  it('declares the four pipeline renditions, and nothing else', async () => {
    const declared = await withPage({}, async (page) =>
      page.evaluate(
        () => document.querySelector('video')?.getAttribute('data-hero-sources') ?? '[]',
      ),
    )
    const expected = heroVideoSources(media.video).map((source) => ({
      src: source.src,
      type: source.type,
      media: source.media,
    }))
    expect(JSON.parse(declared)).toEqual(expected)
    // Four, two per crop, HEVC first — the order and the count are the ladder's, not this component's.
    expect(expected).toHaveLength(4)
    // The page says so in prose as well, so "there is no footage" cannot be dropped quietly.
    const html = await (await fetch(`${BASE}${ROUTE}`)).text()
    expect(html).toContain('Y12-hero-video')
    expect(html.replace(/&#x27;|&#39;/g, "'")).toContain(STAND_IN_NOTE.slice(0, 60))
  }, 60_000)
})

describe('acceptance — art direction', () => {
  for (const [width, expected] of [
    [PHONE, CROPS.mobile.ratio[0] / CROPS.mobile.ratio[1]],
    [DESKTOP, CROPS.desktop.ratio[0] / CROPS.desktop.ratio[1]],
  ] as const) {
    it(`serves the ${cropForViewportWidth(width)} crop at ${width}px`, async () => {
      const seen = await withPage({ width }, async (page) =>
        page.evaluate(() => {
          const img = document.querySelector('.be-hero img') as HTMLImageElement
          return {
            currentSrc: img.currentSrc,
            ratio: img.naturalWidth / img.naturalHeight,
            naturalWidth: img.naturalWidth,
          }
        }),
      )
      const crop = cropForViewportWidth(width)
      const rung = selectedRungFor(width)
      expect(seen.ratio).toBeCloseTo(expected, 2)
      expect(Math.abs(seen.ratio - expected)).toBeLessThan(0.01)
      // The file itself is the crop's own rung, not a resized copy of the other crop.
      expect(new URL(seen.currentSrc).pathname).toBe(posterPath(crop, rung.width))
      // `naturalWidth` is NOT the rung's width, and that is the specification rather than a surprise: a
      // candidate chosen from a `w` descriptor carries a current pixel density of candidate/used-size, and
      // the intrinsic dimensions are corrected by it. At 390 CSS px the 414 rung reports a natural width of
      // 390. Both dimensions are corrected by the same factor, which is why the RATIO is the thing the
      // acceptance criterion asks about and the thing asserted above.
      expect(seen.naturalWidth).toBeGreaterThan(0)
      expect(seen.naturalWidth).toBeLessThanOrEqual(rung.width)
    }, 60_000)
  }

  it('preloads exactly two images, one per media query', async () => {
    const links = await withPage({}, async (page) =>
      page.evaluate(() =>
        [...document.head.querySelectorAll('link[rel="preload"][as="image"]')].map((link) => ({
          href: link.getAttribute('href'),
          media: link.getAttribute('media'),
          type: link.getAttribute('type'),
          fetchpriority: link.getAttribute('fetchpriority'),
          imagesrcset: link.getAttribute('imagesrcset'),
          imagesizes: link.getAttribute('imagesizes'),
        })),
      ),
    )
    expect(links).toHaveLength(2)
    for (const crop of ['mobile', 'desktop'] as const) {
      const link = links.find((candidate) => candidate.media === CROPS[crop].media)
      expect(link, `no preload for the ${crop} crop`).toBeDefined()
      expect(link?.type).toBe('image/avif')
      expect(link?.fetchpriority).toBe('high')
      expect(link?.imagesizes).toBe('100vw')
      // The same builder the `<picture>` uses. A second srcset builder is a second answer, and W-SYS-10
      // made this one the only one.
      expect(link?.imagesrcset).toBe(srcsetFor(media.poster, crop, 'avif'))
      // The first candidate in each set is the crop's narrowest rung, which is the `href` the two
      // `preload()` calls are keyed apart by. React writes a responsive preload with no `href`
      // attribute — the form the HTML specification allows when `imagesrcset` is present — so the key is
      // asserted through the set it belongs to rather than through an attribute that is deliberately
      // absent.
      expect(link?.imagesrcset?.startsWith(posterPath(crop, CROPS[crop].widths[0] ?? 0))).toBe(true)
    }
    // The control: the two links are for different crops. Rendering them as JSX produced FOUR — the
    // hoisted element and React's own float directive, one pair per crop — which is why they are made
    // with `preload()`.
    expect(new Set(links.map((link) => link.media)).size).toBe(2)
    expect(new Set(links.map((link) => link.imagesrcset)).size).toBe(2)
  }, 60_000)
})

describe('acceptance — the island attaches after the page has loaded, and cross-fades on playing', () => {
  it('attaches, plays, and raises the video from 0 to 1 over the duration token', async () => {
    const seen = await withPage({ playableFixture: true }, async (page) => {
      const state = await heroState(page, ['playing'])
      await page.waitForTimeout(HERO_CROSS_FADE_MS * 2)
      return {
        state,
        ...(await page.evaluate(() => {
          const video = document.querySelector('video') as HTMLVideoElement
          const control = document.querySelector('.be-hero__control') as HTMLButtonElement
          return {
            currentSrc: video.currentSrc,
            sources: [...video.querySelectorAll('source')].map((source) => source.src),
            preload: video.preload,
            paused: video.paused,
            controlState: control.getAttribute('data-hero-control'),
            controlHidden: control.hidden,
            samples: (
              globalThis as unknown as {
                __opacity: { opacity: number; state: string; duration: string }[]
              }
            ).__opacity,
            transitions: (
              globalThis as unknown as {
                __transitions: { property: string | null; ms: number | null; state: string }[]
              }
            ).__transitions,
            loadAt: (globalThis as unknown as { __loadAt: number | null }).__loadAt,
            firstSourceAt: (globalThis as unknown as { __firstSourceAt: number | null })
              .__firstSourceAt,
          }
        })),
      }
    })
    expect(seen.state).toBe('playing')
    expect(seen.paused).toBe(false)
    // docs/08 §6 defers the attach to an idle callback (timeout 2500) or `load + 400ms`, and the island
    // waits for `load` on both branches so an idle period during the network's busiest moment cannot put
    // a video download in front of the poster. Measured rather than assumed: the first `<source>` appeared
    // after the load event. The other half of the same claim is in the LCP assertions above, where the
    // hero is still in its server-rendered state at the instant the entry is recorded.
    expect(seen.loadAt, 'the load event was never recorded').not.toBeNull()
    expect(seen.firstSourceAt, 'no source was ever attached').not.toBeNull()
    expect(Number(seen.firstSourceAt)).toBeGreaterThan(Number(seen.loadAt))
    expect(seen.sources).toHaveLength(1)
    expect(seen.currentSrc).not.toBe('')
    // The island raised `preload` from `none`: with `preload="none"` the element fetches nothing and the
    // request would be made from inside the promise an autoplay refusal can cancel.
    expect(seen.preload).toBe('auto')
    // WCAG 2.2.2: while the loop plays there is a visible control, and it offers pause.
    expect(seen.controlHidden).toBe(false)
    expect(seen.controlState).toBe('pause')

    // The cross-fade. Two independent pieces of evidence, because a sample list alone can step over a
    // fade that begins and ends between two animation frames — which is what a cached rendition on a
    // fast connection does, and is why the island commits the transparent frame before attaching.
    const playing = seen.samples.filter((sample) => sample.state === 'playing')
    expect(playing.length, 'no sample was taken while playing').toBeGreaterThan(0)
    expect(playing.at(-1)?.opacity).toBe(1)
    // It rose: the lowest opacity seen while playing is near zero and the highest is one.
    expect(Math.min(...playing.map((sample) => sample.opacity))).toBeLessThan(0.5)
    expect(Math.max(...playing.map((sample) => sample.opacity))).toBe(1)
    // And the engine really created an opacity transition of the token's duration — docs/08 §6's 320ms,
    // which is what `--dur-slow` is.
    const fade = seen.transitions.filter((entry) => entry.property === 'opacity')
    expect(fade.length, 'no opacity transition ran at all').toBeGreaterThan(0)
    for (const entry of fade) expect(entry.ms).toBe(HERO_CROSS_FADE_MS)
    expect(playing.at(-1)?.duration).toBe(`${HERO_CROSS_FADE_MS / 1000}s`)
  }, 90_000)

  it('chooses the crop with the ladder’s own media query', async () => {
    // `media` on a `<source>` inside a `<video>` does nothing, so the island evaluates the query itself.
    // The oracle is `cropForViewportWidth`, the same function the admin preview resolves a crop with.
    for (const width of [PHONE, DESKTOP]) {
      const attached = await withPage({ width, refusePlay: 'NotAllowedError' }, async (page) => {
        await heroState(page, ['paused', 'held'])
        return await page.evaluate(() =>
          [...document.querySelectorAll('video source')].map((source) =>
            source.getAttribute('src'),
          ),
        )
      })
      const crop = cropForViewportWidth(width)
      expect(attached.length, `${width}px attached nothing`).toBeGreaterThan(0)
      for (const src of attached) expect(src).toContain(`-video-${crop}-`)
      // The control: the other crop's renditions were not attached.
      const other = crop === 'mobile' ? 'desktop' : 'mobile'
      for (const src of attached) expect(src).not.toContain(`-video-${other}-`)
    }
  }, 90_000)
})

describe('acceptance — the slow-connection gate', () => {
  it('never attaches below 600 kbit/s, and the still remains after five seconds', async () => {
    // 8KB in 200ms is 327 kbit/s. The fixture is a PerformanceResourceTiming, not a navigator flag.
    const seen = await withPage(
      { timings: { transferSize: 8192, duration: 200 }, playableFixture: true },
      async (page) => {
        const state = await heroState(page, ['held'])
        await page.waitForTimeout(5_000)
        return {
          state,
          ...(await page.evaluate(() => {
            const video = document.querySelector('video') as HTMLVideoElement
            const img = document.querySelector('.be-hero img') as HTMLImageElement
            const control = document.querySelector('.be-hero__control') as HTMLButtonElement
            return {
              hold: document.querySelector('.be-hero')?.getAttribute('data-hero-hold') ?? null,
              sources: video.querySelectorAll('source').length,
              currentSrc: video.currentSrc,
              controlHidden: control.hidden,
              stillVisible:
                img.complete && img.naturalWidth > 0 && img.getBoundingClientRect().height > 0,
            }
          })),
        }
      },
    )
    expect(seen.state).toBe('held')
    expect(seen.hold).toBe('slow-connection')
    expect(seen.sources).toBe(0)
    expect(seen.currentSrc).toBe('')
    expect(seen.stillVisible).toBe(true)
    expect(seen.controlHidden).toBe(true)
  }, 90_000)

  it('attaches on a fast measurement, which is the control for the case above', async () => {
    // 200KB in 100ms is 16 Mbit/s. Same fixture mechanism, same page, opposite answer — without this the
    // test above passes on a hero that never attaches anywhere.
    const state = await withPage(
      { timings: { transferSize: 200_000, duration: 100 }, playableFixture: true },
      async (page) => heroState(page, ['playing', 'paused', 'held']),
    )
    expect(state).toBe('playing')
    expect(HERO_MIN_DOWNLINK_KBPS).toBe(600)
  }, 90_000)
})

describe('acceptance — autoplay refusal, the control, and the remembered choice', () => {
  it('reveals tap-to-play when play() rejects with NotAllowedError', async () => {
    const seen = await withPage({ refusePlay: 'NotAllowedError' }, async (page) => {
      const state = await heroState(page, ['paused', 'held'])
      return {
        state,
        ...(await page.evaluate(() => {
          const hero = document.querySelector('.be-hero') as HTMLElement
          const control = document.querySelector('.be-hero__control') as HTMLButtonElement
          const box = control.getBoundingClientRect()
          const heroBox = hero.getBoundingClientRect()
          return {
            controlState: control.getAttribute('data-hero-control'),
            hidden: control.hidden,
            label: control.getAttribute('aria-label'),
            width: box.width,
            height: box.height,
            fromInlineEnd: heroBox.right - box.right,
            fromBottom: heroBox.bottom - box.bottom,
            sources: document.querySelectorAll('video source').length,
          }
        })),
      }
    })
    expect(seen.state).toBe('paused')
    expect(seen.controlState).toBe('play')
    expect(seen.hidden).toBe(false)
    expect(seen.label).toBe('Play the background video')
    // docs/08 §6: at least 44x44 CSS px. The system's own floor is 48, which is the larger of the two.
    expect(seen.width).toBeGreaterThanOrEqual(44)
    expect(seen.height).toBeGreaterThanOrEqual(44)
    // Bottom inline-end, which in an English document is the right-hand side.
    expect(seen.fromInlineEnd).toBeGreaterThan(0)
    expect(seen.fromInlineEnd).toBeLessThan(80)
    expect(seen.fromBottom).toBeGreaterThan(0)
    expect(seen.fromBottom).toBeLessThan(80)
    // The sources stay attached, so the reader's tap plays what has been fetched rather than starting
    // the fetch.
    expect(seen.sources).toBeGreaterThan(0)
  }, 90_000)

  it('puts the control at the bottom inline-end of the Arabic document too', async () => {
    const seen = await withPage({ refusePlay: 'NotAllowedError', path: ROUTE_AR }, async (page) => {
      await heroState(page, ['paused', 'held'])
      return await page.evaluate(() => {
        const hero = document.querySelector('.be-hero') as HTMLElement
        const control = document.querySelector('.be-hero__control') as HTMLButtonElement
        const box = control.getBoundingClientRect()
        const heroBox = hero.getBoundingClientRect()
        return {
          dir: document.documentElement.getAttribute('dir'),
          label: control.getAttribute('aria-label'),
          fromInlineEnd: box.left - heroBox.left,
          fromBottom: heroBox.bottom - box.bottom,
        }
      })
    })
    expect(seen.dir).toBe('rtl')
    // Inline-end in Arabic is the LEFT-hand side. A control positioned with `right` would pass every
    // assertion in the test above and fail here, which is why the RTL half is a document of its own.
    expect(seen.fromInlineEnd).toBeGreaterThan(0)
    expect(seen.fromInlineEnd).toBeLessThan(80)
    expect(seen.fromBottom).toBeGreaterThan(0)
    expect(seen.label).toBe('تشغيل فيديو الخلفية')
  }, 90_000)

  it('re-reveals tap-to-play on a later pause, and remembers the choice across a reload', async () => {
    const seen = await withPage({ playableFixture: true }, async (page) => {
      await heroState(page, ['playing'])
      // The reader's own tap. It is also the iOS Low Power path: both arrive as a `pause` event, which
      // is the listener docs/08 §6 asks for by name.
      await page.click('.be-hero__control')
      const afterPause = await heroState(page, ['paused'])
      const stored = await page.evaluate(
        (key: string) => globalThis.localStorage.getItem(key),
        MOTION_STORAGE_KEY,
      )
      const control = await page.evaluate(() => {
        const button = document.querySelector('.be-hero__control') as HTMLButtonElement
        const video = document.querySelector('video') as HTMLVideoElement
        return {
          state: button.getAttribute('data-hero-control'),
          hidden: button.hidden,
          label: button.getAttribute('aria-label'),
          paused: video.paused,
        }
      })
      // Reload: the stored choice has to survive it, which is the criterion.
      await page.reload({ waitUntil: 'load' })
      const reloaded = await heroState(page, ['held'])
      const after = await page.evaluate(() => {
        const button = document.querySelector('.be-hero__control') as HTMLButtonElement
        return {
          hold: document.querySelector('.be-hero')?.getAttribute('data-hero-hold') ?? null,
          state: button.getAttribute('data-hero-control'),
          hidden: button.hidden,
          sources: document.querySelectorAll('video source').length,
        }
      })
      return { afterPause, stored, control, reloaded, after }
    })
    expect(seen.afterPause).toBe('paused')
    expect(seen.control.paused).toBe(true)
    expect(seen.control.state).toBe('play')
    expect(seen.control.hidden).toBe(false)
    expect(seen.control.label).toBe('Play the background video')
    expect(seen.stored).toBe('paused')
    expect(seen.reloaded).toBe('held')
    expect(seen.after.hold).toBe('reader-paused')
    // Remembered means the bytes are not fetched again either: nothing is attached at all.
    expect(seen.after.sources).toBe(0)
    expect(seen.after.state).toBe('play')
    expect(seen.after.hidden).toBe(false)
  }, 90_000)
})

describe('acceptance — reduced motion, reduced transparency and the blur ceiling', () => {
  it('never attaches under reduced motion, and offers no control', async () => {
    const seen = await withPage(
      { reducedMotion: 'reduce', playableFixture: true },
      async (page) => {
        const state = await heroState(page, ['held'])
        await page.waitForTimeout(2_000)
        return {
          state,
          ...(await page.evaluate(() => ({
            hold: document.querySelector('.be-hero')?.getAttribute('data-hero-hold') ?? null,
            sources: document.querySelectorAll('video source').length,
            controlHidden: (document.querySelector('.be-hero__control') as HTMLButtonElement)
              .hidden,
            ambient: getComputedStyle(document.documentElement)
              .getPropertyValue('--dur-ambient')
              .trim(),
          }))),
        }
      },
    )
    expect(seen.state).toBe('held')
    expect(seen.hold).toBe('reduced-motion')
    expect(seen.sources).toBe(0)
    expect(seen.controlHidden).toBe(true)
    // And the reason it held: the token the one authored reduced-motion override zeroes. No second media
    // query was added anywhere — `pnpm layout` asserts that in source, and this is the same claim from
    // the browser's side.
    expect(seen.ambient).toBe('0s')
  }, 90_000)

  it('never attaches under reduced transparency, and drops every blur to zero', async () => {
    const seen = await withPage(
      { reducedTransparency: true, playableFixture: true },
      async (page) => {
        const state = await heroState(page, ['held'])
        return {
          state,
          ...(await page.evaluate(() => {
            const blurs: string[] = []
            for (const element of document.querySelectorAll('*')) {
              const filter = getComputedStyle(element).backdropFilter
              if (filter && filter !== 'none') blurs.push(filter)
            }
            return {
              hold: document.querySelector('.be-hero')?.getAttribute('data-hero-hold') ?? null,
              sources: document.querySelectorAll('video source').length,
              flag: getComputedStyle(document.documentElement)
                .getPropertyValue('--hero-video')
                .trim(),
              blurs,
            }
          })),
        }
      },
    )
    expect(seen.state).toBe('held')
    expect(seen.hold).toBe('reduced-transparency')
    expect(seen.sources).toBe(0)
    expect(seen.flag).toBe('0')
    for (const filter of seen.blurs) {
      const px = Number(/blur\(([\d.]+)px\)/.exec(filter)?.[1] ?? 0)
      expect(px, filter).toBe(0)
    }
  }, 90_000)

  it('keeps every backdrop blur at or under 8px with transparency allowed', async () => {
    const blurs = await withPage({ refusePlay: 'NotAllowedError' }, async (page) => {
      await heroState(page, ['paused', 'held'])
      return await page.evaluate(() => {
        const found: { where: string; filter: string }[] = []
        for (const element of document.querySelectorAll('*')) {
          const filter = getComputedStyle(element).backdropFilter
          if (filter && filter !== 'none') found.push({ where: String(element.className), filter })
        }
        return found
      })
    })
    // The control is the one element on this route that has one, so an empty list would mean the
    // assertion below examined nothing.
    expect(blurs.length).toBeGreaterThan(0)
    for (const { where, filter } of blurs) {
      const px = Number(/blur\(([\d.]+)px\)/.exec(filter)?.[1] ?? 0)
      expect(px, `${where}: ${filter}`).toBeLessThanOrEqual(8)
    }
  }, 90_000)
})

describe('acceptance — nothing above the fold animates or arrives faded', () => {
  for (const path of [ROUTE, ROUTE_AR]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`${path} in the ${theme} theme paints everything at once`, async () => {
        const first = await withPage({ path, theme, width: PHONE }, async (page) => {
          await page.waitForFunction(
            () => (globalThis as unknown as { __firstPaint: unknown }).__firstPaint !== null,
          )
          return await page.evaluate(() => ({
            paint: (
              globalThis as unknown as { __firstPaint: { animations: string[]; faded: string[] } }
            ).__firstPaint,
            theme: document.documentElement.getAttribute('data-theme'),
            dir: document.documentElement.getAttribute('dir'),
          }))
        })
        // The cell is the cell it claims to be, before anything is concluded from it.
        expect(first.theme).toBe(theme)
        expect(first.dir).toBe(path === ROUTE_AR ? 'rtl' : 'ltr')
        expect(first.paint.animations, 'a running animation above the fold at first paint').toEqual(
          [],
        )
        expect(
          first.paint.faded,
          'an element above the fold below opacity 1 at first paint',
        ).toEqual([])
      }, 90_000)
    }
  }
})

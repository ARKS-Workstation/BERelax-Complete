import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { testPort } from '@berelax/harness/ports'
import { auditTouchTargetsInPage, touchTargetInputFor } from '@berelax/harness/touch-targets'
import { MEASURE, TOUCH_TARGET } from '@berelax/ui'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * W-SYS-02 — the editorial grid, the layout primitives and the container-query components, proved
 * against the route that renders them.
 *
 * Every claim in this unit is a claim about computed layout, and not one of them can be checked by
 * reading source:
 *
 * - a grid template is five track widths the engine worked out from `minmax`, `min()` and a `1fr`;
 * - a measure is the ratio of an element's width to *its own* `ch`, which differs per font;
 * - a container query is what happens at 340px of container on a 1440px viewport, which no viewport
 *   test can produce;
 * - a focus ring is three computed properties on whatever the Tab key actually reached;
 * - a mirrored animation is two transform matrices from one set of keyframes.
 *
 * So the built application is started and driven, following `shell.itest.ts`. Playwright is pinned to
 * match the pre-installed Chromium, and launched with the same flags.
 *
 * ## Every assertion here has a control that must fail
 *
 * A layout test that cannot fail is the failure mode this repository keeps finding: a selector that
 * stopped matching, a template that is compared against itself, a rule that is true by construction.
 * Each `describe` below therefore also asserts that the *deliberately wrong* version is caught — an
 * uncapped paragraph, a 32px button, a ring turned off, a physically-authored animation, a card whose
 * container queries have been neutralised.
 *
 * ## Authored CSS, not computed CSS, where the question is about authoring
 *
 * The grid template and the keyframes are read out of `document.styleSheets`. `getComputedStyle`
 * resolves `padding-inline` to `padding-left` and `grid-template-columns` to five pixel values, so it
 * cannot answer "is this what docs/08 says". A previous unit's rule read computed styles to check
 * logical properties and produced 114 false positives; `packages/harness/src/critique.ts` carries the
 * note. Where the question is about the *result*, computed styles are exactly right, and that is what
 * the track widths, the measures and the rings are read from.
 */
/**
 * A random port, and the reason is not politeness about a busy machine.
 *
 * This was a fixed 3124, which is fine alone and wrong the moment two checkouts run the suite at once —
 * and several usually do, because each unit works in its own worktree. The second `next start` cannot bind,
 * exits, and `waitForServer` then **succeeds against the first worktree's server**: the assertions below run
 * against a different build of the application and report on code this checkout does not contain. A flake
 * would have been the good outcome; this passes or fails for reasons that have nothing to do with the tree
 * under test. The band comes from `@berelax/harness/ports`, which owns every suite's range and proves they
 * are disjoint; this file naming its own range, and recording its neighbours' in a comment, is what let
 * three pairs of suites end up sharing one.
 */
const PORT = testPort('kitchen-sink')
const BASE = `http://127.0.0.1:${PORT}`
const ROUTE = `${BASE}/kitchen-sink`

let server: ChildProcess
let browser: Browser

async function waitForServer(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ROUTE)
      if (response.ok) return
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`The app did not start on ${ROUTE} within ${timeoutMs}ms`)
}

beforeAll(async () => {
  // `pipe`, not `ignore`: a server that cannot bind says so on stderr, and with the output discarded the
  // only symptom was `ERR_CONNECTION_REFUSED` from Playwright several assertions later.
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
  // The server that answered must be OURS. `waitForServer` only proves something is listening, and a
  // reachable port plus a dead child is exactly the case above: another checkout's application answering
  // for this one.
  if (server.exitCode !== null) {
    throw new Error(
      `next start exited with ${server.exitCode} yet ${BASE} answered — something else is serving that ` +
        `port and these assertions would run against it:\n${output}`,
    )
  }
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.kill('SIGTERM')
})

/**
 * Opens the route at a viewport and hands the page to a callback.
 *
 * The `__name` shim is registered on the context before the page exists. esbuild compiles this suite
 * with `keepNames`, rewriting every named function as `__name(fn, 'fn')`, and Playwright serialises a
 * callback's *compiled* source into the page — where that helper does not exist. `capture.ts` carries
 * the same line for the same reason.
 */
async function withPage<T>(
  options: { width: number; height?: number; path?: string },
  body: (page: Page) => Promise<T>,
): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width, height: options.height ?? 900 },
  })
  try {
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    await page.goto(`${BASE}${options.path ?? '/kitchen-sink'}`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/** Whitespace is not part of a CSS value's meaning, and Chromium re-serialises it its own way. */
function normalise(css: string): string {
  return css.replaceAll(/\s+/g, '')
}

const DOCS = readFileSync(new URL('../../../docs/08-frontend-design.md', import.meta.url), 'utf8')

/** The grid template as docs/08 §4 states it. One place, read rather than copied. */
const DOCS_GRID_TEMPLATE = (() => {
  const match = /grid-template-columns:\s*([^;}]+);/.exec(DOCS)
  if (match?.[1] === undefined) throw new Error('docs/08 §4 has no grid-template-columns block')
  return match[1]
})()

interface GridTracks {
  readonly names: readonly string[]
  readonly sizes: readonly number[]
  readonly gridWidth: number
  readonly gutter: number
  readonly containerMax: string
  readonly ch68: number
  readonly authored: readonly string[]
}

async function gridTracks(page: Page): Promise<GridTracks> {
  return await page.evaluate(() => {
    const grid = document.querySelector('.be-grid')
    if (grid === null) throw new Error('no .be-grid on the page')
    // 100ch measured and divided, not 1ch: a one-character probe is rounded to the layout grid, and
    // that rounding is 0.1ch of error on a 68ch assertion.
    const probe = document.createElement('span')
    probe.style.cssText =
      'position:absolute;visibility:hidden;display:inline-block;inline-size:100ch'
    grid.appendChild(probe)
    const ch = probe.getBoundingClientRect().width / 100
    probe.remove()

    const raw = getComputedStyle(grid).gridTemplateColumns
    const root = getComputedStyle(document.documentElement)
    const authored: string[] = []
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList
      try {
        rules = sheet.cssRules
      } catch {
        // A cross-origin sheet throws. Nothing here is cross-origin, so this is not a silent gap.
        continue
      }
      for (const rule of rules) {
        if (rule.cssText.includes('grid-template-columns') && rule.cssText.includes('full-start')) {
          const value = /grid-template-columns:\s*([^;}]+)/.exec(rule.cssText)
          if (value?.[1] !== undefined) authored.push(value[1])
        }
      }
    }

    return {
      names: [...raw.matchAll(/\[([^\]]+)\]/g)].map((match) => (match[1] ?? '').trim()),
      sizes: raw
        .replaceAll(/\[[^\]]*\]/g, ' ')
        .trim()
        .split(/\s+/)
        .map((size) => Number.parseFloat(size)),
      gridWidth: grid.getBoundingClientRect().width,
      gutter: Number.parseFloat(root.getPropertyValue('--gutter')),
      containerMax: root.getPropertyValue('--container-max').trim(),
      ch68: ch * 68,
      authored,
    }
  })
}

describe('acceptance — the editorial grid is the one docs/08 §4 specifies', () => {
  it('ships the template the document states, character for character', async () => {
    const tracks = await withPage({ width: 1440 }, gridTracks)
    // Exactly one rule in the whole stylesheet defines this grid. Two would mean a second layout.
    expect(tracks.authored).toHaveLength(1)
    expect(normalise(tracks.authored[0] ?? '')).toBe(normalise(DOCS_GRID_TEMPLATE))

    // The control. If the comparison were vacuous — an empty string against an empty string, or a
    // normaliser that strips everything — this would pass too.
    expect(normalise(DOCS_GRID_TEMPLATE.replace('12rem', '11rem'))).not.toBe(
      normalise(tracks.authored[0] ?? ''),
    )
    expect(normalise(DOCS_GRID_TEMPLATE)).toContain('minmax(0,12rem)')
  }, 60_000)

  it('resolves to the gutter of its breakpoint, and caps the container at 1360px', async () => {
    // docs/08 §4: gutters 20/24/40/64/80 by breakpoint, container 1360px.
    const expected = [
      { width: 360, gutter: 20 },
      { width: 480, gutter: 24 },
      { width: 768, gutter: 40 },
      { width: 1024, gutter: 64 },
      { width: 1280, gutter: 80 },
      { width: 1440, gutter: 80 },
    ]
    for (const { width, gutter } of expected) {
      const tracks = await withPage({ width }, gridTracks)
      expect({ width, gutter: tracks.gutter }).toEqual({ width, gutter })
      expect(tracks.containerMax).toBe('1360px')
      // The container binds above 1360 and the viewport binds below it.
      expect(tracks.gridWidth).toBe(Math.min(1360, width))
    }
  }, 120_000)

  it('lays out five named tracks whose widths are the template, resolved', async () => {
    for (const width of [360, 768, 1440]) {
      const tracks = await withPage({ width }, gridTracks)
      expect(tracks.names).toEqual([
        'full-start',
        'wide-start',
        'measure-start',
        'measure-end',
        'wide-end',
        'full-end',
      ])
      expect(tracks.sizes).toHaveLength(5)
      const [gutterStart, wideStart, measure, wideEnd, gutterEnd] = tracks.sizes as [
        number,
        number,
        number,
        number,
        number,
      ]

      // `minmax(var(--gutter), 1fr)`: the gutter is a floor, and it is what these tracks are until the
      // 12rem and 20rem columns have reached their maxima.
      expect(gutterStart).toBeGreaterThanOrEqual(tracks.gutter)
      expect(gutterEnd).toBeCloseTo(gutterStart, 1)

      // `min(68ch, 100% - var(--gutter) * 2)` — the asymmetry's whole point is that this is the same
      // number of characters at every width until the viewport is narrower than 68 of them.
      expect(measure).toBeCloseTo(Math.min(tracks.ch68, tracks.gridWidth - 2 * tracks.gutter), 0)

      // `minmax(0, 12rem)` and `minmax(0, 20rem)`: they collapse rather than squeeze the measure.
      expect(wideStart).toBeLessThanOrEqual(192.5)
      expect(wideEnd).toBeLessThanOrEqual(320.5)

      expect(gutterStart + wideStart + measure + wideEnd + gutterEnd).toBeCloseTo(
        tracks.gridWidth,
        0,
      )
    }
  }, 120_000)

  it('collapses both wide columns at the 360px floor rather than narrowing the measure', async () => {
    // The arithmetic with no font metrics in it: 360 - 2×20 = 320 for the measure, and the 12rem and
    // 20rem tracks have nothing left, which is the behaviour that makes one template work on a phone.
    const tracks = await withPage({ width: 360 }, gridTracks)
    expect(tracks.sizes).toEqual([20, 0, 320, 0, 20])
  }, 60_000)
})

interface MeasuredElement {
  readonly role: string
  readonly tag: string
  readonly ch: number
}

async function measuredElements(
  page: Page,
  selector = '[data-measure]',
): Promise<MeasuredElement[]> {
  return await page.evaluate((query) => {
    const chOf = (element: Element): number => {
      const probe = document.createElement('span')
      probe.style.cssText =
        'position:absolute;visibility:hidden;display:inline-block;inline-size:100ch'
      element.appendChild(probe)
      const width = probe.getBoundingClientRect().width / 100
      probe.remove()
      return width
    }
    return [...document.querySelectorAll(query)].map((element) => ({
      role: element.getAttribute('data-measure') ?? 'none',
      tag: element.tagName.toLowerCase(),
      // The element's own font: a `ch` on the 17px body sans and a `ch` on the 40px display are two
      // different distances, and a measure is a count of characters either way.
      ch: element.getBoundingClientRect().width / chOf(element),
    }))
  }, selector)
}

describe('acceptance — the measure is capped in each element own font metrics', () => {
  it('keeps every role inside its cap, and everything inside 76ch, at every breakpoint', async () => {
    // docs/08 §3, as written down in MEASURE: body 68, lede 56, h1 26, hard maximum 76.
    expect(MEASURE.body).toBe(68)
    expect(MEASURE.lede).toBe(56)
    expect(MEASURE.h1).toBe(26)
    expect(MEASURE.max).toBe(76)

    for (const width of [360, 480, 768, 1024, 1280, 1440]) {
      const measured = await withPage({ width }, (page) => measuredElements(page))
      // A guard against the whole assertion evaporating: a selector that stopped matching would
      // otherwise pass this test with an empty list, which is ADR 0003's failure mode in a loop.
      expect(measured.length, `no measured elements at ${width}px`).toBeGreaterThanOrEqual(10)
      for (const element of measured) {
        const cap = MEASURE[element.role as keyof typeof MEASURE]
        expect(cap, `no measure token for role ${element.role}`).toBeDefined()
        // A fifth of a character of tolerance: the probe is laid out on the same subpixel grid as the
        // text it sits in, and 68.0000 is not a number a browser promises.
        expect(element.ch, `${element.role} (${element.tag}) at ${width}px`).toBeLessThanOrEqual(
          cap + 0.2,
        )
        expect(
          element.ch,
          `${element.role} (${element.tag}) at ${width}px exceeds the hard maximum`,
        ).toBeLessThanOrEqual(MEASURE.max)
      }
    }
  }, 180_000)

  it('reports a paragraph with no cap as over the maximum', async () => {
    // The control. `Measure` is the only thing keeping these lines short; without it a paragraph in the
    // full-bleed span runs the width of the container, which at 1440 is 1360px of one line.
    const over = await withPage({ width: 1440 }, async (page) => {
      await page.evaluate(() => {
        const grid = document.querySelector('.be-grid')
        if (grid === null) throw new Error('no .be-grid on the page')
        const paragraph = document.createElement('p')
        paragraph.dataset['measure'] = 'body'
        paragraph.dataset['control'] = 'uncapped'
        paragraph.setAttribute('data-span', 'full')
        // The defect this rule exists to catch: a container that lost its max-width.
        paragraph.style.maxInlineSize = 'none'
        paragraph.textContent = 'x '.repeat(400)
        grid.appendChild(paragraph)
      })
      return await measuredElements(page, '[data-control="uncapped"]')
    })
    expect(over).toHaveLength(1)
    expect(over[0]?.ch ?? 0).toBeGreaterThan(MEASURE.max)
  }, 60_000)
})

describe('acceptance — every control is big enough to hit and far enough from the next', () => {
  it('clears 48x48 with an 8px gap at 390px, and 40x40 at 1280px', async () => {
    expect(TOUCH_TARGET).toEqual({ desktop: 40, mobile: 48, minGap: 8 })
    for (const width of [390, 1280]) {
      const findings = await withPage({ width, height: 844 }, (page) =>
        page.evaluate(auditTouchTargetsInPage, touchTargetInputFor(width)),
      )
      expect(findings, `${width}px: ${JSON.stringify(findings)}`).toEqual([])
    }
  }, 120_000)

  it('names a 32px button and a 4px gap when they are put there', async () => {
    // The control, and the same rules that just reported the page clean. A 32px button is what
    // `padding: 4px 10px` produces, and it looks deliberate — which is why the rule exists rather than
    // the convention.
    const findings = await withPage({ width: 390, height: 844 }, async (page) => {
      await page.evaluate(() => {
        const main = document.querySelector('main')
        if (main === null) throw new Error('no main element')
        const holder = document.createElement('div')
        holder.style.cssText = 'display:flex;gap:4px;padding:40px'
        const small = document.createElement('button')
        small.type = 'button'
        small.textContent = 'Book'
        small.style.cssText = 'min-height:32px;height:32px;width:32px;padding:4px 10px'
        const first = document.createElement('button')
        first.type = 'button'
        first.textContent = '11:00'
        first.style.cssText = 'width:48px;height:48px'
        const second = document.createElement('button')
        second.type = 'button'
        second.textContent = '12:30'
        second.style.cssText = 'width:48px;height:48px'
        holder.append(small, first, second)
        main.append(holder)
      })
      return await page.evaluate(auditTouchTargetsInPage, touchTargetInputFor(390))
    })
    const rules = findings.map((finding) => finding.rule)
    expect(rules).toContain('touch-target-too-small')
    expect(rules).toContain('touch-target-gap')
  }, 60_000)
})

interface Ring {
  readonly where: string
  readonly outlineWidth: string
  readonly outlineColor: string
  readonly outlineOffset: string
  /** `--color-focus`, resolved by the engine to the same notation `outline-color` comes back in. */
  readonly focusColour: string
  /** `--ring-offset` of the enclosing section, resolved the same way. */
  readonly ringOffset: string
  readonly sectionBackground: string
}

/**
 * Tabs through the page and reports the focus ring on everything the keyboard reaches.
 *
 * Token values are put through a probe element rather than parsed here. `--color-surface` is `#FFFFFF`
 * in the token layer and arrives in the served stylesheet as `#fff`, because the CSS pipeline minifies
 * it — so a hand-written hex parser in the test compares `rgb(255, 15, NaN)` with `rgb(255, 255, 255)`
 * and fails on a page that is correct. Asking the engine to resolve the colour is the only comparison
 * that is about the colour rather than about its spelling.
 */
async function ringsByKeyboard(page: Page, limit = 40): Promise<Ring[]> {
  const rings: Ring[] = []
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => {
      const resolveColour = (value: string): string => {
        if (value === '') return ''
        const probe = document.createElement('span')
        probe.style.cssText = `position:absolute;visibility:hidden;color:${value}`
        document.body.appendChild(probe)
        const resolved = getComputedStyle(probe).color
        probe.remove()
        return resolved
      }
      const element = document.activeElement
      if (element === null || element === document.body) return null
      const style = getComputedStyle(element)
      const section = element.closest('.be-section')
      const sectionStyle = section === null ? null : getComputedStyle(section)
      return {
        where: `${element.tagName.toLowerCase()}.${String(element.className).split(/\s+/)[0]}`,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        outlineOffset: style.outlineOffset,
        focusColour: resolveColour(
          getComputedStyle(document.documentElement).getPropertyValue('--color-focus').trim(),
        ),
        ringOffset: resolveColour(
          sectionStyle === null ? '' : sectionStyle.getPropertyValue('--ring-offset').trim(),
        ),
        sectionBackground: sectionStyle === null ? '' : sectionStyle.backgroundColor,
      }
    })
    if (ring === null) break
    rings.push(ring)
  }
  return rings
}

describe('acceptance — the focus ring is 2px of --color-focus, offset by 2px', () => {
  it('draws the same ring on every primitive the keyboard reaches', async () => {
    const rings = await withPage({ width: 1280 }, (page) => ringsByKeyboard(page))
    // A slot button, two actions, three row actions, three cards, an input, a select, two summaries.
    expect(rings.length).toBeGreaterThanOrEqual(10)
    for (const ring of rings) {
      expect(ring.outlineWidth, ring.where).toBe('2px')
      expect(ring.outlineOffset, ring.where).toBe('2px')
      // Resolved, not declared: the claim is that the ring is painted in the token's colour, and the
      // token is a hex in the generated palette.
      expect(ring.outlineColor, ring.where).toBe(ring.focusColour)
      // docs/08 §4: each section states the background its ring offset is drawn against. Two pixels of
      // offset show whatever is behind the control, so a ring that assumes the page ground has a halo
      // of the wrong colour on every sand band.
      expect(ring.ringOffset, ring.where).toBe(ring.sectionBackground)
    }
  }, 120_000)

  it('reports a control whose ring has been turned off', async () => {
    // The control. `outline: none` on a focus style is the single most common accessibility regression
    // there is, and it is usually somebody removing a ring they found ugly on a mouse click.
    const rings = await withPage({ width: 1280 }, async (page) => {
      await page.addStyleTag({
        content: '.be-action:focus-visible { outline: none; outline-offset: 0; }',
      })
      return await ringsByKeyboard(page, 3)
    })
    expect(rings.some((ring) => ring.outlineWidth !== '2px' || ring.outlineOffset !== '2px')).toBe(
      true,
    )
  }, 60_000)
})

interface Reveal {
  readonly dir: string
  readonly transform: string
  readonly animationNames: readonly string[]
}

/**
 * The reveal's first keyframe, in a direction.
 *
 * The animation is paused and rewound rather than caught while running: a *time-based* one is a 500ms
 * animation on a page that finished loading long before the assertion, so by the time anything is read it
 * has played. `getAnimations()` returns the real `CSSAnimation` built from the authored keyframes, which
 * is the thing under test — authoring the transform in the test would prove only that the test can do
 * algebra.
 *
 * W-SYS-04 made the reveal scroll-driven, and a **progress-based** animation has no current time in
 * milliseconds: Chromium throws `NotSupportedError` on `currentTime = 0` for one. It also needs no
 * rewinding, because at scroll position zero an element below the fold is already at its first frame.
 * So the rewind now applies to the timeline it was written for, which is also the one the control case in
 * this file uses — an animation authored with a literal `translateX(32px)` and no timeline, which does
 * play on load and does have to be put back.
 */
async function revealAt(page: Page, direction: 'ltr' | 'rtl', selector: string): Promise<Reveal> {
  return await page.evaluate(
    ({ dir, query }) => {
      document.documentElement.setAttribute('dir', dir)
      const element = document.querySelector(query)
      if (element === null) throw new Error(`nothing matches ${query}`)
      const animations = element.getAnimations()
      for (const animation of animations) {
        animation.pause()
        if (animation.timeline === document.timeline) animation.currentTime = 0
      }
      return {
        dir: getComputedStyle(document.documentElement).getPropertyValue('--dir').trim(),
        transform: getComputedStyle(element).transform,
        animationNames: animations.map((animation) =>
          'animationName' in animation ? String(animation.animationName) : 'unnamed',
        ),
      }
    },
    { dir: direction, query: selector },
  )
}

/** `matrix(a, b, c, d, tx, ty)` — the two translations are what a mirror changes. */
function translationOf(matrix: string): { x: number; y: number } {
  const parts = /matrix\(([^)]+)\)/.exec(matrix)?.[1]?.split(',').map(Number.parseFloat) ?? []
  return { x: parts[4] ?? Number.NaN, y: parts[5] ?? Number.NaN }
}

describe('acceptance — RTL is a direction multiplier, not a second animation', () => {
  it('resolves --dir to 1 on an English document and -1 on the Arabic one', async () => {
    const english = await withPage({ width: 1280 }, (page) =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--dir').trim(),
      ),
    )
    expect(english).toBe('1')

    // The real Arabic document, whose `<html dir="rtl">` comes from its own root layout.
    const arabic = await withPage({ width: 1280, path: '/ar' }, (page) =>
      page.evaluate(() => ({
        dir: getComputedStyle(document.documentElement).getPropertyValue('--dir').trim(),
        direction: getComputedStyle(document.body).direction,
      })),
    )
    expect(arabic).toEqual({ dir: '-1', direction: 'rtl' })
  }, 60_000)

  it('produces numerically mirrored matrices from one set of keyframes', async () => {
    const { ltr, rtl } = await withPage({ width: 1440 }, async (page) => ({
      ltr: await revealAt(page, 'ltr', '[data-reveal]'),
      rtl: await revealAt(page, 'rtl', '[data-reveal]'),
    }))

    expect(ltr.animationNames).toEqual(['be-reveal'])
    expect(rtl.animationNames).toEqual(['be-reveal'])
    expect(ltr.dir).toBe('1')
    expect(rtl.dir).toBe('-1')

    const left = translationOf(ltr.transform)
    const right = translationOf(rtl.transform)
    // Mirrored on the inline axis and identical on the block axis: a reveal rises the same way in both
    // scripts and comes in from the side the reader starts on.
    expect(left.x).not.toBe(0)
    expect(right.x).toBeCloseTo(-left.x, 3)
    expect(right.y).toBeCloseTo(left.y, 3)
  }, 60_000)

  it('reports an animation whose distance was authored physically', async () => {
    // The control. The same reveal written with a literal `translateX(32px)` produces the *same* matrix
    // in both directions — the page is mirrored and the animation is not, which is the defect the
    // multiplier exists to prevent and the one this assertion would otherwise never notice.
    const { ltr, rtl } = await withPage({ width: 1440 }, async (page) => {
      await page.addStyleTag({
        content: [
          '@keyframes control-physical { from { transform: translate(32px, 16px); } to { transform: translate(0, 0); } }',
          '[data-control="physical"] { animation: control-physical 500ms both; }',
        ].join('\n'),
      })
      await page.evaluate(() => {
        const element = document.createElement('div')
        element.dataset['control'] = 'physical'
        document.querySelector('main')?.append(element)
      })
      return {
        ltr: await revealAt(page, 'ltr', '[data-control="physical"]'),
        rtl: await revealAt(page, 'rtl', '[data-control="physical"]'),
      }
    })
    expect(translationOf(rtl.transform).x).toBe(translationOf(ltr.transform).x)
  }, 60_000)
})

interface CardLayout {
  readonly layout: string
  readonly stacked: boolean
  readonly servicesVisible: boolean
}

async function cardLayoutAt(page: Page, containerWidth: number): Promise<CardLayout> {
  return await page.evaluate((width) => {
    const card = document.querySelector('.be-card')
    if (card === null) throw new Error('no .be-card on the page')
    // The container itself is resized, and the viewport is not. That is the whole claim.
    const container = card as HTMLElement
    container.style.inlineSize = `${width}px`
    const link = card.querySelector('.be-card__link')
    const portrait = card.querySelector('.be-card__portrait')
    const body = card.querySelector('.be-card__body')
    const services = card.querySelector('.be-card__services')
    if (link === null || portrait === null || body === null || services === null) {
      throw new Error('the card is missing a part')
    }
    return {
      layout: getComputedStyle(link).getPropertyValue('--card-layout').trim(),
      stacked: portrait.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1,
      servicesVisible: services.getBoundingClientRect().height > 0,
    }
  }, containerWidth)
}

function signature(layout: CardLayout): string {
  return `${layout.layout}|${layout.stacked}|${layout.servicesVisible}`
}

async function slotColumnsAt(page: Page, containerWidth: number): Promise<number> {
  return await page.evaluate((width) => {
    const slots = document.querySelector('.be-slots')
    const list = document.querySelector('.be-slots__list')
    if (slots === null || list === null) throw new Error('no slot grid on the page')
    const container = slots as HTMLElement
    container.style.inlineSize = `${width}px`
    // Counted from the resolved track list, which is the number of columns the engine produced rather
    // than the number the stylesheet asked for.
    return getComputedStyle(list)
      .gridTemplateColumns.trim()
      .split(/\s+/)
      .filter((track) => track !== '').length
  }, containerWidth)
}

describe('acceptance — the components answer to their container, at a fixed viewport', () => {
  it('gives TherapistCard three distinct layouts at 260, 340 and 420px of container', async () => {
    // The viewport never moves. Everything below is the container changing underneath one card, which
    // is what happens on a real page when the same card is used in a grid, in a measure column and in
    // a 300px admin rail.
    const layouts = await withPage({ width: 1440 }, async (page) => [
      await cardLayoutAt(page, 260),
      await cardLayoutAt(page, 340),
      await cardLayoutAt(page, 420),
    ])
    expect(layouts.map((layout) => layout.layout)).toEqual(['compact', 'split', 'wide'])
    expect(new Set(layouts.map(signature)).size).toBe(3)
    // Distinct in geometry as well as in name: stacked, then side by side, then side by side with the
    // detail that only fits at 420.
    expect(layouts.map((layout) => layout.stacked)).toEqual([true, false, false])
    expect(layouts.map((layout) => layout.servicesVisible)).toEqual([false, false, true])
  }, 60_000)

  it('reports one layout when the container queries are neutralised', async () => {
    // The control. `container-type: normal` stops the card being a query container, and every
    // `@container` rule inside it stops matching — which is exactly what a page breakpoint would do to
    // a card used at three widths on one screen.
    const layouts = await withPage({ width: 1440 }, async (page) => {
      await page.addStyleTag({ content: '.be-card { container-type: normal !important; }' })
      return [
        await cardLayoutAt(page, 260),
        await cardLayoutAt(page, 340),
        await cardLayoutAt(page, 420),
      ]
    })
    expect(new Set(layouts.map(signature)).size).toBe(1)
  }, 60_000)

  it('gives SlotGrid 3, 4 and 6 columns at its declared container widths', async () => {
    const columns = await withPage({ width: 1440 }, async (page) => ({
      inside: [
        await slotColumnsAt(page, 320),
        await slotColumnsAt(page, 380),
        await slotColumnsAt(page, 560),
      ],
      // A pixel either side of each declared threshold. A bucket test passes whatever the thresholds
      // are; this fails if they move, which is the difference between testing the counts and testing
      // the widths they are declared at.
      boundaries: [
        await slotColumnsAt(page, 359),
        await slotColumnsAt(page, 360),
        await slotColumnsAt(page, 519),
        await slotColumnsAt(page, 520),
      ],
    }))
    expect(columns.inside).toEqual([3, 4, 6])
    expect(columns.boundaries).toEqual([3, 4, 4, 6])
  }, 60_000)

  it('stays at three columns when the slot grid stops being a query container', async () => {
    // The control. Without `container-type`, a 560px slot grid keeps the base three columns: the
    // container queries were doing the work, and this is what it looks like when they are not.
    const columns = await withPage({ width: 1440 }, async (page) => {
      await page.addStyleTag({ content: '.be-slots { container-type: normal !important; }' })
      return [await slotColumnsAt(page, 320), await slotColumnsAt(page, 560)]
    })
    expect(columns).toEqual([3, 3])
  }, 60_000)
})

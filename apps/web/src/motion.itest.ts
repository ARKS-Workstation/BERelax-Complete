import { type ChildProcess, spawn } from 'node:child_process'
import {
  MOTION_FALLBACK_ATTRIBUTE,
  MOTION_READY_ATTRIBUTE,
  REVEAL_ROOT_MARGIN,
  staggerFor,
} from '@berelax/ui'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * W-SYS-04 — the motion system, proved in a browser, because none of it is decidable from source.
 *
 * - `prefers-reduced-motion` is a *computed* custom property: whether `--dur-reveal` is 120ms depends on
 *   a media query the engine evaluates, and reading the stylesheet only proves the rule was authored.
 *   "Movement becomes zero and the cross-fade survives" is two samples of `getComputedStyle` at two
 *   points of one animation. A motion system whose reduced-motion path is asserted by grep is a motion
 *   system that ships vestibular triggers.
 * - A scroll-driven animation has **no current time in milliseconds at all** — Chromium throws
 *   `NotSupportedError` on `animation.currentTime = 0` for a progress-based timeline — so the only way to
 *   know the reveal is driven by scroll rather than by a timer is to ask the animation for its timeline.
 * - A stagger is the difference between six animations' progress at one instant.
 * - The fallback is a browser *without* scroll timelines, which is not the browser the suite runs in. It
 *   is reached here by making `CSS.supports('animation-timeline', …)` answer false before the document's
 *   first script runs, which is exactly what Firefox does today, and then driving the whole path: the
 *   blocking bootstrap holds the reveals, the island claims the handshake, an `IntersectionObserver` is
 *   constructed once, and it disconnects after the last element has arrived.
 *
 * Every assertion has a control that must fail. The reduced-motion numbers are read twice, once in a
 * context that asked for reduced motion and once in one that did not; the stagger is read on a group of
 * six, a group of ten and a group of fourteen; the scroll-driven pair is counted in the *parsed*
 * stylesheet, where a third would show up whether or not `pnpm layout` was run.
 */

/**
 * A random port in this suite's own range.
 *
 * The four server-starting suites take disjoint ranges — shell 3200, primitives 3800, route spine 4100,
 * kitchen sink 4400 — so that two worktrees running at once cannot have one suite's `next start` answer
 * for another's build. This one takes 4700.
 */
const PORT = 4700 + Math.floor(Math.random() * 300)
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
  // The server that answered must be OURS. A reachable port plus a dead child is another checkout's
  // application answering for this one, and every assertion below would then be about its build.
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

interface PageOptions {
  readonly reducedMotion?: 'reduce' | 'no-preference'
  readonly path?: string
  /** Answer `CSS.supports('animation-timeline', …)` with false, as a browser without it would. */
  readonly withoutScrollTimelines?: boolean
  readonly width?: number
}

/**
 * Opens the kitchen sink and hands the page to a callback.
 *
 * The `__name` shim is registered before the page exists: esbuild compiles this suite with `keepNames`,
 * rewriting every named function as `__name(fn, 'fn')`, and Playwright serialises a callback's *compiled*
 * source into the page where that helper does not exist. `capture.ts` and `kitchen-sink.itest.ts` carry
 * the same line for the same reason.
 */
async function withPage<T>(options: PageOptions, body: (page: Page) => Promise<T>): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: 800 },
    ...(options.reducedMotion === undefined ? {} : { reducedMotion: options.reducedMotion }),
  })
  try {
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    if (options.withoutScrollTimelines === true) {
      // Before the document's first script, so the blocking bootstrap in `<head>` sees the same answer a
      // browser without scroll-driven animations would give it. The observer is counted at the same time:
      // "disconnects after the first intersection" is a claim about a real IntersectionObserver, and the
      // only way to watch one from outside is to wrap the constructor.
      await context.addInitScript({
        content: `
          (() => {
            const supports = CSS.supports.bind(CSS)
            CSS.supports = (property, value) =>
              String(property).includes('animation-timeline') ? false : supports(property, value)
            const Real = window.IntersectionObserver
            const instances = []
            window.__observerLog = instances
            window.IntersectionObserver = class extends Real {
              constructor(callback, options) {
                super(callback, options)
                this.__record = { rootMargin: options?.rootMargin ?? '', observed: 0, disconnected: 0 }
                instances.push(this.__record)
              }
              observe(target) {
                this.__record.observed += 1
                super.observe(target)
              }
              disconnect() {
                this.__record.disconnected += 1
                super.disconnect()
              }
            }
          })()
        `,
      })
    }
    const page = await context.newPage()
    await page.goto(`${BASE}${options.path ?? '/kitchen-sink'}`, { waitUntil: 'networkidle' })
    if (options.withoutScrollTimelines === true) {
      // The other half of the simulation. Overriding `CSS.supports` changes what the *script* believes;
      // the CSS parser in this browser still understands `animation-timeline: view()` and would leave the
      // reveal scroll-driven, so the assertion that the fallback is a time-based animation would be
      // asserting the opposite of the case it is about. A later sheet at the same specificity wins, and
      // `[data-motion-fallback] [data-reveal]` still holds it paused at its first frame while this lands.
      await page.addStyleTag({ content: '[data-reveal] { animation-timeline: auto; }' })
    }
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/**
 * A CSS time in milliseconds, whatever the stylesheet was minified into.
 *
 * `120ms` comes back from `getComputedStyle` as `.12s`: the production CSS pipeline rewrites a time into
 * its shortest form, and a computed custom property is the *authored* token, not a normalised one. The
 * first version of this file compared strings and failed on every duration — which is the good outcome,
 * because the other way round is a test that passes on `.12s` where it meant `1.2s`.
 */
function milliseconds(value: string): number {
  const match = /^(-?[\d.]+)(ms|s)$/.exec(value.trim())
  if (match === null) throw new Error(`not a CSS time: '${value}'`)
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1)
}

/** The motion tokens as the engine computed them. */
async function motionTokens(page: Page): Promise<Record<string, string>> {
  return await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement)
    const read = (name: string) => root.getPropertyValue(name).trim()
    return {
      '--dur-instant': read('--dur-instant'),
      '--dur-fast': read('--dur-fast'),
      '--dur-base': read('--dur-base'),
      '--dur-slow': read('--dur-slow'),
      '--dur-reveal': read('--dur-reveal'),
      '--dur-ambient': read('--dur-ambient'),
      '--move-sm': read('--move-sm'),
      '--move-md': read('--move-md'),
      '--move-lg': read('--move-lg'),
      '--stagger': read('--stagger'),
    }
  })
}

describe('acceptance — reduced motion is a token override', () => {
  it('collapses the durations, zeroes the movement and zeroes the stagger', async () => {
    const reduced = await withPage({ reducedMotion: 'reduce' }, motionTokens)
    expect(milliseconds(reduced['--dur-slow'] ?? '')).toBe(120)
    expect(milliseconds(reduced['--dur-reveal'] ?? '')).toBe(120)
    expect(reduced['--move-sm']).toBe('0px')
    expect(reduced['--move-md']).toBe('0px')
    expect(reduced['--move-lg']).toBe('0px')
    expect(milliseconds(reduced['--stagger'] ?? '')).toBe(0)
    // Ambient motion stops entirely; a cross-fade does not. docs/08 §5 keeps `--dur-base` at 120ms
    // deliberately, because a state change nobody saw is harder to follow, not easier.
    expect(milliseconds(reduced['--dur-ambient'] ?? '')).toBe(0)
    expect(milliseconds(reduced['--dur-base'] ?? '')).toBe(120)
  }, 60_000)

  it('leaves every one of them alone when nothing was asked for', async () => {
    // The control. Without it, a stylesheet that had simply set every duration to 120ms and every
    // distance to zero would satisfy the assertions above — and the site would have no motion at all.
    const full = await withPage({ reducedMotion: 'no-preference' }, motionTokens)
    expect(milliseconds(full['--dur-instant'] ?? '')).toBe(90)
    expect(milliseconds(full['--dur-fast'] ?? '')).toBe(140)
    expect(milliseconds(full['--dur-base'] ?? '')).toBe(200)
    expect(milliseconds(full['--dur-slow'] ?? '')).toBe(320)
    expect(milliseconds(full['--dur-reveal'] ?? '')).toBe(500)
    expect(milliseconds(full['--dur-ambient'] ?? '')).toBe(12_000)
    expect(full['--move-sm']).toBe('8px')
    expect(full['--move-md']).toBe('16px')
    expect(full['--move-lg']).toBe('32px')
    expect(milliseconds(full['--stagger'] ?? '')).toBe(40)
  }, 60_000)

  it('keeps the opacity cross-fade running with the movement removed', async () => {
    /**
     * The cross-fade, observed rather than read.
     *
     * The attribute is added the way a component adds it when the value behind it has changed, which
     * starts a real animation. It is then paused and sampled at three points of its own timeline — the
     * clock is not waited on, because a wall-clock sample is a flake on a loaded CI machine, and a paused
     * animation at a set time is the same measurement without the race.
     */
    const sample = async (reducedMotion: 'reduce' | 'no-preference') =>
      await withPage({ reducedMotion }, (page) =>
        page.evaluate(() => {
          const element = document.querySelector('[data-motion-specimen="crossfade"]')
          if (element === null) throw new Error('no cross-fade specimen on the page')
          if (element.getAnimations().length > 0) {
            throw new Error('the specimen is animating before anything asked it to')
          }
          element.setAttribute('data-crossfade', '')
          const animations = element.getAnimations()
          // From the animation's own computed timing rather than by parsing the token: this is the number
          // the engine is animating over, and it is in milliseconds by definition.
          const duration = Number(animations[0]?.effect?.getComputedTiming().duration ?? 0)
          const at = (fraction: number) => {
            for (const animation of animations) {
              animation.pause()
              animation.currentTime = duration * fraction
            }
            const style = getComputedStyle(element)
            return { opacity: Number(style.opacity), transform: style.transform }
          }
          return { count: animations.length, duration, start: at(0), middle: at(0.5), end: at(1) }
        }),
      )

    const reduced = await sample('reduce')
    expect(reduced.count).toBe(1)
    expect(reduced.duration).toBe(120)
    // The cross-fade runs: three different opacities, ending opaque.
    expect(reduced.start.opacity).toBe(0)
    expect(reduced.middle.opacity).toBeGreaterThan(0)
    expect(reduced.middle.opacity).toBeLessThan(1)
    expect(reduced.end.opacity).toBe(1)
    // And nothing moves, at any point of it. `matrix(1, 0, 0, 1, 0, 0)` is the identity.
    for (const phase of [reduced.start, reduced.middle, reduced.end]) {
      expect(phase.transform === 'none' || phase.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(
        true,
      )
    }

    // The control: the same element, the same animation, with movement in force. Without this the
    // assertion above is satisfied by an element that never moved in the first place.
    const full = await sample('no-preference')
    expect(full.duration).toBe(200)
    expect(full.start.transform).toBe('matrix(1, 0, 0, 1, 32, 16)')
    expect(full.end.transform).toBe('matrix(1, 0, 0, 1, 0, 0)')
    expect(full.start.opacity).toBe(0)
    expect(full.end.opacity).toBe(1)
  }, 60_000)
})

interface TimelineRule {
  readonly selector: string
  readonly value: string
}

/** Every `animation-timeline` declaration in the stylesheets the browser actually parsed. */
async function timelineRules(page: Page): Promise<TimelineRule[]> {
  return await page.evaluate(() => {
    const found: { selector: string; value: string }[] = []
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        // A grouping rule — `@supports (animation-timeline: scroll())` is one — has the property in its
        // *condition*, not in a declaration. Counting `cssText` would count the feature query as an
        // effect, so only style rules are counted, and the groups are walked into.
        if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
        const style = (rule as CSSStyleRule).style
        if (style === undefined) continue
        const value = style.getPropertyValue('animation-timeline')
        if (value !== '') found.push({ selector: (rule as CSSStyleRule).selectorText, value })
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules)
      } catch {
        // A cross-origin sheet throws. Nothing here is cross-origin, so this is not a silent gap.
      }
    }
    return found
  })
}

describe('acceptance — exactly two scroll-driven effects', () => {
  it('declares animation-timeline on the reveal and the header, and nowhere else', async () => {
    const rules = await withPage({}, timelineRules)
    expect(rules.map((rule) => rule.selector).sort()).toEqual(['.be-header', '[data-reveal]'])
    expect(rules.find((rule) => rule.selector === '[data-reveal]')?.value).toBe('view()')
    expect(rules.find((rule) => rule.selector === '.be-header')?.value).toBe('scroll()')
  }, 60_000)

  it('drives the reveal from a view timeline rather than from a clock', async () => {
    const reveal = await withPage({}, (page) =>
      page.evaluate(() => {
        const element = document.querySelector('figure[data-reveal]')
        if (element === null) throw new Error('no reveal on the page')
        const [animation] = element.getAnimations()
        if (animation === undefined) throw new Error('the reveal is not animating')
        return {
          timeline: animation.timeline?.constructor.name ?? 'none',
          documentTimeline: animation.timeline === document.timeline,
          name: 'animationName' in animation ? String(animation.animationName) : 'unnamed',
          // Below the fold at load, so the reveal is at its first frame: invisible and offset.
          opacity: getComputedStyle(element).opacity,
          transform: getComputedStyle(element).transform,
        }
      }),
    )
    expect(reveal.name).toBe('be-reveal')
    expect(reveal.timeline).toBe('ViewTimeline')
    // The control on the pair: an animation on `document.timeline` is one that plays on load, which is
    // what this unit replaced. W-SYS-02 shipped the keyframes with exactly that defect.
    expect(reveal.documentTimeline).toBe(false)
    expect(reveal.opacity).toBe('0')
    expect(reveal.transform).toBe('matrix(1, 0, 0, 1, 32, 16)')
  }, 60_000)

  it('completes the reveal once the element has been scrolled to', async () => {
    const arrived = await withPage({}, async (page) => {
      await page.evaluate(() => {
        document.querySelector('figure[data-reveal]')?.scrollIntoView({ block: 'center' })
      })
      // Two frames: one for the scroll to be applied, one for the compositor to resolve the timeline.
      await page.evaluate(
        async () =>
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      return await page.evaluate(() => {
        const element = document.querySelector('figure[data-reveal]')
        const style = getComputedStyle(element as Element)
        return { opacity: style.opacity, transform: style.transform }
      })
    })
    expect(Number(arrived.opacity)).toBe(1)
    expect(arrived.transform === 'none' || arrived.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(
      true,
    )
  }, 60_000)

  it('mirrors the reveal in the Arabic document without a second animation', async () => {
    // The same keyframes, the same selector, `--dir: -1`. W-SYS-02 proved this by flipping `dir` on the
    // English page; this is the real Arabic document, whose direction comes from its own root layout.
    const [english, arabic] = await Promise.all([
      withPage({ path: '/kitchen-sink' }, (page) =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector('figure[data-reveal]') as Element).transform,
        ),
      ),
      withPage({ path: '/ar/kitchen-sink' }, (page) =>
        page.evaluate(
          () =>
            getComputedStyle(document.querySelector('figure[data-reveal]') as Element).transform,
        ),
      ),
    ])
    expect(english).toBe('matrix(1, 0, 0, 1, 32, 16)')
    expect(arabic).toBe('matrix(1, 0, 0, 1, -32, 16)')
  }, 90_000)

  it('condenses the header on scroll, on a scroll timeline', async () => {
    const header = await withPage({}, async (page) => {
      const read = async () =>
        await page.evaluate(() => {
          const element = document.querySelector('.be-header')
          if (element === null) throw new Error('no header on the page')
          const [animation] = element.getAnimations()
          return {
            blockSize: element.getBoundingClientRect().height,
            backdrop: getComputedStyle(element).backdropFilter,
            timeline: animation?.timeline?.constructor.name ?? 'none',
          }
        })
      const top = await read()
      await page.evaluate(() => window.scrollTo(0, 400))
      await page.evaluate(
        async () =>
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      return { top, scrolled: await read() }
    })
    expect(header.top.timeline).toBe('ScrollTimeline')
    // 96px tall at the top (`--space-13`), 64px once condensed (`--space-11`).
    expect(header.top.blockSize).toBeCloseTo(96, 0)
    expect(header.scrolled.blockSize).toBeCloseTo(64, 0)
    // docs/08 §8: 8px of blur, and no more, at the condensed end.
    expect(header.scrolled.backdrop).toBe('blur(8px)')
    expect(header.top.backdrop).toBe('blur(0px)')
  }, 60_000)
})

/** One observer the wrapped `IntersectionObserver` in `withPage` saw constructed. */
interface ObserverRecord {
  readonly rootMargin: string
  readonly observed: number
  readonly disconnected: number
}

interface StaggerReading {
  readonly count: number
  readonly delays: readonly number[]
  readonly containerAnimations: number
  readonly childAnimations: number
  readonly opacities: readonly number[]
}

/**
 * One staggered group, read in the browser: the computed delays, and the opacities the delays produce.
 *
 * The group is given the cross-fade attribute — which is what a component does when the values behind a
 * list have changed — and every animation is then paused at the same point of its own timeline. At
 * 100ms into a 200ms cross-fade the first child is half way in and a child whose delay is 100ms or more
 * has not started, which is a stagger, observed, without waiting on a clock.
 */
async function staggerAt(page: Page, count: number): Promise<StaggerReading> {
  return await page.evaluate((groupCount) => {
    const group = document.querySelector(`[data-stagger][data-stagger-count="${groupCount}"]`)
    if (group === null) throw new Error(`no staggered group of ${groupCount} on the page`)
    const children = [...group.children]
    const delays = children.map(
      (child) => Number(getComputedStyle(child).animationDelay.replace('s', '')) * 1000,
    )
    const containerAnimations = group.getAnimations().length
    for (const child of children) child.setAttribute('data-crossfade', '')
    const opacities = children.map((child) => {
      for (const animation of child.getAnimations()) {
        animation.pause()
        animation.currentTime = 100
      }
      return Number(getComputedStyle(child).opacity)
    })
    return {
      count: children.length,
      delays,
      containerAnimations,
      childAnimations: children.filter((child) => child.getAnimations().length > 0).length,
      opacities,
    }
  }, count)
}

describe('acceptance — the stagger, in the DOM', () => {
  it('steps six siblings by 40ms and ten by 24ms, inside the 240ms total', async () => {
    const { six, ten } = await withPage({}, async (page) => ({
      six: await staggerAt(page, 6),
      ten: await staggerAt(page, 10),
    }))

    expect(six.delays).toEqual([0, 40, 80, 120, 160, 200])
    expect(ten.delays).toEqual([0, 24, 48, 72, 96, 120, 144, 168, 192, 216])
    for (const group of [six, ten]) {
      expect(Math.max(...group.delays)).toBeLessThanOrEqual(240)
      // The step the pure helper decided, arriving in the DOM as a delay. Two copies of one number is
      // how the CSS and the TypeScript drift apart.
      expect(group.delays[1]).toBe(staggerFor(group.count).delayMs)
      // And the delays belong to real animations. A computed `animation-delay` resolves on an element
      // with no animation at all, so without this the numbers above could be arithmetic on nothing.
      expect(group.childAnimations).toBe(group.count)
    }

    // The delays doing something: at one instant of one animation, no child is ahead of the one before
    // it, the first is under way and the last has not started. Not *strictly* decreasing, because every
    // child whose delay has not elapsed sits at zero together — which is what a stagger looks like a
    // hundred milliseconds in, and asserting otherwise would be asserting something false.
    for (const group of [six, ten]) {
      for (let index = 1; index < group.opacities.length; index += 1) {
        expect(
          group.opacities[index] ?? 1,
          `child ${index} of ${group.count} is ahead of child ${index - 1}`,
        ).toBeLessThanOrEqual(group.opacities[index - 1] ?? 0)
      }
      expect(group.opacities[0]).toBeGreaterThan(0)
      expect(group.opacities.at(-1)).toBe(0)
      // Three distinct values at least, or a group where only the first child had started would pass.
      expect(new Set(group.opacities).size).toBeGreaterThanOrEqual(3)
    }
  }, 60_000)

  it('animates the container and not the children above twelve siblings', async () => {
    const fourteen = await withPage({}, (page) => staggerAt(page, 14))
    expect(fourteen.count).toBe(14)
    // Every child delay zero, because no child carries an index for the multiplication to reach.
    expect(fourteen.delays).toEqual(Array.from({ length: 14 }, () => 0))
    // And the container carries the single animation — the reveal — which is the whole point of the cliff.
    expect(fourteen.containerAnimations).toBe(1)
    // The control on the reading above: with equal delays the children arrive together, so the ordering
    // the six- and ten-item groups show is a property of the stagger and not of the sampling.
    expect(new Set(fourteen.opacities).size).toBe(1)
  }, 60_000)

  it('zeroes every delay under reduced motion', async () => {
    // The multiplication is what makes this free: `--stagger` becomes 0ms in the token layer and every
    // delay in the document follows, with no component branching on anything.
    const { six, ten } = await withPage({ reducedMotion: 'reduce' }, async (page) => ({
      six: await staggerAt(page, 6),
      ten: await staggerAt(page, 10),
    }))
    expect(six.delays).toEqual(Array.from({ length: 6 }, () => 0))
    expect(ten.delays).toEqual(Array.from({ length: 10 }, () => 0))
    // The group arrives together rather than not at all: the cross-fade still runs for all of them.
    expect(new Set(six.opacities).size).toBe(1)
    expect(six.opacities[0]).toBeGreaterThan(0)
  }, 60_000)
})

describe('acceptance — the fallback for a browser with no scroll timelines', () => {
  it('holds the reveals, reveals them on intersection, and disconnects once', async () => {
    const fallback = await withPage({ withoutScrollTimelines: true }, async (page) => {
      const attributes = await page.evaluate(() => ({
        // The literal, not the constant: the last assertion in this file pins the constant to this
        // spelling, so the two cannot drift into agreeing with each other and disagreeing with the CSS.
        fallback: document.documentElement.hasAttribute('data-motion-fallback'),
      }))
      // The island claims the handshake in an effect, so it may not have hydrated yet. Waiting for the
      // attribute is what makes this deterministic; a fixed sleep is a flake on a loaded machine.
      await page.waitForFunction(() => document.documentElement.hasAttribute('data-motion-ready'))

      const held = await page.evaluate(() => {
        const element = document.querySelector('figure[data-reveal]')
        const [animation] = (element as Element).getAnimations()
        return {
          playState: animation?.playState ?? 'none',
          documentTimeline: animation?.timeline === document.timeline,
          opacity: getComputedStyle(element as Element).opacity,
          revealed: (element as Element).hasAttribute('data-revealed'),
        }
      })

      // Scroll the whole page, so every reveal on it arrives and the observer runs out of work.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 200) {
          window.scrollTo(0, y)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        }
      })
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-reveal]')].every((element) =>
          element.hasAttribute('data-revealed'),
        ),
      )

      const observers = await page.evaluate(
        () => (globalThis as unknown as { __observerLog?: ObserverRecord[] }).__observerLog ?? [],
      )
      // Waiting on the animation's own promise rather than on a clock: the reveal was released at some
      // point during the scroll and takes `--dur-reveal` to finish, so reading it the instant the
      // attribute lands reads an element that is still at opacity 0 — which is what the first run of this
      // did, and it would have been a flake either way round.
      const arrived = await page.evaluate(async () => {
        const element = document.querySelector('figure[data-reveal]') as Element
        await Promise.all(
          element.getAnimations().map(async (animation) => await animation.finished),
        )
        const [animation] = element.getAnimations()
        return {
          playState: animation?.playState ?? 'none',
          opacity: getComputedStyle(element).opacity,
        }
      })
      return { attributes, held, observers, arrived }
    })

    // The blocking script decided before the first paint. An island cannot: it runs after one.
    expect(fallback.attributes.fallback).toBe(true)
    // The reveal is a time-based animation here — the timeline declaration was dropped by the parser —
    // held at its first frame rather than played on load.
    expect(fallback.held.documentTimeline).toBe(true)
    expect(fallback.held.playState).toBe('paused')
    expect(fallback.held.opacity).toBe('0')
    expect(fallback.held.revealed).toBe(false)

    // One observer for every reveal on the page, and it disconnected when the last of them had arrived.
    // The unit test in `packages/ui/src/motion/observe.test.ts` proves that against a stub; this proves
    // the real constructor was used, with the real elements, in a real scroll.
    //
    // Identified by its root margin rather than by counting constructions, because the header island
    // constructs one too and Next's own prefetching may construct more. That the header's is still
    // connected is the control on the pair: the two fallbacks are deliberately different shapes, and a
    // one-shot header would condense at the top of the page and never come back.
    const reveal = fallback.observers.filter((record) => record.rootMargin === REVEAL_ROOT_MARGIN)
    const others = fallback.observers.filter((record) => record.rootMargin !== REVEAL_ROOT_MARGIN)
    expect(reveal).toHaveLength(1)
    expect(reveal[0]?.observed).toBeGreaterThan(1)
    expect(reveal[0]?.disconnected).toBe(1)
    expect(others.length).toBeGreaterThanOrEqual(1)
    expect(others.every((record) => record.disconnected === 0)).toBe(true)

    // Finished, not merely running: the held animation was released and played to its end.
    expect(fallback.arrived.playState).toBe('finished')
    expect(Number(fallback.arrived.opacity)).toBe(1)
  }, 120_000)

  it('does nothing at all in a browser that has them', async () => {
    // The control, and the reason the island is worth its 906 bytes rather than being the mechanism: in a
    // browser with scroll timelines nothing is held, no observer is constructed, and the whole effect is
    // CSS. A fallback that ran everywhere would be the same code paying for itself twice.
    const supported = await withPage({}, async (page) => {
      await page.waitForLoadState('networkidle')
      return await page.evaluate(() => ({
        // The literal, not the constant: the assertion below pins the constant to this spelling, so the
        // two cannot drift into agreeing with each other and disagreeing with the stylesheet.
        fallback: document.documentElement.hasAttribute('data-motion-fallback'),
        revealed: document.querySelectorAll('[data-revealed]').length,
        paused: [...document.querySelectorAll('[data-reveal]')].filter((element) =>
          element.getAnimations().some((animation) => animation.playState === 'paused'),
        ).length,
      }))
    })
    expect(supported.fallback).toBe(false)
    expect(supported.revealed).toBe(0)
    expect(supported.paused).toBe(0)
  }, 60_000)

  it('names the same attributes the stylesheet and the script do', async () => {
    // Three spellings of two attribute names — the TypeScript constant, the inline script and the CSS
    // selector — and the only thing keeping them in step is that the first two come from one module and
    // the third is asserted here against it.
    expect(MOTION_FALLBACK_ATTRIBUTE).toBe('data-motion-fallback')
    expect(MOTION_READY_ATTRIBUTE).toBe('data-motion-ready')
    const selectors = await withPage({}, (page) =>
      page.evaluate((attribute) => {
        const rules = [...document.styleSheets].flatMap((sheet) => {
          try {
            return [...sheet.cssRules]
          } catch {
            // A cross-origin sheet throws. There are none here, so this is not a silent gap.
            return []
          }
        })
        return rules
          .map((rule) => (rule as CSSStyleRule).selectorText)
          .filter((selector) => typeof selector === 'string' && selector.includes(attribute))
      }, MOTION_FALLBACK_ATTRIBUTE),
    )
    expect(selectors).toEqual([
      '[data-motion-fallback] [data-reveal]',
      '[data-motion-fallback] [data-reveal][data-revealed]',
    ])
  }, 60_000)
})

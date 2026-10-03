// Type-only, on its own statement and from the barrel, which is safe because `import type` is ERASED.
// A value imported from the barrel here would pull zod and every schema in the package into this
// module's client chunk — measured at 106,765 bytes, which is what `dimensions.ts` exists for.
import type { AnalyticsEvent } from '@berelax/shared'
import {
  type AnalyticsBreakpoint,
  CLS_VALUE_SCALE,
  WEB_VITALS_IDENTITY_MAX,
  type WebVitalsMetric,
} from '@berelax/shared/analytics/dimensions'
import { TRACK_EVENT_ATTRIBUTE } from './attributes.ts'
import type { Collector } from './collector.ts'

/**
 * Web-vitals field reporting with attribution (A-MEAS-04): what was slow, and what was responsible.
 *
 * ## Why this is hand-rolled and imports nothing
 *
 * `web-vitals` v4 is the obvious dependency and it is not here. Three reasons, in order of weight:
 *
 *   1. **The budget.** Everything in this directory ships to a visitor and buys them nothing — a
 *      measurement SDK is pure overhead to the person waiting for the page, which is the discipline
 *      `build/budgets.json`'s collector budget exists to keep. The attribution build of that library is
 *      larger than the whole collector it would sit beside.
 *   2. **The attribution is the part that needed deciding anyway.** The library's attribution gives a CSS
 *      selector for the element, and a selector carries ids, classes and in the worst case the element's
 *      own text — any of which can hold a service name or a price. ADR 0115 is the rule that an identity
 *      is a STRUCTURAL path and nothing else, and it is enforced by a pattern on the server
 *      (`WEB_VITALS_IDENTITY_PATTERN`). A library whose identity format this build does not control would
 *      have had to be post-processed anyway, and post-processing a selector into a safe one is harder to
 *      be sure of than building a safe one.
 *   3. **`pnpm deps`.** A new runtime dependency on the public bundle is a decision, not a convenience.
 *
 * What is NOT hand-rolled is the arithmetic. The CLS session window and the INP percentile below are the
 * published algorithms, implemented as they are specified and cited where they are not obvious — because
 * the alternative is a figure that cannot be compared with one measured by any other tool, which is the
 * whole value of using the published metric names.
 *
 * ## Pure first, browser second
 *
 * Everything that decides anything is a function of its arguments: {@link webVitalsValueOf},
 * {@link structuralIdentity}, {@link largestShiftWindow}, {@link interactionToNextPaint} and
 * {@link webVitalsEvent}. {@link attachWebVitals} is the only part that touches a `PerformanceObserver`,
 * and it decides nothing — it observes, folds through those functions, and hands the result to the
 * collector A-FIRST-06 already owns. There is no second send path and no `fetch` in this file.
 */

/** The four dimensions every reported metric carries. See the payload schema for why each one. */
export interface WebVitalsDimensions {
  /** The route, which is what makes `/book` measurable as its own route without a second event name. */
  readonly path: string
  readonly breakpoint: AnalyticsBreakpoint
  readonly locale: 'en' | 'ar'
  readonly direction: 'ltr' | 'rtl'
}

/** One metric as the browser reported it, before it becomes an event. */
export interface ObservedMetric {
  readonly metric: WebVitalsMetric
  /** Milliseconds, or the unitless CLS score. Converted to the stored integer by {@link webVitalsValueOf}. */
  readonly value: number
  /** The structural identity of the element responsible, or null when there is none. */
  readonly identity: string | null
}

/**
 * The stored integer for one metric's raw figure.
 *
 * CLS is unitless and arrives as a fraction, so it is carried in thousandths — the one place the scale is
 * applied, and the reason `CLS_VALUE_SCALE` is a shared constant rather than a `1000` written here and
 * again in whatever reads the rows. Everything else is whole milliseconds.
 *
 * Rounded and clamped at nought. A negative figure is not a fast page: `responseStart` can read as a
 * small negative number against a navigation start the browser revised, and a negative millisecond stored
 * as a measurement would make an average faster than any sample in it.
 */
export function webVitalsValueOf(metric: WebVitalsMetric, raw: number): number {
  if (!Number.isFinite(raw)) return 0
  const scaled = metric === 'CLS' ? raw * CLS_VALUE_SCALE : raw
  return Math.max(0, Math.round(scaled))
}

/**
 * The shape {@link structuralIdentity} needs of an element, and nothing more.
 *
 * Deliberately NOT `Element`. This interface admits a tag name, a parent, the parent's children and the
 * element's own declared track event — which means the function CANNOT read an id, a class, an attribute
 * value or any text, because it has no access to one. That is ADR 0115 expressed as a type rather than as
 * care taken: a future edit that wanted to put a class in the identity would have to widen this interface
 * first, which is a diff somebody reviews.
 */
export interface IdentifiableElement {
  /** Upper case from a real DOM, lower-cased here. */
  readonly tagName: string
  readonly parentElement: IdentifiableElement | null
  /**
   * The tag names of the parent's element children, in document order, and this element's index in that
   * list.
   *
   * Tag names and an index rather than the sibling ELEMENTS, and the difference is not cosmetic: a
   * position found by `siblings.indexOf(this)` needs object identity, and an adapter that builds a fresh
   * object per sibling — which any adapter over a live `HTMLCollection` does — can never satisfy it. The
   * first version of this interface was that one, and every `nth-of-type` it produced in a real browser
   * was silently omitted because `indexOf` answered -1.
   *
   * `siblingIndex` is -1 for a detached node, which omits the position rather than inventing one.
   */
  readonly siblingTags: readonly string[]
  readonly siblingIndex: number
  /** The value of `data-track`, or null. A taxonomy event name; nothing else passes the server's pattern. */
  readonly trackEvent: string | null
}

/**
 * How many ancestors an identity may name.
 *
 * Six, and the figure is a consequence rather than a choice: `WEB_VITALS_IDENTITY_MAX` is 160 characters
 * and a step is at most about twenty-five (`section:nth-of-type(12)>`), so six is what fits with the
 * `[data-track=…]` suffix. A deeper element is identified by its nearest six ancestors, which is enough
 * to find it and is not a different element from one step further up.
 */
export const IDENTITY_MAX_DEPTH = 6

/** Elements an identity stops at, because naming them says nothing. */
const IDENTITY_ROOTS: ReadonlySet<string> = new Set(['body', 'html'])

/**
 * The structural identity of an element: tag names, positions, and its own declared track event.
 *
 * `a:nth-of-type(2)` rather than `a.cta-whatsapp`, and `div>section:nth-of-type(3)>h2` rather than
 * `#hero-heading`. The position is `nth-of-type` and not `nth-child` because it is stable against a
 * sibling of a different tag being added — which happens on every page that grows a wrapper — and the
 * whole value of an identity is that two page loads of the same page produce the same one.
 *
 * `null` for an element whose tag is not a name (a custom element with a digit, an SVG node reported with
 * a colon), because the server's pattern would refuse it and a refused event is a lost metric. A figure
 * with no identity is still a figure; an identity the envelope rejects takes the figure with it.
 */
export function structuralIdentity(element: IdentifiableElement | null): string | null {
  if (element === null) return null
  const steps: string[] = []
  let node: IdentifiableElement | null = element
  let depth = 0
  while (node !== null && depth < IDENTITY_MAX_DEPTH) {
    const tag = node.tagName.toLowerCase()
    // The same shape `WEB_VITALS_IDENTITY_PATTERN` admits, and it must stay the same shape: a tag this
    // accepts and the server's pattern refuses costs the whole metric, not just the identity. `h1` to
    // `h6` are why the digit is here — the first version was `[a-z]+` and refused every heading.
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null
    if (IDENTITY_ROOTS.has(tag)) break
    const lower = node.siblingTags.map((name) => name.toLowerCase())
    const sameTagTotal = lower.filter((name) => name === tag).length
    const position =
      node.siblingIndex < 0
        ? 0
        : lower.slice(0, node.siblingIndex).filter((name) => name === tag).length + 1
    // The position is omitted when the element is the only one of its tag among its siblings, which keeps
    // the common case short, and for a detached node, where `nth-of-type(0)` is not a selector.
    steps.push(sameTagTotal > 1 && position > 0 ? `${tag}:nth-of-type(${position})` : tag)
    node = node.parentElement
    depth += 1
  }
  if (steps.length === 0) return null
  const declared = element.trackEvent
  const suffix = declared !== null && /^[a-z_]+$/.test(declared) ? `[data-track=${declared}]` : ''
  const identity = `${steps.toReversed().join('>')}${suffix}`
  // Truncation would produce a string the server's pattern refuses, so an over-long identity is dropped
  // rather than cut: the metric still travels, without an identity.
  return identity.length <= WEB_VITALS_IDENTITY_MAX ? identity : null
}

/** One layout shift, as the observer reports it. */
export interface LayoutShift {
  readonly value: number
  readonly startTime: number
  /** The node the shift was attributed to, or null. */
  readonly source: IdentifiableElement | null
}

/** The gap that ends a CLS session window, and the window's own cap. The published algorithm's figures. */
export const CLS_SESSION_GAP_MS = 1000
export const CLS_SESSION_WINDOW_MS = 5000

/**
 * The largest CLS session window, and the element the biggest shift in it was attributed to.
 *
 * The published algorithm, not an average and not a total: a session window is a run of shifts each
 * within one second of the previous one and at most five seconds long, and CLS is the LARGEST such
 * window. A plain sum would make a page that shifted a little on every scroll worse than one that threw
 * its content around once, which is the opposite of what a reader experiences.
 *
 * The identity is the biggest shift's source rather than the last one's, because the element that moved
 * furthest is the one somebody has to fix.
 */
export function largestShiftWindow(shifts: readonly LayoutShift[]): {
  readonly value: number
  readonly source: IdentifiableElement | null
} {
  let best = { value: 0, source: null as IdentifiableElement | null }
  let current = 0
  let largestInWindow: LayoutShift | null = null
  let windowStart = 0
  let previous = 0
  for (const shift of shifts) {
    const continues =
      largestInWindow !== null &&
      shift.startTime - previous < CLS_SESSION_GAP_MS &&
      shift.startTime - windowStart < CLS_SESSION_WINDOW_MS
    if (continues) {
      current += shift.value
      if (largestInWindow === null || shift.value > largestInWindow.value) largestInWindow = shift
    } else {
      current = shift.value
      largestInWindow = shift
      windowStart = shift.startTime
    }
    previous = shift.startTime
    if (current > best.value) best = { value: current, source: largestInWindow?.source ?? null }
  }
  return best
}

/** One interaction, folded to its worst duration. */
export interface Interaction {
  readonly durationMs: number
  readonly target: IdentifiableElement | null
}

/** How many of the longest interactions the percentile is taken over. The published algorithm's figure. */
export const INP_LONGEST_KEPT = 10

/**
 * Interaction to Next Paint: the high percentile of this page's interaction latencies.
 *
 * The published algorithm and not the maximum. It keeps the ten longest interactions and reports the one
 * at `floor(interactionCount / 50)` — so a page with fewer than fifty interactions reports its worst, and
 * a page with four hundred reports roughly its 98th percentile. The maximum alone is the figure a single
 * unlucky interaction on one visit decides, and it is why the published metric is not the maximum.
 *
 * `null` for a page nobody interacted with, which is not an INP of nought: a page with no interaction has
 * no interaction latency, and nought would read as instant (ADR 0002).
 */
export function interactionToNextPaint(
  interactions: readonly Interaction[],
  interactionCount: number,
): Interaction | null {
  if (interactions.length === 0) return null
  const longest = [...interactions].toSorted((a, b) => b.durationMs - a.durationMs)
  const kept = longest.slice(0, INP_LONGEST_KEPT)
  const index = Math.min(kept.length - 1, Math.floor(Math.max(0, interactionCount) / 50))
  return kept[index] ?? null
}

/**
 * One metric as an event the collector will queue.
 *
 * ## Why this does NOT validate
 *
 * `parseAnalyticsEvent` is the taxonomy's door and it is zod, and zod in a browser module is the 106,765
 * bytes `dimensions.ts`'s header records. The collector takes the same position for the same reason, in
 * so many words: *"what makes it a valid payload is `scripts/check-event-attributes.mjs` at build time
 * and `parseAnalyticsEvent` at the server — not a cast here, and not a second validator in the browser"*.
 *
 * So the refusal lives at `/api/collect`, which is where it has to be anyway: that is a write path
 * exposed to the internet, so a validator that ran only in this build's own code would cover the one
 * caller that was never the risk. ADR 0115's identity pattern is part of that schema, and
 * `web-vitals.test.ts` runs the SERVER's own validator over this function's output — which is a stronger
 * claim than this function validating, because it is the real refusal applied to the real payload.
 *
 * The assertion is therefore the whole cost of the decision, and it is narrow: `AnalyticsEvent` is a
 * union whose `web_vitals` member is exactly the object below, and the fields are built from the typed
 * arguments rather than from anything that arrived as data.
 */
export function webVitalsEvent(
  observed: ObservedMetric,
  dimensions: WebVitalsDimensions,
): AnalyticsEvent {
  return {
    name: 'web_vitals',
    payload: {
      path: dimensions.path,
      metric: observed.metric,
      value: webVitalsValueOf(observed.metric, observed.value),
      breakpoint: dimensions.breakpoint,
      locale: dimensions.locale,
      direction: dimensions.direction,
      identity: observed.identity,
    },
  } as AnalyticsEvent
}

// --- the browser half ------------------------------------------------------------------------------

/** The minimum event duration the interaction observer is told to report, in milliseconds. */
export const INP_DURATION_THRESHOLD_MS = 40

/** Everything this module does to a browser, as values somebody else supplies. */
export interface WebVitalsHost {
  /**
   * The two things this module asks of a collector, and not the whole of one.
   *
   * `Pick` rather than `Collector`, so the app's client boundary can hand over the two functions the
   * shared collector exports — `trackCollectorEvent` and `flushCollector` — instead of constructing a
   * second collector with a second queue, a second browser host and a second envelope. Two collectors on
   * one page is two batches, and the second one's `interactionCount` would be nought for a page somebody
   * interacted with.
   */
  readonly collector: {
    readonly track: Collector['track']
    /**
     * Posts what is queued. Returns nothing, deliberately.
     *
     * `Collector['flush']` answers a `FlushResult` and the shared collector's exported door
     * (`flushCollector`) answers `void`, because the island's flush is gated on whether the network is
     * open yet and has nothing useful to report about a call it declined. Narrowing the return here is
     * what lets the app hand over the function it has instead of wrapping it in one that invents a
     * result.
     */
    readonly flush: () => void
  }
  readonly dimensions: () => WebVitalsDimensions
  /**
   * Observes one entry type, or does nothing where the browser cannot.
   *
   * Injected rather than read off `globalThis`, so the fold below is drivable without a browser and so a
   * `PerformanceObserver` that throws on an unsupported `type` — which is what Safari did for `event` for
   * two years — cannot stop the other four metrics being reported.
   */
  readonly observe: (
    type: string,
    options: { readonly buffered: boolean; readonly durationThreshold?: number },
    onEntries: (entries: readonly unknown[]) => void,
  ) => (() => void) | null
  /** Calls back once, when the page is being hidden or unloaded. The only moment a metric is final. */
  readonly onFinal: (report: () => void) => () => void
  /** `responseStart` relative to the navigation, or null where there is no navigation entry. */
  readonly timeToFirstByte: () => number | null
  /** Adapts a real DOM node to the three things an identity may read. Null for a node with no element. */
  readonly identify: (node: unknown) => IdentifiableElement | null
}

/**
 * Observes the five metrics and reports each one at most once, when the page is hidden.
 *
 * ## Why every metric is reported at the END and not as it arrives
 *
 * LCP is not final until the first interaction or the page is hidden — a later, larger element replaces
 * it. CLS accumulates. INP is a percentile over interactions that have not happened yet. So a reporter
 * that sent each metric when the observer first fired would send the first candidate and never the
 * answer, and the figures would be systematically better than the page. One report per metric per page
 * view, taken when there is nothing left to revise.
 *
 * ## Why this is not in the LCP critical request chain
 *
 * It issues no request at all. The events go into the collector's queue, and the collector decides when
 * to flush — which A-FIRST-06 made "not before the `load` event". The only thing this adds before first
 * paint is the registration of four observers, which costs no network and no layout.
 *
 * Returns a function that stops every observer and the final hook, so a suite can run twice in one page.
 */
export function attachWebVitals(host: WebVitalsHost): () => void {
  let largestContentful: { value: number; element: IdentifiableElement | null } | null = null
  const shifts: LayoutShift[] = []
  const interactions = new Map<number, Interaction>()
  let firstContentfulPaint: number | null = null
  let reported = false

  const stops: (() => void)[] = []
  const push = (stop: (() => void) | null): void => {
    if (stop !== null) stops.push(stop)
  }

  push(
    host.observe('largest-contentful-paint', { buffered: true }, (entries) => {
      for (const entry of entries) {
        const row = entry as { startTime?: unknown; element?: unknown }
        if (typeof row.startTime !== 'number') continue
        // The LAST entry wins, not the largest: the browser only emits a new entry when it has found a
        // larger element, so the final one IS the largest and comparing sizes here would be a second
        // opinion about a question the browser has already answered.
        largestContentful = { value: row.startTime, element: host.identify(row.element) }
      }
    }),
  )

  push(
    host.observe('layout-shift', { buffered: true }, (entries) => {
      for (const entry of entries) {
        const row = entry as {
          value?: unknown
          startTime?: unknown
          hadRecentInput?: unknown
          sources?: unknown
        }
        // `hadRecentInput` shifts are excluded by the metric's own definition: a layout change a reader
        // caused by pressing something is not an unexpected shift.
        if (row.hadRecentInput === true) continue
        if (typeof row.value !== 'number' || typeof row.startTime !== 'number') continue
        const sources = Array.isArray(row.sources) ? row.sources : []
        const first = sources[0] as { node?: unknown } | undefined
        shifts.push({
          value: row.value,
          startTime: row.startTime,
          source: host.identify(first?.node),
        })
      }
    }),
  )

  push(
    host.observe(
      'event',
      { buffered: true, durationThreshold: INP_DURATION_THRESHOLD_MS },
      (entries) => {
        for (const entry of entries) {
          const row = entry as { interactionId?: unknown; duration?: unknown; target?: unknown }
          // `interactionId` of 0 is an event that was not part of an interaction — a scroll, a programmatic
          // dispatch — and folding those in would make INP a figure about the page rather than about what
          // a reader did.
          if (typeof row.interactionId !== 'number' || row.interactionId === 0) continue
          if (typeof row.duration !== 'number') continue
          const existing = interactions.get(row.interactionId)
          // One interaction produces several events (pointerdown, pointerup, click) and its latency is the
          // WORST of them, which is what the published algorithm does: the reader waited for the slowest
          // part, not for the average of the parts.
          if (existing === undefined || row.duration > existing.durationMs) {
            interactions.set(row.interactionId, {
              durationMs: row.duration,
              target: host.identify(row.target),
            })
          }
        }
      },
    ),
  )

  push(
    host.observe('paint', { buffered: true }, (entries) => {
      for (const entry of entries) {
        const row = entry as { name?: unknown; startTime?: unknown }
        if (row.name !== 'first-contentful-paint' || typeof row.startTime !== 'number') continue
        firstContentfulPaint = row.startTime
      }
    }),
  )

  const report = (): void => {
    // Once. `visibilitychange` and `pagehide` both fire on a real navigation, and a reporter that sent on
    // both would double every figure on the dashboard while every single measurement stayed correct.
    if (reported) return
    reported = true
    const dimensions = host.dimensions()
    const observed: ObservedMetric[] = []

    const ttfb = host.timeToFirstByte()
    if (ttfb !== null) observed.push({ metric: 'TTFB', value: ttfb, identity: null })
    if (firstContentfulPaint !== null) {
      observed.push({ metric: 'FCP', value: firstContentfulPaint, identity: null })
    }
    if (largestContentful !== null) {
      observed.push({
        metric: 'LCP',
        value: largestContentful.value,
        identity: structuralIdentity(largestContentful.element),
      })
    }
    if (shifts.length > 0) {
      const window = largestShiftWindow(shifts)
      observed.push({
        metric: 'CLS',
        value: window.value,
        identity: structuralIdentity(window.source),
      })
    }
    const inp = interactionToNextPaint([...interactions.values()], interactions.size)
    if (inp !== null) {
      observed.push({
        metric: 'INP',
        value: inp.durationMs,
        identity: structuralIdentity(inp.target),
      })
    }

    for (const metric of observed) {
      // `track` and not a second send path: the collector owns the queue, the batching, the body cap and
      // the offline retry, and a reporter with its own `fetch` would be a second answer to every one of
      // those questions. A payload the taxonomy refuses throws out of `webVitalsEvent`, which is why each
      // one is wrapped: one unreportable metric must not cost the other four.
      try {
        host.collector.track(webVitalsEvent(metric, dimensions))
      } catch {
        // Swallowed deliberately, and it is the only swallow in this file. The alternative is an
        // exception inside a `visibilitychange` handler on a page being unloaded, which the visitor sees
        // as a broken page for a measurement they did not ask for.
      }
    }
    host.collector.flush()
  }

  stops.push(host.onFinal(report))
  return () => {
    for (const stop of stops) stop()
    stops.length = 0
  }
}

/**
 * Adapts a real DOM node to {@link IdentifiableElement}.
 *
 * The one function in this file that knows what an `Element` is, and it exposes exactly three things:
 * `tagName`, the parent, and `data-track`. `siblings` is read lazily through a getter so identifying a
 * deep element does not walk the whole document up front.
 *
 * Duck-typed rather than `instanceof Element`: this runs in a browser, and a node arriving from inside an
 * `<iframe>` or a shadow root is an `Element` from a different realm, for which `instanceof` is false. A
 * node with no `tagName` is not an element and answers null.
 */
export function identifiableFrom(node: unknown): IdentifiableElement | null {
  if (node === null || typeof node !== 'object') return null
  const element = node as {
    tagName?: unknown
    parentElement?: unknown
    getAttribute?: (name: string) => string | null
  }
  if (typeof element.tagName !== 'string') return null
  const parent = element.parentElement
  const children =
    parent !== null && typeof parent === 'object'
      ? ((parent as { children?: ArrayLike<unknown> }).children ?? null)
      : null
  const list = children === null ? [] : Array.from(children as ArrayLike<unknown>)
  return {
    tagName: element.tagName,
    parentElement: identifiableFrom(parent),
    siblingTags: list.map((child) =>
      typeof (child as { tagName?: unknown }).tagName === 'string'
        ? (child as { tagName: string }).tagName
        : '',
    ),
    siblingIndex: list.indexOf(node),
    trackEvent:
      typeof element.getAttribute === 'function'
        ? element.getAttribute(TRACK_EVENT_ATTRIBUTE)
        : null,
  }
}

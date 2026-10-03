import {
  ANALYTICS_WRITING_DIRECTIONS,
  CLS_VALUE_SCALE,
  parseAnalyticsEvent,
  WEB_VITALS_IDENTITY_MAX,
  WEB_VITALS_IDENTITY_PATTERN,
  WEB_VITALS_METRICS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { directionFor } from '../theme/theme.ts'
import type { Collector, FlushResult, TrackOutcome } from './collector.ts'
import {
  attachWebVitals,
  CLS_SESSION_GAP_MS,
  IDENTITY_MAX_DEPTH,
  type IdentifiableElement,
  INP_LONGEST_KEPT,
  type Interaction,
  interactionToNextPaint,
  largestShiftWindow,
  structuralIdentity,
  type WebVitalsDimensions,
  type WebVitalsHost,
  webVitalsEvent,
  webVitalsValueOf,
} from './web-vitals.ts'

/**
 * Web-vitals field reporting (A-MEAS-04): the arithmetic, the identity, and the one report per page.
 *
 * ## The case this file exists for
 *
 * `structuralIdentity` is the whole of ADR 0115 in the browser, and the thing it must be shown to do is
 * REFUSE: an element whose id is `price-table` and whose class is `deep-tissue` must produce an identity
 * that contains neither word. Every positive case below is paired with that, and the server's own pattern
 * is applied to every identity this file produces — so an identity that passed here and would be refused
 * at `/api/collect` is a failing test rather than a metric nobody receives.
 *
 * ## Why the published algorithms are tested against worked examples
 *
 * CLS's session window and INP's percentile are not this build's inventions and their value is that they
 * are comparable with a figure measured by any other tool. A test asserting whatever the implementation
 * happens to produce would hold that comparability to nothing, so the cases below are small sequences
 * whose answers can be worked out by hand from the published definitions.
 */

const DIMENSIONS: WebVitalsDimensions = {
  path: '/book',
  breakpoint: 'sm',
  locale: 'en',
  direction: 'ltr',
}

/** An element, with its parent chain, as the pure identity function needs it. */
function element(args: {
  readonly tag: string
  readonly parent?: IdentifiableElement | null
  readonly siblingTags?: readonly string[]
  readonly siblingIndex?: number
  readonly trackEvent?: string | null
}): IdentifiableElement {
  return {
    tagName: args.tag,
    parentElement: args.parent ?? null,
    siblingTags: args.siblingTags ?? [args.tag],
    siblingIndex: args.siblingIndex ?? 0,
    trackEvent: args.trackEvent ?? null,
  }
}

describe('the stored value is an integer in the metric’s own unit', () => {
  it('carries CLS in thousandths and everything else in whole milliseconds', () => {
    expect(webVitalsValueOf('CLS', 0.082)).toBe(82)
    expect(CLS_VALUE_SCALE).toBe(1000)
    expect(webVitalsValueOf('LCP', 2487.4)).toBe(2487)
    expect(webVitalsValueOf('INP', 196.6)).toBe(197)
  })

  it('clamps a negative figure at nought rather than storing a faster-than-instant page', () => {
    // `responseStart` can read negative against a navigation start the browser revised, and a negative
    // millisecond in a stored measurement makes an average faster than any sample in it.
    expect(webVitalsValueOf('TTFB', -3)).toBe(0)
    expect(webVitalsValueOf('CLS', Number.NaN)).toBe(0)
    expect(webVitalsValueOf('LCP', Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('an attribution identity is structural and nothing else (ADR 0115)', () => {
  it('names tags and positions, and satisfies the pattern the server enforces', () => {
    const section = element({
      tag: 'SECTION',
      siblingTags: ['HEADER', 'SECTION', 'SECTION'],
      siblingIndex: 2,
    })
    const heading = element({
      tag: 'H2',
      parent: section,
      siblingTags: ['H2', 'P'],
      siblingIndex: 0,
    })
    const identity = structuralIdentity(heading)
    expect(identity).toBe('section:nth-of-type(2)>h2')
    expect(WEB_VITALS_IDENTITY_PATTERN.test(identity ?? '')).toBe(true)
  })

  it('cannot carry an id, a class or any text, because it is given none', () => {
    // The strongest form of the claim: the interface the function takes admits a tag, a parent, the
    // sibling tag names and `data-track`. A hostile element carrying all three forbidden things produces
    // an identity with none of them in it, because there is no field for them to arrive in.
    const hostile = {
      tagName: 'BUTTON',
      parentElement: null,
      siblingTags: ['BUTTON'],
      siblingIndex: 0,
      trackEvent: null,
      // Fields a DOM element has and this interface does not. Present here on purpose: if the type were
      // ever widened to `Element`, this object would start being read and the assertions below would be
      // the thing that fails.
      id: 'price-table',
      className: 'deep-tissue-card',
      textContent: 'Deep tissue, AED 420',
    } as unknown as IdentifiableElement
    const identity = structuralIdentity(hostile)
    expect(identity).toBe('button')
    expect(identity).not.toContain('price')
    expect(identity).not.toContain('deep-tissue')
    expect(identity).not.toContain('420')
  })

  it('carries a declared track event, which is the only attribute value it may name', () => {
    const anchor = element({
      tag: 'A',
      siblingTags: ['A', 'A'],
      siblingIndex: 1,
      trackEvent: 'cta_click',
    })
    const identity = structuralIdentity(anchor)
    expect(identity).toBe('a:nth-of-type(2)[data-track=cta_click]')
    expect(WEB_VITALS_IDENTITY_PATTERN.test(identity ?? '')).toBe(true)
  })

  it('refuses a track attribute that is not a bare name, rather than passing it through', () => {
    // The attribute is markup and markup is editable. A value with a quote or a space in it would make an
    // identity the server refuses, which costs the metric; it is dropped from the identity instead.
    const anchor = element({ tag: 'A', trackEvent: 'cta_click"><script>' })
    expect(structuralIdentity(anchor)).toBe('a')
  })

  it('omits the position when the element is the only one of its tag', () => {
    expect(
      structuralIdentity(element({ tag: 'MAIN', siblingTags: ['MAIN'], siblingIndex: 0 })),
    ).toBe('main')
  })

  it('stops at the body and at the depth cap, and never produces a refused identity', () => {
    let node = element({ tag: 'BODY' })
    for (let depth = 0; depth < IDENTITY_MAX_DEPTH + 4; depth += 1) {
      node = element({ tag: 'DIV', parent: node, siblingTags: ['DIV'], siblingIndex: 0 })
    }
    const identity = structuralIdentity(node)
    expect(identity).not.toContain('body')
    expect((identity ?? '').split('>')).toHaveLength(IDENTITY_MAX_DEPTH)
    expect(WEB_VITALS_IDENTITY_PATTERN.test(identity ?? '')).toBe(true)
    expect((identity ?? '').length).toBeLessThanOrEqual(WEB_VITALS_IDENTITY_MAX)
  })

  it('answers null for no element and for a tag that is not a name', () => {
    expect(structuralIdentity(null)).toBeNull()
    // An SVG node reported with a colon in its name: the server's pattern would refuse it, and a refused
    // envelope costs the figure as well as the identity. A custom element's own name is structural and IS
    // admitted — see the pattern's note on why the digit and the hyphen are there.
    expect(structuralIdentity(element({ tag: 'svg:rect' }))).toBeNull()
    expect(structuralIdentity(element({ tag: 'my-widget-2' }))).toBe('my-widget-2')
    expect(structuralIdentity(element({ tag: 'H3', siblingTags: ['H3'], siblingIndex: 0 }))).toBe(
      'h3',
    )
    expect(structuralIdentity(element({ tag: 'BODY' }))).toBeNull()
  })
})

describe('CLS is the largest session window, not the total', () => {
  it('sums a run of shifts within a second of each other', () => {
    const source = element({ tag: 'IMG' })
    const window = largestShiftWindow([
      { value: 0.02, startTime: 100, source: null },
      { value: 0.05, startTime: 600, source },
      { value: 0.01, startTime: 1200, source: null },
    ])
    expect(window.value).toBeCloseTo(0.08, 5)
    // The biggest shift in the window, not the last one: the element that moved furthest is the one
    // somebody has to fix.
    expect(window.source).toBe(source)
  })

  it('starts a new window after a gap, and reports the larger of the two', () => {
    const window = largestShiftWindow([
      { value: 0.3, startTime: 100, source: null },
      { value: 0.1, startTime: 100 + CLS_SESSION_GAP_MS + 1, source: null },
      { value: 0.1, startTime: 100 + CLS_SESSION_GAP_MS + 200, source: null },
    ])
    // 0.3 alone beats 0.2, which a total would not: a total would answer 0.5 and report a page that
    // shifted twice gently as worse than one that threw its content around once.
    expect(window.value).toBeCloseTo(0.3, 5)
  })

  it('answers nought for a page that never shifted', () => {
    expect(largestShiftWindow([]).value).toBe(0)
    expect(largestShiftWindow([]).source).toBeNull()
  })
})

describe('INP is the published percentile, not the maximum', () => {
  const interaction = (durationMs: number): Interaction => ({ durationMs, target: null })

  it('reports the worst interaction on a page with fewer than fifty', () => {
    expect(
      interactionToNextPaint([interaction(40), interaction(220), interaction(90)], 3)?.durationMs,
    ).toBe(220)
  })

  it('moves down the ranking as the interaction count grows', () => {
    const many = [500, 400, 300, 200, 100].map(interaction)
    // floor(100 / 50) = 2, so the third-longest. The maximum alone is the figure one unlucky interaction
    // decides, which is why the published metric is not the maximum.
    expect(interactionToNextPaint(many, 100)?.durationMs).toBe(300)
    expect(interactionToNextPaint(many, 0)?.durationMs).toBe(500)
  })

  it('never indexes past the interactions it kept', () => {
    const many = Array.from({ length: 30 }, (_, index) => interaction(1000 - index))
    const answer = interactionToNextPaint(many, 100_000)
    expect(answer).not.toBeNull()
    // Ten are kept, so the index is clamped at nine rather than reading undefined off the end.
    expect(answer?.durationMs).toBe(1000 - (INP_LONGEST_KEPT - 1))
  })

  it('answers null for a page nobody interacted with, which is not an INP of nought', () => {
    expect(interactionToNextPaint([], 0)).toBeNull()
  })
})

describe('an event is built through the taxonomy', () => {
  it('produces a payload the SERVER’s own validator accepts', () => {
    /*
      The builder does not validate — zod in a browser module is the 106,765 bytes
      `dimensions.ts`'s header records — so this is where the claim is made instead, and it is the
      stronger form of it: `parseAnalyticsEvent` is the exact function `/api/collect` runs, applied here
      to the exact object the builder produced. A builder that validated itself would be asserting its own
      opinion; this asserts the server's.
    */
    const built = webVitalsEvent(
      {
        metric: 'LCP',
        value: 2487.4,
        identity: 'section:nth-of-type(2)>h2',
      },
      DIMENSIONS,
    )
    expect(() => parseAnalyticsEvent(built.name, built.payload)).not.toThrow()
    expect(parseAnalyticsEvent(built.name, built.payload).payload).toEqual(built.payload)
  })

  it('validates against the schema and carries all four dimensions', () => {
    const event = webVitalsEvent(
      { metric: 'INP', value: 196.6, identity: 'a[data-track=cta_click]' },
      DIMENSIONS,
    )
    expect(event.name).toBe('web_vitals')
    expect(event.payload).toEqual({
      path: '/book',
      metric: 'INP',
      value: 197,
      breakpoint: 'sm',
      locale: 'en',
      direction: 'ltr',
      identity: 'a[data-track=cta_click]',
    })
  })

  it('refuses an identity ADR 0115 forbids, at the taxonomy and not in a reviewer’s head', () => {
    // The control that makes the identity assertions above matter: a selector with a class in it is
    // refused by the same schema the server runs, so an identity that got past this module could not
    // reach the store either.
    expect(() =>
      parseAnalyticsEvent('web_vitals', {
        path: '/book',
        metric: 'LCP',
        value: 2400,
        breakpoint: 'sm',
        locale: 'en',
        direction: 'ltr',
        identity: 'section>h2.deep-tissue',
      }),
    ).toThrow()
  })

  it('holds the writing directions equal to the ones the UI produces', () => {
    // `packages/shared` may not import a React package, so ANALYTICS_WRITING_DIRECTIONS is a second
    // statement of what `directionFor` returns. This is the check that comes with it — the same
    // arrangement the breakpoint bands record one file over.
    expect([...ANALYTICS_WRITING_DIRECTIONS].toSorted()).toEqual(
      [directionFor('en'), directionFor('ar')].toSorted(),
    )
  })

  it('offers five metrics and refuses a sixth nobody defined', () => {
    expect([...WEB_VITALS_METRICS]).toEqual(['LCP', 'CLS', 'INP', 'TTFB', 'FCP'])
    expect(() =>
      parseAnalyticsEvent('web_vitals', { ...DIMENSIONS, metric: 'TBT', value: 1, identity: null }),
    ).toThrow()
  })
})

describe('one report per page view, taken when nothing is left to revise', () => {
  /** A collector that records what it was handed, and nothing else. */
  function recordingCollector(): {
    readonly collector: Collector
    readonly tracked: { name: string; payload: unknown }[]
    readonly flushes: () => number
  } {
    const tracked: { name: string; payload: unknown }[] = []
    let flushes = 0
    const outcome: TrackOutcome = { accepted: true, clientEventId: 'fixture' }
    const flushResult: FlushResult = { requests: 0, sent: 0, kept: 0, dropped: 0 }
    return {
      tracked,
      flushes: () => flushes,
      collector: {
        track: (event) => {
          tracked.push({ name: event.name, payload: event.payload })
          return outcome
        },
        trackInteraction: () => outcome,
        flush: () => {
          flushes += 1
          return flushResult
        },
        queued: () => 0,
        interactions: () => 0,
      },
    }
  }

  /** A host whose observers are driven by hand, so the fold is testable with no browser. */
  function fixtureHost(): {
    readonly host: WebVitalsHost
    readonly emit: (type: string, entries: readonly unknown[]) => void
    readonly final: () => void
    readonly collector: ReturnType<typeof recordingCollector>
    readonly stopped: () => number
  } {
    const collector = recordingCollector()
    const listeners = new Map<string, (entries: readonly unknown[]) => void>()
    let report: (() => void) | null = null
    let stopped = 0
    return {
      collector,
      stopped: () => stopped,
      emit: (type, entries) => listeners.get(type)?.(entries),
      final: () => report?.(),
      host: {
        collector: collector.collector,
        dimensions: () => DIMENSIONS,
        observe: (type, _options, onEntries) => {
          listeners.set(type, onEntries)
          return () => {
            stopped += 1
          }
        },
        onFinal: (hook) => {
          report = hook
          return () => {
            stopped += 1
          }
        },
        timeToFirstByte: () => 183,
        identify: (node) =>
          node === null || node === undefined ? null : (node as IdentifiableElement),
      },
    }
  }

  it('reports every metric it observed, once, and flushes', () => {
    const fixture = fixtureHost()
    const stop = attachWebVitals(fixture.host)
    fixture.emit('paint', [{ name: 'first-contentful-paint', startTime: 910 }])
    fixture.emit('largest-contentful-paint', [
      { startTime: 1400, element: null },
      // The LAST entry wins: the browser only emits a new one when it has found a larger element.
      { startTime: 2460, element: element({ tag: 'IMG', siblingTags: ['IMG'], siblingIndex: 0 }) },
    ])
    fixture.emit('layout-shift', [
      { value: 0.04, startTime: 300, hadRecentInput: false, sources: [] },
    ])
    fixture.emit('event', [{ interactionId: 7, duration: 210, target: null }])
    fixture.final()

    const byMetric = new Map(
      fixture.collector.tracked.map((event) => [
        (event.payload as { metric: string }).metric,
        event.payload as Record<string, unknown>,
      ]),
    )
    expect([...byMetric.keys()].toSorted()).toEqual(['CLS', 'FCP', 'INP', 'LCP', 'TTFB'])
    expect(byMetric.get('LCP')).toMatchObject({ value: 2460, identity: 'img' })
    expect(byMetric.get('CLS')).toMatchObject({ value: 40 })
    expect(byMetric.get('INP')).toMatchObject({ value: 210 })
    expect(byMetric.get('TTFB')).toMatchObject({ value: 183 })
    expect(fixture.collector.flushes()).toBe(1)

    // Once. `visibilitychange` and `pagehide` both fire on a real navigation, and a reporter that sent on
    // both would double every figure on the dashboard while every single measurement stayed correct.
    fixture.final()
    expect(fixture.collector.tracked).toHaveLength(5)
    stop()
    expect(fixture.stopped()).toBeGreaterThanOrEqual(5)
  })

  it('reports nothing for a metric the browser never offered, rather than a nought', () => {
    const fixture = fixtureHost()
    attachWebVitals({ ...fixture.host, timeToFirstByte: () => null })
    fixture.final()
    expect(fixture.collector.tracked).toEqual([])
    // The control: the same host WITH entries reports them, so the emptiness above is the absence of
    // observations and not a reporter that never sends.
    const second = fixtureHost()
    attachWebVitals(second.host)
    second.final()
    expect(second.collector.tracked).toHaveLength(1)
  })

  it('excludes a shift the reader caused and an event that is not an interaction', () => {
    const fixture = fixtureHost()
    attachWebVitals({ ...fixture.host, timeToFirstByte: () => null })
    fixture.emit('layout-shift', [{ value: 0.5, startTime: 10, hadRecentInput: true, sources: [] }])
    fixture.emit('event', [{ interactionId: 0, duration: 900, target: null }])
    fixture.final()
    expect(fixture.collector.tracked).toEqual([])
  })

  it('survives an observer the browser refuses to install', () => {
    // Safari refused `event` for two years. A reporter that threw, or that stopped registering after the
    // first refusal, would lose the other four metrics on every one of those browsers.
    const fixture = fixtureHost()
    attachWebVitals({
      ...fixture.host,
      observe: (type, options, onEntries) =>
        type === 'event' ? null : fixture.host.observe(type, options, onEntries),
    })
    fixture.emit('paint', [{ name: 'first-contentful-paint', startTime: 700 }])
    fixture.final()
    expect(
      fixture.collector.tracked
        .map((event) => (event.payload as { metric: string }).metric)
        .toSorted(),
    ).toEqual(['FCP', 'TTFB'])
  })
})

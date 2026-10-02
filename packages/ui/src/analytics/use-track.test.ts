import { parseAnalyticsEvent } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { TRACK_EVENT_ATTRIBUTE, trackPayloadAttribute } from './attributes.ts'
import {
  type Collector,
  type CollectorHost,
  createCollector,
  type TrackOutcome,
} from './collector.ts'
import {
  attachDeclaredTracking,
  declaredEventOf,
  declaringElement,
  pageViewEvent,
  TRACK_SELECTOR,
  type TrackableClick,
  type TrackableElement,
  type TrackableRoot,
  trackDeclaringElement,
} from './use-track.ts'

/**
 * The delegated listener, driven with structural stand-ins for an element, a click and a document.
 *
 * `use-track.ts` names no DOM type — every dependency is a parameter, exactly as `motion/observe.ts` is —
 * so the whole of it runs in `environment: 'node'` with nothing started. What that buys is the ability to
 * assert the two things a browser suite is bad at: that a click on a CHILD of the declaring element is
 * tracked (because that is what a reader actually clicks: the `<span>` inside the anchor), and that each
 * refusal fires for its own reason, which has no user-visible effect and therefore cannot be observed from
 * outside at all.
 */

/** An element with attributes and a parent chain, enough for `closest`. */
class FakeElement implements TrackableElement {
  constructor(
    private readonly attributes: Readonly<Record<string, string>>,
    private readonly parent: FakeElement | null = null,
  ) {}

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getAttributeNames(): readonly string[] {
    return Object.keys(this.attributes)
  }

  closest(selector: string): TrackableElement | null {
    // Only the one selector this module uses; a fake that implemented CSS would be testing itself.
    if (selector !== TRACK_SELECTOR) throw new Error(`unexpected selector ${selector}`)
    if (this.attributes[TRACK_EVENT_ATTRIBUTE] !== undefined) return this
    return this.parent?.closest(selector) ?? null
  }
}

/** A document that records its listeners so a test can fire one and then detach it. */
class FakeRoot implements TrackableRoot {
  readonly listeners: ((event: TrackableClick) => void)[] = []
  captures = 0

  addEventListener(
    _type: 'click',
    listener: (event: TrackableClick) => void,
    options?: { readonly capture?: boolean },
  ): void {
    if (options?.capture === true) this.captures += 1
    this.listeners.push(listener)
  }

  removeEventListener(_type: 'click', listener: (event: TrackableClick) => void): void {
    const at = this.listeners.indexOf(listener)
    if (at !== -1) this.listeners.splice(at, 1)
  }

  click(target: unknown): void {
    for (const listener of [...this.listeners]) listener({ target })
  }
}

function collectorFor(): { readonly collector: Collector; readonly bodies: string[] } {
  const bodies: string[] = []
  let issued = 0
  const host: CollectorHost = {
    now: () => 1_767_225_600_000,
    newEventId: () => {
      issued += 1
      return `fixture-${issued}`
    },
    viewportWidth: () => 390,
    query: () => null,
    referrer: () => null,
    online: () => true,
    send: (_path, body) => {
      bodies.push(body)
      return true
    },
  }
  return { collector: createCollector(host), bodies }
}

const cta = (target: string): Readonly<Record<string, string>> => ({
  [TRACK_EVENT_ATTRIBUTE]: 'cta_click',
  [trackPayloadAttribute('target')]: target,
})

describe('declaringElement', () => {
  it('finds the declaring ancestor of whatever was actually clicked', () => {
    const anchor = new FakeElement(cta('whatsapp'))
    const icon = new FakeElement({ class: 'icon' }, anchor)
    const glyph = new FakeElement({}, icon)
    // Two levels down, which is the ordinary case: a reader clicks the `<svg>` inside the `<span>` inside
    // the anchor. A test on the event target itself would track nothing on any control with an icon in it.
    expect(declaringElement({ target: glyph })).toBe(anchor)
  })

  it('answers null for a click on nothing, on a plain element, and on a non-element', () => {
    expect(declaringElement({ target: null })).toBeNull()
    expect(declaringElement({ target: 'not an element' })).toBeNull()
    expect(declaringElement({ target: {} })).toBeNull()
    expect(declaringElement({ target: new FakeElement({ class: 'plain' }) })).toBeNull()
  })
})

describe('trackDeclaringElement', () => {
  it('queues the event the element declares, with the path the collector supplied', () => {
    const { collector } = collectorFor()
    const outcome = trackDeclaringElement(collector, new FakeElement(cta('call')), {
      path: '/book',
    })
    expect(outcome?.accepted).toBe(true)
    expect(collector.queued()).toBe(1)
    collector.flush()
  })

  it('answers null for an element that declares nothing at all', () => {
    const { collector } = collectorFor()
    expect(
      trackDeclaringElement(collector, new FakeElement({ class: 'plain' }), { path: '/' }),
    ).toBeNull()
    expect(collector.queued()).toBe(0)
  })

  it('posts a name the taxonomy does not hold rather than deciding for itself', () => {
    /*
     * The one assertion in this file about something the collector does NOT do.
     *
     * A browser that refused `cta_clicked` would be a second statement of the taxonomy shipped to a cache
     * (`attributes.ts`'s header carries the measurement that settled it), and it would hide the mistake
     * from the one place that reports it usefully: `/api/collect` answers `unknown_event` with the list.
     * What stops this markup ever existing is `scripts/check-event-attributes.mjs`, at build time — and
     * gate block 156 is where that is shown to fire.
     */
    const { collector } = collectorFor()
    const outcome = trackDeclaringElement(
      collector,
      new FakeElement({ [TRACK_EVENT_ATTRIBUTE]: 'cta_clicked' }),
      { path: '/' },
    )
    expect(outcome?.accepted).toBe(true)
    expect(collector.queued()).toBe(1)
  })
})

describe('declaredEventOf', () => {
  it('reads every payload attribute the element carries and nothing else', () => {
    const element = new FakeElement({
      [TRACK_EVENT_ATTRIBUTE]: 'service_viewed',
      [trackPayloadAttribute('style')]: 'asian',
      [trackPayloadAttribute('treatment')]: 'normal_massage',
      'data-testid': 'not ours',
      class: 'be-action',
    })
    expect(declaredEventOf(element, { path: '/pricing' })).toEqual({
      name: 'service_viewed',
      payload: { style: 'asian', treatment: 'normal_massage', path: '/pricing' },
    })
  })

  it('does not let an element override the path the page supplied', () => {
    // A component reused on two pages would otherwise report whichever page its author was looking at.
    // `data-berelax-path` is also refused at build time, so this is the second of two closures.
    const element = new FakeElement({
      [TRACK_EVENT_ATTRIBUTE]: 'cta_click',
      [trackPayloadAttribute('target')]: 'call',
      [trackPayloadAttribute('path')]: '/somewhere-else',
    })
    expect(declaredEventOf(element, { path: '/book' })?.payload).toEqual({
      target: 'call',
      path: '/book',
    })
  })

  it('answers null for an element that declares no event', () => {
    expect(declaredEventOf(new FakeElement({ class: 'plain' }), { path: '/' })).toBeNull()
  })
})

describe('attachDeclaredTracking', () => {
  it('installs one capture-phase listener and removes it on detach', () => {
    const { collector } = collectorFor()
    const root = new FakeRoot()
    const detach = attachDeclaredTracking({ root, collector, page: { path: '/book' } })
    expect(root.listeners).toHaveLength(1)
    // Capture phase, which is load-bearing: a `tel:` or `wa.me` anchor is about to navigate away, and a
    // handler on the way down runs before anything on the page can stop the event propagating.
    expect(root.captures).toBe(1)
    detach()
    expect(root.listeners).toHaveLength(0)
  })

  it('tracks a declared click, ignores an undeclared one, and stops when detached', () => {
    const { collector } = collectorFor()
    const root = new FakeRoot()
    const outcomes: TrackOutcome[] = []
    const detach = attachDeclaredTracking({
      root,
      collector,
      page: { path: '/book' },
      onOutcome: (outcome) => outcomes.push(outcome),
    })

    root.click(new FakeElement(cta('whatsapp')))
    expect(collector.queued()).toBe(1)
    // The control that stops the assertion above passing against a listener that tracks every click.
    root.click(new FakeElement({ class: 'plain' }))
    expect(collector.queued()).toBe(1)
    expect(outcomes).toHaveLength(1)

    detach()
    root.click(new FakeElement(cta('call')))
    expect(collector.queued()).toBe(1)
  })

  it('reports a refusal through onOutcome, which is the only way one is observable', () => {
    const { collector } = collectorFor()
    const root = new FakeRoot()
    const outcomes: TrackOutcome[] = []
    attachDeclaredTracking({
      root,
      collector,
      page: { path: '/book' },
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    const element = new FakeElement(cta('whatsapp'))
    root.click(element)
    root.click(element)
    expect(outcomes.map((outcome) => outcome.accepted)).toEqual([true, false])
    const second = outcomes[1]
    if (second?.accepted === false) expect(second.refusal).toBe('duplicate_interaction')
    expect(collector.queued()).toBe(1)
  })
})

describe('pageViewEvent', () => {
  it('builds the event through the taxonomys own validator', () => {
    expect(pageViewEvent({ path: '/pricing' }, true)).toEqual(
      parseAnalyticsEvent('page_view', { path: '/pricing', entry: true }),
    )
    expect(pageViewEvent({ path: '/pricing' }, false)).toEqual(
      parseAnalyticsEvent('page_view', { path: '/pricing', entry: false }),
    )
  })

  it('passes the path through verbatim, because the server is what refuses one', () => {
    /*
     * `pathSchema` forbids a query string — origination is resolved once per session, so `gclid` must not
     * ride every page view — and this function does NOT enforce that. It cannot: enforcing it means
     * importing the schema, which means `zod`, which `pnpm budgets` measured at 98,927 bytes in this
     * bundle. The path comes from the server that rendered the route and is asserted end to end in
     * `apps/web/e2e/collector.itest.ts`; a bad one is `/api/collect`'s `invalid_event_payload`.
     *
     * Asserted rather than left implicit, because "the browser does not validate" is a decision somebody
     * will otherwise read as an oversight and fix by importing the taxonomy.
     */
    expect(pageViewEvent({ path: '/book?gclid=abc' }, true).payload).toEqual({
      path: '/book?gclid=abc',
      entry: true,
    })
  })
})

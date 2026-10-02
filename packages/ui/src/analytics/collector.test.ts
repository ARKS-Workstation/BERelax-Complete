import {
  type AnalyticsEvent,
  COLLECT_MAX_BATCH_EVENTS,
  COLLECT_MAX_BODY_BYTES,
  COLLECT_PATH,
  collectBatchSchema,
  parseAnalyticsEvent,
} from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { INTERACTION_DEDUPE_MS } from './attributes.ts'
import {
  COLLECTOR_MAX_QUEUED_EVENTS,
  type Collector,
  type CollectorHost,
  createCollector,
} from './collector.ts'

/**
 * The collector, driven with a counter for a clock.
 *
 * Every claim in A-FIRST-06's acceptance that is not about a browser is here, and the reason they can be
 * is that `CollectorHost` is the module's whole contact with one: the 300 ms window, the batch split, the
 * offline queue and the stability of a client event id across a retry are decisions about arithmetic over
 * instants. `apps/web/e2e/collector.itest.ts` does the half that needs a real `sendBeacon`, a real
 * `visibilitychange` and a real double click, and it is deliberately the smaller file.
 *
 * ## The one assertion that makes the rest mean something
 *
 * Every body this file produces is parsed through `collectBatchSchema` — the server's own envelope. Without
 * it these tests would prove the collector is self-consistent, which is not the claim: the claim is that
 * what it posts is what `/api/collect` accepts, and an ISO instant in the wrong shape, a gap over the
 * envelope's ceiling or a client event id with a character outside its class are all invisible to an
 * assertion written against the collector's own output.
 */

interface Harness {
  readonly collector: Collector
  readonly bodies: string[]
  readonly advance: (ms: number) => void
  readonly setOnline: (value: boolean) => void
  readonly setAccepting: (value: boolean) => void
  readonly ids: () => readonly string[]
}

const START = 1_767_225_600_000

function harness(options: { readonly viewportWidth?: number | null } = {}): Harness {
  let now = START
  let issued = 0
  let online = true
  let accepting = true
  const bodies: string[] = []
  const host: CollectorHost = {
    now: () => now,
    // Deterministic and inside `collectEventSchema`'s URL-safe class, so a failure is about the collector
    // rather than about a random id.
    newEventId: () => {
      issued += 1
      return `fixture-event-${issued}`
    },
    // `'viewportWidth' in options` and NOT `options.viewportWidth ?? 412`: null is the value this harness
    // most needs to be able to express — "the client reported no viewport", which `breakpointFor` bands as
    // `unknown` — and `??` treats it as absent, so the fallback fired and the one case about a null
    // viewport asserted 412. Caught by that case on its first run; brief rule about `??` and `''`, one
    // type over.
    viewportWidth: () => ('viewportWidth' in options ? options.viewportWidth : 412) ?? null,
    query: () => null,
    referrer: () => null,
    online: () => online,
    send: (path, body) => {
      expect(path, 'the collector posts to exactly one path').toBe(COLLECT_PATH)
      if (!accepting) return false
      bodies.push(body)
      return true
    },
  }
  return {
    collector: createCollector(host),
    bodies,
    advance: (ms) => {
      now += ms
    },
    setOnline: (value) => {
      online = value
    },
    setAccepting: (value) => {
      accepting = value
    },
    ids: () =>
      bodies.flatMap((body) => {
        const parsed = collectBatchSchema.parse(JSON.parse(body))
        return parsed.events.map((event) => event.clientEventId)
      }),
  }
}

/** A `cta_click`, validated by the taxonomy exactly as the product's own path validates it. */
const ctaClick = (target: 'whatsapp' | 'call' | 'book', path = '/book'): AnalyticsEvent =>
  parseAnalyticsEvent('cta_click', { target, path })

const pageView = (path = '/book', entry = true): AnalyticsEvent =>
  parseAnalyticsEvent('page_view', { path, entry })

/** Parses every body the harness collected through the server's envelope and returns them. */
const envelopes = (bodies: readonly string[]) =>
  bodies.map((body) => collectBatchSchema.parse(JSON.parse(body)))

let rig: Harness

beforeEach(() => {
  rig = harness()
})

describe('what the collector posts', () => {
  it('posts a batch the servers own envelope accepts', () => {
    rig.collector.track(pageView())
    rig.advance(1_200)
    rig.collector.trackInteraction(ctaClick('whatsapp'), { id: 'cta' })
    const result = rig.collector.flush()

    expect(result).toEqual({ requests: 1, sent: 2, kept: 0, dropped: 0 })
    const [batch] = envelopes(rig.bodies)
    expect(batch).toBeDefined()
    if (batch === undefined) return
    expect(batch.events.map((event) => event.name)).toEqual(['page_view', 'cta_click'])
    expect(batch.interactionCount).toBe(1)
    // Gaps, never instants (A-FIRST-04). One event has no predecessor, so one gap for two events.
    expect(batch.interEventGapsMs).toEqual([1_200])
    expect(batch.viewportWidth).toBe(412)
  })

  it('stamps each event with the clients own instant, in the shape the envelope validates', () => {
    rig.collector.track(pageView())
    rig.collector.flush()
    const [batch] = envelopes(rig.bodies)
    expect(batch).toBeDefined()
    if (batch === undefined) return
    const [event] = batch.events
    expect(event).toBeDefined()
    if (event === undefined) return
    expect(event.occurredAt).toBe(new Date(START).toISOString())

    // The control, and it is not a formality: `envelopes` is what makes every assertion in this file a
    // claim about what the SERVER accepts, so a parse that had stopped refusing anything would make the
    // whole file self-referential. Milliseconds since the epoch as a string is the obvious wrong shape,
    // and `z.iso.datetime({ offset: true })` must refuse it.
    expect(() =>
      collectBatchSchema.parse({
        ...batch,
        events: [{ ...event, occurredAt: String(START) }],
      }),
    ).toThrow()
  })

  it('reports a null viewport rather than a zero, which the envelope refuses', () => {
    const narrow = harness({ viewportWidth: null })
    narrow.collector.track(pageView())
    narrow.collector.flush()
    expect(envelopes(narrow.bodies)[0]?.viewportWidth).toBeNull()
  })
})

describe('the double-fire window', () => {
  it('takes one event for a second fire inside the window and two for one outside it', () => {
    /*
     * The window has to be wide enough for "inside it" to mean something, and that is asserted rather than
     * assumed. `advance(INTERACTION_DEDUPE_MS - 1)` is this case's idea of "inside"; with the constant at 0
     * it moves the clock BACKWARD by a millisecond, which a `<` comparison still treats as inside — so a
     * window of zero passed this case and was caught by a different one. Gate case 156l found it.
     */
    expect(INTERACTION_DEDUPE_MS).toBeGreaterThan(1)
    const control = { id: 'call' }
    expect(rig.collector.trackInteraction(ctaClick('call'), control).accepted).toBe(true)
    rig.advance(INTERACTION_DEDUPE_MS - 1)
    const second = rig.collector.trackInteraction(ctaClick('call'), control)
    expect(second.accepted).toBe(false)
    if (second.accepted) return
    expect(second.refusal).toBe('duplicate_interaction')
    expect(rig.collector.queued()).toBe(1)

    // One millisecond past the window is a second interaction. Both halves are asserted, because a dedupe
    // that never expires is indistinguishable from one that works until a reader clicks twice on purpose.
    rig.advance(2)
    expect(rig.collector.trackInteraction(ctaClick('call'), control).accepted).toBe(true)
    expect(rig.collector.queued()).toBe(2)
    expect(rig.collector.interactions()).toBe(2)
  })

  it('treats two controls carrying the same payload as two interactions', () => {
    // The window is a window on ONE control. Two calls to action with the same target is the ordinary case
    // — a header button and a sticky bar — and a reader who uses one and then the other has done two
    // things. Keying the dedupe on the payload alone would silently drop the second.
    expect(rig.collector.trackInteraction(ctaClick('book'), { id: 'header' }).accepted).toBe(true)
    rig.advance(10)
    expect(rig.collector.trackInteraction(ctaClick('book'), { id: 'sticky' }).accepted).toBe(true)
    expect(rig.collector.queued()).toBe(2)
  })

  it('treats a different payload on the same control as a second interaction', () => {
    const control = { id: 'one-button' }
    expect(rig.collector.trackInteraction(ctaClick('call'), control).accepted).toBe(true)
    rig.advance(10)
    expect(rig.collector.trackInteraction(ctaClick('whatsapp'), control).accepted).toBe(true)
    expect(rig.collector.queued()).toBe(2)
  })

  it('does not count or remember a refused interaction', () => {
    const control = { id: 'call' }
    rig.collector.trackInteraction(ctaClick('call'), control)
    rig.advance(1)
    rig.collector.trackInteraction(ctaClick('call'), control)
    // One queued, one counted. A refused fire that still moved the window would push the window forward on
    // every repeat, so a control held down would be refused for ever.
    expect(rig.collector.interactions()).toBe(1)
    rig.advance(INTERACTION_DEDUPE_MS)
    expect(rig.collector.trackInteraction(ctaClick('call'), control).accepted).toBe(true)
  })

  it('applies no window to an event that is not an interaction', () => {
    // `track` is the imperative door — A-FIRST-07's `whatsapp_ref_shown` is not a click — and two of them
    // in the same millisecond are two facts. A shared window would silently drop the second.
    expect(rig.collector.track(pageView('/book', true)).accepted).toBe(true)
    expect(rig.collector.track(pageView('/book', false)).accepted).toBe(true)
    expect(rig.collector.queued()).toBe(2)
  })
})

describe('the offline queue', () => {
  it('sends nothing while offline, keeps the queue, and flushes it once with no duplication', () => {
    rig.setOnline(false)
    rig.collector.track(pageView())
    rig.advance(50)
    rig.collector.trackInteraction(ctaClick('whatsapp'), { id: 'a' })
    rig.advance(50)
    rig.collector.trackInteraction(ctaClick('call'), { id: 'b' })

    const offline = rig.collector.flush()
    expect(offline).toEqual({ requests: 0, sent: 0, kept: 3, dropped: 0 })
    expect(rig.bodies).toEqual([])

    rig.setOnline(true)
    const online = rig.collector.flush()
    expect(online).toEqual({ requests: 1, sent: 3, kept: 0, dropped: 0 })
    const ids = rig.ids()
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size, 'every client event id is distinct').toBe(3)

    // And the second flush sends nothing. This is the no-duplication half: a queue that cleared on the
    // ATTEMPT rather than on the acceptance would be empty here too, so the assertion that matters is the
    // one above it — three ids, each once, in one request.
    expect(rig.collector.flush()).toEqual({ requests: 0, sent: 0, kept: 0, dropped: 0 })
    expect(rig.bodies).toHaveLength(1)
  })

  it('keeps the same client event ids across a refused send, so a retry cannot duplicate', () => {
    rig.collector.track(pageView())
    rig.collector.trackInteraction(ctaClick('book'), { id: 'a' })
    rig.setAccepting(false)
    expect(rig.collector.flush()).toEqual({ requests: 0, sent: 0, kept: 2, dropped: 0 })

    rig.setAccepting(true)
    expect(rig.collector.flush().sent).toBe(2)
    const ids = rig.ids()
    // The ids are the FIRST two the host issued, not a fresh pair: `/api/collect` holds a unique index on
    // them, so a retry is idempotent only if the id survives the failure. Re-minting them would inflate
    // every funnel figure by however many retries happened, with nothing anywhere saying so.
    expect(ids).toEqual(['fixture-event-1', 'fixture-event-2'])
  })
})

describe('the caps, which are the servers and not the collectors', () => {
  it('refuses the newest event when the queue is full, and keeps the landing at the front', () => {
    rig.setOnline(false)
    rig.collector.track(pageView('/book', true))
    for (let index = 1; index < COLLECTOR_MAX_QUEUED_EVENTS; index += 1) {
      rig.advance(INTERACTION_DEDUPE_MS)
      expect(rig.collector.trackInteraction(ctaClick('book'), { id: index }).accepted).toBe(true)
    }
    expect(rig.collector.queued()).toBe(COLLECTOR_MAX_QUEUED_EVENTS)

    rig.advance(INTERACTION_DEDUPE_MS)
    const refused = rig.collector.trackInteraction(ctaClick('call'), { id: 'last' })
    expect(refused.accepted).toBe(false)
    if (refused.accepted) return
    expect(refused.refusal).toBe('queue_full')

    // The oldest event survived, and it is the entry page view — the `landing` stage, which is the
    // denominator every conversion rate divides by. A ring buffer would have evicted exactly this row.
    rig.setOnline(true)
    rig.collector.flush()
    const first = envelopes(rig.bodies)[0]?.events[0]
    expect(first?.name).toBe('page_view')
    expect(first?.clientEventId).toBe('fixture-event-1')
  })

  it('derives the queue ceiling from the servers batch cap rather than choosing one', () => {
    expect(COLLECTOR_MAX_QUEUED_EVENTS).toBe(COLLECT_MAX_BATCH_EVENTS)
  })

  it('splits a batch the server would refuse for its SIZE into requests it will read', () => {
    // A long path is the only way a validated event gets large, and `pathSchema` allows 2048 characters.
    // Fifty of those is about 115KB against a 64KB body cap, so a collector that split only by COUNT
    // would post a body refused as `body_too_large` — losing the whole batch, which is the failure
    // A-FIRST-05's header warns about in those words.
    const longPath = `/${'a'.repeat(2_000)}`
    rig.setOnline(false)
    for (let index = 0; index < COLLECTOR_MAX_QUEUED_EVENTS; index += 1) {
      rig.advance(INTERACTION_DEDUPE_MS)
      rig.collector.trackInteraction(ctaClick('book', longPath), { id: index })
    }
    rig.setOnline(true)
    const result = rig.collector.flush()

    expect(result.sent).toBe(COLLECTOR_MAX_QUEUED_EVENTS)
    expect(result.kept).toBe(0)
    expect(result.dropped).toBe(0)
    expect(result.requests, 'one request could not have carried this').toBeGreaterThan(1)
    for (const body of rig.bodies) {
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(COLLECT_MAX_BODY_BYTES)
      // Every request is a valid batch on its own, which is what the server reads them as.
      expect(() => collectBatchSchema.parse(JSON.parse(body))).not.toThrow()
    }
    const ids = rig.ids()
    expect(new Set(ids).size).toBe(COLLECTOR_MAX_QUEUED_EVENTS)
  })

  it('drops one event that cannot be split further rather than spinning on it', () => {
    /*
     * A state no validated event can reach, and the guard that stops the halving looping for ever.
     *
     * `parseAnalyticsEvent` bounds a path at 2048 characters, so the largest real event is about 2.2KB
     * against a 64KB cap — which is why this is NOT a named refusal (see `TRACK_REFUSALS`) and why the
     * event here is FORGED past the validator with a cast. Without this case the branch would be a line
     * nothing has ever executed, which is the shape of every guard that turns out not to work.
     */
    const forged = {
      name: 'page_view',
      payload: { path: `/${'a'.repeat(COLLECT_MAX_BODY_BYTES * 2)}`, entry: true },
    } as AnalyticsEvent
    rig.collector.track(forged)
    rig.collector.track(pageView())
    const result = rig.collector.flush()
    expect(result.dropped).toBe(1)
    expect(result.sent).toBe(1)
    expect(result.kept).toBe(0)
    expect(envelopes(rig.bodies)[0]?.events).toHaveLength(1)
  })

  it('does nothing and says so when there is nothing queued', () => {
    expect(rig.collector.flush()).toEqual({ requests: 0, sent: 0, kept: 0, dropped: 0 })
    expect(rig.bodies).toEqual([])
  })
})

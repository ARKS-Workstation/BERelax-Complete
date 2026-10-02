/**
 * The browser collector (A-FIRST-06): one small typed SDK, no third-party script, and NOT a second opinion
 * about anything the server already decides.
 *
 * ## What this file deliberately does not contain
 *
 * Three facts belong to the server and not one of them is restated here, because a second statement of any
 * of them would be the statement that drifts — and all three drift silently:
 *
 *   - **The taxonomy.** Membership is `parseAnalyticsEvent` behind `/api/collect` (A-FIRST-02), which
 *     refuses an unknown name BY NAME with the list. There is no list of event names in this package and
 *     nothing here asks whether one is valid: a browser-side copy is worse than an ordinary duplicate
 *     because it ships to a cache, so the stale copy would be the one deployed for as long as a visitor's
 *     bundle lived. What stops a mis-declared tag existing at all is
 *     `scripts/check-event-attributes.mjs`, at BUILD time, where reading the real Zod schemas is free —
 *     and `attributes.ts`'s header carries the measurement that settled the argument.
 *   - **The caps.** `COLLECT_MAX_BATCH_EVENTS` and `COLLECT_MAX_BODY_BYTES` are A-FIRST-05's figures, read
 *     from `analytics/collect-limits.ts`, whose header says why it exists at all:
 *     *"a cap the collector does not know about is a cap that silently drops a browser's whole batch"*,
 *     and a cap imported from the module that validates brings the validator with it.
 *     {@link COLLECTOR_MAX_QUEUED_EVENTS} is derived from the first of them rather than chosen.
 *   - **The consent decision.** There is none here. `/api/collect` reads the consent cookie
 *     (`analyticsStorageGranted`) and answers 204 either way, because a browser cannot act on the
 *     difference; a collector that read the cookie and decided for itself would be a second gate that
 *     disagrees with the first exactly when a banner has just been answered. So this posts, and the server
 *     decides what the post becomes. ADR 0066 is why that projection is irreversible, and ADR 0078 §"the
 *     collector decides nothing" is this half of it.
 *
 * ## Why every effect is injected
 *
 * {@link CollectorHost} is the whole of this module's contact with a browser: the clock, the id, the
 * viewport, the referrer, the online flag and the send. That is what makes the three claims in this unit's
 * acceptance testable without a browser at all — the 300 ms dedupe, the batch split and the offline
 * queue are decisions about arithmetic over instants, and `collector.test.ts` drives them with a counter
 * for a clock. The browser host is twelve lines in `collector.island.tsx`, where it belongs.
 *
 * ## The one thing a collector gets wrong that nothing notices
 *
 * Duplication. A flush that cannot tell whether the server received a batch has two wrong answers, and
 * "drop it" and "send it again with new ids" are both wrong — the first loses events and the second inflates
 * every funnel figure by however many retries happened. So a {@link QueuedEvent} is given its
 * `clientEventId` when it is ENQUEUED and keeps it through every retry, and `/api/collect` holds a unique
 * index on it. Re-sending is then free and idempotent, which is what lets this keep the queue on a failed
 * send instead of guessing.
 */
import type { AnalyticsEvent, CollectBatch } from '@berelax/shared'
/*
 * The limits, from the one module in `@berelax/shared` that imports NOTHING.
 *
 * Not from the package barrel and not from `analytics/collect.ts`, and the reason is a number: both reach
 * `zod`, so importing a cap from either put 98,927 bytes gzipped into the client bundle against a
 * 3,072-byte budget. `collect-limits.ts` carries the argument, and the figures are still stated exactly
 * once — `collect.ts` re-exports them, so no other consumer in the build changed.
 *
 * The two TYPE imports above are erased (`verbatimModuleSyntax` makes `import type` explicit), so naming
 * the barrel there costs nothing at runtime and keeps the envelope this module fills a type the SERVER
 * owns.
 */
import {
  COLLECT_MAX_BATCH_EVENTS,
  COLLECT_MAX_BODY_BYTES,
  COLLECT_PATH,
} from '@berelax/shared/analytics/collect-limits'
import { INTERACTION_DEDUPE_MS, type TrackRefusal } from './attributes.ts'

/**
 * The largest number of events the collector will hold while it cannot send.
 *
 * `COLLECT_MAX_BATCH_EVENTS` — one batch — and the figure is DERIVED rather than chosen: the queue exists
 * to survive the window between an interaction and the next flush, and anything the server will not read in
 * one request is not a queue, it is a backlog with no reader.
 *
 * ## Why the NEWEST event is refused rather than the oldest evicted
 *
 * A ring buffer is the obvious implementation and it is wrong here in a way that is invisible in the data.
 * The oldest event in any queue is the `page_view` that carries `entry: true`, which is the `landing` stage
 * — the denominator every conversion rate on the analytics page divides by. Evicting it turns an
 * over-active page into a page with conversions and no landings, which reads as a rate above 100% or, after
 * a chart clamps it, as a very good day. Refusing the newest loses a click and says so by name.
 */
export const COLLECTOR_MAX_QUEUED_EVENTS = COLLECT_MAX_BATCH_EVENTS

/**
 * The largest inter-event gap the envelope accepts, in milliseconds.
 *
 * A second statement of `collectBatchSchema`'s own `.max(86_400_000)` and it arrives with the reason it has
 * to be one: the schema is the server's refusal and this is the CLAMP that stops a tab left open over a
 * weekend producing a gap the envelope rejects — at which point the whole batch is refused as
 * `invalid_envelope` and every event in it is lost for a signal nothing reads at that resolution.
 * `collector.test.ts` holds the two equal by parsing a clamped body through `collectBatchSchema`, which is
 * the check this duplicate comes with.
 */
const MAX_GAP_MS = 86_400_000

/** Everything this module does to a browser, as functions somebody else supplies. */
export interface CollectorHost {
  /** Milliseconds since the epoch. The only clock. */
  readonly now: () => number
  /**
   * A fresh idempotency key, URL-safe and at most 64 characters — `collectEventSchema`'s own bound.
   *
   * The browser host uses `crypto.randomUUID()`, whose hyphens are inside the envelope's character class.
   */
  readonly newEventId: () => string
  /** The layout viewport width in CSS pixels, or null when there is none to report. */
  readonly viewportWidth: () => number | null
  /** The landing URL's query string, or null. */
  readonly query: () => string | null
  /** The referrer as the page saw it, or null. */
  readonly referrer: () => string | null
  /**
   * Whether the browser believes it has a network.
   *
   * Asked BEFORE every send, and that is the whole of the offline acceptance line. `navigator.sendBeacon`
   * returns `true` while offline — it accepts the payload into its own queue and the browser decides later
   * what to do with it — so a collector that treated its answer as delivery would drop every event produced
   * during an outage, and the symptom would be a funnel that was quietly short on bad-network days.
   */
  readonly online: () => boolean
  /**
   * Posts one batch and says whether the browser accepted it for delivery.
   *
   * Synchronous and boolean, because the flush that matters runs while the page is being unloaded: there is
   * no later turn of the event loop to resolve a promise in. `false` keeps every event in the queue.
   */
  readonly send: (path: string, body: string) => boolean
}

/** One event waiting to be sent, with the id it will keep through every retry. */
interface QueuedEvent {
  readonly clientEventId: string
  readonly name: string
  readonly payload: unknown
  /** ISO 8601 with an offset — `collectEventSchema` validates the shape and never parses it. */
  readonly occurredAt: string
  /** The host clock's reading at enqueue. Never sent; the envelope carries gaps, not instants. */
  readonly at: number
  /**
   * Milliseconds since the previous event of this page, or null for the first one.
   *
   * Computed at ENQUEUE rather than at flush, and that is the whole reason this field exists. The envelope
   * carries gaps and never instants (A-FIRST-04), so a gap computed inside one batch has no value for the
   * first event of it — and threading the previous batch's last instant through the flush was the first
   * implementation and dropped exactly one gap per batch boundary, which makes a page that flushes often
   * look like a page with fewer interactions than it had. A gap recorded when it happens cannot be lost by
   * however the queue is later sliced.
   */
  readonly gapMs: number | null
}

/** What happened to one `track` call. */
export type TrackOutcome =
  | { readonly accepted: true; readonly clientEventId: string }
  | { readonly accepted: false; readonly refusal: TrackRefusal; readonly detail: string }

/** What one flush did. */
export interface FlushResult {
  /** How many requests were posted. Zero when there was nothing to send or no network to send it on. */
  readonly requests: number
  /** How many events were accepted for delivery and removed from the queue. */
  readonly sent: number
  /** How many are still queued, which is what the next flush will retry. */
  readonly kept: number
  /** Events dropped because one event's own JSON exceeds the body cap. See `fittingSlice`. */
  readonly dropped: number
}

/**
 * One event on its way to the queue: a name and whatever payload its declaration produced.
 *
 * Looser than {@link AnalyticsEvent} on purpose, and only the declarative door takes it. An attribute's
 * value is a `string` the markup carried, and what makes it a valid payload is
 * `scripts/check-event-attributes.mjs` at build time and `parseAnalyticsEvent` at the server — not a cast
 * here, and not a second validator in the browser.
 */
export interface CollectedEvent {
  readonly name: string
  readonly payload: unknown
}

export interface Collector {
  /**
   * Queues one already-validated event.
   *
   * Takes an {@link AnalyticsEvent} — the discriminated union `parseAnalyticsEvent` returns — so a name the
   * taxonomy does not hold cannot reach the queue through THIS door, which is the imperative one
   * (A-FIRST-07's ref code). The type is erased at build, so the guarantee costs no bytes.
   */
  readonly track: (event: AnalyticsEvent) => TrackOutcome
  /**
   * Queues one event that came from a user interaction, applying the double-fire window.
   *
   * `source` identifies the thing that was interacted with. Two interactions are the same fire when the
   * event, its payload AND the source all match inside {@link INTERACTION_DEDUPE_MS} — the source is part
   * of the key because two different calls to action may carry the same payload, and a reader who clicks
   * one and then the other is doing two things.
   */
  readonly trackInteraction: (event: CollectedEvent, source: object) => TrackOutcome
  /** Sends what is queued, in batches the server will read. Safe to call when the queue is empty. */
  readonly flush: () => FlushResult
  /** How many events are waiting. For a test and for a debugger; nothing in the product reads it. */
  readonly queued: () => number
  /** How many interactions this page has produced. The envelope's `interactionCount`. */
  readonly interactions: () => number
}

/** The JSON size of a value, in bytes, as the server will measure the body. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length

export function createCollector(host: CollectorHost): Collector {
  const queue: QueuedEvent[] = []
  /** The instant of the last event enqueued, for the gap to the next one. Survives a flush. */
  let previousEventAt: number | null = null
  let interactionCount = 0
  let lastInteraction: {
    readonly source: object
    readonly key: string
    readonly at: number
  } | null = null

  const enqueue = (event: CollectedEvent): TrackOutcome => {
    if (queue.length >= COLLECTOR_MAX_QUEUED_EVENTS) {
      return {
        accepted: false,
        refusal: 'queue_full',
        detail: `${COLLECTOR_MAX_QUEUED_EVENTS} events are already waiting to be sent`,
      }
    }
    const at = host.now()
    const clientEventId = host.newEventId()
    queue.push({
      clientEventId,
      name: event.name,
      payload: event.payload,
      occurredAt: new Date(at).toISOString(),
      at,
      gapMs:
        previousEventAt === null ? null : Math.min(Math.max(at - previousEventAt, 0), MAX_GAP_MS),
    })
    previousEventAt = at
    return { accepted: true, clientEventId }
  }

  const track = (event: AnalyticsEvent): TrackOutcome => enqueue(event)

  const trackInteraction = (event: CollectedEvent, source: object): TrackOutcome => {
    const key = `${event.name}\u0000${JSON.stringify(event.payload)}`
    const at = host.now()
    if (
      lastInteraction !== null &&
      lastInteraction.source === source &&
      lastInteraction.key === key &&
      at - lastInteraction.at < INTERACTION_DEDUPE_MS
    ) {
      return {
        accepted: false,
        refusal: 'duplicate_interaction',
        detail: `${event.name} fired again ${at - lastInteraction.at}ms after the same interaction`,
      }
    }
    const outcome = enqueue(event)
    if (!outcome.accepted) return outcome
    // Counted and remembered only for an interaction that was actually queued. A refused one is not an
    // interaction the server was told about, and counting it would make `interactionCount` disagree with
    // the number of events the row set holds — the one figure A-FIRST-04's heuristic reads it beside.
    lastInteraction = { source, key, at }
    interactionCount += 1
    return outcome
  }

  /** The envelope round a slice of the queue. Every gap was computed when its event was enqueued. */
  const envelopeFor = (events: readonly QueuedEvent[]): CollectBatch => {
    const gaps: number[] = []
    for (const event of events) if (event.gapMs !== null) gaps.push(event.gapMs)
    return {
      viewportWidth: host.viewportWidth(),
      interactionCount,
      interEventGapsMs: gaps,
      query: host.query(),
      referrer: host.referrer(),
      events: events.map((event) => ({
        name: event.name,
        occurredAt: event.occurredAt,
        clientEventId: event.clientEventId,
        payload: event.payload,
      })),
    }
  }

  /**
   * The largest leading slice of the queue whose serialised body the server will read.
   *
   * Halved rather than measured per event, because the envelope's fixed cost is not divisible between its
   * events and a per-event estimate would be an estimate.
   *
   * ## Why the byte split is reachable and the single-event drop is not
   *
   * The count cap alone is not enough, and the arithmetic says so: the largest validated event is a
   * 2048-character path plus its own envelope fields, about 2.2KB, so fifty of them are roughly 115KB
   * against a 64KB body cap. A collector that split only by count would therefore post a body
   * `/api/collect` refuses as `body_too_large` — losing the whole batch, which is the failure A-FIRST-05's
   * header warns about in exactly these words.
   *
   * A slice of ONE that still does not fit cannot happen through `parseAnalyticsEvent`, by the same
   * arithmetic. The branch exists so the halving terminates rather than spins, it drops that one event and
   * counts it in {@link FlushResult.dropped}, and it is NOT a named refusal for the reason
   * `TRACK_REFUSALS` records: a refusal nothing can raise is worse than no refusal.
   */
  const fittingSlice = (): { readonly count: number; readonly body: string } | null => {
    let count = Math.min(queue.length, COLLECT_MAX_BATCH_EVENTS)
    for (;;) {
      if (count === 0) return null
      const body = JSON.stringify(envelopeFor(queue.slice(0, count)))
      if (byteLength(body) <= COLLECT_MAX_BODY_BYTES) return { count, body }
      if (count === 1) return null
      count = Math.floor(count / 2)
    }
  }

  const flush = (): FlushResult => {
    let requests = 0
    let sent = 0
    let dropped = 0
    while (queue.length > 0) {
      if (!host.online()) break
      const slice = fittingSlice()
      if (slice === null) {
        // One event, too large on its own. Drop exactly that one and carry on.
        queue.shift()
        dropped += 1
        continue
      }
      if (!host.send(COLLECT_PATH, slice.body)) break
      requests += 1
      sent += slice.count
      queue.splice(0, slice.count)
    }
    return { requests, sent, kept: queue.length, dropped }
  }

  return {
    track,
    trackInteraction,
    flush,
    queued: () => queue.length,
    interactions: () => interactionCount,
  }
}

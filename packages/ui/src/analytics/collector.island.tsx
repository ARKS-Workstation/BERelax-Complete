'use client'

/**
 * The one client boundary the collector has: the browser host, the delegated listener, and when the network
 * is allowed to be touched.
 *
 * ## What is deferred, and what is not
 *
 * The listener is attached immediately. It costs nothing — one capture-phase handler on the document — and
 * deferring it would drop the clicks of a reader who is faster than `load`, which on a booking page is the
 * reader who already knew what they wanted.
 *
 * The NETWORK is deferred to the `load` event. That is the acceptance line *"does not appear in the LCP
 * critical request chain"* made true by construction rather than by configuration: until `load` there is no
 * request to be in any chain. The exception is the page being torn down — on `pagehide`, or on the tab
 * becoming hidden — where the flush happens whether or not `load` has fired, because at that point there is
 * no largest contentful paint left to protect and the alternative is losing the page view of every visitor
 * who left early, which is exactly the bounce the funnel's first stage exists to count.
 *
 * ## Why the path is a PROP and not `usePathname`
 *
 * It was `usePathname` first, and `pnpm budgets` refused it with a number: a module that imports
 * `next/navigation` is bundled into Turbopack's framework chunk, so the chunk that DEFINES this island
 * became the 414KB one every route already loads and the collector's own weight measured 96.6KB against a
 * 3KB budget. A budget that cannot see the thing it is about is not a budget, and the acceptance line asks
 * for a number.
 *
 * Reading `location.pathname` in the effect was the other alternative and is worse than it looks: on an App
 * Router navigation the URL is updated by `history.pushState` around the render, so an effect that read it
 * would be reading a value whose timing nothing in this file controls — and a page view filed under the
 * PREVIOUS path is a wrong figure rather than a missing one.
 *
 * So the server that rendered the route states its path, which it knows exactly. An App Router navigation
 * unmounts the page subtree and mounts the next one, so a route that renders this island gets a fresh mount
 * with its own path — which is why the island belongs to the PAGE and never to a shared layout. That it is
 * the right path is not left to a reviewer: `apps/web/e2e/collector.itest.ts` asserts the `page_view`'s
 * path against the route it navigated to, for `/book` and for the fixture route.
 *
 * ## Why `sendBeacon` and why `navigator.onLine` is consulted first
 *
 * `sendBeacon` is the only post that survives the document being unloaded, which is the flush that carries
 * the landing event. It returns `true` while the browser is OFFLINE — it has accepted the payload into its
 * own queue, which is not the same as having delivered it — so the collector asks `navigator.onLine` before
 * every send and keeps the queue when the answer is no. Without that, an outage is a funnel that is quietly
 * short rather than a queue that flushes when the network returns.
 */
import type { AnalyticsEvent } from '@berelax/shared'
/*
 * The limits from the zod-free module, never from the package barrel.
 *
 * `attributes.ts`'s header carries the measurement that settled it and `collect-limits.ts` carries the
 * argument. Note the shape of the import above as well: `import type { X }` on its own line, and NOT
 * `import { type X, Y }` from the barrel. The second form is what this file had, and under
 * `verbatimModuleSyntax` it compiles to a bare `import '@berelax/shared'` — a SIDE-EFFECT import, which
 * keeps the whole package (and `zod`) in the chunk even though nothing in it is used at runtime. The budget
 * measured 98,455 bytes against 3,072 and nothing else in the build noticed; `pnpm typecheck` is perfectly
 * happy with either spelling.
 */
import { COLLECT_MAX_BATCH_EVENTS, COLLECT_PATH } from '@berelax/shared/analytics/collect-limits'
import { useEffect } from 'react'
import {
  type Collector,
  type CollectorHost,
  createCollector,
  type TrackOutcome,
} from './collector.ts'
import { attachDeclaredTracking, pageViewEvent } from './use-track.ts'

/**
 * The browser host: every effect the collector has, in one place.
 *
 * Built lazily rather than at module scope, because this module is evaluated during the server rendering of
 * the route that renders the island — `'use client'` marks a boundary, not a browser — and `navigator` does
 * not exist there.
 */
function browserHost(): CollectorHost {
  return {
    now: () => Date.now(),
    // `randomUUID` because its hyphens are inside `collectEventSchema`'s URL-safe character class and its
    // 36 characters are inside the 64-character bound, so the id needs no encoding step of its own. It is
    // available on every browser that has `sendBeacon`, over a secure context — which is every context this
    // application is served in, `Secure` being unconditional on its own cookies.
    newEventId: () => crypto.randomUUID(),
    // `innerWidth` is the LAYOUT viewport in CSS pixels, which is what `breakpointFor` and `deviceKindFor`
    // band. `screen.width` is the device and would report a phone held in landscape as a desktop.
    viewportWidth: () => (window.innerWidth > 0 ? window.innerWidth : null),
    query: () => (window.location.search === '' ? null : window.location.search),
    referrer: () => (document.referrer === '' ? null : document.referrer),
    online: () => navigator.onLine,
    send: (path, body) => {
      // A `Blob` with an explicit type rather than a bare string: a string beacon is sent as
      // `text/plain;charset=UTF-8`, and the route's own refusals are easier to read when the request says
      // what it is. Same-origin, so there is no preflight to earn.
      const blob = new Blob([body], { type: 'application/json' })
      if (typeof navigator.sendBeacon === 'function') return navigator.sendBeacon(path, blob)
      // The fallback is `keepalive`, which is the only other post that outlives the document. Fire and
      // forget: the queue has already been cleared on a `true`, and the idempotency key on every event is
      // what makes a retry after a failure safe rather than a duplicate.
      void fetch(path, { method: 'POST', body: blob, keepalive: true }).catch(() => undefined)
      return true
    },
  }
}

/**
 * One collector per document, created on first use.
 *
 * Module scope and not a React ref, because the queue has to survive a navigation: the island unmounts and
 * remounts as the App Router replaces the page, and a per-component collector would throw away everything
 * queued since the last flush every time a reader moved between pages. The one thing it must NOT survive is
 * a new document, and it does not — the module is evaluated again.
 */
let collector: Collector | undefined
let networkOpen = false
let entryRecorded = false

function sharedCollector(): Collector {
  collector ??= createCollector(browserHost())
  return collector
}

/**
 * Posts what is queued, unless the network is still closed.
 *
 * `force` is the teardown's, and it is the one caller allowed to post before `load`.
 */
function flush(force: boolean): void {
  if (!networkOpen && !force) return
  networkOpen = true
  sharedCollector().flush()
}

/**
 * Queues one event from a caller that is not a declared element.
 *
 * The imperative door, for the events that are not interactions: A-FIRST-07's `whatsapp_ref_shown` fires
 * when a ref code is rendered, not when something is clicked, so there is no element to declare it on. It
 * takes an {@link AnalyticsEvent} — the union `parseAnalyticsEvent` returns — so this door cannot be used
 * to post a name the taxonomy does not hold.
 */
export function trackCollectorEvent(event: AnalyticsEvent): TrackOutcome {
  return sharedCollector().track(event)
}

/**
 * Posts what is queued, now, whether or not `load` has fired.
 *
 * Added by A-MEAS-04, which needs it for a reason that could not be solved by listener order. The web
 * vitals are not final until the page is being hidden — a later, larger element replaces the LCP, and INP
 * is a percentile over interactions that have not happened yet — so they are tracked inside a
 * `visibilitychange` handler. This island registers its own flush on the same event when it mounts, and
 * it mounts first, so by the time the vitals are queued this document's flush for that event has already
 * run. Relying on the `pagehide` flush that follows works in every browser that fires both and loses the
 * batch in one that fires only `pagehide`.
 *
 * `force` is already the contract for "the page is going away" — see {@link flush} — so this exposes the
 * existing one rather than adding a second flush with its own rules.
 */
export function flushCollector(): void {
  flush(true)
}

export interface CollectorIslandProps {
  /**
   * The path of the route rendering this island, as the router resolves it — `/book`, `/ar/book`.
   *
   * Site-relative, no query and no fragment, which is `pathSchema`'s own rule: origination is resolved once
   * per session by A-FIRST-03, so a query string on every page view would be a second copy of `gclid` with
   * a shorter retention and no reader. `pageViewEvent` validates it through the taxonomy, so a path that
   * breaks the rule throws here rather than being refused at `/api/collect`.
   */
  readonly path: string
}

/**
 * Mounts the collector. Renders nothing.
 *
 * An island that rendered markup could not be deferred without taking content out of the server-rendered
 * HTML (ADR 0013), and there is nothing to render: the tracked elements are the page's own, server-rendered,
 * and they are tracked because of an attribute rather than because of a component.
 */
export default function CollectorIsland({ path }: CollectorIslandProps): null {
  // Once per document: the flush triggers, and the moment the network opens.
  useEffect(() => {
    const onHidden = (): void => {
      // The state and not the event: a `visibilitychange` back to VISIBLE is a tab returning, which is not
      // a flush.
      if (document.visibilityState === 'hidden') flush(true)
    }
    const onPageHide = (): void => {
      flush(true)
    }
    const onOnline = (): void => {
      flush(false)
    }
    const onLoad = (): void => {
      flush(true)
    }
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('online', onOnline)
    if (document.readyState === 'complete') onLoad()
    else window.addEventListener('load', onLoad, { once: true })
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('load', onLoad)
    }
  }, [])

  // Per page: the delegated listener, carrying this page's path, and this page's view.
  useEffect(() => {
    const active = sharedCollector()
    const page = { path }
    const detach = attachDeclaredTracking({
      root: document,
      collector: active,
      page,
      onOutcome: () => {
        // A full queue refuses the NEWEST event by name, so a page that produces more than one batch
        // between flushes has to flush when it fills. `COLLECT_MAX_BATCH_EVENTS` is the server's cap and
        // the queue's ceiling both, read from `@berelax/shared` so there is no second number here.
        if (active.queued() >= COLLECT_MAX_BATCH_EVENTS) flush(false)
      },
    })
    const entry = !entryRecorded
    entryRecorded = true
    active.track(pageViewEvent(page, entry))
    // The page view of the document the reader entered on is flushed as soon as the network opens; a later
    // one rides the next flush. `flush` is a no-op until `load`, so this line cannot put a request in front
    // of the largest contentful paint.
    flush(false)
    return detach
  }, [path])

  return null
}

/** The path the collector posts to, re-exported so a consumer can name it without a literal. */
export const COLLECTOR_PATH = COLLECT_PATH

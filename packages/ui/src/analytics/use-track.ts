/**
 * Declarative interaction tracking: one delegated listener, and the walk from a click to the element that
 * declared what it means.
 *
 * ## Why one listener and not one handler per call to action
 *
 * A handler per element is a client component per element. The site is server-rendered almost everywhere —
 * docs/09 §3 makes the booking flow *"the one heavy client island"* — so attaching tracking that way would
 * turn every tracked button into a boundary and put the collector in the import graph of every page that
 * has one. One listener in the CAPTURE phase on the document reaches every element that will ever exist,
 * including markup a CMS publishes and anything W-SITE renders later, with no component anywhere knowing
 * that it is tracked. The element declares; the listener reads.
 *
 * Capture phase and not bubble, for one reason: a `tel:` or a `wa.me` anchor is about to navigate away, and
 * a handler on the way DOWN runs before anything the page itself does with the event — including a
 * `stopPropagation` in an unrelated component, which would otherwise make a tracked element silently stop
 * being tracked with no change to its own markup.
 *
 * ## What it does NOT do: validate
 *
 * The payload is every `data-berelax-*` attribute the element carries, named by
 * {@link payloadFieldForAttribute}, with the page's own fields applied last. There is no check that the
 * name is in the taxonomy and no check that the fields are the right ones, and both absences are
 * deliberate: that judgement is `parseAnalyticsEvent`'s behind `/api/collect`, which refuses by name, and a
 * copy of it in the browser would be a second statement shipped to a cache (`attributes.ts`'s header
 * carries the measurement that settled it — 98,927 bytes of `zod` against a 3,072-byte budget). What makes
 * a wrong declaration impossible before it ships is `scripts/check-event-attributes.mjs`, at build time.
 *
 * ## No DOM globals and no React in this file
 *
 * Every dependency is a parameter, in exactly the shape `motion/observe.ts` records for the same reason:
 * `packages/**\/*.ts` is typechecked by the ROOT project, which has `lib: ["ES2023"]` and no DOM — so a
 * `.ts` here that named `Element` or `MouseEvent` would not compile — and a module with no DOM globals is a
 * module the unit suite can drive in `environment: 'node'` with nothing running. The real `document`, the
 * real `crypto` and the React component that mounts all of this are `collector.island.tsx`, which is a
 * `.tsx` and is typechecked through `apps/web` where the DOM libs are.
 */
import type { AnalyticsEvent } from '@berelax/shared'
import {
  payloadFieldForAttribute,
  TRACK_ATTRIBUTE_PREFIX,
  TRACK_EVENT_ATTRIBUTE,
} from './attributes.ts'
import type { CollectedEvent, Collector, TrackOutcome } from './collector.ts'

/** The selector that finds every declaring element. Derived from the attribute, never written twice. */
export const TRACK_SELECTOR = `[${TRACK_EVENT_ATTRIBUTE}]`

/** What this module needs of an element. A real `Element` satisfies it. */
export interface TrackableElement {
  getAttribute(name: string): string | null
  /** Every attribute present, which is how the payload is read without knowing the event's fields. */
  getAttributeNames(): readonly string[]
  closest(selector: string): TrackableElement | null
}

/** What it needs of a click. A real `MouseEvent` satisfies it. */
export interface TrackableClick {
  readonly target: unknown
}

/** What it needs of the document the click happened in. A real `Document` satisfies it. */
export interface TrackableRoot {
  addEventListener(
    type: 'click',
    listener: (event: TrackableClick) => void,
    options?: { readonly capture?: boolean },
  ): void
  removeEventListener(
    type: 'click',
    listener: (event: TrackableClick) => void,
    options?: { readonly capture?: boolean },
  ): void
}

/** The page facts the collector supplies for every event, so no element declares them. */
export interface TrackedPage {
  /** The route the server rendered. Site-relative, no query, no fragment — `pathSchema`'s own rule. */
  readonly path: string
}

/**
 * The declaring element for a click, or null.
 *
 * `closest` and not a reference-equality test against the event's target, because the thing a reader clicks
 * is usually a `<span>` or an `<svg>` inside the anchor that carries the attribute. A test on the target
 * itself tracks nothing on any button with an icon in it — which is most of them — and the symptom is an
 * event that fires sometimes.
 */
export function declaringElement(click: TrackableClick): TrackableElement | null {
  const target = click.target
  if (target === null || typeof target !== 'object') return null
  const candidate = target as Partial<TrackableElement>
  if (typeof candidate.closest !== 'function') return null
  return candidate.closest(TRACK_SELECTOR)
}

/**
 * The event one element declares: its name, and every payload attribute it carries.
 *
 * The page's fields are applied LAST and that ordering is load-bearing: an element cannot override the
 * path. If it could, a component reused on two pages would report whichever page its author was looking at
 * when they wrote the attribute. (`data-berelax-path` is refused at build time as well, by
 * `event-payload-attribute-is-not-a-payload-field`, so this is the second of two closures rather than the
 * only one.)
 *
 * What it adds is `DECLARED_EVENT_PAGE_FIELDS` — `path`, and nothing else — and the event's own
 * schema has to accept it, because every payload schema is a `strictObject` and an extra property is a
 * refusal of the whole event. That is a build-time rule rather than a check here, for this module's
 * reason: `event-attribute-declares-an-event-with-no-page-field`.
 *
 * Returns null for an element that declares no event at all.
 */
export function declaredEventOf(
  element: TrackableElement,
  page: TrackedPage,
): CollectedEvent | null {
  const name = element.getAttribute(TRACK_EVENT_ATTRIBUTE)
  if (name === null) return null
  const payload: Record<string, unknown> = {}
  for (const attribute of element.getAttributeNames()) {
    if (!attribute.startsWith(TRACK_ATTRIBUTE_PREFIX)) continue
    const field = payloadFieldForAttribute(attribute)
    if (field === null) continue
    const value = element.getAttribute(attribute)
    if (value !== null) payload[field] = value
  }
  return { name, payload: { ...payload, path: page.path } }
}

/**
 * Reads one declaring element and queues what it declares.
 *
 * Returns the outcome, and `null` when the element declares no event, so the listener below can be a
 * one-liner and a test can assert a refusal BY NAME — which is otherwise unobservable, because tracking is
 * decoration on every surface it sits on and a refusal changes nothing a reader can see.
 */
export function trackDeclaringElement(
  collector: Collector,
  element: TrackableElement,
  page: TrackedPage,
): TrackOutcome | null {
  const declared = declaredEventOf(element, page)
  if (declared === null) return null
  // The ELEMENT is the interaction's source, which is what makes the 300 ms window a window on one
  // control rather than on the page: two calls to action carrying the same payload are two interactions,
  // and a reader clicking one and then the other inside the window is doing two things.
  return collector.trackInteraction(declared, element)
}

/**
 * Installs the one delegated listener, and returns the function that removes it.
 *
 * `onOutcome` exists for the suites and for the island's flush-when-full, and for nothing else.
 */
export function attachDeclaredTracking(input: {
  readonly root: TrackableRoot
  readonly collector: Collector
  readonly page: TrackedPage
  readonly onOutcome?: (outcome: TrackOutcome) => void
}): () => void {
  const { root, collector, page, onOutcome } = input
  const listener = (click: TrackableClick): void => {
    const element = declaringElement(click)
    if (element === null) return
    const outcome = trackDeclaringElement(collector, element, page)
    if (outcome !== null && onOutcome !== undefined) onOutcome(outcome)
  }
  root.addEventListener('click', listener, { capture: true })
  return () => {
    root.removeEventListener('click', listener, { capture: true })
  }
}

/**
 * The page view, built here so the `entry` flag has exactly one author.
 *
 * `entry` is *"was this the page the session ENTERED on"* and it decides the `landing` stage — one landing
 * per session, so the funnel's first bucket is a count of sessions rather than of page views. The collector
 * answers it with "is this the first page view this document produced", and a client-side navigation inside
 * the App Router is therefore not an entry: the document did not change, so the session did not begin here.
 * Deciding it server-side was the alternative and is wrong for the reason `collect.ts` records about the
 * `Referer` header — the landing event arrives in a `sendBeacon` from a page the visitor has already left,
 * where the server has no view of whether it was the first.
 *
 * Typed as {@link AnalyticsEvent} with no cast: `page_view`'s payload is `{ path: string; entry: boolean }`
 * after inference, so the literal below satisfies that member of the union structurally. The type is a
 * compile-time import and is erased, which is what keeps `zod` out of this bundle.
 */
export function pageViewEvent(page: TrackedPage, entry: boolean): AnalyticsEvent {
  return { name: 'page_view', payload: { path: page.path, entry } }
}

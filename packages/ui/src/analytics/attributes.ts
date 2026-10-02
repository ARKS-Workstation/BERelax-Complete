/**
 * How an event is DECLARED on an element: the attribute names, and the one statement of the conversion
 * between a payload field and the attribute that carries it.
 *
 * ## Why tracking is declared on the element at all
 *
 * The alternative is an `onClick` per call to action calling `track('cta_click', { target: 'whatsapp' })`.
 * It works, and it is unverifiable: the name and the payload are expressions inside a component, so the
 * only way to know what the site collects is to read every component — and a typo in one of them is a row
 * no reporting query can read, discovered weeks later as a funnel stage with no events in it. docs/03 §6
 * puts the volume discipline at the centre of this estate for the same reason A-FIRST-02 closed the
 * taxonomy at five events: an unbounded set of hand-written call sites is the thing that makes the event
 * table the largest object in the database. A handler per element is also a client component per element,
 * on a site where docs/09 §3 allows exactly one heavy island.
 *
 * An attribute is a STRING IN THE MARKUP. `scripts/check-event-attributes.mjs` reads every one of them
 * without running anything, holds each against A-FIRST-02's registry, and fails the build on seven rules.
 * That is the whole argument for this file: it makes "the site collects exactly these events" a statement a
 * check can refuse rather than a convention a reviewer can miss. ADR 0078.
 *
 * ## This module imports NOTHING, and that is a measurement rather than a preference
 *
 * The first version imported the taxonomy so it could derive each event's required fields and validate a
 * value against its own Zod schema in the browser. `pnpm budgets` refused it: the taxonomy imports `zod`
 * and, through the package barrel, every schema in `@berelax/shared` — **98,927 bytes gzipped against a
 * 3,072-byte budget**, in a module whose job is to read six attributes off an element.
 *
 * It was also the wrong design, which the budget is simply what noticed. Membership in the taxonomy and
 * the shape of a payload are decided in exactly ONE place and it is the server: `parseAnalyticsEvent`
 * behind `/api/collect`, which refuses by name. A copy of that judgement in the browser is a second
 * statement of it shipped to a cache, so the stale copy is the one deployed for as long as a visitor's
 * bundle lives. What makes a mis-declared tag impossible in the first place is the BUILD-TIME check, which
 * reads the real schemas where a validation library is free.
 *
 * So the browser's job is transport: read the attributes, name the fields, post. The derivation of WHICH
 * fields an event needs is {@link declaredPayloadFields}, which takes the schema shape as an argument — so
 * the one statement of it is here and the Zod stays with the caller (the checker, and the unit test that
 * holds this module equal to the taxonomy).
 */

/**
 * The attribute that names the event. One per element, and its value is a literal.
 *
 * `data-berelax-` and not `data-track-` or `data-analytics-`: the prefix is already this repository's in
 * `data-hero-sources`, `data-reveal` and `data-slot`, and a generic prefix is the one a third-party script
 * or a CMS paste can collide with. The suffix is `event` rather than `name` because an element declares
 * what HAPPENED, and the payload attributes below are the fields of it.
 */
export const TRACK_EVENT_ATTRIBUTE = 'data-berelax-event'

/** Every attribute this module owns begins with this. Read by the checker's dead-attribute rule. */
export const TRACK_ATTRIBUTE_PREFIX = 'data-berelax-'

/**
 * How long after an accepted interaction an identical one on the same element is a DOUBLE FIRE.
 *
 * 300 ms, which is the acceptance line's figure — *"a double click inside 300 ms produces one event, not
 * two"* — and it is also in the neighbourhood of a browser's own double-click threshold, so the window
 * covers the mistake it exists for: a reader who taps a call to action twice because nothing visibly
 * happened, and a `click` handler that fires on both halves of a `dblclick`.
 *
 * Stated once, here, because three things read it: the collector's dedupe, the unit test that proves
 * 299 ms is one event and 301 ms is two, and the browser suite that double-clicks a real button.
 */
export const INTERACTION_DEDUPE_MS = 300

/**
 * The payload fields the COLLECTOR supplies, which an element therefore never declares.
 *
 * `path` is the route the server rendered and `entry` is whether this page view began the session. Both are
 * facts about the document rather than about the element, and an attribute carrying either would be a
 * second statement of something the page already knows — wrong on every page a component is reused on,
 * which for `path` is every page.
 *
 * It is a declared list rather than an inference because the consequence of guessing is asymmetric: a
 * field wrongly treated as collector-supplied is a field the checker stops requiring, which is a payload
 * refused at `/api/collect` with nothing failing at build time.
 */
export const COLLECTOR_SUPPLIED_PAYLOAD_FIELDS: readonly string[] = ['path', 'entry']

/**
 * The subset of {@link COLLECTOR_SUPPLIED_PAYLOAD_FIELDS} that a DECLARED interaction carries.
 *
 * `path` and not `entry`: `entry` is a page view's field and no element declares a page view. The
 * distinction is not pedantry, and the browser suite is what found it — every event's payload schema is a
 * `strictObject`, so a field the schema does not have is an UNKNOWN EXTRA PROPERTY and the server refuses
 * the whole event as `invalid_event_payload`. `whatsapp_ref_shown` has `refCode` and nothing else, so an
 * element declaring it got a payload with a `path` the taxonomy refuses — a tag that renders, works, and
 * produces a 400 nobody is watching.
 *
 * So an event is declarable by attribute only if its own schema accepts every field in this list, and
 * `event-attribute-declares-an-event-with-no-page-field` in `scripts/check-event-attributes.mjs` is what
 * refuses one that does not. The imperative door (`trackCollectorEvent`) is where the events that are not
 * page-located belong, which is where A-FIRST-07's ref code will raise this one.
 */
export const DECLARED_EVENT_PAGE_FIELDS: readonly string[] = ['path']

/** `refCode` -> `ref-code`. The one conversion, so the reader and the checker cannot disagree. */
const kebab = (field: string): string =>
  field.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)

/** The attribute a payload field travels in: `target` -> `data-berelax-target`. */
export function trackPayloadAttribute(field: string): string {
  return `${TRACK_ATTRIBUTE_PREFIX}${kebab(field)}`
}

/** The payload field an attribute carries, or null when the attribute is not one of ours. */
export function payloadFieldForAttribute(attribute: string): string | null {
  if (!attribute.startsWith(TRACK_ATTRIBUTE_PREFIX)) return null
  const suffix = attribute.slice(TRACK_ATTRIBUTE_PREFIX.length)
  if (suffix === '' || suffix === 'event') return null
  return suffix.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/**
 * The payload fields an element declaring an event has to carry, given that event's own schema shape.
 *
 * The SHAPE is a parameter — `ANALYTICS_EVENT_SCHEMAS[name].shape` — rather than something this module
 * looks up, which is what keeps `zod` out of the browser while leaving exactly one statement of the
 * derivation. Two callers: `scripts/check-event-attributes.mjs`, which refuses a declaration missing one
 * of these, and `attributes.test.ts`, which holds this module equal to the taxonomy in both directions.
 *
 * Sorted, so a failure message lists them in one order whichever object key order a runtime gives.
 */
export function declaredPayloadFields(shape: Readonly<Record<string, unknown>>): readonly string[] {
  return Object.keys(shape)
    .filter((field) => !COLLECTOR_SUPPLIED_PAYLOAD_FIELDS.includes(field))
    .sort()
}

/** The same set, as the attributes an element has to carry. */
export function declaredPayloadAttributes(
  shape: Readonly<Record<string, unknown>>,
): readonly string[] {
  return declaredPayloadFields(shape).map(trackPayloadAttribute)
}

/**
 * Every way the COLLECTOR refuses a declared interaction, by name.
 *
 * Two, and the shortness of the list is the design rather than an omission. `unknown_event` and
 * `invalid_event_payload` are `/api/collect`'s, raised by the one validator in the build; a browser-side
 * copy of either would be the second statement this module's header is about. Both are also unreachable in
 * a tree that passed `pnpm verify`, because `scripts/check-event-attributes.mjs` turns them into build
 * failures — which is the point of having a build-time check at all.
 *
 * There is deliberately no `event_too_large` either. The flush splits a batch by BYTES as well as by
 * count, and the slice that cannot be split further has to do something — but it is not a refusal a CALLER
 * can be given, because no event the taxonomy accepts can reach it: the largest validated payload is a
 * 2048-character path plus a style and a treatment key, about 2.2KB with the envelope's own fields, against
 * a 64KB body cap. So it is a termination guarantee rather than an outcome, counted in
 * `FlushResult.dropped`. Naming it here would be a refusal nothing can raise, which this build has already
 * paid for once: A-FIRST-05's `unknown_event` became unreachable behind an envelope that validated the name
 * twice.
 */
export const TRACK_REFUSALS = [
  /** The same interaction on the same element, inside {@link INTERACTION_DEDUPE_MS}. */
  'duplicate_interaction',
  /** The queue is full. See `COLLECTOR_MAX_QUEUED_EVENTS` in `collector.ts`. */
  'queue_full',
] as const

export type TrackRefusal = (typeof TRACK_REFUSALS)[number]

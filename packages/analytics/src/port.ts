/**
 * The analytics dispatch port — the interface a real GA4 or Meta adapter will implement (A-MEAS-03).
 *
 * Shaped around the two providers rather than around the fakes (docs/12 §1.1, ADR 0022), and three things
 * make it so rather than generic:
 *
 *   - **`eventId` is an argument, not something the adapter mints.** Both platforms deduplicate on an id
 *     they are given, and the same conversion reaches GA4 through the on-page tag and the Measurement
 *     Protocol. An adapter that minted its own would make one booking two conversions.
 *   - **`actionSource` is an argument and has three values.** Meta's Conversions API requires it, and it
 *     is the field that says a conversion was a walk-in rather than a web order — so it cannot be derived
 *     from the fact that a server sent the request, which is what a generic port would do.
 *   - **`eventTimeIso` is an argument and is never `now()`.** An offline conversion is uploaded days after
 *     the visit (A-MEAS-05), and an adapter that stamped the send instant would date every walk-in on the
 *     night the worker ran.
 *
 * ## The payload is branded and this port cannot be handed anything else
 *
 * `payload` is an {@link EgressPayload}, which is produced only by `buildEgressPayload` in
 * `@berelax/core` — the brand is a `unique symbol`, so an object literal cannot satisfy it and
 * `scripts/check-egress-guard.mjs` rule 1 asserts the one cast that mints one is inside the builder. That
 * is what makes "no service name and no price on a non-terminal event reaches a platform" a property of
 * this signature rather than of an adapter's care (ADR 0018, ADR 0059).
 *
 * ## No host, no measurement id, no pixel id, no token
 *
 * There is no GA4 property and no Meta pixel in this build (docs/01 decision 14, OPEN-QUESTIONS
 * `Y5-analytics-basis`), so this module names no destination host and no credential, and
 * {@link AnalyticsDispatchProvider} has no configuration parameter for one. `scripts/check-egress-guard.mjs`
 * rule 6 refuses any module naming an analytics destination outside `DECLARED_ADAPTERS`, and that map is
 * still EMPTY after this unit — deliberately, because nothing here transmits. A plausible-looking
 * measurement id would be indistinguishable from a configured one (brief rule 15).
 *
 * ## Delivery is synchronous and acceptance is not success
 *
 * `send` resolves with {@link AnalyticsDispatchAccepted}, whose `transmitted` is a boolean rather than
 * being implied by the absence of a throw. Both platforms answer 200 to a payload they then discard, and
 * off production this build's guard diverts every dispatch to a local outbox — so "the call returned" and
 * "an ad platform has the conversion" are different facts and the type keeps them apart.
 */
import { type EgressPayload, serialiseEgressPayload } from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * Where the conversion happened, in the vocabulary the receiving platform uses.
 *
 * Meta's Conversions API requires it and GA4 does not, and it is declared once here for both: the field
 * is about the EVENT, not about the transport, so two spellings of it would be two claims about one
 * booking. Three values, which is the acceptance line's own list.
 */
export const ANALYTICS_ACTION_SOURCES = ['website', 'phone_call', 'physical_store'] as const
export type AnalyticsActionSource = (typeof ANALYTICS_ACTION_SOURCES)[number]

/**
 * Every value `booking.source` may hold, in the database's own order.
 *
 * A second statement of the CHECK constraint `booking_source_known`, and it arrives with the check that
 * holds the two equal: `packages/fixtures/src/analytics-dispatch.itest.ts` reads the constraint out of
 * `pg_constraint` and asserts the two sets match in BOTH directions. The alternative was mapping from a
 * plain `string`, which makes a renamed source a runtime `undefined` instead of a tsc error — and an
 * `undefined` action source is the field Meta rejects the whole batch for.
 */
export const BOOKING_SOURCES = ['online', 'front_desk', 'phone', 'walk_in', 'import'] as const
export type BookingSource = (typeof BOOKING_SOURCES)[number]

/**
 * Which action source each booking source is, as a TABLE.
 *
 * `Record<BookingSource, …>` and not a partial map or a `switch` with a `default`, so a fifth booking
 * source stops this file compiling until somebody decides what it is. A `switch` with a default would
 * resolve it silently, and the silent answer — `website` — is the one that makes a front-desk walk-in
 * look like an online order in somebody's advertising report.
 *
 * `front_desk` and `walk_in` are both `physical_store`, and they are different booking sources for a
 * reason that does not reach the platform: one is a person at the counter booking for later and the other
 * is a person taking a treatment now. Neither happened on a website and neither was a phone call, so the
 * platform vocabulary has one word for both, and collapsing them here rather than in the consumer is what
 * keeps the internal distinction intact.
 */
/**
 * `import` is deliberately ABSENT from the table below, and that is the decision rather than an omission.
 *
 * Migration 0130 (H-MIG-05) widened `booking_source_check` to admit `import`, because a reconstructed
 * visit is history the live status machine may not touch. The legacy file does not say where such a
 * booking was taken, so there is no action source to declare: mapping it to any of the three would
 * report a visit from before this system existed as a conversion that happened now, in somebody else's
 * advertising account. `actionSourceFor` therefore refuses it by the path that already refuses an
 * undeclared source, and `Exclude<..., 'import'>` keeps the table total over the sources a LIVE booking
 * may have — so a sixth source still stops this file compiling until somebody decides what it is.
 */
export const BOOKING_SOURCE_ACTION_SOURCE: Readonly<
  Record<Exclude<BookingSource, 'import'>, AnalyticsActionSource>
> = Object.freeze({
  online: 'website',
  front_desk: 'physical_store',
  phone: 'phone_call',
  walk_in: 'physical_store',
})

/** The action source for a booking source that arrived as a plain `string`, or a named refusal. */
export function actionSourceFor(bookingSource: string): AnalyticsActionSource {
  const mapped = (
    BOOKING_SOURCE_ACTION_SOURCE as Readonly<Record<string, AnalyticsActionSource | undefined>>
  )[bookingSource]
  if (mapped !== undefined) return mapped
  throw new AppError(
    'validation',
    `booking.source is ${JSON.stringify(bookingSource)}, which no action source is declared for. A ` +
      `dispatch is refused rather than defaulted: ${ANALYTICS_ACTION_SOURCES[0]} is the value a default ` +
      "would reach, and it would report a walk-in as a web order in somebody else's advertising account.",
    { details: { bookingSource, declared: [...BOOKING_SOURCES] } },
  )
}

/**
 * The identifiers a platform matches a conversion to a person with, already hashed.
 *
 * Hashed BEFORE this type exists, which is the whole reason the fields are named `phoneSha256` and
 * `emailSha256` rather than `phone` and `email`: a port that took the plaintext would be a port an
 * adapter could forget to hash, and the failure is silent — both platforms accept an unhashed value and
 * the only evidence is that a phone number left the building. `hashedUserData` in `./identity.ts` is the
 * one place a plaintext contact detail is turned into one of these.
 *
 * `fbp` and `fbc` are the browser cookies Meta sets, forwarded VERBATIM and never hashed: they are
 * already opaque to us, hashing them would make them unmatchable, and they are what lets a server-side
 * conversion be joined to the click that produced it. They are optional because a session that arrived
 * without an advertising click has neither, and an empty string is not the same claim as an absent field.
 */
export interface HashedUserData {
  readonly phoneSha256?: string
  readonly emailSha256?: string
  readonly fbp?: string
  readonly fbc?: string
}

export interface AnalyticsDispatchRequest {
  /**
   * The deduplication identity, shared with the on-page tag.
   *
   * Derived by `analyticsEventId`, not minted here — see that function's header for why both surfaces
   * derive rather than one telling the other.
   */
  readonly eventId: string
  /** The consent-gated destination id this dispatch is for. Opaque: it names no host. */
  readonly destination: string
  /** What may leave, and nothing else may. Produced by `buildEgressPayload` alone. */
  readonly payload: EgressPayload
  readonly actionSource: AnalyticsActionSource
  /** The instant the conversion HAPPENED, ISO-8601. Never the instant of the send. */
  readonly eventTimeIso: string
  readonly userData: HashedUserData
  /**
   * The browser identifier the on-page tag used, if this conversion had a browser.
   *
   * GA4's Measurement Protocol needs a `client_id` and it is the `_ga` cookie's value, which is minted by
   * the on-page tag — A-MEAS-04's module, which does not exist yet. So the field is optional and this
   * build supplies none, and {@link AnalyticsDispatchProvider} implementations OMIT it rather than
   * inventing one: a made-up client id is a distinct visitor to GA4, so a run of them would report every
   * conversion as a first-ever session and destroy the very attribution the push exists to supply. The
   * omission is RECORDED on the outbox row (`GA4_CLIENT_REFERENCE_OMITTED`) so it reads as unanswered
   * rather than as configured (brief rule 15, OPEN-QUESTIONS `Y1-analytics-credentials`).
   *
   * An offline conversion legitimately has none for ever — a walk-in had no browser — which is why this
   * is `optional` on the port and not a field A-MEAS-04 later makes required.
   */
  readonly clientReference?: string
}

export interface AnalyticsDispatchAccepted {
  /** The adapter that answered, by name. `GA4_MEASUREMENT_PROTOCOL.name` and its sibling. */
  readonly provider: string
  /**
   * Whether a request actually reached a platform.
   *
   * A boolean rather than the absence of a throw, because both platforms answer 200 to a payload they
   * then discard and this build's guard diverts everything off production. `false` with a `divertedReason`
   * is the only answer a fake can honestly give.
   */
  readonly transmitted: boolean
  /** Why nothing was transmitted, or null. Non-null exactly when `transmitted` is false. */
  readonly divertedReason: string | null
  /** The local outbox row this dispatch left behind. Never empty — see {@link LOCAL_OUTBOX_IS_THE_RECEIPT}. */
  readonly outboxId: string
}

/**
 * Why every adapter writes a local outbox row even when nothing was transmitted.
 *
 * docs/12 §1: *"nothing returns success without writing to a visible local outbox"*. For a message that
 * is about being able to show the owner what would have been sent. For a conversion it is sharper: a
 * dispatch that returned success and left no trace is indistinguishable from one that was never made, and
 * A-MEAS-07's whole job is comparing internal truth against what was pushed. A bare `{ ok: true }` would
 * make that comparison a comparison of our own table with itself.
 */
export const LOCAL_OUTBOX_IS_THE_RECEIPT =
  'An analytics adapter that returns success without writing a local outbox row makes A-MEAS-07 a ' +
  'comparison of our own records with themselves.'

export interface AnalyticsDispatchProvider {
  readonly name: string
  /**
   * Transmit one dispatch, or divert it and say so.
   *
   * ONE dispatch and not a batch, deliberately. Both platforms accept batches, and a batched port makes
   * partial failure the caller's problem: GA4 answers 200 for a batch in which one event was dropped, and
   * Meta answers a per-event error list. One call per `(event_id, destination)` is what makes the attempt
   * counter on the row mean something, and the consumer's retry is per row for the same reason.
   */
  send(request: AnalyticsDispatchRequest): Promise<AnalyticsDispatchAccepted>
  /** Every dispatch this adapter has recorded, in order. The admin panel and the tests read this. */
  drainLocalOutbox(): readonly LocalDispatchRecord[]
}

/** One recorded dispatch: what was sent where, in the shape the adapter would have put on the wire. */
export interface LocalDispatchRecord {
  readonly outboxId: string
  readonly provider: string
  readonly eventId: string
  readonly destination: string
  readonly actionSource: AnalyticsActionSource
  readonly eventTimeIso: string
  /** The serialised egress payload, byte for byte as `serialiseEgressPayload` produced it. */
  readonly serialisedPayload: string
  /** The provider-shaped body, as the real adapter would have posted it. No credential in it. */
  readonly body: Readonly<Record<string, unknown>>
  readonly transmitted: boolean
  readonly divertedReason: string | null
  readonly recordedAtIso: string
}

/**
 * The bytes of a dispatch, for the row the consumer stores and for A-MEAS-07.
 *
 * `serialiseEgressPayload` and never `JSON.stringify(payload)`: the former walks the field allowlist in
 * order, so two adapters serialising one payload cannot produce two strings — and two strings for one
 * payload is two payloads to anything deduplicating on content.
 */
export const dispatchPayloadBytes = (payload: EgressPayload): string =>
  serialiseEgressPayload(payload)

/**
 * `@berelax/analytics` — the two analytics destinations, behind the interface their real adapters will
 * implement (A-MEAS-03).
 *
 * The contract these satisfy is docs/12 §1, the same one `@berelax/providers` satisfies for messaging: the
 * real interface exists, a fake behaves like the real thing including its failures, selection is
 * configuration, and nothing returns success without writing to a visible local outbox.
 *
 * ## THIS BARREL RE-EXPORTS NOTHING FROM `ga4.ts` OR `meta-capi.ts`, and that is the point
 *
 * `.dependency-cruiser.cjs`'s `analytics-adapters-only-through-the-registry` forbids importing either
 * adapter module from anywhere but `src/registry.ts` and a test, and a barrel re-export would make that
 * rule match nothing — the lesson `payment-gateway-adapters-only-through-the-registry` and
 * `messaging-providers-only-inside-a-transport` both record in so many words: THE BARREL IS THE LOOPHOLE.
 * So this file does not reach either module at all, not even for a constant.
 *
 * A consumer takes an adapter from {@link createAnalyticsDispatchers}, which is the only place
 * `ANALYTICS_PROVIDER` is read, and names a destination through {@link DISPATCH_DESTINATIONS}, which the
 * registry assembles. A test that needs a body builder — `ga4MeasurementBody`, `metaConversionsBody` — or
 * an adapter's own constants imports the module directly, which the rule permits for a test and for
 * nothing else.
 *
 * ## Money is not re-exported either
 *
 * `conversionValueNumber` and its siblings live in `@berelax/core`, where money arithmetic belongs, and a
 * consumer imports them from there. A re-export here would be a second door onto one function and would
 * make this package look like the home of a figure it only formats.
 */

export {
  ANALYTICS_AGGREGATE_KINDS,
  type AnalyticsAggregateKind,
  type AnalyticsEventSubject,
  analyticsEventCanonicalForm,
  analyticsEventId,
  EVENT_ID_LENGTH,
  EVENT_ID_SEPARATOR,
  ORIGINAL_STATEMENT_REVISION,
} from './event-id.ts'
export {
  ANALYTICS_MAX_ATTEMPTS,
  ANALYTICS_RETRY_BASE_SECONDS,
  ANALYTICS_RETRY_FACTOR,
  type AnalyticsEgressDecision,
  type AnalyticsFakeContext,
  analyticsRetryDelaySeconds,
  createDispatchOutbox,
  type DispatchOutbox,
  type DispatchOutboxEntry,
  dispatchEventTime,
  guardAnalyticsEgress,
  performFakeDispatch,
  TRANSPORT_REFUSAL_IS_RETRYABLE,
  TRANSPORT_REFUSAL_STATUS,
  TRANSPORT_REFUSALS,
  type TransportRefusal,
  TransportRefusalError,
  TransportScript,
  transportRefusalOf,
} from './fakes.ts'
export {
  EMAIL_HASHING_VECTORS,
  emailSha256,
  type HashedUserDataResult,
  hashedUserData,
  normaliseEmailForMatching,
  PHONE_HASHING_VECTORS,
  type PhoneMatchKey,
  phoneDigitsForMatching,
  phoneSha256,
  sha256Lower,
  USER_DATA_OMISSIONS,
  type UserDataOmission,
} from './identity.ts'
export {
  ANALYTICS_ACTION_SOURCES,
  type AnalyticsActionSource,
  type AnalyticsDispatchAccepted,
  type AnalyticsDispatchProvider,
  type AnalyticsDispatchRequest,
  actionSourceFor,
  BOOKING_SOURCE_ACTION_SOURCE,
  BOOKING_SOURCES,
  type BookingSource,
  dispatchPayloadBytes,
  type HashedUserData,
  LOCAL_OUTBOX_IS_THE_RECEIPT,
  type LocalDispatchRecord,
} from './port.ts'
export {
  type AnalyticsDispatchers,
  type AnalyticsRegistryOptions,
  createAnalyticsDispatchers,
  DISPATCH_DESTINATIONS,
  type DispatchDestination,
} from './registry.ts'

/**
 * @berelax/providers — every external service, behind the interface its real adapter will implement.
 *
 * The contract these satisfy is docs/12 §1: the real interface exists, a fake behaves like the real
 * thing including its failures, selection is configuration, and nothing returns success without
 * writing to a visible local outbox. `rendering.itest.ts`-style conformance tests hold the last one
 * to account for every provider at once, so a fake added later cannot quietly opt out of it.
 */

export { type CallLog, type CallOutcome, createCallLog, type ProviderCall } from './call-log.ts'
export { BOUNCE_MARKER, COMPLAINT_MARKER, createFakeResend, RESEND } from './email/fake-resend.ts'
export type {
  EmailAccepted,
  EmailAddress,
  EmailAttachment,
  EmailEvent,
  EmailEventType,
  EmailProvider,
  EmailRequest,
} from './email/port.ts'
export {
  FAILURE_MODES,
  type FailureMode,
  FailureScript,
  failureError,
  failureModeOf,
  isRetryable,
} from './failure.ts'
export {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
  GOOGLE_BUSINESS_PROFILE,
  GOOGLE_OAUTH,
  GOOGLE_SEARCH_CONSOLE,
  REVIEW_FIXTURES,
  TESTING_REFRESH_TOKEN_DAYS,
} from './google/fake-google.ts'
export {
  createFakePlaces,
  GOOGLE_PLACES,
  PLACES_AGGREGATE_FIELD_MASK,
  PLACES_AGGREGATE_FIXTURE,
  PLACES_FIXTURE_PLACE_ID,
  PLACES_REVIEW_FIXTURES,
} from './google/fake-places.ts'
export type {
  BusinessProfileProvider,
  GoogleOAuthProvider,
  GoogleRevocation,
  GoogleSub,
  GoogleTokens,
  PlacesDetails,
  PlacesProvider,
  PlacesReview,
  Review,
  SearchAnalyticsRow,
  SearchConsoleProvider,
} from './google/port.ts'
export { GOOGLE_REVOKE_ENDPOINT } from './google/port.ts'
export { createFakeLlm, FAKE_LLM, LOCAL_FAKE_PRICING } from './llm/fake-llm.ts'
export {
  createFakeDeepSeek,
  createFakeMiniMax,
  DEEPSEEK,
  MINIMAX,
  PROVISIONAL_DEEPSEEK_PRICING,
  PROVISIONAL_MINIMAX_PRICING,
  REJECTED_KEY_MARKER,
} from './llm/named-fakes.ts'
export {
  costOfFils,
  type LlmOutcome,
  type LlmPricing,
  type LlmProvider,
  type LlmPurpose,
  type LlmRequest,
  type LlmUsage,
  MINIMUM_LLM_KEY_LENGTH,
  validateLlmKey,
} from './llm/port.ts'
export { notImplemented, PENDING, type PendingIntegration } from './not-implemented.ts'
export { FAKE_GATEWAY, REFERENCE_MARKERS } from './payments/fake-gateway.ts'
export {
  BUILT_LLM_PROVIDERS,
  createProviders,
  type ProviderRegistryOptions,
  type Providers,
} from './registry.ts'
export { createFakeSmsala, SMSALA, UNDELIVERABLE_SUFFIX } from './sms/fake-smsala.ts'
export type {
  DeliveryReceipt,
  DeliveryStatus,
  SenderId,
  SmsAccepted,
  SmsProvider,
  SmsRequest,
} from './sms/port.ts'

/*
  W-SITE-08's IndexNow port and fake are deliberately NOT re-exported here.

  They live on the `@berelax/providers/seo` subpath instead, because
  `.dependency-cruiser.cjs`'s `messaging-providers-only-inside-a-transport` bans THIS barrel outside a
  messaging transport — it re-exports the SMS and email ports, so an import of the barrel reaches SMSala
  while naming nothing forbidden. Adding IndexNow here would have made the propagation job's import of it
  a boundary violation, and the fix would have been to widen the rule rather than to use a subpath. See
  `packages/google`, which imports `@berelax/providers/google` for the same reason.
*/

/**
 * @berelax/google — the owner's Google connection: its token store, its lifecycle and its KEK rotation.
 *
 * Why a package of its own rather than a folder in `db` or `providers`: the tokens here are the only
 * secret in the `public` schema that grants write access to something outside this system. Everything
 * that touches them is in one place so the chokepoint rule G-CONN-03 adds — *nothing outside
 * `with-google.ts` and `token-store.ts` may reference a token column* — has a boundary to be drawn
 * around. A rule that has to enumerate folders across three packages is a rule that will be forgotten.
 *
 * The pure arithmetic (staleness, the seven-day Testing tripwire, the state machine, the derivation of
 * what a human is shown) lives in `@berelax/core` and is tested without a clock or a database. This
 * package is the I/O around it.
 */
export type {
  CapabilityHealthWrite,
  ConnectionEventInput,
  ConsentWrite,
  GoogleCapabilityRecord,
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleConsentStore,
  NewConnection,
  RefreshWrite,
  StatusWrite,
} from './connection-store.ts'
export {
  type CapabilityDeclaration,
  CONSUMERS,
  type ConsumerDeclaration,
  type DeclaredCapability,
  type DegradedMode,
  declarationFor,
  type GoogleConsumer,
  indexByCapability,
  isDeclaredCapability,
} from './consumers.ts'
export {
  capabilityHealthFor,
  classifyGoogleError,
  DEGRADES,
  FAILURE_MODE_CLASS,
  GOOGLE_ERROR_CLASSES,
  type GoogleErrorClass,
  googleCallError,
  isRetryableGoogleError,
  UPSTREAM_CODE_CLASS,
  type UpstreamFingerprint,
  upstreamFingerprint,
} from './errors.ts'
export {
  type AccessTokenGrant,
  accessTokenFor,
  googleReauthRequired,
  grantFailureFromError,
  refreshAccessToken,
  type TokenLifecycleDeps,
} from './lifecycle.ts'
export {
  connectionRecord,
  createMemoryConnectionStore,
  type MemoryConnectionStore,
} from './memory-store.ts'
export {
  type AuthorizationRequest,
  buildAuthorizationRequest,
  CONSENT_WINDOW_MINUTES,
  type ConsentDeps,
  codeChallengeFor,
  consentWindowExpired,
  type PendingConsent,
  parsePendingConsent,
  serialisePendingConsent,
} from './oauth/consent.ts'
export {
  authorizationCodeFingerprint,
  CONSENT_CODE_REPLAYED,
  CONSENT_DENIED,
  CONSENT_IDENTITY_MISMATCH,
  CONSENT_STATE_MISMATCH,
  CONSENT_WINDOW_CLOSED,
  type ConsentCallback,
  type ConsentGrant,
  claimsFromIdToken,
  consentCodeReplayed,
  type ExchangeDeps,
  exchangeConsentCode,
  type GoogleIdentity,
  identityFrom,
} from './oauth/exchange.ts'
export {
  type ApplyConsentDeps,
  applyConsent,
  type CompleteConsentDeps,
  type ConsentOutcome,
  type ConsentOutcomeKind,
  completeGoogleConsent,
  type GoogleAccountMismatch,
} from './oauth/reconnect.ts'
export { createPostgresConnectionStore } from './postgres-store.ts'
export { type RewrapReport, rewrapRefreshTokens } from './rewrap.ts'
/**
 * The token *shape*, and deliberately not the token *accessors*.
 *
 * `openToken`, `sealToken`, `rewrapToken` and `connectionBinding` were re-exported here until G-CONN-03,
 * which made the chokepoint rule unenforceable in exactly the way
 * `messaging-providers-only-inside-a-transport` documents: a dependency-cruiser rule matching a *module*
 * is defeated by a re-export, so `import { openToken } from '@berelax/google'` reached the decryption
 * function while naming nothing forbidden. Unlike the providers barrel this one cannot simply be banned —
 * it is the package's only entry point and the consent route legitimately imports from it — so the fix is
 * the other direction: the accessors leave the barrel, and the only way to them is a relative import from
 * inside this package, which is a module path a rule can match.
 *
 * `SealedToken` stays: it is the five sealed columns as a type, and a type decrypts nothing.
 */
export type { SealedToken } from './token-store.ts'
export {
  type DegradationCause,
  type GoogleCallContext,
  type GoogleErrorSink,
  type GoogleLogger,
  type GoogleLogLine,
  type LogLevel,
  type WithGoogleDeps,
  type WithGoogleOutcome,
  withGoogle,
} from './with-google.ts'

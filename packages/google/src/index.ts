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
export {
  connectionBinding,
  GOOGLE_CONNECTIONS_TABLE,
  openToken,
  rewrapToken,
  type SealedToken,
  sealToken,
} from './token-store.ts'

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
export {
  type AccountEnumeration,
  enumerateAccounts,
  GBP_ACCOUNT_TYPES,
  holdsLocationsIndependently,
} from './adapters/account-management.ts'
export {
  assertReadMask,
  type EnumeratedLocation,
  getLocationUnder,
  LOCATION_READ_MASK,
  type LocationSnapshot,
  listLocationsUnder,
  oneLineAddress,
  READ_MASK_INCOMPLETE,
  READ_MASK_MISSING,
  REQUIRED_READ_MASK_FIELDS,
  readLocationSnapshot,
} from './adapters/business-information.ts'
export {
  assertSiteSelectable,
  isDomainProperty,
  listSearchConsoleSites,
  SITE_NOT_LISTED,
  SITE_NOT_VERIFIED,
  siteIsUsable,
  USABLE_SITE_PERMISSIONS,
} from './adapters/search-console.ts'
export {
  dedupeByPlaceId,
  enumerateGbpChoices,
  enumerateSearchConsoleChoices,
  type GbpPickerView,
  type GbpResourceRef,
  type GscPickerView,
  type GscResourceRef,
  mapsLinkFor,
  PICKER_CHOICE_UNKNOWN,
  PICKER_GUIDANCE,
  PICKER_LISTING_MOVED,
  PICKER_STATE_FOR_CAUSE,
  type PickerChoice,
  type PickerDeps,
  type PickerState,
  parseGbpResourceRef,
  parseGscResourceRef,
  RESOURCE_REF_MALFORMED,
  reviewsPathFor,
  type SelectionActor,
  type SelectionOutcome,
  type SiteChoice,
  selectGbpLocation,
  selectSearchConsoleProperty,
} from './capability-resolver.ts'
export type {
  CapabilityHealthWrite,
  CapabilityResourceWrite,
  CheckOutcomeWrite,
  ConfirmedListing,
  ConnectionEventInput,
  ConsentWrite,
  DisconnectWrite,
  GoogleCapabilityRecord,
  GoogleCapabilitySelectionStore,
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleConsentStore,
  GoogleDisconnectStore,
  GoogleHealthStore,
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
  declaredCapabilities,
  type GoogleConsumer,
  indexByCapability,
  isDeclaredCapability,
} from './consumers.ts'
export {
  type DisconnectActor,
  type DisconnectDeps,
  type DisconnectOutcome,
  type DisconnectOutcomeKind,
  disconnectGoogleConnection,
  type RetryAnnouncement,
  type RevokeRetryReport,
  retryPendingRevocations,
} from './disconnect.ts'
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
  type CapabilityCheck,
  type ConnectionCheck,
  checkConnection,
  type DeepCheckResult,
  HEALTH_EVENT_FAILED,
  HEALTH_EVENT_OK,
  HEALTH_NO_CONFIRMED_LISTING,
  HEALTH_NO_CONSUMER,
  HEALTH_NO_RESOURCE_SELECTED,
  HEALTH_RESOURCE_REF_MALFORMED,
  HEALTH_SCOPE_MISSING,
  type HealthCheckDeps,
  type HealthFinding,
  type ListingNotVerifiedFinding,
  runDeepCheck,
} from './health/deep-check.ts'
export {
  type LivenessDeps,
  type LivenessProbe,
  type LivenessResult,
  type LivenessSkip,
  livenessCapabilityFor,
  runLiveness,
} from './health/liveness.ts'
export {
  type ConnectionHealthCard,
  connectionHealthCards,
  connectionSnapshot,
  escapeHtml,
  GOOGLE_PUBLISHING_STATUSES,
  type GooglePublishingStatus,
  isGooglePublishingStatus,
  renderConnectionHealth,
  renderTestingExpiry,
  spellDate,
  TESTING_EXPIRY_TRIPWIRE,
  type TestingExpiryView,
  testingExpiryFor,
} from './health/testing-expiry.ts'
export {
  type AccessTokenGrant,
  accessTokenFor,
  cachedAccessGrant,
  googleReauthRequired,
  grantFailureFromError,
  loadActiveConnection,
  refreshAccessToken,
  revokeStoredGrant,
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
export {
  DISCONNECT_REASON_DONE,
  DISCONNECT_REASON_REVOKE_FAILED,
  type DisconnectStatusReason,
  GOOGLE_REVOKE_ENDPOINT,
  REVOKE_VERDICTS,
  type RevokeVerdict,
  type RevokeVerdictKind,
  revokeDetail,
  statusReasonFor,
  verdictForRevocation,
  verdictForRevokeError,
  zeroisationIsSafe,
} from './oauth/revoke.ts'
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
export {
  type AccessTokenOptions,
  accessTokenUnderLock,
  assertReadCommitted,
  createMemoryRefreshLock,
  createPostgresRefreshLock,
  DEFAULT_REFRESH_LOCK_TIMEOUT_MS,
  type LockedRefreshScope,
  type ProactiveRefreshDeps,
  REFRESH_LOCK_NAMESPACE,
  REFRESH_LOCK_TIMEOUT,
  REFRESH_LOCK_WRONG_ISOLATION,
  type RefreshLockOptions,
  type RefreshLockRunner,
} from './token-refresh.ts'
export type { SealedToken } from './token-store.ts'
export {
  type DegradationCause,
  type GoogleCallContext,
  type GoogleErrorSink,
  type GoogleLogger,
  type GoogleLogLine,
  type LogLevel,
  type WithGoogleDeps,
  type WithGoogleOptions,
  type WithGoogleOutcome,
  withGoogle,
} from './with-google.ts'

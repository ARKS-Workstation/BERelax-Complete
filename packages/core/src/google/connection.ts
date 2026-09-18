import { AppError } from '@berelax/shared'
import { addMinutes, type Instant } from '../time.ts'

/**
 * The Google connection, as arithmetic.
 *
 * Everything in this file is a function of its arguments — including the instant, which is injected
 * like every other clock read in `packages/core`. That matters more here than usual: the two things
 * this computes are *"is the connection about to die"* and *"should the owner be emailed"*, and a
 * calculation that reads the machine clock cannot be tested for either without waiting a week.
 *
 * ## Two vocabularies, deliberately not one
 *
 * `GoogleConnectionStatus` is the state of the **grant**, and it is what the database stores
 * (docs/10 §2). `GoogleConnectionDisplayState` is what a human is shown, and it is **derived** from
 * the stored status plus capability health plus token age (docs/07 §6). Conflating them produced a
 * genuine inconsistency between two design documents, so they are separate types and exactly one
 * function converts between them — which is what stops the settings panel and the email saying
 * different things about the same connection.
 */

/** The state of the grant. Stored on `google_connections.status`. */
export type GoogleConnectionStatus = 'active' | 'needs_reauth' | 'revoked' | 'disconnected'

export const GOOGLE_CONNECTION_STATUSES: readonly GoogleConnectionStatus[] = [
  'active',
  'needs_reauth',
  'revoked',
  'disconnected',
]

/**
 * What the admin panel and the emails show. Never a scope string, never a stored status.
 *
 * `pending_gbp_approval` is the one that looks like an error and is not: Business Profile API access
 * is granted by application review rather than by enabling an API, so a perfectly valid token with
 * zero quota is the expected state for weeks after launch. Rendering that as `broken` would put a red
 * banner on every admin page for a month and a half, after which nobody reads red banners.
 */
export type GoogleConnectionDisplayState =
  | 'never_connected'
  | 'healthy'
  | 'expiring_soon'
  | 'degraded'
  | 'broken'
  | 'pending_gbp_approval'

export type GoogleCapability = 'gbp_reviews' | 'gbp_location' | 'gbp_performance' | 'gsc'

export const GOOGLE_CAPABILITIES: readonly GoogleCapability[] = [
  'gbp_reviews',
  'gbp_location',
  'gbp_performance',
  'gsc',
]

export type GoogleCapabilityHealth =
  | 'ok'
  | 'permission_missing'
  | 'not_verified'
  | 'quota_zero'
  | 'unknown'

/**
 * The two scopes requested, and nothing else (docs/10 §3).
 *
 * `business.manage` has no read-only variant: **the scope that reads reviews also rewrites the
 * address and the opening hours.** That is the single biggest security fact of this integration, and
 * the reason the write paths are read-modify-write with a narrow update mask rather than a PATCH.
 */
export const GOOGLE_SCOPE_BUSINESS_MANAGE = 'https://www.googleapis.com/auth/business.manage'
export const GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY =
  'https://www.googleapis.com/auth/webmasters.readonly'

/**
 * The only two scopes this system may ever request.
 *
 * A union of the two literals rather than `string`, so widening the consent is a **compile** error
 * rather than a review comment. `scripts/test-gates.mjs` writes a fixture requesting a Gmail scope and
 * asserts `tsc` rejects it by name — the type is the gate, and a gate nobody has watched fail is not
 * a gate (ADR 0003).
 */
export type GoogleRequestedScope =
  | typeof GOOGLE_SCOPE_BUSINESS_MANAGE
  | typeof GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY

export const REQUESTED_GOOGLE_SCOPES: readonly GoogleRequestedScope[] = [
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
]

/**
 * Scopes that must never appear in an authorization request, and why each one is here.
 *
 * `webmasters` without the `.readonly` suffix is the read-write Search Console scope. It is listed
 * first because it is the one that would be added by accident: it differs from the scope we do want by
 * nine characters, and sitemap submission — the only thing it buys — is a one-time manual action in
 * the Search Console UI (docs/10 §3).
 *
 * The Gmail scopes are worse than unnecessary. They are the reason a *password change* revokes a
 * refresh token: Google ties that revocation to tokens carrying Gmail scopes, so requesting one turns
 * an invalidation cause that does not apply to us into one that does (docs/10 §4).
 *
 * The Analytics scopes are here because GA4 is a separate consent in a later unit, and a scope
 * requested speculatively is a scope on the consent screen the owner has to be talked through.
 */
export const FORBIDDEN_GOOGLE_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/analytics',
  'https://www.googleapis.com/auth/analytics.readonly',
]

/**
 * The forbidden scopes present in a scope list, compared as whole scopes.
 *
 * Whole scopes, not substrings, and that is the entire subtlety: `auth/webmasters` is a prefix of
 * `auth/webmasters.readonly`, so a containment check would report the scope we *do* want as
 * forbidden — and the natural fix for that false positive is to delete the check.
 */
export function forbiddenScopesIn(scopes: readonly string[]): readonly string[] {
  const requested = new Set(scopes)
  return FORBIDDEN_GOOGLE_SCOPES.filter((scope) => requested.has(scope))
}

/** The scope each capability needs. One scope covers every Business Profile API; there is no other. */
export const CAPABILITY_SCOPE: Readonly<Record<GoogleCapability, string>> = {
  gbp_reviews: GOOGLE_SCOPE_BUSINESS_MANAGE,
  gbp_location: GOOGLE_SCOPE_BUSINESS_MANAGE,
  gbp_performance: GOOGLE_SCOPE_BUSINESS_MANAGE,
  gsc: GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
}

/** True for the capabilities gated behind the Basic API Access application rather than behind OAuth. */
export function isBusinessProfileCapability(capability: GoogleCapability): boolean {
  return capability !== 'gsc'
}

/**
 * Refresh-token lifetime while the OAuth consent screen is in Testing status.
 *
 * Seven days after consent, every refresh token issued by a Testing-status client dies with
 * `invalid_grant`. Both agents run on a weekly-ish cadence, so the failure presents as *"it worked
 * when we tested it and stopped the following week"*, repeatedly, with no correlated deploy. Until
 * the consent screen is published this is the normal case, not an edge case (docs/10 §4).
 *
 * A test in `@berelax/google` asserts this equals the value the OAuth fake expires tokens at, so the
 * fake and the tripwire cannot drift apart.
 */
export const TESTING_REFRESH_TOKEN_DAYS = 7

/**
 * Refresh the access token when it has less than this long to live.
 *
 * Proactive, never reactively on a 401: a reactive refresh wastes a round trip on every cron cycle
 * and fills the error taxonomy with 401s that mean nothing, which is how the one 401 that means the
 * grant died gets lost (docs/10 §4).
 */
export const ACCESS_TOKEN_REFRESH_MARGIN_MINUTES = 5

/**
 * How long without a successful authenticated call before the connection is no longer "Connected".
 *
 * 48 hours, matching the predictive-email threshold in docs/07 §6. The daily deep check runs at 03:00
 * and the liveness probe hourly, so two days of silence means many probes in a row found nothing —
 * *"Connected"* with no recency is exactly how silent failure hides.
 */
export const CONNECTION_STALE_AFTER_HOURS = 48

const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24

/** When a Testing-status grant's refresh token dies. Computable the moment consent is recorded. */
export function testingRefreshTokenExpiry(consentAt: Instant): Instant {
  return addMinutes(consentAt, TESTING_REFRESH_TOKEN_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR)
}

/** Whole hours between two instants, rounded down. Negative when `earlier` is in the future. */
export function hoursBetween(earlier: Instant, later: Instant): number {
  return Math.floor((later - earlier) / (MINUTES_PER_HOUR * 60_000))
}

/**
 * True when the cached access token should be replaced before the next call.
 *
 * A missing token is always due. So is an expired one — this is the only place that decides, so a
 * caller cannot accidentally use a token that expires mid-request.
 */
export function shouldRefreshAccessToken(args: {
  readonly accessExpiresAt: Instant | null
  readonly now: Instant
}): boolean {
  if (args.accessExpiresAt === null) return true
  return args.accessExpiresAt - args.now <= ACCESS_TOKEN_REFRESH_MARGIN_MINUTES * 60_000
}

/** Scopes a capability needs that the grant does not have. */
export function missingScopesFor(
  capabilities: readonly GoogleCapability[],
  grantedScopes: readonly string[],
): readonly string[] {
  const granted = new Set(grantedScopes)
  const missing = new Set<string>()
  for (const capability of capabilities) {
    const scope = CAPABILITY_SCOPE[capability]
    if (!granted.has(scope)) missing.add(scope)
  }
  return [...missing]
}

/**
 * The health a capability has purely from the granted scopes.
 *
 * `granted_scopes` is what Google **returned**, not what was requested: a consent screen where the
 * owner unticks one product returns fewer scopes with an otherwise successful exchange. Deriving
 * capability health from the request would leave the system convinced it has an access it does not
 * have, and the symptom would be a 403 on a cron job at 03:00 rather than an amber badge at consent.
 */
export function capabilityHealthFromScopes(
  capability: GoogleCapability,
  grantedScopes: readonly string[],
): 'ok' | 'permission_missing' {
  return grantedScopes.includes(CAPABILITY_SCOPE[capability]) ? 'ok' : 'permission_missing'
}

/**
 * The health a capability should carry immediately after a consent, which is not the same question.
 *
 * `capabilityHealthFromScopes` answers *"is the scope there"*. This answers *"what do we now know"*,
 * and the difference is `ok`. A fresh grant proves the owner ticked the product; it proves nothing
 * about the resource behind it — the listing may be unverified, the Business Profile quota may still
 * be zero, the Search Console property may belong to another account. Writing `ok` here would put a
 * green tick on a capability nothing has exercised, and the first thing that reads it is the panel
 * telling the owner everything is fine.
 *
 * So a granted scope resolves to `unknown` and the daily health check (G-CONN-06) decides. An
 * existing health survives, because a re-consent is not evidence that a previously observed failure
 * has gone away — except for `permission_missing`, which the consent has by definition just fixed.
 */
export function capabilityHealthAtConsent(args: {
  readonly capability: GoogleCapability
  readonly grantedScopes: readonly string[]
  /** Null for a capability that has no row yet. */
  readonly existingHealth: GoogleCapabilityHealth | null
}): GoogleCapabilityHealth {
  if (capabilityHealthFromScopes(args.capability, args.grantedScopes) === 'permission_missing') {
    return 'permission_missing'
  }
  if (args.existingHealth === null || args.existingHealth === 'permission_missing') return 'unknown'
  return args.existingHealth
}

export interface CapabilityState {
  readonly capability: GoogleCapability
  readonly health: GoogleCapabilityHealth
}

export interface ConnectionSnapshot {
  readonly status: GoogleConnectionStatus
  readonly consentAt: Instant
  /** Last successful authenticated call. Null when nothing has succeeded yet. */
  readonly lastOkAt: Instant | null
  readonly grantedScopes: readonly string[]
  readonly capabilities: readonly CapabilityState[]
  /**
   * Whether the OAuth consent screen is still in Testing status.
   *
   * Defaults to assuming it is, because Testing is the default state of every Cloud project and
   * therefore the result of not deciding. Assuming Production would silence the one tripwire that
   * catches the launch blocker.
   */
  readonly consentScreenInTesting: boolean
  /** Whether the Basic API Access application has been approved (quota moved 0 → 300 QPM). */
  readonly gbpAccessGranted: boolean
}

/** Why the owner is being emailed. Never more than one reason per evaluation. */
export type GoogleConnectionNotification = 'reauth_required' | 'predictive_warning'

export interface GoogleConnectionHealth {
  readonly displayState: GoogleConnectionDisplayState
  /** Null when nothing has ever succeeded; the panel then shows the consent time instead. */
  readonly hoursSinceLastSuccess: number | null
  readonly stale: boolean
  /** Null when the consent screen is published, because then there is no seven-day bomb to show. */
  readonly testingExpiresAt: Instant | null
  readonly hoursUntilTestingExpiry: number | null
  readonly expiringSoon: boolean
  /** Capabilities failing for a reason the owner can act on. */
  readonly failingCapabilities: readonly GoogleCapability[]
  /** Capabilities failing only because Google has not approved API access yet. Not the owner's fault. */
  readonly pendingGbpCapabilities: readonly GoogleCapability[]
  readonly missingScopes: readonly string[]
  readonly notify: GoogleConnectionNotification | null
}

const NOTHING_CONNECTED: GoogleConnectionHealth = {
  displayState: 'never_connected',
  hoursSinceLastSuccess: null,
  stale: false,
  testingExpiresAt: null,
  hoursUntilTestingExpiry: null,
  expiringSoon: false,
  failingCapabilities: [],
  pendingGbpCapabilities: [],
  missingScopes: [],
  notify: null,
}

interface PartitionedCapabilities {
  readonly failing: readonly GoogleCapability[]
  readonly pendingGbp: readonly GoogleCapability[]
}

/**
 * Splits failing capabilities into "the owner can do something" and "Google has not approved us yet".
 *
 * The second bucket is the launch-day normal and must not read as a fault. Business Profile access is
 * granted by application review, so a valid token with zero quota is the expected state for weeks.
 */
function partitionCapabilities(
  capabilities: readonly CapabilityState[],
  gbpAccessGranted: boolean,
): PartitionedCapabilities {
  const failing: GoogleCapability[] = []
  const pendingGbp: GoogleCapability[] = []
  for (const { capability, health } of capabilities) {
    if (health === 'ok') continue
    // `not_verified` is excluded deliberately: an unverified listing is not something Google's access
    // review will fix, so filing it under "waiting for approval" would leave it amber forever.
    const awaitingApproval =
      !gbpAccessGranted && isBusinessProfileCapability(capability) && health !== 'not_verified'
    if (awaitingApproval) pendingGbp.push(capability)
    else failing.push(capability)
  }
  return { failing, pendingGbp }
}

/** The precedence order, in one expression so it can be read top to bottom. */
function chooseDisplayState(args: {
  readonly status: GoogleConnectionStatus
  readonly stale: boolean
  readonly expiringSoon: boolean
  readonly capabilities: PartitionedCapabilities
}): GoogleConnectionDisplayState {
  if (args.status === 'needs_reauth' || args.status === 'revoked') return 'broken'
  if (args.capabilities.failing.length > 0 || args.stale) return 'degraded'
  if (args.capabilities.pendingGbp.length > 0) return 'pending_gbp_approval'
  if (args.expiringSoon) return 'expiring_soon'
  return 'healthy'
}

/**
 * The one derivation. The settings panel, the badge, the banner and every email read this.
 *
 * Precedence, and the reasoning for the order:
 *
 *  1. **broken** — the grant is gone (`needs_reauth` or `revoked`). Nothing else matters.
 *  2. **degraded** — a capability is failing for a reason the owner can act on, *or* nothing has
 *     succeeded within the staleness window. An active grant with no recent success is not
 *     `healthy`: that is precisely the silent failure being designed out, and the banner shows for
 *     `degraded`, so the owner is told.
 *  3. **pending_gbp_approval** — the only failures are Business Profile capabilities waiting on
 *     Google's application review. Amber, expected, and deliberately ranked below a real failure so
 *     a genuine problem is never hidden behind the launch-day normal.
 *  4. **expiring_soon** — a computable Testing expiry within the staleness window. Drives the
 *     predictive email rather than the banner: nothing is broken yet, which is the whole point of
 *     sending it.
 *  5. **healthy**.
 *
 * `disconnected` maps to `never_connected` rather than to `broken`: the owner did it on purpose, and
 * a state that emails them daily about their own deliberate action trains them to ignore the emails.
 */
export function deriveConnectionHealth(
  connection: ConnectionSnapshot | null,
  now: Instant,
): GoogleConnectionHealth {
  if (connection === null || connection.status === 'disconnected') return NOTHING_CONNECTED

  const hoursSinceLastSuccess =
    connection.lastOkAt === null ? null : hoursBetween(connection.lastOkAt, now)
  // A connection consented ten minutes ago has no successful call yet and is not stale. Falling back
  // to consentAt is what stops a brand-new connection reading as degraded the moment it is created.
  const stale =
    hoursBetween(connection.lastOkAt ?? connection.consentAt, now) >= CONNECTION_STALE_AFTER_HOURS

  const testingExpiresAt = connection.consentScreenInTesting
    ? testingRefreshTokenExpiry(connection.consentAt)
    : null
  const hoursUntilTestingExpiry =
    testingExpiresAt === null ? null : hoursBetween(now, testingExpiresAt)
  const expiringSoon =
    hoursUntilTestingExpiry !== null && hoursUntilTestingExpiry <= CONNECTION_STALE_AFTER_HOURS

  const capabilities = partitionCapabilities(connection.capabilities, connection.gbpAccessGranted)
  const displayState = chooseDisplayState({
    status: connection.status,
    stale,
    expiringSoon,
    capabilities,
  })

  // One reason, not a list. An email that reports three things gets read as one thing.
  const notify: GoogleConnectionNotification | null =
    displayState === 'broken'
      ? 'reauth_required'
      : stale || expiringSoon
        ? 'predictive_warning'
        : null

  return {
    displayState,
    hoursSinceLastSuccess,
    stale,
    testingExpiresAt,
    hoursUntilTestingExpiry,
    expiringSoon,
    failingCapabilities: capabilities.failing,
    pendingGbpCapabilities: capabilities.pendingGbp,
    missingScopes: missingScopesFor(
      connection.capabilities.map((c) => c.capability),
      connection.grantedScopes,
    ),
    notify,
  }
}

/**
 * Why a grant stopped working, in the only vocabulary the connection state machine understands.
 *
 * `transient` is the default for anything unrecognised. An unmapped upstream code must not be
 * swallowed into `invalid_grant`, because that would mark a working connection as needing re-auth on
 * the strength of a network blip and send the owner through a consent flow for nothing.
 */
export type GoogleGrantFailure =
  | 'invalid_grant'
  | 'access_not_granted'
  | 'admin_policy_enforced'
  | 'quota_zero'
  | 'rate_limited'
  | 'transient'

/**
 * The append-only event vocabulary, matching the CHECK constraint in migration 0016.
 *
 * Kept here rather than in the database package so the state machine and the table cannot disagree
 * about what is recordable; the migration's constraint is the enforcement, this is the type.
 */
export type GoogleConnectionEventName =
  | 'connected'
  | 'reconnected'
  | 'refreshed'
  | 'refresh_failed'
  | 'reauth_required'
  | 'revoked'
  | 'disconnected'
  | 'scopes_changed'
  | 'capability_changed'
  | 'health_check_ok'
  | 'health_check_failed'
  | 'token_rewrapped'

export interface ConnectionTransition {
  readonly status: GoogleConnectionStatus
  readonly statusReason: string | null
  /** The event to append to `google_connection_events`, or null when nothing changed. */
  readonly event: GoogleConnectionEventName | null
  readonly notify: GoogleConnectionNotification | null
}

/**
 * The state transition for a failed authenticated call.
 *
 * Only `invalid_grant` kills the grant. Everything else leaves the status alone and records the
 * failure, because the alternative — treating a quota error or a 500 as a dead token — sends the
 * owner through a re-consent that fixes nothing and teaches them the notification is noise.
 *
 * The notification is deduped here rather than in the mailer: the first `invalid_grant` emails, and a
 * connection already in `needs_reauth` does not email again. Without that, a pg-boss queue with three
 * Google jobs sends three identical emails per cycle, and docs/07 §6 is explicit that it must be one
 * per incident.
 */
export function applyGrantFailure(
  current: { readonly status: GoogleConnectionStatus; readonly statusReason: string | null },
  failure: GoogleGrantFailure,
): ConnectionTransition {
  if (failure !== 'invalid_grant') {
    return {
      status: current.status,
      statusReason: current.statusReason,
      event: 'health_check_failed',
      notify: null,
    }
  }
  const alreadyDead = current.status === 'needs_reauth' || current.status === 'revoked'
  return {
    status: 'needs_reauth',
    statusReason: 'invalid_grant',
    event: alreadyDead ? 'refresh_failed' : 'reauth_required',
    notify: alreadyDead ? null : 'reauth_required',
  }
}

/**
 * The transition for a successful refresh.
 *
 * A grant that was `needs_reauth` and now refreshes is back: the owner re-consented, or a transient
 * revocation resolved. Recording that as still-broken would leave the banner up on a working
 * connection, which is the same credibility problem as a false alarm.
 */
export function applyRefreshSuccess(current: {
  readonly status: GoogleConnectionStatus
}): ConnectionTransition {
  if (current.status === 'disconnected') {
    // A disconnected connection must not resurrect itself from a stray job. Offboarding revoked the
    // token at Google on purpose; reviving the row here would hide that from whoever runs the
    // business next.
    throw new AppError(
      'invariant_violated',
      'A disconnected Google connection cannot be refreshed. Re-consent creates a new grant.',
    )
  }
  return { status: 'active', statusReason: null, event: 'refreshed', notify: null }
}

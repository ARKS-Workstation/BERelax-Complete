import type { GoogleCapabilityHealth } from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel: the barrel re-exports the SMS and email ports,
// which puts `messaging-providers-only-inside-a-transport` one hop away.
import { type FailureMode, failureModeOf, isRetryable } from '@berelax/providers/failure'
import { AppError, type ErrorKind } from '@berelax/shared'

/**
 * The Google error taxonomy: seven named classes, and nothing that falls outside them.
 *
 * ## Why a taxonomy and not an `if` chain
 *
 * Every one of these seven needs a *different* response, and four of them look identical from a stack
 * trace. A quota of zero and a revoked grant are both a failed call with a 403; one is the launch-day
 * normal for six weeks and the other is an email to the owner. An `if` chain with a silent `else` puts
 * them in the same bucket, and the bucket is named after whichever case was written first.
 *
 * So the classification is a total function and its default is **`TransientUpstream`, never a swallow**.
 * An upstream code nobody has seen before means *"this call failed and we do not know why"*, which is a
 * thing a retry may fix — and that is the opposite of `GoogleReauthRequired`, which sends the owner
 * through a consent flow. Defaulting the wrong way is how a DNS blip costs the owner a re-consent, and an
 * owner who re-consented for nothing once ignores the next notification.
 *
 * ## The one class that is a residue rather than a diagnosis
 *
 * `TransientUpstream` carries `retryable` in its details rather than in its name. The taxonomy docs/10
 * closes has no class for *"the provider rejected the request and will reject it again"* — a malformed
 * write, an invalid resource name — so `rejected` lands here too. Naming the class after the retry
 * decision would therefore be a lie in exactly one case, so the retry decision travels separately and
 * `isRetryable` from the failure script is its single source.
 */
export const GOOGLE_ERROR_CLASSES = [
  'GoogleReauthRequired',
  'AccessNotGranted',
  'QuotaZero',
  'RateLimited',
  'ListingNotVerified',
  'AdminPolicyEnforced',
  'TransientUpstream',
] as const

export type GoogleErrorClass = (typeof GOOGLE_ERROR_CLASSES)[number]

/**
 * Every fake fault code, mapped to exactly one class.
 *
 * `Record<FailureMode, …>` rather than a `switch`, so a failure mode added to the shared script is a
 * **compile error** here until somebody decides which class it belongs to. A `switch` with a `default`
 * would silently file it under `TransientUpstream`, and the one that would arrive that way is
 * `admin_policy_enforced` — a permanent org-wide refusal reported as something a retry might fix.
 */
export const FAILURE_MODE_CLASS: Readonly<Record<FailureMode, GoogleErrorClass>> = {
  invalid_grant: 'GoogleReauthRequired',
  access_not_granted: 'AccessNotGranted',
  quota_exhausted: 'QuotaZero',
  rate_limited: 'RateLimited',
  not_verified: 'ListingNotVerified',
  admin_policy_enforced: 'AdminPolicyEnforced',
  // Neither is a diagnosis of anything about the connection: both are "the call did not land".
  timeout: 'TransientUpstream',
  server_error: 'TransientUpstream',
  // A rejected request is NOT transient, and this is the taxonomy's one rough edge — see the header.
  // Filed here because the seven classes are closed and the retry decision is carried separately.
  rejected: 'TransientUpstream',
}

/**
 * The upstream codes the real Google APIs return, mapped to the same seven classes.
 *
 * Matched as **whole codes**, case-insensitively, never as substrings. A substring match is how
 * `webmasters` came to condemn `webmasters.readonly` in the scope checker, and the natural fix for that
 * false positive is to delete the check.
 *
 * `google_reauth_required` is in here because it is ours, not Google's: `googleReauthRequired` in
 * `lifecycle.ts` raises it when the stored grant is already dead, and a chokepoint that could not
 * recognise its own package's error would degrade the one case it exists to degrade as a transient blip.
 */
export const UPSTREAM_CODE_CLASS: Readonly<Record<string, GoogleErrorClass>> = {
  google_reauth_required: 'GoogleReauthRequired',
  invalid_grant: 'GoogleReauthRequired',
  unauthenticated: 'GoogleReauthRequired',
  access_not_granted: 'AccessNotGranted',
  accessnotconfigured: 'AccessNotGranted',
  service_disabled: 'AccessNotGranted',
  permission_denied: 'AccessNotGranted',
  resource_exhausted: 'QuotaZero',
  quotaexceeded: 'QuotaZero',
  dailylimitexceeded: 'QuotaZero',
  ratelimitexceeded: 'RateLimited',
  userratelimitexceeded: 'RateLimited',
  rate_limit_exceeded: 'RateLimited',
  not_verified: 'ListingNotVerified',
  notverified: 'ListingNotVerified',
  location_not_verified: 'ListingNotVerified',
  admin_policy_enforced: 'AdminPolicyEnforced',
  adminpolicyenforced: 'AdminPolicyEnforced',
}

/**
 * Whether a class is the consumer's to survive or the queue's to retry.
 *
 * The rule, in one sentence: **a failure the next attempt cannot fix degrades; a failure the next
 * attempt might fix throws**, so pg-boss retries it with backoff.
 *
 * docs/10 §4 names `GoogleReauthRequired` and `AccessNotGranted` explicitly. The other three that
 * degrade are the same argument with a different cause and would be perverse to treat differently: a
 * Business Profile quota of zero is the expected state for weeks after launch, an unverified listing
 * needs the owner to verify it, and a Workspace admin restriction needs the admin. Retrying any of them
 * every six hours produces a failed job every six hours for six weeks and no reply drafts — and the whole
 * argument of docs/10 §6 is that the fallback *is* the launch mode.
 *
 * A total record rather than a set, so a new class cannot be added without deciding.
 */
export const DEGRADES: Readonly<Record<GoogleErrorClass, boolean>> = {
  GoogleReauthRequired: true,
  AccessNotGranted: true,
  QuotaZero: true,
  ListingNotVerified: true,
  AdminPolicyEnforced: true,
  // Retryable, and short-lived. Degrading here would turn a sixty-second wait into a day of draft-only.
  RateLimited: false,
  TransientUpstream: false,
}

/**
 * The capability health a class is evidence for, or null when it is evidence of nothing.
 *
 * `RateLimited` and `TransientUpstream` return null deliberately. A blip is not evidence that a
 * capability is broken, and writing one would put an amber badge on a working capability on the strength
 * of a dropped connection — the same argument that stops `applyGrantFailure` killing a grant on a 500.
 *
 * `GoogleReauthRequired` also returns null: the grant is what died, not the capability, and the
 * connection's own `status` already says so. Marking every capability `permission_missing` on a dead
 * grant would leave them all wrong after a successful re-consent.
 */
export function capabilityHealthFor(errorClass: GoogleErrorClass): GoogleCapabilityHealth | null {
  switch (errorClass) {
    case 'AccessNotGranted':
    case 'QuotaZero':
      // Both are "a valid token with no quota behind it", which is what quota_zero means and what the
      // panel renders as *Business Profile access pending Google approval* (docs/10 §4).
      return 'quota_zero'
    case 'ListingNotVerified':
      return 'not_verified'
    case 'AdminPolicyEnforced':
      // The service is Restricted for the organisation, so the permission genuinely is absent — and
      // unlike quota_zero, no approval from Google will change it.
      return 'permission_missing'
    default:
      return null
  }
}

/**
 * A token-free label for what actually failed, for the ledger row and the log line.
 *
 * `googleCallError` deliberately does not carry the upstream message or its `cause`, because an upstream
 * library that built its message from the request would carry an `Authorization: Bearer` header into every
 * log line and Sentry issue that quotes it. The cost of that is real: a `TransientUpstream` with nothing
 * else attached tells an operator only that something they cannot name went wrong. It cost an hour of
 * this unit's own debugging.
 *
 * So this carries the parts that cannot be a secret **by construction**, rather than a redacted message:
 *
 *   - the error's class name, which is `PostgresError` or `AppError` or `TypeError`;
 *   - `AppError.kind`, a closed union from `@berelax/shared`;
 *   - the injected failure mode, validated against the closed `FAILURE_MODES` list;
 *   - and a five-character **SQLSTATE**, matched against `/^[0-9A-Z]{5}$/` and nothing else. `53300` is
 *     `too_many_connections`, and it is the single value that would have named the problem immediately.
 *
 * The SQLSTATE pattern is the load-bearing part. A bearer credential is not five uppercase alphanumerics,
 * so a token in `error.code` cannot pass the guard — which a truncating redaction would not have given:
 * the first 64 characters of a token are still most of a token. A test feeds it a token-shaped `code` and
 * asserts nothing comes back.
 */
export interface UpstreamFingerprint {
  readonly upstreamKind: string
  readonly errorKind: ErrorKind | null
  readonly failureMode: FailureMode | null
  readonly sqlState: string | null
}

const SQLSTATE = /^[0-9A-Z]{5}$/

export function upstreamFingerprint(error: unknown): UpstreamFingerprint {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  return {
    upstreamKind:
      typeof error === 'object' && error !== null ? error.constructor.name : typeof error,
    errorKind: error instanceof AppError ? error.kind : null,
    failureMode: failureModeOf(error) ?? null,
    sqlState: typeof code === 'string' && SQLSTATE.test(code) ? code : null,
  }
}

/** The upstream code carried by an error, from any of the places one actually arrives. */
function upstreamCodeOf(error: unknown): string | undefined {
  const candidates: unknown[] = []
  if (error instanceof AppError) {
    candidates.push(
      error.details['upstreamCode'],
      error.details['reason'],
      error.details['status'],
      error.details['code'],
    )
  }
  if (typeof error === 'object' && error !== null) {
    candidates.push((error as { code?: unknown }).code, (error as { reason?: unknown }).reason)
  }
  return candidates.find((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Classifies anything into exactly one of the seven classes. Total, and never throws.
 *
 * Order matters. The injected failure mode wins over an upstream code because a fake arming
 * `access_not_granted` also sets `kind: 'forbidden'`, and a classifier that read the HTTP-ish shape
 * first would collapse every 403 into one class.
 */
export function classifyGoogleError(error: unknown): GoogleErrorClass {
  const mode = failureModeOf(error)
  if (mode !== undefined) return FAILURE_MODE_CLASS[mode]

  const code = upstreamCodeOf(error)
  if (code !== undefined) {
    const mapped = UPSTREAM_CODE_CLASS[code.toLowerCase()]
    if (mapped !== undefined) return mapped
  }

  // The default, and the whole point of the file. An unmapped code is not swallowed into whichever class
  // is nearest; it is named as what it is — an upstream failure we cannot explain.
  return 'TransientUpstream'
}

/** Whether the next attempt could plausibly succeed. Drives pg-boss's retry, never the class name. */
export function isRetryableGoogleError(error: unknown): boolean {
  const mode = failureModeOf(error)
  if (mode !== undefined) return isRetryable(mode)
  // An unmapped failure is retried once by the queue rather than declared permanent, for the same reason
  // it classifies as transient: the alternative is a permanent verdict on no evidence.
  return classifyGoogleError(error) !== 'GoogleReauthRequired'
}

/**
 * The error a consumer sees for a class that does not degrade.
 *
 * The message is assembled from the class name, the capability and the correlation id — three values
 * this system generated. **The upstream message is deliberately not concatenated in**: Google's client
 * libraries have been known to build an error string from the request that produced it, and a request
 * carrying an `Authorization: Bearer` header would then carry the access token into every log line, every
 * Sentry issue and every serialised stack trace that quotes it (docs/10 §4).
 */
export function googleCallError(args: {
  readonly errorClass: GoogleErrorClass
  readonly capability: string
  readonly correlationId: string
  readonly connectionId: string | null
  readonly retryable: boolean
}): AppError {
  return new AppError(
    args.errorClass === 'RateLimited' ? 'rate_limited' : 'provider_unavailable',
    `Google ${args.capability} call failed: ${args.errorClass} ` +
      `(correlation ${args.correlationId}).`,
    {
      details: {
        errorClass: args.errorClass,
        capability: args.capability,
        correlationId: args.correlationId,
        connectionId: args.connectionId,
        retryable: args.retryable,
      },
    },
  )
}

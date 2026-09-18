/**
 * Failure injection, shared by every fake.
 *
 * A fake that only ever succeeds hides every error path, and the error paths are most of the work
 * (docs/12 §1.2). So each fake declares the failures its real counterpart actually produces, and any
 * of them can be armed on demand — from a test, and from an admin screen, so an operator can see
 * what a rate limit looks like before the day it happens.
 *
 * The modes are not invented. Each is a documented failure of the service it stands in for:
 *
 * | Mode | Real counterpart |
 * |---|---|
 * | `rate_limited` | SMSala throttling; Resend's per-second cap; Google's per-minute quota |
 * | `rejected` | An invalid recipient, a suspended sender ID, a hard bounce |
 * | `invalid_grant` | An OAuth refresh token revoked, expired, or aged out of Testing status |
 * | `quota_exhausted` | A Google API daily quota at zero |
 * | `access_not_granted` | The Business Profile API allowlist not yet approved |
 * | `not_verified` | A Business Profile listing that is not verified with Google (Voice of Merchant) |
 * | `admin_policy_enforced` | A Workspace admin marking the service Restricted for the whole org |
 * | `timeout` | The request that neither succeeds nor fails |
 * | `server_error` | The provider's own 5xx |
 *
 * Failures are scripted rather than random. A fake that fails 5% of the time makes a test suite
 * flaky, which trains everyone to re-run it — the opposite of what an error path is for.
 */
import { AppError, type ErrorKind } from '@berelax/shared'

export const FAILURE_MODES = [
  'rate_limited',
  'rejected',
  'invalid_grant',
  'quota_exhausted',
  'access_not_granted',
  // The two that only Google produces, added for G-CONN-03's taxonomy. Both are in docs/10 — §4 lists
  // a Workspace admin marking a service Restricted, and §4's state list names *Listing not verified with
  // Google* — and neither could be reached from a test before, which meant two of the seven taxonomy
  // classes were reachable only by constructing an error by hand. A class no fake can produce is a class
  // whose handling is unproven.
  'not_verified',
  'admin_policy_enforced',
  'timeout',
  'server_error',
] as const

export type FailureMode = (typeof FAILURE_MODES)[number]

interface FailureShape {
  readonly kind: ErrorKind
  readonly message: string
  /** True when a caller should retry after a delay rather than treat it as final. */
  readonly retryable: boolean
}

const SHAPES: Readonly<Record<FailureMode, FailureShape>> = {
  rate_limited: {
    kind: 'rate_limited',
    message: 'Rate limit exceeded. Retry after the provider-specified interval.',
    retryable: true,
  },
  rejected: {
    kind: 'validation',
    message: 'The provider rejected the request: invalid recipient, sender or payload.',
    retryable: false,
  },
  invalid_grant: {
    kind: 'unauthenticated',
    message:
      'invalid_grant: the refresh token is revoked, expired, or was issued to an OAuth client in ' +
      'Testing status and has aged out after seven days. Re-consent is required.',
    retryable: false,
  },
  quota_exhausted: {
    kind: 'rate_limited',
    message: 'Daily quota exhausted. The call cannot succeed again until the quota window resets.',
    retryable: false,
  },
  access_not_granted: {
    kind: 'forbidden',
    message:
      'The API is not enabled for this project. Access is granted by application review, not by ' +
      'enabling the API in the console.',
    retryable: false,
  },
  not_verified: {
    kind: 'forbidden',
    message:
      'The Business Profile listing is not verified with Google, so the resource behind this ' +
      'capability cannot be read or written. Verification is an owner action, not a retry.',
    retryable: false,
  },
  admin_policy_enforced: {
    kind: 'forbidden',
    message:
      'admin_policy_enforced: a Google Workspace administrator has marked this service Restricted ' +
      'for the organisation. It surfaces at authorisation, before any token exists.',
    retryable: false,
  },
  timeout: {
    kind: 'provider_unavailable',
    message: 'The provider did not respond before the deadline. The request may still have landed.',
    retryable: true,
  },
  server_error: {
    kind: 'provider_unavailable',
    message: 'The provider returned an internal error.',
    retryable: true,
  },
}

/** True when a caller should retry this failure rather than give up on it. */
export function isRetryable(mode: FailureMode): boolean {
  return SHAPES[mode].retryable
}

/**
 * Builds the error a fake throws, shaped like the real provider's.
 *
 * The failure mode and its retryability travel in `details` rather than only in the message, so a
 * retry policy can branch on them without parsing prose.
 */
export function failureError(provider: string, mode: FailureMode): AppError {
  const shape = SHAPES[mode]
  return new AppError(shape.kind, `${provider}: ${shape.message}`, {
    details: { provider, failureMode: mode, retryable: shape.retryable },
  })
}

/** The failure mode carried by an error a fake threw, if it was one. */
export function failureModeOf(error: unknown): FailureMode | undefined {
  if (!(error instanceof AppError)) return undefined
  const mode = error.details['failureMode']
  return typeof mode === 'string' && (FAILURE_MODES as readonly string[]).includes(mode)
    ? (mode as FailureMode)
    : undefined
}

/**
 * A scripted sequence of failures.
 *
 * `failNext(mode, times)` arms a finite number of calls, which is how a retry path is tested: arm
 * two rate limits, assert the third attempt succeeds. `failAlways(mode)` arms every call, which is
 * how a dead-end is tested. `clear()` disarms.
 */
export class FailureScript {
  private queued: FailureMode[] = []
  private persistent: FailureMode | undefined

  /** Arm `times` consecutive calls to fail with `mode`. */
  failNext(mode: FailureMode, times = 1): this {
    for (let i = 0; i < times; i += 1) this.queued.push(mode)
    return this
  }

  /** Arm every subsequent call to fail, until cleared. */
  failAlways(mode: FailureMode): this {
    this.persistent = mode
    return this
  }

  clear(): this {
    this.queued = []
    this.persistent = undefined
    return this
  }

  /** True when at least one call is still armed to fail. */
  get armed(): boolean {
    return this.queued.length > 0 || this.persistent !== undefined
  }

  /**
   * Consumes one scripted failure, if any.
   *
   * Queued failures are consumed before the persistent one, so `failNext` then `failAlways` reads
   * in the order it was written.
   */
  take(): FailureMode | undefined {
    const queued = this.queued.shift()
    if (queued !== undefined) return queued
    return this.persistent
  }
}

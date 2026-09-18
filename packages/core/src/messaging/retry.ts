/**
 * How many times a failed send is attempted, and how long the waits are.
 *
 * Pure arithmetic over a declared table, in `core`, because every part of it is a decision somebody
 * will want to read without reading a worker: how many attempts a rate limit gets, how long the third
 * wait is, and which failures are not retried at all.
 *
 * ## Why a rejection is capped at one attempt and a rate limit is not
 *
 * `@berelax/providers`' failure taxonomy already answers this and it is the answer that matters:
 * `rejected` carries `retryable: false`, because a rejection is an invalid recipient, a malformed
 * payload or a suspended sender identity. None of those changes in sixty seconds, so a retry is a
 * second charge for a guaranteed failure — and on a suspended promotional identity, a retry loop is a
 * few thousand of them. `rate_limited` carries `retryable: true`, because waiting is literally the
 * remedy the vendor asked for.
 *
 * So the attempt cap is **per failure reason**, and the two named in B-MSG-04's acceptance criterion
 * have different caps on purpose: a rejection is attempted once and is terminal, a rate limit is
 * attempted three times with a growing wait and is terminal after the third. `attemptCapFor` is what
 * the tests assert exact attempt counts against, and it is one table rather than a number buried in a
 * worker.
 *
 * ## Why the backoff is a declared list rather than a formula
 *
 * `2 ** attempt * base` reads as a decision and is not one: nobody chose 8 minutes, it fell out of the
 * exponent. The waits here were chosen — one minute, then five, because SMSala's throttle is per-second
 * and Resend's is per-second-per-domain, so a minute clears both and five minutes clears a queue that
 * built up behind an outage. A list also cannot produce a four-hour wait from an off-by-one.
 */
import type { MessageFailureReason } from '@berelax/shared'
import { type Instant, instantToIso } from '../time.ts'

/** The retry policy for one failure reason. */
export interface RetryPolicy {
  /**
   * Total attempts, the first one included. `1` means no retry.
   *
   * Counted as attempts rather than retries deliberately: `attempts` on the message row is what this
   * is compared against, and "3 retries" and "3 attempts" differ by one in exactly the place an
   * off-by-one is invisible.
   */
  readonly maxAttempts: number
  /**
   * The wait before attempt 2, 3, … in seconds. `waitsSeconds[0]` precedes the second attempt.
   *
   * Length is `maxAttempts - 1`, asserted by `assertRetryPolicies` at import: a policy with fewer
   * waits than attempts would schedule the last retry immediately, which is the retry storm the
   * backoff exists to prevent.
   */
  readonly waitsSeconds: readonly number[]
  /** Why this reason has this cap. Read by a person deciding whether to change it. */
  readonly why: string
}

export const MESSAGE_RETRY_POLICY: Readonly<Record<MessageFailureReason, RetryPolicy>> = {
  provider_rejected: {
    maxAttempts: 1,
    waitsSeconds: [],
    why:
      'An invalid recipient, a malformed payload or a suspended sender identity. None of those ' +
      'changes on a retry, so a second attempt is a second charge for the same guaranteed failure — ' +
      'and against a suspended promotional identity a retry loop is thousands of them (ADR 0016).',
  },
  provider_rate_limited: {
    maxAttempts: 3,
    waitsSeconds: [60, 300],
    why:
      'Waiting is the remedy the vendor asked for. One minute clears a per-second throttle; five ' +
      'clears a queue that built up behind one. Three attempts, because a limit still firing after ' +
      'six minutes is an account problem a human has to see rather than a wait to lengthen.',
  },
  provider_unavailable: {
    maxAttempts: 3,
    waitsSeconds: [60, 300],
    why:
      'A timeout or a 5xx. The same waits as a rate limit, and the same cap: the request may have ' +
      'landed, so the idempotency key is what makes the retry safe rather than the delay.',
  },
  provider_error: {
    maxAttempts: 1,
    waitsSeconds: [],
    why:
      'A failure nobody has classified — including a transport that threw instead of returning an ' +
      'outcome. Not retried, for the same reason an unrecognised vendor status does not become ' +
      'delivered: an unclassified failure is not one anybody should be automatically repeating.',
  },
}

/**
 * Validates the table at import, where a deploy fails and somebody is watching.
 *
 * The alternative is discovering a policy with no wait for its second attempt on the night a vendor
 * throttles, which is also the night the loop is at its most expensive.
 */
export function assertRetryPolicies(
  policies: Readonly<Record<MessageFailureReason, RetryPolicy>> = MESSAGE_RETRY_POLICY,
): void {
  for (const [reason, policy] of Object.entries(policies)) {
    if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
      throw new Error(
        `${reason}: maxAttempts must be a whole number of at least 1, received ${policy.maxAttempts}. ` +
          'A cap below one is a message that is never attempted at all.',
      )
    }
    if (policy.waitsSeconds.length !== policy.maxAttempts - 1) {
      throw new Error(
        `${reason}: ${policy.maxAttempts} attempt(s) need ${policy.maxAttempts - 1} wait(s), ` +
          `found ${policy.waitsSeconds.length}. A missing wait schedules that retry immediately.`,
      )
    }
    for (const wait of policy.waitsSeconds) {
      if (!Number.isInteger(wait) || wait < 1) {
        throw new Error(
          `${reason}: every wait must be a whole number of seconds, received ${wait}.`,
        )
      }
    }
    if (policy.why.trim().length === 0) {
      throw new Error(`${reason}: a cap with no reason is one nobody dares change.`)
    }
  }
}

assertRetryPolicies()

/** Total attempts allowed for a reason, the first attempt included. */
export function attemptCapFor(reason: MessageFailureReason): number {
  return MESSAGE_RETRY_POLICY[reason].maxAttempts
}

/**
 * What happens after an attempt failed.
 *
 * `attemptsSoFar` is the attempt count *including* the one that just failed, which is what the message
 * row holds after it is incremented. A `retry` decision carries the instant the next attempt may run;
 * `exhausted` means the row becomes terminally failed.
 */
export type RetryDecision =
  | { readonly kind: 'retry'; readonly attempt: number; readonly atIso: string }
  | { readonly kind: 'exhausted'; readonly attempts: number; readonly cap: number }

export function decideRetry(args: {
  readonly reason: MessageFailureReason
  readonly attemptsSoFar: number
  readonly failedAt: Instant
}): RetryDecision {
  const policy = MESSAGE_RETRY_POLICY[args.reason]
  if (args.attemptsSoFar >= policy.maxAttempts) {
    return { kind: 'exhausted', attempts: args.attemptsSoFar, cap: policy.maxAttempts }
  }
  // The wait before the NEXT attempt: after attempt 1 that is `waitsSeconds[0]`.
  const wait = policy.waitsSeconds[args.attemptsSoFar - 1]
  if (wait === undefined) {
    // Unreachable while `assertRetryPolicies` holds, and not an implicit zero: a missing wait is a
    // retry storm, and a thrown error is the only answer that cannot be mistaken for "retry now".
    throw new Error(
      `${args.reason}: no declared wait before attempt ${args.attemptsSoFar + 1} of ` +
        `${policy.maxAttempts}. MESSAGE_RETRY_POLICY is inconsistent.`,
    )
  }
  return {
    kind: 'retry',
    attempt: args.attemptsSoFar + 1,
    atIso: instantToIso(addSeconds(args.failedAt, wait)),
  }
}

/**
 * The waits are in seconds and `addMinutes` is the only helper in `time.ts`.
 *
 * Kept local rather than added to `time.ts`: a backoff is the only thing in this system measured in
 * seconds — trading hours, reminders and accrual are all minutes or longer — and a seconds helper in
 * the shared time module is an invitation to express a duration in the unit that reads smallest.
 */
function addSeconds(instant: Instant, seconds: number): Instant {
  return (instant + seconds * 1000) as Instant
}

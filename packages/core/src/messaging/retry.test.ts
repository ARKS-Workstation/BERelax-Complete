/**
 * The retry policy: the exact attempt counts B-MSG-04's acceptance criterion asks for, and the waits.
 *
 * Every assertion here is paired with a control that must fail the other way. "A rejection is attempted
 * once" is satisfied by a policy table that caps everything at one, so the rate-limited cap is asserted
 * beside it; "the declared waits are 60 and 300" is satisfied by a `decideRetry` that ignores the table,
 * so the instants are asserted, and a table with a missing wait is asserted to be rejected rather than
 * silently scheduling the retry immediately.
 */
import { describe, expect, it } from 'vitest'
import { instantFromIso, instantToIso } from '../time.ts'
import {
  assertRetryPolicies,
  attemptCapFor,
  decideRetry,
  MESSAGE_RETRY_POLICY,
  type RetryPolicy,
} from './retry.ts'

const FAILED_AT = '2026-09-18T10:00:00.000Z'

describe('the declared caps', () => {
  it('attempts a rejection once and a rate limit three times', () => {
    // The two modes the acceptance criterion names, and they differ on purpose: a rejection is an
    // invalid recipient or a suspended identity, and neither changes on a retry.
    expect(attemptCapFor('provider_rejected')).toBe(1)
    expect(attemptCapFor('provider_rate_limited')).toBe(3)
    // The control. Without it a table that capped everything at 1 would satisfy the first line, and a
    // table that capped everything at 3 would satisfy the second.
    expect(attemptCapFor('provider_rejected')).not.toBe(attemptCapFor('provider_rate_limited'))
  })

  it('does not retry a failure nobody has classified', () => {
    // Same reasoning as an unrecognised vendor status: an unclassified failure is not one to repeat.
    expect(attemptCapFor('provider_error')).toBe(1)
    expect(attemptCapFor('provider_unavailable')).toBe(3)
  })

  it('gives every reason a wait per retry and a stated reason for its cap', () => {
    for (const [reason, policy] of Object.entries(MESSAGE_RETRY_POLICY)) {
      expect(policy.waitsSeconds.length, reason).toBe(policy.maxAttempts - 1)
      expect(policy.why.length, reason).toBeGreaterThan(40)
    }
  })
})

describe('the validator', () => {
  it('accepts the shipped table', () => {
    expect(() => assertRetryPolicies()).not.toThrow()
  })

  it('rejects a policy with fewer waits than retries', () => {
    // The control that makes the validator worth having: a missing wait schedules that retry
    // immediately, which is the retry storm the backoff exists to prevent.
    const broken: Record<string, RetryPolicy> = {
      ...MESSAGE_RETRY_POLICY,
      provider_rate_limited: { maxAttempts: 3, waitsSeconds: [60], why: 'x'.repeat(50) },
    }
    expect(() => assertRetryPolicies(broken as typeof MESSAGE_RETRY_POLICY)).toThrow(
      /need 2 wait\(s\), found 1/,
    )
  })

  it('rejects a cap below one, a fractional wait and an unexplained cap', () => {
    const with_ = (policy: RetryPolicy): typeof MESSAGE_RETRY_POLICY =>
      ({ ...MESSAGE_RETRY_POLICY, provider_error: policy }) as typeof MESSAGE_RETRY_POLICY
    expect(() =>
      assertRetryPolicies(with_({ maxAttempts: 0, waitsSeconds: [], why: 'x' })),
    ).toThrow(/at least 1/)
    expect(() =>
      assertRetryPolicies(with_({ maxAttempts: 2, waitsSeconds: [1.5], why: 'x'.repeat(50) })),
    ).toThrow(/whole number of seconds/)
    expect(() =>
      assertRetryPolicies(with_({ maxAttempts: 1, waitsSeconds: [], why: '  ' })),
    ).toThrow(/nobody dares change/)
  })
})

describe('what happens after an attempt failed', () => {
  it('exhausts a rejection on its first attempt', () => {
    expect(
      decideRetry({
        reason: 'provider_rejected',
        attemptsSoFar: 1,
        failedAt: instantFromIso(FAILED_AT),
      }),
    ).toEqual({ kind: 'exhausted', attempts: 1, cap: 1 })
  })

  it('schedules a rate limit at the declared waits and then exhausts it', () => {
    const at = (attemptsSoFar: number) =>
      decideRetry({
        reason: 'provider_rate_limited',
        attemptsSoFar,
        failedAt: instantFromIso(FAILED_AT),
      })
    // One minute, then five: chosen numbers, not `2 ** n`.
    expect(at(1)).toEqual({ kind: 'retry', attempt: 2, atIso: '2026-09-18T10:01:00.000Z' })
    expect(at(2)).toEqual({ kind: 'retry', attempt: 3, atIso: '2026-09-18T10:05:00.000Z' })
    expect(at(3)).toEqual({ kind: 'exhausted', attempts: 3, cap: 3 })
    // The control on the arithmetic: the second wait is five times the first, so a formula that
    // doubled would produce 10:02 and fail here.
    expect(at(2)).not.toEqual({ kind: 'retry', attempt: 3, atIso: '2026-09-18T10:02:00.000Z' })
  })

  it('measures the wait from the failure, not from the first attempt', () => {
    const later = instantFromIso('2026-09-18T10:10:00.000Z')
    const decision = decideRetry({
      reason: 'provider_unavailable',
      attemptsSoFar: 1,
      failedAt: later,
    })
    expect(decision).toEqual({ kind: 'retry', attempt: 2, atIso: '2026-09-18T10:11:00.000Z' })
    // And it is an instant, not a duration: the row stores a timestamptz.
    expect(instantToIso(later)).toBe('2026-09-18T10:10:00.000Z')
  })

  it('throws rather than retrying now when the table has no wait for the next attempt', () => {
    // Unreachable while `assertRetryPolicies` holds — which is why it is asserted: the alternative
    // spelling of this branch is `?? 0`, and a zero wait is an immediate retry loop.
    expect(() =>
      decideRetry({
        reason: 'provider_rejected',
        // A caller that lost count. The cap is 1, so there is no declared wait before attempt 1.
        attemptsSoFar: 0,
        failedAt: instantFromIso(FAILED_AT),
      }),
    ).toThrow(/no declared wait before attempt 1/)
  })
})

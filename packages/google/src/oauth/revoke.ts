import type { GoogleGrantFailure } from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel: the barrel is one hop from the SMS and email
// ports, and `messaging-providers-only-inside-a-transport` is a reachable rule. Same note as lifecycle.ts.
import { type FailureMode, failureModeOf } from '@berelax/providers/failure'
import { GOOGLE_REVOKE_ENDPOINT, type GoogleRevocation } from '@berelax/providers/google'

/**
 * What a revocation attempt *means* — and nothing that performs one.
 *
 * ## Why the judgement is a module of its own
 *
 * Because the ordering decision of the whole unit reduces to one question — *may we now erase the
 * credential?* — and that question must be answerable without a network, a database or a key. docs/10 §5
 * states the offboarding step as a single clause: *"disconnect in admin (revokes at Google and zeroises
 * the stored token)"*. Revoke first, zeroise second. The two half-failures are not symmetrical:
 *
 *   - **Zeroise first, revoke fails.** The grant is live at Google and the only credential that could
 *     kill it is gone. Nothing in this system can recover — a new consent mints a different grant, and
 *     the old one keeps full authority over the business's Google presence. The scope that reads reviews
 *     also rewrites the address and the opening hours (docs/10 §3).
 *   - **Revoke first, zeroise fails.** A dead token sits encrypted at rest. The lesser evil, and
 *     recoverable: the credential is worthless, and running the disconnect again is safe because Google
 *     answers a second revoke with `invalid_token`, which is `already_dead` below.
 *
 * So the safe order is revoke-then-zeroise, and the erasure is **conditional on a confirmed verdict**.
 * `zeroisationIsSafe` is the whole rule, in one function, tested without a database.
 *
 * ## Why the failure mapping here is not a copy of `grantFailureFromError`
 *
 * It looks like one and answers a different question. On the **refresh** endpoint `invalid_grant` means
 * *this grant has died* — a state change worth notifying about. On the **revocation** endpoint the same
 * rejection means *Google does not recognise this token*, which is the outcome a revocation is asking
 * for: there is nothing left to revoke. Reading it as a failure would make the retry loop for ever
 * against a grant that is already gone, and reading a 500 as success would zeroise the credential that
 * could still have killed a live grant. One error, two endpoints, two meanings — writing it once per
 * endpoint is the point rather than duplication.
 */

/** Re-exported so a caller and the runbook name one endpoint. docs/10 §5 names it by hand. */
export { GOOGLE_REVOKE_ENDPOINT }

/**
 * `status_reason` after a completed disconnect. The value the acceptance criterion names.
 *
 * `manual` rather than `revoked`: the *reason* the grant ended is that a human asked for it, which is
 * what an operator reading the row six months later needs to know. Whether Google confirmed it is
 * recorded in the append-only event, where it cannot be overwritten by the next status change.
 */
export const DISCONNECT_REASON_DONE = 'manual'

/**
 * `status_reason` on a disconnect whose revocation Google did not confirm.
 *
 * Load-bearing in the schema, not only in the UI: migration 0040's
 * `google_connections_revoke_retry_keeps_its_token` refuses to let a row carrying this reason have a NULL
 * ciphertext, because that ciphertext is the retry's only credential.
 */
export const DISCONNECT_REASON_REVOKE_FAILED = 'revoke_failed'

export type DisconnectStatusReason =
  | typeof DISCONNECT_REASON_DONE
  | typeof DISCONNECT_REASON_REVOKE_FAILED

/**
 * The three verdicts, as a closed set.
 *
 * `already_dead` is deliberately separate from `revoked` even though both permit erasure. An operator
 * auditing an offboarding needs to know whether *we* killed the grant or found it already gone — the
 * second answer means somebody else revoked it first, which is a different conversation about who has
 * been in the account.
 */
export const REVOKE_VERDICTS = ['revoked', 'already_dead', 'unconfirmed'] as const
export type RevokeVerdictKind = (typeof REVOKE_VERDICTS)[number]

export interface RevokeVerdict {
  readonly kind: RevokeVerdictKind
  /**
   * The provider failure behind an `unconfirmed` verdict, or null. Never an upstream message: an
   * upstream library that built its message from the request would carry an Authorization header into
   * the event row this ends up in (docs/10 §4).
   */
  readonly failureMode: FailureMode | null
  /**
   * The same failure in the state machine's vocabulary, so the event detail reads like every other
   * Google failure this system records rather than like a second private taxonomy.
   */
  readonly grantFailure: GoogleGrantFailure | null
}

/** The verdict for a revocation Google answered. Both answers mean the grant is gone. */
export function verdictForRevocation(revocation: GoogleRevocation): RevokeVerdict {
  return {
    kind: revocation === 'revoked' ? 'revoked' : 'already_dead',
    failureMode: null,
    grantFailure: null,
  }
}

/**
 * The verdict for a revocation that threw.
 *
 * `invalid_grant` and `access_not_granted` are `already_dead`: both are Google refusing the credential
 * itself, and a credential Google will not accept cannot be used against the business by anybody. A
 * quota error, a rate limit, a timeout and a 500 are `unconfirmed` — the grant may be perfectly alive,
 * which is exactly when the ciphertext must be kept.
 *
 * An unrecognised error is `unconfirmed`, never `already_dead`. Defaulting the other way would let a DNS
 * blip authorise the erasure of a live credential, and that is the unrecoverable half-failure.
 */
export function verdictForRevokeError(error: unknown): RevokeVerdict {
  const mode = failureModeOf(error)
  switch (mode) {
    case 'invalid_grant':
      return { kind: 'already_dead', failureMode: mode, grantFailure: 'invalid_grant' }
    case 'access_not_granted':
      return { kind: 'already_dead', failureMode: mode, grantFailure: 'access_not_granted' }
    case 'quota_exhausted':
      return { kind: 'unconfirmed', failureMode: mode, grantFailure: 'quota_zero' }
    case 'rate_limited':
      return { kind: 'unconfirmed', failureMode: mode, grantFailure: 'rate_limited' }
    default:
      return { kind: 'unconfirmed', failureMode: mode ?? null, grantFailure: 'transient' }
  }
}

/**
 * **The ordering rule.** True only when Google has accounted for the token.
 *
 * Every caller that erases a ciphertext asks this first, and it is the one function in the unit that must
 * never be inlined at a call site: an inlined `verdict.kind !== 'unconfirmed'` is a condition somebody
 * eventually writes the other way round, and the wrong way round is unrecoverable.
 */
export function zeroisationIsSafe(verdict: RevokeVerdict): boolean {
  return verdict.kind !== 'unconfirmed'
}

/** The `status_reason` a verdict writes. Derived from the verdict so the two cannot disagree. */
export function statusReasonFor(verdict: RevokeVerdict): DisconnectStatusReason {
  return zeroisationIsSafe(verdict) ? DISCONNECT_REASON_DONE : DISCONNECT_REASON_REVOKE_FAILED
}

/**
 * The event detail a verdict contributes, for `google_connection_events`.
 *
 * A closed set of values — verdict kind, failure mode, endpoint — so nothing here can be a secret. The
 * table's `google_connection_events_no_token` CHECK is the backstop; this is the reason it never fires.
 */
export function revokeDetail(verdict: RevokeVerdict): Readonly<Record<string, unknown>> {
  return {
    revokeVerdict: verdict.kind,
    revokeEndpoint: GOOGLE_REVOKE_ENDPOINT,
    ...(verdict.failureMode === null ? {} : { failureMode: verdict.failureMode }),
    ...(verdict.grantFailure === null ? {} : { failure: verdict.grantFailure }),
  }
}

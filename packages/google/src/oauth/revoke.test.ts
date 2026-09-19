import { FAILURE_MODES, failureError } from '@berelax/providers/failure'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  DISCONNECT_REASON_DONE,
  DISCONNECT_REASON_REVOKE_FAILED,
  GOOGLE_REVOKE_ENDPOINT,
  REVOKE_VERDICTS,
  revokeDetail,
  statusReasonFor,
  verdictForRevocation,
  verdictForRevokeError,
  zeroisationIsSafe,
} from './revoke.ts'

/**
 * The one decision the whole of G-CONN-09 reduces to: **may we erase the credential now?**
 *
 * It is worth testing on its own, with no database and no network, because the two ways of getting it
 * wrong are not equally bad and one of them cannot be undone:
 *
 *   - **Answering `true` when Google never confirmed** erases the only credential that could kill a live
 *     grant. Nothing in this system recovers from it; the remedy is a human signing in to Google.
 *   - **Answering `false` when the grant is already dead** leaves a worthless ciphertext and a retry that
 *     runs for ever against a token Google will never accept.
 *
 * So both directions are asserted, and the classifier is driven over **every** failure mode the fakes can
 * produce rather than over the three this unit happened to think of. A mode nobody mapped would fall to
 * the default, and the assertion below is that the default is the safe one.
 */

describe('a revocation Google answered', () => {
  it('reads a 200 as revoked, and erasure is safe', () => {
    const verdict = verdictForRevocation('revoked')
    expect(verdict.kind).toBe('revoked')
    expect(zeroisationIsSafe(verdict)).toBe(true)
    expect(statusReasonFor(verdict)).toBe(DISCONNECT_REASON_DONE)
  })

  it('reads invalid_token as already dead, and erasure is still safe', () => {
    // Google's 400 for a token it does not recognise. It is what a SECOND revoke of the same token gets,
    // which is the whole basis of the retry being repeatable — and treating it as a failure would make the
    // retry loop for ever against a grant that is already gone.
    const verdict = verdictForRevocation('already_revoked')
    expect(verdict.kind).toBe('already_dead')
    expect(zeroisationIsSafe(verdict)).toBe(true)
    expect(statusReasonFor(verdict)).toBe(DISCONNECT_REASON_DONE)
  })

  it('distinguishes the two even though both permit erasure', () => {
    // Not a cosmetic distinction. `already_dead` means somebody else revoked the grant before we did,
    // which is a different conversation about who has been in the account.
    expect(verdictForRevocation('revoked').kind).not.toBe(
      verdictForRevocation('already_revoked').kind,
    )
  })
})

describe('a revocation that threw', () => {
  it('reads a 500 as unconfirmed, and REFUSES erasure', () => {
    const verdict = verdictForRevokeError(failureError('google-oauth', 'server_error'))
    expect(verdict.kind).toBe('unconfirmed')
    expect(zeroisationIsSafe(verdict)).toBe(false)
    expect(statusReasonFor(verdict)).toBe(DISCONNECT_REASON_REVOKE_FAILED)
    expect(verdict.failureMode).toBe('server_error')
    expect(verdict.grantFailure).toBe('transient')
  })

  it('reads a timeout as unconfirmed — the request may still have landed', () => {
    const verdict = verdictForRevokeError(failureError('google-oauth', 'timeout'))
    expect(zeroisationIsSafe(verdict)).toBe(false)
  })

  it('reads invalid_grant as already dead: Google refused the credential itself', () => {
    // A credential Google will not accept cannot be used against the business by anybody, so there is
    // nothing left to protect and nothing left to revoke.
    const verdict = verdictForRevokeError(failureError('google-oauth', 'invalid_grant'))
    expect(verdict.kind).toBe('already_dead')
    expect(zeroisationIsSafe(verdict)).toBe(true)
    expect(verdict.grantFailure).toBe('invalid_grant')
  })

  it('reads a quota error as unconfirmed, not as dead', () => {
    // The tempting mistake: a 403 shaped like an authorisation failure. A quota of zero says nothing at
    // all about whether the grant is alive, and reading it as dead would erase a live credential.
    const verdict = verdictForRevokeError(failureError('google-oauth', 'quota_exhausted'))
    expect(verdict.kind).toBe('unconfirmed')
    expect(verdict.grantFailure).toBe('quota_zero')
  })

  it('reads an UNMAPPED error as unconfirmed — the safe default', () => {
    // Not an AppError and carrying no failure mode: a DNS failure, a TypeError, anything a future library
    // throws. Defaulting to `already_dead` here would let a network blip authorise the erasure of a live
    // credential, which is the unrecoverable half-failure.
    for (const error of [new Error('getaddrinfo ENOTFOUND'), 'a string', undefined, null]) {
      const verdict = verdictForRevokeError(error)
      expect(verdict.kind, `${String(error)} must not authorise erasure`).toBe('unconfirmed')
      expect(zeroisationIsSafe(verdict)).toBe(false)
      expect(verdict.grantFailure).toBe('transient')
    }
  })

  it('an AppError with no failureMode is unconfirmed too', () => {
    // The shape a hand-built error takes. `failureModeOf` returns undefined, and undefined must not read
    // as permission.
    const verdict = verdictForRevokeError(new AppError('provider_unavailable', 'no detail'))
    expect(verdict.kind).toBe('unconfirmed')
    expect(verdict.failureMode).toBeNull()
  })

  it('every failure mode the fakes can produce maps to a verdict in the closed set', () => {
    // Driven over FAILURE_MODES rather than over a hand-written list, so a mode added to the fakes cannot
    // arrive unclassified. Two assertions: the verdict is in the set, and — the substantive one — only the
    // modes that are Google refusing the credential may authorise erasure.
    const permitted = new Set(['invalid_grant', 'access_not_granted'])
    for (const mode of FAILURE_MODES) {
      const verdict = verdictForRevokeError(failureError('google-oauth', mode))
      expect(REVOKE_VERDICTS).toContain(verdict.kind)
      expect(zeroisationIsSafe(verdict), `${mode} must not authorise erasure`).toBe(
        permitted.has(mode),
      )
    }
  })

  it('the control: the safe answer is not simply always false', () => {
    // Without this, `zeroisationIsSafe` could be `() => false` and every assertion above but two would
    // pass — and a disconnect that never erased anything would look correct.
    expect(zeroisationIsSafe(verdictForRevocation('revoked'))).toBe(true)
    expect(
      zeroisationIsSafe(verdictForRevokeError(failureError('google-oauth', 'server_error'))),
    ).toBe(false)
  })
})

describe('the event detail a verdict contributes', () => {
  it('names the verdict and the endpoint, and carries no secret', () => {
    const detail = revokeDetail(verdictForRevocation('revoked'))
    expect(detail).toEqual({ revokeVerdict: 'revoked', revokeEndpoint: GOOGLE_REVOKE_ENDPOINT })
  })

  it('carries the failure class on an unconfirmed verdict', () => {
    const detail = revokeDetail(verdictForRevokeError(failureError('google-oauth', 'server_error')))
    expect(detail).toMatchObject({
      revokeVerdict: 'unconfirmed',
      failureMode: 'server_error',
      failure: 'transient',
    })
  })

  it('never carries a key the events table refuses', () => {
    // `google_connection_events_no_token` is the backstop; this is the reason it never fires. Every value
    // in the detail comes from a closed set, so none of them can be a secret — but a future field could
    // be named `token`, and the CHECK would then reject a row on the disconnect path, which is the path
    // where a rejected row means the record of a destroyed credential is lost.
    const forbidden = ['refresh_token', 'access_token', 'refreshToken', 'accessToken', 'token']
    for (const mode of FAILURE_MODES) {
      const keys = Object.keys(revokeDetail(verdictForRevokeError(failureError('x', mode))))
      expect(keys.filter((key) => forbidden.includes(key))).toEqual([])
    }
  })
})

describe('the endpoint', () => {
  it('is the one docs/10 §5 names by hand', () => {
    // Asserted as a literal rather than re-exported into the assertion, because the point is that the
    // value is this and not a plausible neighbour: `accounts.google.com/o/oauth2/revoke` is the legacy
    // host and still resolves, which is exactly how a wrong endpoint survives review.
    expect(GOOGLE_REVOKE_ENDPOINT).toBe('https://oauth2.googleapis.com/revoke')
  })

  it('the two status reasons are the values the schema and the acceptance name', () => {
    expect(DISCONNECT_REASON_DONE).toBe('manual')
    // Load-bearing: migration 0040's google_connections_revoke_retry_keeps_its_token keys on this exact
    // string to refuse a retained-credential row whose ciphertext has been erased.
    expect(DISCONNECT_REASON_REVOKE_FAILED).toBe('revoke_failed')
  })
})

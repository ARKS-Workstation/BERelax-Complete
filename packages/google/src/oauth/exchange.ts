import { createHash } from 'node:crypto'
import { type Clock, type Instant, instantFromIso } from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel — see the note in `consent.ts`.
import type { GoogleOAuthProvider, GoogleTokens } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { consentWindowExpired, type PendingConsent } from './consent.ts'

/**
 * Turning a callback into a grant: state, PKCE, the code, and the identity inside the id_token.
 *
 * Nothing here writes anything. That is deliberate and it is what makes *"neither path writes a
 * connection row"* provable rather than reviewed: every refusal in this file happens before a store is
 * in scope, so there is no write to forget to skip.
 *
 * The three refusals, and what each one actually prevents:
 *
 * **State mismatch.** Someone else's authorization code, delivered to this owner's browser. Without the
 * check it exchanges cleanly and the business's Google presence is connected to an account chosen by
 * whoever sent the link.
 *
 * **A replayed code.** Distinct from a state mismatch on purpose. A reloaded callback tab and a hostile
 * replay look identical to a `state` cookie, because a successful exchange clears it — so a cleared
 * cookie can only say *"no consent in flight"*. The fingerprint of the code that produced a connection
 * is recorded on the append-only event, and that is what tells the two apart.
 *
 * **A sub that disagrees with itself.** `sub` arrives twice, in the token response and in the id_token,
 * and every stored token is AAD-bound to it. Two different values mean the response was assembled from
 * two accounts, and picking either one silently is how a token ends up bound to the wrong identity.
 */

/** `details.reason` on the error each refusal throws. A caller branches on these, never on prose. */
export const CONSENT_STATE_MISMATCH = 'google_consent_state_mismatch'
export const CONSENT_CODE_REPLAYED = 'google_consent_code_replayed'
export const CONSENT_WINDOW_CLOSED = 'google_consent_window_closed'
export const CONSENT_DENIED = 'google_consent_denied'
export const CONSENT_IDENTITY_MISMATCH = 'google_consent_identity_mismatch'

/** What Google puts on the redirect. `error` is present instead of `code` when consent failed. */
export interface ConsentCallback {
  readonly code?: string | null
  readonly state?: string | null
  /** `access_denied`, `admin_policy_enforced`, … Present instead of a code. */
  readonly error?: string | null
}

export interface GoogleIdentity {
  /** The identity key. Every stored token's AAD is bound to it. */
  readonly googleSub: string
  /** Display only. Changes when a Workspace account is renamed. */
  readonly googleEmail: string
}

/**
 * A successful exchange, before anything is stored.
 *
 * `refreshToken` is plaintext here and nowhere else: it is sealed by `applyConsent` within a few lines
 * of being returned. It must not be logged, put in an error message, or placed in a pg-boss payload —
 * see docs/10 §4, and G-CONN-03's chokepoint rule, which is what will enforce it.
 */
export interface ConsentGrant {
  readonly identity: GoogleIdentity
  /** What Google GRANTED. Never the request — see `applyConsent`. */
  readonly grantedScopes: readonly string[]
  readonly refreshToken: string
  readonly accessToken: string
  readonly accessExpiresAt: Instant
  /** SHA-256 of the authorization code, for the replay check. Never the code itself. */
  readonly authorizationCodeFingerprint: string
}

/**
 * The fingerprint recorded against a spent authorization code.
 *
 * A hash rather than the code, because a code is a bearer credential until it is exchanged and rows
 * reach query logs, `pg_stat_statements` and backups. A hash of a single-use value that has already
 * been spent is useless to an attacker and sufficient to recognise the same value again.
 */
export function authorizationCodeFingerprint(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

interface IdTokenClaims {
  readonly sub?: unknown
  readonly email?: unknown
}

/**
 * Reads `sub` and `email` out of the id_token's payload.
 *
 * The signature is not verified, and that is correct rather than lazy: this token came back in the body
 * of a TLS request this server made to Google's token endpoint, authenticated with the client secret.
 * Google's own documentation says a token obtained that way needs no verification — verification exists
 * for tokens that arrived via a browser. Verifying it here would mean fetching and caching Google's
 * signing keys, which is a second network dependency on the consent path for no additional guarantee.
 */
export function claimsFromIdToken(idToken: string): IdTokenClaims {
  const payload = idToken.split('.')[1]
  if (payload === undefined || payload === '') {
    throw new AppError(
      'validation',
      'The id_token is not a JWT: it has no payload segment. Without it the account has no email ' +
        'address and the connection cannot be labelled for whoever runs the business next.',
      { details: { reason: CONSENT_IDENTITY_MISMATCH } },
    )
  }
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims
  } catch (cause) {
    throw new AppError('validation', 'The id_token payload is not decodable JSON.', {
      details: { reason: CONSENT_IDENTITY_MISMATCH },
      cause,
    })
  }
}

/**
 * The account a token response belongs to, cross-checked against the id_token.
 *
 * Exported because it is the one piece of the exchange worth testing on its own: the mismatch branch
 * is unreachable through a well-behaved provider, and an assertion that can only be reached through a
 * misbehaving one still has to be proved to fire.
 */
export function identityFrom(tokens: GoogleTokens): GoogleIdentity {
  if (tokens.idToken === undefined) {
    throw new AppError(
      'validation',
      'The token response carried no id_token, so the account has no email address. The `openid` ' +
        'scope was not granted — a consent that returns no identity cannot be stored against one.',
      { details: { reason: CONSENT_IDENTITY_MISMATCH } },
    )
  }
  const claims = claimsFromIdToken(tokens.idToken)
  const sub = typeof claims.sub === 'string' ? claims.sub : ''
  const email = typeof claims.email === 'string' ? claims.email : ''
  if (sub === '' || email === '') {
    throw new AppError(
      'validation',
      'The id_token carries no sub or no email. Both are required: sub is the identity every stored ' +
        'token is bound to, and email is what the settings panel shows.',
      { details: { reason: CONSENT_IDENTITY_MISMATCH } },
    )
  }
  if (sub !== tokens.sub) {
    throw new AppError(
      'invariant_violated',
      'The id_token sub and the token response sub disagree. Refusing to guess which account this ' +
        'grant belongs to: a token sealed against the wrong sub cannot be decrypted, and a token ' +
        'sealed against the wrong sub that CAN be decrypted is a reply posted to another business.',
      { details: { reason: CONSENT_IDENTITY_MISMATCH } },
    )
  }
  return { googleSub: sub, googleEmail: email }
}

export interface ExchangeDeps {
  readonly oauth: GoogleOAuthProvider
  readonly clock: Clock
}

/**
 * Validates the callback and exchanges the code. Writes nothing.
 *
 * The order is load-bearing. Every check that can be made without talking to Google is made first, so
 * a forged callback never costs a round trip and — more importantly — never consumes one of the ~100
 * live refresh tokens Google allows per account per client (docs/10 §4).
 */
export async function exchangeConsentCode(
  deps: ExchangeDeps,
  pending: PendingConsent,
  callback: ConsentCallback,
  options: { readonly redirectUri?: string } = {},
): Promise<ConsentGrant> {
  if (callback.error) {
    throw new AppError(
      'forbidden',
      `Google refused the consent: ${callback.error}. ` +
        (callback.error === 'admin_policy_enforced'
          ? 'A Workspace administrator has marked this service Restricted, which surfaces here, ' +
            'before any token exists (docs/10 §4).'
          : 'Nothing was connected and nothing was changed.'),
      { details: { reason: CONSENT_DENIED, error: callback.error } },
    )
  }
  if (!callback.state || callback.state !== pending.state) {
    // One error for both "absent" and "different". Telling a caller which of the two it was tells an
    // attacker whether their guess had the right shape.
    throw new AppError(
      'forbidden',
      'The consent callback state does not match the consent this server started. Refusing to ' +
        "exchange it — an authorization code delivered with someone else's state is how a business " +
        'presence gets connected to an account the owner never chose.',
      { details: { reason: CONSENT_STATE_MISMATCH } },
    )
  }
  if (!callback.code) {
    throw new AppError(
      'validation',
      'The consent callback carries no authorization code and no error. There is nothing to exchange.',
      { details: { reason: CONSENT_DENIED } },
    )
  }
  if (consentWindowExpired(pending, deps.clock.now())) {
    throw new AppError(
      'forbidden',
      'This consent was started too long ago to be completed. Start the connection again from the ' +
        'settings page.',
      { details: { reason: CONSENT_WINDOW_CLOSED } },
    )
  }

  const tokens = await deps.oauth.exchangeCode(callback.code, {
    codeVerifier: pending.codeVerifier,
    ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri }),
  })
  if (tokens.refreshToken === undefined || tokens.refreshToken === '') {
    // Google omits the refresh token when the account has already granted this client and the request
    // did not carry `prompt=consent`. Storing the access token alone would produce a connection that
    // works for an hour and then dies with nothing to refresh from.
    throw new AppError(
      'invariant_violated',
      'The code exchange returned no refresh token. Without one the connection lasts one hour: the ' +
        'authorization request must carry access_type=offline and prompt=consent.',
    )
  }

  return {
    identity: identityFrom(tokens),
    grantedScopes: tokens.scopes,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessExpiresAt: instantFromIso(tokens.expiresAtIso),
    authorizationCodeFingerprint: authorizationCodeFingerprint(callback.code),
  }
}

/** The error a replayed authorization code raises, wherever the replay is noticed. */
export function consentCodeReplayed(): AppError {
  return new AppError(
    'conflict',
    'This authorization code has already been exchanged for a connection. Nothing was written. ' +
      'Reloading the callback URL does not reconnect anything — start again from the settings page.',
    { details: { reason: CONSENT_CODE_REPLAYED } },
  )
}

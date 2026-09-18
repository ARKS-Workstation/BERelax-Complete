import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto'
import {
  addMinutes,
  type Clock,
  forbiddenScopesIn,
  type GoogleRequestedScope,
  type Instant,
  REQUESTED_GOOGLE_SCOPES,
} from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel: the barrel re-exports the SMS and email ports,
// which is what `messaging-providers-only-inside-a-transport` bans outside a transport.
import type { GoogleOAuthProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'

/**
 * Starting a consent: the authorization URL, its `state`, and its PKCE verifier.
 *
 * Three decisions live here, and each of them is the reason a line of this file exists.
 *
 * **The scope list is closed at the type level.** `GoogleRequestedScope` is a union of exactly the two
 * scopes docs/10 §3 permits, so a future unit cannot add a Gmail or a read-write Search Console scope
 * without a compile error — and `forbiddenScopesIn` repeats the check at runtime, because a scope list
 * can also arrive from configuration, where the type system is not present. `business.manage` has no
 * read-only variant: **the scope that reads reviews also rewrites the address and the opening hours**,
 * so a consent screen with one scope too many is not a cosmetic problem.
 *
 * **State and verifier are 256-bit random values that never touch the database.** They belong to one
 * browser for a few minutes. Storing them in a table would mean a migration, a cleanup job and a row
 * per abandoned consent; the caller puts this in a one-shot HttpOnly cookie instead.
 *
 * **PKCE is sent even though this is a confidential client with a secret.** It costs one hash and it
 * removes the entire class of attack where an authorization code is intercepted on the redirect — and
 * the redirect here is to an admin URL an owner may well open on a phone on a hotel network.
 */

/** The state's entropy, in bytes. 256 bits: a guessable state is a CSRF hole, not a nuisance. */
const STATE_BYTES = 32

/** RFC 7636 permits 43–128 characters; 32 random bytes base64url-encode to 43. */
const VERIFIER_BYTES = 32

/**
 * How long a started consent stays valid.
 *
 * Ten minutes. The owner is being walked through this on a call (docs/10 §3), so it does not need to
 * survive a lunch break — and a state that lives for hours is a CSRF token an attacker has hours to
 * use. Google's own authorization codes expire on roughly this scale.
 */
export const CONSENT_WINDOW_MINUTES = 10

/**
 * Everything the callback needs to prove it is the continuation of a consent this server started.
 *
 * Serialised into a cookie by the route handler, which is why it is flat JSON and carries no
 * functions. `codeVerifier` is a secret for the length of one exchange: it must not be logged.
 */
export interface PendingConsent {
  readonly state: string
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly scopes: readonly GoogleRequestedScope[]
  readonly startedAt: Instant
  /**
   * The connection the owner clicked *Reconnect* on, when they clicked one.
   *
   * It is what turns "a different Google account signed in" from a guess into a statement: without it,
   * a second account arriving at a first-time connect and a second account arriving at a reconnect are
   * indistinguishable, and only one of them deserves a warning.
   */
  readonly reconnectingConnectionId: string | null
}

export interface AuthorizationRequest {
  /** Where to send the browser. */
  readonly url: string
  /** What to keep until the callback. */
  readonly pending: PendingConsent
}

export interface ConsentDeps {
  readonly oauth: GoogleOAuthProvider
  readonly clock: Clock
  /**
   * Injected so a test can assert an exact state and challenge.
   *
   * Defaults to `node:crypto`. A caller that passes a counter here has built a predictable CSRF token,
   * which is why the default is the real thing rather than something seeded.
   */
  readonly randomBytes?: (size: number) => Buffer
}

const consentCookieMissing =
  'This callback carries no consent this server started. Begin the connection again from the ' +
  'settings page rather than reloading the callback URL.'

const base64url = (input: Buffer): string => input.toString('base64url')

/** The S256 challenge for a verifier, as RFC 7636 defines it. */
export function codeChallengeFor(codeVerifier: string): string {
  return base64url(createHash('sha256').update(codeVerifier, 'ascii').digest())
}

/**
 * Builds the authorization URL and the pending consent that must accompany its callback.
 *
 * `scopes` exists so a re-consent can ask for exactly what is missing rather than everything again —
 * it can only narrow, never widen, because its element type is the closed union.
 */
export function buildAuthorizationRequest(
  deps: ConsentDeps,
  args: {
    readonly scopes?: readonly GoogleRequestedScope[]
    readonly reconnectingConnectionId?: string | null
    readonly redirectUri?: string
  } = {},
): AuthorizationRequest {
  const random = deps.randomBytes ?? nodeRandomBytes
  const scopes = args.scopes ?? REQUESTED_GOOGLE_SCOPES
  if (scopes.length === 0) {
    throw new AppError(
      'validation',
      'Refusing to build an authorization URL with no scopes. Google would return a token that can ' +
        'do nothing, and the connection would read as healthy.',
    )
  }
  // The type already forbids these. This is the second check, for the path where the list came from
  // configuration or a request body and the compiler was not in the room.
  const forbidden = forbiddenScopesIn(scopes)
  if (forbidden.length > 0) {
    throw new AppError(
      'validation',
      `Refusing to request ${forbidden.join(', ')}. See docs/10 §3: the read-write webmasters scope ` +
        'buys only sitemap submission, which is a one-time manual action, and a Gmail scope would make ' +
        'a password change revoke our refresh token.',
      { details: { forbidden } },
    )
  }

  const codeVerifier = base64url(random(VERIFIER_BYTES))
  const codeChallenge = codeChallengeFor(codeVerifier)
  const pending: PendingConsent = {
    state: base64url(random(STATE_BYTES)),
    codeVerifier,
    codeChallenge,
    scopes,
    startedAt: deps.clock.now(),
    reconnectingConnectionId: args.reconnectingConnectionId ?? null,
  }

  return {
    url: deps.oauth.authorizationUrl({
      state: pending.state,
      scopes,
      codeChallenge,
      codeChallengeMethod: 'S256',
      ...(args.redirectUri === undefined ? {} : { redirectUri: args.redirectUri }),
    }),
    pending,
  }
}

/** True once the consent window has closed. The callback must refuse rather than exchange. */
export function consentWindowExpired(pending: PendingConsent, now: Instant): boolean {
  return now > addMinutes(pending.startedAt, CONSENT_WINDOW_MINUTES)
}

/**
 * The cookie payload, as a string.
 *
 * Plain JSON, and deliberately not signed: there is no key source for a signing secret in this
 * environment yet, and an unsigned double-submit cookie compared against the `state` query parameter
 * is the standard OAuth defence. What closes the remaining gap — an attacker who can *set* a cookie on
 * this origin — is binding the pending consent to the admin session, which needs a session, which is
 * W-SYS-01. Until then the cookie is HttpOnly, SameSite=Lax and lives for ten minutes.
 */
export function serialisePendingConsent(pending: PendingConsent): string {
  return JSON.stringify(pending)
}

export function parsePendingConsent(raw: string | null | undefined): PendingConsent {
  if (!raw) {
    throw new AppError('validation', consentCookieMissing, {
      details: { reason: 'google_consent_cookie_missing' },
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new AppError('validation', consentCookieMissing, {
      details: { reason: 'google_consent_cookie_missing' },
      cause,
    })
  }
  const candidate = parsed as Partial<PendingConsent> | null
  if (
    candidate === null ||
    typeof candidate.state !== 'string' ||
    typeof candidate.codeVerifier !== 'string' ||
    typeof candidate.codeChallenge !== 'string' ||
    typeof candidate.startedAt !== 'number' ||
    !Array.isArray(candidate.scopes)
  ) {
    throw new AppError('validation', consentCookieMissing, {
      details: { reason: 'google_consent_cookie_missing' },
    })
  }
  return {
    state: candidate.state,
    codeVerifier: candidate.codeVerifier,
    codeChallenge: candidate.codeChallenge,
    scopes: candidate.scopes,
    startedAt: candidate.startedAt,
    reconnectingConnectionId: candidate.reconnectingConnectionId ?? null,
  }
}

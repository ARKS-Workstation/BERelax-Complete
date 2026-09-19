import type { Kek } from '@berelax/clinical'
import {
  applyGrantFailure,
  applyRefreshSuccess,
  type Clock,
  type GoogleGrantFailure,
  type Instant,
  instantFromIso,
  shouldRefreshAccessToken,
} from '@berelax/core'
// Subpath imports, not the `@berelax/providers` barrel: the barrel is one hop from the SMS and email
// ports, and `messaging-providers-only-inside-a-transport` is a reachable rule.
import { failureModeOf } from '@berelax/providers/failure'
import type { GoogleOAuthProvider } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import type { GoogleConnectionRecord, GoogleConnectionStore } from './connection-store.ts'
import { type RevokeVerdict, verdictForRevocation, verdictForRevokeError } from './oauth/revoke.ts'
import { connectionBinding, openToken, type SealedToken, sealToken } from './token-store.ts'

/**
 * The token lifecycle: obtain a usable access token, or say precisely why not.
 *
 * Two rules from docs/10 §4 are implemented here rather than left to callers.
 *
 * **Refresh proactively, never reactively on a 401.** A reactive refresh spends a round trip on every
 * cron cycle and fills the error taxonomy with 401s that mean nothing — which is how the one 401 that
 * means the grant is dead gets lost among them.
 *
 * **`invalid_grant` is the only failure that kills the grant.** A quota error, a rate limit and a 500
 * leave the status alone. Treating them as a dead token sends the owner through a re-consent that
 * fixes nothing, and an owner who has re-consented for nothing once ignores the next notification.
 */

/** What a caller gets. The token itself, and whether obtaining it cost a round trip. */
export interface AccessTokenGrant {
  readonly accessToken: string
  readonly expiresAt: Instant
  readonly refreshed: boolean
}

export interface TokenLifecycleDeps {
  readonly store: GoogleConnectionStore
  readonly oauth: GoogleOAuthProvider
  readonly kek: Kek
  readonly clock: Clock
}

/**
 * The error a consumer must convert into its declared degraded mode rather than propagate.
 *
 * `details.reason` is `google_reauth_required`. G-CONN-03 replaces this with the named taxonomy class
 * `GoogleReauthRequired` and the `withGoogle` chokepoint that catches it; until then the reason code is
 * what a caller branches on, so the branch does not have to parse prose.
 */
export function googleReauthRequired(connection: {
  readonly id: string
  readonly googleEmail: string
  readonly statusReason: string | null
}): AppError {
  return new AppError(
    'unauthenticated',
    `The Google connection for ${connection.googleEmail} needs re-authorising ` +
      `(${connection.statusReason ?? 'unknown reason'}). Review replies will keep being drafted.`,
    {
      details: {
        reason: 'google_reauth_required',
        connectionId: connection.id,
        googleEmail: connection.googleEmail,
        statusReason: connection.statusReason,
      },
    },
  )
}

/**
 * Classifies a provider error into the vocabulary the state machine understands.
 *
 * Anything unrecognised becomes `transient`, never `invalid_grant`. Defaulting the other way would let
 * a DNS blip mark a working connection dead, and the owner would re-consent to fix a network.
 */
export function grantFailureFromError(error: unknown): GoogleGrantFailure {
  switch (failureModeOf(error)) {
    case 'invalid_grant':
      return 'invalid_grant'
    case 'access_not_granted':
      return 'access_not_granted'
    case 'quota_exhausted':
      return 'quota_zero'
    case 'rate_limited':
      return 'rate_limited'
    default:
      return 'transient'
  }
}

/**
 * Loads a connection that is fit to serve a token, or says why it is not.
 *
 * Split out because `token-refresh.ts` reads the same row twice — once to decide whether a refresh is
 * due and once again inside the advisory lock — and a second copy of this guard is a second place for
 * `disconnected` to be forgotten.
 */
export async function loadActiveConnection(
  store: Pick<GoogleConnectionStore, 'load'>,
  connectionId: string,
): Promise<GoogleConnectionRecord> {
  const connection = await store.load(connectionId)
  if (connection === null) {
    throw new AppError('not_found', `No Google connection with id ${connectionId}`)
  }
  if (connection.status !== 'active') {
    // Including `disconnected`: a disconnected connection's token was revoked at Google on purpose.
    throw googleReauthRequired(connection)
  }
  return connection
}

/**
 * The cached grant on a connection, or null when there is none worth using.
 *
 * The ONLY place that decides whether a stored access token is still good. `token-refresh.ts` asks
 * exactly this question twice — before taking the advisory lock and again inside it — and the second
 * ask is the double check that stops the loser of a race spending a refresh token the winner has
 * already replaced. Two copies of the margin arithmetic would eventually disagree, and the direction
 * they disagree in is a token that expires mid-request.
 */
export function cachedAccessGrant(
  deps: Pick<TokenLifecycleDeps, 'kek' | 'clock'>,
  connection: GoogleConnectionRecord,
): AccessTokenGrant | null {
  if (connection.accessToken === null) return null
  if (
    shouldRefreshAccessToken({
      accessExpiresAt: connection.accessExpiresAt,
      now: deps.clock.now(),
    })
  ) {
    return null
  }
  return {
    accessToken: openToken(
      deps.kek,
      connectionBinding({ connectionId: connection.id, googleSub: connection.googleSub }),
      connection.accessToken,
    ),
    // Non-null because the schema's CHECK makes the cached token and its expiry all-or-nothing.
    expiresAt: connection.accessExpiresAt as Instant,
    refreshed: false,
  }
}

/**
 * Obtains an access token for a connection, refreshing it when it is inside the margin.
 *
 * **Unserialised, and that is why `withGoogle` does not call this.** docs/10 §4 serialises competing
 * refreshes with a Postgres advisory transaction lock and a double-checked re-read, which is
 * `accessTokenUnderLock` in `token-refresh.ts`: the lock belongs around the whole read-refresh-write
 * in a transaction, one level up, and taking it here — on a path that has no transaction to scope it
 * to — would look serialised without being it. pg-boss can start the review poll, the SEO crawl and
 * the health check in the same second.
 *
 * What is left here is the unlocked primitive the locked path is built from, and the one place a
 * caller holding a store with no transaction seam (the memory store, a unit test of the
 * `invalid_grant` state machine) can still obtain a token.
 */
export async function accessTokenFor(
  deps: TokenLifecycleDeps,
  connectionId: string,
): Promise<AccessTokenGrant> {
  const connection = await loadActiveConnection(deps.store, connectionId)
  return cachedAccessGrant(deps, connection) ?? refreshAccessToken(deps, connection)
}

/**
 * The sealed refresh token, or a refusal naming why there is none.
 *
 * Nullable since migration 0040, which is what made zeroisation expressible: a completed disconnect NULLs
 * all five columns. Every caller here is already behind `loadActiveConnection`, which refuses anything but
 * `active`, and `google_connections_live_grant_has_a_refresh_token` refuses an `active` row with no
 * ciphertext — so this is unreachable from a consistent database and is still written as a refusal rather
 * than a `!`. A non-null assertion would turn the one state that genuinely has no credential into a
 * `TypeError` with no connection id in it, on whichever cron happened to look first.
 *
 * Exported because six test files need it. Every assertion that a token round-tripped has to say what it
 * means for the token to be absent now that it can be, and a `!` in each of them would report the one
 * interesting case — a fixture built with no credential — as an unattributable TypeError. Reusing the
 * production guard also means the tests and the code agree about what a missing token is.
 */
export function assertRefreshTokenStored(
  connection: Pick<GoogleConnectionRecord, 'id' | 'refreshToken'>,
): SealedToken {
  if (connection.refreshToken === null) {
    throw new AppError(
      'invariant_violated',
      `Google connection ${connection.id} holds no refresh token: it was zeroised by a disconnect. ` +
        'Re-consent creates a new grant; nothing can revive this one.',
      { details: { reason: 'google_refresh_token_zeroised', connectionId: connection.id } },
    )
  }
  return connection.refreshToken
}

/**
 * Asks Google to revoke the grant, and returns what that means. **Writes nothing.**
 *
 * ## Why this lives here and not in `oauth/revoke.ts`
 *
 * Because it decrypts, and decryption is the thing the chokepoint fences. Five modules may hold a
 * plaintext Google token — `scripts/check-google-token-chokepoint.mjs` and the
 * `google-tokens-only-in-with-google` rule name them — and this is one of them already, for the refresh.
 * Putting the revocation in a sixth module would have widened that allow-list to buy a file boundary, and
 * the allow-list is the guarantee. So the *I/O* is here beside the refresh it mirrors, and the *judgement*
 * — may we now erase the credential — is in `oauth/revoke.ts`, which holds no key and touches no column.
 *
 * ## Why it does not go through `withGoogle`
 *
 * `withGoogle` resolves a connection **from a capability** and refuses anything that is not `active`. A
 * disconnect has to work on precisely the connections it would refuse: one whose grant already looks dead
 * (`needs_reauth`), and one that never got as far as having a capability row. It would also classify
 * anything thrown inside its body through the Google taxonomy and write a `health_check_failed` row — and
 * a revocation failure is not a capability health failure, so that row would report a broken capability
 * for a connection somebody is deliberately taking out of service (G-CONN-05's laundering note). The
 * disconnect writes its own rows, which are the ones the panel reads.
 *
 * ## Why the refresh token and not the access token
 *
 * Google's revocation endpoint accepts either, and revoking the refresh token kills the whole grant
 * including every access token issued under it. The refresh token is also the credential we actually
 * store, so revoking it is what makes the stored bytes worthless — which is the entire reason the
 * revocation precedes the erasure.
 */
export async function revokeStoredGrant(
  deps: Pick<TokenLifecycleDeps, 'oauth' | 'kek'>,
  connection: Pick<GoogleConnectionRecord, 'id' | 'googleSub' | 'refreshToken'>,
): Promise<RevokeVerdict> {
  const binding = connectionBinding({
    connectionId: connection.id,
    googleSub: connection.googleSub,
  })
  const refreshToken = openToken(deps.kek, binding, assertRefreshTokenStored(connection))
  try {
    return verdictForRevocation(await deps.oauth.revoke(refreshToken))
  } catch (error) {
    // Caught, classified, returned — never rethrown. The caller has a status to write and an event to
    // append on this path, and a throw here would make the decision at the call site a `catch` block
    // somebody eventually widens. The classification is `oauth/revoke.ts`'s, so the rule that decides
    // whether erasure is safe stays in one testable function.
    return verdictForRevokeError(error)
  }
}

/**
 * Trades the stored refresh token for a fresh access token, and records what happened either way.
 *
 * The write on the failure path matters as much as the one on the success path: a pg-boss job failure
 * is not evidence of failure, because nobody reads `pgboss.job`. Every Google failure that affects a
 * capability must also write a row the owner's dashboard renders (docs/10 §4).
 */
export async function refreshAccessToken(
  deps: TokenLifecycleDeps,
  connection: GoogleConnectionRecord,
): Promise<AccessTokenGrant> {
  const binding = connectionBinding({
    connectionId: connection.id,
    googleSub: connection.googleSub,
  })
  const refreshToken = openToken(deps.kek, binding, assertRefreshTokenStored(connection))

  let tokens: Awaited<ReturnType<GoogleOAuthProvider['refresh']>>
  try {
    tokens = await deps.oauth.refresh(refreshToken)
  } catch (error) {
    const failure = grantFailureFromError(error)
    const transition = applyGrantFailure(connection, failure)
    await deps.store.recordStatus({
      connectionId: connection.id,
      status: transition.status,
      statusReason: transition.statusReason,
      lastCheckedAt: deps.clock.now(),
    })
    if (transition.event !== null) {
      await deps.store.appendEvent({
        connectionId: connection.id,
        googleSub: connection.googleSub,
        event: transition.event,
        // The failure class and whether anyone was emailed — never the token, never the error's own
        // message, which upstream libraries have been known to build by concatenating the request.
        detail: { failure, notified: transition.notify ?? 'none' },
      })
    }
    if (failure === 'invalid_grant') {
      throw googleReauthRequired({ ...connection, statusReason: transition.statusReason })
    }
    throw error
  }

  const transition = applyRefreshSuccess(connection)
  const expiresAt = instantFromIso(tokens.expiresAtIso)
  const okAt = deps.clock.now()
  // Google normally returns the same refresh token. When it returns a different one, persisting it is
  // not optional: keeping the old one means the grant dies at a moment nothing in the deploy log
  // explains.
  const rotated =
    tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken
      ? sealToken(deps.kek, binding, tokens.refreshToken)
      : undefined

  await deps.store.recordRefresh({
    connectionId: connection.id,
    accessToken: sealToken(deps.kek, binding, tokens.accessToken),
    accessExpiresAt: expiresAt,
    ...(rotated === undefined ? {} : { refreshToken: rotated }),
    lastOkAt: okAt,
    status: transition.status,
    statusReason: transition.statusReason,
  })
  await deps.store.appendEvent({
    connectionId: connection.id,
    googleSub: connection.googleSub,
    event: 'refreshed',
    detail: { rotatedRefreshToken: rotated !== undefined, scopes: tokens.scopes.length },
  })

  return { accessToken: tokens.accessToken, expiresAt, refreshed: true }
}

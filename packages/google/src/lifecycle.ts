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
import { connectionBinding, openToken, sealToken } from './token-store.ts'

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
 * Obtains an access token for a connection, refreshing it when it is inside the margin.
 *
 * Concurrency note: docs/10 §4 serialises competing refreshes with a Postgres advisory transaction
 * lock and a double-checked re-read, and that is G-CONN-04's unit of work. It belongs one level up,
 * around the whole read-refresh-write inside a transaction, rather than here: taking a lock on a path
 * a consumer can bypass is worse than not taking one, because it would look serialised and not be.
 * pg-boss can start the review poll, the SEO crawl and the health check in the same second.
 */
export async function accessTokenFor(
  deps: TokenLifecycleDeps,
  connectionId: string,
): Promise<AccessTokenGrant> {
  const connection = await deps.store.load(connectionId)
  if (connection === null) {
    throw new AppError('not_found', `No Google connection with id ${connectionId}`)
  }
  if (connection.status !== 'active') {
    // Including `disconnected`: a disconnected connection's token was revoked at Google on purpose.
    throw googleReauthRequired(connection)
  }

  const binding = connectionBinding({
    connectionId: connection.id,
    googleSub: connection.googleSub,
  })
  const now = deps.clock.now()

  if (
    connection.accessToken !== null &&
    !shouldRefreshAccessToken({ accessExpiresAt: connection.accessExpiresAt, now })
  ) {
    return {
      accessToken: openToken(deps.kek, binding, connection.accessToken),
      // Non-null because the schema's CHECK makes the cached token and its expiry all-or-nothing.
      expiresAt: connection.accessExpiresAt as Instant,
      refreshed: false,
    }
  }

  return refreshAccessToken(deps, connection)
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
  const refreshToken = openToken(deps.kek, binding, connection.refreshToken)

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

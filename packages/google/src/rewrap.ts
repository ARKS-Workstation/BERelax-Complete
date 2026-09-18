import type { Kek } from '@berelax/clinical'
import { AppError } from '@berelax/shared'
import type { GoogleConnectionStore } from './connection-store.ts'
import { connectionBinding, rewrapToken } from './token-store.ts'

/**
 * The KEK rotation job.
 *
 * This is what `refresh_token_kid` is for. Rotating the app key without it would mean asking the owner
 * to re-consent for every connection — and a rotation that needs the owner is a rotation that never
 * happens, which makes the key permanent, which is the thing key rotation exists to prevent.
 *
 * What it must not do is touch anything else. The job re-wraps a data key; it does not decide whether a
 * connection is healthy, does not clear a `needs_reauth`, and does not touch capabilities. The store's
 * `rewrapRefreshToken` is deliberately too narrow to express any of those, so this is enforced by the
 * shape of the seam rather than by this comment.
 */

export interface RewrapReport {
  readonly scanned: number
  readonly rewrapped: number
  /** Already on the new kid. A second run over a partly rotated estate must be a no-op on those rows. */
  readonly alreadyCurrent: number
}

/**
 * Moves every refresh token from `oldKek` to `newKek`.
 *
 * Idempotent: rows already carrying the new kid are counted and skipped, so an interrupted rotation is
 * resumed by running it again rather than by working out where it stopped.
 */
export async function rewrapRefreshTokens(deps: {
  readonly store: GoogleConnectionStore
  readonly oldKek: Kek
  readonly newKek: Kek
}): Promise<RewrapReport> {
  if (deps.oldKek.version === deps.newKek.version) {
    throw new AppError(
      'validation',
      `Refusing to re-wrap from KEK "${deps.oldKek.version}" to itself. A rotation that changes no ` +
        'version number leaves no evidence it ran, and the next rotation cannot tell what is pending.',
    )
  }

  const connections = await deps.store.listAll()
  let rewrapped = 0
  let alreadyCurrent = 0

  for (const connection of connections) {
    if (connection.refreshToken.kid === deps.newKek.version) {
      alreadyCurrent += 1
      continue
    }
    if (connection.refreshToken.kid !== deps.oldKek.version) {
      // A third version means a retired KEK was discarded before every row had moved off it. Failing
      // loudly beats leaving one undecryptable row to be discovered by a cron job at 03:00.
      throw new AppError(
        'invariant_violated',
        `Connection ${connection.id} is sealed with KEK "${connection.refreshToken.kid}", which is ` +
          `neither "${deps.oldKek.version}" nor "${deps.newKek.version}". Retain retired KEKs until ` +
          'every row has been re-wrapped.',
      )
    }
    const binding = connectionBinding({
      connectionId: connection.id,
      googleSub: connection.googleSub,
    })
    await deps.store.rewrapRefreshToken({
      connectionId: connection.id,
      // Re-wraps the data key without decrypting the token: the plaintext never exists in this process.
      refreshToken: rewrapToken(deps.oldKek, deps.newKek, binding, connection.refreshToken),
    })
    await deps.store.appendEvent({
      connectionId: connection.id,
      googleSub: connection.googleSub,
      event: 'token_rewrapped',
      detail: { fromKid: deps.oldKek.version, toKid: deps.newKek.version },
    })
    rewrapped += 1
  }

  return { scanned: connections.length, rewrapped, alreadyCurrent }
}

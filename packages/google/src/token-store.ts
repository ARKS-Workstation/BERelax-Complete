import { type Kek, open, type RecordBinding, rewrap, seal } from '@berelax/clinical'
import { AppError } from '@berelax/shared'

/**
 * Envelope encryption for Google OAuth tokens.
 *
 * The refresh token is the second-most-valuable secret in this system after the clinical DEK. It is a
 * durable bearer credential for control of the business's Google presence, and there is no read-only
 * variant of the scope it carries: **the token that reads reviews also rewrites the address and the
 * opening hours.** Volume encryption protects a stolen disk; it does nothing about the realistic
 * breach, which is an attacker holding a valid database credential.
 *
 * So this deliberately does NOT invent a second scheme. It reuses the clinical primitives from
 * migration 0008 — AES-256-GCM under a per-row data key, that key wrapped by the app KEK, the KEK
 * version stored alongside so rotation is a background re-wrap, and AAD binding each ciphertext to
 * its own row. Two encryption schemes in one codebase means two key hierarchies to rotate and two
 * chances to get the AAD wrong; one scheme reviewed twice is strictly better than two reviewed once.
 *
 * The AAD is the property worth dwelling on. Without it, an attacker with UPDATE could copy the
 * `refresh_token_ct` of the connection that owns the GBP listing onto the row a consumer resolves for
 * Search Console, and it would decrypt cleanly — which is how a reply gets posted to the wrong
 * business. Bound, the same move produces an authentication failure.
 */

/** The table name that participates in the AAD. Changing it invalidates every stored token. */
export const GOOGLE_CONNECTIONS_TABLE = 'google_connections'

/**
 * The AAD binding for a connection's tokens.
 *
 * `RecordBinding`'s third field is the identity the row belongs to. For clinical data that is the
 * customer; for a Google connection it is the **google_sub**, never the email address — binding to an
 * email would make every stored token undecryptable the day the owner renames their Google account.
 */
export function connectionBinding(args: {
  readonly connectionId: string
  readonly googleSub: string
}): RecordBinding {
  if (!args.connectionId || !args.googleSub) {
    throw new AppError(
      'validation',
      'A token binding needs both the connection id and the google_sub; an unbound ciphertext can be ' +
        'moved between connections.',
    )
  }
  return {
    table: GOOGLE_CONNECTIONS_TABLE,
    recordId: args.connectionId,
    customerId: args.googleSub,
  }
}

/**
 * One sealed token, as the five columns it occupies.
 *
 * `kid` is the KEK version. It is NOT NULL in the schema for a reason: a row whose key version is
 * unknown cannot be re-wrapped, so one nullable kid leaves the rotation job unable to finish and
 * unable to say which row stopped it.
 */
export interface SealedToken {
  readonly ct: Buffer
  readonly nonce: Buffer
  readonly wrappedKey: Buffer
  readonly kid: string
  readonly aadFingerprint: string
}

export function sealToken(kek: Kek, binding: RecordBinding, token: string): SealedToken {
  if (!token) {
    throw new AppError(
      'validation',
      'Refusing to seal an empty token. A blank ciphertext decrypts to a blank token and the failure ' +
        'surfaces as an unexplained 401 days later.',
    )
  }
  const sealed = seal(kek, binding, token)
  return {
    ct: sealed.ciphertext,
    nonce: sealed.nonce,
    wrappedKey: sealed.wrappedDataKey,
    kid: sealed.kekVersion,
    aadFingerprint: sealed.aadFingerprint,
  }
}

/** Decrypts. Throws rather than returning a wrong token if the row, the KEK or the tag disagree. */
export function openToken(kek: Kek, binding: RecordBinding, stored: SealedToken): string {
  return open(kek, binding, {
    ciphertext: stored.ct,
    nonce: stored.nonce,
    wrappedDataKey: stored.wrappedKey,
    kekVersion: stored.kid,
    aadFingerprint: stored.aadFingerprint,
  })
}

/**
 * Moves a token to a new KEK **without decrypting it**.
 *
 * This is the whole reason the envelope exists: rotating the KEK rewrites a few dozen bytes per row
 * rather than forcing the owner through a fresh consent. A rotation that required re-consent would
 * never be performed, and a key that is never rotated is a key that leaks eventually.
 */
export function rewrapToken(
  oldKek: Kek,
  newKek: Kek,
  binding: RecordBinding,
  stored: SealedToken,
): SealedToken {
  const rewrapped = rewrap(oldKek, newKek, binding, {
    ciphertext: stored.ct,
    nonce: stored.nonce,
    wrappedDataKey: stored.wrappedKey,
    kekVersion: stored.kid,
    aadFingerprint: stored.aadFingerprint,
  })
  return {
    ct: rewrapped.ciphertext,
    nonce: rewrapped.nonce,
    wrappedKey: rewrapped.wrappedDataKey,
    kid: rewrapped.kekVersion,
    aadFingerprint: rewrapped.aadFingerprint,
  }
}

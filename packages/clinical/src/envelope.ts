import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { AppError } from '@berelax/shared'

/**
 * Envelope encryption for clinical data.
 *
 * Volume encryption on DO Managed Postgres protects a stolen disk and nothing else. It does not
 * protect against the realistic case — an attacker holding a valid database credential, via an
 * application flaw or a leaked connection string. Application-level encryption does.
 *
 * The scheme:
 *   - a fresh 256-bit **data key (DEK)** per record, used once with AES-256-GCM
 *   - the DEK **wrapped** by a long-lived **key-encrypting key (KEK)** held outside the database
 *   - the KEK version stored alongside, so rotation is a background re-wrap of small blobs rather
 *     than a re-encryption of every payload
 *   - **AAD** binding each ciphertext to its own row, so a payload cannot be moved between
 *     customers even by someone who can write to the table
 *
 * That last property is the one worth dwelling on: without AAD, an attacker with UPDATE could swap
 * one client's intake payload onto another's record and it would decrypt cleanly.
 */

const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export interface Kek {
  readonly version: string
  readonly key: Buffer
}

export interface SealedPayload {
  /** Ciphertext with the GCM tag appended. */
  readonly ciphertext: Buffer
  readonly nonce: Buffer
  readonly wrappedDataKey: Buffer
  readonly kekVersion: string
  readonly aadFingerprint: string
}

/**
 * Identifies the row a ciphertext belongs to. Every field participates in the AAD, so changing any
 * of them makes decryption fail rather than silently return another record's data.
 */
export interface RecordBinding {
  readonly table: string
  readonly recordId: string
  readonly customerId: string
}

export function parseKek(base64Key: string, version: string): Kek {
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new AppError(
      'validation',
      `KEK must be ${KEY_BYTES} bytes (base64-encoded), received ${key.length}`,
    )
  }
  if (!version) throw new AppError('validation', 'KEK version is required — rotation depends on it')
  return { version, key }
}

export function generateKek(version: string): Kek {
  return { version, key: randomBytes(KEY_BYTES) }
}

function aadFor(binding: RecordBinding): Buffer {
  // Canonical, order-independent of the caller's object literal.
  return Buffer.from(`${binding.table}|${binding.recordId}|${binding.customerId}`, 'utf8')
}

export function fingerprint(binding: RecordBinding): string {
  return createHash('sha256').update(aadFor(binding)).digest('hex').slice(0, 32)
}

function encryptWith(key: Buffer, plaintext: Buffer, aad: Buffer): { ct: Buffer; nonce: Buffer } {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGO, key, nonce)
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { ct: Buffer.concat([body, cipher.getAuthTag()]), nonce }
}

function decryptWith(key: Buffer, payload: Buffer, nonce: Buffer, aad: Buffer): Buffer {
  if (payload.length < TAG_BYTES) {
    throw new AppError('invariant_violated', 'Ciphertext is shorter than its authentication tag')
  }
  const body = payload.subarray(0, payload.length - TAG_BYTES)
  const tag = payload.subarray(payload.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

/** Encrypts a payload under a fresh data key, wrapped by the given KEK. */
export function seal(kek: Kek, binding: RecordBinding, plaintext: string): SealedPayload {
  const dataKey = randomBytes(KEY_BYTES)
  const aad = aadFor(binding)
  const { ct, nonce } = encryptWith(dataKey, Buffer.from(plaintext, 'utf8'), aad)
  // The wrapped key is bound to the same row, so a wrapped key cannot be transplanted either.
  const wrapped = encryptWith(kek.key, dataKey, aad)
  dataKey.fill(0)
  return {
    ciphertext: ct,
    nonce,
    wrappedDataKey: Buffer.concat([wrapped.nonce, wrapped.ct]),
    kekVersion: kek.version,
    aadFingerprint: fingerprint(binding),
  }
}

/**
 * Decrypts. Throws `forbidden` on any authentication failure — a tampered ciphertext, a wrong KEK,
 * or a binding that does not match the row it was read from.
 */
export function open(kek: Kek, binding: RecordBinding, sealed: SealedPayload): string {
  if (sealed.kekVersion !== kek.version) {
    throw new AppError(
      'invariant_violated',
      `Payload was sealed with KEK "${sealed.kekVersion}" but "${kek.version}" was supplied. ` +
        'Retain retired KEKs until every payload has been re-wrapped.',
    )
  }
  const aad = aadFor(binding)
  if (sealed.aadFingerprint !== fingerprint(binding)) {
    throw new AppError('forbidden', 'Record binding does not match the sealed payload')
  }
  try {
    const wrappedNonce = sealed.wrappedDataKey.subarray(0, NONCE_BYTES)
    const wrappedBody = sealed.wrappedDataKey.subarray(NONCE_BYTES)
    const dataKey = decryptWith(kek.key, wrappedBody, wrappedNonce, aad)
    const plaintext = decryptWith(dataKey, sealed.ciphertext, sealed.nonce, aad).toString('utf8')
    dataKey.fill(0)
    return plaintext
  } catch (error) {
    throw new AppError('forbidden', 'Clinical payload failed authentication', { cause: error })
  }
}

/**
 * Re-wraps a payload's data key under a new KEK **without decrypting the payload**.
 *
 * This is why the envelope exists: rotating the KEK touches a few dozen bytes per record rather than
 * re-encrypting every intake form, so rotation is a routine background job instead of an outage.
 */
export function rewrap(
  oldKek: Kek,
  newKek: Kek,
  binding: RecordBinding,
  sealed: SealedPayload,
): SealedPayload {
  const aad = aadFor(binding)
  const wrappedNonce = sealed.wrappedDataKey.subarray(0, NONCE_BYTES)
  const wrappedBody = sealed.wrappedDataKey.subarray(NONCE_BYTES)
  let dataKey: Buffer
  try {
    dataKey = decryptWith(oldKek.key, wrappedBody, wrappedNonce, aad)
  } catch (error) {
    throw new AppError('forbidden', 'Could not unwrap the data key with the supplied KEK', {
      cause: error,
    })
  }
  const rewrapped = encryptWith(newKek.key, dataKey, aad)
  dataKey.fill(0)
  return {
    ...sealed,
    wrappedDataKey: Buffer.concat([rewrapped.nonce, rewrapped.ct]),
    kekVersion: newKek.version,
  }
}

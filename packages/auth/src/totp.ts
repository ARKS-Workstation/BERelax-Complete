import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from '@berelax/shared'

/**
 * TOTP (RFC 6238), used as the mandatory second factor for the owner, manager, accountant and
 * auditor roles — every role that can move money, see salaries or change settings.
 *
 * Implemented directly rather than pulled from a dependency: it is about sixty lines of well-specified
 * arithmetic, and an auth primitive with a supply chain is a poor trade.
 */

const DIGITS = 6
const PERIOD_SECONDS = 30
/** Accept the adjacent windows, because phone clocks drift. One step each way, not more. */
const DEFAULT_WINDOW = 1

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function generateSecret(byteLength = 20): string {
  return base32Encode(randomBytes(byteLength))
}

export function base32Encode(buffer: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) {
      throw new AppError('validation', `Invalid base32 character in TOTP secret: "${char}"`)
    }
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Reads a byte, refusing to silently treat a short buffer as zeroes. */
function byteAt(buffer: Buffer, index: number): number {
  const value = buffer.at(index)
  if (value === undefined) {
    throw new AppError('invariant_violated', `HMAC digest too short at byte ${index}`)
  }
  return value
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(counterBuffer).digest()
  // Dynamic truncation, RFC 4226 §5.4.
  const offset = byteAt(digest, digest.length - 1) & 0x0f
  const binary =
    ((byteAt(digest, offset) & 0x7f) << 24) |
    (byteAt(digest, offset + 1) << 16) |
    (byteAt(digest, offset + 2) << 8) |
    byteAt(digest, offset + 3)
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0')
}

export function totpAt(secretBase32: string, atEpochMs: number): string {
  return hotp(base32Decode(secretBase32), Math.floor(atEpochMs / 1000 / PERIOD_SECONDS))
}

/**
 * Verifies a code, in constant time, against the current window and `window` steps either side.
 *
 * Returns the matched counter so the caller can persist it and REJECT REPLAY — accepting the same
 * code twice inside its 30-second window defeats much of the point of a second factor.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atEpochMs: number,
  options: { readonly window?: number; readonly lastUsedCounter?: number } = {},
): { readonly valid: boolean; readonly counter?: number; readonly reason?: string } {
  const trimmed = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(trimmed)) return { valid: false, reason: 'malformed' }

  const secret = base32Decode(secretBase32)
  const current = Math.floor(atEpochMs / 1000 / PERIOD_SECONDS)
  const window = options.window ?? DEFAULT_WINDOW

  for (let drift = -window; drift <= window; drift += 1) {
    const counter = current + drift
    const expected = hotp(secret, counter)
    const a = Buffer.from(expected)
    const b = Buffer.from(trimmed)
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (options.lastUsedCounter !== undefined && counter <= options.lastUsedCounter) {
        return { valid: false, reason: 'replayed' }
      }
      return { valid: true, counter }
    }
  }
  return { valid: false, reason: 'mismatch' }
}

/** `otpauth://` URI for the enrolment QR code. */
export function totpEnrolmentUri(args: {
  readonly secretBase32: string
  readonly accountName: string
  readonly issuer: string
}): string {
  const label = encodeURIComponent(`${args.issuer}:${args.accountName}`)
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

export const TOTP_PERIOD_SECONDS = PERIOD_SECONDS

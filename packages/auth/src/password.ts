import { randomBytes, type ScryptOptions, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { AppError } from '@berelax/shared'

// promisify picks the 3-argument overload, which drops the cost parameters. Type it explicitly so
// N, r and p are actually applied — silently falling back to defaults would be a real weakening.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/**
 * Password hashing with scrypt.
 *
 * scrypt rather than argon2id purely because it is in Node's standard library: an auth primitive that
 * needs a native build step is a deployment failure waiting to happen on App Platform. The parameters
 * below are deliberately costly — this runs at most a few times a day for a handful of staff, so
 * there is no throughput argument for weakening them.
 */
const KEY_LENGTH = 64
const SALT_LENGTH = 16
const PARAMS = { N: 2 ** 16, r: 8, p: 1, maxmem: 128 * 2 ** 16 * 8 * 2 } as const

const MIN_LENGTH = 12

export function assertPasswordPolicy(password: string): void {
  const problems: string[] = []
  if (password.length < MIN_LENGTH) problems.push(`at least ${MIN_LENGTH} characters`)
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter')
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter')
  if (!/\d/.test(password)) problems.push('a digit')
  if (problems.length > 0) {
    throw new AppError('validation', `Password must contain ${problems.join(', ')}`, {
      userFacing: true,
    })
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password)
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...PARAMS })
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`
}

/**
 * Verifies in constant time. Returns false rather than throwing on a malformed stored hash, so a
 * corrupt row cannot be distinguished from a wrong password by timing or by error message.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  try {
    const salt = Buffer.from(saltB64 ?? '', 'base64')
    const expected = Buffer.from(hashB64 ?? '', 'base64')
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(n) * Number(r) * 2,
    })
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

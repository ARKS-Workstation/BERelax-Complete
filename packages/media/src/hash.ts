/**
 * Content addressing.
 *
 * Separate from `derivatives.ts` so the storage adapters can verify a write without pulling libvips in
 * behind them, and separate from `url.ts` so the browser's copy of the URL logic carries no
 * `node:crypto`.
 */
import { createHash } from 'node:crypto'
import { CONTENT_HASH_LENGTH } from './url.ts'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The content address of a source: the first sixteen hex characters of its sha256.
 *
 * Sixteen and not sixty-four because the whole digest makes a URL that wraps in a log line and in an
 * editor, and sixteen hex characters is 64 bits — a collision between two photographs of one salon is
 * not a risk anybody needs to price. It is deliberately a prefix of the real digest rather than a
 * shorter hash, so the full digest can always be recomputed and compared.
 */
export function contentAddress(bytes: Uint8Array): string {
  return sha256Hex(bytes).slice(0, CONTENT_HASH_LENGTH)
}

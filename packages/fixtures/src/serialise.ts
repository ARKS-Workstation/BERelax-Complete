/**
 * Canonical serialisation, and the digest that makes "reproducible" checkable.
 *
 * `JSON.stringify` is not canonical: key order follows insertion order, so two structurally identical
 * objects can serialise to different bytes. That is exactly the difference a determinism test must
 * not be fooled by, in either direction — a false failure trains people to ignore it, and a false
 * pass makes it worthless.
 *
 * So keys are sorted at every level, and the digest is taken over the result. Two runs agreeing on
 * this digest agree on every value in the dataset.
 */
import { createHash } from 'node:crypto'

/** JSON with every object's keys sorted, recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value), null, 2)
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalise(entryValue)]))
}

/** SHA-256 over the canonical form, as hex. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

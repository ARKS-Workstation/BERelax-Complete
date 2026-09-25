import { DUPLICATE_QUEUE_SUBJECT_LIMIT } from '@berelax/db'
import type { RenderDirection } from './render.ts'

/**
 * The query parameters the queue and the preview share, parsed in one place.
 *
 * Both routes read `at`, `dir` and the `customer` scope, and the preview carries them onto every link it
 * renders. Two copies of these parsers is two answers to "what does `?at=nonsense` mean" — and the answer
 * matters: a parameter that silently did nothing would make a page taken at a named instant a page about a
 * different moment, and it would look right.
 *
 * A separate module rather than an export from `route.ts`, because importing one route handler's module
 * from another pulls in its `dynamic` declaration and its database connection for no reason. Next routes
 * only on `page.*` and `route.*` files, so this file adds no URL — `apps/web/src/routes/discover.ts`
 * implements that convention and `registry.test.ts` asserts the bijection.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The `customer` parameters, or undefined for the unscoped window.
 *
 * A value that is not a uuid is REFUSED rather than dropped: a scope silently narrowed to nothing renders
 * as "no duplicates", which is the one answer this screen must never give by accident.
 */
export function scopeFrom(url: URL): readonly string[] | undefined {
  const ids = url.searchParams.getAll('customer').filter((id) => id.trim() !== '')
  if (ids.length === 0) return undefined
  const bad = ids.filter((id) => !UUID.test(id))
  if (bad.length > 0) {
    throw new TypeError(`a customer scope is a uuid; refusing ${bad.join(', ')}`)
  }
  return ids
}

/** A uuid from a request, refused rather than coerced. */
export function idFrom(value: unknown, name: string): string {
  if (typeof value === 'string' && UUID.test(value)) return value
  throw new TypeError(`${name} must be a customer uuid`)
}

export function limitFrom(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null) return DUPLICATE_QUEUE_SUBJECT_LIMIT
  const limit = Number(raw)
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError(`a probe limit is a positive integer; refusing ${raw}`)
  }
  return limit
}

/**
 * The instant consent is resolved at. Refused rather than defaulted when it is unparseable.
 *
 * Defaulting to "now" for a value somebody meant is the failure `/compliance` refuses for the same reason:
 * the page would answer a different question and look right doing it. It is also what makes this screen
 * photographable — a page that read the clock could not be captured twice byte for byte.
 */
export function atFrom(url: URL): string {
  const raw = url.searchParams.get('at')
  if (raw === null) return new Date().toISOString()
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) {
    throw new TypeError(`an instant is an ISO-8601 timestamp; refusing ${raw}`)
  }
  return at.toISOString()
}

/** `?dir=rtl` mirrors the layout. A direction axis rather than a locale — see `render.ts`. */
export function directionFrom(url: URL): RenderDirection {
  return url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr'
}

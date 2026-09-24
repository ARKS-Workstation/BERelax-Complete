/**
 * Steps 4 and 5: the decisions that are not a read and not a render.
 *
 * A `.ts` module beside `state.ts` and for the same reason it gives: `apps/web`'s `tsconfig` sets
 * `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application at all. Everything here is
 * therefore checkable in a unit test with no server, no browser and no database — which is where an
 * idempotency key, a cooldown and a cookie policy belong, because all three are pure functions of their
 * input and all three are wrong in ways a screenshot cannot show.
 *
 * ## The POST-redirect-GET shape, and why it is not an island
 *
 * B-UI-01 put every choice in the URL so steps 1–3 work with JavaScript off. Steps 4 and 5 cannot be GET
 * — they send an SMS, verify a code, record consent and take a slot — but they do not have to be
 * JavaScript either. Each is a plain `<form method="post">` to `/api/v1/book`, which does the work and
 * answers **303 See Other** with the URL of the next state. A browser with no JavaScript follows it; a
 * browser with JavaScript does the same thing, and the island adds only the affordances HTML has no way
 * to express (E.164 on blur, a ticking cooldown, a disabled second submit).
 *
 * 303 and not 302, which is the one detail here that is a correctness bug rather than a preference: a 302
 * on a POST is re-issued as a POST by some clients, so a reader who reloaded the confirmation would
 * re-submit the booking. 303 requires the follow-up to be a GET. The idempotency key makes the re-POST
 * harmless as well, and both are here because "harmless" and "does not happen" are different properties
 * and the second one is what a reader experiences.
 *
 * ## The idempotency key is derived, not generated
 *
 * {@link bookingIdempotencyKey} is a pure function of the session, the treatment and the start, so the
 * SAME key is produced by the server-rendered hidden field, by a reload of that form, and by a second
 * browser tab on the same cookie. That is the whole of docs/09 §3's *"double submission (idempotency
 * key)"*: `createBooking` claims the key on `booking_idempotency`'s primary key before it locks a room,
 * so the second request blocks on the index and is answered from the first one's committed row.
 *
 * A generated key — `crypto.randomUUID()` in the island, or a fresh one per render — satisfies every
 * assertion about "the header is present" and none about double submission: two renders produce two keys
 * and two bookings. That mistake is invisible in review, because the code that makes it looks more
 * careful than the code that does not.
 */

import { createHash } from 'node:crypto'
import type { BookAfter, BookStep } from './state.ts'

/**
 * The cookie the flow's session travels in.
 *
 * `berelax_book`, and the prefix is deliberate: `berelax:theme` in `localStorage` uses a colon and a
 * cookie name may not contain one (RFC 6265 `token`), so the two conventions differ by necessity rather
 * than by accident and this note is why the next person should not "tidy" it.
 */
export const BOOK_SESSION_COOKIE = 'berelax_book'

/**
 * The cookie's attributes, assembled once.
 *
 * `httpOnly` because the value is a bearer credential and nothing on the page has any reason to read it —
 * an `httpOnly` cookie is the one thing that survives a cross-site scripting hole on this page.
 * `sameSite: 'lax'` rather than `strict`, because the flow is arrived at from Google Business Profile,
 * from a treatment page and from an SMS, and `strict` drops the cookie on a cross-site navigation — which
 * would present as "the booking flow forgets my number when I come from Google". `secure` outside
 * development, because a secure cookie on `http://127.0.0.1` is never sent and the integration suite
 * drives exactly that origin.
 */
export function bookSessionCookie(args: {
  readonly token: string
  readonly maxAgeSeconds: number
  readonly secure: boolean
}): string {
  const parts = [
    `${BOOK_SESSION_COOKIE}=${args.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(args.maxAgeSeconds))}`,
  ]
  if (args.secure) parts.push('Secure')
  return parts.join('; ')
}

/** The cookie value a request carries, or null. Parsed here so two callers cannot parse it two ways. */
export function bookSessionTokenFrom(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null
  for (const pair of cookieHeader.split(';')) {
    const index = pair.indexOf('=')
    if (index === -1) continue
    if (pair.slice(0, index).trim() !== BOOK_SESSION_COOKIE) continue
    const value = pair.slice(index + 1).trim()
    return value === '' ? null : value
  }
  return null
}

/**
 * The idempotency key for one attempt at one slot.
 *
 * Over the session, the treatment and the start, and deliberately not over the therapist or the room: the
 * booking endpoint re-chooses both inside the transaction, so a reader whose room was swapped is still
 * making the same request. `requestFingerprint` in `@berelax/db` is the other half — it refuses a key
 * reused for a genuinely different request — so a key that is too coarse is refused rather than silently
 * replayed, which is the safe direction for this to be wrong in.
 *
 * Hashed rather than concatenated, and the reason is not length. The session id is the primary key of a
 * row holding somebody's phone number, and `booking_idempotency.idempotency_key` is a column a support
 * query selects and pastes into a ticket. A hash is the same key with nothing in it to leak.
 */
export function bookingIdempotencyKey(args: {
  readonly sessionId: string
  readonly serviceVariantId: string
  readonly startsAt: number
}): string {
  const canonical = [args.sessionId, args.serviceVariantId, String(args.startsAt)].join('|')
  return `book:${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`
}

/**
 * Seconds until a resend is allowed, from the instant the server computed.
 *
 * Rounded UP, so a page that says "2 seconds" is never a page whose button is still refused when the
 * reader counts to two. `Math.floor` here would produce zero for 400ms remaining, and the button would
 * enable itself into a 429.
 */
export function resendCooldownSeconds(args: {
  readonly resendAvailableAtIso: string | null
  readonly now: number
}): number {
  if (args.resendAvailableAtIso === null) return 0
  const at = Date.parse(args.resendAvailableAtIso)
  if (Number.isNaN(at)) return 0
  return Math.max(0, Math.ceil((at - args.now) / 1000))
}

/**
 * The step a verified phone leads to.
 *
 * `confirm` unless the reader was on their way to the waitlist. The default is the booking rather than
 * the waitlist because a reader who arrives at step 4 with a slot chosen is booking it; a waitlist join
 * has to say so, and it does, in `after`.
 */
export function stepAfterVerification(after: BookAfter | null): BookStep {
  return after === 'waitlist' ? 'waitlist' : 'confirm'
}

/**
 * The step to send a reader to when a step needs a verified phone and there is not one.
 *
 * Always `details`, never `otp`: a code cannot be typed for a number that has not been submitted, and a
 * reader landing on a bare code box has no way to get a code. The `after` field is what brings them back.
 */
export const UNVERIFIED_STEP: BookStep = 'details'

/**
 * The actions the POST endpoint accepts, as a closed set.
 *
 * Named values, not a URL path per action: one endpoint means one place the session is resolved, one
 * place the redirect is built and one place a locale is read. Five paths would be five places to forget
 * the session check, and the one that forgot it would be the one that books.
 */
export const BOOK_ACTIONS = [
  'send_code',
  'resend_code',
  'verify_code',
  'confirm',
  'join_waitlist',
] as const
export type BookAction = (typeof BOOK_ACTIONS)[number]

export function isBookAction(value: string | null): value is BookAction {
  return value !== null && (BOOK_ACTIONS as readonly string[]).includes(value)
}

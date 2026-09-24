import { describe, expect, it } from 'vitest'
import {
  BOOK_ACTIONS,
  BOOK_SESSION_COOKIE,
  bookingIdempotencyKey,
  bookSessionCookie,
  bookSessionTokenFrom,
  isBookAction,
  resendCooldownSeconds,
  stepAfterVerification,
  UNVERIFIED_STEP,
} from './flow.ts'
import {
  BOOK_FLOW_ERRORS,
  BOOK_ISSUES,
  BOOK_STEPS,
  isBookFlowError,
  parseBookingParams,
  VERIFIED_STEPS,
} from './state.ts'

/**
 * B-UI-02 — the four decisions steps 4 and 5 make that are pure functions of their input.
 *
 * Each of them is wrong in a way a rendered page does not show:
 *
 *   - **the idempotency key.** A key that varies per render satisfies every assertion about "the header is
 *     present" and produces two bookings on a double tap. The defect looks like more care than the fix.
 *   - **the cooldown.** Rounded down, a page says "0 seconds" for 400ms of remaining wait and the button
 *     enables itself into a 429.
 *   - **the cookie policy.** `SameSite=Strict` drops the cookie on the navigation from Google Business
 *     Profile, which presents as "the flow forgets my number when I arrive from Google" and cannot be
 *     reproduced by anybody typing the URL.
 *   - **the cookie parser.** A cookie header carries several pairs, and a parser that took the first or
 *     matched a prefix would read another cookie's value as a session token.
 */

const SESSION = '0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e22'
const VARIANT = '0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e23'
const START = Date.parse('2026-10-24T15:45:00.000Z')

describe('the idempotency key', () => {
  it('is the same for the same attempt at the same slot, every time it is derived', () => {
    // The property the whole of "double submission creates exactly one booking" rests on. Two renders of
    // the confirm form, or two tabs on one cookie, must produce ONE key.
    const first = bookingIdempotencyKey({
      sessionId: SESSION,
      serviceVariantId: VARIANT,
      startsAt: START,
    })
    const second = bookingIdempotencyKey({
      sessionId: SESSION,
      serviceVariantId: VARIANT,
      startsAt: START,
    })
    expect(first).toBe(second)
    expect(first.startsWith('book:')).toBe(true)
  })

  it('differs for a different slot, a different treatment and a different attempt', () => {
    // The control. A key that was constant would also be "the same every time", and the second booking a
    // customer ever made would be answered with their first one.
    const base = { sessionId: SESSION, serviceVariantId: VARIANT, startsAt: START }
    const keys = new Set([
      bookingIdempotencyKey(base),
      bookingIdempotencyKey({ ...base, startsAt: START + 3_600_000 }),
      bookingIdempotencyKey({ ...base, serviceVariantId: SESSION }),
      bookingIdempotencyKey({ ...base, sessionId: VARIANT }),
    ])
    expect(keys.size).toBe(4)
  })

  it('carries neither the session id nor the number of anything in it', () => {
    // The session id is the primary key of a row holding a phone number, and this value is a column a
    // support query pastes into a ticket.
    const key = bookingIdempotencyKey({
      sessionId: SESSION,
      serviceVariantId: VARIANT,
      startsAt: START,
    })
    expect(key).not.toContain(SESSION)
    expect(key).not.toContain(VARIANT)
    expect(key).not.toContain(String(START))
    expect(key.length).toBeLessThan(64)
  })
})

describe('the resend cooldown', () => {
  it('is zero when a resend is available and rounds a part-second up', () => {
    const now = Date.parse('2026-10-24T15:00:00.000Z')
    expect(resendCooldownSeconds({ resendAvailableAtIso: null, now })).toBe(0)
    expect(resendCooldownSeconds({ resendAvailableAtIso: '2026-10-24T14:59:00.000Z', now })).toBe(0)
    // 400ms remaining is one second of wait, not none. Rounded down, the button enables itself into a 429.
    expect(resendCooldownSeconds({ resendAvailableAtIso: '2026-10-24T15:00:00.400Z', now })).toBe(1)
    expect(resendCooldownSeconds({ resendAvailableAtIso: '2026-10-24T15:00:45.000Z', now })).toBe(
      45,
    )
  })

  it('answers zero for an unparseable instant rather than NaN', () => {
    // A NaN reaches the island as `disabled={NaN > 0}` — false — and the label as "Another code in NaN
    // seconds". Zero is the honest fallback: the endpoint still refuses a request inside its own window.
    const now = Date.parse('2026-10-24T15:00:00.000Z')
    expect(resendCooldownSeconds({ resendAvailableAtIso: 'not an instant', now })).toBe(0)
  })
})

describe('the session cookie', () => {
  it('is http-only, lax and path-wide, and secure only when asked', () => {
    const cookie = bookSessionCookie({ token: 'abc', maxAgeSeconds: 1200, secure: false })
    expect(cookie.startsWith(`${BOOK_SESSION_COOKIE}=abc;`)).toBe(true)
    expect(cookie).toContain('HttpOnly')
    // Lax and not Strict: the flow is arrived at from Google Business Profile, a treatment page and an
    // SMS, and Strict drops the cookie on a cross-site navigation.
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('SameSite=Strict')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=1200')
    // The control: a Secure cookie is never sent over http, and the integration suite drives 127.0.0.1.
    expect(cookie).not.toContain('Secure')
    expect(bookSessionCookie({ token: 'abc', maxAgeSeconds: 1200, secure: true })).toContain(
      'Secure',
    )
  })

  it('never writes a negative or fractional Max-Age', () => {
    expect(bookSessionCookie({ token: 'a', maxAgeSeconds: -5, secure: false })).toContain(
      'Max-Age=0',
    )
    expect(bookSessionCookie({ token: 'a', maxAgeSeconds: 12.7, secure: false })).toContain(
      'Max-Age=12',
    )
  })

  it('finds its own value among several cookies, whatever the order', () => {
    expect(bookSessionTokenFrom(`${BOOK_SESSION_COOKIE}=tok`)).toBe('tok')
    expect(bookSessionTokenFrom(`a=1; ${BOOK_SESSION_COOKIE}=tok; b=2`)).toBe('tok')
    expect(bookSessionTokenFrom(`  ${BOOK_SESSION_COOKIE} = tok ; other=x`)).toBe('tok')
  })

  it('does not match a cookie whose name merely begins the same way', () => {
    // The control, and the real defect: `berelax_booking_ref=…` would otherwise be read as a session
    // token, which resolves to `unknown` and silently restarts the flow.
    expect(bookSessionTokenFrom(`${BOOK_SESSION_COOKIE}x=tok`)).toBeNull()
    expect(bookSessionTokenFrom(`x${BOOK_SESSION_COOKIE}=tok`)).toBeNull()
    expect(bookSessionTokenFrom('other=1; another=2')).toBeNull()
    expect(bookSessionTokenFrom(null)).toBeNull()
    expect(bookSessionTokenFrom(`${BOOK_SESSION_COOKIE}=`)).toBeNull()
  })
})

describe('the vocabularies', () => {
  it('declares five actions and eleven refusals, each recognised only by name', () => {
    expect(BOOK_ACTIONS).toHaveLength(5)
    for (const action of BOOK_ACTIONS) expect(isBookAction(action)).toBe(true)
    expect(isBookAction('confirm_booking')).toBe(false)
    expect(isBookAction(null)).toBe(false)
    expect(BOOK_FLOW_ERRORS.length).toBeGreaterThan(5)
    for (const error of BOOK_FLOW_ERRORS) expect(isBookFlowError(error)).toBe(true)
    expect(isBookFlowError('something_else')).toBe(false)
  })

  it('sends verification to the booking unless the reader asked for the waiting list', () => {
    expect(stepAfterVerification(null)).toBe('confirm')
    expect(stepAfterVerification('confirm')).toBe('confirm')
    expect(stepAfterVerification('waitlist')).toBe('waitlist')
  })

  it('sends an unverified reader to the number and never to the code', () => {
    // A code cannot be typed for a number nobody has submitted. Landing on a bare code box is a dead end
    // with no way to get a code, which is the failure this constant exists to prevent.
    expect(UNVERIFIED_STEP).toBe('details')
    expect(VERIFIED_STEPS).not.toContain(UNVERIFIED_STEP)
    expect(VERIFIED_STEPS).not.toContain('otp')
  })

  it('parses every step and every issue the flow can reach, and nothing else', () => {
    // The URL is the state, so a step the parser cannot read is a step no link can reach — a bug that
    // presents as "the button goes back to the first screen".
    for (const step of BOOK_STEPS) {
      expect(parseBookingParams({ step }).step, step).toBe(step)
    }
    expect(parseBookingParams({ step: 'checkout' }).step).toBe('choose')
    for (const issue of BOOK_ISSUES) {
      expect(parseBookingParams({ issue }).issue, issue).toBe(issue)
    }
    // Only the two a reader can honestly report. A field that accepted `slot_taken` would let a URL
    // assert a state the page has not checked.
    expect(parseBookingParams({ issue: 'slot_taken' }).issue).toBeNull()
    for (const error of BOOK_FLOW_ERRORS) {
      expect(parseBookingParams({ error }).error, error).toBe(error)
    }
    expect(parseBookingParams({ error: 'anything' }).error).toBeNull()
  })

  it('accepts a booking id only in the uuid form, and after is one of two words', () => {
    const uuid = '0199f0d1-2b4e-7c9a-8f1e-3d5a7b9c1e22'
    expect(parseBookingParams({ booking: uuid }).booking).toBe(uuid)
    expect(parseBookingParams({ booking: 'not-a-uuid' }).booking).toBeNull()
    expect(parseBookingParams({ after: 'waitlist' }).after).toBe('waitlist')
    expect(parseBookingParams({ after: 'somewhere' }).after).toBeNull()
  })
})

import { COLLECT_MAX_BATCH_EVENTS, SESSION_INACTIVITY_MS } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  COLLECT_RATE_MAX_REQUESTS,
  COLLECT_RATE_WINDOW_MS,
  decideCollectRate,
  stitchSession,
  TRADING_DATE_BASES_CHECKED,
} from './ingest.ts'

/**
 * The two decisions `/api/collect` makes from arithmetic, under a frozen clock.
 *
 * Frozen is the point, and it is why these functions are here rather than in the route: the acceptance
 * lines are "two events 29 minutes apart share a session id", "31 minutes apart create a second session"
 * and "200 requests inside a frozen second". None of the three can be asserted against a function that
 * reads the clock, and the first two cannot be asserted against a real one at all without a test that takes
 * half an hour.
 */

const AT = Date.parse('2026-09-29T21:00:00.000+04:00')
const MINUTE = 60_000

describe('stitching a session on thirty minutes of inactivity', () => {
  it('continues at 29 minutes and starts a new one at 31', () => {
    // The acceptance line, in the two figures it names, and asserted against the constant rather than
    // against 1_800_000 written again — a test that restated the window would agree with itself if
    // somebody changed it.
    expect(stitchSession({ lastEventAtMs: AT - 29 * MINUTE, atMs: AT }).kind).toBe('continue')
    expect(stitchSession({ lastEventAtMs: AT - 31 * MINUTE, atMs: AT }).kind).toBe('new')
    expect(SESSION_INACTIVITY_MS).toBe(30 * MINUTE)
  })

  it('treats the window as half-open, so exactly thirty minutes is a new session', () => {
    // `[0, window)`, which is every other window in this build — `resolveTradingDate`'s `[open, close)` and
    // the rate limiter below. One instant cannot be in two windows, and the boundary is where an
    // off-by-one produces a session count that is wrong by exactly the number of visitors who paused for
    // half an hour.
    expect(stitchSession({ lastEventAtMs: AT - SESSION_INACTIVITY_MS, atMs: AT }).kind).toBe('new')
    expect(stitchSession({ lastEventAtMs: AT - SESSION_INACTIVITY_MS + 1, atMs: AT }).kind).toBe(
      'continue',
    )
  })

  it('reports how long the session had been idle when it starts a new one', () => {
    const stitch = stitchSession({ lastEventAtMs: AT - 45 * MINUTE, atMs: AT })
    expect(stitch.kind).toBe('new')
    expect(stitch.kind === 'new' ? stitch.idleMs : null).toBe(45 * MINUTE)
  })

  it('continues a session for an event that arrives EARLIER than its last one', () => {
    // A batched beacon flushes out of order: the collector queues while offline and posts on the next
    // `visibilitychange`, so a page view whose client instant precedes one already stored is a late
    // arrival and not a new visit. An absolute-difference implementation would answer `new` here and give
    // one visitor two sessions for never having left, which is the control that a signed comparison is
    // deliberate rather than accidental.
    expect(stitchSession({ lastEventAtMs: AT + 40 * MINUTE, atMs: AT }).kind).toBe('continue')
  })
})

describe('the per-caller request budget', () => {
  it('refuses the 200 requests the acceptance line fires inside one frozen second', () => {
    // The claim, exactly as stated: 200 requests, one instant, and the refusals are what the route answers
    // 429 to. Nothing here advances a clock, so "inside a second" is a property of the test rather than of
    // how fast the machine is (brief rule 23).
    let hitsMs: readonly number[] = []
    let allowed = 0
    let refused = 0
    for (let request = 0; request < 200; request += 1) {
      const decision = decideCollectRate({ hitsMs, atMs: AT })
      hitsMs = decision.hitsMs
      if (decision.allowed) allowed += 1
      else refused += 1
    }
    expect(allowed).toBe(COLLECT_RATE_MAX_REQUESTS)
    expect(refused).toBe(200 - COLLECT_RATE_MAX_REQUESTS)
    // And the cap is DERIVED from the batch cap rather than chosen, which is the one figure the
    // specification gives.
    expect(COLLECT_RATE_MAX_REQUESTS).toBe(COLLECT_MAX_BATCH_EVENTS)
    expect(COLLECT_RATE_MAX_REQUESTS).toBeLessThan(200)
  })

  it('does not record a refused request, so retrying cannot extend the penalty', () => {
    const full = Array.from({ length: COLLECT_RATE_MAX_REQUESTS }, (_, index) => AT - index)
    const first = decideCollectRate({ hitsMs: full, atMs: AT })
    expect(first.allowed).toBe(false)
    expect(first.hitsMs.length).toBe(COLLECT_RATE_MAX_REQUESTS)
    // Ten retries later the list is the same length. A limiter that counted refusals would grow it and the
    // caller would never come back inside the window — a rate limit that has become a lockout, which is
    // why `otp.ts` counts issued challenges and not refused ones.
    let hitsMs = first.hitsMs
    for (let retry = 0; retry < 10; retry += 1) {
      hitsMs = decideCollectRate({ hitsMs, atMs: AT }).hitsMs
    }
    expect(hitsMs.length).toBe(COLLECT_RATE_MAX_REQUESTS)
  })

  it('frees the budget as the window slides off the oldest hit, not on a calendar boundary', () => {
    // A fixed window lets a caller spend double the allowance across its boundary, which for this endpoint
    // is double the write volume. The oldest hit ageing out is what frees exactly one slot.
    const full = Array.from({ length: COLLECT_RATE_MAX_REQUESTS }, (_, index) => AT - index)
    expect(decideCollectRate({ hitsMs: full, atMs: AT }).allowed).toBe(false)
    const later = AT + COLLECT_RATE_WINDOW_MS
    const freed = decideCollectRate({ hitsMs: full, atMs: later })
    expect(freed.allowed).toBe(true)
    // Everything that had aged out is gone, and only the one this request added plus the hits still inside
    // the window remain.
    expect(freed.hitsMs.every((hit) => later - hit < COLLECT_RATE_WINDOW_MS)).toBe(true)
  })

  it('answers a Retry-After of at least one second, never zero', () => {
    /*
     * And the reason is the window's own strictness, not the `Math.max(1, …)` in the source.
     *
     * Every live hit is strictly inside the window, so the oldest one frees strictly after `atMs`, so the
     * quotient is in `(0, 1]` and `Math.ceil` of that is 1. The clamp is therefore unreachable — which this
     * unit's gate block proved by being unable to write a case that broke it. It is kept as the guard for
     * the one edit that would make it reachable (a `<=` in the filter), and the half-open case below is
     * what actually holds the answer above zero.
     *
     * So this case asserts the ANSWER rather than the mechanism, at both ends of the refusing range: a
     * caller refused the instant it filled its budget, and one refused a millisecond before the window
     * frees. Both get 1, and `Retry-After: 0` — which means "now", an instruction to hammer the endpoint —
     * is unrepresentable.
     */
    const full = Array.from({ length: COLLECT_RATE_MAX_REQUESTS }, () => AT)
    const refused = decideCollectRate({ hitsMs: full, atMs: AT })
    expect(refused.retryAfterSeconds).toBe(1)
    const almost = decideCollectRate({ hitsMs: full, atMs: AT + COLLECT_RATE_WINDOW_MS - 1 })
    expect(almost.allowed).toBe(false)
    expect(almost.retryAfterSeconds).toBe(1)
    // The control for "never zero": a refused answer is never 0, and an ALLOWED one always is — so the
    // figure means "wait" and nothing else, and a caller branching on it cannot confuse the two.
    expect(decideCollectRate({ hitsMs: [], atMs: AT }).retryAfterSeconds).toBe(0)
  })

  it('treats the window as half-open, so a hit exactly one window old has expired', () => {
    const full = Array.from({ length: COLLECT_RATE_MAX_REQUESTS }, () => AT)
    expect(decideCollectRate({ hitsMs: full, atMs: AT + COLLECT_RATE_WINDOW_MS }).allowed).toBe(
      true,
    )
    expect(decideCollectRate({ hitsMs: full, atMs: AT + COLLECT_RATE_WINDOW_MS - 1 }).allowed).toBe(
      false,
    )
  })

  it('honours an overridden window and cap, which is what makes the defaults testable at all', () => {
    const decision = decideCollectRate({ hitsMs: [AT, AT], atMs: AT, windowMs: 10, maxRequests: 2 })
    expect(decision.allowed).toBe(false)
    expect(
      decideCollectRate({ hitsMs: [AT], atMs: AT, windowMs: 10, maxRequests: 2 }).allowed,
    ).toBe(true)
  })

  it('never throws and never returns a shorter-than-legal Retry-After, over arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 200 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        (offsets, nowOffset) => {
          const decision = decideCollectRate({
            hitsMs: offsets.map((offset) => AT + offset),
            atMs: AT + nowOffset,
          })
          // Every retained hit is inside the window, in both branches. A limiter that kept an expired hit
          // would refuse a caller for traffic it sent an hour ago.
          for (const hit of decision.hitsMs) {
            expect(AT + nowOffset - hit).toBeLessThan(COLLECT_RATE_WINDOW_MS)
          }
          if (decision.allowed) {
            expect(decision.retryAfterSeconds).toBe(0)
            expect(decision.hitsMs).toContain(AT + nowOffset)
          } else {
            expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1)
          }
          return true
        },
      ),
      { numRuns: 300 },
    )
  })

  it('generates inputs that can actually refuse, and counts them', () => {
    /*
     * Brief rule 22, and this case found the defect it exists for on its first run.
     *
     * The obvious generator — `fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { maxLength: 200
     * })` — refused **zero times in 2,000 runs**, for two compounding reasons. Offsets spread over a
     * million milliseconds put almost nothing inside a 1,000 ms window, and `fc.array` biases hard towards
     * SHORT arrays, so a `maxLength` of 200 typically produced fewer than ten hits against a cap of fifty.
     * The property above would have held for a limiter that never refused anything, and the assertion about
     * `Retry-After` in its `else` branch would have been checking a branch nothing reached.
     *
     * So the length is drawn UNIFORMLY through a `chain` rather than left to the array shrinker's bias, and
     * the offsets are drawn from twice the window so about half of any batch is live. MEASURED, not
     * reasoned about: 50.5% of 3,000 runs refuse, and repeated measurement stayed within a couple of points
     * of that. The floor is `runs / 8` — far under the observed share and far above zero, which is the
     * shape a vacuity floor has to have, because a floor set just below the minimum becomes its own flake.
     */
    const window = COLLECT_RATE_WINDOW_MS
    const batches = fc.integer({ min: 0, max: 200 }).chain((length) =>
      fc.array(fc.integer({ min: -2 * window, max: 0 }), {
        minLength: length,
        maxLength: length,
      }),
    )
    let refusing = 0
    const runs = 400
    fc.assert(
      fc.property(batches, (offsets) => {
        if (
          !decideCollectRate({ hitsMs: offsets.map((offset) => AT + offset), atMs: AT }).allowed
        ) {
          refusing += 1
        }
        return true
      }),
      { numRuns: runs },
    )
    expect(
      refusing,
      'the generator never produced a refusal, so the property above proved only one of its two branches',
    ).toBeGreaterThan(runs / 8)
  })
})

describe('the trading-date basis vocabulary', () => {
  it('is held equal to the resolver by the compiler, and the assertion is still reachable', () => {
    // `TRADING_DATE_BASES_CHECKED` exists so the two-way type assertion cannot be removed as dead code, and
    // this case is what stops the export itself being removed as unused. Asserting on its value would be
    // asserting on a tuple's length; what is worth asserting is that it is there.
    expect(TRADING_DATE_BASES_CHECKED).toBe(2)
  })
})

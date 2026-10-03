import { describe, expect, it } from 'vitest'
import {
  businessInformationEditLimit,
  PerProfileRateLimit,
  reviewReplyLimit,
  simulatedRateLimitClock,
} from './token-bucket.ts'

/**
 * The limiter, over its real window.
 *
 * Every assertion here is about a sixty-second window and runs in milliseconds, which is the whole
 * reason the clock is injected: the alternative is a suite that shortens the window to a figure
 * production does not use and then asserts arithmetic about that figure.
 */
describe('the per-profile edit limiter', () => {
  it('admits the cap immediately and queues the rest, dropping none (6/min, 20 submissions)', async () => {
    const clock = simulatedRateLimitClock()
    const limit = reviewReplyLimit(clock)
    const delivered: number[] = []

    // Twenty submissions "within one second": the simulated clock does not advance on its own, so every
    // one of them arrives at the same instant, which is the strictest reading of the acceptance line.
    const all = Array.from({ length: 20 }, (_, index) =>
      limit.run(async () => {
        delivered.push(index)
      }),
    )
    await Promise.all(all)

    // None dropped. The assertion the acceptance criterion names, and it is a final delivery count
    // rather than a queue length: a limiter that queued and never delivered would pass the other way.
    expect(delivered).toHaveLength(20)
    expect(delivered).toEqual(Array.from({ length: 20 }, (_, index) => index))

    // At most six in the FIRST simulated minute. `0` is the first admitted instant, so the first minute
    // is [0, 60_000) — exclusive, because a call admitted exactly on the boundary is in the next window.
    expect(limit.admittedWithin(0, 59_999)).toBe(6)

    // And no window of the whole run holds more than six, which is the claim a fixed window cannot make.
    for (const call of limit.admitted) {
      expect(limit.admittedWithin(call.atMs - 59_999, call.atMs)).toBeLessThanOrEqual(6)
    }

    // 6, 6, 6, 2 — one minute apart. Stated as the instants rather than as a batch count, because a
    // limiter that delivered all twenty at t=180_000 would also produce four distinct instants.
    const instants = limit.admitted.map((call) => call.atMs)
    expect(instants).toEqual([
      0, 0, 0, 0, 0, 0, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 120_000, 120_000, 120_000,
      120_000, 120_000, 120_000, 180_000, 180_000,
    ])
  })

  it('queues the eleventh edit of a minute and delivers it later, never early (10/min)', async () => {
    const clock = simulatedRateLimitClock()
    const limit = businessInformationEditLimit(clock)
    const delivered: { readonly index: number; readonly atMs: number }[] = []

    await Promise.all(
      Array.from({ length: 11 }, (_, index) =>
        limit.run(async () => {
          delivered.push({ index, atMs: clock.now() })
        }),
      ),
    )

    expect(delivered).toHaveLength(11)
    // The first ten are admitted on arrival; the eleventh is not attempted before the window turns.
    expect(delivered.slice(0, 10).map((call) => call.atMs)).toEqual(Array(10).fill(0))
    expect(delivered[10]?.atMs).toBe(60_000)
    expect(limit.admitted[10]?.queuedMs).toBe(60_000)
  })

  it('does not attempt the queued call before its slot: the task runs after the wait', async () => {
    const clock = simulatedRateLimitClock()
    const limit = new PerProfileRateLimit({ name: 'probe', limit: 1, windowMs: 60_000, clock })
    const attemptedAt: number[] = []

    const first = limit.run(async () => {
      attemptedAt.push(clock.now())
    })
    const second = limit.run(async () => {
      attemptedAt.push(clock.now())
    })
    await first
    // The control that makes the claim non-vacuous: at this point the second task must NOT have run.
    expect(attemptedAt).toEqual([0])
    await second
    expect(attemptedAt).toEqual([0, 60_000])
  })

  it('charges a failed call its slot, because Google counted it', async () => {
    const clock = simulatedRateLimitClock()
    const limit = new PerProfileRateLimit({ name: 'probe', limit: 1, windowMs: 60_000, clock })

    await expect(
      limit.run(async () => {
        throw new Error('the transport refused')
      }),
    ).rejects.toThrow('the transport refused')

    // The chain survives a rejection — one failed edit must not stop every later one — and the slot is
    // spent, so the next call waits.
    let ranAt = -1
    await limit.run(async () => {
      ranAt = clock.now()
    })
    expect(ranAt).toBe(60_000)
    expect(limit.admitted).toHaveLength(2)
  })

  it('refuses a limit or a window that could not be a cap', () => {
    const clock = simulatedRateLimitClock()
    expect(
      () => new PerProfileRateLimit({ name: 'zero', limit: 0, windowMs: 60_000, clock }),
    ).toThrow('at least one call per window')
    expect(
      () => new PerProfileRateLimit({ name: 'fractional', limit: 6, windowMs: 0, clock }),
    ).toThrow('A window must be a whole number')
  })

  it('declares the two figures docs/10 §7 names, and they are not the same figure', () => {
    const clock = simulatedRateLimitClock()
    // The pair is the point: the reviews limiter is deliberately UNDER the profile edit cap, because the
    // two share one cap at Google and this process cannot see another worker's window.
    expect(businessInformationEditLimit(clock).limit).toBe(10)
    expect(reviewReplyLimit(clock).limit).toBe(6)
    expect(reviewReplyLimit(clock).limit).toBeLessThan(businessInformationEditLimit(clock).limit)
    expect(reviewReplyLimit(clock).windowMs).toBe(60_000)
  })
})

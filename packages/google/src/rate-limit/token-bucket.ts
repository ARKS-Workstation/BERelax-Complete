/**
 * The per-profile edit limiter: a sliding window, with the clock and the wait injected.
 *
 * docs/10 §7 states two caps and they are the same cap read twice. Business Information: *"Edits are
 * capped at 10 per minute per profile and Google states this cannot be raised"*. Reviews (legacy v4):
 * *"Plan a 6/min token bucket against the 10 edits/min cap"*. One mechanism serves both — G-SEO-06's
 * hours write at 10 and G-REV-07's `updateReply` at 6 — because two limiters would be two answers to how
 * many edits this profile has spent, and the one that is wrong is whichever ran second.
 *
 * ## Why a sliding window and not a refilling bucket
 *
 * A continuously refilling bucket at 6/min admits a call every ten seconds, so twenty calls submitted at
 * once produce ELEVEN in the first minute (six immediately, then five on the refill) — which is over the
 * cap the acceptance criterion names and over the cap Google enforces. A fixed window is worse in a
 * different way: it refills on a boundary, so twelve calls can land inside one sixty-second span that
 * straddles it, and the limiter's own claim ("at most N per minute") is then false of every window but
 * the ones it chose.
 *
 * A sliding window is the only one of the three whose claim is true of EVERY window: a call is admitted
 * only when fewer than `limit` calls were admitted in the preceding `windowMs`. Twenty calls at 6/min
 * therefore leave in four batches of 6, 6, 6 and 2, one minute apart, and the count inside any minute of
 * the run is at most six.
 *
 * ## Why the clock AND the wait are injected, and why that is not two seams
 *
 * They are one seam: a limiter is a statement about time, and a test that cannot move time can only
 * assert that nothing was delayed. `setTimeout` in a test turns a one-minute window into a one-minute
 * test, so every suite that ever asserted on a limiter either shortened the window — proving the
 * arithmetic against a window production does not use — or asserted the queue length and not the
 * delivery. {@link simulatedRateLimitClock} advances the clock to the instant the limiter asks to wait
 * until, so the assertions are about the real window.
 *
 * ## What it does NOT do
 *
 * It does not retry, it does not time out, and it does not drop. A submitted call is delivered when its
 * slot arrives, however long that is, because the alternative is an edit that was approved by a human and
 * silently discarded by a rate limiter. If a caller needs a deadline, the deadline belongs to the caller:
 * a limiter that cancelled work would make "none is dropped" untrue in a way no count could see.
 *
 * It is also NOT durable. The window lives in this process, so two workers each hold their own — which is
 * honest rather than hidden: a durable per-profile window needs a row and a lock, and docs/10 §4 already
 * serialises Google work through an advisory transaction lock for the token refresh. The 6/min figure is
 * the headroom that covers it, and that is the reason it is 6 against a cap of 10 rather than 10.
 */
import { AppError } from '@berelax/shared'

/** The two things a limiter needs from time. Injected together, because they are one seam. */
export interface RateLimitClock {
  /** Milliseconds since the epoch. */
  now(): number
  /** Resolves no earlier than `whenMs`. A wait already in the past resolves on the next tick. */
  waitUntil(whenMs: number): Promise<void>
}

/**
 * The real clock.
 *
 * `setTimeout` with a floor of zero rather than a negative delay: Node treats a negative delay as 1ms,
 * which is the same answer, and relying on that would make the floor a property of the runtime.
 */
export const systemRateLimitClock: RateLimitClock = {
  now: () => Date.now(),
  waitUntil: (whenMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, whenMs - Date.now()))
    }),
}

/** A clock a test drives. See the header: a limiter that cannot be tested over its real window is not. */
export interface SimulatedRateLimitClock extends RateLimitClock {
  /** Every instant the limiter asked to wait until, in order. The waits it actually made. */
  readonly waits: readonly number[]
}

/**
 * A clock that jumps to whatever the limiter asks for.
 *
 * Exported from the module under test rather than written twice, because both callers of the limiter —
 * G-SEO-06's hours write and G-REV-07's reply submitter — need the same simulated window, and the brief
 * forbids a second statement of a fact without the check that holds the two equal. There is no such check
 * available for a test helper, so there is one helper.
 *
 * It never goes backwards: a wait for an instant already past advances nothing, which is what makes the
 * admitted-call count a property of the window rather than of the order the awaits resolved in.
 */
export function simulatedRateLimitClock(startMs = 0): SimulatedRateLimitClock {
  let current = startMs
  const waits: number[] = []
  return {
    now: () => current,
    async waitUntil(whenMs) {
      waits.push(whenMs)
      if (whenMs > current) current = whenMs
      // A real await, so the limiter's queue yields exactly as it does against `systemRateLimitClock`.
      await Promise.resolve()
    },
    get waits() {
      return waits
    },
  }
}

export interface PerProfileRateLimitOptions {
  /** Which cap this is, by name, so a refusal and a log line say which limiter spoke. */
  readonly name: string
  /** How many calls may be admitted in any window of `windowMs`. */
  readonly limit: number
  readonly windowMs: number
  readonly clock: RateLimitClock
}

/** One admitted call, as the limiter recorded it. The evidence a test asserts the window over. */
export interface AdmittedCall {
  readonly sequence: number
  readonly atMs: number
  /** How long this call waited for its slot. Zero for a call that was admitted on arrival. */
  readonly queuedMs: number
}

/**
 * A sliding-window limiter for one profile's edits.
 *
 * Serial by construction: `run` chains onto the previous submission, so calls are admitted in submission
 * order and the window is consulted once per call. Concurrency here would buy nothing — the cap is one
 * per profile — and would make the admitted order a property of the event loop.
 */
export class PerProfileRateLimit {
  readonly name: string
  readonly limit: number
  readonly windowMs: number
  private readonly clock: RateLimitClock
  /** The instants of the admitted calls still inside the window, oldest first. At most `limit` long. */
  private readonly window: number[] = []
  private readonly admittedCalls: AdmittedCall[] = []
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: PerProfileRateLimitOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new AppError(
        'validation',
        `A rate limit must admit at least one call per window; ${options.name} declares ` +
          `${options.limit}. A limit of zero is a disabled feature pretending to be a cap.`,
      )
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new AppError(
        'validation',
        `${options.name} declares a window of ${options.windowMs}ms. A window must be a whole number ` +
          'of milliseconds: a fractional one makes the admitted count depend on floating-point rounding.',
      )
    }
    this.name = options.name
    this.limit = options.limit
    this.windowMs = options.windowMs
    this.clock = options.clock
  }

  /** Every call this limiter has admitted, in order. */
  get admitted(): readonly AdmittedCall[] {
    return this.admittedCalls
  }

  /** How many calls were admitted in the window ending at `atMs`. What the cap is a claim about. */
  admittedWithin(fromMs: number, toMs: number): number {
    return this.admittedCalls.filter((call) => call.atMs >= fromMs && call.atMs <= toMs).length
  }

  /**
   * Runs `task` as soon as a slot is free, and never before.
   *
   * The task is invoked AFTER the wait and AFTER the slot is recorded, which is the whole of "never
   * attempted early": there is no path through this method that reaches `task()` without having first
   * found or waited for a slot. A task that throws still consumes its slot — the call was made, and
   * Google counted it.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const queuedAtMs = this.clock.now()
    const mine = this.tail.then(async () => {
      await this.acquire(queuedAtMs)
      return await task()
    })
    // The chain must not break on a rejected task, or one failed edit stops every later one. The caller
    // still sees the rejection through `mine`; the chain sees a resolved promise.
    this.tail = mine.then(
      () => undefined,
      () => undefined,
    )
    return mine
  }

  private async acquire(queuedAtMs: number): Promise<void> {
    for (;;) {
      const now = this.clock.now()
      this.evict(now)
      if (this.window.length < this.limit) {
        this.window.push(now)
        this.admittedCalls.push({
          sequence: this.admittedCalls.length + 1,
          atMs: now,
          queuedMs: now - queuedAtMs,
        })
        return
      }
      // The oldest admitted call in the window is the one whose departure frees a slot. `window[0]`
      // exists: the length is at least `limit`, which the constructor holds at one or more.
      const oldest = this.window[0] as number
      await this.clock.waitUntil(oldest + this.windowMs)
    }
  }

  private evict(now: number): void {
    while (this.window.length > 0 && (this.window[0] as number) + this.windowMs <= now) {
      this.window.shift()
    }
  }
}

/**
 * The Business Information edit cap: 10 per minute per profile, which docs/10 §7 says cannot be raised.
 *
 * A function rather than a shared instance. The window belongs to a profile, and a module-level limiter
 * would make two profiles share one — which is the right answer for a single-premises business today and
 * silently wrong the day there are two. It is also what keeps a test's limiter out of the next test's.
 */
export function businessInformationEditLimit(clock: RateLimitClock): PerProfileRateLimit {
  return new PerProfileRateLimit({
    name: 'business_information_edits',
    limit: 10,
    windowMs: 60_000,
    clock,
  })
}

/**
 * The reviews reply cap: 6 per minute, deliberately under the 10 the profile allows.
 *
 * docs/10 §7 names the figure and this is the reason it is not 10: the edit cap is shared with the hours
 * write above, the quota actually applied to legacy v4 is on the *must confirm* list, and a limiter whose
 * window lives in one process cannot see a second worker's. Four edits a minute of headroom is what
 * covers all three.
 */
export function reviewReplyLimit(clock: RateLimitClock): PerProfileRateLimit {
  return new PerProfileRateLimit({
    name: 'review_reply_updates',
    limit: 6,
    windowMs: 60_000,
    clock,
  })
}

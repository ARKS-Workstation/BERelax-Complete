/**
 * The two decisions `/api/collect` makes from arithmetic over instants (A-FIRST-05): whether an event
 * continues a session or begins one, and whether a caller has had its budget.
 *
 * Both are here rather than in the route for the same reason: each is a claim the acceptance list makes
 * about a FROZEN clock — "two events 29 minutes apart share a session id", "200 requests inside a frozen
 * second" — and a decision that read the clock could not be tested under one. So every instant is an
 * argument, in milliseconds, and the route is the only thing that knows what "now" is.
 *
 * The window itself lives in `@berelax/shared` beside the wire contract, because the browser collector
 * cannot import `@berelax/core` and the thirty minutes is a fact the collector's own batching is shaped
 * by. Nothing here restates it.
 */
import {
  COLLECT_MAX_BATCH_EVENTS,
  SESSION_INACTIVITY_MS,
  type TradingDateBasis,
} from '@berelax/shared'
import type { OutsideTradingReason } from '../business-day/resolve.ts'

/**
 * Whether an event at `atMs` belongs to the session whose last event was at `lastEventAtMs`.
 *
 * ## Why this takes the last event and not the session's start
 *
 * Thirty minutes of INACTIVITY, not thirty minutes of session. A visitor reading for an hour with a page
 * view every ten minutes is one session; the same visitor coming back after lunch is two. Measuring from
 * the start would cut a long genuine visit in half at the half-hour and report the second half as a new
 * arrival, which inflates the funnel's first bucket — and the first bucket is the denominator every
 * conversion rate on the analytics page divides by.
 *
 * ## Why an event that arrives EARLIER than the session's last event still continues it
 *
 * A batched beacon flushes out of order: the collector queues while offline and posts on the next
 * `visibilitychange` (A-FIRST-06), so a page view whose client instant is earlier than one already stored
 * is an ordinary late arrival rather than a new visit. A gap computed as an absolute difference would
 * make a forty-minute-late flush open a second session for a visitor who never left — which is why the
 * comparison is signed and a negative gap continues.
 *
 * Note what this means for a client whose clock is wrong: a browser reporting instants from last week
 * flushes into the session it arrives in. That is the right trade. The alternative — trusting the client
 * enough to split sessions on it — lets a wrong clock multiply one visitor into a hundred.
 */
export type SessionStitch =
  | { readonly kind: 'continue' }
  | { readonly kind: 'new'; readonly idleMs: number }

export function stitchSession(args: {
  readonly lastEventAtMs: number
  readonly atMs: number
}): SessionStitch {
  const idleMs = args.atMs - args.lastEventAtMs
  if (idleMs < SESSION_INACTIVITY_MS) return { kind: 'continue' }
  return { kind: 'new', idleMs }
}

/**
 * The per-caller request budget: how many requests, over how long.
 *
 * ## Where these two figures come from, and the one that is not answered
 *
 * The WINDOW is one second because the claim is about a burst: the acceptance line fires 200 requests
 * inside a frozen second, and a limiter whose window is longer would pass that test while permitting a
 * sustained flood. The CAP is `COLLECT_MAX_BATCH_EVENTS`, the only figure the specification gives —
 * a client sending fifty batches in one second has already sent 2,500 events, which is more than a page
 * can produce, so the cap is above every real client by a wide margin and below the 200 the acceptance
 * line requires refused. It is deliberately not a number chosen for how it feels.
 *
 * Whether fifty a second is the right operational ceiling is a question this build cannot answer from a
 * document — it depends on traffic nobody has measured yet — so it is recorded as
 * `Y5-collect-rate-limit` rather than presented as a decision (brief rule 15). Changing it changes one
 * constant and no code.
 *
 * ## Why a sliding window and not a fixed one
 *
 * `packages/db/src/repositories/otp.ts` records the reason on its own limiter: a fixed window lets a
 * caller spend double the allowance across its boundary. The hits are kept as instants and aged out, so
 * the allowance is per second at every second rather than per calendar second.
 */
export const COLLECT_RATE_WINDOW_MS = 1_000

/**
 * The cap, DERIVED from the batch cap rather than written as a number of its own.
 *
 * So the two move together: raising how many events one request may carry cannot silently multiply how
 * many events a second a caller may send, because the request budget falls out of the same figure.
 */
export const COLLECT_RATE_MAX_REQUESTS = COLLECT_MAX_BATCH_EVENTS

/**
 * What the limiter decided, and the hit list to keep.
 *
 * The retained list is RETURNED rather than mutated in place, because this module is pure and the state
 * belongs to whoever is holding it — the route keeps a map, a test keeps a local. A function that mutated
 * its argument would be untestable in the one way that matters: you could not ask it the same question
 * twice and get the same answer.
 */
export interface CollectRateDecision {
  readonly allowed: boolean
  /** The hits inside the window, including this one when it was allowed. Ascending. */
  readonly hitsMs: readonly number[]
  /**
   * Seconds a refused caller should wait. Never 0, because `Retry-After: 0` means "now".
   *
   * It cannot be 0 by ARITHMETIC rather than by the clamp below, and the distinction is worth stating
   * because it decides what can be tested: every live hit is strictly inside the window, so the oldest
   * one frees at some instant strictly after `atMs`, so the quotient is in `(0, 1]` and `Math.ceil` of
   * that is 1. The clamp is therefore unreachable today — see {@link decideCollectRate}.
   */
  readonly retryAfterSeconds: number
}

export function decideCollectRate(args: {
  readonly hitsMs: readonly number[]
  readonly atMs: number
  readonly windowMs?: number
  readonly maxRequests?: number
}): CollectRateDecision {
  const windowMs = args.windowMs ?? COLLECT_RATE_WINDOW_MS
  const maxRequests = args.maxRequests ?? COLLECT_RATE_MAX_REQUESTS
  // Strictly inside the window: a hit exactly `windowMs` old has expired. Half-open, like every other
  // window in this build (`resolveTradingDate`'s `[open, close)`), so one instant cannot be in two.
  const live = args.hitsMs.filter((hit) => args.atMs - hit < windowMs)
  if (live.length >= maxRequests) {
    const oldest = live.reduce((lowest, hit) => (hit < lowest ? hit : lowest), live[0] as number)
    const freesAt = oldest + windowMs
    return {
      allowed: false,
      // The refused request is NOT recorded. Counting it would extend the caller's own penalty every
      // time it retried, which is the shape that turns a rate limit into a lockout — `otp.ts` counts
      // issued challenges and not refused ones for the same reason.
      hitsMs: live,
      /*
       * `Math.max(1, …)` is UNREACHABLE while the filter above is strict, and it stays anyway.
       *
       * Stated rather than quietly kept, because a clamp that can never bind is indistinguishable from a
       * clamp that is load-bearing, and this unit's own gate block found the difference: a case that broke
       * the clamp and required a check to fire could not exist, because breaking it changes no answer.
       * What makes it unreachable is one character — `<` in the filter. Change it to `<=` and a hit exactly
       * `windowMs` old becomes live, `freesAt` equals `atMs`, and the honest figure is 0: an instruction to
       * retry immediately, issued to the caller already over its budget. So the clamp is the guard for that
       * edit and nothing else, and `ingest.test.ts` asserts the half-open window instead — which is the
       * property that actually holds the answer above zero.
       */
      retryAfterSeconds: Math.max(1, Math.ceil((freesAt - args.atMs) / 1000)),
    }
  }
  return { allowed: true, hitsMs: [...live, args.atMs], retryAfterSeconds: 0 }
}

/* ------------------------------------------------------------------------------------------------
 * The trading-date basis vocabulary, held equal to the resolver's own reasons AT COMPILE TIME
 * ------------------------------------------------------------------------------------------------ */

/**
 * `TRADING_DATE_BASES` minus `trading` must be exactly `OutsideTradingReason`, in both directions.
 *
 * The tuple has to live in `@berelax/shared` — `@berelax/db` writes the column and may never import
 * `@berelax/core` (ADR 0001) — which means it cannot be derived from the resolver's own union. So the
 * agreement is asserted, and asserted by the compiler rather than by a test: a reason added to
 * `resolveTradingDate` and not to the tuple fails `pnpm typecheck`, and a word in the tuple the resolver
 * cannot produce fails it too.
 *
 * Both directions matter and they fail differently. A missing reason means a real session in the daytime
 * gap has no basis it is allowed to declare, so the ZY222 trigger refuses the row and the visit is lost. A
 * spare word means the database accepts a basis nothing can produce, which is a column with a value no
 * reader can interpret.
 *
 * `never` rather than `false` as the failing branch, because an unused `false`-typed alias is a type a
 * linter is entitled to consider satisfied; assigning `true` to `never` is an error nothing can widen.
 */
type OutsideBasis = Exclude<TradingDateBasis, 'trading'>
type EveryReasonIsABasis = OutsideTradingReason extends OutsideBasis ? true : never
type EveryBasisIsAReason = OutsideBasis extends OutsideTradingReason ? true : never

const TRADING_DATE_BASES_MATCH_THE_RESOLVER: [EveryReasonIsABasis, EveryBasisIsAReason] = [
  true,
  true,
]

/**
 * Exported so the assertion above cannot be deleted as dead code.
 *
 * An unread `const` is exactly what a cleanup removes, and removing it would take the only check that
 * these two vocabularies agree with it. Reading it as the tuple's own length makes it load-bearing:
 * `taxonomy.test.ts`'s pinning argument, one directory over, in one line.
 */
export const TRADING_DATE_BASES_CHECKED = TRADING_DATE_BASES_MATCH_THE_RESOLVER.length

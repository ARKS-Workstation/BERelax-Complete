import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * `rate_limit_window` (0165): one upsert on the hot path, and a reader that makes the limit measurable.
 *
 * ## The hot path is ONE statement, and that is the whole design
 *
 * `insert … on conflict (scope, key, window_started_at) do update set hits = hits + 1 … returning hits`.
 * A read followed by a write is how two workers both see `hits = limit - 1` and both allow — the defect a
 * rate limit exists to prevent, reproduced inside the rate limiter. The row lock the upsert takes is held
 * for the length of one statement, which is why this scales to the collector's 240-per-minute ceiling.
 *
 * It takes an `Sql` and not a `UnitOfWork`, which is the opposite of nearly everything else in this
 * directory, and the reason is what the row is: a counter, not an audited fact. An audit row per request
 * on the four busiest unauthenticated endpoints would make `audit_event` mostly a traffic log, and the
 * one table an insider-threat review reads would be unreadable. The MEASUREMENT lives in this table
 * instead, which is what makes the limit observable.
 *
 * ## `hits` includes the request being decided
 *
 * The upsert increments and returns, so the count that comes back is this request's own. `decideRateLimit`
 * in `@berelax/shared` is written against that shape and its boundary is `hits > limit`: a policy of 20
 * permits the twentieth and refuses the twenty-first.
 */

export interface RateLimitHit {
  readonly hits: number
  readonly windowStartedAtMs: number
}

/**
 * Counts this request and returns the new total.
 *
 * `windowStartedAtIso` is computed by the caller from the policy's length (`windowStartFor`), never here:
 * this package may not import the policy, and re-deriving the window in SQL would be a second reading of
 * a length this table does not hold.
 */
export async function recordRateLimitHit(
  sql: Sql,
  args: {
    readonly scope: string
    readonly key: string
    readonly windowStartedAtIso: string
    readonly atIso: string
  },
): Promise<RateLimitHit> {
  const [row] = await sql<{ hits: number; windowStartedAt: Date }[]>`
    insert into rate_limit_window (scope, key, window_started_at, hits, first_seen_at, last_seen_at)
    values (${args.scope}, ${args.key}, ${args.windowStartedAtIso}::timestamptz, 1,
            ${args.atIso}::timestamptz, ${args.atIso}::timestamptz)
    on conflict (scope, key, window_started_at) do update
      set hits = rate_limit_window.hits + 1,
          last_seen_at = greatest(rate_limit_window.last_seen_at, excluded.last_seen_at)
    returning hits, window_started_at as "windowStartedAt"
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The rate limit upsert returned no row')
  }
  return { hits: row.hits, windowStartedAtMs: row.windowStartedAt.getTime() }
}

/**
 * Records that this window refused a request.
 *
 * A SECOND statement, after the decision, and deliberately: the upsert above cannot know whether the
 * count it returned is over the ceiling, because the ceiling is the policy's and the policy is in
 * `@berelax/shared`. Folding the comparison into SQL would be a second statement of every limit, in a
 * place no test of the arithmetic can reach.
 *
 * It is `hits`-bounded by a CHECK (`refusals <= hits`), so a refusal recorded for a request that was
 * never counted is refused by the database rather than by care.
 */
export async function recordRateLimitRefusal(
  sql: Sql,
  args: {
    readonly scope: string
    readonly key: string
    readonly windowStartedAtIso: string
  },
): Promise<void> {
  await sql`
    update rate_limit_window
       set refusals = refusals + 1
     where scope = ${args.scope}
       and key = ${args.key}
       and window_started_at = ${args.windowStartedAtIso}::timestamptz
  `
}

export interface RateLimitWindowRow {
  readonly scope: string
  readonly key: string
  readonly windowStartedAt: Date
  readonly hits: number
  readonly refusals: number
  readonly firstSeenAt: Date
  readonly lastSeenAt: Date
}

/**
 * Every window for a scope, newest first. The reader that makes the ceiling measurable.
 *
 * Bounded by `limit`, because an operator asks about the recent past and an unbounded read of a counter
 * table gets slower every day. It is the ONE reader: *an unmeasured limit is a guess*, and a limit whose
 * hits nothing can read is unmeasured however carefully the number was chosen.
 */
export async function readRateLimitWindows(
  sql: Sql,
  args: { readonly scope: string; readonly limit?: number },
): Promise<readonly RateLimitWindowRow[]> {
  return sql<RateLimitWindowRow[]>`
    select scope,
           key,
           window_started_at as "windowStartedAt",
           hits,
           refusals,
           first_seen_at     as "firstSeenAt",
           last_seen_at      as "lastSeenAt"
      from rate_limit_window
     where scope = ${args.scope}
     order by window_started_at desc, key
     limit ${args.limit ?? 100}
  `
}

/** One window by its whole key, for a test that asserts a count rather than a decision. */
export async function readRateLimitWindow(
  sql: Sql,
  args: {
    readonly scope: string
    readonly key: string
    readonly windowStartedAtIso: string
  },
): Promise<RateLimitWindowRow | null> {
  const [row] = await sql<RateLimitWindowRow[]>`
    select scope,
           key,
           window_started_at as "windowStartedAt",
           hits,
           refusals,
           first_seen_at     as "firstSeenAt",
           last_seen_at      as "lastSeenAt"
      from rate_limit_window
     where scope = ${args.scope}
       and key = ${args.key}
       and window_started_at = ${args.windowStartedAtIso}::timestamptz
  `
  return row ?? null
}

/**
 * Drops every window that closed before `beforeIso`. The sweep, run as the OWNER.
 *
 * `berelax_app` holds no DELETE on this table (0165 revokes it) because a caller who could delete their own
 * window could reset their own ceiling, so this statement only works for the owner — which is the right
 * way round and is asserted in both directions by `rate-limit.itest.ts`.
 *
 * Why it exists at all: the key is a caller's IP address, which is personal data under the PDPL, and the
 * proportionality argument for keeping one covers the length of a window rather than for ever.
 * `RATE_LIMIT_RETENTION_DAYS` in `@berelax/shared` holds the bound and the reasoning. Nothing schedules
 * this yet and the module header there says so rather than implying a cron that does not exist.
 *
 * Returns the number of windows removed, so a caller that does schedule it has something to report.
 */
export async function deleteRateLimitWindowsBefore(
  sql: Sql,
  args: { readonly beforeIso: string },
): Promise<number> {
  const removed = await sql`
    delete from rate_limit_window
     where window_started_at < ${args.beforeIso}::timestamptz
  `
  return removed.count
}

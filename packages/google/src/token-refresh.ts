import type { Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { GoogleConnectionStore } from './connection-store.ts'
import {
  type AccessTokenGrant,
  cachedAccessGrant,
  loadActiveConnection,
  refreshAccessToken,
  type TokenLifecycleDeps,
} from './lifecycle.ts'
import { createPostgresConnectionStore } from './postgres-store.ts'

/**
 * Proactive token refresh, serialised by a Postgres **advisory transaction lock**, double-checked.
 *
 * This module holds one claim and nothing else: *at most one worker refreshes a given connection's
 * access token, and the losers of the race use the winner's token rather than spending another refresh.*
 * The refresh itself stays in `lifecycle.ts`, which is deliberate — see the note on the chokepoint at
 * the bottom of this comment.
 *
 * ## Why a lock at all
 *
 * pg-boss can start the review poll, the SEO crawl and the daily health check in the same second, on
 * different workers, all holding the same stale row (docs/10 §4). Without serialisation each of them
 * refreshes, and each refresh is a request Google is entitled to answer with a **rotated refresh
 * token**. The last write wins, the other tokens are now invalid, and the connection dies at a moment
 * nothing in the deploy log explains. A refresh that runs twice is not merely wasteful; it is how the
 * grant breaks.
 *
 * ## Why the TRANSACTION lock and not the session one
 *
 * `pg_advisory_lock` is held by the *session* and released by an explicit `pg_advisory_unlock`, by a
 * `pg_advisory_unlock_all`, or by the connection closing. A refresh that throws between taking it and
 * releasing it leaves the lock held on a pooled connection that goes straight back into the pool — and
 * every subsequent refresh of that connection blocks for ever, on a lock nothing in the code still
 * wants. `pg_advisory_xact_lock` is released by COMMIT or ROLLBACK, whichever happens, so the failing
 * path needs no cleanup and cannot leak one. There is no lease to expire and no distributed-lock
 * correctness argument to make; a crashed worker's transaction is rolled back by the server.
 * `token-refresh.itest.ts` asserts `pg_locks` is empty for the computed key after the commit, and its
 * control takes the *session* lock in a rolled-back transaction and finds it still held.
 *
 * ## Why the check happens TWICE
 *
 * The first check is outside the lock, and it is the important one for throughput: the common case is a
 * token with fifty minutes to live, and taking a lock for that would serialise every Google call in the
 * system behind one row. The second check is inside the lock, and it is the important one for
 * correctness: between deciding to refresh and acquiring the lock, another worker may have refreshed
 * and committed. Skipping it turns nine waiters into nine refreshes that arrive in a queue rather than
 * in parallel — the lock would make the race orderly without making it harmless.
 *
 * The double check only works because the re-read sees the winner's committed write, and **that depends
 * on READ COMMITTED**, where every statement takes a fresh snapshot. Under REPEATABLE READ the snapshot
 * is taken at the first statement — the lock acquisition itself — so the re-read would return the row as
 * it was *before* the winner committed, and the loser would refresh anyway while looking correct. That
 * is silent, so it is asserted rather than assumed: `assertReadCommitted` runs inside the transaction on
 * `current_setting('transaction_isolation')`.
 *
 * ## Why the refresh stays in lifecycle.ts
 *
 * `scripts/check-google-token-chokepoint.mjs` and the `google-tokens-only-in-with-google` rule name the
 * five modules that may hold a plaintext Google token. This module is not one of them and did not need
 * to become one: it obtains an `AccessTokenGrant` from `lifecycle.ts` and passes it back to
 * `withGoogle`, and it never names `openToken`, `sealToken` or `connectionBinding` and never imports
 * `token-store.ts`. Widening the allow-list to six modules to hold a lock would have traded a real
 * guarantee for a cosmetic file move.
 */

/**
 * The advisory-lock namespace, from docs/10 §4: `hashtextextended('google:'||$1, 0)`.
 *
 * A prefix rather than the bare id, because the advisory-lock key space is global to the database and
 * shared with every other lock anybody adds. Two subsystems hashing a bare UUID would eventually collide
 * on one, and the symptom is a refresh blocking on something with no relation to Google at all.
 *
 * Exported so the integration test computes the key with the same expression this module locks on. A
 * test that hashed its own string would pass while watching the wrong key.
 */
export const REFRESH_LOCK_NAMESPACE = 'google:'

/** Default ceiling on waiting for the lock. See `RefreshLockOptions.lockTimeoutMs`. */
export const DEFAULT_REFRESH_LOCK_TIMEOUT_MS = 10_000

/** `details.reason` on the error a lock wait raises, so a caller branches without parsing prose. */
export const REFRESH_LOCK_TIMEOUT = 'google_refresh_lock_timeout'

/** `details.reason` on the error a wrong isolation level raises. */
export const REFRESH_LOCK_WRONG_ISOLATION = 'google_refresh_lock_wrong_isolation'

/** What the body of a locked refresh is handed: a store scoped to the locking transaction. */
export interface LockedRefreshScope {
  /**
   * The same store interface, bound to the transaction that holds the lock.
   *
   * Transaction-scoped rather than the caller's pooled store, and this is the half that makes the lock
   * mean something: a refresh that wrote through a *different* connection would commit outside the
   * transaction the lock is attached to, so a second worker could read the new token before the winner
   * had finished and the two writes would interleave anyway.
   */
  readonly store: GoogleConnectionStore
}

/**
 * The serialisation seam.
 *
 * An interface rather than a concrete function so the unit tests can exercise the double check with no
 * database — the same argument `connection-store.ts` makes. `createMemoryRefreshLock` is not more
 * permissive than the Postgres one: it serialises too, because a fake lock that let two bodies run at
 * once would make every unit test above it pass for the wrong reason.
 */
export interface RefreshLockRunner {
  withConnectionLock<T>(
    connectionId: string,
    body: (scope: LockedRefreshScope) => Promise<T>,
  ): Promise<T>
}

export interface RefreshLockOptions {
  /**
   * How long to wait for the lock before giving up.
   *
   * Not optional behaviour, because `pg_advisory_xact_lock` waits for ever by default. If the winner's
   * HTTPS call to Google hangs, every waiter holds an open transaction and therefore a pooled
   * connection, and the pool is shared with the rest of the application — one slow Google call would
   * become `53300 too_many_connections` for the booking flow. A `lock_timeout` converts that into one
   * failed job the queue retries with backoff, which is a strictly smaller blast radius.
   */
  readonly lockTimeoutMs?: number
}

/**
 * Refuses to double-check inside a snapshot that predates the lock.
 *
 * Exported because it is the one part of the guard that is testable without a database, and a guard
 * whose failure branch has never run is not a guard. See the isolation paragraph in the header.
 */
export function assertReadCommitted(isolation: string): void {
  if (isolation === 'read committed') return
  throw new AppError(
    'invariant_violated',
    `A proactive Google token refresh must run in READ COMMITTED, not '${isolation}'. A snapshot ` +
      'taken before the lock was acquired cannot see the winning refresh, so the double check would ' +
      'read the stale row and refresh again — silently, and while looking correct.',
    { details: { reason: REFRESH_LOCK_WRONG_ISOLATION, isolation } },
  )
}

/**
 * The real lock: one transaction per refresh, `pg_advisory_xact_lock`, released at commit.
 *
 * `sql.begin` is what owns the transaction, so the lock's lifetime is the transaction's lifetime by
 * construction rather than by a `finally` somebody can forget.
 */
export function createPostgresRefreshLock(
  sql: Sql,
  options: RefreshLockOptions = {},
): RefreshLockRunner {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_REFRESH_LOCK_TIMEOUT_MS
  return {
    async withConnectionLock(connectionId, body) {
      return sql.begin(async (tx) => {
        // `set_config(…, true)` is `SET LOCAL`: it reverts at the end of this transaction, so the
        // timeout cannot leak onto the next user of a pooled connection. Written as a function call
        // rather than `set local lock_timeout = …` because SET does not take a bind parameter, and an
        // interpolated one would be string-concatenated SQL.
        const settings = await tx<{ isolation: string }[]>`
          select
            set_config('lock_timeout', ${`${Math.max(1, Math.trunc(timeoutMs))}ms`}, true) as timeout,
            current_setting('transaction_isolation') as isolation
        `
        assertReadCommitted(settings[0]?.isolation ?? 'unknown')

        // A separate statement from the settings above, deliberately: the evaluation order of a
        // select's target list is not defined, so a `set_config` sitting beside the lock call might or
        // might not have applied when the lock starts waiting.
        try {
          await tx`
            select pg_advisory_xact_lock(
              hashtextextended(${REFRESH_LOCK_NAMESPACE} || ${connectionId}, 0)
            )
          `
        } catch (error) {
          // 55P03 is lock_not_available, which is what lock_timeout raises. Anything else is not ours
          // to relabel — a connection failure reported as a lock conflict would send an operator to
          // look at concurrency for a database that is down.
          if ((error as { code?: unknown }).code !== '55P03') throw error
          throw new AppError(
            'conflict',
            `Timed out after ${timeoutMs}ms waiting to refresh the Google token for connection ` +
              `${connectionId}. Another worker holds the refresh lock. Classified TransientUpstream, ` +
              'so the queue retries with backoff rather than the caller degrading.',
            { details: { reason: REFRESH_LOCK_TIMEOUT, connectionId, lockTimeoutMs: timeoutMs } },
          )
        }

        return body({ store: createPostgresConnectionStore(tx as unknown as Sql) })
      }) as Promise<Awaited<ReturnType<typeof body>>>
    },
  }
}

/**
 * An in-process lock over a store that has no transactions, for the unit tests.
 *
 * Mutual exclusion per connection id via a promise chain. It reproduces the guarantee rather than
 * pretending to have it, for the reason `memory-store.ts` gives: a fake more permissive than the real
 * thing is how a bug reaches production green. What it cannot reproduce is atomicity — the memory store
 * has no transaction, so a body that fails halfway leaves its earlier writes in place. That difference
 * is why the concurrency claim is asserted against real PostgreSQL and not here.
 */
export function createMemoryRefreshLock(store: GoogleConnectionStore): RefreshLockRunner {
  const tails = new Map<string, Promise<unknown>>()
  return {
    async withConnectionLock(connectionId, body) {
      const previous = tails.get(connectionId) ?? Promise.resolve()
      // `.then` on a settled-or-not predecessor, and `catch` on the chain rather than on the body, so
      // one failed refresh does not wedge every later one behind a rejected promise.
      const mine = previous.catch(() => undefined).then(() => body({ store }))
      tails.set(
        connectionId,
        mine.catch(() => undefined),
      )
      return mine
    },
  }
}

export interface ProactiveRefreshDeps extends TokenLifecycleDeps {
  readonly lock: RefreshLockRunner
}

export interface AccessTokenOptions {
  /**
   * Refresh even when the cached token has plenty of life left. Default false.
   *
   * There is exactly one caller: the daily health check (G-CONN-06). Its whole job is to answer *"does
   * this grant still work"*, and the cached-token fast path cannot answer it — a token with fifty
   * minutes to live proves only that something refreshed recently. Two invalidations in docs/10 §4 are
   * invisible to any other path: the **seven-day Testing expiry**, which is the launch blocker, and the
   * **six-months-unused** auto-invalidation, which the daily check is what makes structurally
   * impossible. Both are discovered by *asking Google for a token* and by nothing else.
   *
   * The lock is still taken, and that is not a formality: the point of the lock is that the health
   * check, the review poll and the SEO crawl can start in the same second on different workers, and a
   * forced refresh outside it would be the one refresh that races. What is skipped is only the
   * double **check** — deliberately, because the winner's fresh token is precisely the answer a forced
   * refresh must not accept.
   */
  readonly force?: boolean
}

/**
 * Obtains an access token, refreshing it proactively and at most once across every worker.
 *
 * Proactive means *before* expiry, inside the five-minute margin
 * (`ACCESS_TOKEN_REFRESH_MARGIN_MINUTES`), and **never reactively on a 401**. A reactive refresh spends
 * a round trip on every cron cycle and fills the error taxonomy with 401s that mean nothing, which is
 * how the one 401 that means the grant is dead gets lost among them (docs/10 §4). Nothing here inspects
 * a response status; a 401 from an API call reaches `withGoogle`'s classifier and is reported, and this
 * function is not consulted again.
 *
 * The lock is taken only when a refresh is actually due, which is the reason the first check exists at
 * all — see the header.
 */
export async function accessTokenUnderLock(
  deps: ProactiveRefreshDeps,
  connectionId: string,
  options: AccessTokenOptions = {},
): Promise<AccessTokenGrant> {
  const connection = await loadActiveConnection(deps.store, connectionId)
  if (options.force !== true) {
    const cached = cachedAccessGrant(deps, connection)
    if (cached !== null) return cached
  }

  const outcome = await deps.lock.withConnectionLock<LockedRefreshOutcome>(
    connectionId,
    async (scope) => {
      // The double check. Read through the LOCKED store, not the outer one: the outer store is a
      // different pooled connection and its read would not be inside the transaction the lock belongs to.
      const locked = await loadActiveConnection(scope.store, connectionId)
      if (options.force !== true) {
        const winner = cachedAccessGrant(deps, locked)
        if (winner !== null) return { kind: 'ok', grant: winner }
      }

      // Both writes `refreshAccessToken` makes — the token columns and the append-only `refreshed` event —
      // now happen inside this transaction, so they commit together or not at all. Outside a transaction
      // they are two statements, and a crash between them leaves a refreshed token with no event beside
      // it: the connection panel then shows a successful call that the log says never happened.
      try {
        return {
          kind: 'ok',
          grant: await refreshAccessToken({ ...deps, store: scope.store }, locked),
        }
      } catch (error) {
        // **Caught so the transaction commits, and rethrown outside it.** This is not defensive coding;
        // it is the difference between detecting a dead grant and not.
        //
        // `refreshAccessToken`'s failure path writes the two rows that *are* the detection: the status
        // moving to `needs_reauth` with `status_reason = invalid_grant`, and the append-only
        // `reauth_required` event that the connection panel renders and that deduplicates the owner's
        // email to one per incident. Both are written through `scope.store`, which is this transaction.
        // Letting the throw propagate out of `sql.begin` rolls the transaction back and takes both of
        // them with it — so a revoked grant, or a Testing-status client on day seven, would be
        // discovered and then forgotten, every time, silently. The connection would stay `active` with a
        // valid-looking row and no event, and the only symptom would be every Google capability quietly
        // degrading for ever.
        //
        // It was found by G-CONN-06's own day-eight test, not by review: the success path's atomicity was
        // argued carefully and the failure path was overlooked.
        return { kind: 'failed', error }
      }
    },
  )
  if (outcome.kind === 'failed') throw outcome.error
  return outcome.grant
}

/**
 * The two shapes a locked refresh can end in, so a failure can commit its evidence before it propagates.
 *
 * A union rather than a throw, and the reason is the comment inside `accessTokenUnderLock`: the rows that
 * record *why* a grant died are written inside the locking transaction, and a throw rolls them back.
 */
type LockedRefreshOutcome =
  | { readonly kind: 'ok'; readonly grant: AccessTokenGrant }
  | { readonly kind: 'failed'; readonly error: unknown }

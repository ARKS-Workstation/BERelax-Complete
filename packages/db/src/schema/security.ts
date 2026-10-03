import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * `rate_limit_window` — the public endpoints' ceilings, as rows (0165, H-HARD-01).
 *
 * One row per `(scope, key, window_started_at)`: the hits, the refusals, and the first and last instant.
 * It is the rate-limit STATE and the rate-limit OBSERVATION, and it is one table because those are the
 * same rows — the acceptance line asks for state that survives a worker restart, and the rule beside it
 * is that an unmeasured limit is a guess.
 *
 * The hot path is ONE statement: `recordRateLimitHit` is an upsert returning the new count, because a
 * read followed by a write is how two workers both see `hits = limit - 1` and both allow.
 *
 * **UPDATE is kept for the application role**, which is the one place in this estate it is: the counters
 * are the state. DELETE is revoked, because a caller who could delete their own window could reset their
 * own ceiling. **ZY861** holds the row's IDENTITY immutable — the scope, the key and the window start may
 * not move and the counters may only increase — so the only thing an UPDATE can do is count.
 */
export const rateLimitWindow = pgTable(
  'rate_limit_window',
  {
    scope: text('scope').notNull(),
    /** The caller's address, lower-cased by `rateLimitKey`. Text and not `inet`: see the migration. */
    key: text('key').notNull(),
    /** From `windowStartFor` in `@berelax/shared`, STORED rather than derived in SQL. */
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
    /** Every request counted in this window, refused ones included. */
    hits: integer('hits').notNull(),
    /** The subset that was refused, so traffic and ceiling-fired are both answerable from one row. */
    refusals: integer('refusals').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'rate_limit_window_pkey',
      columns: [t.scope, t.key, t.windowStartedAt],
    }),
    index('rate_limit_window_scope_idx').on(t.scope, t.windowStartedAt),
    check(
      'rate_limit_window_scope_is_known',
      sql`${t.scope} in ('booking', 'collect', 'payment_webhook', 'consent', 'payment_intent',
                     'whatsapp_ref')`,
    ),
    check('rate_limit_window_key_is_not_blank', sql`length(btrim(${t.key})) > 0`),
    check('rate_limit_window_counters_are_nonneg', sql`${t.hits} >= 0 and ${t.refusals} >= 0`),
    check('rate_limit_window_refusals_are_a_subset', sql`${t.refusals} <= ${t.hits}`),
    check('rate_limit_window_last_seen_follows_first', sql`${t.lastSeenAt} >= ${t.firstSeenAt}`),
  ],
)

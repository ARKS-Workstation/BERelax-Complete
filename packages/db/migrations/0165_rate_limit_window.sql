-- ---------------------------------------------------------------------------------------------
-- 0165 — rate_limit_window (H-HARD-01)
-- ---------------------------------------------------------------------------------------------
-- One row per (scope, key, window): the hits, the refusals and the first and last instant. It is the
-- rate-limit STATE and the rate-limit OBSERVATION, and it is one table because those are the same rows.
--
-- ## Why the state is in PostgreSQL and not in the process
--
-- The acceptance line is that "rate-limit state is server-side and survives a worker restart", and an
-- in-process counter fails that twice over: it is lost on a restart, and with two workers it is two
-- counters, each permitting the whole limit. A deployment that rolls pods every hour would reset every
-- ceiling every hour and nothing would say so.
--
-- Redis is the usual answer and this build has none: docs/05 contracts no cache, and adding one for a
-- counter would be a second datastore to operate, back up and reason about consistency with. A row per
-- window in the database the application already has is enough for a salon's traffic — the hot path is
-- ONE statement, an upsert returning the new count — and it is durable by construction.
--
-- ## Why one STATEMENT and not a read then a write
--
-- `recordRateLimitHit` is a single `insert … on conflict … do update … returning hits`. Two statements is
-- how two workers both read `hits = limit - 1` and both allow, which is the defect a rate limit exists to
-- prevent, reproduced inside the rate limiter. The row lock the upsert takes is held for the length of one
-- statement.
--
-- ## Why the window is a COLUMN and not derived from `created_at`
--
-- The window's start is computed by `windowStartFor` in `@berelax/core`'s neighbour `@berelax/shared`, from
-- the policy's length, and stored. Deriving it here would be a second reading of the policy — in SQL,
-- against a length this table does not hold — and the two would disagree the first time somebody changed a
-- window. It is part of the key, so a new window is a new row and the old one stays as the measurement.
--
-- ## Why the counters are UPDATED while almost everything else here is append-only
--
-- A counter that could only be inserted would be one row per request, which for the collector's 240-per-
-- minute ceiling is a write amplifier pointed at the database this endpoint exists to keep away from. The
-- WINDOW is the append-only unit: a row is never deleted and never re-keyed, its counters only ever
-- increase, and ZY861 refuses an UPDATE that would move the window, the key or the scope — so the row's
-- identity is immutable and only its tallies move. A retention sweep may remove old windows; nothing else
-- may touch them.
--
-- ## ZY861 is the only private SQLSTATE here
--
-- ZY862 through ZY870 were allocated to this unit and are RELEASED UNUSED and deliberately unregistered.
-- Everything else this table has to say is a CHECK — the scope vocabulary, the non-negative counters, the
-- refusals never exceeding the hits — and `pnpm sqlstate` refuses an entry for a code no migration raises.

create table rate_limit_window (
  -- The natural key IS the identity: there is nothing to reference this row by, and a surrogate id would
  -- make the upsert's `on conflict` target a unique index beside the primary key for no benefit.
  scope              text        not null,
  -- The caller's address, lower-cased by `rateLimitKey`. Text and not `inet`, because the key is a
  -- STRING the limiter compares and some scopes will key on something that is not an address — the OTP's
  -- per-phone ceiling is `issueOtpChallenge`'s, and the day a scope keys on an API client this column
  -- holds that too. An `inet` would force a cast on every read of a value that is only ever compared.
  key                text        not null,
  -- The window's start, from `windowStartFor`. Part of the key: see the header on why it is not derived.
  window_started_at  timestamptz not null,
  -- Requests counted in this window, INCLUDING the ones refused. The refusals are the subset below, so
  -- "how often did this ceiling fire" and "how much traffic was there" are both answerable.
  hits               integer     not null default 0,
  refusals           integer     not null default 0,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),

  constraint rate_limit_window_pkey primary key (scope, key, window_started_at),
  -- The vocabulary, as a CHECK rather than an enum: six values that grow by one per unauthenticated
  -- endpoint do not need a type, and a type would need a migration to add the seventh. One scope per
  -- CLASS of endpoint rather than per URL: `/api/v1/book` and `/api/v1/bookings` are the same operation
  -- under two spellings and share `booking`, because two ceilings over one operation is two ways to be
  -- wrong about it.
  constraint rate_limit_window_scope_is_known
    check (scope in ('booking', 'collect', 'payment_webhook', 'consent', 'payment_intent',
                     'whatsapp_ref')),
  constraint rate_limit_window_key_is_not_blank check (length(btrim(key)) > 0),
  constraint rate_limit_window_counters_are_nonneg check (hits >= 0 and refusals >= 0),
  -- A refusal is a hit that was refused, so it cannot exceed the hits. Checked because the two are
  -- incremented by the same statement and a reordered expression would silently break the subset
  -- relation, after which "how often did the ceiling fire" would read above "how much traffic".
  constraint rate_limit_window_refusals_are_a_subset check (refusals <= hits),
  constraint rate_limit_window_last_seen_follows_first check (last_seen_at >= first_seen_at)
);

comment on table rate_limit_window is
  'One row per (scope, key, window): the rate-limit STATE and the rate-limit OBSERVATION, which are the '
  'same rows. Server-side so it survives a worker restart and so two workers share one counter; the hot '
  'path is ONE upsert returning the new count, because a read then a write is how two workers both see '
  'hits = limit - 1 and both allow. The counters move and the row IDENTITY does not: ZY861 refuses an '
  'UPDATE that would change the scope, the key or the window.';
comment on column rate_limit_window.window_started_at is
  'Computed by windowStartFor() in @berelax/shared from the policy length and STORED. Deriving it in SQL '
  'would be a second reading of the policy against a length this table does not hold.';
comment on column rate_limit_window.hits is
  'Every request counted in this window, refused ones included. refusals is the subset, so traffic and '
  'ceiling-fired are both answerable from one row.';

-- The reader's index: "every window for this scope, newest first", which is what an operator asks when
-- deciding whether a ceiling is right.
create index rate_limit_window_scope_idx on rate_limit_window (scope, window_started_at desc);

-- ---------------------------------------------------------------------------------------------
-- ZY861 — the row's identity is immutable
-- ---------------------------------------------------------------------------------------------
create function refuse_rate_limit_window_rekey() returns trigger
language plpgsql
as $$
begin
  if new.scope is distinct from old.scope
     or new.key is distinct from old.key
     or new.window_started_at is distinct from old.window_started_at then
    raise exception
      'A rate limit window may not be re-keyed; the scope, the key and the window start are its '
      'identity. Only the counters move. Re-keying a window would move a measurement from one caller or '
      'one minute to another, after which the table could not answer whether a ceiling is right - which '
      'is the only reason it exists, since an unmeasured limit is a guess.'
      using errcode = 'ZY861';
  end if;
  -- The counters may only ever increase. A decrement would be a measurement edited after the fact, and
  -- the one shape that produces is a ceiling that looks like it never fired.
  if new.hits < old.hits or new.refusals < old.refusals then
    raise exception
      'A rate limit window''s counters may only increase; % -> % hits and % -> % refusals is a '
      'measurement edited after the fact.',
      old.hits, new.hits, old.refusals, new.refusals
      using errcode = 'ZY861';
  end if;
  return new;
end $$;

comment on function refuse_rate_limit_window_rekey() is
  'Raises ZY861 (RateLimitWindowIdentityImmutable) for rate_limit_window, for every role including the '
  'owner: the scope, key and window start are the row''s identity and the counters may only increase.';

create trigger rate_limit_window_no_rekey before update on rate_limit_window
  for each row execute function refuse_rate_limit_window_rekey();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards. UPDATE is KEPT here, which is the one place in this estate it is: the counters are the
-- state and the upsert is the hot path. DELETE is revoked, because a caller who could delete their own
-- window could reset their own ceiling - which is the one operation that would make the limit decorative.
-- A retention sweep runs as the owner.
revoke delete, truncate on rate_limit_window from berelax_app;

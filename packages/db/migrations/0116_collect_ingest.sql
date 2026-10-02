-- 0116_collect_ingest.sql — A-FIRST-05
--
-- The two things the ingest route needs that migration 0096 could not know it would: the identifier-free
-- record of a visit that arrived BEFORE a consent decision, and the reason a session row's trading date
-- is the date it says.
--
-- ============================================================================================
-- 1. Pre-consent staging, which is a PROJECTION and not a holding pen
-- ============================================================================================
--
-- The unit's provisional position is the stricter reading of `Y5-analytics-basis`: the internal store is
-- treated as consent-gated, so `analytics.visitor` and `analytics.session` are created AT consent and
-- never before it. That leaves a hole the funnel cannot survive. `landing` is the funnel's first stage and
-- its denominator — every conversion rate on the analytics page divides by it — and a visitor who arrives,
-- reads, and leaves without answering a banner has landed. Dropping that event loses the denominator;
-- keeping the event loses the position.
--
-- The obvious third answer is to STAGE it: hold the event somewhere until a decision arrives, then promote
-- it or expire it. That answer is not available, and the reason is worth stating because it is the whole
-- decision (ADR 0066):
--
--   **A holding pen needs a key, and a key before consent is the thing the position forbids.** To promote
--   a staged event later you must be able to find it, which means writing an identifier for a visitor who
--   has agreed to nothing — the same identifier the position exists to withhold, with a "pending" label on
--   it. To expire it you need a clock over that identifier, which is a second copy of the retention
--   problem over data that should never have existed.
--
-- So the pre-consent path is an irreversible projection instead. Each landing is reduced, at the boundary,
-- to `+1` against a bucket carrying a business day and a route, and NOTHING else is written: no visitor,
-- no session, no event row, no `Set-Cookie`. Two claims follow, and both are properties of this table
-- rather than promises about the code:
--
--   * **When consent never arrives, nothing happens.** There is nothing to promote, nothing to expire and
--     nothing for retention to purge — which is why this table's policy row is `keep_indefinitely` beside
--     the nightly rollups rather than a purge with a window. An aggregate with no identifier does not age.
--   * **A subject access request finds nothing, and cannot.** Not "we would not return it" — the row holds
--     no column any of C-CRM-10's five erasure probes can reach and no instant finer than a trading date,
--     so there is no key by which a subject could be looked up even by somebody trying.
--     `analytics-privacy.itest.ts` asserts the probes see this schema and find nothing in it, from both
--     ends, and `collect.itest.ts` enumerates this table's columns against the same probe.
--
-- What is genuinely lost is stated rather than glossed: a pre-consent visit contributes to no session, so
-- it is one landing and never a journey. The consented share of landings is therefore a data-quality
-- figure the analytics page must show (A-FIRST-10), because a funnel whose first bucket is larger than its
-- second for a reason that is not drop-off would otherwise read as catastrophic drop-off.
--
-- ============================================================================================
-- 2. Why a session says WHY its trading date is that date
-- ============================================================================================
--
-- `analytics.session.trading_date` is `not null` with a real foreign key to `public.business_day`, which
-- is right and is also a problem this unit had to solve rather than defer. Trading runs 11:00-02:00, so
-- between 02:00 and 11:00 `resolveTradingDate` correctly answers that an instant belongs to NO trading
-- date — and web traffic does not stop for nine hours a day. A-FIRST-02 refused to invent an answer and
-- recorded the question as `Y5-funnel-gap-bucket`; but a row still has to be written, so the choice here
-- is between refusing nine hours of measurement and filing it somewhere.
--
-- It is filed under the next trading date the calendar opens, and the row SAYS SO. `trading_date_basis` is
-- `trading` when the session genuinely started inside that day's window, and otherwise names which of
-- `resolveTradingDate`'s three reasons applied. That is 0096's own argument for `attribution.basis`, one
-- table over: "google/cpc reached through a gclid and google/cpc reached through a referrer are the same
-- tuple and different evidence, and the second is the one that goes wrong quietly."
--
-- And the claim is enforced rather than conventional. `analytics.assert_session_trading_basis` raises
-- ZY222 when a row's basis disagrees with the business day it names — a session claiming `trading` whose
-- `started_at` is outside that day's open window, or a session claiming a gap reason whose `started_at` is
-- inside it. Without that trigger, "we attribute gap traffic and mark it" and "we attribute gap traffic
-- silently" are the same code with a different comment, and the second is what A-FIRST-09 would then read
-- as ordinary daytime trade.
--
-- ============================================================================================
-- What this file does NOT do
-- ============================================================================================
--
--   * **No CHECK on an event name.** 0096 left `event.event_name` unconstrained deliberately — a list in
--     SQL and a union in TypeScript is two lists — and A-FIRST-02's taxonomy is the one authority. The
--     route refuses an unknown name with a named error before any statement runs.
--   * **No `bot_kind` CHECK.** A-FIRST-04 recorded the same reasoning for the same reason.
--   * **No customer or booking reference.** A-FIRST-08 owns that column and arrives with its erasure
--     classification on the same commit; `analytics.itest.ts` refuses one here in the meantime.
--   * **No `fbp`/`fbc` columns.** Those cookies exist only once a Meta pixel has run, and the pixel cannot
--     run before consent (A-MEAS-02), so the unit that makes them reachable is the unit that owns them.

begin;

-- --------------------------------------------------------------------------------------------
-- Pre-consent landings, per business day and per route, with no identifier of any kind
-- --------------------------------------------------------------------------------------------

/*
 * The bucket is ONE date column plus the basis that says what kind of date it is, and not a nullable
 * trading date beside a nullable calendar date.
 *
 * The two-nullable-columns shape is what A-FIRST-02's `FunnelBucket` union looks like in TypeScript, and
 * it does not survive the translation: a primary key cannot contain a nullable column, so the upsert this
 * table exists for — `on conflict (…) do update set landings = landings + 1` — would have to infer its
 * arbiter from a `unique nulls not distinct` index, and the same `+1` would then be one row or two
 * depending on which column was set. One date and a basis beside it keeps the key total.
 *
 * There is deliberately NO foreign key to `public.business_day`, and that is the one place this table
 * differs from every rollup in 0096. A pre-consent landing in the daytime gap has no trading date at all,
 * and the whole point of the bucket is that the visit is counted rather than refused; a key that refused
 * a date the trading calendar does not hold would drop exactly the cohort this table exists to keep. The
 * basis is what makes that readable: `trading` says the date IS a trading date, and A-FIRST-09 may join it
 * to `business_day` on that condition.
 */
create table analytics.pre_consent_landing (
  /*
   * The trading date when `bucket_basis` is `trading`, and otherwise the CALENDAR date the landing fell
   * on locally. Never both, never ambiguous, because the basis is in the key.
   */
  bucket_date   date    not null,
  bucket_basis  text    not null,
  /*
   * The route, as posted. Query and fragment are excluded by the collected-path schema
   * (`analytics/taxonomy.ts`), which matters more here than anywhere else in the schema: a `gclid` or a
   * `utm_term` in this column would put an advertising identifier on the one row that exists precisely
   * because no identifier may be stored.
   */
  path          text    not null,
  /*
   * How many landings. `bigint` and not `integer`, because this row is kept indefinitely and is the only
   * surviving record of a pre-consent visit — a counter that can overflow is a denominator that silently
   * stops being one.
   */
  landings      bigint  not null,
  primary key (bucket_date, bucket_basis, path),
  constraint pre_consent_landing_basis_known
    check (bucket_basis in ('trading', 'before_opening', 'after_closing', 'premises_closed')),
  constraint pre_consent_landing_path_is_a_path
    check (path like '/%'),
  -- A row exists because something landed, so zero is not a state it can be in. The trigger below is what
  -- refuses a decrease; this is what refuses one written directly.
  constraint pre_consent_landing_counted_at_least_one
    check (landings >= 1)
);

comment on table analytics.pre_consent_landing is
  'The identifier-free record of a visit that arrived before a consent decision (A-FIRST-05, ADR 0066). '
  'One row per business day, gap basis and route, holding a count and nothing else: no visitor, no '
  'session, no event, no instant finer than the date, and no column any erasure probe can reach — so a '
  'subject access request finds nothing here because there is nothing here to find, and consent never '
  'arriving needs no purge because nothing identifying was written. It is the funnel''s denominator when '
  'the identified store may not be written to, which is why its retention policy is keep_indefinitely '
  'beside the nightly rollups. A DELETE, or an UPDATE that lowers landings, raises ZY221: this figure is '
  'the only evidence a pre-consent visit happened at all.';

comment on column analytics.pre_consent_landing.bucket_basis is
  'Whether bucket_date is a trading date (`trading`) or the calendar date of an instant that belonged to '
  'no trading date, naming which of resolveTradingDate''s three reasons applied. In the KEY, so the two '
  'kinds of date can never be added together (Y5-funnel-gap-bucket).';

/*
 * The counter may go up and may not come down.
 *
 * An append-only table is the wrong shape here — the whole point is a row that is incremented — so the
 * rule is monotonicity rather than immutability, and it needs a trigger because no CHECK can see the old
 * row. Two triggers rather than one combined one, for 0096's reason at `event_refuse_update`: the
 * convention scanner reads for a BEFORE trigger per event, and a single `before update or delete` satisfies
 * neither half of that scan.
 *
 * Note what is NOT refused: raising `landings`, which is the ordinary write, and changing nothing, which is
 * an idempotent re-run. What is refused is a revision downwards and a removal, because this figure is a
 * denominator that outlives every raw partition it was derived from — and a denominator quietly revised
 * down moves every conversion rate on the analytics page up.
 */
create function analytics.refuse_pre_consent_landing_loss() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'analytics.pre_consent_landing holds the only record that a pre-consent visit happened: the event '
      'itself was never stored, by design (ADR 0066), so deleting %/%/% loses the funnel''s denominator '
      'for that day and route with nothing left to recompute it from. Retention keeps this table '
      'indefinitely and never removes a row from it.',
      old.bucket_date, old.bucket_basis, old.path
      using errcode = 'ZY221';
  end if;
  if new.landings < old.landings then
    raise exception
      'analytics.pre_consent_landing.landings may not be lowered: %/%/% would go from % to %. The count '
      'is a denominator kept indefinitely, and revising one down moves every conversion rate that divides '
      'by it. A correction that genuinely has to reduce a count is a migration, deliberately.',
      new.bucket_date, new.bucket_basis, new.path, old.landings, new.landings
      using errcode = 'ZY221';
  end if;
  if new.bucket_date <> old.bucket_date
     or new.bucket_basis <> old.bucket_basis
     or new.path <> old.path then
    raise exception
      'analytics.pre_consent_landing''s key identifies which day and route a count belongs to; moving a '
      'count from %/%/% to %/%/% would relabel landings that already happened.',
      old.bucket_date, old.bucket_basis, old.path,
      new.bucket_date, new.bucket_basis, new.path
      using errcode = 'ZY221';
  end if;
  return new;
end $$;

comment on function analytics.refuse_pre_consent_landing_loss() is
  'Refuses a DELETE from analytics.pre_consent_landing and an UPDATE that lowers its count or moves it to '
  'another key (ZY221). Monotonicity rather than append-only, because the table is a counter: the write '
  'that must keep working is the increment.';

create trigger pre_consent_landing_refuse_update
  before update on analytics.pre_consent_landing
  for each row execute function analytics.refuse_pre_consent_landing_loss();

create trigger pre_consent_landing_refuse_delete
  before delete on analytics.pre_consent_landing
  for each row execute function analytics.refuse_pre_consent_landing_loss();

/*
 * Its retention policy row, which is not paperwork: `analytics.run_retention` raises ZY062 for a base
 * table in this schema with no row here, so the whole pass stops rather than retaining a new table for
 * ever by omission. 0096's `retention_policy` comment states that rule about itself.
 */
insert into analytics.retention_policy (relation_name, policy, age_column, purge_order, reason)
values
  ('pre_consent_landing', 'keep_indefinitely', null, null,
   'The identifier-free pre-consent landing counter (A-FIRST-05). Exempt because there is nothing here '
   'for retention to protect anybody from: the row holds a business day, a route and a count, no '
   'identifier of any kind, and no instant finer than the date. It is also the only surviving record that '
   'a pre-consent visit happened — the event was never stored — so a 90-day window would silently delete '
   'the funnel''s own denominator for every day past it.');

-- --------------------------------------------------------------------------------------------
-- Grants. The default privileges 0096 declared cover SELECT and INSERT; the increment needs UPDATE.
-- --------------------------------------------------------------------------------------------

-- Explicit rather than inherited, and named beside the three rollups it behaves like: the application
-- role updates exactly what genuinely changes, and an upserted counter is that.
grant update on analytics.pre_consent_landing to berelax_app;

-- --------------------------------------------------------------------------------------------
-- Why a session's trading date is the date it says
-- --------------------------------------------------------------------------------------------

-- Nullable, then set, then NOT NULL. `analytics.session` ships empty — nothing in this build has written
-- a row into it before this migration — so a bare `add column ... not null` would succeed today and fail
-- against any database that HAS rows, which is the worst kind of migration: one that passes in the tree
-- that wrote it. No DEFAULT afterwards, deliberately: a default of `trading` is exactly the value a caller
-- who has not thought about the daytime gap would get, and it would be wrong nine hours out of every
-- twenty-four.
alter table analytics.session add column trading_date_basis text;

update analytics.session set trading_date_basis = 'trading' where trading_date_basis is null;

alter table analytics.session alter column trading_date_basis set not null;

alter table analytics.session
  add constraint session_trading_date_basis_known
  check (trading_date_basis in ('trading', 'before_opening', 'after_closing', 'premises_closed'));

comment on column analytics.session.trading_date_basis is
  'Why trading_date is that date. `trading` means started_at fell inside that business day''s open '
  'window; the other three are resolveTradingDate''s named reasons for an instant that belonged to no '
  'trading date at all, filed under the next day the calendar opens. Enforced by '
  'analytics.assert_session_trading_basis (ZY222), so gap traffic is visibly attributed rather than '
  'silently counted as daytime trade (Y5-funnel-gap-bucket, ADR 0066).';

/*
 * The basis must agree with the calendar.
 *
 * ONE rule in both directions: `started_at` is inside the named business day's window exactly when the
 * basis is `trading`. A one-directional check would be satisfied by a writer that stamped every row
 * `before_opening`, which is the same loss of information as stamping every row `trading`.
 *
 * The window is `[opens_at, closes_at)`, half-open, which is `resolveTradingDate`'s own boundary — an
 * instant exactly at close belongs to the next session, and a treatment may end at close while nothing may
 * start there. Comparing against the business_day row's stored instants and not against a re-derived
 * 11:00-02:00 is the point: `business_day` is the materialised calendar including its dated overrides, and
 * a second derivation here would disagree with it on exactly the days somebody changed the hours.
 *
 * AFTER rather than BEFORE, so it reads the row as it will be stored, and it fires on the UPDATE as well:
 * ingest advances `last_event_at` on a stitched session, and an UPDATE that moved `started_at` or
 * `trading_date` without the basis would otherwise slip past a check made only at insert.
 */
create function analytics.assert_session_trading_basis() returns trigger
language plpgsql
as $$
declare
  v_opens_at  timestamptz;
  v_closes_at timestamptz;
  v_inside    boolean;
begin
  select b.opens_at, b.closes_at into v_opens_at, v_closes_at
    from public.business_day b
   where b.trading_date = new.trading_date;

  if v_opens_at is null then
    -- Unreachable while session_trading_date_fk holds, and raised rather than assumed: a silent `return`
    -- here would exempt a row from the rule for the one reason nobody would look for.
    raise exception
      'analytics.session %: business_day has no row for trading_date %, so this session''s basis cannot '
      'be checked against anything.', new.session_id, new.trading_date
      using errcode = 'ZY222';
  end if;

  v_inside := new.started_at >= v_opens_at and new.started_at < v_closes_at;

  if v_inside <> (new.trading_date_basis = 'trading') then
    raise exception
      'analytics.session %: trading_date_basis is %, but started_at % is % the trading window of % '
      '(% to %). A session that began in the daytime gap is filed under the next trading date and must '
      'say so — `trading` on a gap session makes nine hours of browsing read as daytime trade, and a gap '
      'reason on a session that really did start inside the window hides the same amount the other way.',
      new.session_id, new.trading_date_basis,
      to_char(new.started_at, 'YYYY-MM-DD HH24:MI:SSOF'),
      case when v_inside then 'INSIDE' else 'OUTSIDE' end,
      new.trading_date,
      to_char(v_opens_at, 'YYYY-MM-DD HH24:MI:SSOF'),
      to_char(v_closes_at, 'YYYY-MM-DD HH24:MI:SSOF')
      using errcode = 'ZY222';
  end if;

  return new;
end $$;

comment on function analytics.assert_session_trading_basis() is
  'Holds analytics.session.trading_date_basis honest against public.business_day''s own instants '
  '(ZY222): started_at is inside the named day''s [opens_at, closes_at) window exactly when the basis is '
  '`trading`. Both directions, because a writer that stamped every row with a gap reason would lose the '
  'same information as one that stamped every row `trading`.';

create trigger session_assert_trading_basis
  after insert or update on analytics.session
  for each row execute function analytics.assert_session_trading_basis();

commit;

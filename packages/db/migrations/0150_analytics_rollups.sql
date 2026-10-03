-- 0150_analytics_rollups.sql — A-FIRST-09
--
-- What the funnel materialisation and the nightly rollups need that 0096 could not know: one statement of
-- how an instant becomes a trading date, two columns that make the daytime gap visible, the privileges a
-- RE-materialisation needs, and the two refusals that keep a rollup a figure somebody can audit.
--
-- ============================================================================================
-- What this file does NOT create, and why that is most of it
-- ============================================================================================
--
-- `analytics.funnel_step`, `analytics.daily_traffic`, `analytics.daily_funnel` and
-- `analytics.daily_source_revenue` all exist, created by 0096 (A-FIRST-01) against this unit by name.
-- Their keys are right and this file does not touch them: every rollup is keyed on `trading_date` with a
-- real foreign key into `public.business_day`, which is what makes "a session that began at 02:00 belongs
-- to the previous trading day" a property of the schema rather than of the job. A rollup keyed on a
-- calendar date would have been a different table, and re-keying one is not what this unit is for.
--
-- `nightly_rollups` already has its `agent_definition` row and its `agent_heartbeat` row, both from 0021,
-- so no agent arrives here either. 0021 declared the agent before any job existed precisely so that the
-- job could not be added without a heartbeat; this is that job.
--
-- ============================================================================================
-- Y5-funnel-gap-bucket: acted on, with no second statement of how an instant becomes a date
-- ============================================================================================
--
-- Trading runs 11:00-02:00, so between 02:00 and 11:00 no business day contains the instant at all while
-- web traffic carries on. A-FIRST-02 refused to invent an answer and recorded the question as
-- `Y5-funnel-gap-bucket`; 0116 could not defer it for `analytics.session`, because that column is NOT NULL
-- with a real key, so it filed the row under the next date the calendar opens and made the row SAY SO in
-- `trading_date_basis`, enforced by ZY222 against `business_day`'s own instants in BOTH directions. ADR
-- 0066 states the mechanism and says in so many words that it is *"not an answer to
-- Y5-funnel-gap-bucket"* and that **A-FIRST-09 is the unit that has to act on it**.
--
-- This is that action, and the shape of it is the decision: **the rollups COUNT the gap cohort and resolve
-- nothing.** `daily_traffic.gap_sessions` and `daily_funnel.gap_entered` are read off
-- `analytics.session.trading_date_basis` — the column 0116 created and ZY222 holds honest — so the cohort
-- is visible and re-bucketable the day the business answers the question, rather than silently read as
-- daytime trade.
--
-- The alternative was a `analytics.rollup_trading_date(timestamptz)` function here, resolving each step's
-- own instant against `business_day`'s window. It was written, applied, and REMOVED before this file was
-- finished, and the reason is the brief's own rule: a second statement of a fact drifts. Two statements of
-- "which trading date does this instant belong to" already exist and both are enforced —
-- `analytics.session.trading_date` by ZY222, and `appointment.trading_date` by a foreign key into
-- `business_day` (0024) — and a third, consulted only by the rollups, would disagree with the first two on
-- exactly the dates somebody overrode the hours for. The rollups therefore read the STORED answer:
-- traffic and the funnel group on `analytics.session.trading_date`, and revenue on
-- `appointment.trading_date`. A 01:30 paid invoice rolls into the previous business_day because the
-- appointment's own materialised trading date says so, which is what "resolved through the business_day
-- table rather than date(occurred_at)" means.
--
-- ============================================================================================
-- Why the two new columns are counts beside `entered` rather than a basis in the KEY
-- ============================================================================================
--
-- `analytics.daily_ref_capture` (0127) is keyed on `(trading_date, trading_date_basis)`, which is
-- `analytics.session`'s own pair, and that was right for a table 0127 created. It is not available here:
-- the three rollups' primary keys are 0096's and are read by A-FIRST-10, R-REP-07 and A-MEAS-07. Adding a
-- column to a primary key changes what a row IS — one day would become four — and every one of those
-- readers would have to learn to sum them before it could show a day's traffic, which is a figure nobody
-- would get wrong loudly.
--
-- So the gap is a COUNT beside the total, which is 0096's own shape for `bot_sessions` beside `sessions`
-- and for `excluded` beside `entered`: *"carried beside `entered` rather than subtracted from it so both
-- figures the page shows are readable"*. `gap_sessions <= sessions` and `gap_entered <= entered` are
-- CHECKs, for the reason `daily_traffic_bots_within_sessions` is one — a row claiming more gap traffic than
-- traffic would render a percentage over 100 and nothing else would notice.
--
-- ============================================================================================
-- Why the application role gains DELETE on `analytics.funnel_step` and nothing else in that schema
-- ============================================================================================
--
-- 0096's rule is that rows leave the `analytics` schema through `analytics.run_retention` and nothing else,
-- and the application role holds no DELETE there. That rule was written for the RAW tables, and 0096 says
-- so itself in the one place it makes an exception: *"`funnel_step` is deliberately NOT append-only, and
-- the contrast with `analytics.event` is the point: an event is evidence of something a browser did and may
-- never be rewritten, while a funnel step is DERIVED and a corrected derivation has to be able to replace
-- it."*
--
-- A re-materialisation is that replacement, and without DELETE it is not expressible: the pass would have
-- to accumulate, and an accumulated funnel double-counts every step the second time it runs. So DELETE is
-- granted on `analytics.funnel_step` alone. `analytics.event` keeps its ZY065 refusal for every role but
-- `berelax_retention`, and nothing here touches it.
--
-- ============================================================================================
-- `whatsapp_ref` gains DELETE for the purge A-FIRST-07 handed this unit
-- ============================================================================================
--
-- A-FIRST-07's NOTE: *"A code that expired with NOTHING referencing it should eventually be purged; that is
-- a nightly pass and a cron needs an agent row, so it is handed to A-FIRST-09 with the rollups, and
-- `whatsapp_ref_expires_at_idx` exists as the predicate it will need."* This is that grant, and the pass is
-- in `apps/worker/src/jobs/analytics-rollup.ts`.
--
-- The "nothing references it" half needs no predicate and no second query, which is the nice part:
-- `booking_whatsapp_ref_capture.ref_code` is `ON DELETE RESTRICT`, so a code a booking claimed CANNOT be
-- deleted whatever the pass asks for. The statement is `delete from whatsapp_ref where expires_at < …` and
-- the foreign key is what makes it safe — a `not exists` subquery beside it would be a second statement of
-- a rule the schema already holds, and the one that drifts.
--
-- ============================================================================================
-- ZY701 and ZY702, and the eight codes released
-- ============================================================================================
--
-- The band ZY701-ZY710 is this unit's. Two codes are raised and registered; ZY703 through ZY710 are
-- released and deliberately left UNREGISTERED, because `pnpm sqlstate` refuses an entry for a code no
-- migration raises.
--
--   * **ZY701 — a session reaches a funnel step at most once.** The funnel's first bucket is a count of
--     SESSIONS, which is what makes every rate below it meaningful, and `landing` is already one per
--     session because the ingest overwrites the `entry` flag server-side (ADR 0066). The other seven have
--     no such guard, and the ones that need it are the domain steps: a session that produced two bookings
--     would contribute two `booking_created` rows and two `confirmed` rows, so the funnel would report a
--     conversion rate above the share of people who converted. It cannot be a unique constraint, because
--     `funnel_step` is RANGE partitioned on `occurred_at` and PostgreSQL requires every unique constraint
--     on a partitioned table to contain the partition key — a unique `(session_id, step, occurred_at)`
--     would permit exactly the second row this rule is about.
--   * **ZY702 — a trading day that has not closed may not be rolled up.** Trading runs 11:00-02:00, so a
--     pass that ran at 22:00 would write a day's figures from half a day's trade, the row would look
--     complete, and the next morning's report would show a day whose takings fell by half for no reason
--     anybody could find. A-MEAS-07's ZY472 is the same rule about the same calendar for the same reason,
--     and this one has to exist separately: a reconciliation refusing an open day says nothing about a
--     rollup writing one. A CHECK cannot state it, because the closing instant is a row in `business_day`.
--
-- Both are triggers. ZY701 reads another row of the same table and ZY702 reads another table, and a CHECK
-- may do neither.

begin;

-- ---------------------------------------------------------------------------------------------
-- The two gap counts (Y5-funnel-gap-bucket, acted on rather than answered)
-- ---------------------------------------------------------------------------------------------

alter table analytics.daily_traffic
  add column gap_sessions integer not null default 0;

alter table analytics.daily_traffic
  add constraint daily_traffic_gap_within_sessions
  check (gap_sessions >= 0 and gap_sessions <= sessions);

comment on column analytics.daily_traffic.gap_sessions is
  'How many of `sessions` were filed under this trading date because their `started_at` fell in the '
  '02:00-11:00 gap, where no business day contains the instant at all (0116, ADR 0066). A COUNT beside '
  'the total and not a column in the key, because the key is 0096''s and is read by A-FIRST-10, R-REP-07 '
  'and A-MEAS-07: adding to it would turn one day into four rows and make every reader sum them before '
  'it could show a day. Y5-funnel-gap-bucket is still open; this is what makes the answer re-bucketable '
  'rather than lost.';

alter table analytics.daily_funnel
  add column gap_entered integer not null default 0;

alter table analytics.daily_funnel
  add constraint daily_funnel_gap_within_entered
  check (gap_entered >= 0 and gap_entered <= entered);

comment on column analytics.daily_funnel.gap_entered is
  'How many of `entered` were filed under this trading date out of the daytime gap. '
  '`daily_traffic.gap_sessions`'' column, per funnel step: a step reached at 09:14 belongs to no trading '
  'date, and a rollup that filed it silently would read nine hours of browsing as daytime trade.';

-- `daily_source_revenue` gains NO such column, deliberately. Its trading date comes from
-- `appointment.trading_date`, which is materialised at booking by `resolveTradingDate` and carries a real
-- foreign key into `business_day` (0024) — so a treatment is always on a trading date and the gap cannot
-- arise. A gap count there would be a column that is zero for ever, which is indistinguishable from a
-- column whose producer stopped working (0125's rule).

-- ---------------------------------------------------------------------------------------------
-- ZY701 — a session reaches a funnel step at most once
-- ---------------------------------------------------------------------------------------------

create function analytics.assert_one_step_per_session() returns trigger
language plpgsql
as $$
declare
  v_existing timestamptz;
begin
  select f.occurred_at into v_existing
    from analytics.funnel_step f
   where f.session_id = new.session_id
     and f.step = new.step
     and f.funnel_step_id <> new.funnel_step_id
   limit 1;
  if v_existing is null then
    return new;
  end if;
  raise exception
    'analytics.session % has already reached funnel step % at %, so a second row at % would count one '
    'journey twice. The funnel''s first bucket is a count of SESSIONS - that is what makes every rate '
    'below it meaningful - and a session that produced two bookings would otherwise report a conversion '
    'rate above the share of people who converted. Re-materialise the day (the pass deletes before it '
    'inserts) rather than adding a row.',
    new.session_id, new.step, v_existing, new.occurred_at
    using errcode = 'ZY701';
end $$;

comment on function analytics.assert_one_step_per_session() is
  'Raises ZY701 when a session would reach one funnel step twice. A TRIGGER and not a unique constraint: '
  'funnel_step is RANGE partitioned on occurred_at and PostgreSQL requires every unique constraint on a '
  'partitioned table to contain the partition key, so a unique (session_id, step, occurred_at) would '
  'permit exactly the second row this rule is about.';

create trigger funnel_step_one_per_session
  before insert or update on analytics.funnel_step
  for each row execute function analytics.assert_one_step_per_session();

-- ---------------------------------------------------------------------------------------------
-- ZY702 — a trading day that has not closed may not be rolled up
-- ---------------------------------------------------------------------------------------------

create function analytics.assert_rolled_up_day_has_closed() returns trigger
language plpgsql
as $$
declare
  v_closes_at timestamptz;
begin
  select d.closes_at into v_closes_at
    from public.business_day d where d.trading_date = new.trading_date;
  if v_closes_at is null then
    -- Unreachable through the foreign key every rollup carries, and written anyway: a future
    -- `drop constraint` would otherwise make this trigger silently permit everything.
    raise exception
      'analytics.% names trading date %, which public.business_day does not hold, so there is no closing '
      'instant to hold the rollup against.', tg_table_name, new.trading_date
      using errcode = 'ZY702';
  end if;
  if clock_timestamp() >= v_closes_at then
    return new;
  end if;
  raise exception
    'analytics.% would write figures for trading date %, which does not close until % — half a day''s '
    'trade written as a day''s total. The row would look complete, and the next morning''s report would '
    'show takings that fell by half for a reason nobody could find. A-MEAS-07''s ZY472 refuses the same '
    'thing about the same calendar one table over.',
    tg_table_name, new.trading_date, v_closes_at
    using errcode = 'ZY702';
end $$;

comment on function analytics.assert_rolled_up_day_has_closed() is
  'Raises ZY702 when a nightly rollup would write a trading day that has not closed. `clock_timestamp()` '
  'and not `now()`, deliberately: `now()` is the TRANSACTION''s start, and the pass opens one transaction '
  'per day it rolls up, so a long backfill would judge every day against the instant the backfill began. '
  'A CHECK cannot state the rule at all, because the closing instant is a row in business_day.';

create trigger daily_traffic_day_has_closed
  before insert or update on analytics.daily_traffic
  for each row execute function analytics.assert_rolled_up_day_has_closed();

create trigger daily_funnel_day_has_closed
  before insert or update on analytics.daily_funnel
  for each row execute function analytics.assert_rolled_up_day_has_closed();

create trigger daily_source_revenue_day_has_closed
  before insert or update on analytics.daily_source_revenue
  for each row execute function analytics.assert_rolled_up_day_has_closed();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------

-- The re-materialisation. See the header: 0096's "no DELETE in this schema" was written for the raw
-- tables, and 0096 itself makes funnel_step the exception because it is DERIVED.
grant delete on analytics.funnel_step to berelax_app;

-- The expired-ref purge A-FIRST-07 handed this unit. The "nothing references it" half is
-- booking_whatsapp_ref_capture's ON DELETE RESTRICT, not a predicate in the statement.
grant delete on whatsapp_ref to berelax_app;

commit;

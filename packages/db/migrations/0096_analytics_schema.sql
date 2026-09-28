-- 0096_analytics_schema.sql — A-FIRST-01
--
-- The `analytics` schema: the first-party measurement store, its monthly partitions, and the 90-day raw
-- retention as a thing that RUNS rather than a sentence in a document.
--
-- ============================================================================================
-- What this file is for, and the four failures it is arranged against
-- ============================================================================================
--
-- docs/03 "Volume discipline" is the whole specification and it is three clauses: raw events take monthly
-- partitions, raw retention is 90 days, and the nightly rollups are kept indefinitely. Every one of those
-- is a maintenance obligation rather than a DDL flourish, and each has a failure mode that is silent:
--
--   1. **A month with no partition.** `analytics.ensure_partitions` keeps three months ahead of the clock
--      from a cron; if it stops, the next insert has nowhere to go. PostgreSQL's own answer is
--      `23514 no partition of relation "event" found for row`, which names neither the cause nor the
--      remedy — an error nobody reads. The named refusal is ZY061, and the mechanism it needed is the one
--      thing in this file worth reading twice: see "Why there IS a default partition" below.
--   2. **A retention policy with no job.** A documented 90 days that nothing enforces is not retention.
--      `analytics.run_retention` is the job, `analytics.retention_policy` is the table it reads, and it
--      REFUSES (ZY062) when an analytics table has no policy row — so a table added by a later unit stops
--      the pass rather than being silently retained for ever.
--   3. **A retention pass that quietly does nothing.** A partition's upper bound is only readable as the
--      TEXT of `pg_get_expr(relpartbound, …)`. A parser that stopped matching would make every partition
--      look un-droppable and the pass would report success having dropped nothing — the dominant defect
--      class in this build, a check whose stated claim is not what it measures. So an unparseable bound is
--      ZY064 and stops the pass; it is never skipped.
--   4. **A collected event edited after the fact.** A funnel number is evidence about the business, and an
--      UPDATE on `analytics.event` would rewrite it with nothing saying so. Two BEFORE triggers raise
--      ZY065 for every role but `berelax_retention`, and they are declared on the PARTITIONED PARENT so
--      PostgreSQL clones them onto every partition — `delete from analytics.event_2026_09` is refused too,
--      which a grant on the parent alone would not do.
--
-- ============================================================================================
-- Why there IS a default partition, against 0005's advice, and why that advice still holds
-- ============================================================================================
--
-- 0005 says of `audit_event`: "there is deliberately no DEFAULT partition", because a default partition is
-- a place rows land that nobody prunes. That reasoning is right and it is the reason THIS default
-- partition exists.
--
-- A BEFORE INSERT ROW trigger cannot be the refusal. Measured, not assumed: on PostgreSQL 16 a row
-- inserted into a partitioned parent is ROUTED FIRST and the trigger then fires on the partition it landed
-- in — `tg_relid` is the partition, never the parent. So when no partition covers the row, tuple routing
-- raises `23514` before any trigger of ours has run, and a guard on the parent is unreachable code on
-- exactly the day it is needed. A statement-level trigger fires on the parent but cannot see the row's
-- timestamp, so it cannot say which month is missing, and a trigger that ran `ensure_partitions` would put
-- DDL and an ACCESS EXCLUSIVE lock on the ingest path to fix a problem a cron already fixes nightly.
--
-- So each raw parent has a DEFAULT partition whose only purpose is to be the thing the row routes to, and a
-- BEFORE INSERT trigger on that default partition raises ZY061 naming the parent, the instant and the
-- function to run. Nothing is ever stored there — the refusal is what makes it unreachable — so 0005's
-- objection does not apply: there is no row in it for anybody to forget to prune, and
-- `analytics.itest.ts` asserts it is empty. `run_retention` REPORTS each default partition as
-- `guarded_default_partition` rather than passing over it, so the pass is seen to have looked.
--
-- ============================================================================================
-- What is NOT here, and who owns each piece
-- ============================================================================================
--
--   * **`whatsapp_ref` already exists.** The unit summary lists it among this schema's tables; 0079
--     (B-UI-04) created `public.whatsapp_ref` and `public.booking_whatsapp_ref_capture` and they are
--     correct. A second `analytics.whatsapp_ref` would be a second statement of one fact, which is the
--     convention this build has paid for most often. `public.whatsapp_ref.session_reference` is documented
--     there as "A-FIRST's opaque handle for the conversation": it is `analytics.session.session_id`, and
--     deliberately carries no foreign key across the schema boundary — a client-record merge must not move
--     a booking's attribution, and 0079's header says so.
--   * **No customer or booking reference anywhere in this schema.** A-FIRST-08 owns "attribution onto
--     customer and booking", including repointing attribution rows to the survivor of a merge. A
--     `customer_id` here would enter C-CRM-05's merge participant registry and C-CRM-10's erasure
--     catalogue on this commit with no unit owning either decision — and an unclassified column there
--     REFUSES every customer erasure. The column arrives with the unit whose acceptance line names it.
--   * **No IP address and no user-agent string.** The bot classifier (A-FIRST-04) takes the user agent as
--     an ARGUMENT and this store keeps its verdict (`bot`, `bot_kind`) rather than its input. An
--     `ip_address` column would be a contact detail under C-CRM-10's second probe, reachable from nobody
--     and removable only by time — exposure with no compensating value, which is the same argument 0085's
--     `contact_channel` retention rule makes about a spent OTP.
--   * **No third-party identifier, tag or beacon.** ADR 0018: analytics is first-party only. Click ids are
--     stored because docs/03 says they are what permits reconciliation with the ad platforms later, and
--     nothing in this schema addresses an external origin.
--   * **The event taxonomy's closed list.** A-FIRST-02 owns the versioned event names and their Zod
--     schemas. `event.event_name` is therefore `text` with no CHECK: a list here and a list there is two
--     lists. The FUNNEL is different and is an enum below, for the reason stated at it.
--
-- ============================================================================================
-- Why the funnel steps are an enum and the other closed lists are CHECKs
-- ============================================================================================
--
-- 0079 settled when an enum is the right instrument: when the list is the exhaustive result of something
-- rather than a provisional claim somebody may correct. `device_kind` and the origination `basis` qualify
-- and are CHECKs, because nothing about them is ORDERED.
--
-- The funnel is ordered, and the order is the measurement: "conversion is computed as paid / landing,
-- never booking_created / landing" (A-FIRST-09) is a statement about which step comes last. A CHECK list
-- has no order, so the order would have to be stated a second time somewhere — in TypeScript, where it
-- would drift. `pg_enum.enumsortorder` stores it, which makes A-FIRST-02's ordered funnel enum something
-- to PIN against the catalogue rather than a second copy of it; that is exactly how
-- `whatsapp_ref_capture_outcome` is pinned to `REF_CAPTURE_OUTCOMES`. The eight members are docs/03's and
-- A-FIRST-02's, verbatim, and no member is invented here.
--
-- ============================================================================================
-- Why `trading_date` is on the session and on the rollups, and on nothing else
-- ============================================================================================
--
-- `business_day` runs 11:00-02:00 Asia/Dubai and crosses midnight, so a rollup keyed on a calendar date is
-- wrong: a 01:30 event belongs to the previous trading date. The column is therefore a real foreign key to
-- `public.business_day(trading_date)` — an unseeded date is refused here rather than silently landing on
-- `date(occurred_at)`, which makes "resolved through the business_day table" a property of the database.
--
-- It is NOT on `event` or `funnel_step`. Those carry `occurred_at`, which is the partition key, and the
-- trading date is reached by joining the session. A `trading_date` column on both would be a second
-- statement of one fact with an UPDATE path between them, and the first time an override moved a trading
-- window the two would disagree with nothing to say which was right.
--
-- ============================================================================================
-- Why the raw tables carry no foreign key to the session
-- ============================================================================================
--
-- `event.session_id` and `funnel_step.session_id` are `uuid not null` with NO reference, and this is
-- 0067's and 0079's reasoning with one addition of its own. Retention drops a raw PARTITION and purges a
-- session ROW on the same 90-day window but not in lockstep, so a foreign key would make the pass
-- order-dependent for no gain. Worse, `on delete cascade` from `session` would turn a session purge into a
-- DELETE against `analytics.event` — which the ZY065 trigger refuses. Two rules that cannot both be
-- satisfied is not a safety net; it is a nightly job that fails. `attribution` and `visitor` are not
-- partitioned and are purged by the same pass, so they DO carry cascading keys and the pass never has to
-- know the order.

begin;

create schema analytics;

comment on schema analytics is
  'The first-party measurement store (A-FIRST). First-party only (ADR 0018): nothing here addresses an '
  'external origin and no third-party identifier is stored. Raw tables take monthly partitions with '
  '90-day retention and the daily rollups are kept indefinitely (docs/03, Volume discipline); which is '
  'which is declared in analytics.retention_policy and enforced by analytics.run_retention.';

/*
 * The retention role, created idempotently for 0009's reason: a managed database may already hold it and a
 * migration must never fail on a re-run.
 *
 * It exists so that "a collected event cannot be edited after the fact" has an EXCEPTION that is named
 * rather than implied. The refusal below tests `current_user` against this role by name and NOT
 * `pg_has_role`, which is the difference between a rule and a privilege check: `berelax` is a superuser, so
 * `pg_has_role` answers true for it and the refusal would never bite the role the application actually
 * connects as. Testing the name means even the owner has to SAY it is acting as retention — `set role
 * berelax_retention` — before the database will let a collected event be touched.
 */
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'berelax_retention') then
    create role berelax_retention nologin;
  end if;
end $$;

comment on role berelax_retention is
  'The only role analytics.event may be UPDATEd or DELETEd as (ZY065). Holds no login: a session reaches '
  'it with `set role`, which is the deliberate act the refusal exists to require.';

-- --------------------------------------------------------------------------------------------
-- The funnel, in order
-- --------------------------------------------------------------------------------------------

create type analytics.funnel_step_name as enum (
  'landing',
  'service_viewed',
  'price_viewed',
  'cta_click',
  'booking_created',
  'confirmed',
  'attended',
  'paid'
);

comment on type analytics.funnel_step_name is
  'The eight ordered steps of docs/03 and A-FIRST-02, ending at PAID. An enum rather than a CHECK because '
  'the ORDER is the measurement and pg_enum.enumsortorder is the only place a database stores it; '
  'A-FIRST-02 pins its ordered enum against this catalogue rather than restating the list.';

-- --------------------------------------------------------------------------------------------
-- The visitor and the session
-- --------------------------------------------------------------------------------------------

create table analytics.visitor (
  visitor_id    uuid        not null default public.uuid_generate_v7(),
  first_seen_at timestamptz not null,
  last_seen_at  timestamptz not null,
  created_at    timestamptz not null default now(),
  primary key (visitor_id),
  constraint visitor_last_seen_not_before_first
    check (last_seen_at >= first_seen_at)
);

comment on table analytics.visitor is
  'One row per first-party visitor cookie. Created at CONSENT and never before it (A-FIRST-05; '
  'Y5-analytics-basis takes the stricter position): before consent there is no cookie and no row, only an '
  'identifier-free counter, so the funnel keeps a denominator without an identifier. Holds no contact '
  'detail, no IP address and no user-agent string.';

comment on column analytics.visitor.last_seen_at is
  'Advanced by ingest, and the age retention measures a visitor by. It is at or after every one of this '
  'visitor''s sessions'' last_event_at, which is why purging sessions and then visitors in that order '
  'cannot orphan anything — and the cascade below means it could not even if the invariant were broken.';

create table analytics.session (
  session_id    uuid        not null default public.uuid_generate_v7(),
  visitor_id    uuid        not null,
  started_at    timestamptz not null,
  last_event_at timestamptz not null,
  /*
   * The TRADING date, resolved by the caller through `resolveTradingDate` and never truncated from the
   * instant. A real foreign key: a session on a date `business_day` does not hold is refused here rather
   * than rolled up onto a calendar day the 11:00-02:00 window does not agree with.
   */
  trading_date  date        not null,
  landing_path  text        not null,
  referrer_url  text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  utm_term      text,
  utm_content   text,
  /*
   * Every click id found, verbatim. A jsonb object rather than four columns because A-FIRST-03's list
   * (gclid, fbclid, wbraid, msclkid) is the list of platforms that exist TODAY and a fifth is a data
   * change rather than a migration. Stored even when a UTM set won the origination, because they are what
   * permits reconciliation with the ad platforms later (docs/03), and never case-folded.
   */
  click_ids     jsonb       not null default '{}'::jsonb,
  device_kind   text        not null,
  breakpoint    text        not null,
  bot           boolean     not null,
  bot_kind      text,
  created_at    timestamptz not null default now(),
  primary key (session_id),
  constraint session_visitor_fk
    foreign key (visitor_id) references analytics.visitor (visitor_id) on delete cascade,
  constraint session_trading_date_fk
    foreign key (trading_date) references public.business_day (trading_date),
  constraint session_last_event_not_before_start
    check (last_event_at >= started_at),
  constraint session_device_kind_known
    check (device_kind in ('mobile', 'tablet', 'desktop', 'unknown')),
  constraint session_landing_path_is_a_path
    check (landing_path like '/%'),
  /*
   * A `bot_kind` on a session that is not flagged is unrepresentable, in both directions. The funnel
   * excludes bots by default (A-FIRST-09) and reads the FLAG; a row carrying a kind with the flag clear
   * would be counted as a human by every query while reading as a crawler to anybody looking at it.
   */
  constraint session_bot_kind_implies_bot
    check ((bot_kind is not null) = bot),
  constraint session_click_ids_is_an_object
    check (jsonb_typeof(click_ids) = 'object')
);

comment on table analytics.session is
  'One row per 30-minute-inactivity session (A-FIRST-05). Holds the origination signals AS RECEIVED; what '
  'the resolver made of them is analytics.attribution, which is a different fact with its own provenance.';

comment on column analytics.session.bot_kind is
  'The classifier''s verdict, not the user agent that produced it (A-FIRST-04). Null exactly when `bot` '
  'is false, enforced above.';

create index session_visitor_idx on analytics.session (visitor_id, started_at desc);
create index session_trading_date_idx on analytics.session (trading_date);
-- The purge's own predicate. Without it every nightly pass seq-scans the table to find nothing.
create index session_last_event_idx on analytics.session (last_event_at);

-- --------------------------------------------------------------------------------------------
-- The raw events, partitioned by month
-- --------------------------------------------------------------------------------------------

create table analytics.event (
  event_id        uuid        not null default public.uuid_generate_v7(),
  session_id      uuid        not null,
  occurred_at     timestamptz not null,
  /*
   * When ingest stored it, which a batched beacon makes different from `occurred_at`: a queue flushed on
   * the next `visibilitychange` can arrive minutes or a day late (A-FIRST-06). Both instants are kept
   * because a funnel drawn on arrival time would report a returning visitor's flush as new activity.
   */
  received_at     timestamptz not null default now(),
  event_name      text        not null,
  path            text        not null,
  properties      jsonb       not null default '{}'::jsonb,
  /*
   * The collector's own id for this event, which is what makes an offline flush idempotent (A-FIRST-06).
   * Unique WITH the partition key, because PostgreSQL requires every unique constraint on a partitioned
   * table to contain it — so the uniqueness is per month, which is the window a retry lives in.
   */
  client_event_id text        not null,
  primary key (event_id, occurred_at),
  constraint event_client_event_id_unique unique (client_event_id, occurred_at),
  constraint event_path_is_a_path check (path like '/%'),
  constraint event_name_not_blank check (btrim(event_name) <> ''),
  constraint event_properties_is_an_object check (jsonb_typeof(properties) = 'object')
) partition by range (occurred_at);

comment on table analytics.event is
  'Raw collected events, RANGE partitioned by month on occurred_at so retention is a DETACH and a DROP '
  'rather than a mass delete. Append-only: UPDATE and DELETE raise (ZY065) for every role but '
  'berelax_retention, and the triggers are declared on this parent so PostgreSQL clones them onto every '
  'partition. The DEFAULT partition holds nothing and exists only so a month nobody created is ZY061 '
  'naming the remedy instead of 23514 naming nothing — see the header.';

create index event_session_idx on analytics.event (session_id, occurred_at);
create index event_name_idx on analytics.event (event_name, occurred_at);

create table analytics.funnel_step (
  funnel_step_id  uuid        not null default public.uuid_generate_v7(),
  session_id      uuid        not null,
  step            analytics.funnel_step_name not null,
  occurred_at     timestamptz not null,
  /*
   * Why a step that was reached does not count. A no-show carries one (A-FIRST-02): the booking was
   * `confirmed` and was neither `attended` nor `paid`, and the show-adjusted rate excludes it from both
   * numerator and denominator. Null means the step counts, which is the ordinary case.
   */
  excluded_reason text,
  created_at      timestamptz not null default now(),
  primary key (funnel_step_id, occurred_at),
  constraint funnel_step_excluded_reason_not_blank
    check (excluded_reason is null or btrim(excluded_reason) <> '')
) partition by range (occurred_at);

comment on table analytics.funnel_step is
  'The materialised funnel (A-FIRST-09), RANGE partitioned by month on occurred_at. Deliberately NOT '
  'append-only, and the contrast with analytics.event is the point: an event is evidence of something a '
  'browser did and may never be rewritten, while a funnel step is DERIVED and a corrected derivation has '
  'to be able to replace it. What makes that safe is that the rollups are keyed on business_day and '
  'upserted, so a re-materialisation converges rather than accumulating.';

create index funnel_step_session_idx on analytics.funnel_step (session_id, occurred_at);
create index funnel_step_step_idx on analytics.funnel_step (step, occurred_at);

-- --------------------------------------------------------------------------------------------
-- The resolved origination
-- --------------------------------------------------------------------------------------------

create table analytics.attribution (
  session_id       uuid not null,
  /*
   * WHICH precedence rule won, from A-FIRST-03's strict order. Kept beside the answer because "google/cpc"
   * reached through a gclid and "google/cpc" reached through a referrer are the same tuple and different
   * evidence, and the second is the one that goes wrong quietly.
   */
  basis            text not null,
  source           text not null,
  medium           text not null,
  campaign         text not null default '',
  term_value       text not null default '',
  content_value    text not null default '',
  /*
   * The resolver that produced this row. A resolver is a pure function of the session's signals
   * (A-FIRST-03), so a corrected resolver gives a different answer for the same session — and a row that
   * did not say which version decided it would make the two indistinguishable.
   */
  resolver_version text        not null,
  resolved_at      timestamptz not null,
  primary key (session_id),
  constraint attribution_session_fk
    foreign key (session_id) references analytics.session (session_id) on delete cascade,
  constraint attribution_basis_known
    check (basis in ('utm', 'click_id', 'referrer', 'direct')),
  constraint attribution_source_not_blank check (btrim(source) <> ''),
  constraint attribution_medium_not_blank check (btrim(medium) <> ''),
  constraint attribution_resolver_version_not_blank check (btrim(resolver_version) <> ''),
  /*
   * `direct` is the answer when there was nothing to resolve, so it has one spelling and not several.
   * Without this a direct visit could arrive as ('direct','none'), ('(direct)','(none)') or
   * ('direct','') from three callers and the traffic report would show three rows for one thing.
   */
  constraint attribution_direct_has_one_spelling
    check (basis <> 'direct' or (source = 'direct' and medium = 'none'))
);

comment on table analytics.attribution is
  'One row per session: what A-FIRST-03''s resolver made of that session''s raw signals, with the basis '
  'and the resolver version beside it. Raw, and purged on the same 90-day window as the session it is '
  'about — the first and last touch that OUTLIVE it are denormalised onto customer and booking by '
  'A-FIRST-08, which is the unit that owns them.';

comment on column analytics.attribution.term_value is
  'utm_term, resolved. Named `term_value` rather than `term` because `term` is a reserved word in enough '
  'dialects to make every hand-written query quote it, and a column nobody can spell unquoted is a column '
  'somebody eventually spells wrong.';

-- --------------------------------------------------------------------------------------------
-- The rollups, kept indefinitely
-- --------------------------------------------------------------------------------------------

/*
 * Three tables, all keyed on `trading_date` with a foreign key to `business_day`, all exempt from
 * retention by an explicit row in `analytics.retention_policy`.
 *
 * `campaign` is NOT NULL with an empty-string default rather than nullable, and that is a primary-key
 * decision rather than a style one: a null never equals a null, so a nullable dimension in a primary key
 * would let the same campaign-less day upsert a second row every night. The rollup job's idempotence —
 * "two runs produce byte-identical rows" — depends on it.
 */

create table analytics.daily_traffic (
  trading_date  date    not null,
  source        text    not null,
  medium        text    not null,
  campaign      text    not null default '',
  device_kind   text    not null,
  sessions      integer not null,
  visitors      integer not null,
  bot_sessions  integer not null,
  events        integer not null,
  computed_at   timestamptz not null,
  primary key (trading_date, source, medium, campaign, device_kind),
  constraint daily_traffic_trading_date_fk
    foreign key (trading_date) references public.business_day (trading_date),
  constraint daily_traffic_counts_nonneg
    check (sessions >= 0 and visitors >= 0 and bot_sessions >= 0 and events >= 0),
  /*
   * The bot-filtered share is a data-quality figure on the analytics page (A-FIRST-10), and it is a SHARE
   * of these sessions. A row claiming more crawlers than sessions would render a percentage over 100 and
   * nothing else would notice.
   */
  constraint daily_traffic_bots_within_sessions
    check (bot_sessions <= sessions)
);

comment on table analytics.daily_traffic is
  'Nightly traffic rollup, kept INDEFINITELY (docs/03). Exempt from retention by its row in '
  'analytics.retention_policy, and analytics.run_retention reports the exemption rather than passing over '
  'it in silence.';

create table analytics.daily_funnel (
  trading_date date    not null,
  step         analytics.funnel_step_name not null,
  source       text    not null,
  medium       text    not null,
  campaign     text    not null default '',
  entered      integer not null,
  excluded     integer not null,
  computed_at  timestamptz not null,
  primary key (trading_date, step, source, medium, campaign),
  constraint daily_funnel_trading_date_fk
    foreign key (trading_date) references public.business_day (trading_date),
  constraint daily_funnel_counts_nonneg
    check (entered >= 0 and excluded >= 0),
  -- An exclusion is a subset of the step's arrivals: a no-show excluded from `attended` reached
  -- `confirmed` first, so it was counted before it was excluded.
  constraint daily_funnel_excluded_within_entered
    check (excluded <= entered)
);

comment on table analytics.daily_funnel is
  'Nightly funnel rollup per business day, step and origination, kept INDEFINITELY. `excluded` is the '
  'no-show and bot count removed from both sides of the show-adjusted rate, carried beside `entered` '
  'rather than subtracted from it so both figures the page shows are readable (A-FIRST-09, A-FIRST-10).';

create table analytics.daily_source_revenue (
  trading_date   date    not null,
  source         text    not null,
  medium         text    not null,
  campaign       text    not null default '',
  paid_invoices  integer not null,
  /*
   * `fils` and NOT `fils_nonneg`, deliberately. A day whose credit notes (M-TILL-08) exceed its sales has
   * negative revenue, and a non-negative domain would refuse the row rather than report the day — an
   * invented business rule dressed as a type. Integer fils, gross authoritative, VAT derived (ADR 0007).
   */
  gross_fils     fils    not null,
  vat_fils       fils    not null,
  net_fils       fils    not null,
  computed_at    timestamptz not null,
  primary key (trading_date, source, medium, campaign),
  constraint daily_source_revenue_trading_date_fk
    foreign key (trading_date) references public.business_day (trading_date),
  constraint daily_source_revenue_paid_invoices_nonneg check (paid_invoices >= 0),
  /*
   * ADR 0007, as a property of the table. Gross is authoritative and VAT is derived as gross - net, so
   * `net + vat = gross` exactly and integer fils make it exact rather than nearly. A-FIRST-09's acceptance
   * line asks that "its gross minus VAT reconciles to the invoice to the fils"; this is the half of that
   * claim the database can hold on its own, and it holds it for a restored dump and a hand-written INSERT
   * as well as for the rollup job.
   */
  constraint daily_source_revenue_vat_reconciles
    check (net_fils + vat_fils = gross_fils)
);

comment on table analytics.daily_source_revenue is
  'Nightly revenue-by-origination rollup in integer fils, kept INDEFINITELY. Taken from PAID invoice '
  'lines (A-FIRST-09); gross is VAT-inclusive and authoritative and vat is gross - net, which the CHECK '
  'above makes unfalsifiable.';

-- --------------------------------------------------------------------------------------------
-- The retention policy, which is the list run_retention reads
-- --------------------------------------------------------------------------------------------

create table analytics.retention_policy (
  relation_name text not null,
  policy        text not null,
  /*
   * For `raw_row_purge`: the timestamptz column the age is measured on. The purge is one generic statement
   * built from this name, so a table added to this list is purged without a new branch — the alternative,
   * a `case` in the function, is a policy row that looks enforced and is a no-op.
   */
  age_column    text,
  /*
   * For `raw_row_purge`: the order the deletes run in, so a child is removed before its parent. Unique, so
   * two tables cannot both claim to go first.
   */
  purge_order   integer,
  reason        text not null,
  primary key (relation_name),
  constraint retention_policy_purge_order_unique unique (purge_order),
  constraint retention_policy_known
    check (policy in ('raw_partitioned', 'raw_row_purge', 'keep_indefinitely')),
  constraint retention_policy_age_column_iff_row_purge
    check ((policy = 'raw_row_purge') = (age_column is not null)),
  constraint retention_policy_purge_order_iff_row_purge
    check ((policy = 'raw_row_purge') = (purge_order is not null)),
  constraint retention_policy_reason_not_blank check (btrim(reason) <> '')
);

comment on table analytics.retention_policy is
  'One row per base table in this schema, saying what retention does to it and why. The explicit '
  'exemption list the rollups are on, and the list analytics.run_retention reads: a table in this schema '
  'with no row here stops the pass with ZY062 rather than being retained for ever by omission, and a row '
  'here naming a relation that is not in this schema stops it with ZY063.';

-- --------------------------------------------------------------------------------------------
-- The 90 days, stated once
-- --------------------------------------------------------------------------------------------

create function analytics.raw_retention_days() returns integer
language sql
immutable
parallel safe
as $$ select 90 $$;

comment on function analytics.raw_retention_days() is
  'The raw retention window, in days. docs/03 "Volume discipline": raw events take monthly partitions '
  'with 90-day retention, rolled up nightly into daily aggregates kept indefinitely. Not an invented '
  'business rule and not a settings key — a function, so the figure has exactly one spelling and the '
  'tests assert against the same one the job uses.';

-- --------------------------------------------------------------------------------------------
-- Partition bounds, read from the catalogue
-- --------------------------------------------------------------------------------------------

/*
 * A range partition's bounds, parsed out of `pg_get_expr(relpartbound, …)`.
 *
 * PostgreSQL 16 exposes a partition's bounds only as the TEXT of that expression — there is no structured
 * catalogue column — so this is a pattern match over `FOR VALUES FROM ('…') TO ('…')`, and that is the
 * whole risk in this file's retention path. A parser that stopped matching would make every partition look
 * un-droppable and `run_retention` would report success having dropped nothing: a check whose stated claim
 * is not what it measures, which is the failure this build has paid for most. So an unreadable bound
 * RAISES ZY064 and is never skipped, and `analytics.itest.ts` proves it by handing this function the
 * DEFAULT partition, whose bound expression is the word DEFAULT and has no range at all.
 *
 * `set timezone to 'UTC'` because the expression is rendered in the SESSION's zone. The rendering always
 * carries an offset, so the cast back to timestamptz is exact either way; pinning it means the pattern
 * above is a fixed string rather than one that depends on who connected.
 */
create function analytics.partition_bounds(p_partition regclass)
returns table (lower_bound timestamptz, upper_bound timestamptz)
language plpgsql
stable
set timezone to 'UTC'
as $$
declare
  v_bound text;
  v_parts text[];
begin
  select pg_get_expr(c.relpartbound, c.oid) into v_bound
    from pg_class c
   where c.oid = p_partition;

  if v_bound is null then
    raise exception
      'analytics.partition_bounds: % is not a partition, so it has no bounds to read', p_partition
      using errcode = 'ZY064';
  end if;

  v_parts := regexp_match(v_bound, '^FOR VALUES FROM \(''([^'']+)''\) TO \(''([^'']+)''\)$');

  if v_parts is null then
    raise exception
      'analytics.partition_bounds: cannot read the bounds of % from "%". Retention refuses rather than '
      'skipping it: a partition whose bound cannot be read is a partition that would never be dropped, '
      'and the pass would then report success having removed nothing.',
      p_partition, v_bound
      using errcode = 'ZY064';
  end if;

  return query select v_parts[1]::timestamptz, v_parts[2]::timestamptz;
end $$;

comment on function analytics.partition_bounds(regclass) is
  'The [lower, upper) bounds of a range partition, parsed from pg_get_expr(relpartbound). Raises ZY064 '
  'rather than returning nothing for a bound it cannot read — an unreadable bound must stop retention, '
  'not exempt a partition from it.';

-- --------------------------------------------------------------------------------------------
-- Creating next month's partition
-- --------------------------------------------------------------------------------------------

/*
 * Monthly partitions for every partitioned table in this schema, `p_ahead` months beyond `p_from_month`,
 * idempotently.
 *
 * The set of parents is read from `pg_class` rather than from a list, for the reason acceptance line 2
 * gives about assertions: the catalogue is what is true. A list here would be a second statement of which
 * analytics tables are partitioned, and the first table added without being added to the list would stop
 * getting partitions with nothing saying so.
 *
 * Idempotent by `to_regclass` on the name it is about to create, so a second run in the same month creates
 * nothing and returns 0 — and the suite asserts that against `pg_catalog` rather than against this return
 * value, because a function that returned 0 while quietly creating nothing would satisfy a return-value
 * assertion perfectly.
 */
create function analytics.ensure_partitions(
  p_from_month date default (date_trunc('month', now()))::date,
  p_ahead      integer default 3
) returns integer
language plpgsql
security definer
set search_path = analytics, public, pg_temp
as $$
declare
  v_parent  record;
  v_i       integer;
  v_start   date;
  v_end     date;
  v_child   text;
  v_created integer := 0;
begin
  if p_ahead < 0 then
    raise exception
      'analytics.ensure_partitions: p_ahead is %, and a negative look-ahead creates nothing while '
      'reporting success', p_ahead
      using errcode = 'ZY066';
  end if;

  for v_parent in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'analytics' and c.relkind = 'p'
     order by c.relname
  loop
    for v_i in 0..p_ahead loop
      v_start := (date_trunc('month', p_from_month) + (v_i || ' months')::interval)::date;
      v_end   := (v_start + interval '1 month')::date;
      v_child := format('%s_%s', v_parent.relname, to_char(v_start, 'YYYY_MM'));

      if to_regclass(format('analytics.%I', v_child)) is null then
        execute format(
          'create table analytics.%I partition of analytics.%I for values from (%L) to (%L)',
          v_child, v_parent.relname, v_start, v_end
        );
        v_created := v_created + 1;
      end if;
    end loop;
  end loop;

  return v_created;
end $$;

comment on function analytics.ensure_partitions(date, integer) is
  'Idempotent. Creates the monthly partition of every partitioned analytics table for p_from_month and '
  'p_ahead months after it, reading the set of parents from pg_class so a table added later is covered '
  'without editing a list. Called by the analytics.ensure-partitions cron; if it stops running, an insert '
  'raises ZY061 naming this function rather than landing somewhere nobody prunes.';

revoke execute on function analytics.ensure_partitions(date, integer) from public;
grant execute on function analytics.ensure_partitions(date, integer) to berelax_app;

-- --------------------------------------------------------------------------------------------
-- The named refusal for a month nobody created
-- --------------------------------------------------------------------------------------------

create function analytics.refuse_uncovered_insert() returns trigger
language plpgsql
as $$
declare
  v_parent regclass;
begin
  select i.inhparent::regclass into v_parent from pg_inherits i where i.inhrelid = tg_relid;
  raise exception
    'no partition of % covers %, so the row routed to the guarded default partition %.%. Run '
    '`select analytics.ensure_partitions()`: the cron `analytics.ensure-partitions` keeps three months '
    'ahead of the clock and has either stopped or not reached this month. Nothing is ever stored in the '
    'default partition — it exists so this sentence can name the month and the remedy, which 23514 does '
    'not.',
    v_parent, to_char(new.occurred_at, 'YYYY-MM-DD HH24:MI:SSOF'), tg_table_schema, tg_table_name
    using errcode = 'ZY061';
end $$;

comment on function analytics.refuse_uncovered_insert() is
  'The BEFORE INSERT trigger on each raw parent''s DEFAULT partition. Measured rather than assumed: a row '
  'is ROUTED before any row-level trigger fires, so tuple routing raises 23514 before a guard on the '
  'parent could run — the default partition is what gives this refusal something to fire on. Raises ZY061 '
  'with the month and the remedy in the message, and stores nothing.';

create table analytics.event_default partition of analytics.event default;

comment on table analytics.event_default is
  'Permanently empty. The only reason it exists is so an event whose month has no partition has somewhere '
  'to route, where a BEFORE INSERT trigger raises ZY061 naming the month and the remedy. 0005''s objection '
  'to a default partition — a place rows land that nobody prunes — is the reason this one refuses every '
  'row rather than an argument against it.';

create trigger event_default_refuse_uncovered_insert
  before insert on analytics.event_default
  for each row execute function analytics.refuse_uncovered_insert();

create table analytics.funnel_step_default partition of analytics.funnel_step default;

comment on table analytics.funnel_step_default is
  'Permanently empty, for the same reason analytics.event_default is: a funnel step whose month has no '
  'partition routes here and is refused with ZY061 rather than 23514.';

create trigger funnel_step_default_refuse_uncovered_insert
  before insert on analytics.funnel_step_default
  for each row execute function analytics.refuse_uncovered_insert();

-- --------------------------------------------------------------------------------------------
-- A collected event cannot be edited after the fact
-- --------------------------------------------------------------------------------------------

create function analytics.refuse_event_mutation() returns trigger
language plpgsql
as $$
begin
  if current_user <> 'berelax_retention' then
    raise exception
      '%.% is append-only: a collected event may not be changed or removed by % (attempted %). Retention '
      'removes whole partitions — analytics.run_retention detaches and drops — and never edits a row. If '
      'a correction is genuinely needed, `set role berelax_retention` says so deliberately.',
      tg_table_schema, tg_table_name, current_user, tg_op
      using errcode = 'ZY065';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

comment on function analytics.refuse_event_mutation() is
  'Refuses UPDATE and DELETE on analytics.event for every role but berelax_retention (ZY065). Tests '
  'current_user by NAME rather than pg_has_role, because berelax is a superuser and pg_has_role answers '
  'true for it — so the refusal would never bite the role the application connects as.';

/*
 * Two triggers and not one `before update or delete`, deliberately.
 *
 * `check-schema-conventions.mjs` reads the table's own comment for the phrase "UPDATE and DELETE raise"
 * and then looks for a BEFORE trigger per event. A single combined trigger satisfies neither half of that
 * scan, so the table would claim a guarantee no gate had checked — which is the shape that rule exists to
 * refuse, and the reason it was written is that somebody wrote one trigger and copied it without changing
 * the word.
 */
create trigger event_refuse_update
  before update on analytics.event
  for each row execute function analytics.refuse_event_mutation();

create trigger event_refuse_delete
  before delete on analytics.event
  for each row execute function analytics.refuse_event_mutation();

-- --------------------------------------------------------------------------------------------
-- The retention pass
-- --------------------------------------------------------------------------------------------

/*
 * The 90-day raw retention, as the thing that runs.
 *
 * Returns a row per relation it considered, including the ones it did NOT touch. That is not verbosity: a
 * pass that reported only what it removed would be indistinguishable from a pass that had stopped running,
 * which is docs/10 §6's failure and the reason `agent_heartbeat` exists — and the three EXEMPT rollups are
 * the claim acceptance line four is about, so the pass says out loud that it looked at them and left them.
 *
 * Every refusal stops the whole pass rather than skipping one relation, and the three are the three ways
 * this could quietly under-deliver: a table nobody classified (ZY062), a classification for a table that
 * is not there (ZY063), and a partition whose bound cannot be read (ZY064, raised by
 * `analytics.partition_bounds`).
 *
 * `p_as_of` is an argument because every assertion about which partition falls due is made under a frozen
 * clock. The handler is the only thing that reads a real one, and it reads it once.
 */
create function analytics.run_retention(p_as_of timestamptz)
returns table (relation text, action text, detail text)
language plpgsql
security definer
set search_path = analytics, public, pg_temp
as $$
declare
  v_cutoff  timestamptz := p_as_of - (analytics.raw_retention_days() || ' days')::interval;
  v_missing text[];
  v_unknown text[];
  v_policy  record;
  v_child   record;
  v_bounds  record;
  v_deleted integer;
  /*
   * The partition's NAME, captured before it is dropped.
   *
   * `regclass::text` resolves an oid through the catalogue every time it is rendered, so a `detail` string
   * built after the DROP prints the bare oid — `3828561, upper bound …` — and the one line in the report
   * that says which partition went names nothing a person can read. Found by running the pass against a
   * fixture and reading its output, which is the only way a formatting defect in a log line is ever found.
   */
  v_name    text;
begin
  -- 1. The list and the schema must agree, in both directions, before anything is dropped.
  select coalesce(array_agg(c.relname order by c.relname), '{}'::text[])
    into v_missing
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'analytics'
     and c.relkind in ('r', 'p')
     and not c.relispartition
     and not exists (
       select 1 from analytics.retention_policy p where p.relation_name = c.relname
     );

  if array_length(v_missing, 1) is not null then
    raise exception
      'analytics.run_retention: no retention policy for %. Every base table in this schema needs a row '
      'in analytics.retention_policy saying what retention does to it and why. A table with no row is a '
      'table retention would keep for ever by omission, so the pass refuses rather than leaving it out.',
      array_to_string(v_missing, ', ')
      using errcode = 'ZY062';
  end if;

  select coalesce(array_agg(p.relation_name order by p.relation_name), '{}'::text[])
    into v_unknown
    from analytics.retention_policy p
   where not exists (
     select 1
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'analytics'
        and c.relkind in ('r', 'p')
        and not c.relispartition
        and c.relname = p.relation_name
   );

  if array_length(v_unknown, 1) is not null then
    raise exception
      'analytics.run_retention: analytics.retention_policy names %, which is not a base table in the '
      'analytics schema. A policy for a relation that is not there makes the list read as covering more '
      'than it does, which is the direction C-CRM-10''s stale erasure rules get wrong too.',
      array_to_string(v_unknown, ', ')
      using errcode = 'ZY063';
  end if;

  -- 2. The partitioned raw tables: detach and drop whole partitions that are entirely past the window.
  for v_policy in
    select p.relation_name from analytics.retention_policy p
     where p.policy = 'raw_partitioned'
     order by p.relation_name
  loop
    for v_child in
      select c.oid::regclass as child, pg_get_expr(c.relpartbound, c.oid) as bound
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
       where i.inhparent = format('analytics.%I', v_policy.relation_name)::regclass
       order by c.relname
    loop
      -- The guarded default partition, reported rather than skipped in silence: it has no range, it holds
      -- nothing (the ZY061 trigger refuses every row), and dropping it would turn the named refusal back
      -- into 23514.
      v_name := v_child.child::text;

      if v_child.bound = 'DEFAULT' then
        relation := v_policy.relation_name;
        action   := 'guarded_default_partition';
        detail   := format('%s holds nothing and is never dropped', v_name);
        return next;
        continue;
      end if;

      select * into v_bounds from analytics.partition_bounds(v_child.child);
      /*
       * `<=` and not `<`: a partition whose upper bound IS the cutoff holds nothing later than an instant
       * just before it, so every row in it is older than the window. Using `<` would keep one partition
       * for an extra month on the one day a month the two coincide, which is the kind of off-by-one that
       * is invisible except in a fixture built to land exactly on it.
       */
      if v_bounds.upper_bound <= v_cutoff then
        /*
         * DETACH then DROP, and plain DETACH rather than CONCURRENTLY. CONCURRENTLY cannot run inside a
         * transaction block, and a pass that could not be one transaction could leave a partition
         * detached and undropped — invisible to every query through the parent and still holding the rows
         * retention was asked to remove.
         */
        execute format('alter table analytics.%I detach partition %s', v_policy.relation_name, v_name);
        execute format('drop table %s', v_name);
        relation := v_policy.relation_name;
        action   := 'dropped_partition';
        detail   := format('%s, upper bound %s, cutoff %s', v_name, v_bounds.upper_bound, v_cutoff);
        return next;
      else
        relation := v_policy.relation_name;
        action   := 'kept_partition';
        detail   := format('%s, upper bound %s, cutoff %s', v_name, v_bounds.upper_bound, v_cutoff);
        return next;
      end if;
    end loop;
  end loop;

  -- 3. The unpartitioned raw tables: delete rows past the window, children before parents.
  for v_policy in
    select p.relation_name, p.age_column from analytics.retention_policy p
     where p.policy = 'raw_row_purge'
     order by p.purge_order
  loop
    execute format('delete from analytics.%I where %I < $1',
                   v_policy.relation_name, v_policy.age_column)
      using v_cutoff;
    get diagnostics v_deleted = row_count;
    relation := v_policy.relation_name;
    action   := 'purged_rows';
    detail   := format('%s row(s) with %s before %s', v_deleted, v_policy.age_column, v_cutoff);
    return next;
  end loop;

  -- 4. The exemptions, named in the output so the pass is seen to have looked at them.
  for v_policy in
    select p.relation_name, p.reason from analytics.retention_policy p
     where p.policy = 'keep_indefinitely'
     order by p.relation_name
  loop
    relation := v_policy.relation_name;
    action   := 'exempt';
    detail   := v_policy.reason;
    return next;
  end loop;

  return;
end $$;

comment on function analytics.run_retention(timestamptz) is
  'The 90-day raw retention pass (docs/03). Detaches and drops every partition of a raw_partitioned table '
  'whose upper bound is at or before p_as_of minus analytics.raw_retention_days(), deletes rows past the '
  'same cutoff from every raw_row_purge table in purge_order, and REPORTS the keep_indefinitely rollups '
  'and the guarded default partitions rather than passing over them. Refuses the whole pass on a table '
  'with no policy (ZY062), a policy for a relation that is not there (ZY063) or a partition bound it '
  'cannot read (ZY064).';

revoke execute on function analytics.run_retention(timestamptz) from public;
grant execute on function analytics.run_retention(timestamptz) to berelax_app;

-- --------------------------------------------------------------------------------------------
-- The policy rows
-- --------------------------------------------------------------------------------------------

insert into analytics.retention_policy (relation_name, policy, age_column, purge_order, reason)
values
  ('event', 'raw_partitioned', null, null,
   'Raw collected events. Monthly partitions with 90-day retention (docs/03) so removal is a DETACH and a '
   'DROP rather than a mass delete against an append-only table the ZY065 trigger would refuse.'),
  ('funnel_step', 'raw_partitioned', null, null,
   'The materialised funnel, derived from raw events and no more durable than they are. Dropping its '
   'partitions cannot lose a figure the page shows: those live in the rollups, which are exempt.'),
  ('attribution', 'raw_row_purge', 'resolved_at', 1,
   'One row per session, purged before the session it references. What outlives it is the first and last '
   'touch A-FIRST-08 denormalises onto customer and booking, which are not this schema''s rows.'),
  ('session', 'raw_row_purge', 'last_event_at', 2,
   'Raw session rows, purged on the same 90-day window as the events they group. After attribution and '
   'before visitor, so a cascade never has to decide the order.'),
  ('visitor', 'raw_row_purge', 'last_seen_at', 3,
   'The first-party cookie identity, purged last. last_seen_at is at or after every one of this visitor''s '
   'sessions'' last_event_at, so a visitor past the window has no session left; the cascade on '
   'session_visitor_fk means that holds even if ingest ever broke the invariant.'),
  ('daily_traffic', 'keep_indefinitely', null, null,
   'Nightly aggregate, kept indefinitely (docs/03). It is the only thing that still answers what happened '
   'a year ago once the raw partitions are gone.'),
  ('daily_funnel', 'keep_indefinitely', null, null,
   'Nightly aggregate, kept indefinitely (docs/03). Holds the counts the funnel page draws, so dropping a '
   'raw partition must leave it untouched.'),
  ('daily_source_revenue', 'keep_indefinitely', null, null,
   'Nightly aggregate in integer fils, kept indefinitely (docs/03). It reconciles to invoices the '
   'business must keep for the statutory period, so a 90-day window has nothing to say about it.'),
  ('retention_policy', 'keep_indefinitely', null, null,
   'This list. Exempt from the pass it drives, and present in it because a base table in this schema with '
   'no row here stops the pass with ZY062 — including this one.');

-- --------------------------------------------------------------------------------------------
-- This month's partitions, so today works immediately
-- --------------------------------------------------------------------------------------------

-- Before the grants below, so `grant ... on all tables in schema analytics` reaches the partitions this
-- creates as well as the parents. The `alter default privileges` lines cover every partition a later cron
-- run creates.
select analytics.ensure_partitions();

-- --------------------------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------------------------

/*
 * 0009's shape, with one difference that is the point of this file. The application role may INSERT and
 * SELECT everywhere in the schema and UPDATE only what genuinely changes: a session's `last_event_at`, a
 * visitor's `last_seen_at`, a re-resolved attribution and an upserted rollup. It holds no UPDATE and no
 * DELETE on `analytics.event`, which the ZY065 trigger then makes true for every role — the grant is the
 * layer that answers when triggers are off, and the trigger is the layer that answers for the owner.
 *
 * It holds no DELETE anywhere either: rows leave this schema through `analytics.run_retention`, which is
 * SECURITY DEFINER and is the only thing that should ever be removing measurement.
 */
grant usage on schema analytics to berelax_app;
grant select, insert on all tables in schema analytics to berelax_app;
grant update on
  analytics.visitor,
  analytics.session,
  analytics.attribution,
  analytics.daily_traffic,
  analytics.daily_funnel,
  analytics.daily_source_revenue
  to berelax_app;
-- Explicit and load-bearing rather than merely absent: an event is append-only for the application role at
-- the privilege layer as well as at the trigger.
revoke update, delete, truncate on analytics.event from berelax_app;
alter default privileges in schema analytics grant select, insert on tables to berelax_app;

-- Reporting reads the schema and writes nothing, the /analytics page's queries included.
grant usage on schema analytics to berelax_readonly;
grant select on all tables in schema analytics to berelax_readonly;
alter default privileges in schema analytics grant select on tables to berelax_readonly;

-- The retention role: the one role the ZY065 trigger admits. The default privileges matter as much as the
-- grant, because every partition a later cron run creates is a new table.
grant usage on schema analytics to berelax_retention;
grant select, update, delete on all tables in schema analytics to berelax_retention;
alter default privileges in schema analytics
  grant select, update, delete on tables to berelax_retention;

-- The clinical role has no business here and is given nothing, which is stated rather than implied:
-- 0009's bridge exists so health data crosses as booleans, and measurement never needs to cross at all.
revoke all on schema analytics from berelax_clinical;

-- --------------------------------------------------------------------------------------------
-- The two agents, so neither cron is one nobody watches
-- --------------------------------------------------------------------------------------------

/*
 * A cron with no `agent_definition` row has no declared interval and no budget, so nothing is watching it
 * and nothing is capping it — G-AGT-01's failure, which `pnpm jobs` refuses statically. Two agents and not
 * one, for migration 0033's reason: sharing one heartbeat between a partition pass and a retention pass
 * would keep it fresh while one of the two was dead.
 *
 * Both budgets are 0 fils. Neither pass makes an external call or consults a model, and a non-zero budget
 * would suggest it spends something and make the spend report wrong about where money goes.
 */
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('analytics_partitions', 'Analytics partitions',
   'Keeps the monthly partitions of analytics.event and analytics.funnel_step three months ahead of the '
   'clock. A month nobody created is a refused insert (ZY061), not a row in a partition nobody prunes.',
   60 * 60 * 24, 0),
  ('analytics_retention', 'Analytics retention',
   'Detaches and drops raw analytics partitions past the 90-day window and purges the unpartitioned raw '
   'rows, leaving the daily rollups untouched (docs/03).',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- 0031's note, which every later agent repeats: `agentsWithHeartbeat` INNER joins, so an agent with no
-- heartbeat row does not appear — and an agent that does not appear is one the watchdog never checks.
insert into agent_heartbeat (agent_key)
values ('analytics_partitions'), ('analytics_retention')
on conflict (agent_key) do nothing;

commit;

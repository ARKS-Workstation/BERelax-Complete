-- 0110_reporting_schema.sql — R-REP-01
--
-- The `reporting` schema: four dimensions, three facts, all materialised, all keyed on `business_day`,
-- with one refresh that is the only way a row in here changes.
--
-- ============================================================================================
-- What this schema IS, and the one property everything else rests on
-- ============================================================================================
--
-- **Nothing in `reporting` states a fact of its own.** Every relation here is a materialised view over
-- `public`, so the whole schema is a cache with a `REFRESH` and no writer. That is not an aesthetic
-- choice; three separate obligations in this build depend on it:
--
--   * **C-CRM-05's merge registry** and **C-CRM-10's erasure catalogue** enumerate `relkind in ('r','p')`
--     — ordinary and partitioned TABLES. A materialised view is `relkind = 'm'` and is invisible to both.
--     That is correct here and would be a hole anywhere else: a merge re-points rows, and there are no
--     rows of this schema's own to re-point; an erasure removes a subject, and a refresh is what makes
--     that true here. So `dim_customer` carries **no contact detail, no name and no phone** — see its own
--     header — and the erasure is complete the moment the base row changes, whether or not a refresh has
--     run since.
--   * **ADR 0006 (SQL-first)**: the views are the definition, and `pnpm db:drift` compares the two BASE
--     tables below against their Drizzle mirrors. The drift gate's `OWNED_SCHEMAS` gains `reporting` in
--     the same commit, because a schema a migration creates and nothing mirrors is exactly what that
--     list exists to refuse.
--   * **R-REP-07's freshness rule** — "a materialised view older than 26 hours marks its dependent tiles
--     stale" — needs an answer to "when was this last refreshed", and PostgreSQL records no such thing.
--     `reporting.refresh_run` is that record, and it is append-only for the obvious reason: a log
--     somebody can edit is a log that can be made to look fresh.
--
-- ============================================================================================
-- Why `dim_date` is keyed on `business_day` and has no calendar date of its own
-- ============================================================================================
--
-- Trading runs 11:00–02:00 (docs/01 decision 8, migration 0011), so 01:30 belongs to the PREVIOUS
-- trading date. Eleven tables in `public` already carry that quantity as `trading_date` with a foreign
-- key to `business_day`, and 0011's own header says why the mapping is a table rather than an
-- expression: "a SQL expression repeated in each of them is a rule that will eventually disagree with
-- itself."
--
-- A date dimension generated from `generate_series` over calendar dates would be a twelfth statement of
-- the trading calendar, and the FIRST one entitled to disagree with `business_day` — because nothing
-- joins the two. So `dim_date.business_day` IS `business_day.trading_date`: one row per trading date,
-- and a closed date is ABSENT rather than present with a zero, which is the claim 0011 makes and the
-- reason it makes it ("a report that forgets a `where is_open` predicate would count a closed day as a
-- zero-takings trading day, which is a different and worse claim than 'we were shut'").
--
-- The consequence to live with: `reporting` cannot answer a question about a calendar day the premises
-- did not trade on. That is the right refusal for every figure in R-REP-02 through R-REP-08 — all of
-- them are per trading day — and a report that needs calendar days has to say so and join `business_day`
-- itself.
--
-- ============================================================================================
-- The five refusals, and why each is a refusal rather than a convention
-- ============================================================================================
--
--   * **ZY181** — the registry and the catalogue disagree. `reporting.materialised_view` declares the
--     views, their grain, their refresh order and which column holds their business day. That is a
--     second statement of "which views exist", so it comes with the check that holds the two equal
--     (brief rule: "a second statement of a fact drifts"). Without it a view added by a later unit is a
--     view the nightly refresh silently never touches — stale numbers with a green job beside them.
--   * **ZY182** — a materialised view with no UNIQUE index. `REFRESH MATERIALIZED VIEW CONCURRENTLY`
--     requires one and refuses without it, and PostgreSQL's own message names neither the view nor the
--     remedy. Worse, the natural "fix" is to drop `CONCURRENTLY`, which takes ACCESS EXCLUSIVE and makes
--     every reader block for the length of the refresh. So the absence is refused BEFORE the refresh.
--   * **ZY183** — `reporting.refresh()` called with a name that is not a registered view. This is the
--     injection guard as much as the typo guard: the function is SECURITY DEFINER (only the owner may
--     refresh a materialised view) and it interpolates an identifier, so the name is checked against the
--     registry before `format(%I)` ever sees it.
--   * **ZY184** — `reporting.refresh_run` is append-only. UPDATE and DELETE raise.
--   * **ZY185** — a fact row keyed on a date the trading calendar does not hold. `fact_appointment` and
--     `fact_shift` inherit the guarantee from a foreign key; `fact_sale` does NOT, because
--     `invoice.tax_point_date` has no foreign key to `business_day` (0026 stores it rather than
--     deriving it, and nothing constrains it). An INNER JOIN would have "fixed" that by DROPPING the
--     invoice, which is revenue leaving a revenue fact in silence. So the key is taken as stored and the
--     refresh REFUSES, naming every offending date.
--
-- ZY186–ZY190 of the ZY181–ZY190 band are left FREE and deliberately unregistered: an entry for a code
-- no migration raises is refused by `pnpm sqlstate` (ADR 0043).
--
-- ============================================================================================
-- What is deferred, and to whom
-- ============================================================================================
--
-- **The holiday calendar is P-HR-10's** ("Holiday calendar, lunar confirmation impact report, Ramadan
-- dated override"), which is `todo` and is not a dependency of this unit. `dim_date` still has to carry
-- the two flags, so `reporting.calendar_observance` below is the minimum source for them — and the
-- reason it is a new table rather than a read of `premises_closure` is worth reading, because the
-- obvious answer is exactly backwards:
--
--   `premises_closure` carries `kind = 'public_holiday'`, so it looks like the holiday calendar. It is
--   not. A closure means the premises is SHUT, and a shut date has no `business_day` row at all (0011),
--   so it has no `dim_date` row either — while a public holiday the salon TRADES THROUGH has no closure
--   row, which `Y9-overtime` states in so many words: "a public holiday the premises trades through has
--   no row at all, so the derived set is a floor". Deriving `is_public_holiday` from closures would
--   therefore be false on every holiday the flag is for.
--
-- No observance row is SEEDED. The dates of the UAE's lunar holidays are announced at short notice
-- (docs/04 §6, docs/06 B5) and inventing one would be brief rule 15's "plausible is indistinguishable
-- from configured" applied to a date every report would then key on. The FIGURES are recorded as
-- `Y9-holiday-calendar` in docs/OPEN-QUESTIONS.md; the MECHANISM is here and is exercised by fixtures.
--
-- What the mechanism does guarantee, as a constraint rather than as a property of seeded data, is the
-- acceptance line: `calendar_observance_lunar_is_provisional` refuses a lunar-dated observance that is
-- not provisional. See that constraint's own comment for why that is safe to assert now and what
-- P-HR-10 has to do to it.

begin;

create schema reporting;

comment on schema reporting is
  'The reporting schema (R-REP-01, docs/02 section 4): four dimensions and three facts, all materialised '
  'views over public, all keyed on business_day. Nothing here states a fact of its own, which is why a '
  'merge has nothing to re-point and an erasure needs no refresh to be complete: every relation is '
  'derived, and reporting.refresh_all() is the only thing that changes a row in it.';

-- ---------------------------------------------------------------------------------------------
-- reporting.materialised_view — the registry the refresh walks
-- ---------------------------------------------------------------------------------------------
--
-- A registry and not a hard-coded list inside the refresh function, for the reason the job registry in
-- `apps/worker/src/registry.ts` gives about crons: "declaring a job is not the same as it running, and
-- the gap between the two is where scheduled work quietly stops". Here the gap is a view a later unit
-- adds and the nightly refresh never reaches — numbers that are stale with a green job beside them.
--
-- It holds three things the catalogue cannot: the GRAIN in one sentence, the refresh ORDER, and which
-- column carries the business day (null for a dimension that is not dated). It also restates which views
-- exist, which is a second statement of a fact — so `reporting.assert_views_are_refreshable()` holds the
-- two equal and raises ZY181, and the refresh calls it before it touches anything.
create table reporting.materialised_view (
  view_name    text        primary key,
  kind         text        not null check (kind in ('dimension', 'fact')),
  -- One sentence naming what one row IS. A grain nobody wrote down is a grain every consumer guesses at,
  -- and the guesses differ: `fact_shift` is one row per employee per shift, not one per shift.
  grain        text        not null check (btrim(grain) <> ''),
  -- The order `refresh_all` walks. No view here reads another, so this is not a dependency order and is
  -- not pretending to be one: it is a DECLARED order, so that two runs of the nightly pass touch the
  -- views in the same sequence and a partially-failed pass is the same partial state every time.
  refresh_rank smallint    not null unique check (refresh_rank >= 1),
  -- The column holding the trading date, or null for an undated dimension. Read by
  -- `reporting.assert_business_day_keys`, which is the one place that knows a fact is keyed on a trading
  -- date at all — so a fact added later without one is a failed refresh rather than a column nobody
  -- noticed was missing.
  business_day_column text,
  created_at   timestamptz not null default now()
);

comment on table reporting.materialised_view is
  'Which materialised views the reporting schema holds, their grain, the order refresh_all walks them in '
  'and which column carries the business day. Held equal to pg_catalog by '
  'reporting.assert_views_are_refreshable() (ZY181), because this is a second statement of which views '
  'exist and a second statement of a fact drifts.';

comment on column reporting.materialised_view.business_day_column is
  'The column holding the trading date, or null for an undated dimension. A fact whose key does not '
  'resolve in business_day is refused by ZY185 rather than reported against a day nobody traded on.';

-- ---------------------------------------------------------------------------------------------
-- reporting.calendar_observance — the minimum source for dim_date's two flags
-- ---------------------------------------------------------------------------------------------
--
-- P-HR-10 owns the operational holiday calendar. This is the reporting schema's own minimum, and the
-- header above records why a read of `premises_closure` would be false on exactly the days the flag
-- exists for.
--
-- Nothing is seeded. Every figure — which dates, in which year — is `Y9-holiday-calendar`.
create table reporting.calendar_observance (
  id             uuid        primary key default uuid_generate_v7(),
  kind           text        not null check (kind in ('public_holiday', 'ramadan')),
  -- The observance's own name. A statutory holiday's name is a published fact rather than an invented
  -- one; its DATE, for a lunar observance, is not, which is what `is_provisional` is about.
  name           text        not null check (btrim(name) <> '' and not is_placeholder_text(name)),
  -- Whether the date is fixed in the Gregorian calendar or announced against the lunar one. This is the
  -- distinction R-REP-06 needs in order to "report its impact twice — confirmed and provisional — rather
  -- than one blended number": without it a consumer cannot tell a date that will move from one that
  -- will not.
  date_basis     text        not null check (date_basis in ('gregorian', 'lunar')),
  starts_on      date        not null,
  ends_on        date        not null,
  is_provisional boolean     not null,
  -- Which OPEN-QUESTIONS id owns the provisional value, as data, so a reader of the database can see
  -- that a date is an assumption awaiting an announcement (0026's convention).
  open_question_id text,
  -- Where the date came from, in the author's own words.
  source         text        not null check (btrim(source) <> '' and not is_placeholder_text(source)),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint calendar_observance_range_ordered check (ends_on >= starts_on),
  constraint calendar_observance_provisional_names_a_question
    check (is_provisional = (open_question_id is not null)),
  -- **The acceptance line, as a constraint rather than as a property of the rows somebody seeded.**
  --
  -- "every lunar-date holiday row carries provisional = true" is checkable two ways: assert it over
  -- whatever rows exist, which is vacuous on a database with none and passes for ever once somebody adds
  -- a confirmed one; or refuse the other case. This refuses it.
  --
  -- It is safe to assert NOW because nothing in this build can record an announcement: the lunar
  -- calendar is `Y9-holiday-calendar` and the confirmation flow is P-HR-10's third acceptance line. When
  -- P-HR-10 lands, `dim_date` reads ITS calendar and this table goes with its constraint — which is the
  -- deferral recorded on P-HR-10 in build/manifest.yaml, not a constraint a future unit has to argue
  -- with. Until then, a lunar date presented as settled is a date this repository has no evidence for.
  constraint calendar_observance_lunar_is_provisional
    check (date_basis <> 'lunar' or is_provisional)
);

comment on table reporting.calendar_observance is
  'Public holidays and Ramadan, as date ranges, for dim_date''s two flags only. The operational holiday '
  'calendar is P-HR-10''s; this is the reporting schema''s minimum source and it is deliberately EMPTY — '
  'every date is Y9-holiday-calendar, and a plausible lunar date is indistinguishable from a confirmed '
  'one (brief rule 15). Deriving the flags from premises_closure would be false on every holiday the '
  'salon trades through, which is the common case: see 0110''s header.';

comment on column reporting.calendar_observance.date_basis is
  'gregorian for a date fixed in the Gregorian calendar, lunar for one announced against the lunar '
  'calendar at short notice (docs/04 section 6, docs/06 B5). A lunar row must be provisional.';

create index calendar_observance_range_idx
  on reporting.calendar_observance (kind, starts_on, ends_on);

create trigger calendar_observance_updated_at before update on reporting.calendar_observance
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- reporting.refresh_run — one row per view per refresh, append-only
-- ---------------------------------------------------------------------------------------------
--
-- PostgreSQL records nothing about when a materialised view was last refreshed. R-REP-07's staleness
-- rule needs that, and so does anybody asking why a figure moved, so the refresh writes a row.
--
-- Append-only (ZY184) and no `updated_at`: a row here is evidence about a pass that happened, and the
-- one thing an editable freshness log lets somebody do is make a stale view look current. The growth is
-- bounded and small — seven views once a night is about 2,600 rows a year — so there is no retention
-- pass and deliberately no policy table pretending otherwise.
--
-- `checksum` is what makes "refresh is idempotent" a measurement rather than a hope: two consecutive
-- refreshes of a view over unchanged base rows write the same checksum, and a view that read the clock
-- would not. See `reporting.view_checksum`.
create table reporting.refresh_run (
  id               uuid        primary key default uuid_generate_v7(),
  view_name        text        not null references reporting.materialised_view (view_name)
                                 on update cascade on delete restrict,
  refresh_trigger  text        not null check (refresh_trigger in ('nightly', 'on_demand')),
  -- Recorded rather than assumed. The whole point of the unique index on every view is that a refresh
  -- can be CONCURRENT, and a pass that quietly fell back to a blocking refresh is a pass that blocked
  -- every reader for its duration.
  ran_concurrently boolean     not null,
  started_at       timestamptz not null,
  finished_at      timestamptz not null,
  row_count        integer     not null check (row_count >= 0),
  checksum         text        not null check (btrim(checksum) <> ''),
  constraint refresh_run_finishes_after_it_starts check (finished_at >= started_at)
);

comment on table reporting.refresh_run is
  'One row per materialised view per refresh: when, how long, how many rows and the checksum of the '
  'result. Append-only: UPDATE and DELETE raise (ZY184), because the one thing an editable freshness log '
  'permits is making a stale view look current — and R-REP-07 reads this to decide whether a tile may '
  'render a number at all.';

comment on column reporting.refresh_run.checksum is
  'md5 over the view''s rows, order-independent. Two consecutive refreshes over unchanged base rows '
  'produce the same value; a view that read the clock would not, which is what makes idempotence '
  'measurable rather than asserted.';

create index refresh_run_view_finished_idx
  on reporting.refresh_run (view_name, finished_at desc);

create function reporting.refuse_refresh_run_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'reporting_refresh_run_append_only: a refresh run is evidence about a pass that happened, so % on '
    'reporting.refresh_run is refused. To record a new state, run the refresh again — '
    'reporting.refresh(view_name) writes a new row.',
    tg_op
    using errcode = 'ZY184';
end $$;

comment on function reporting.refuse_refresh_run_change() is
  'Refuses UPDATE and DELETE on reporting.refresh_run with ZY184. Two triggers rather than one: the '
  'conventions gate refuses a table documented as raising on both that only carries one of them.';

create trigger refresh_run_no_update before update on reporting.refresh_run
  for each row execute function reporting.refuse_refresh_run_change();

create trigger refresh_run_no_delete before delete on reporting.refresh_run
  for each row execute function reporting.refuse_refresh_run_change();

-- ---------------------------------------------------------------------------------------------
-- dim_date — one row per TRADING date
-- ---------------------------------------------------------------------------------------------
--
-- Keyed on `business_day.trading_date` and carrying no date of its own: the header says why at length.
--
-- `open_minutes` comes from `business_day.duration_seconds`, which 0011 GENERATES from the instants — so
-- every hours denominator in R-REP-03 through R-REP-06 reads `premises_hours` and its dated overrides
-- transitively, and a Ramadan schedule is a row in `premises_hours_override` plus a regeneration of
-- `business_day`, with no code change anywhere. That is this unit's `provisional:` note, discharged by
-- not having a number in it.
--
-- The two observance flags are split into three columns each rather than blended into one, because a
-- consumer needs to tell "a holiday, settled" from "a holiday, on a date that may move" — R-REP-06's
-- fourth acceptance line is exactly that distinction, and a single `is_public_holiday` boolean cannot
-- carry it.
create materialized view reporting.dim_date as
select
  bd.trading_date                                       as business_day,
  bd.opens_at,
  bd.closes_at,
  -- Integer division of an integer column: minutes, never a fraction of one.
  (bd.duration_seconds / 60)                            as open_minutes,
  bd.crosses_midnight,
  bd.source                                             as hours_source,
  extract(isodow from bd.trading_date)::smallint        as iso_day_of_week,
  extract(isoyear from bd.trading_date)::smallint       as iso_year,
  extract(week from bd.trading_date)::smallint          as iso_week,
  extract(year from bd.trading_date)::smallint          as business_year,
  date_trunc('month', bd.trading_date)::date            as business_month,
  date_trunc('quarter', bd.trading_date)::date          as business_quarter,
  holiday.observed                                      as is_public_holiday,
  holiday.names                                         as public_holiday_names,
  coalesce(holiday.is_provisional, false)               as public_holiday_is_provisional,
  coalesce(holiday.is_lunar_dated, false)               as public_holiday_is_lunar_dated,
  ramadan.observed                                      as is_ramadan,
  coalesce(ramadan.is_provisional, false)               as ramadan_is_provisional
from public.business_day bd
-- `cross join lateral` over an aggregate rather than a `left join` plus `group by`: the subquery returns
-- exactly one row for every trading date whether or not an observance covers it, so `observed` is false
-- rather than null and no consumer has to remember a coalesce. `string_agg` is ordered, so a date
-- carrying two observances produces the same text on every refresh — an unordered aggregate would change
-- the checksum between refreshes and make idempotence unprovable.
cross join lateral (
  select count(*) > 0                                          as observed,
         string_agg(o.name, ' / ' order by o.name, o.id)        as names,
         bool_or(o.is_provisional)                              as is_provisional,
         bool_or(o.date_basis = 'lunar')                        as is_lunar_dated
    from reporting.calendar_observance o
   where o.kind = 'public_holiday'
     and bd.trading_date between o.starts_on and o.ends_on
) holiday
cross join lateral (
  select count(*) > 0                                          as observed,
         bool_or(o.is_provisional)                              as is_provisional
    from reporting.calendar_observance o
   where o.kind = 'ramadan'
     and bd.trading_date between o.starts_on and o.ends_on
) ramadan;

comment on materialized view reporting.dim_date is
  'One row per TRADING date, keyed on business_day.trading_date and carrying no calendar date of its '
  'own. A date the premises did not trade on is ABSENT rather than present with a zero (0011). '
  'open_minutes derives from business_day.duration_seconds, which is generated from the instants, so '
  'every hours denominator reads premises_hours and its dated overrides with no code change.';

create unique index dim_date_business_day_key on reporting.dim_date (business_day);

-- ---------------------------------------------------------------------------------------------
-- dim_service — one row per service VARIANT
-- ---------------------------------------------------------------------------------------------
--
-- The variant and not the service, because a variant is what an appointment references
-- (`appointment.service_variant_id`) and what carries a duration and a price. A dimension keyed on the
-- service would need a second join in every fact query and could not answer "the 90-minute one".
--
-- `list_gross_fils` is the CATALOGUE price, and it is the price today rather than the price on any
-- given day: the price a treatment was actually sold at is snapshotted onto `fact_appointment`. Naming
-- it `list_` is what keeps the two apart — R-REP-04's "a package redemption contributes revenue at the
-- snapshotted per-session price, not the package price current on the day the report runs" is the same
-- distinction one subject along.
create materialized view reporting.dim_service as
select
  sv.id                                        as service_variant_id,
  s.id                                         as service_id,
  s.style::text                                as treatment_style,
  s.treatment_key,
  s.slug,
  s.internal_name,
  s.public_display_name,
  sv.duration_minutes,
  s.turnaround_minutes,
  -- Cast off the `fils` domain so the column is plainly `bigint`: the reporting schema's money rule is
  -- checkable by type, and a domain would make every check have to resolve one.
  sv.gross_price_fils::bigint                  as list_gross_fils,
  (s.published_at is not null)                 as is_published,
  (s.archived_at is not null)                  as is_archived,
  (s.is_provisional or sv.is_provisional)      as is_provisional,
  coalesce(sv.open_question_id, s.open_question_id) as open_question_id
from public.service_variant sv
join public.service s on s.id = sv.service_id;

comment on materialized view reporting.dim_service is
  'One row per service variant — the grain an appointment references. list_gross_fils is the CATALOGUE '
  'price now; the price a treatment was sold at is snapshotted on fact_appointment, and the two are '
  'deliberately different columns in different relations.';

create unique index dim_service_variant_key on reporting.dim_service (service_variant_id);

-- ---------------------------------------------------------------------------------------------
-- dim_staff — one row per employee
-- ---------------------------------------------------------------------------------------------
--
-- **No wage column, and that is a rule rather than an omission.** R-REP-08's second acceptance line is
-- that "forbidden columns are absent from the serialised JSON response, not merely hidden in the UI — a
-- test inspects the payload for salary and clinical keys per role", and the cheapest way to keep that
-- promise is for the dimension every role's dashboard joins to not to contain a salary at all. Labour
-- cost is R-REP-04's, computed against the versioned rules that judged the period.
--
-- `display_name` is nullable and stays nullable: a therapist has no display name until an admin sets one
-- (brief rule 10, ADR 0020), and the nineteen seeded employment records have none. A dimension that
-- substituted a label would be inventing a person's name in the one place every report reads.
create materialized view reporting.dim_staff as
select
  e.id                              as employee_id,
  e.staff_reference,
  e.display_name,
  e.contract_type::text             as contract_type,
  e.employed_from,
  e.employed_until,
  (e.employed_until is null)        as is_current,
  e.is_publishable,
  e.is_provisional,
  e.open_question_id
from public.employee e;

comment on materialized view reporting.dim_staff is
  'One row per employee, with NO wage or allowance column: the dimension every role''s dashboard joins '
  'to must not contain a salary (R-REP-08). display_name is nullable and is not substituted — a '
  'therapist has no display name until an admin sets one (ADR 0020).';

create unique index dim_staff_employee_key on reporting.dim_staff (employee_id);

-- ---------------------------------------------------------------------------------------------
-- dim_customer — one row per customer, and no contact detail anywhere in it
-- ---------------------------------------------------------------------------------------------
--
-- The schema-wide safety argument depends on this one relation. `reporting` escapes C-CRM-10's erasure
-- catalogue because a materialised view is `relkind = 'm'`, and that is only SAFE while no view here
-- holds anything an erasure would have to remove. So: no `phone_e164`, no `display_name`, no
-- `name_match_key`, no `notes`. What is here is the customer's SHAPE — how they arrived, where they are
-- in the lifecycle, when they first and last came in — and `is_erased`, so a report can exclude them
-- without joining back to a table holding the detail.
--
-- An identity LABEL ("Customer 0042", ADR 0020) is deliberately not materialised either. It belongs to
-- whatever renders a row, and a label stored here would be a contact-shaped column in the schema whose
-- whole argument is that it has none.
--
-- `first_visit_business_day` is the cohort key R-REP-05 groups on, defined ONCE here: the earliest
-- trading date of an appointment that was DELIVERED. Not booked, not paid — delivered, because a cohort
-- of people who booked and never came is a different cohort. R-REP-05 reads this rather than
-- recomputing it; a second definition of "first visit" is two answers to one question.
create materialized view reporting.dim_customer as
select
  c.id                              as customer_id,
  c.created_at                      as record_created_at,
  c.created_via,
  c.locale,
  c.lifecycle_state,
  c.acquisition_source,
  c.is_vip,
  (c.erased_at is not null)         as is_erased,
  visits.first_visit_business_day,
  visits.last_visit_business_day
from public.customer c
cross join lateral (
  select min(a.trading_date) as first_visit_business_day,
         max(a.trading_date) as last_visit_business_day
    from public.appointment a
    join public.booking b on b.id = a.booking_id
   where b.customer_id = c.id
     and a.status = 'completed'
) visits;

comment on materialized view reporting.dim_customer is
  'One row per customer with NO contact detail, name, label or note — which is what makes the whole '
  'reporting schema''s absence from C-CRM-10''s erasure catalogue safe rather than a hole. '
  'first_visit_business_day is the trading date of the earliest DELIVERED appointment and is the cohort '
  'key R-REP-05 reads rather than recomputing.';

create unique index dim_customer_key on reporting.dim_customer (customer_id);

-- ---------------------------------------------------------------------------------------------
-- fact_appointment — one row per appointment
-- ---------------------------------------------------------------------------------------------
--
-- `business_day` is `appointment.trading_date`, which has a foreign key to `business_day` (0024) and is
-- resolved per appointment by `resolveTradingDate` across midnight (B-LIFE-03). So a 01:30 treatment is
-- filed under the PREVIOUS trading date and this view does not participate in that decision — it carries
-- it. Truncating `lower(period)` to a date here would move the last two hours of every night into
-- tomorrow, which is the failure 0024's own comment is about.
--
-- Every status is present, not just the delivered ones. `no_show` is R-REP-04's no-show cost,
-- `cancelled_by_*` is its own figure, and a fact that filtered would make each of those a separate query
-- against `public` — which is how a dashboard comes to disagree with itself.
--
-- The amounts are the SNAPSHOT on the appointment, not a lookup of today's catalogue price: 0024 stores
-- `gross_price_fils`, `net_fils` and `vat_fils` per appointment for exactly that reason, and
-- `appointment_price_split_exact` makes `net + vat = gross` a database fact (ADR 0007).
create materialized view reporting.fact_appointment as
select
  a.id                                   as appointment_id,
  a.trading_date                         as business_day,
  a.booking_id,
  b.customer_id,
  a.service_variant_id,
  a.therapist_id                         as employee_id,
  a.room_id,
  a.shape::text                          as shape,
  a.status::text                         as status,
  a.holds_resources,
  (a.status = 'completed')               as is_delivered,
  (a.status = 'no_show')                 as is_no_show,
  lower(a.period)                        as starts_at,
  upper(a.period)                        as ends_at,
  (extract(epoch from (upper(a.period) - lower(a.period))) / 60)::integer as treatment_minutes,
  a.turnaround_minutes,
  a.therapist_buffer_minutes,
  a.room_places,
  a.gross_price_fils::bigint             as gross_fils,
  a.net_fils::bigint                     as net_fils,
  a.vat_fils::bigint                     as vat_fils,
  a.vat_rate_bp,
  a.late_cancellation,
  a.rescheduled_from_id,
  a.price_list_id,
  a.promotion_id
from public.appointment a
join public.booking b on b.id = a.booking_id;

comment on materialized view reporting.fact_appointment is
  'One row per appointment, in every status. business_day is appointment.trading_date — foreign-keyed to '
  'business_day and resolved per appointment across midnight — so a 01:30 treatment is filed under the '
  'previous trading date and this view does not recompute that. The amounts are the snapshot on the '
  'appointment, never today''s catalogue price.';

create unique index fact_appointment_key on reporting.fact_appointment (appointment_id);
create index fact_appointment_business_day_idx on reporting.fact_appointment (business_day);

-- ---------------------------------------------------------------------------------------------
-- fact_sale — one row per tax DOCUMENT, credit notes signed negative
-- ---------------------------------------------------------------------------------------------
--
-- Invoices and credit notes in one relation, with the credit note's amounts NEGATED. The alternative —
-- invoices only — makes every net-revenue figure in R-REP-02 and R-REP-05 wrong by whatever was credited
-- back, and makes the correction a second query every consumer has to remember to subtract. A credit
-- note is identifiable by `document_kind` and by `corrects_document_id`, so nothing is hidden by the
-- sign.
--
-- **`business_day` is `tax_point_date` and is taken as stored, with no join to `business_day`.** Three
-- candidate keys exist and only one is the sale's own trading day:
--
--   * `issued_at` truncated to a date — refused outright. That is `date(occurred_at)`, and it moves every
--     sale rung up between midnight and 02:00 into the next day.
--   * `issue_trading_date` — the trading date the DOCUMENT was written on, and nullable by design: 0026
--     records that "an invoice raised by the accountant at 10:00 is written while the premises is shut,
--     so it belongs to no trading date at all". It is carried here as `issue_business_day` because
--     cash-up needs it, and it is not the key.
--   * `tax_point_date` — the date of SUPPLY, not null, and already the trading date: 0026 stores it
--     rather than deriving it precisely because "a supply on trading day D invoiced on D+1 keeps its tax
--     point at D", and the value comes from `resolveTradingDate` over `business_day`.
--
-- What `tax_point_date` lacks is a foreign key, so nothing in `public` refuses a tax point that is not a
-- trading date. An INNER JOIN to `business_day` would have looked like the fix and would have DROPPED
-- that invoice — revenue leaving a revenue fact with nothing said. So the key is taken as stored and
-- `reporting.assert_business_day_keys` refuses the refresh (ZY185), naming every date the trading
-- calendar does not hold.
create materialized view reporting.fact_sale as
select
  i.id                          as document_id,
  i.document_kind,
  i.display_number,
  i.tax_point_date              as business_day,
  i.issue_trading_date          as issue_business_day,
  i.issue_date,
  i.issued_at,
  i.customer_id,
  null::uuid                    as corrects_document_id,
  i.net_total::bigint           as net_fils,
  i.vat_total::bigint           as vat_fils,
  i.gross_total::bigint         as gross_fils
from public.invoice i
union all
select
  cn.id,
  cn.document_kind,
  cn.display_number,
  cn.tax_point_date,
  cn.issue_trading_date,
  cn.issue_date,
  cn.issued_at,
  cn.customer_id,
  cn.invoice_id,
  -- Negated, so a consumer summing net_fils over a period gets net revenue and not gross sales.
  -(cn.net_total::bigint),
  -(cn.vat_total::bigint),
  -(cn.gross_total::bigint)
from public.credit_note cn;

comment on materialized view reporting.fact_sale is
  'One row per tax document — invoice or credit note, the credit note negated — keyed on tax_point_date, '
  'the date of SUPPLY, which is already a trading date (0026). Never date(issued_at), which would move '
  'every sale after midnight into the next day; and never an inner join to business_day, which would drop '
  'an off-calendar tax point instead of refusing the refresh (ZY185).';

-- `(document_kind, document_id)` rather than `document_id` alone. Both tables draw ids from
-- `uuid_generate_v7()` so a collision is not a practical worry, but a UNIQUE index is what makes
-- `REFRESH ... CONCURRENTLY` legal, and it has to be unique by construction rather than by probability:
-- a duplicate would fail the refresh, and a failed nightly refresh is stale numbers everywhere.
create unique index fact_sale_key on reporting.fact_sale (document_kind, document_id);
create index fact_sale_business_day_idx on reporting.fact_sale (business_day);

-- ---------------------------------------------------------------------------------------------
-- fact_shift — one row per employee per shift
-- ---------------------------------------------------------------------------------------------
--
-- The grain is the ASSIGNMENT and not the shift, because the measure is "this person was rostered for
-- these minutes" — the numerator side of therapist utilisation (R-REP-03) and the hours a labour cost is
-- attributed over (R-REP-04). A shift with nobody on it therefore has no row here, which is the right
-- answer for those two figures and the wrong one for "how many shifts were there"; a consumer asking
-- that counts `public.shift` and the grain sentence in the registry says so.
--
-- `business_day` is `shift.trading_date`, foreign-keyed to `business_day` (0030) for the reason 0030
-- gives: "a shift on a date the premises does not trade has no row to join to, which is the roster error
-- worth refusing". A shift from 23:00 to 02:00 is ONE row with ONE trading date.
create materialized view reporting.fact_shift as
select
  sa.shift_id,
  sa.employee_id,
  sh.trading_date                        as business_day,
  lower(sh.period)                       as starts_at,
  upper(sh.period)                       as ends_at,
  (extract(epoch from (upper(sh.period) - lower(sh.period))) / 60)::integer as rostered_minutes,
  sh.label
from public.shift_assignment sa
join public.shift sh on sh.id = sa.shift_id;

comment on materialized view reporting.fact_shift is
  'One row per employee per shift — the assignment, not the shift, because the measure is rostered '
  'minutes per person. A shift with no assignment has no row here; count public.shift for that. '
  'business_day is shift.trading_date, so a 23:00-02:00 shift is one row under one trading date.';

create unique index fact_shift_key on reporting.fact_shift (shift_id, employee_id);
create index fact_shift_business_day_idx on reporting.fact_shift (business_day);

-- ---------------------------------------------------------------------------------------------
-- The registry rows
-- ---------------------------------------------------------------------------------------------
--
-- Dimensions first, then facts. Not a dependency order — no view here reads another — but a DECLARED
-- one, so two nightly passes touch the views in the same sequence and a pass that fails half way leaves
-- the same half-state every time rather than a different one each night.
insert into reporting.materialised_view (view_name, kind, grain, refresh_rank, business_day_column)
values
  ('dim_date', 'dimension',
   'One row per TRADING date, keyed on business_day.trading_date. A date the premises did not trade on '
   'is absent.', 1, 'business_day'),
  ('dim_service', 'dimension',
   'One row per service variant — a service at a duration, which is what an appointment references.',
   2, null),
  ('dim_staff', 'dimension',
   'One row per employee, current and former. No wage column.', 3, null),
  ('dim_customer', 'dimension',
   'One row per customer, with no contact detail of any kind.', 4, null),
  ('fact_appointment', 'fact',
   'One row per appointment, in every status, with the price snapshotted on it.', 5, 'business_day'),
  ('fact_sale', 'fact',
   'One row per tax document — invoice or credit note, the credit note negated.', 6, 'business_day'),
  ('fact_shift', 'fact',
   'One row per employee per SHIFT ASSIGNMENT. A shift with nobody on it has no row.',
   7, 'business_day');

-- ---------------------------------------------------------------------------------------------
-- reporting.assert_views_are_refreshable — ZY181 and ZY182
-- ---------------------------------------------------------------------------------------------
--
-- Two checks that have to run BEFORE a refresh rather than after it, because both of their failures are
-- otherwise reported by PostgreSQL in a message that names neither the cause nor the remedy.
create function reporting.assert_views_are_refreshable() returns void
language plpgsql
stable
as $$
declare
  v_unregistered text;
  v_unbuilt      text;
  v_unindexed    text;
begin
  -- Direction one: a materialised view the registry does not declare. This is the one that matters — a
  -- view a later unit adds and never registers is a view `refresh_all` walks straight past, so its rows
  -- are whatever they were the day it was created with a green nightly job beside them.
  select string_agg(c.relname, ', ' order by c.relname) into v_unregistered
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'reporting'
     and c.relkind = 'm'
     and not exists (select 1 from reporting.materialised_view m where m.view_name = c.relname);

  -- Direction two: a registry row naming nothing. `refresh_all` would fail on it every night, which is
  -- loud — but it is also how the registry comes to describe a schema that no longer exists, and an
  -- entry that describes nothing is standing permission to re-create what it described.
  select string_agg(m.view_name, ', ' order by m.view_name) into v_unbuilt
    from reporting.materialised_view m
   where not exists (
     select 1 from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'reporting' and c.relkind = 'm' and c.relname = m.view_name);

  if v_unregistered is not null or v_unbuilt is not null then
    raise exception
      'reporting_registry_disagrees: the reporting registry and the catalogue do not match. '
      'Materialised view(s) with no registry row: %. Registry row(s) naming no view: %. '
      'reporting.materialised_view is what refresh_all walks, so an unregistered view is never '
      'refreshed and a registry row naming nothing describes a relation that is gone.',
      coalesce(v_unregistered, '(none)'), coalesce(v_unbuilt, '(none)')
      using errcode = 'ZY181';
  end if;

  -- `indpred is null and indexprs is null`: REFRESH ... CONCURRENTLY requires a unique index over plain
  -- COLUMNS with no WHERE clause, so a partial or expression unique index satisfies `indisunique` and
  -- does not satisfy PostgreSQL. Checking `indisunique` alone would pass here and fail at the refresh
  -- with the message this function exists to replace.
  select string_agg(c.relname, ', ' order by c.relname) into v_unindexed
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'reporting'
     and c.relkind = 'm'
     and not exists (
       select 1 from pg_catalog.pg_index x
        where x.indrelid = c.oid
          and x.indisunique
          and x.indpred is null
          and x.indexprs is null);

  if v_unindexed is not null then
    raise exception
      'reporting_view_has_no_unique_index: materialised view(s) % carry no UNIQUE index over plain '
      'columns, so REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run against them. Dropping '
      'CONCURRENTLY is not the fix: a plain refresh takes ACCESS EXCLUSIVE and every reader blocks for '
      'its duration. Add a unique index over the view''s grain.',
      v_unindexed
      using errcode = 'ZY182';
  end if;
end $$;

comment on function reporting.assert_views_are_refreshable() is
  'Holds reporting.materialised_view equal to pg_catalog in both directions (ZY181) and refuses a '
  'materialised view with no plain UNIQUE index (ZY182). Called by reporting.refresh and '
  'reporting.refresh_all before anything is touched, because PostgreSQL''s own messages for both name '
  'neither the cause nor the remedy.';

-- ---------------------------------------------------------------------------------------------
-- reporting.registered_or_refuse — ZY183
-- ---------------------------------------------------------------------------------------------
--
-- The one place a view NAME is turned into something this schema will act on. Both dynamic functions
-- below go through it, which is what makes `format(..., %I)` safe in a SECURITY DEFINER function: the
-- identifier is a registry row's own column by the time it reaches the format string.
create function reporting.registered_or_refuse(p_view text) returns reporting.materialised_view
language plpgsql
stable
as $$
declare
  v_row reporting.materialised_view;
begin
  select * into v_row from reporting.materialised_view where view_name = p_view;
  if not found then
    raise exception
      'reporting_view_not_registered: "%" is not a registered reporting view. The registered views, in '
      'refresh order, are: %. A refresh that accepted an arbitrary name would be interpolating a caller''s '
      'identifier into SECURITY DEFINER SQL.',
      p_view,
      (select string_agg(m.view_name, ', ' order by m.refresh_rank) from reporting.materialised_view m)
      using errcode = 'ZY183';
  end if;
  return v_row;
end $$;

comment on function reporting.registered_or_refuse(text) is
  'The registry row for a view name, or ZY183. Every dynamic statement in this schema resolves its '
  'identifier through here, which is what makes format(%I) safe inside a SECURITY DEFINER function.';

-- ---------------------------------------------------------------------------------------------
-- reporting.view_checksum — what makes idempotence measurable
-- ---------------------------------------------------------------------------------------------
--
-- md5 over the view's rows, ordered by the row TEXT rather than by any column, so the value depends on
-- the set of rows and not on the order a refresh happened to write them in. Two consecutive refreshes
-- over unchanged base rows therefore agree, and a view that read `now()` would not — which is the whole
-- point: a clock inside a view definition makes every nightly refresh a change and every downstream
-- comparison meaningless.
--
-- `chr(30)` (the ASCII record separator) is the joiner rather than a comma or a pipe: those appear inside
-- `record::text` output, so rows ('a|b') and ('a','b') could hash the same and a real difference would
-- read as none.
create function reporting.view_checksum(p_view text) returns text
language plpgsql
stable
as $$
declare
  v_registered reporting.materialised_view := reporting.registered_or_refuse(p_view);
  v_checksum   text;
begin
  execute format(
    'select coalesce(md5(string_agg(t.row_text, %L order by t.row_text)), %L) '
    '  from (select r::text as row_text from reporting.%I r) t',
    chr(30), 'empty', v_registered.view_name
  ) into v_checksum;
  return v_checksum;
end $$;

comment on function reporting.view_checksum(text) is
  'md5 over a reporting view''s rows, order-independent, or the literal ''empty'' for a view with none. '
  'Two consecutive refreshes over unchanged base rows agree; a view reading the clock would not.';

-- ---------------------------------------------------------------------------------------------
-- reporting.assert_business_day_keys — ZY185
-- ---------------------------------------------------------------------------------------------
--
-- Applied to every registry row carrying a `business_day_column`, including the two facts whose key has
-- a foreign key already. One rule in one place is the point: `fact_appointment` and `fact_shift` are
-- guaranteed by `public`, `fact_sale` is guaranteed by this, and a fact added later is guaranteed by
-- this whether or not its author knew the rule existed.
create function reporting.assert_business_day_keys(p_view text) returns void
language plpgsql
stable
as $$
declare
  v_registered reporting.materialised_view := reporting.registered_or_refuse(p_view);
  v_offending  bigint;
  v_dates      text;
begin
  if v_registered.business_day_column is null then
    return;
  end if;

  -- `not exists` and not `<>`: a NULL key makes the NOT EXISTS true, so a fact whose business day is
  -- missing altogether is counted here rather than passing as "no mismatch". The date list coalesces the
  -- null so the message names it instead of dropping it.
  execute format(
    'select count(*), string_agg(distinct coalesce(v.%I::text, ''(null)''), '', '') '
    '  from reporting.%I v '
    ' where not exists (select 1 from public.business_day bd where bd.trading_date = v.%I)',
    v_registered.business_day_column, v_registered.view_name, v_registered.business_day_column
  ) into v_offending, v_dates;

  if v_offending > 0 then
    raise exception
      'reporting_fact_off_the_trading_calendar: % row(s) of reporting.% are keyed on a date the trading '
      'calendar does not hold: %. A fact keyed on a day nobody traded on is a figure no report can '
      'attribute, and dropping the row instead would be revenue leaving a revenue fact in silence. '
      'Either business_day has not been generated that far (generate-business-days.ts) or the source '
      'document''s trading date was not resolved through it.',
      v_offending, v_registered.view_name, v_dates
      using errcode = 'ZY185';
  end if;
end $$;

comment on function reporting.assert_business_day_keys(text) is
  'Refuses (ZY185) a reporting fact whose business_day does not resolve in public.business_day, or is '
  'null. Applied to every registry row with a business_day_column, including the two whose source column '
  'is foreign-keyed — one rule in one place, so a fact added later inherits it.';

-- ---------------------------------------------------------------------------------------------
-- reporting.refresh — one view, concurrently, on demand
-- ---------------------------------------------------------------------------------------------
--
-- SECURITY DEFINER because only a materialised view's OWNER may refresh it, and the application role is
-- not the owner and must not be. What that costs is a function that interpolates an identifier, and what
-- pays for it is `registered_or_refuse`: the name reaching `format(%I)` is a registry row's own column.
--
-- CONCURRENTLY always, and `ran_concurrently` is recorded rather than assumed. A plain refresh takes
-- ACCESS EXCLUSIVE, so every reader blocks for its duration — on the nightly pass that is a few seconds
-- nobody sees, and on an on-demand refresh from an admin screen it is every other admin's dashboard
-- hanging. The unique index on every view is what makes the concurrent form legal, and ZY182 is what
-- stops it silently stopping being available.
create function reporting.refresh(p_view text, p_trigger text default 'on_demand')
returns reporting.refresh_run
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_registered reporting.materialised_view := reporting.registered_or_refuse(p_view);
  v_started    timestamptz := clock_timestamp();
  v_rows       integer;
  v_run        reporting.refresh_run;
begin
  perform reporting.assert_views_are_refreshable();

  execute format('refresh materialized view concurrently reporting.%I', v_registered.view_name);
  execute format('select count(*)::integer from reporting.%I', v_registered.view_name) into v_rows;

  -- After the refresh and before the row is written: a run recorded against a view whose keys do not
  -- resolve would be a freshness record for numbers nothing may report.
  perform reporting.assert_business_day_keys(v_registered.view_name);

  insert into reporting.refresh_run
    (view_name, refresh_trigger, ran_concurrently, started_at, finished_at, row_count, checksum)
  values
    (v_registered.view_name, p_trigger, true, v_started, clock_timestamp(), v_rows,
     reporting.view_checksum(v_registered.view_name))
  returning * into v_run;

  return v_run;
end $$;

comment on function reporting.refresh(text, text) is
  'Refreshes ONE reporting view with REFRESH MATERIALIZED VIEW CONCURRENTLY, checks its business_day '
  'keys and records a refresh_run row. SECURITY DEFINER because only the owner may refresh a '
  'materialised view; the identifier is a registry row''s own column by the time format(%I) sees it '
  '(ZY183). Concurrent so a reader is never blocked by a refresh.';

-- ---------------------------------------------------------------------------------------------
-- reporting.refresh_all — the nightly pass
-- ---------------------------------------------------------------------------------------------
--
-- Returns every run row, including the ones whose row count is zero. A pass that reported only what
-- changed would be indistinguishable from a pass that had stopped, which is the argument
-- `analytics.run_retention` makes for reporting its exemptions out loud, and the reason
-- `agent_heartbeat` exists at all (docs/10 section 6).
create function reporting.refresh_all(p_trigger text default 'nightly')
returns setof reporting.refresh_run
language plpgsql
security definer
set search_path = reporting, public, pg_temp
as $$
declare
  v_view reporting.materialised_view;
begin
  -- Once, before the first view, rather than once per view: the registry is what this loop iterates, so
  -- a disagreement with the catalogue has to be refused before any of it is trusted.
  perform reporting.assert_views_are_refreshable();

  for v_view in select * from reporting.materialised_view order by refresh_rank loop
    return next reporting.refresh(v_view.view_name, p_trigger);
  end loop;
end $$;

comment on function reporting.refresh_all(text) is
  'Refreshes every registered reporting view in declared order and returns one row per view, including '
  'the ones that came back empty — a pass reporting only what changed is indistinguishable from a pass '
  'that stopped. This is what the reporting.refresh nightly cron calls.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
--
-- The application role READS and never writes: every relation here is derived, so there is nothing for
-- it to insert. It gets EXECUTE on the two refresh functions instead, which is what SECURITY DEFINER is
-- for — a role that could refresh a materialised view directly would have to own it.
grant usage on schema reporting to berelax_app;
grant select on all tables in schema reporting to berelax_app;
alter default privileges in schema reporting grant select on tables to berelax_app;

-- It may add and amend observance rows, because answering Y9-holiday-calendar is an admin action rather
-- than a migration — the same argument 0011 makes for premises_hours_override being data.
grant insert, update, delete on reporting.calendar_observance to berelax_app;

revoke execute on function reporting.refresh(text, text) from public;
revoke execute on function reporting.refresh_all(text) from public;
grant execute on function reporting.refresh(text, text) to berelax_app;
grant execute on function reporting.refresh_all(text) to berelax_app;

grant usage on schema reporting to berelax_readonly;
grant select on all tables in schema reporting to berelax_readonly;
alter default privileges in schema reporting grant select on tables to berelax_readonly;

-- The clinical role has no business here and says so, exactly as 0096 does for analytics: this schema
-- holds aggregates of the commercial estate, and 0009 revoked the traffic in the other direction.
revoke all on schema reporting from berelax_clinical;

-- ---------------------------------------------------------------------------------------------
-- The nightly pass's agent row
-- ---------------------------------------------------------------------------------------------
--
-- A cron with no `agent_definition` row is a cron nothing watches and nothing caps (G-AGT-01), and
-- `pnpm jobs` refuses one. The declared interval is 24 hours, which is what makes the watchdog's "no
-- success within twice the interval" alert mean something for it.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('reporting_refresh', 'Reporting refresh',
   'Refreshes every materialised view in the reporting schema, concurrently, once a night after trading '
   'closes, and records a refresh_run row per view. A pass that stops running is stale numbers with '
   'nothing saying so, which is what R-REP-07 reads refresh_run to decide.',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- And its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two and the watchdog evaluates what
-- that returns. An agent_definition row with no heartbeat row is therefore an agent the watchdog cannot see
-- at all — the exact state a watchdog exists to make impossible — and it fails
-- `apps/worker/src/jobs/agent-watchdog.itest.ts`'s registry-completeness case by name.
--
-- One row, this unit's own. 0107's missing `gratuity_accrual` heartbeat was found twice independently and
-- was repaired here as a second row, on the argument that a landed migration should not be edited. At the
-- integrating merge 0107 itself was corrected instead: nothing has gone live, every database is rebuilt from
-- the files, and the convention 0031 states — "0021 seeded a heartbeat for every agent it created; a new
-- agent has to bring its own" — belongs in the migration that creates the agent. A gratuity row in a
-- reporting migration would also be a second statement of whose agent that is.
insert into agent_heartbeat (agent_key)
values ('reporting_refresh')
on conflict (agent_key) do nothing;

commit;

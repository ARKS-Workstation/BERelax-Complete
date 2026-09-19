-- 0042 — the Search Console warehouse: the daily rows, the run that fetched them, and the URL
--        Inspection rotation that a 2,000-a-day cap makes necessary.
--
-- This is the first slice of the SEO agent and the one that works on launch day, because Search Console
-- is not access-gated the way Business Profile is (docs/10 §2, §9). Everything here exists because of
-- four facts about the Search Console API, each of which shapes a column:
--
--   1. **The 16-month window.** Google discards the seventeenth month. A report that reads the API
--      directly can therefore never show a year-on-year comparison, and the history is not recoverable
--      once it is gone — so the nightly job mirrors it into `seo_gsc_daily`, and the mirror IS the
--      history. That is the whole reason this table exists rather than a live query.
--   2. **The 2–3 day lag.** The most recent two days are incomplete and keep changing. The requested
--      window therefore ends at `today - 3` and a re-fetch of the preceding week is normal, which is why
--      `seo_gsc_daily` is upserted rather than appended (see `seo_gsc_daily_dimensions_unique`).
--   3. **25,000 rows per request, paged with `startRow`.** A day of query-level rows for a site with any
--      long tail exceeds one page, so the writer takes many pages and has to prove it lost none.
--   4. **Rare queries are withheld entirely.** Summed query-level clicks are ALWAYS less than page-level
--      clicks, because Google removes queries too rare to be anonymous. That is a fact to store and
--      explain, not a discrepancy to reconcile (docs/10 §7) — hence `rare_query_clicks`, which is a
--      GENERATED column so the number cannot be invented, only derived.
--
-- ## Calendar UTC dates, NOT business_day — and this is a deliberate exception
--
-- Every other date in this system that belongs to a trading day uses `business_day` semantics: trading
-- runs 11:00–02:00, so 01:30 belongs to the previous trading date (ADR 0007, `resolveTradingDate`). The
-- dates here do not, and must not.
--
-- `seo_gsc_daily.date` is **Google's own date**: the calendar day in UTC that Search Console attributed
-- the impression to. It is the join key between our warehouse and the Search Console UI the owner will
-- compare it against, and it is the value the API both accepts and returns. Re-deriving it on
-- `business_day` would shift every row by up to three hours, so a click Google recorded at 22:30 UTC on
-- Tuesday (02:30 Wednesday in Abu Dhabi, therefore trading date Tuesday) would sometimes agree and
-- sometimes not — and the two systems would disagree about a day's clicks by an amount nobody could
-- explain. A warehouse whose totals do not match the source it mirrors is worse than no warehouse.
--
-- `seo_url_inspection_run.run_date` is a calendar UTC date for a different reason: it is the day Google's
-- URL Inspection quota resets on, which is Google's own day and not ours to define. Both are stated in
-- their column comments so a reader does not have to find this header.
--
-- ## Why the run is its own table
--
-- `seo_gsc_snapshot` is one row per (property, window) and carries the evidence that the run behaved:
-- how many pages it took, where the cursor ended, how many rows it persisted, and the two totals whose
-- difference is the withheld figure. Without it, "the nightly job ran and found nothing" and "the
-- nightly job has not run since Tuesday" look identical — and the second is the one that matters.

begin;

-- ---------------------------------------------------------------------------------------------
-- The warehouse: one row per Search Console dimension tuple per day.
-- ---------------------------------------------------------------------------------------------
create table seo_gsc_daily (
  id              bigint      generated always as identity primary key,
  -- The property, as Search Console identifies it: `sc-domain:example.com` or `https://example.com/`.
  -- A domain property and a URL-prefix property for the same website are two SEPARATE properties with
  -- separate data (docs/10 §2), which is why this is part of the dimension key below rather than
  -- context a reader is expected to assume.
  site_url        text        not null,
  -- Google's calendar date in UTC, not a trading date. See the header: this is the join key between the
  -- warehouse and the Search Console UI, and re-deriving it on business_day would make the two disagree.
  date            date        not null,
  page            text        not null,
  -- The search query. NOT NULL and never a placeholder: a withheld rare query does not arrive as an
  -- empty string, it does not arrive at all, and inventing a row for it is the one thing that would make
  -- the withheld figure below unreconstructable.
  query           text        not null,
  -- DESKTOP | MOBILE | TABLET, as the API spells them, and deliberately WITHOUT a CHECK constraint.
  -- A closed set here would refuse a row rather than store it the day Google adds a device class, and a
  -- refused row is data lost for ever — the API keeps no history to re-fetch it from after 16 months.
  -- An unexpected value is noticed where it can be acted on instead: the adapter logs it.
  device          text        not null,
  -- ISO 3166-1 alpha-3, lower case, as the API returns it (`are`, `ind`). `zzz` is Google's own value
  -- for a country it could not determine and is stored as it arrives, for the same reason as `device`.
  country         text        not null,
  clicks          integer     not null,
  impressions     integer     not null,
  -- Average position × 100, as an integer.
  --
  -- Integer rather than numeric or a float for the reason ADR 0007 gives about money and which applies
  -- here too: a float average position read back differs in the last digit between two runs of the same
  -- report, and this warehouse is read by a weekly report that must diff cleanly. Two decimals is what
  -- the Search Console UI shows, so nothing is lost by pinning the precision here.
  avg_position_centi integer  not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Google reports clicks as a subset of impressions. A row that breaks it was mis-parsed on our side —
  -- most plausibly by reading two different dimension groupings into one row — and storing it would
  -- silently corrupt every CTR the analyses compute from these two columns.
  constraint seo_gsc_daily_clicks_cannot_exceed_impressions check (clicks <= impressions),
  constraint seo_gsc_daily_counts_are_non_negative check (clicks >= 0 and impressions >= 0),
  -- Position is 1-based and there is no position zero. Zero is what arrives when a missing value is
  -- coerced rather than handled, and it would read as ranking ABOVE the first result — the same mistake
  -- docs/10 §7 names for CrUX: handle the empty case rather than rendering a zero.
  constraint seo_gsc_daily_position_is_at_least_one check (avg_position_centi >= 100)
);

comment on table seo_gsc_daily is
  'The mirrored Search Console query report. Upserted, not appended: the last two to three days keep '
  'changing, so the nightly pass re-fetches a week and the dimension key decides what is the same row.';
comment on column seo_gsc_daily.date is
  'Google calendar date in UTC. NOT a business_day trading date — see 0042 header.';
comment on column seo_gsc_daily.avg_position_centi is
  'Average position times 100. Integer, so two runs of one report produce the same bytes.';

-- THE index this unit turns on, and the five dimensions are Google's own.
--
-- It is what makes the nightly pass idempotent: a re-fetch of a day already stored updates the row
-- instead of adding a second one, and a paging bug that returned the same page twice is REFUSED rather
-- than silently doubling a day's clicks. The writer therefore upserts with `do update` and asserts that
-- every row it sent was affected — `do nothing` would hide exactly the loss this index exists to reveal.
--
-- `site_url` leads the key although the acceptance criterion names five columns and not six. Two
-- properties for one website are two separate datasets, and without it the domain property's rows would
-- overwrite the URL-prefix property's row by row, leaving one dataset that is half of each.
create unique index seo_gsc_daily_dimensions_unique
  on seo_gsc_daily (site_url, date, page, query, device, country);

-- The read pattern of every analysis in G-SEO-03: one property, a date range, newest first.
create index seo_gsc_daily_site_date_idx on seo_gsc_daily (site_url, date desc);

create trigger seo_gsc_daily_updated_at before update on seo_gsc_daily
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- The run: what the nightly pass fetched, and the withheld figure it derived.
-- ---------------------------------------------------------------------------------------------
create table seo_gsc_snapshot (
  id                uuid        primary key default uuid_generate_v7(),
  site_url          text        not null,
  -- The requested window, in Google's calendar UTC dates. `window_end` is `today - 3`: the two most
  -- recent days are incomplete, and a warehouse that stored them would record a traffic collapse every
  -- night and a recovery every morning.
  window_start      date        not null,
  window_end        date        not null,
  -- The instant the pass ran, injected rather than defaulted, so a pass driven at a frozen clock stores
  -- the instant it was driven at. `created_at` is when the row was written, which is not the same claim.
  requested_at      timestamptz not null,
  -- The paging evidence. `pages_fetched` is the number of API calls and `last_start_row` the cursor the
  -- final call used, so "one page, 25,000 rows" — the shape of a silently truncated fetch — is visible
  -- in the row rather than only in a log nobody reads.
  pages_fetched     integer     not null,
  row_limit         integer     not null,
  last_start_row    integer     not null,
  rows_persisted    integer     not null,
  -- The two totals whose difference is the withheld figure. Query-level is the sum over the rows the
  -- breakdown returned; page-level is the sum over the same window with no query dimension, which is
  -- where the rare queries' clicks are still counted.
  query_clicks      bigint      not null,
  query_impressions bigint      not null,
  page_clicks       bigint      not null,
  page_impressions  bigint      not null,
  -- The rare-query gap, GENERATED.
  --
  -- This is the named column the criterion asks for, and it is generated rather than written because the
  -- one way to get this fact wrong is to store a number somebody computed elsewhere. A stored copy can
  -- disagree with the two figures it is made of; a generated one cannot, and PostgreSQL refuses an INSERT
  -- that tries to supply a value for it (SQLSTATE 428C9), which is a stronger guarantee than a comment.
  rare_query_clicks      bigint generated always as (page_clicks - query_clicks) stored,
  rare_query_impressions bigint generated always as (page_impressions - query_impressions) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint seo_gsc_snapshot_window_is_ordered check (window_start <= window_end),
  constraint seo_gsc_snapshot_counts_are_non_negative check (
    pages_fetched >= 1 and row_limit > 0 and last_start_row >= 0 and rows_persisted >= 0
      and query_clicks >= 0 and query_impressions >= 0
      and page_clicks >= 0 and page_impressions >= 0
  ),
  -- The direction of the inequality, as a constraint rather than as a hope.
  --
  -- Google withholds rare queries, so the query breakdown can only ever total LESS than the page-level
  -- report. The other direction is not a Google anomaly: it means this system summed the same rows twice,
  -- or compared two different windows, and the generated column above would then hold a negative
  -- withheld figure that the owner-facing sentence would render as "-20 clicks are withheld". Refusing
  -- the row leaves the previous night's snapshot in place, which is a worse-but-honest answer.
  constraint seo_gsc_snapshot_query_clicks_do_not_exceed_page_clicks check (
    query_clicks <= page_clicks and query_impressions <= page_impressions
  ),
  -- One row per property per window, so re-running a night updates the evidence rather than appending a
  -- second version of it.
  constraint seo_gsc_snapshot_window_unique unique (site_url, window_start, window_end)
);

comment on table seo_gsc_snapshot is
  'One row per property per requested window: the paging evidence and the rare-query gap. Without it, '
  '"the pass ran and found nothing" and "the pass has not run since Tuesday" are the same row count.';
comment on column seo_gsc_snapshot.rare_query_clicks is
  'GENERATED: page_clicks - query_clicks. The clicks Search Console withholds because the query was too '
  'rare to be anonymous. A fact, not an error (docs/10 §7).';

create index seo_gsc_snapshot_site_window_idx on seo_gsc_snapshot (site_url, window_end desc);

create trigger seo_gsc_snapshot_updated_at before update on seo_gsc_snapshot
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- URL Inspection: a rotation, because the cap is 2,000 a day and unraisable.
-- ---------------------------------------------------------------------------------------------
--
-- docs/10 §7: URL Inspection is **2,000/day per site and effectively unraisable** — so the answer is to
-- inspect a rotating priority subset, never everything daily. The rotation state is PERSISTED here and
-- not computed, and that is the substance of this table rather than an implementation detail: a subset
-- chosen by a shuffle, or by a hash of the date, re-inspects the same URLs before it has covered the
-- others, and the ones it skips are skipped for weeks with nothing saying so.
create table seo_url_inspection (
  id                uuid        primary key default uuid_generate_v7(),
  site_url          text        not null,
  url               text        not null,
  -- Lower sorts first. The tie-break after "least recently inspected", so a run that can only take
  -- 2,000 of 5,000 candidates takes the 2,000 that matter most — and two runs with the same state
  -- choose the same URLs, which is what makes the rotation reproducible.
  priority          integer     not null default 1000,
  -- The rotation cursor. NULL means never inspected, and the selection orders by this column with NULLS
  -- FIRST: every candidate is covered once before any is covered twice.
  last_inspected_at timestamptz,
  inspections       integer     not null default 0,
  -- The API's own answer. `verdict` is a closed set the API documents; `coverage_state` is Google's
  -- prose ("Submitted and indexed", "Crawled - currently not indexed") and is not ours to close.
  verdict           text,
  coverage_state    text,
  last_crawled_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint seo_url_inspection_url_unique unique (site_url, url),
  constraint seo_url_inspection_priority_is_non_negative check (priority >= 0),
  constraint seo_url_inspection_inspections_are_non_negative check (inspections >= 0),
  constraint seo_url_inspection_verdict_is_known check (
    verdict is null or verdict in ('PASS', 'PARTIAL', 'FAIL', 'NEUTRAL', 'VERDICT_UNSPECIFIED')
  ),
  -- The rotation state must be self-consistent, and this is the constraint that keeps the coverage
  -- guarantee true. A row counted as inspected with no timestamp sorts as never-inspected under NULLS
  -- FIRST, so it would be handed to the very next run — inspected twice while another URL had not been
  -- inspected at all, which is precisely what the cap makes expensive.
  constraint seo_url_inspection_inspected_rows_carry_a_timestamp check (
    (inspections = 0) = (last_inspected_at is null)
  ),
  -- A verdict with no inspection is a verdict from nowhere.
  constraint seo_url_inspection_verdict_needs_an_inspection check (
    verdict is null or last_inspected_at is not null
  )
);

comment on table seo_url_inspection is
  'The URL Inspection rotation. last_inspected_at IS the cursor: the selection orders by it NULLS '
  'FIRST, so full coverage happens before any re-inspection (docs/10 §7, the 2,000/day cap).';
comment on column seo_url_inspection.last_inspected_at is
  'Set when the inspection is REQUESTED, not when it succeeds: Google charges the quota for the request.';

-- The rotation's selection order, as an index. Without it the nightly claim sorts 5,000 rows to take
-- 2,000 of them, every night, for ever.
create index seo_url_inspection_rotation_idx
  on seo_url_inspection (site_url, last_inspected_at nulls first, priority, url);

create trigger seo_url_inspection_updated_at before update on seo_url_inspection
  for each row execute function set_updated_at();

-- The daily quota ledger: what a day has already spent.
--
-- One row per (property, Google's day), so a retried job does not spend a second full cap — the cap is
-- per calendar day at Google's end, not per run at ours, and a job that treated it as per-run would
-- exhaust the quota on its second attempt and inspect nothing for the rest of the day.
create table seo_url_inspection_run (
  id           uuid        primary key default uuid_generate_v7(),
  site_url     text        not null,
  -- Google's calendar UTC date: the day its quota resets on. See the header.
  run_date     date        not null,
  daily_cap    integer     not null,
  inspected    integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint seo_url_inspection_run_unique unique (site_url, run_date),
  constraint seo_url_inspection_run_cap_is_positive check (daily_cap > 0),
  -- The cap, enforced where it cannot be forgotten. Exceeding it does not fail gracefully at Google's
  -- end: every further call that day is refused, including the ones a human would have wanted.
  constraint seo_url_inspection_run_stays_within_the_daily_cap check (
    inspected >= 0 and inspected <= daily_cap
  )
);

comment on table seo_url_inspection_run is
  'What each property has already spent of its 2,000-a-day URL Inspection quota, keyed on Google''s '
  'calendar day. A retry reads this and takes only the remainder.';

create trigger seo_url_inspection_run_updated_at before update on seo_url_inspection_run
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Two agents, and why not one — and why neither is `seo_agent`.
-- ---------------------------------------------------------------------------------------------
--
-- 0021's contract is that every pg-boss cron has an `agent_definition` row: without one it has no
-- declared interval and no budget, so nothing watches it and nothing caps it, and `pnpm jobs` refuses
-- the declaration outright.
--
-- **Not `seo_agent`.** That row exists already and declares a SEVEN-DAY interval, because it is the
-- weekly review and the five prioritised actions (G-SEO-05). A nightly pass writing its heartbeat would
-- keep it hours old for ever, and a weekly report that had stopped being produced entirely would be
-- invisible — the watchdog measures the absence of a success per agent, and the slowest schedule sharing
-- a heartbeat with the fastest is a heartbeat that reports only the fastest. That is 0033's argument for
-- `google_liveness`, and it applies unchanged here.
--
-- **Two, not one,** for the same reason one level down. The snapshot and the inspection rotation are
-- separate crons with separate failure modes: the rotation can be refused all night by an exhausted
-- quota while the snapshot is perfectly healthy, and a shared heartbeat would report the pair as fine
-- because one of them ran. Both declare 24h, so the watchdog alerts at 48h: one missed night is a late
-- cron, two is an incident.
--
-- The budget is zero fils on both. Neither pass calls a model — they call Google and write rows. The
-- deterministic analyses and the drafting that do call one are G-SEO-03 and G-SEO-05, under `seo_agent`.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('seo_gsc_snapshot', 'Search Console nightly snapshot',
   'Mirrors the Search Console query report into seo_gsc_daily every night, paging 25,000 rows at a '
   'time and ending the window at today minus 3. The API keeps 16 months; this keeps the history '
   'Google discards (G-SEO-01).',
   60 * 60 * 24, 0),
  ('seo_url_inspection', 'URL Inspection rotation',
   'Inspects a rotating priority subset of URLs within the 2,000-a-day per-site cap, so every '
   'candidate is covered before any is re-inspected (G-SEO-01, docs/10 §7).',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with no heartbeat row does not
-- appear in the watchdog's list at all — and an agent that does not appear is one the watchdog silently
-- never checks, which is worse than unwatched because the completeness check reports it present. 0021
-- seeded one per agent it created; 0031 and 0033 each brought their own, and so does this.
insert into agent_heartbeat (agent_key)
values ('seo_gsc_snapshot'), ('seo_url_inspection')
on conflict (agent_key) do nothing;

commit;

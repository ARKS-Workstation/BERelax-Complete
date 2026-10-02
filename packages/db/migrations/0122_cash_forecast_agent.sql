-- 0122_cash_forecast_agent.sql — R-REP-06
--
-- Two rows, and no schema at all. This migration creates no table, no column, no type, no function and
-- no constraint; it registers the agent behind the weekly cash-forecast cron and gives it the heartbeat
-- row the watchdog needs in order to be able to see it.
--
-- ============================================================================================
-- Why R-REP-06 needs a migration when R-REP-02, R-REP-03 and R-REP-04 did not
-- ============================================================================================
--
-- The three units before this one each released their allocated migration number unused, and each gave
-- the same reason: the arithmetic is pure, every refusal is a refusal of arithmetic rather than of a
-- write, and a private SQLSTATE is for a refusal that needs a runbook answer at the database boundary
-- (ADR 0043, 0061). All of that is true of this unit as well. **The forecast is not materialised**, for
-- ADR 0064's reason reaching one subject further: it is recomputed from `journal_line`, the recurring
-- cost definitions and the diary at read time, and a stored snapshot would be a second statement of a
-- figure the two would disagree about the first time a booking was cancelled.
--
-- What this unit has that those three did not is a **cron**. `apps/worker/src/job.ts` requires an
-- `agent` on any job with a `cron`, and says why in so many words: "a scheduled job with no agent row
-- has no declared interval and no budget, so nothing is watching it and nothing is capping it — and a
-- cron nobody watches is the failure G-AGT-01 exists to remove". `pnpm jobs` refuses a cron without one
-- and `agents.itest.ts` asserts every registered cron's agent has a row. The agent row is a ROW, so it
-- is a migration — which is the whole of this file.
--
-- The alternative was a queue-only job with no `cron`, which needs no agent. It is worse, and the reason
-- is this unit's own subject: the figures this build can produce for a cash forecast today are mostly
-- REFUSALS — payroll for want of a pay date (`Y8-payroll-date`) and a wage (`Y8-staff`), and every
-- seasonality bucket for want of two occurrences of its own window — and a refusal nobody reads is
-- indistinguishable from a figure. A report that only runs when somebody asks for it is a report whose
-- refusals are seen by whoever already suspected them.
--
-- ============================================================================================
-- The interval, and what it makes the watchdog's alert mean
-- ============================================================================================
--
-- Seven days. The cron is `37 4 * * 0` — 04:37 Asia/Dubai on a Sunday, after the nightly reporting
-- refresh at 03:55 because the seasonality half reads `reporting.dim_date`, which is a materialised view
-- and would otherwise be yesterday's calendar.
--
-- Weekly rather than nightly because the artefact is a weekly horizon: thirteen windows that only move
-- on the day the first one does, so a nightly pass would re-log almost the same thing six times and bury
-- the one that changed. `expected_interval_seconds` is therefore 604,800, and what that buys is the
-- watchdog's "no success within twice the interval" rule meaning "two Sundays have passed with no
-- forecast" rather than a figure this file picked.
--
-- `budget_fils_per_run` is 0, like `reporting_refresh`'s: the pass performs no outbound call of any
-- kind. It reads four aggregates over `journal_line`, three reads of the diary and four of the reporting
-- schema, writes nothing, and logs one line.
--
-- ============================================================================================
-- What this file deliberately does NOT do
-- ============================================================================================
--
--   * **No `reporting.calendar_observance` row.** The dates of the UAE's lunar observances are
--     `Y9-holiday-calendar` and migration 0110 ships that table EMPTY on purpose: "a plausible lunar date
--     is indistinguishable from a confirmed one" (brief rule 15) in the one place every report would then
--     key on. This unit builds the seasonality mechanism OVER whatever that table holds and proves it
--     against rows a test inserts; seeding a Ramadan range here would be this unit inventing the figure
--     0110 refused to invent, and it would do it in the migration run every database replays.
--   * **No `premises_hours_override` row.** Same argument, one table along, and the chain is already
--     complete: a Ramadan schedule is an override row plus a regeneration of `business_day`, with no
--     code change anywhere, which is what `packages/fixtures/src/cash-forecast.itest.ts` exercises by
--     writing one and reading a different seasonality index out of unchanged code.
--   * **No SQLSTATE.** The band ZY281-ZY290 allocated to this unit is released and deliberately left
--     UNREGISTERED: `pnpm sqlstate` refuses an entry for a code no migration raises, and nothing here
--     can be refused by the database because nothing here writes.
--   * **No Drizzle mirror change.** `pnpm db:drift` compares base TABLES against their mirrors, and this
--     file adds no object to compare. `agent_definition` and `agent_heartbeat` are already mirrored.

begin;

-- The agent behind `reporting.cash-forecast`. `on conflict do nothing` for the reason every other agent
-- insert has it: a migration run twice must change nothing, and this file is replayed by
-- `scripts/apply-migrations.mjs` against every database.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('cash_forecast', 'Cash-flow forecast',
   'Computes the 13-week cash-flow forecast and the seasonality report once a week and records what it '
   'found, including every figure it REFUSED to produce. It stores nothing: the forecast is recomputed '
   'at read time, and the point of a scheduled pass over an artefact nobody can check until it is too '
   'late is that its refusals are seen rather than silently rendered as zero (R-REP-06, ADR 0073).',
   60 * 60 * 24 * 7, 0)
on conflict (agent_key) do nothing;

-- And its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two and the watchdog evaluates
-- what that returns. An `agent_definition` row with no heartbeat row is an agent the watchdog cannot see
-- at all — the exact state a watchdog exists to make impossible — and it fails
-- `apps/worker/src/jobs/agent-watchdog.itest.ts`'s registry-completeness case by name. 0031 states the
-- convention and 0110 restates it: "0021 seeded a heartbeat for every agent it created; a new agent has
-- to bring its own".
insert into agent_heartbeat (agent_key)
values ('cash_forecast')
on conflict (agent_key) do nothing;

commit;

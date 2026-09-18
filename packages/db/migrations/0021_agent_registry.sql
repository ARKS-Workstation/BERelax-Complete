-- 0021 — the agent registry, the heartbeat contract and the watchdog's alert ledger.
--
-- Eight agents in this system do work on a schedule that nobody watches in real time: the SEO agent,
-- the review autoresponder, the reminder scheduler, the campaign sender, the analytics dispatcher, the
-- nightly rollups, the compliance calendar and the Google health check. Every one of them fails the same
-- way — silently. A pg-boss job that stops being scheduled, a handler that throws on every run, a cron
-- that was never registered after a rename: all three look identical from outside, which is to say they
-- look like a system with nothing to do.
--
-- docs/10 §6 puts it plainly: **a pg-boss job failure is not evidence anybody has seen, because nobody
-- reads pgboss.job.** So the contract is inverted. An agent declares how often it expects to succeed,
-- and a watchdog alerts when it has not — whatever the cause, including causes nobody anticipated. The
-- absence of a success is the signal, not the presence of an error.
--
-- This table set exists before any agent so that no agent can be added without a heartbeat. The
-- registry-completeness check is the enforcement: a cron with no `agent_definition` row fails the build.

begin;

create table agent_definition (
  agent_key                 text        primary key,
  display_name              text        not null,
  purpose                   text        not null,
  -- How often a success is expected. The watchdog alerts at twice this, so an agent that runs daily is
  -- not paged for being four hours late — only for having missed two whole cycles.
  expected_interval_seconds integer     not null check (expected_interval_seconds > 0),
  -- Per-run cap on LLM spend. Zero means the agent costs nothing to run, not that it is unlimited.
  budget_fils_per_run       fils_nonneg not null default 0,
  enabled                   boolean     not null default true,
  -- Distinct from `enabled` on purpose. `enabled` is configuration: this agent is part of the product.
  -- `kill_switch` is an operator stopping a running thing now, and the two want different audit stories
  -- and different alerting: a disabled agent is silent by design, a killed one is an incident.
  kill_switch               boolean     not null default false,
  -- When the agent last became enabled. The watchdog measures silence from the later of this and the
  -- last success, which is what stops a re-enabled agent emitting a backdated alert for the window it
  -- was deliberately switched off — a special case in the watchdog otherwise, and one that is easy to
  -- get wrong in exactly the situation where somebody has just finished fixing something.
  enabled_since             timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table agent_definition is
  'One row per scheduled agent. Every pg-boss cron must have one, enforced by the registry-completeness '
  'check, so an agent cannot be added without a heartbeat and a watchdog.';
comment on column agent_definition.enabled_since is
  'Silence is measured from greatest(last_success_at, enabled_since), so re-enabling does not alert for '
  'the disabled window.';

create trigger agent_definition_updated_at before update on agent_definition
  for each row execute function set_updated_at();

create table agent_run (
  run_id       uuid        primary key default uuid_generate_v7(),
  agent_key    text        not null references agent_definition (agent_key),
  -- The pg-boss job id, when the run came from a queue. Text rather than uuid with a foreign key: the
  -- job row is subject to pg-boss's retention policy and will eventually be deleted, so a foreign key
  -- would either block retention or cascade away the run history.
  job_id       text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  outcome      text        not null
    check (outcome in ('running', 'succeeded', 'failed', 'stopped_by_kill_switch', 'budget_exceeded')),
  -- Partial spend is recorded even on a run that aborted. A budget-exceeded run that recorded nothing
  -- would make the month's LLM bill unexplainable by exactly the runs that caused it.
  cost_fils    fils_nonneg not null default 0,
  error        text,
  -- The trading date, not the calendar date: trading runs 11:00–02:00, so a 01:30 run belongs to the
  -- previous trading day and a per-day agent cost report that cut on the calendar date would split one
  -- night's work across two rows.
  trading_date date,
  check ((outcome = 'running') = (finished_at is null)),
  check ((error is null) or (outcome in ('failed', 'budget_exceeded')))
);
comment on table agent_run is 'One row per attempt, including attempts stopped before their body ran.';

create index agent_run_agent_started_idx on agent_run (agent_key, started_at desc);
create index agent_run_unfinished_idx on agent_run (agent_key) where outcome = 'running';

create table agent_heartbeat (
  agent_key            text        primary key references agent_definition (agent_key),
  -- Written on failure as well as success, which is the whole point. A heartbeat that only records
  -- successes cannot distinguish "running and failing every time" from "not running at all", and those
  -- two need different people woken up.
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  last_error           text,
  last_outcome         text,
  consecutive_failures integer     not null default 0 check (consecutive_failures >= 0),
  updated_at           timestamptz not null default now()
);
comment on column agent_heartbeat.last_run_at is
  'Updated on every attempt, successful or not. last_success_at is what the watchdog measures.';

create trigger agent_heartbeat_updated_at before update on agent_heartbeat
  for each row execute function set_updated_at();

create table agent_alert (
  alert_id     uuid        primary key default uuid_generate_v7(),
  agent_key    text        not null references agent_definition (agent_key),
  raised_at    timestamptz not null default now(),
  -- One alert per unbroken silence. The key is derived from the last success the watchdog saw, so every
  -- pass during the same incident computes the same value and the unique constraint below discards the
  -- duplicate. A watchdog that ran every fifteen minutes would otherwise raise ninety-six alerts for one
  -- broken agent, and the ninety-sixth is the one nobody reads.
  incident_key text        not null,
  silent_for_seconds integer not null check (silent_for_seconds >= 0),
  detail       jsonb       not null default '{}'::jsonb,
  acknowledged_at timestamptz,
  unique (agent_key, incident_key)
);
comment on table agent_alert is
  'Deduplicated by (agent_key, incident_key). The incident key changes only when a success does, so a '
  'repeated watchdog pass in the same incident inserts nothing.';

-- The eight agents this system runs, plus the maintenance cron that predates them.
--
-- Seeded here rather than by an application so that the completeness check has something to check on a
-- fresh database, and so that adding an agent is a migration — a reviewable act — rather than a row
-- somebody inserted once on production.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('seo_agent', 'SEO agent',
   'Weekly Search Console review and the five prioritised actions report (G-SEO).',
   60 * 60 * 24 * 7, 5000),
  ('review_autoresponder', 'Review autoresponder',
   'Drafts replies to new Google reviews for approval (G-REV).',
   60 * 60 * 6, 2000),
  ('reminder_scheduler', 'Reminder scheduler',
   'Builds and rebuilds appointment reminders as bookings change (B-MSG-03).',
   60 * 15, 0),
  ('campaign_sender', 'Campaign sender',
   'Sends scheduled campaigns inside the promotional window (C-AUTO-10).',
   60 * 15, 0),
  ('analytics_dispatcher', 'Analytics dispatcher',
   'Pushes conversions to GA4 Measurement Protocol and Meta CAPI (A-MEAS-03).',
   60 * 5, 0),
  ('nightly_rollups', 'Nightly rollups',
   'Aggregates the funnel and the day''s takings on business_day (A-FIRST-09).',
   60 * 60 * 24, 0),
  ('compliance_calendar', 'Compliance calendar',
   'VAT and licence deadlines, with escalation (M-VAT-11).',
   60 * 60 * 24, 0),
  ('google_health', 'Google connection health',
   'Daily connection check, Testing-expiry tripwire and listing-drift detection (G-CONN-06).',
   60 * 60 * 24, 0),
  -- The ninth. Migration 0005 creates audit_event with no DEFAULT partition, deliberately, so this job
  -- stopping means audit inserts FAIL rather than landing somewhere nobody prunes. It had been declared
  -- since F04 and watched by nothing; a watchdog that covered the eight interesting agents and not this
  -- one would be watching the wrong list.
  ('audit_partitions', 'Audit partition maintenance',
   'Keeps audit_event partitions ahead of the clock. 0005 creates no DEFAULT partition on purpose.',
   60 * 60 * 24, 0),
  -- The tenth, and the one that looks circular. The watchdog has a row like everything else, so if the
  -- watchdog itself stops running its own heartbeat goes stale — which no pass of the watchdog will
  -- report, because there are no passes. That is the point: the evidence is a row rather than an absence,
  -- and something outside this process reads it (the alerting ladder, H-HARD-05). A watchdog exempt from
  -- its own contract is a watchdog whose failure is invisible, which is the exact shape of failure this
  -- table set exists to remove.
  ('agent_watchdog', 'Agent watchdog',
   'Alerts when any enabled agent has had no success within twice its declared interval.',
   60 * 15, 0);

insert into agent_heartbeat (agent_key) select agent_key from agent_definition;

commit;

-- 0033 — the agent behind the hourly Google liveness probe.
--
-- G-CONN-06 registers two crons, not one: a deep check at 03:00 Asia/Dubai and a cheap liveness probe
-- every hour. 0021's contract is that every pg-boss cron has an `agent_definition` row — without one it
-- has no declared interval and no budget, so nothing is watching it and nothing is capping it, and
-- `pnpm jobs` refuses the declaration outright.
--
-- ## Why a SECOND agent rather than both crons reporting to google_health
--
-- This is the whole reason this migration exists, and it is the failure the agent registry was built to
-- remove. The watchdog alerts on the **absence of a success**, measured per agent. If the hourly probe
-- wrote the `google_health` heartbeat, then a deep check that stopped running entirely — renamed, never
-- registered after a deploy, throwing on every pass — would be invisible: the heartbeat would be minutes
-- old, every hour, for ever, refreshed by a completely different job. The slowest schedule sharing a
-- heartbeat with the fastest is a heartbeat that reports only the fastest.
--
-- Two agents, two intervals, two independent silences:
--
--   * `google_health`   — 24h, seeded by 0021. The watchdog alerts at 48h, which is the acceptance
--                         boundary: one missed daily pass is a late cron, two is an incident.
--   * `google_liveness` — 1h. The watchdog alerts at 2h, which is what makes the probe's own failure
--                         visible within the window the probe exists to provide.
--
-- The budget is zero fils on both. Neither pass calls a model: they call Google and write rows.

begin;

insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('google_liveness', 'Google connection liveness',
   'One cheap authenticated call per Google connection every hour, so a revoked or expired grant is '
   'found within the hour rather than at 03:00 the following morning (G-CONN-06).',
   60 * 60, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with no heartbeat row does not
-- appear in the watchdog's list at all — and an agent that does not appear is one the watchdog silently
-- never checks. 0021 seeded a heartbeat for every agent it created and 0031 did the same for the
-- recurring-cost register; a new agent has to bring its own or it is worse than unwatched, because the
-- registry-completeness check would report it present.
insert into agent_heartbeat (agent_key) values ('google_liveness')
on conflict (agent_key) do nothing;

commit;

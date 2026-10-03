---
id: job-backlog
title: pg-boss backlog: the worker has stopped draining
unit: H-HARD-06
trigger_kind: alert
trigger: The outbox lag or job failure alert has fired, or scheduled work is visibly not happening: no messages going out, no nightly reports, no accruals.
first_action_heading: 1-is-the-worker-running-at-all
first_action: Find out whether the worker is running at all, because a stopped worker raises no alerts and the absence of alerts reads exactly like quiet.
owner: owner
escalation: Nothing outside this deployment watches the worker, so a stopped worker is undefended by design and is recorded as such in the alert registry; escalation is a person looking, and there is nobody else to ask.
alerts: outbox_lag, job_failure_rate
env: DATABASE_URL
---

# Runbook — pg-boss backlog

## Read this first: a stopped worker raises nothing

Every alert in this build is raised by a **pass** — `apps/worker/src/jobs/alert-evaluator.ts`, run by
the watchdog every fifteen minutes. So a worker that is not running raises no alert at all, and the
absence of alerts is indistinguishable from everything being fine. That exposure is written out as
`the-pass-cannot-report-its-own-absence` in `packages/shared/src/alerts/registry.ts` rather than left to
be discovered, and it is why section 1 is the first action rather than a diagnostic.

What makes it findable at all is that the evidence is a **row** and not an absence: every agent writes
`agent_heartbeat` on every run, with the instant of its next expected run beside the last one.

## 1. Is the worker running at all

```
psql "$DATABASE_URL" -c "select agent_key, last_run_at, last_success_at, next_run_at, last_outcome, consecutive_failures from agent_heartbeat order by last_run_at nulls first"
```

| What you see | What it is |
|---|---|
| Every `last_run_at` older than its `next_run_at` by a lot, all by the same amount | The worker is not running. Start it. |
| `last_run_at` recent, `last_success_at` old, `consecutive_failures` climbing | The worker is running and one or more agents are failing every pass. Section 3. |
| One agent stale and the rest current | That one job is failing or is not scheduled. Section 3. |
| No rows at all | The migrations are applied and no agent has ever run. A fresh deployment, not an incident. |

All by the same amount is the signature worth knowing: a stopped process stops everything at once, and a
broken job stops one thing.

## 2. The queue itself

pg-boss keeps its own tables in its own schema and `apps/worker/src/boss.ts` is the instance. Two
states matter:

- **`active` jobs with no progress.** `apps/worker/src/boss.ts`'s own comment is about this: a handler
  killed halfway through leaves the job `active`, and pg-boss will not reissue it until its expiry
  passes. So an `active` job older than its deadline is a job waiting on a timeout, not a job running.
- **A cron that never fires.** A malformed expression is *accepted* by pg-boss and then simply never
  runs. `pnpm jobs` is the gate that refuses one in the repository, so this cannot be the cause of a
  backlog on a tree that passes — which is the point of having that gate.

```
psql "$DATABASE_URL" -c "select state, count(*) from pgboss.job group by 1 order by 2 desc"
```

## 3. One agent is failing every pass

`agent_run` holds each attempt with its outcome; read the newest for the agent that is stale. Then:

- **Inside its retry budget** the row stays `failed` and a later pass tries again. A malformed payload
  is this case, and doing nothing is correct.
- **Budget exhausted** moves it to `dead_letter`, which is a *state* and not a silent drop — the reason
  that distinction exists is that a `failed` row and a given-up row used to be indistinguishable in
  every console and every `where` clause.
- **A dead-lettered row can be re-queued.** Consent is judged again on the way back through, so a row
  that should no longer go out refuses again rather than going out because it was re-queued.
- **A dead-lettered row may not be DELETED**, including by the owner, because the offline-conversion
  reconciliation compares against what was pushed and a deleted dead letter makes a conversion the
  platform never heard about indistinguishable from one nobody enqueued.

## 4. The outbox, which is the backlog people actually notice

The outbox is the send path's queue and is separate from pg-boss's: `outbox_event` is the work and
`outbox_delivery` is one row per `(event, handler)` attempt, which is what makes exactly-once delivery
per handler a thing you can count rather than a thing you hope for.

```
psql "$DATABASE_URL" -c "select count(*) as unpublished, max(attempts) as worst from outbox_event where published_at is null"
psql "$DATABASE_URL" -c "select handler, count(*) as delivered, max(attempts) as worst from outbox_delivery group by 1 order by 2 desc"
```

If the events are pending and the deliveries are not growing, the drain is stopped and section 1 is the
cause. If the deliveries are growing and the recipients are not receiving, it is
[the messaging runbook](messaging-outage.md) and not this one.

## 5. Draining a large backlog

Nothing has to be done by hand. The drain is at-least-once per event with deduplication per
`(event, handler)`, which is what makes "exactly one delivery per handler" something you can COUNT over
a drained backlog rather than something you hope for. Two things not to do:

- **Do not run two workers to drain faster** unless you have read how the spend cap and the row locks
  behave under two; the cap is enforced in the database for exactly that reason, so a second worker
  cannot overspend it — but the backlog is not the moment to find out what else two workers do.
- **Do not truncate the outbox.** A pending event is work somebody is waiting for, and the table is
  the only record that it was ever enqueued.

## 6. After it is draining again

1. `agent_heartbeat` current for every agent, with `next_run_at` in the future.
2. `pnpm jobs` clean, which is the declaration half.
3. Read `agent_alert` for anything the evaluator raised while you were not looking: the alerts clear by
   themselves when the condition goes away, so a backlog that has drained leaves no alert and the record
   of it is this table.

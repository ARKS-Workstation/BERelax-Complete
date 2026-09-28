# ADR 0045 — analytics retention is a policy table the job reads, and the missing partition is a guarded default

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** A-FIRST-01
- **Covers:** docs/01 decisions — none; this is the storage mechanism behind ADR 0018's first-party
  measurement store, and it is the half docs/03 "Volume discipline" states as a requirement without saying
  what enforces it

## Decision

**Two decisions, each of which contradicts something this repository already believed, and each of which is
the reason the other one is safe.**

1. **Every base table in the `analytics` schema carries a row in `analytics.retention_policy` saying what
   retention does to it and why, and `analytics.run_retention` REFUSES the whole pass when the list and the
   schema disagree in either direction** — `ZY062` for a table nobody classified, `ZY063` for a policy naming
   a relation that is not there. The 90-day window is one function, `analytics.raw_retention_days()`. The
   three daily rollups are exempt *by a row*, and the pass reports the exemption in its output rather than
   passing over them in silence.

2. **Each raw partitioned parent has a DEFAULT partition, and a `BEFORE INSERT` trigger on that default
   partition raises `ZY061`** naming the month, the parent and the function to run. Nothing is ever stored
   there. Migration 0005 says of `audit_event` that there is "deliberately no DEFAULT partition", and that
   reasoning — a default partition is a place rows land that nobody prunes — is exactly why this one exists.

## The alternative, and the specific way each fails here

### On retention: a `case` in the function, or a documented schedule

The obvious design is a job that knows the tables: drop partitions of `event` and `funnel_step`, delete old
rows from `visitor`, `session` and `attribution`. It is shorter and it reads perfectly.

It fails on the first table a later unit adds. A-FIRST-08 adds attribution columns; A-FIRST-09 adds the rollup
writer; A-MEAS adds the egress ledger. A table added to this schema and not to that function is retained for
ever, the pass reports success every night, and the symptom arrives as disk pressure months later with nothing
connecting it to the commit that caused it. The generic-statement-plus-policy-row shape has the opposite
failure mode: the pass stops, loudly, naming the table, on the first night after the migration lands.

The weaker version of the same alternative is the one docs/03 currently is: a sentence saying retention is 90
days. A documented policy with no job is not retention. This build has the matching precedent in
`agent_definition` — a cron with no agent row is a cron nobody watches — and both crons here carry one.

There is one more alternative worth naming because it is the tidier-looking one: **a registry table of
partitions**, written by the creation pass and read by the retention pass, so nobody has to parse a bound
expression. It is rejected because it is a second statement of what `pg_inherits` already says, and the two
drift the moment a partition is created or dropped by anything but the pass — which includes every fixture in
`packages/db/src/analytics.itest.ts`. The acceptance line's own words are that idempotence is "asserted
against pg_catalog rather than by return value"; a registry would be a return value with a table around it.
The cost of that decision is stated below.

### On the default partition: a guard on the parent, or an automatic creation

The first design was a `BEFORE INSERT` trigger on the partitioned parent that refused a row whose month had
no partition. **It cannot work, and this was measured rather than reasoned about.** On PostgreSQL 16 a row
inserted into a partitioned parent is ROUTED FIRST and the trigger then fires on the partition it landed in —
`tg_relid` is the partition, never the parent. So when no partition covers the row, tuple routing raises
`23514 no partition of relation "event" found for row` before any trigger of ours has run. The guard is
unreachable code on exactly the day it is needed, and it would have shipped green: every test that inserts
into a month that *does* exist passes, because the clone on that partition fires and finds a partition.

A statement-level trigger fires on the parent, but it cannot see the row, so it cannot say which month is
missing — and the only useful thing it could do is run `ensure_partitions`, which puts DDL and an
ACCESS EXCLUSIVE lock on the ingest path to solve a problem a nightly cron already solves three months in
advance.

So the choice was between `23514` and a default partition. `23514` names neither the cause nor the remedy: a
caller cannot branch on it (it is `check_violation`, which every CHECK in the schema raises) and a person
reading it has to know that this table is partitioned, that partitions are created monthly, and which function
does it. That is an error nobody reads, which is the failure the unit brief names.

0005's objection to a default partition is about rows accumulating somewhere nothing prunes. Here the trigger
refuses every row, so the objection is answered by construction rather than argued with: the partition is
permanently empty, `analytics.itest.ts` asserts it is empty *and* asserts the trigger that keeps it so, and
`run_retention` reports it as `guarded_default_partition` so a pass that stopped looking at it is visible in
the output.

## The consequences somebody has to live with

- **A partition's upper bound is parsed out of text.** PostgreSQL 16 exposes bounds only as
  `pg_get_expr(relpartbound, …)`, so `analytics.partition_bounds` pattern-matches
  `FOR VALUES FROM ('…') TO ('…')`. A parser that stopped matching would make every partition look
  un-droppable and the pass would report success having dropped nothing — the defect class this build has paid
  for most. So an unreadable bound raises `ZY064` and stops the pass; it is never skipped. If a future
  PostgreSQL changes that rendering, this is the thing that breaks, and it breaks loudly.
- **`analytics.event` is append-only for every role but `berelax_retention`, and the refusal tests
  `current_user` by NAME.** `pg_has_role` answers true for a superuser, and `berelax` is one, so a privilege
  test would never bite the role the application actually connects as. The consequence is that a legitimate
  correction — and there will be one — requires `set role berelax_retention` rather than an UPDATE, and any
  suite that needs to remove an event has to say so deliberately or roll its transaction back.
- **The triggers are declared on the partitioned parent** so PostgreSQL clones them onto every partition,
  including ones a cron creates years from now. That is what makes `delete from analytics.event_2026_09`
  refused too. It also means a partition ATTACHED from outside gets the clones, which is right, and that a
  partition DETACHED keeps them, which is harmless because the pass drops it immediately.
- **`funnel_step` is deliberately not append-only**, and the contrast has to be maintained rather than
  tidied: an event is evidence of something a browser did, and a funnel step is derived, so a corrected
  derivation has to be able to replace it. A unit that copies the `event` triggers onto `funnel_step` makes
  A-FIRST-09's re-materialisation impossible.
- **Every base table added to this schema from now on needs a policy row in the same migration.** That is one
  more line in a file that already has one, and the cost of forgetting it is a red nightly job rather than a
  silent retention hole — which is the trade this record is making.

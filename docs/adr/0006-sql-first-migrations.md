# ADR 0006 — SQL-first migrations, Drizzle for queries, drift gated

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F04

## Context

[Decision 3](../01-scope-and-decisions.md) chose Drizzle for its SQL-first character. F04 had to
decide whether schema changes are *generated* by `drizzle-kit` from TypeScript definitions, or
*written* as SQL with the TypeScript kept as a mirror.

The spine needs: `EXCLUDE USING gist` exclusion constraints, range partitioning with a partition-
creating function, generated columns, `DO` blocks, `CREATE RULE`, and domains. Some of these an
ORM cannot express; the rest it expresses awkwardly, and the generated output is what ends up
running against production.

## Decision

**Migrations are hand-written, numbered SQL** in `packages/db/migrations/`, applied in lexical order.
**Drizzle definitions are a hand-written mirror** used for type-safe queries, never to generate DDL.

To stop the mirror rotting, `pnpm db:drift` compares the Drizzle definitions against the live
database in **both directions** — a column in Drizzle the database lacks (the query would fail at
runtime) and a column in the database Drizzle lacks (a migration whose mirror was forgotten). It runs
in `pnpm verify` and CI, and has its own known-bad fixture per [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md).

## What the database now enforces, rather than the application remembering

- **Singletons** — `legal_entity` and `premises` use `id smallint primary key default 1 check (id = 1)`.
  Declarative, untriggerable, and the intent is visible in the schema. An earlier draft used a trigger;
  it was nonsense and was removed.
- **`crosses_midnight`** is a *generated* column on `premises_hours` (`close_time <= open_time`), so
  no caller can disagree about whether 11:00–02:00 crosses midnight.
- **`audit_event` is append-only** via `CREATE RULE ... DO INSTEAD NOTHING` for UPDATE and DELETE.
  Discipline is not a control; this is.
- **`audit_event` has no DEFAULT partition, deliberately.** If `ensure_audit_partitions` stops
  running, inserts *fail loudly* rather than pooling in a partition nobody prunes. A silent audit gap
  is worse than an outage.
- **Exactly one regulatory profile in force**, via a partial unique index on `superseded_at is null`.
  "The profile in force" is therefore never ambiguous.
- **`outbox_event.idempotency_key` is unique**, so an at-least-once delivery cannot fire an effect
  twice.
- **`outbox_event_unpublished_idx` is partial** (`where published_at is null`), so the worker's scan
  stays small forever as the table grows.

## `uuid_generate_v7`

Postgres 16 has no built-in v7 generator, so migration 0002 implements one. v7 over v4 for index
locality: the leading 48 bits are the millisecond timestamp, so inserts append rather than scatter.

Honest limitation, asserted by the test rather than glossed: **this implementation adds no monotonic
counter**, so values are ordered at millisecond granularity and are *not* monotonic within a single
millisecond. The test asserts the real guarantee — the timestamp prefix never goes backwards — after
an earlier version wrongly asserted full sort order and failed.

## pg-boss

pg-boss owns and migrates the `pgboss` schema itself, so it is deliberately **not** part of the SQL
chain. It is instead **asserted present by an integration test**, so a deployment cannot come up
without a queue. Retention is a *per-queue* option in pg-boss 12, not a constructor option, so
`DEFAULT_QUEUE_OPTIONS` is applied at `createQueue` time — seven days of completed-job history,
because when a client says a reminder never arrived the job row is the evidence.

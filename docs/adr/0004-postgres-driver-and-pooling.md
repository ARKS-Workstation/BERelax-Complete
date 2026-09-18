# ADR 0004 — postgres.js with prepared statements disabled

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F02

## Decision

`postgres` (postgres.js) as the driver, with **`prepare: false`**, and `bigint` parsed as a string.

## Why `prepare: false` is not optional

DigitalOcean Managed PostgreSQL fronts the database with PgBouncer in **transaction pooling** mode.
Server-side prepared statements do not survive between statements in that mode. Enabling them works
perfectly in local development and fails in production — the worst possible shape of difference, and
one that surfaces under load rather than in a test.

## Why `bigint` is parsed as a string

Money is integer fils and the analytics event table will exceed 2^53 rows over time. The default
driver behaviour hydrates `bigint` into a JS `number`, which loses precision silently. A silent
rounding error in a financial column is not acceptable, so `bigint` crosses the boundary as a string
and is converted deliberately.

## What F02 proved, rather than assumed

`packages/db/src/postgres.itest.ts` runs against a real PostgreSQL 16 and asserts:

- server version ≥ 16
- `btree_gist`, `pgcrypto`, `pg_trgm` and `unaccent` are all available
- `timestamptz` at `Asia/Dubai` renders `22:30Z` as `02:30` the following day — the after-midnight
  case the business day must handle, given trading runs to 02:00
- **a `btree_gist` exclusion constraint on `(therapist_id, period)` rejects an overlapping range,
  accepts a back-to-back range because `tstzrange` is half-open `[)`, and accepts the same period for
  a different therapist**

That last group is the entire no-double-booking guarantee of the availability engine, proven in F02
rather than discovered in B-AVAIL.

## Note on the environment

Docker was unavailable in the build environment (client installed, daemon not running), so local
integration tests run against the machine's own PostgreSQL 16 cluster via `pg_ctlcluster`.
`docker-compose.yml` remains the documented path for developers, with the cluster fallback recorded
in its header comment. CI uses a GitHub Actions service container and is unaffected.

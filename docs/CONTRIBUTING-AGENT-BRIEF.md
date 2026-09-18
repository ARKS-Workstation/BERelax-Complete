# Brief for a unit implementation

Read this before touching anything. It is the whole convention set, and every point in it has already
caught a real defect in this repository.

## The rules

1. **`pnpm verify` is the only arbiter.** A unit is done when it passes, never on assertion. Run it.
   Start PostgreSQL first: `pg_ctlcluster 16 main start`, then export
   `TEST_DATABASE_URL="postgres://berelax:berelax@127.0.0.1:5432/berelax_test"` and `DATABASE_URL` to
   the same value.

2. **Every gate needs a known-bad fixture** (ADR 0003). If you add a check, add a case to
   `scripts/test-gates.mjs` that deliberately breaks it and asserts it fails. A passing check that has
   never been seen to fail may not be a check at all — TypeScript 7 once reduced `pnpm boundaries` to
   zero modules while reporting success.

3. **A test must not be able to pass vacuously.** Pair each assertion with a control that must fail.
   If you assert "X is correct", also assert that the deliberately wrong X is detected.

4. **Module boundaries are enforced.** `packages/core` is pure: no I/O, no clock, no `process`, no
   framework, and it may import `@berelax/shared` only. `packages/db` must never import
   `packages/core` — the dependency runs the other way. Put calculations in `core` and writes in `db`.
   `packages/fixtures` may depend on both, which makes it the right home for a test that exercises the
   pair.

5. **SQL-first migrations** (ADR 0006). Write the `.sql` by hand in `packages/db/migrations/`, apply it
   to `berelax_test` and `berelax_dev` with `psql`, then update the Drizzle mirror in
   `packages/db/src/schema/`. `pnpm db:drift` compares them both ways and will fail if they disagree.
   Bump `SCHEMA_VERSION` in `packages/db/src/index.ts`.

6. **Money is integer fils, VAT-inclusive gross authoritative** (ADR 0007). VAT is derived as
   `gross - net` so `net + vat === gross` exactly. Never a float. Use `aed()` for literals and
   `aedFrom()` for runtime values.

7. **Time is `timestamptz`, the zone is always an argument**, and `business_day` is first-class:
   trading runs 11:00–02:00, so 01:30 belongs to the *previous* trading date. Use
   `resolveTradingDate` from `@berelax/core`.

8. **Comments explain why, not what.** Every non-obvious decision carries the reason and, where there
   is one, the specific failure it prevents. Do not write comments that restate the code. Do write the
   one that says why the obvious alternative is wrong here.

9. **Append-only tables exist** (ADR 0008): `audit_event`, `app_setting_history`, `regulatory_profile`.
   A test must assert a *delta*, never a total, and must not try to DELETE from them.

10. **No invented names of people.** Therapists have no display name until an admin sets one; customers
    are labelled `Customer 0042`. See `packages/fixtures/src/synthetic.ts`.

11. **Colours come from `@berelax/ui` tokens.** `pnpm colours` rejects a literal hex anywhere outside
    the token layer.

## Working

- Read the unit's entry in `build/manifest.yaml`. Its `acceptance` list is the specification: satisfy
  every line, and where a line is impossible because a dependency does not exist yet, scope it
  explicitly and add a `NOTE:` line to the manifest saying what was deferred and to which unit.
- Format with `pnpm exec biome check --write <paths>` before typechecking; Biome reformats, which will
  otherwise break a later string match.
- Do not mark the unit `done` in the manifest and do not commit. Report what you did and what
  `pnpm verify` said.

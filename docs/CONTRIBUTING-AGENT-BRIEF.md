# Brief for a unit implementation

Read this before touching anything. It is the whole convention set, and every point in it has already
caught a real defect in this repository.

## The rules

1. **`pnpm verify` is the only arbiter.** A unit is done when it passes, never on assertion. Run it.

   Start PostgreSQL with `pg_ctlcluster 16 main start`, then **create your own database** — several
   units are usually in flight at once, and a shared database means one unit's migration makes
   another's drift check fail:

   ```
   psql postgres://berelax:berelax@127.0.0.1:5432/postgres -c 'create database berelax_<unit> owner berelax'
   for f in packages/db/migrations/*.sql; do psql -q postgres://berelax:berelax@127.0.0.1:5432/berelax_<unit> -f "$f"; done
   export TEST_DATABASE_URL=postgres://berelax:berelax@127.0.0.1:5432/berelax_<unit>
   export DATABASE_URL="$TEST_DATABASE_URL"
   ```

   Apply your own migration to that database only.

   **Two things that will cost you a false failure when several units are in flight.** The integration
   suite drives the built web application, so run `pnpm --filter @berelax/web build` once in your
   worktree before `pnpm verify` — `.next` is gitignored and a fresh worktree has none. And the suite
   opens a 64-connection pool to prove a row lock under concurrency; if you see
   `sorry, too many clients already` or `ERR_CONNECTION_REFUSED`, another worktree was running the
   integration suite at the same time. Neither is yours. Re-run, and say so in your report rather than
   changing the test.

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

12. **The integration suite runs sequentially against ONE database, and earlier files leave rows
    behind.** A test that assumes it is the only row in a table passes until another unit lands and then
    fails on somebody else's branch. Three real cases, all of which were green for weeks:

    - `with-google.itest.ts` assumed it held the only Google connection. `resolveTarget` scans every
      connection serving a capability and orders by id — production behaviour, and why a consumer never
      has to know which account is wired up — so a completed consent left behind by `google-oauth.itest.ts`
      sorted first and won every test in the file. Isolate by narrowing what the code under test can
      *see* (that file disconnects the others), not by deleting rows a foreign key protects:
      `google_reviews.connection_id` is `ON DELETE RESTRICT`, and a `delete` there is a different false
      failure, not a fix.
    - `settings-store.itest.ts` read a **delta through a capped reader**. `settingHistory` takes a
      `limit`, `app_setting_history` is append-only so it only grows, and the first time a key passed
      500 rows both sides of the subtraction pinned at 500 — three recorded changes read as zero. Count
      in SQL. A limit is right for a panel and wrong for a count, and its sibling assertion had gone
      vacuous the same way.
    - `opening-balances.itest.ts` ensured the `legal_entity` **singleton** with an invented spelling of
      the legal name, reasoning that `on conflict do nothing` would discard it against a seeded
      database. It then ran against a database that predated the seed, won the race, and left the wrong
      registered name in the row every later suite reads — and that column is snapshotted onto every tax
      invoice. If you ensure a singleton, ensure it with the values the migration seeds.

13. **`pnpm gates:test` is not safe to interrupt.** One case mutates a shipped file in place and restores
    it in a `finally`; others write `__gate_fixture__` files into real source directories. Kill the
    wrapper and the `node scripts/test-gates.mjs` child is orphaned, not stopped — it goes on creating
    and removing fixtures in your worktree while the next run's `tsc` and `depcruise` read them, which
    surfaces as a failure in a package you never touched. If you must stop a run, find the orphan
    (`pgrep -f test-gates` plus `/proc/<pid>/cwd`, because its argv carries no path) and kill that too,
    then `git status` before believing anything.

14. **The scratchpad directory is shared with every other agent.** A file called `verify.sh` or
    `verify.log` there will be overwritten by somebody else's, and one agent has already relaunched
    another's script against another's database. Prefix every scratchpad filename with your unit.

15. **Do not invent a value that the real system will one day hold.** A plausible-looking TRN, licence
    number, legal name or address is worse than a blank one: blank is visibly unanswered, and plausible
    is indistinguishable from configured. Provisional values carry a marker the schema refuses
    (`is_placeholder_text`, migration 0026) and an `OPEN-QUESTIONS` id.

16. **Never wait on a `pgrep -f` pattern that appears in the waiting command itself.** `until ! pgrep -f
    "pnpm verify"; do sleep 10; done` never exits: the shell evaluating it has `pnpm verify` in its own
    argv, so `pgrep` matches that shell and the condition can never become true. `PID=$(pgrep -f "pnpm
    test:integration && …")` has the same defect and is worse, because the pid it captures is the
    waiting shell, so `tail --pid=$PID` waits on itself. Three of these have had to be killed by hand in
    this build, two of them still spinning in worktrees that had already been deleted. Redirect the run
    to a log with a sentinel (`sh -c 'pnpm verify > mine.log 2>&1; echo "VERIFY_EXIT=$?" >> mine.log'`)
    and wait on the sentinel's presence in the file, or identify the process by
    `readlink /proc/<pid>/cwd`, which cannot match your own shell by accident.

17. **`pnpm typecheck` runs two projects, and `pnpm verify` does not build the web application.** The
    root `tsconfig.json` cannot include `apps/web` — it needs `jsx: "preserve"`, DOM libs, the Next
    plugin and its own path map — so the web app is a second `tsc` invocation chained into the same
    script. That chaining is recent: before it, nothing typechecked `apps/web/app/**`,
    `apps/web/src/**` or any `.tsx`, and two wrong import depths passed `pnpm typecheck` and failed only
    in `next build`. One gap is still open and is stated in `tsconfig.json` rather than hidden:
    `.next/types/**` exists only after a build, so the generated route types are checked only when one
    has happened. If your unit adds a route, build the app once before believing a clean typecheck.

## Working

- Read the unit's entry in `build/manifest.yaml`. Its `acceptance` list is the specification: satisfy
  every line, and where a line is impossible because a dependency does not exist yet, scope it
  explicitly and add a `NOTE:` line to the manifest saying what was deferred and to which unit.
- Format with `pnpm exec biome check --write <paths>` before typechecking; Biome reformats, which will
  otherwise break a later string match.
- Do not mark the unit `done` in the manifest and do not commit. Report what you did and what
  `pnpm verify` said.

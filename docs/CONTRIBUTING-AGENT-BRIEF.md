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
   export APP_ENV=test
   pnpm seed
   ```

   Apply your own migration to that database only.

   **Those last two lines are not optional and both have cost a whole run.** `.github/workflows/ci.yml`
   sets `APP_ENV` for the workflow, so CI never sees its absence; a local run without it gets
   `AppError: Invalid configuration — APP_ENV: Invalid option`, the built web application answers 500 to
   every request, and it presents as about 56 failing tests across six files nobody touched. And without
   `pnpm seed` the database has its tables and no fixture salon, so `packages/hr/src/employee.itest.ts`
   fails on "the therapist rows the seed creates ... 19 of them" and `availability-perf.itest.ts` fails
   its answer-shape assertions — neither failure mentioning seeding. Seed before running anything: the
   seeder is idempotent per table, so a suite that has already inserted a consent row makes it skip that
   table and leaves the database half seeded.

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


    **After a merge that touches `apps/web`, build BEFORE the integration suite.** `next start` serves
    whatever `.next` was last built, so a route added on a branch is a 404 in a merged tree nobody built,
    and the symptom names neither the merge nor the build: `expected 404 to be 303` from a route whose
    source is right there, a route-spine case failing on a route the registry declares, and a client bundle
    still holding the dependency a merge was supposed to remove. It cost an integration stage on the
    five-unit merge — 38 failures across three files, none of them a defect. `pnpm --filter @berelax/web
    build` first, then verify.
18. **A server-starting suite draws its port from `@berelax/harness/ports`, never from arithmetic.**
    A band added to `TEST_PORT_BANDS` in that module, and claimed by `startWebServer({ suite: 'your-suite' })`
    — see rule 19 — or by a bare `testPort('your-suite')` if you need the number without a server. Do not
    write `4700 + Math.floor(Math.random() * 300)`, and do not put a literal port in an
    `http://127.0.0.1:` URL.

    The scheme this replaced was each suite choosing a band and listing its neighbours' in a comment.
    By the eleventh suite three pairs were sharing one — `kitchen-sink` with `breakpoint-preview`,
    `primitives` with `messages-inbox`, `hero-lcp` with `content` — and `hero-lcp.itest.ts` had written
    two of the three overlaps into its comment as if they were the arrangement. A shared band does not
    present as a port bug: the second `next start` cannot bind, exits, and the suite's own
    wait-for-server loop then answers from the **first** one's server, so the assertions run against
    another worktree's build and the run reports on code the file under test does not contain. Green
    means nothing and red means nothing, in either direction.

    `packages/harness/src/ports.test.ts` proves the bands are disjoint, below the ephemeral range and
    wide enough; `apps/web/src/test-ports.test.ts` proves no suite picks a port for itself and that
    every band has exactly one claimant — so a band you declare and do not use fails, as does a band
    you use and do not declare.

19. **A suite starts the application with `startWebServer` from `@berelax/harness/server`, never with
    its own `spawn`.** It owns three things a suite kept getting wrong separately, and each one cost a
    real run:

    - **The temp root.** Next writes its server-side module cache under `os.tmpdir()` and removes
      nothing. Neither did any suite. One `pnpm verify` left twelve directories of about 5.7 MB behind,
      and a session of agents each running verify repeatedly left **10,539** of them — 25 GB. That does
      not present as a test-harness bug: it presents as `ENOSPC` in whatever unrelated command runs next,
      and twice as a container that stopped. `startWebServer` creates the root, points `TMPDIR` at it, and
      `stop()` removes it once the child has exited.
    - **The port.** `testPort` *draws* at random inside the band; `startWebServer` *acquires* — it binds a
      candidate and releases it before `next start` gets it, and draws again if the child still dies with
      `EADDRINUSE`. The band comment's "under a percent" is true for one pair of runs and false for four
      worktrees each running all twelve suites, where a collision arrives often enough to be filed as a
      flake.
    - **The failure message.** Three of the twelve used `stdio: 'ignore'`, so a collision arrived as
      `next start exited with 1` with the child's own explanation discarded. Every throw now carries the
      captured output, and the ownership check — a reachable port plus a dead child is another worktree's
      application answering for this one — is made for all twelve rather than for the six that remembered.

    `apps/web/src/test-ports.test.ts` refuses a suite that spawns `next start` itself, and that check found
    a twelfth suite one directory down the moment it was written. `packages/harness/src/server.test.ts`
    covers the parts whose being wrong would make the retry silently do nothing.

20. **A gate case that edits a shipped file anchors on something unique.** Use `replaceOnce` in
    `scripts/test-gates.mjs` rather than `String.replace`, which takes the first match silently. Three
    cases have now edited the wrong construct — `const required = [` and `'canonical',` each appear twice
    in their files — and every one then reported PASS about a file that still contained what the case meant
    to remove. `withEditedFile`'s no-op guard cannot catch it, because the edit does change something.

21. **A correctness test must not carry an implicit performance budget.** `vitest.config.ts` declares no
    `testTimeout`, so every test inherits 5,000 ms. A property test with hundreds of cases, or a paging
    test over tens of thousands of rows, needs an explicit `}, 30_000)` and a comment saying why. Four
    files have now failed on this, each one under coverage on a loaded machine and each one passing in
    about two seconds alone — so the failure names the wrong thing and costs a two-and-a-half-hour verify.

22. **A property test's generator has to be able to exercise the claim, and the test has to count that.**
    `resolveConsent`'s order-independence property generated a record set whose channel, purpose and
    instant each had to match: uniform thirds put the expected count of *applicable* records at 0.37, so
    most generated sets had fewer than two and no permutation could change the answer. The property held
    for a completely order-dependent resolver about one run in eight, and the visible symptom was a gate
    case reporting a rule as missing. Weight the generator towards inputs that can disagree, count how
    many of the generated cases actually could, and assert that count against a floor you have MEASURED —
    a floor set just under the observed minimum becomes its own flake.

23. **A wall-clock assertion measures the machine, not the code.** Where an acceptance line names a
    latency it also names where — "on the CI Postgres" — and this container is not that. Assert the WORK
    instead wherever the claim allows it: statements issued, rows read, round trips. Where the absolute
    figure has to stay, gate it on a signal that says whether the machine can hold it, skip loudly with
    both numbers when it cannot, and put that message on **stderr** — vitest's reporter shows a test's
    stdout only when the test fails, so a `console.log` in a passing or skipped test is invisible.

24. **A fresh database needs three steps, not two.** Create it, apply
    `packages/db/migrations/*.sql` in order, and then `pnpm seed`. Without the seed,
    `packages/hr/src/employee.itest.ts` fails on "the therapist rows the seed creates ... 19 of them" and
    `availability-perf.itest.ts` fails its answer-shape assertions, and neither failure mentions seeding.
    Seed before any suite runs: the seeder is idempotent per table, so a suite that has already inserted a
    consent row makes it skip that table and leaves the database half seeded.

25. **Use a fresh, uniquely-named log file for every verify run, and end it with a sentinel.** `rm`
    unlinks but a running process keeps writing to the old inode, so a reused path hands you a previous
    run's result. Write `echo "VERIFY_EXIT=$?" > "$LOG.done"` and read the sentinel, not the tail. Twice
    in one session a stale log was read as a live one, once as a 40-minute-old suite mistaken for a
    current run.

26. **Never `pkill` by pattern.** Several worktrees run the same commands at once; filter by
    `readlink /proc/<pid>/cwd` so you only stop your own. A blanket `pkill -f test-gates.mjs` killed
    another unit's run mid-`withEditedFile` and left a mutated shipped file behind in its worktree — the
    exact hazard rule 13 is about, inflicted from outside.

## Working

- Read the unit's entry in `build/manifest.yaml`. Its `acceptance` list is the specification: satisfy
  every line, and where a line is impossible because a dependency does not exist yet, scope it
  explicitly and add a `NOTE:` line to the manifest saying what was deferred and to which unit.
- Format with `pnpm exec biome check --write <paths>` before typechecking; Biome reformats, which will
  otherwise break a later string match.
- Do not mark the unit `done` in the manifest and do not commit. Report what you did and what
  `pnpm verify` said.

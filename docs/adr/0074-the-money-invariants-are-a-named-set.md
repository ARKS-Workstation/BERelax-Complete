# ADR 0074 — the money invariants are a named SET, and a claim that stops being examined fails the build

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** M-VAT-13
- **Covers:** docs/01 decisions — none; this is a build-process decision about the money estate
- **Supersedes nothing. Applies to money:** [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md),
  and rests on [ADR 0002](0002-typescript-6-not-7.md), [ADR 0007](0007-money-and-business-day-primitives.md),
  [ADR 0008](0008-unit-of-work-and-exactly-once-per-handler.md),
  [ADR 0017](0017-accounting-journal-and-no-auto-filing.md) and
  [ADR 0023](0023-gapless-numbering-row-locked-counter.md)

## Context

Seven claims decide whether this build's books are worth anything, and M-VAT-13's first acceptance line
names them: the ledger always balances, the VAT gross/net round-trip is exact at the fils, no UPDATE or
DELETE reaches `journal_line`, the statutory numbering is gap-free, the package liability ties to `2050`,
a cash session is keyed on its business day, and the VAT201 box partition is exhaustive.

Every one of them was already proved, and each in the only place it can be. `net + vat === gross` is a
property over generated amounts in a pure test. `UPDATE on journal_line raises ZL001` can only be shown
against real PostgreSQL, because the rule is a trigger plus a revoke. The exhaustive partition needs a
closed period with documents behind it. They live in nine files across three packages and two runner
configs, and that spread is correct — it is where the rules are.

What was missing is that **nothing said the seven are a set.** Each test was reachable only through a
GLOB: `packages/**/*.test.ts` and `packages/**/*.itest.ts`. Delete one, rename it, or wrap it in
`describe.skip`, and the run is one test shorter out of about 7,600 — with nothing anywhere saying which
of the seven claims had stopped being made. That is exactly the shape ADR 0002 records (`pnpm boundaries`
reporting success over zero modules) applied to the claims a tax authority asks about, and it is the one
place in this build where a silently reduced check is a filed return.

## The decision rejected first, with the measurement that rejected it

The obvious design, and the one this unit built and threw away, is a **census**: one script that re-adds
every money identity in SQL over every row the database holds, so a violation is caught wherever it came
from. It was written, it ran, and it is not in this commit. Three findings killed it, and all three are
worth recording because the next person will have the same idea.

1. **It is a second statement of every rule it checks.** `0026_invoice.sql` already argues the general
   case, at length, against a generated `vat_total`: "The half-up rounding rule has one definition, in
   core, and a plpgsql re-implementation would be a second — with the disagreement surfacing on a
   document that has already been filed." A census in a third language is that objection one layer out.
2. **A census over the test database measures the SUITES, not the books.** Measured on a database
   migrated, seeded and then driven through 41 money integration files: the census reported
   `NumberingGap: bill series SUPP-BILL period "" has a run of 44 starting at 5` and
   `PackageLiabilityDoesNotTieTo2050: balances hold 0 fils unreleased and 2050 holds 733,337 fils from
   the package path`. Both are true of that database and neither is a defect in the code. `journal_line`
   and `bill` are append-only in different degrees: a suite that removes its own `package_balance` and
   `bill` rows cannot remove the entries it posted, so the committed estate is inconsistent by
   construction. A gate that fails on every verify run is not a gate.
3. **And where the estate is consistent it is EMPTY.** The same measurement: a migrated and seeded
   database holds zero `journal_entry`, zero `invoice`, zero `package_balance` and zero `cash_session`
   rows, because every money suite plants inside a transaction it rolls back — which is the correct
   convention for append-only tables, and leaves a census with nothing to examine. ADR 0002 again: a
   check that examined nothing is worse than one that failed.

## Decision

The money invariant suite is a **registry of the existing tests**, not a new suite.

`MONEY_INVARIANTS` in `vitest.integration.config.ts` names the seven claims. Each carries the acceptance
line's own words for the claim, the ONE statement the rule rests on, and one or more tests — each a
`{ config, file, nameContains }`, where `nameContains` is a clause of the test's own name.

`pnpm money-invariants` (`scripts/money-invariants.mjs`) is a step of `pnpm verify` and of
`.github/workflows/ci.yml`, registered in `scripts/test-gates.mjs` case 29, and it refuses three things:

- **`[money-invariant-unresolved]`** — a registered file is not on disk, or no longer contains its marker
  clause. A file read, so a renamed test costs a second rather than the suite.
- **`[money-invariant-failed]`** — a runner exited non-zero. The claim is stated and it is false.
- **`[money-invariant-examined-nothing]`** — everything ran, every runner exited zero, and ZERO **passed**
  tests matched some marker.

### Why the count comes from the runner's report and not from the source

The third refusal is the one the other two cannot reach, and it is the reason this is a runner rather than
a lint. `describe.skip`, `it.todo`, `it.skipIf` and a `beforeAll` that returns early all leave the marker
clause in the file and the exit code at zero. The first version of this check was a grep for the clause
and passed over every one of them. Measured: a `--reporter=json` run with the round-trip property skipped
reports `status: "skipped"` for `splitGross — properties net + vat === gross, …`, so the count is taken
from `assertionResults[].status === 'passed'` and a skipped claim is a failing build.

### Why the registry lives in the integration config

That file already decides what the integration suite IS. A separate module listing test files would be a
second answer to that question, and the money set is a subset of this one — so the day a money file stops
matching `include`, the registry is read beside the glob that no longer covers it. Each entry names its
config, because a unit file handed to the integration runner matches nothing and vitest reports "no test
files found" — a message about the runner, which would have been read as a claim that was still fine.

### And the coverage floors, which are the other half of "exact at the fils"

Three of the seven rules are stated in `packages/core` and deliberately NOT restated in SQL: the half-up
rounding rule, the release formula's complement, and the expected-float expression. A registry that says
those tests ran says nothing about how much of those modules they reach. `vitest.config.ts` therefore
grows four threshold groups — `packages/core/src/ledger/**`, `packages/core/src/money.ts`,
`packages/core/src/money/**` and `packages/core/src/tax/**` — at 95% lines and 90% branches each, the
figures the acceptance line names.

They are separate from the existing `packages/core/src/**` group because an aggregate hides a small
module inside a large one: these are about 900 statements of a 6,500-statement package, so all four could
fall to 70% without moving the package figure past its floor. Only lines and branches are declared, and
that restraint is deliberate — vitest computes each glob group independently and the global thresholds
over everything, so statements and functions are still held by the existing group, and `money.ts`
measures 95.45% on functions today: a 95% function floor here would fail the build on one more uncovered
function, on a dimension the acceptance line does not mention. Measured when written: ledger 100.00%
lines / 97.24% branches, `money.ts` 98.18/100.00, `money/` 98.99/96.92, `tax` 98.23/93.90.

## The gate-fires fixtures

`scripts/test-gates.mjs` block `152a-152z`, and the groups are four because each fails in a way the
others cannot see:

| Cases | Fixture | Refusal required |
|---|---|---|
| 152a-152g | one marker clause per invariant re-pointed at a name no test has | `[money-invariant-unresolved] <ID>` |
| 152h | a claim's id renamed out of the registry | `[money-invariant-registry-incomplete]` |
| 152i | an invariant registered with no test at all | `[money-invariant-unresolved]` |
| 152j | a registered file that is not on disk | `[money-invariant-unresolved]` |
| 152k | the round-trip property wrapped in `it.skip` | `[money-invariant-examined-nothing]` |
| 152l | `postEntry`'s balance refusal blinded | `[money-invariant-failed]` |
| 152m-152s | the ONE statement of each rule broken, one at a time — six by a file edit, one in the database | the named test, by name |
| 152t | a coverage run that did not exercise the money modules | each of the four groups, by name |
| 152u-152w | the step out of the chain, out of case 29, out of the workflow, or ahead of the database | the order check, with its own control |
| 152x | a `packages/` path the registry names that is not on disk | the path scan, with a planted path |
| 152y-152z | the controls: the runner over all nine registered files unedited, and every coverage glob shown to match real source | — |

**152o is the one case in the block that is not a file edit**, and it is worth stating why. `no UPDATE or
DELETE on journal_line` is `refuse_journal_change()` plus a revoke, applied to the database by migration
0018 — there is no source line whose breaking would show it. So the fixture DISABLES
`journal_line_no_update` in the test database, runs `journal.itest.ts`, requires its named test back, and
re-enables the trigger in a `finally`. `tgenabled` goes to `'D'` and the trigger stays in the catalogue,
which is also why a check that merely asked whether the trigger EXISTS would have passed. The cost is
brief rule 13's hazard, stated in the case: if a run is killed between the two statements, the recovery is
`alter table journal_line enable trigger journal_line_no_update`.

## What is NOT built, and it is two clauses of the acceptance list

Both are recorded as `NOTE:` lines on the unit, and neither is smoothed over.

1. **"a deliberately failing money invariant is shown once to turn the workflow red, with the run
   recorded in the ADR".** A unit agent may not push, so no GitHub Actions run exists to record and a run
   id written here would be a plausible figure nothing stands behind (brief rule 15). What IS recorded is
   the local measurement of the identical step the workflow runs — `pnpm money-invariants` with the
   round-trip property skipped exits 1 with
   `[money-invariant-examined-nothing] VAT_ROUND_TRIP`, and with `postEntry`'s refusal blinded exits 1
   with `[money-invariant-failed]` — both of which are gate cases 152k and 152l, so they are re-measured
   on every verify rather than quoted from this document.
2. **"every M-TILL and M-VAT unit is marked done only from CI status, never by assertion".** The first
   half of that line is already true and was before this unit: `docs/PROGRESS.md` is regenerated from
   `build/manifest.yaml` by `scripts/progress.py` and `pnpm progress:check` holds the two equal on every
   verify. The second half needs a CI status feed — a workflow conclusion recorded against a unit id —
   and no unit in the manifest owns one: F02, H05 and H-HARD-02 are the CI units and all three are
   finished. So the clause stands unbuilt rather than approximated, and the NOTE says a new unit is
   needed for it.

## Cost

One more step in a 45-step chain, at about a minute — 54 s on a quiet container and 85 s with three other
worktrees verifying: three unit files and six integration files, all nine of which `pnpm test:integration`
and `pnpm coverage` already ran. That duplication is the price of the claim —
a named step whose removal `pnpm gate-registry` refuses, where a glob's silent shrinkage cost nothing.

The other cost is a real one and falls on whoever renames a test: `nameContains` is a whole clause, not a
word, because a word keeps matching a test that has been rewritten to assert something else. Renaming one
of the thirteen marked te
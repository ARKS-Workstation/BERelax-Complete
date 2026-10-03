# ADR 0106 — a dry run is a FRESH database, a recorded run carries its own digest, and the gate must be able to refuse one

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-MIG-09
- **Covers:** docs/01 decisions — none new. It is the rehearsal-shaped consequence of
  [ADR 0105](0105-a-reconciliation-report-is-a-reading-and-a-variance-is-named-or-it-fails.md) (the report
  is a reading, its instant is outside the compared content, and a variance is named or it fails) meeting
  [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md) (a gate that has never been seen to fail may
  not be a gate) and [ADR 0061](0061-an-import-is-resumable-per-row-and-provenance-is-a-reference.md)'s
  non-idempotent, numbered migrations. It records WHY three of the five real importers are not rehearsed
  and what each one is waiting for.

## Decision

**Four things.**

1. **A dry run means a database created from nothing.** `scripts/migrate-dry-run-full.mjs` creates a
   throwaway database, applies every migration in order, seeds, imports, reports, runs the invariant
   census over the result and drops the database. There is no resume path and none was added:
   `scripts/apply-migrations.mjs` already refuses a non-empty database and its header says why — the
   migrations are deliberately not idempotent, there is no applied-migrations table to consult, and the
   one attempt at tolerating a second run reported a half-applied migration as a skip.

2. **A recorded run is a FILE that carries its own sha-256.** `artifacts/migration/run-N.json` holds
   `{ runNumber, generatedAt, contentDigest, report, importersRun, importersNotRun, postImportChecks }`,
   and `pnpm dry-runs` recomputes the digest over the stored report.

3. **Three recorded runs, every one clean, consecutive runs differing only in a REMINTED key.** The
   reminted list is two names long — `runId` and `recordId` — and is matched by name, never by shape.

4. **Three importers are not rehearsed and the recorded run SAYS SO**, each with the open question that
   blocks it: `packages` (Y8-packages), `appointments` (Y8-visits), `staff` (Y8-staff) and
   `opening-balances` (Y8-opening-balances). A dry run that ran no importer at all is refused by name.

## Why the digest is stored beside the report, which is the non-obvious one

A recorded run is a file in the repository. Every figure in it can therefore be edited by hand, and the
one edit nobody would notice is `unexplainedVariances` from 1 to 0 — the single figure this whole gate
turns on. Nothing about the file's appearance would change, the gate would go green, and the evidence that
the migration had been rehearsed would be a number somebody typed.

So the digest is a sha-256 over the report's canonical form, stored beside it, and
`checkRecordedRun` recomputes it. Changing a figure without recomputing the digest fails the build, and
recomputing it means running the driver, which means performing the import. That is the only arrangement
in which "the artefact says it was clean" and "it was clean" are the same claim.

It works only because ADR 0105 put the run instant OUTSIDE the report: a digest over content that included
`generatedAt` would be unique per run and could not be checked against anything.

## Why the reminted field list is two names and not a shape test

A fresh database remints every surrogate key — `uuid_generate_v7()` embeds the millisecond it ran in — so
two runs over identical files differ in every id and in nothing else. A diff that reported those would
report every run as different from every other, after which the only way to use it is to stop reading it.

The version that suggests itself is "excuse anything that looks like a uuid or a hash", and it is wrong in
the direction that matters: `sourceFileHash` and `contentHash` are also opaque hex, and they are the two
values whose CHANGING is the most important thing this diff can report — a source file that is not the
file the last run imported, or a row whose content moved. A shape test would quietly excuse both, so the
list is two NAMES and `diff.test.ts` asserts neither hash is in it.

A path present in one run and absent from the other is material **even when its field name is reminted**:
a quarantine row that appeared is not a reminted key.

## Why the gate is stricter than its acceptance line, and why the diff reuses the renderer's walk

The acceptance line asks that *the latest* report hold no unexplained variance. Every recorded run has to,
and the reason is that the third acceptance line asks for a report DIFF: a set in which run 1 failed and
runs 2 and 3 passed is a set in which something changed between them, so the diff would be comparing two
different states while reporting on one migration. A run that failed is evidence, and it belongs in the
history of the thing that was corrected rather than in the three the gate reads.

`diffReconciliationReports` walks the report through `reportFigures` — the same traversal the human form is
rendered from. A diff with a traversal of its own would be a second statement of the report's shape, and
the first field it failed to reach would be a field no diff could ever report a change in.

## What is NOT rehearsed, and why inventing it would be worse than saying so

Three real importers and the opening trial balance are not run, and the recorded run names each with its
open question. Each one needs a human act, not a file:

- **`packages`** needs the owner's sign-off: who signed, the cash actually received, the opening date and
  the statement accepted. `import_sign_off_reconciles_to_the_cash_received` refuses a signature whose
  figures do not tie, so a synthetic sign-off would have to carry an invented attested cash figure — in a
  committed artefact, indistinguishable from a measured one (ADR 0069, brief rule 15).
- **`appointments`** needs the previous arrangement's visit history, every line of which must resolve to a
  therapist, a room and a service in THIS catalogue or be quarantined by name (ADR 0082). A generated
  history would be a reconstruction of visits nobody made.
- **`staff`** needs real staff references, genders and leave opening balances, and the leave year anchor
  has no default on purpose (ADR 0083): a generated one decides which leave year somebody's carry-over
  forfeits in.
- **`opening-balances`** needs the trial balance somebody checks against the books being copied from, and
  attesting it LOCKS the database behind its boundary for ever (ADR 0084).

A dry run that silently covered two importers out of five would report "no unexplained variance" about a
migration nobody has rehearsed, and it would read exactly like one that imported the real files cleanly.
So the absence is DATA — `importersNotRun`, in every recorded run — and `check-dry-runs.mjs` prints it.

## What this costs

- **The corpus is synthetic and that is stated in every recorded run.** It is generated in full from
  `packages/fixtures` (`syntheticPerson`, `buildContactList`), so no figure in a committed run is a claim
  about this business, and every nonce in it is a CONSTANT rather than a clock reading — the opposite of
  the integration suites' convention, and for the opposite reason: they run against a shared database
  where a fixed fixture collides with the last execution's rows, and this runs against a database that
  did not exist a second ago. A clock reading would change the source bytes between runs, after which run
  N+1 could not be compared with run N at all. Gate case 184m is the scan that refuses one.
- **The restore-drill half of the first acceptance line is DEFERRED to H-HARD-04**, which owns
  `scripts/restore-drill.mjs` and the ephemeral-Postgres harness, and is `todo`. This driver creates its
  clean database by applying every migration from nothing rather than by restoring a backup, which is a
  clean database by a different route and is the route available today; the words "from the restore-drill
  artefact" cannot be satisfied by a file that does not exist. Running the driver as a CI step is deferred
  with it, for the same reason: `pnpm dry-runs`, which reads the committed evidence and needs no database,
  is what CI runs.
- **No migration, no private SQLSTATE and no test port band.** Everything here reads: the driver writes
  only into a database it created and drops, and the gate reads files. The band **ZY731–ZY740** was not
  allocated and none is used; migration numbers are untouched, `SCHEMA_VERSION` is unchanged and no
  migration-ledger paragraph was added. The port band `{ start: 22_700, width: 300 }` is released with
  H-MIG-08's.
- **One new `pnpm verify` step, `pnpm dry-runs`**, registered in gate case 29's array and in
  `.github/workflows/ci.yml` in the same commit, beside the schema gates.

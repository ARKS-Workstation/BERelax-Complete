---
id: cutover
title: Cutover: taking this system live, and the window it takes
unit: H-MIG-11
trigger_kind: manual
trigger: The owner has decided to stop running the business on the previous arrangement and start running it on this system, and the moment that happens is now being carried out.
first_action_heading: 1-run-the-go-no-go-check-and-read-every-line-of-it
first_action: Run the go/no-go check and read every line it prints, including the lines it says are met, because a cutover begun on an unmet item cannot be given back.
owner: owner
escalation: There is nobody to escalate to. Nothing in this build decides a cutover and nothing can take one back: the rollback runbook is the honest statement of which parts are irreversible, and the two people who can stop this are the owner and whoever is holding the backup.
alerts: (none)
env: DATABASE_URL, APP_ENV
---

# Runbook — cutover

## Read this first: what this document is and is not

The cutover is **one declared sequence of eleven steps**, and `scripts/cutover.mjs` is the part of it a
script can perform. The step ids below are the exact strings that script prints, so a run that says it
stopped at `stop-the-worker` is telling you which row of this table to read.

| # | Step id | Who | Writes |
|---|---|---|---|
| 1 | `preflight-go-no-go` | script | no |
| 2 | `preflight-freeze` | script | no |
| 3 | `preflight-schema-is-newest` | script | no |
| 4 | `stop-the-worker` | **you** | yes |
| 5 | `backup-before-anything` | **you** | no |
| 6 | `final-import` | script | yes |
| 7 | `post-import-reconciliation` | script | yes |
| 8 | `post-import-invariants` | script | yes |
| 9 | `record-the-decision` | **you** | yes |
| 10 | `start-the-worker` | **you** | yes |
| 11 | `open-for-business` | **you** | yes |

Five are yours, and they are the five nothing in this repository can do:

- **stop and start the worker** — a process, not a row;
- **take the backup** — no backup destination is on file
  ([OPEN-QUESTIONS](../OPEN-QUESTIONS.md) `Y13-rpo-rto`), and a script that chose one would be choosing
  where the only copy of this business goes;
- **record the cutover decision** — `parallel_run_decision` is a free column a named person fills in
  with their own rationale, and `ZY744` refuses one nobody is behind (ADR 0107);
- **open for business** — the act that makes it a cutover.

So the script stops at each of those and tells you to read this. Resume it afterwards with
`--from <next-step-id>`.

`post-import-invariants` is marked as writing although it only asserts: the named invariant sets are
registries of existing tests and those tests insert their own fixtures, so a rehearsal that ran them
would change the tables it exists to prove it left alone.

**Nothing here decides anything.** The go/no-go check reports six facts; the freeze register holds a
state a person set; the decision row is a person's claim. Each is deliberate, and each is the shape
`docs/adr/0127-a-go-no-go-that-cannot-say-no-is-decoration.md` records.

## 1. Run the go-no-go check and read every line of it

```
pnpm go-no-go
```

It prints a row for every one of six requirements, met ones included, and exits non-zero if any is unmet
or unanswered. Read the met lines too: the value of the output is the shape of the whole set, not the
list of blockers.

**It exits non-zero today and is supposed to.** Three of the six cannot be cleared by any amount of
code: no penetration test has been performed, fifty external items are open, and `M3 Reachable` has no
unit in the manifest declaring it. That is why this check is not in `pnpm verify` — a check that fails
every commit on a business fact gets deleted — and why it is run here, which is the only moment its
answer matters.

An `UNKNOWN` row blocks exactly as hard as an `UNMET` one. On the day of a cutover, *we did not measure
it* and *it failed* have the same consequence.

## 2. Confirm the freeze, and confirm somebody declared it

```
pnpm freeze
```

The register is `artifacts/release/freeze.json`. While it says `open` there is no freeze, and the check
says so with the open question that would end it (`Y13-cutover-date`). Declaring one is an edit to that
file: `state` becomes `frozen` and `claim` gains the F07 role that declared it, the instant and the
reason. The check refuses a frozen register that names any fewer than all three, and refuses a claimant
that is not a role — a name typed into that file is a string this build invented.

While the tree is frozen, `.github/workflows/freeze.yml` refuses any pull request that is not labelled
`launch-blocking`. The label is a constant in the code and not a field of the register, so it cannot be
changed to one every pull request already carries.

## 3. Rehearse it, and prove the rehearsal changed nothing

```
pnpm cutover --out artifacts/cutover/dry-run-1.json
```

The default mode is the rehearsal. It performs every step that is a script's and does not write,
measures the window, checksums **every ordinary table in `public` and `import_staging` before and
after**, and records the lot with a digest over its own figures.

Two things to read in the output:

- **`tables checksummed: N`, and no `cutover-dry-run-changed-a-table` line.** That is the rehearsal's
  one claim. A table whose checksum moved is named; a run that checksummed nothing is refused outright,
  because "nothing changed" over an empty table list is what a wrong schema filter looks like from the
  inside.
- **The window, and what it is a window over.** It is a **floor**, not an estimate: the steps that take
  the time are the ones the rehearsal does not perform, and the record says `coversEveryStep: false` so
  the figure cannot be quoted as the cutover's duration. It also records where it was measured — a
  duration off a shared agent container is a fact about that container (ADR 0126).

A recorded run is re-judged rather than trusted:

```
pnpm cutover --verify artifacts/cutover/dry-run-1.json
```

Edit any figure in that file by hand and this refuses it, because recomputing the digest means running
the sequence again.

## 4. Perform it

```
pnpm cutover --execute
```

It stops at the first step that is a person's, and prints what that step is. Work through
[section 1 of the rollback runbook](cutover-rollback.md#1-decide-what-rolling-back-actually-means-here)
**before** you start, not after: the decision about what rolling back would mean is cheaper to make now.

The order is the order, and two parts of it are not a matter of taste:

1. **The backup comes before the first write.** Everything after it is the only record of the period
   that follows. `pg_dump --format=custom` per [the restore runbook](restore.md), and read it back — a
   backup nobody has restored is a backup whose format, completeness and readability are all
   assumptions (ADR 0123).
2. **The worker starts after the import, not before.** Scheduled reminders are rebuilt from the
   imported appointments, and a worker running during the import acts on a half-built set — which means
   messages about appointments that already happened, to real people, with no recall.

## 5. What this cannot undo

[The rollback runbook](cutover-rollback.md) is the document, and its section 3 is the part to have read
before step 4 rather than after it. In one line each: an **issued tax document** exists, is numbered and
is the business's record whatever happens next; a **sent message** reached a real person and there is no
recall; **audit rows** are append-only by design; an **erasure** was an erasure.

## 6. Afterwards

The cutover is not finished when the sequence ends. `scripts/cutover.mjs` records what it did; what it
cannot record is the day-one reading:

```
psql "$DATABASE_URL" -c "select business_day, paper_count, system_count, difference, state from parallel_run_variance order by business_day desc limit 7"
```

A day **awaiting** a paper count is not a day that agreed. That distinction is H-MIG-10's and it is the
reason this table is worth reading at all — see
[section 5 of the rollback runbook](cutover-rollback.md#5-if-the-parallel-run-is-what-prompted-this).

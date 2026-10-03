# ADR 0127 — A go/no-go check that cannot say NO is decoration; a freeze is a CLAIM a human makes; and a cutover rehearsal's window is a floor measured on whatever machine ran it

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-MIG-11
- **Covers:** docs/01 decisions — none; this is ADR 0002's floor applied to a release gate, ADR 0107's
  "nothing in this build decides it" applied to the freeze, and ADR 0126's "a figure about the
  container is not a figure about a deployment" applied to a rehearsal's window

## Context

The unit asks for five things: a go/no-go script that exits non-zero and names every unmet item, with a
fixture proving that exactly one unmet item names that item and no other; a list of six requirements it
covers; a scripted cutover with a dry-run mode that leaves every table checksum unchanged and records
its measured window; a rollback that is honest about what cannot be reversed; and a code-freeze flag
that rejects any merge not labelled launch-blocking.

Every one of those five is a check that is easy to build in a form that cannot fail. A release checklist
whose items are all `TODO` reads as thorough. A freeze that nothing enforces reads as declared. A
rehearsal that performed four read-only steps and reported success reads like a rehearsal of a cutover.
The three decisions below are what separate each of them from the decorative version.

## Decision 1 — every requirement is UNMET until a fact clears it, and an absent fact blocks

`GO_NO_GO_REQUIREMENTS` declares six requirements and `releaseGoNoGoVerdict` clears one only on a
`met` finding. The vocabulary has three states, not two:

- **`met`** — a fact answers it.
- **`unmet`** — a fact refuses it.
- **`unknown`** — there is no fact: the source file is absent, the bound was never configured, the
  query threw, the list came back empty.

`unknown` blocks exactly as hard as `unmet`, and that is the decision. A release gate's failure mode is
not saying the wrong thing; it is saying nothing and being read as a pass. The restore drill is the live
instance: `check-drill-age.mjs` enforces its calendar bound **only when a maximum age has been
configured**, and deliberately has no default, because how often a restore must be rehearsed is part of
the same unanswered question as the RPO and the RTO (`Y13-rpo-rto`, ADR 0123). That is right for a gate
that runs on every commit and wrong for a release: "newer than the maximum age" with no maximum age is
a comparison against nothing. So this check reports it `unknown` and refuses, while printing the
difference so a reader still knows which of the two it was.

Three further consequences follow, and each is its own refusal:

- **A declared requirement with no finding at all is refused** (`go-no-go-requirement-not-examined`).
  A gatherer that stopped producing one — a renamed source, a caught exception — would otherwise
  shorten the examined set and report a cleaner answer than the last run, and nothing else could see it.
- **A verdict over no requirements, or over no findings, is refused** (`go-no-go-examined-nothing`).
  This is ADR 0002's shape at the moment it costs the most.
- **The check is NOT in `pnpm verify`.** It exits non-zero today and is supposed to: no penetration test
  has been performed, fifty external items are open, and `M3 Reachable` has no unit declaring it. A
  check that fails every commit on a business fact nobody can fix in code is a check somebody deletes,
  which is `go-live-payments.mjs`'s stated argument and `go-live-security.mjs`'s.

### What the six requirements are answered BY, and why none of them is re-derived here

Each requirement is answered by running the gate that already owns it — `check-drill-age.mjs`,
`go-live-security.mjs`, `check-dry-runs.mjs` — rather than by re-deriving its judgement. A
re-derivation would be a second statement of the maximum drill age, the blocking severities and the
minimum of three recorded runs, and the copy that drifted would be the one the release gate read. It
also means every one of those three already has its own known-bad fixture (ADR 0003), so this unit's
gate block does not have to prove them again.

The two requirements with no existing gate — the external items and the milestones — are read from
`build/manifest.yaml` and `docs/OPEN-QUESTIONS.md` by line scan, each with a floor that refuses a scan
matching nothing. An external item is one named in some unit's `blocked_on_owner`; it is cleared when
its row in `OPEN-QUESTIONS` says `resolved`. An id named by a unit with no row at all is reported
separately, because "unrecorded" and "open" are different failures.

## Decision 2 — the freeze is a claim, recorded with who and when, and nothing decides it

`artifacts/release/freeze.json` holds a `state` a person set, together with the F07 **role** that set
it, the instant and the reason. There is no date arithmetic, no "frozen once the go/no-go passes" and no
job that writes there. The cutover date is not on file (`Y13-cutover-date`), so a mechanism that decided
when to freeze would be deciding a date this build invented (brief rule 15).

This is the third time this repository has taken this shape and the argument is the same each time:
migration 0128's *"Marked as posted"* ("a row that says only *the reply was posted at 14:02* is a fact
nobody is answerable for, and the first question asked of it — *who said so?* — has no answer at all"),
H-HARD-07's incident register, and 0153's `parallel_run_decision` (ADR 0107). So `freezeProblems`
refuses:

- a frozen register with **no claim** behind it;
- a claimant that is **not an F07 role** — a role resolves to a person outside this repository, a name
  typed into a JSON file is a string;
- an **open** register that still carries a claim (the freeze was lifted and the claim is a record of a
  period that ended, which belongs in the history and not in the live state);
- an **open** register naming no open question, because a blank reads like a field nobody filled in.

### Why the exempt label is a constant and not a field of the register

`LAUNCH_BLOCKING_LABEL` is in `packages/core/src/release/freeze.ts`. The register is a working file
somebody edits on purpose — ADR 0125's argument for the findings register having no digest — so a label
named *there* could be edited to one every pull request already carries (`bug`, say), and the freeze
would permit everything while reading as enforced. The label a freeze exempts is a decision, so it
lives where decisions live.

### Why absent label information is refused by its own rule

`mergePermitted` takes `readonly string[] | null`. An empty array is a pull request with no labels,
which is a real state and is refused during a freeze. `null` is the absence of label information — a
workflow expression that resolved to nothing, a caller that did not look — and it is refused by
`freeze-merge-labels-not-supplied` rather than being folded into the first case. Folding them would mean
a workflow whose label expression broke reported the strictest possible answer for the right-looking
wrong reason, and the day somebody fixed the expression the gate would appear to weaken.

## Decision 3 — a rehearsal's evidence is the checksums; its window is a floor, and it says where it was measured

`scripts/cutover.mjs`'s default mode performs every step that is a script's and does not write, then
proves it wrote nothing by checksumming **every ordinary permanent table in `public` and
`import_staging`** before and after and comparing, naming the table that moved.
`import_staging.content_checksum` is the one implementation of a table checksum in this repository
(`packages/migration/src/checksum.ts`), so there is no second answer to *did this table change*. The
table list is derived from `pg_class` rather than declared, because the table a declared list would stop
covering is whichever one a migration added last. A run that checksummed **nothing** is refused
outright: "no table changed" over an empty list is what a wrong schema filter looks like from the
inside.

Two consequences of marking each step with whether it writes:

- **`post-import-invariants` is marked as WRITING** although it only asserts. `pnpm money-invariants`
  is a registry of *existing tests* (ADR 0074) and those tests insert their own fixtures, so a rehearsal
  that ran them would change the tables it exists to prove it left alone — and the checksum comparison
  would be refusing this step rather than catching a real write.
- **Five of the eleven steps are an operator's and the script performs none of them.** Stopping a
  process, choosing where the only copy of this business goes, recording a decision only a named person
  may take (`ZY744`), and opening the doors. `--execute` stops at the first of them and
  `--from <step-id>` resumes, which makes the sequence a scripted procedure with a person in it rather
  than a script that pretends to be the whole cutover.

The window is recorded with two fields that stop it being quoted: `coversEveryStep`, **derived** from
the step records rather than trusted, and `measuredOn`, a closed set whose default is `agent_container`.
Both exist for ADR 0126's reason one subject over: the steps that take the time are the ones a rehearsal
does not perform, and a duration measured on a shared four-core container is a figure about that
container. The rendering prints both warnings whenever they apply, and `cutoverRunProblems` refuses a
record whose `coversEveryStep` disagrees with its own steps.

The record carries a sha-256 over its own canonical form, and there is deliberately **no re-seal
command**: recomputing the digest means running the sequence again, which is what makes *the artefact
says it was clean* and *it was clean* the same claim (ADR 0123's argument for the drill report). The
digest problem is reported and then **not returned on** — every other rule is still judged — because a
hand edit to one checksum has to be visible as the rule it breaks as well as as a broken digest.

## Consequences

- `pnpm freeze` joins `pnpm verify` and CI: a malformed freeze register is a defect in the repository
  whatever the release position is, and the check is two file reads. `pnpm go-no-go` and `pnpm cutover`
  are deliberately outside both.
- The go/no-go check will say NO until the owner clears fifty external items, an engagement is
  performed, a maximum drill age is configured, every provisional setting is confirmed and a unit exists
  for `M3 Reachable`. That is the intended state and it is the unit's own provisional note: *every
  external item is recorded as uncleared so the check fails until the owner clears it.*
- `--findings <path>` exists on the go/no-go script for one reason, and it is ADR 0003's: five of the
  six requirements cannot be cleared in this repository today, so the cleared path and the
  exactly-one-unmet path can be seen in no other way. It is `check-dry-runs.mjs --dir`'s device.
- A future unit that adds a requirement adds it to `GO_NO_GO_REQUIREMENTS` and to the gatherer in the
  same commit, or the verdict refuses the run by name.

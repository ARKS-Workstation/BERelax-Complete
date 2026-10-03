# ADR 0123 — A restore drill restores into a database made from nothing and READS ROWS BACK, and its evidence goes stale by prefix and not by calendar

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-04
- **Covers:** docs/01 decisions — none; this is ADR 0002 applied to disaster recovery, ADR 0034
  limitation 1 ("it does not reach a backup") given a per-class operator answer, and brief rule 15
  applied to the recovery objectives nobody has set (`Y13-rpo-rto`)

## Context

The acceptance line asks for a drill that "restores a backup into an ephemeral postgres:16" and reports
"measured RTO and data-loss window". This deployment has **one PostgreSQL 16 server, no managed backup
service, no WAL archive, no off-site copy and no staging host**, and the container the drill was built in
runs several agents on four cores.

Two ways to carry that out are available and wrong. The first is to build the drill against a cloud
backup API that is not wired up, which produces a script nobody can run and a gate that is never green.
The second is to run a dump and a restore, watch both exit zero, and record the elapsed time as an RTO —
which produces a committed artefact that is indistinguishable from evidence about a configured system,
and that is brief rule 15's failure: a plausible figure is worse than a blank one, because blank is
visibly unanswered.

## Decision 1 — the drill restores into a database it creates and drops, and proves it by reading rows out

`pg_dump --format=custom` to a file, `create database`, `pg_restore --exit-on-error
--single-transaction`, and then three separate proofs that something came back:

1. **Every** relation's row count compared in BOTH directions. The second direction is the one nobody
   writes: a table present in the restore and absent from the source means the target was not created
   from nothing, so every count in the report is a comparison against somebody else's rows.
2. **Four named rows read back** — the `legal_entity` singleton, the catalogue, the invoice and
   invoice-line counts, `app_setting` — each compared with the same statement run against the source in
   the same run, never against a figure committed to this repository, which would be a second statement
   of the data and would go stale on the first seed change.
3. **A suite and the money invariants run against the restored database.** This is the part a row count
   cannot do, and it earned its place immediately: see decision 4.

A fresh database every time, with no resume path, for `apply-migrations.mjs`'s stated reason one floor
up — a restore on top of existing rows is a mixture, and the reconciliation that would have reported it
is comparing against the wrong thing.

## Decision 2 — staleness is a PREFIX rule over the migration set, not an age in days

"Fail when the newest report is older than N days" needs an N, and nobody has chosen one. The rule that
needs no figure is also the stronger one: a recorded drill is evidence about the migration set it
restored, so it stays evidence for as long as that set is an unchanged **prefix** of the set on disk.
Appending migration 0159 does not make yesterday's restore untrue; editing migration 0042, which the
drill restored, makes the evidence describe a schema that is not here.

It also does not fail on correct work, which the calendar rule does: every unit that adds a migration
would have to re-run the drill — twenty minutes with the suites — to get a green build, and a gate that
fails on correct work is a gate somebody deletes.

The calendar bound is implemented all the same, enforced from `--max-age-days` or from
`objectives.drillMaxAgeDays` in the artefact, with **no default**. So the rule exists, has a known-bad
fixture, and fires the day somebody decides the figure. Until then `pnpm drill-age` prints the four
unanswered objectives by name on every run, so the absence is loud rather than quiet.

## Decision 3 — the report carries `rpoSeconds`, `rtoSeconds` and `backupRetentionDays` as `null`, and a `notProved` list it may not leave empty

`DrillObjectives` types all four figures `number | null` and the drill writes `null`. The measured
restore duration is recorded separately, under a `machine` block naming the platform, the core count and
the one-minute load average, with `measuredOn: 'agent_container'` — brief rule 23, made a field instead
of a comment, so nothing downstream can read an agent-container duration as a recovery time.

The data-loss window IS measured, because for this drill it is a real quantity: the interval from the
dump finishing to the restored copy being verified, in which every write to the source is absent from the
copy. It is a figure about that run. An RPO is a function of how often a backup is taken, nothing takes
one on a schedule here, and the report says so rather than dividing one number by another.

`notProved` is refused when empty. A report of this drill that claimed no limitations would be wrong
about itself, and the gate fails on it — the same shape as `importersNotRun` in ADR 0106.

## Decision 4 — what the drill found in its own first two runs, which is the argument for all of the above

**It restored a database in which the application role had no permissions.** The first version passed
`--no-owner --no-privileges` to both commands, which is the habitual pair. Every row came back. Every
grant did not: the money invariants failed eight ways with `permission denied for table journal_entry`,
and `information_schema` showed `berelax_app` holding nothing where migration 0067 gives it INSERT and
deliberately withholds UPDATE. A row-count reconciliation cannot see that, a read-back cannot see it, and
the data looked perfect. Only running real statements as the real role did.

**It reported four materialised views as data loss.** `pg_dump` emits a `REFRESH MATERIALIZED VIEW`
rather than the rows, so `pg_restore` recomputes the seven `reporting.*` views from the restored base
tables: they are as at the RESTORE and not as at the dump. They are therefore recorded as
`derivedViews` rather than reconciled — and a view that comes back EMPTY where the source had rows is
still a failure, because the distinction between "refreshed" and "absent" is the whole reason the split
exists rather than an exclusion list.

## Decision 5 — the per-class backup position lives beside `DATA_CLASSES`, and `erasureReachesBackup` is typed `false`

`rights_resolution.backup_position` (0085) already makes every completed erasure tell the SUBJECT that a
row-level erasure does not reach a backup. That is one sentence for all ten classes. The operator's
question is per class, and has four different answers: is it in the backup, is it readable once restored,
what does restoring **undo**, and does an erasure already performed come back. `BACKUP_POSITIONS` answers
all four, keyed by `DataClass` so the compiler refuses a key that is not one, and
`backup-position.test.ts` holds it to `ERASURE_RULES` in both directions.

It is in `packages/core/src/privacy/` and not the declared `packages/db/src/data-classes.ts` because
`DataClass` is a core type and `packages/db` may never import core (ADR 0001).

`erasureReachesBackup` is typed `false` and not `boolean`, which is `AlertSlo.target`'s trick for the
same reason: a `pg_dump` is one file and no individual row can be removed from it, so "this class's
erasure does reach the backup" is **inexpressible** rather than discouraged — and a `true` there is a
claim an operator would act on by telling a data subject their data is gone from every copy.

## The consequence somebody will have to live with

**The gate cannot tell you the backup is recent, because nothing takes one.** `pnpm drill-age` proves the
restore PATH works against the current schema and says, every time it runs, that the RPO, the RTO, the
retention period and its own maximum age are all unset. That is the honest state and it is a worse
operational position than it looks: the most recent backup of this system is whichever one somebody last
took by hand. Answering `Y13-rpo-rto` is a scheduling decision and a storage decision, not a code change,
and the only part of it this repository can hold is the figure.

**And the three protections a restore undoes have to be re-applied by a person.** Step 6 of
`docs/runbooks/restore.md` is a human checklist — revoke again, re-enter suppressions, re-enter consent
withdrawals — because the evidence that any of them happened was inside the window being rolled back.
Nothing in the restored database can discover them, so no script can do this step.

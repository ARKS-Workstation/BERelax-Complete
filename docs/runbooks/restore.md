---
id: restore
title: Restore the database from a backup
unit: H-HARD-04
trigger_kind: manual
trigger: The database is lost, corrupted, or has been written to in a way that cannot be corrected forward, and the decision has been taken to go back to a backup.
first_action_heading: 1-stop-the-worker-before-you-restore-anything
first_action: Stop the worker, because a restored outbox re-delivers every message the dump had not yet published.
owner: owner
escalation: There is no second person and no on-call rota in this business, so there is nobody to escalate to; what escalation means here is recording the decision and its consequences in the incident register before acting, not telling somebody else.
alerts: (none)
env: DATABASE_URL, CLINICAL_KEK, CLINICAL_KEK_PREVIOUS, CLINICAL_KEK_PREVIOUS_VERSION
---

# Runbook — restore the database from a backup

**H-HARD-04. The drill that proves these steps work is `pnpm drill`, and the evidence of its last run
is [artifacts/drills/restore-report.json](../../artifacts/drills/restore-report.json).**

## Read this before you decide to restore

A restore is **not** a neutral recovery. It is an action with consequences for people, and four of them
are invisible from the words "put the database back". They are stated per data class, with the reason,
in `packages/core/src/privacy/backup-position.ts`, and in short:

- **A credential that was revoked after the backup was taken works again.** `staff_credential` holds the
  hash a sign-in is checked against and `booking_manage_grant` holds a live bearer token. If the reason
  you are restoring is that somebody had access they should not have, restoring re-grants it.
- **A consent that was withdrawn after the backup reads as given**, and the messaging gate reads those
  rows. A restore can turn a refusal into a send.
- **A suppression added after the backup is gone**, so somebody who asked never to be contacted again
  becomes contactable, silently.
- **The audit trail goes back with everything else**, including the audit rows for the incident that
  caused the restore. Record what you know in the incident register (H-HARD-07) *before* you restore;
  that register is the only thing that survives the window you are rolling back.

## What this build has, and what it does not

- There is **one PostgreSQL 16 server**. There is no managed backup service, no off-site copy, no
  immutable store and no second host to restore onto.
- There is **no point-in-time recovery.** `archive_mode` is read off the server by the drill and
  recorded in the report; with no WAL archive there is no instant to recover to other than a dump.
- There is **no backup schedule, no retention period, no RPO and no RTO.** Not "they are short" —
  there are none, and no figure for any of them exists in this repository. See
  [OPEN-QUESTIONS](../OPEN-QUESTIONS.md) `Y13-rpo-rto`. The restore duration in the drill report is a
  measurement of the machine the drill ran on under whatever else was running on it, and it is not a
  recovery time objective.
- **Taking the backup is therefore a manual step**, and until the open question above is answered the
  most recent backup is whichever one somebody last took by hand.

## Taking a backup

```
pg_dump --format=custom --file berelax-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"
```

`--format=custom` because it is the format `pg_restore` can read selectively and verify: `pg_restore
--list` on the file parses its table of contents and opens no connection, which is how a truncated dump
is detected before anything is restored. **Do not** pass `--no-owner` or `--no-privileges`; see step 3.

## Restoring

### 1. Stop the worker before you restore anything

The outbox is deduplicated by `idempotency_key` **within a database**. A restored copy carries no memory
of a delivery made from the original, so a worker pointed at a freshly restored database re-sends every
`outbox_event` the dump had not yet published — to real recipients, if the transports are live.

### 2. Restore into a database created from nothing

```
psql "$DATABASE_URL" -c 'create database berelax_restored'
pg_restore --dbname "postgres://…/berelax_restored" --exit-on-error --single-transaction backup.dump
```

Never into a database that already holds tables. A restore on top of existing rows gives you a mixture,
and the row-count reconciliation that would have told you so is comparing against the wrong thing. This
is the same rule `scripts/apply-migrations.mjs` enforces for migrations and for the same reason.

`--single-transaction` so a failure leaves nothing behind, and `--exit-on-error` because without it
`pg_restore` reports a non-zero exit at the end and carries on in between, which produces a database
that is partly restored and looks finished.

### 3. Restore WITH owners and privileges

This step exists because the first run of the drill got it wrong. With `--no-owner --no-privileges` the
restore produced a database in which **`berelax_app` held no permissions at all**: every row was there,
and the money invariants failed eight ways with `permission denied for table journal_entry`, and
`information_schema` showed the application role holding no grants where migration 0067 gives it INSERT
and deliberately withholds UPDATE. The data was intact and the least-privilege controls were gone, and
nothing about the data said so.

So: no `--no-owner`, no `--no-privileges`, and the roles (`berelax`, `berelax_app`) must already exist on
the server — they are cluster-level objects and are not in the dump.

### 4. Reconcile, and read rows back

```
pnpm drill --source "$DATABASE_URL"
```

The drill is the mechanised version of this step and is what to run if you can: it dumps, restores into
a database it creates and drops, compares **every** table's row count in both directions, reads four
named rows back out, and runs
[the restore suite](../../packages/fixtures/src/restore-drill.itest.ts) and the money invariants against
the restored copy. Two commands exiting zero is not a restore.

Checking by hand, the four things worth reading back are the ones the drill reads: the `legal_entity`
singleton (every tax document snapshots from it), the catalogue, the invoice and invoice-line counts,
and `app_setting`.

### 5. Expect the reporting views to differ, and check they are not empty

`pg_dump` emits a `REFRESH MATERIALIZED VIEW` rather than the rows, so the seven `reporting.*` views are
**recomputed** by the restore and are as at the restore rather than as at the dump. A changed count there
is correct. An **empty** one is not, and the drill fails on it.

### 6. Re-apply what the window rolled back

In this order, because each one can harm somebody:

1. **Revoke again.** Any credential or booking-manage grant you revoked after the backup instant.
2. **Re-enter suppressions.** Anyone who asked not to be contacted in the rolled-back window is now
   contactable. This is the step that cannot be discovered from the restored database, because the
   evidence of the request was in the window.
3. **Re-enter consent withdrawals**, for the same reason.
4. **Re-make settings changes.** An audited settings change made after the dump is reverted with no
   record in the restored copy that it ever happened.
5. **Only then** start the worker.

### 7. Clinical rows need a key that is not in the dump

Clinical submissions restore as ciphertext with their wrapped data keys. They are readable only if the
KEK that wrapped them is still available: `CLINICAL_KEK`, or `CLINICAL_KEK_PREVIOUS` with
`CLINICAL_KEK_PREVIOUS_VERSION` if the KEK has been rotated since the dump was taken.
[The KEK rotation runbook](key-rotation.md) is the authority on which version is which; restoring an old
dump after a rotation without the retired version leaves the rows present and unreadable.

A crypto-erasure performed after the dump is also **undone** by the restore, because the dump holds the
old wrapped key.

## If the restore fails

| What you see | What it means | What to do |
|---|---|---|
| `restore-backup-unusable` | `pg_restore --list` could not parse the file. This is what a truncated dump looks like. | Use another backup. A dump that fails this check will also fail part-way through a restore, which is worse. |
| `restore-backup-empty` | The table of contents is empty: restoring it would succeed and restore nothing. | Use another backup. |
| `restore-row-count-mismatch` | A table came back with a different number of rows, did not come back, or was already there. | If the target was not empty, start again with a fresh database. Otherwise the dump is incomplete. |
| `restore-read-back-failed` | A named row could not be read out of the restored copy. | The schema restored and the data did not. Do not point the application at it. |
| `restore-suite-failed` | The restored database does not behave like the schema: a protection, a grant or an extension is missing. | Step 3 is the usual cause. Read the suite's output; it names the table and the SQLSTATE. |
| `drill-report-stale-schema` | The committed drill evidence is about a migration that has since been changed. | Re-run `pnpm drill --emit` and commit the report. |

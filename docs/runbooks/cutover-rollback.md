---
id: cutover-rollback
title: Cutover rollback: going back to the previous arrangement
unit: H-HARD-06
trigger_kind: manual
trigger: The cutover has happened, this system is the one the business is running on, and it has to stop being that — either because something is wrong with it or because the parallel run disagreed.
first_action_heading: 1-decide-what-rolling-back-actually-means-here
first_action: Decide which of the two rollbacks is being asked for, because going back to paper and going back to a previous release are different acts with different costs.
owner: owner
escalation: Nothing in this build decides a cutover and nothing can decide a rollback; it is the owner's decision, and the only thing this document can do is make the consequences visible before it is taken.
alerts: (none)
env: DATABASE_URL
---

# Runbook — cutover rollback

## Read this first: nothing here decides this

`apps/worker/src/jobs/parallel-run-reconcile.ts` records, per trading day, what the paper day sheet
counted and what this system counted, and flags any difference. It is a **reading**. No job computes a
recommendation and no trigger sets a decision: `parallel_run_decision.decision` is a free column that a
person fills in, with their own name and rationale beside it. That is deliberate (ADR 0107): the paper side is a named person's claim and the system
side is a measurement, and a function that turned the two into a verdict would be a verdict nobody made.

So this runbook is the consequences, not the decision.

## 1. Decide what rolling back actually means here

Two different acts get called the same thing:

- **Back to the previous arrangement.** The business stops using this system and goes back to whatever it
  was doing. Section 2.
- **Back to a previous release of this system.** The business keeps using this system and a deployment
  is reverted. Section 4. This is much cheaper and is usually what is actually needed.

Asking which one is being asked for is the first action because the second is reversible and the first,
in one specific respect, is not — see section 3.

## 2. Back to the previous arrangement

The data this system holds is the only record of everything that happened after the cutover. So the
order is:

1. **Stop the worker.** Otherwise it goes on sending messages about appointments the business is no
   longer managing here. [The job backlog runbook](job-backlog.md) section 1 is how to tell whether it
   is running.
2. **Take a backup before anything else.** `pg_dump --format=custom` per
   [the restore runbook](restore.md), and keep it: it is the only copy of the post-cutover period, and
   nothing in this deployment retains a backup on its own
   ([OPEN-QUESTIONS](../OPEN-QUESTIONS.md) `Y13-rpo-rto`).
3. **Export what the business needs to carry back.** Future appointments, outstanding package balances
   and unpaid invoices are the three that matter, in that order, because the first two are commitments to
   customers and the third is money owed.
4. **Stop taking bookings.** The public site is the part customers reach, and leaving it live while the
   business is not reading this system is worse than taking it down.

## 3. What a rollback cannot undo

Stated plainly, because each one is a thing somebody has to be told rather than discover:

- **Issued tax documents.** An invoice and a credit note are append-only with a sequence behind them
  (`pnpm no-invoice-mutation`, and a trigger in the database). A document that was issued from this
  system exists, is numbered, and is the business's record whatever the business does next. It cannot be
  withdrawn by rolling back; a correction is a credit note.
- **Messages that were sent.** Anything the outbox published reached a real person. There is no recall.
- **Audit rows.** Append-only (ADR 0008), and that is the point: the record of what this system did
  during the period it was in use survives the decision to stop using it.
- **Erasures.** A customer erased in this system was erased here. The restore section of
  [the restore runbook](restore.md) is explicit that a restore brings erased data back, which is a
  separate decision with its own obligations.

## 4. Back to a previous release

Much simpler, and the one constraint is the schema:

1. **Migrations only go forward.** `scripts/apply-migrations.mjs` applies every migration from nothing
   and cannot resume; there is no down-migration in this build and no applied-migrations table. So
   reverting the code to a release that predates a migration leaves the code reading a schema it does
   not expect.
2. **So check whether a migration landed between the two releases.** If none did, reverting the code is
   just a deployment. If one did, the revert is a restore of the database to a point before it — which
   is [the restore runbook](restore.md), with everything that document says about what a restore undoes.
3. **Re-run the gates against the reverted tree.** `pnpm money-invariants` is the one that matters most
   here: it re-adds every money identity over every row the database holds, which is the question a
   revert raises.

## 5. If the parallel run is what prompted this

Read the variance rows before anything else:

```
psql "$DATABASE_URL" -c "select business_day, paper_count, system_count, difference, state from parallel_run_variance order by business_day desc limit 30"
```

A day **awaiting** a paper count is not a day that agreed — the pass reports it as awaiting rather than
writing a zero, precisely so that an uncounted day cannot read as agreement. A day outside the declared
window is refused by name rather than reported as zero variance, for the same reason. Those two
behaviours are what make this table worth reading at all, and they are the reason a rollback prompted by
"the numbers did not match" should start by checking how many days were actually compared.

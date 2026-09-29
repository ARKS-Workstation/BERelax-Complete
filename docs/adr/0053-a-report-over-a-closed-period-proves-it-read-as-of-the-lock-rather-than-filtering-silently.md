# ADR 0053 — a report over a closed period PROVES it read as of the lock, rather than filtering silently

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** M-VAT-12
- **Covers:** docs/01 decisions — none; this is the reporting half of the period lock ADR 0026 makes
  irreversible, and it narrows a reading of migration 0097's `ZY076` that three units still to land would
  otherwise each have to guess at

## Decision

**A report over a closed accounting period records the instant the lock was taken and carries a line that
counts the rows written after it. It does NOT filter its reads on `created_at <= sourceAsOf`.**

Two halves, and the second is the one being decided:

1. `sourceAsOf` is the lock's own `locked_at` for a period a `period_lock` covers, and the caller's instant
   for an open one. It is **stored on the report**, so a regeneration next year reads at the same instant,
   and it comes from `commissionPeriodSource` — the one function that already answers this — which in turn
   asks `periodStatusOn`, the one reader of the lock. Nothing adds a second reader of either.

2. The discipline is then **asserted rather than applied**. Every closed-month report carries
   `rows_created_after_the_period_lock`: a count, across every document table the report reads and across
   `journal_entry`, of the rows dated inside the period whose `created_at` (or `posted_at`) is later than
   `sourceAsOf`. **Zero is what makes "as of the lock" and "as of now" the same answer.** Non-zero is a
   named variance, and the report refuses to be exported.

## The alternative, and the specific way it fails

The obvious reading of `ZY076` is the opposite: a commission run over a closed period filters every clause
of its read on `created_at <= sourceAsOf`, and `0097_hr_commission.sql` says why — a late payment against a
March invoice, or a sale backdated into March after March was filed, makes "completed and paid in March" a
larger set than it was, so a recompute is correct arithmetic over facts that postdate the payslip.

That is right for a commission run and wrong for a reconciliation, for two reasons.

**The figures a reconciliation compares come from functions that take no such filter.** The ledger movement
is `trialBalanceMovement` and the deferred liability is `readPackageLiability`; both are the ONE source of
their figure, nine `done` units assert against the first, and neither has an as-of parameter. Adding one is a
change to a function the build is built on; re-deriving either with the filter in a report is the second
derivation of a money figure that every other rule in this build exists to prevent. A reconciliation where
three figures are as-filed and two are as-of-now is not a reconciliation — it is two reports interleaved, and
the variance it shows is an artefact of which half was filtered.

**And a silent filter hides exactly the event it is for.** A period can be reopened: ADR 0026 makes it a
sanctioned migration and nothing else, and `packages/db/src/services/vat-return-signoff.itest.ts` does it
deliberately to prove a snapshot does not re-derive. A report that filtered on `created_at` would, after such
a reopening, go on reporting the figures as filed **with nothing anywhere saying the ledger behind them had
moved**. M-VAT-08's header names that outcome from the other side: every return already filed against the
period silently restates itself, with the hash recomputed and the signatures still attached. The filter would
make the report agree with the filed figures precisely when the two had stopped being the same thing.

A census line cannot do that. It is loud, it names the count, it blocks the export, and it is a check that
has been **seen to fail**: `month-reconciliation.itest.ts` reads an open month at an instant 250 years before
it was written and requires the count to be 15, with both closed months at zero.

## The consequences somebody has to live with

- **A reopened-and-reposted period produces a report that refuses to be exported rather than a wrong one.**
  That is the intended behaviour and it is worth stating plainly, because it means the remedy for a reopening
  is to re-close and re-state, not to re-run the report and see what it says.

- **The claim is now a property of the REPORT and not of the query.** Anything that reads the reconciliation
  without reading `rows_created_after_the_period_lock` has read figures whose as-filed status it has not
  checked. `exportMonthReconciliation` is the only door, it reads `notExportableReasons`, and the census
  drives that list — but a future caller that bypassed the export would bypass the proof. The enumeration
  `MONTH_RECONCILIATION_CONSUMERS` exists so that such a caller is a failing test rather than an omission,
  which is M-VAT-08's `VAT_RETURN_CONSUMERS` arrangement for the same hazard.

- **`ZY076`'s filter stays exactly as it is for commission.** This ADR does not weaken it. A commission run
  stores one figure per therapist and is compared against a payslip that was paid; it has no second source to
  disagree with, so the filter costs it nothing and buys reproducibility. The distinction is that a
  reconciliation's whole content is a disagreement between two sources, and a filter applied to one of them
  manufactures one.

- **R-REP-02, H-MIG-07 and M-VAT-13 each face this question and now have an answer.** R-REP-02's
  "re-running the statements for a locked period produces byte-identical output" is the same claim: it is met
  by a census over the period plus figures read at the period's own dates, not by filtering the statement
  queries on `created_at`. H-MIG-07 locks the period up to the cutover and asserts its opening balance sheet
  ties to the imported package liability; it should tie through `readPackageLiability` and state the census
  rather than filter. M-VAT-13's money-invariant suite should run the census line as an invariant over every
  closed period, which is the form in which this decision becomes something the build checks on every unit
  rather than something a reporting unit remembered.

- **The cost is one more line on a report nobody wants longer.** Eleven lines is already at the edge of what
  a reviewer reads, and one of them is about the report rather than about the money. The alternative is a
  report with ten lines that is wrong in the one case it exists for.

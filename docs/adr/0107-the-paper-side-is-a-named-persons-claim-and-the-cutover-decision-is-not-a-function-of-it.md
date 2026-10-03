# ADR 0107 — the paper side of a parallel run is a named person's CLAIM, a day outside the window has no figure, and the cutover decision is not a function of either

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-MIG-10
- **Covers:** docs/01 decisions — none new. It is the cutover-shaped record of docs/12's parallel-run step
  and of **Y12-pilot** ("staff pilot; report what the front desk complains about") and **Y14-devices**,
  and it opens **Y8-parallel-run-window**. It stands on
  [ADR 0070](0070-an-unattributable-cost-is-a-refusal-and-never-a-zero.md) (an unattributable figure is a
  refusal and never a zero) and takes its claim mechanism from migration 0128 (G-REV-06's "Marked as
  posted") and migration 0142 (H-HARD-07's incident register), which are the two other places this build
  records an assertion about the outside world. It reads the evidence
  [ADR 0105](0105-a-reconciliation-report-is-a-reading-and-a-variance-is-named-or-it-fails.md) and
  [ADR 0106](0106-a-dry-run-is-a-fresh-database-and-three-recorded-runs-or-the-gate-is-decoration.md)
  produce.

## Decision

**Five things, and the last is an absence.**

1. **The paper day sheet is a CLAIM and the system count is a MEASUREMENT, and they are different
   tables.** `parallel_run_paper_count` carries who read the sheet, is append-only (ZY743) and cannot
   COMMIT without an `audit_event` in the same transaction naming a staff actor (ZY742).
   `parallel_run_reconciliation` carries what the system held, written by the daily job.

2. **A day inside the window that nobody has counted produces NO ROW.** The reconciliation has a foreign
   key to the paper count, so the schema makes it impossible, and the pass reports the day as awaiting
   rather than skipping it.

3. **A day outside the window is refused by name (ZY741), not reported.** The window is two settings with
   no date (`migration.parallel_run_window_start`, `migration.parallel_run_window_end`, both blank,
   provisional against Y8-parallel-run-window), and with either unset the pass refuses to run at all.

4. **The difference and the state live in one VIEW** (`parallel_run_variance`) and the difference is
   SIGNED.

5. **Nothing in this build decides the cutover.** `parallel_run_decision.decision` is a free column over
   two values; no trigger computes it, no view recommends one, no job writes a row, and neither module
   exports a function whose name is about deciding one. What the schema does instead is make the decision
   attributable (ZY744), permanent (ZY745) and checkable against its own evidence (ZY746).

## Why the paper count is a separate table, which is the decision the rest follows from

The first version had both counts on one row. It is smaller, it is what the acceptance line's wording
suggests ("one variance row per business_day comparing the paper count with the system count"), and it
cannot be made to work: the thing that writes the row is a daily job, whose actor is `system`, and the
paper column's entire value is that a named person stood behind it. A job writing it would be the machine
asserting what the paper said.

Separating them also decides the case that matters most. On a day inside the window with no paper count,
a one-table design has to write *something* — and the only candidate is 0. **A zero there is
indistinguishable from "the paper and the system agreed that nothing happened"**, which is the figure a
whole parallel run is judged by. ADR 0070 settled that substitution in a cost; here it is a count, and the
consequence is larger because the output is a decision about whether a business cuts over. So the foreign
key makes the row impossible and the pass REPORTS the day — `awaitingPaperCount`, named, in the log line —
rather than passing over it in silence, because a day the pass skipped quietly is a day nobody knows is
missing.

## Why the window is two settings with no date, and why blank rather than null

A date has no "strictest safe option". Every other provisional setting in the registry carries the build's
strictest reading of something — a notification deadline, an alert threshold, a matching mode — and a
cutover date has no such reading: every candidate is equally made up, and this one decides which days the
comparison is about. Brief rule 15's own words settle it: blank is visibly unanswered, and plausible is
indistinguishable from configured.

So the reconciliation refuses while either is unset, rather than reconciling zero days. **"0 days, no
variance" reads exactly like a parallel run in which everything agreed**, which is this build's defining
failure shape (ADR 0002) arriving in the one place where its consequence is a go-live.

Blank and not null for a mechanical reason found by running the integration suite: `app_setting.value` is
`not null` and the global setup writes one row per definition, so a null-defaulted setting is one that
cannot be seeded at all. The suite's global setup failed on the insert, which is the right way round.

## Why ZY741 is a trigger and ZY746 exists at all

**ZY741 is a trigger and not a CHECK** although a CHECK could state it, because the message has to name
the two setting keys and the open question — what a reader at 02:00 needs, and what a CHECK violation
cannot carry. (0117 took the opposite decision for the opposite reason: there a CHECK would have written a
card number into the server log.)

**ZY746 holds `unreconciled_days` on the decision equal to the variance rows up to `as_of_business_day`,
and the reason is that the variance rows are UPSERTABLE.** A reconciliation is the current answer to a
question about a day, asked again whenever the answer might have changed (0138's reasoning), so a day
corrected after a decision was taken would silently change what the decision looks like it was taken in
the light of. Recording the figure makes "proceeded while four days were unexplained" permanent, and
holding it to the rows makes it checkable — a count nothing can check is a number nobody can act on. It is
DEFERRED because the writer may record the decision and the last day's reconciliation in one transaction,
and a row-by-row check would let the ORDER decide whether the rule held (ZY471's reason).

## Why the taxonomy is closed and two of its eight categories produce no unit

The thing reading a feedback category is a generator that writes a unit into the build's plan. A free
category would be a unit title nobody planned; an unknown one answered with a default would file somebody's
complaint under the wrong heading and generate the wrong work. So an unknown category is refused by name
with the eight it could have been.

**`not_a_defect` is the category that earns the taxonomy.** Without it every item becomes a fix unit, the
build acquires work from each expectation nobody had set, and the first response to a backlog like that is
to stop recording feedback — which costs the pilot its entire value. `device_or_hardware` produces nothing
for a different reason: a receipt printer or an OTP autofill is not something this build can change
(Y14-devices), so a unit for it would be a unit nobody could do. Both are REPORTED per item, because an
item that silently produced no unit is an item whoever reported it will raise again.

The generator prints a fragment and does not edit `build/manifest.yaml`. That file is what every agent
reads and every merge resolves, and a helper pointed at it has already deleted it once.

## What this costs

- **The front-desk p95 is NOT measured, and the committed report says so rather than carrying a figure.**
  `artifacts/pilot/walk-in-speed.json` holds `verdict: "not_measured"` and `p95Ms: null` —
  not 0, which would pass a ten-second budget with room to spare, and not an absent field, which would
  read like a report nobody had generated. Brief rule 23 is the reason: a wall-clock percentile taken in
  an agent container with several agents on four cores is a figure about the container, and written into a
  committed report it is indistinguishable from a figure about the product. The suite measures when
  `WALK_IN_SPEED_MEASURE=1` is set on a machine somebody chose, skips loudly on stderr otherwise, and
  **its report-integrity half always runs**: it holds the artefact to the verdict the arithmetic gives for
  the artefact's own figures, so a hand-edited `within_budget` over three samples fails. `minimumSamples`
  is 20 because that is the smallest count at which a 95th percentile is not simply the slowest
  observation.
- **The declared filename `apps/web/e2e/walk-in-speed.spec.ts` became `.itest.ts`.**
  `vitest.integration.config.ts`'s `include` is `apps/**/*.itest.ts`, so a `.spec.ts` is a test nothing
  runs — which is ADR 0002 in the file name.
- **The pilot feedback log is EMPTY and the pilot has not run.** The mechanism is complete and is exercised
  against a synthetic log whose every summary says it is synthetic, so no fixture item can be mistaken for
  a complaint somebody made. Y12-pilot is an owner verification task, not a code change.
- **Migration 0153 and the band ZY741–ZY746 are used; ZY747–ZY750 are released unused** and deliberately
  unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises. `SCHEMA_VERSION`
  is 153 and the ledger carries a paragraph. The test port band `{ start: 22_700, width: 300 }` IS used,
  by `walk-in-speed`.
- **`parallel_run_variance` has no Drizzle mirror**, which is not an omission: `pnpm db:drift` compares
  base tables, and a mirror of the view would be a second statement of the arithmetic the view exists to
  hold in one place.

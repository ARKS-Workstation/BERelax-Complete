# ADR 0084 — an opening position is attested ONCE, and nothing is ever dated behind its boundary

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** H-MIG-07
- **Covers:** docs/01 decisions — none new. It completes
  [migration 0027](../../packages/db/migrations/0027_opening_balances.sql)'s own rules now that the
  opening position is a SET of entries rather than one, which is what
  [ADR 0069](0069-a-reconstructed-package-sale-is-the-outstanding-entitlement-held-to-its-workbook-row.md)
  made true by posting the reconstructed package liability on `source = 'opening_balance'`; it stands on
  [ADR 0017](0017-accounting-journal-and-no-auto-filing.md) (a correction is a dated reversal),
  [ADR 0064](0064-a-financial-statement-is-a-directed-sum-over-a-partition-of-the-chart.md) (a statement
  line holds no figure of its own) and
  [ADR 0071](0071-a-realised-cohort-figure-is-a-figure-at-a-stated-horizon.md) (a posting from outside the
  package path is a named variance rather than one absorbed), and it records the provisional answers to
  **Y8-opening-balances** and **Y8-coa** the import rests on.

## Decision

**Four refusals and one piece of arithmetic.**

1. **`ZY381` — once any opening balance has been attested, no entry may be dated before the boundary,
   whatever its source.** 0027 exempted `opening_balance` and `reversal` from `ZL004` so that the opening
   entry could be inserted at all — it commits before the import row exists to guard against it — and
   that exemption is correct for exactly one entry and permanent for every other. With H-MIG-03's
   liability on the same source, a second opening entry could be dated anywhere behind the boundary at any
   time afterwards, inside the period the attested totals already summarise. The books would still
   balance. They would simply be larger.

2. **`ZY383` — once a boundary is attested, no further `opening_balance` entry may be dated ON it.** ZY381
   covers "before"; this covers "on", which is where the opening entries actually sit. **It follows that
   the package liability must be imported BEFORE the trial balance**, which is the dependency H-MIG-07's
   manifest entry declares, and it is not an accident of ordering: the trial balance is the statement of
   the whole opening position, so anything belonging in it has to be in the books before it is attested.

3. **`ZY382` — the attested totals must equal the journal lines of the entry the attestation NAMES, and
   the refusal names the imbalance on each side in fils.** 0027 left those totals "derived, and asserted
   against the lines by the itest rather than trusted"; this is that assertion moved into the database,
   which matters because `ZY384` makes the row append-only so nothing would ever re-derive them.

4. **`ZY384` — the attestation is append-only.** 0027 revoked UPDATE and DELETE from `berelax_app`, which
   is the privilege and not the rule: a migration, a psql session or a role added later is outside it, and
   ZY382 is DEFERRED and fires on INSERT, so an UPDATE afterwards would change the attested totals with
   nothing re-checking them.

5. **The statement states the FULL balance of every account, and the import posts the REMAINDER.** The
   file is what somebody checks against the books they are copying from, so it carries the whole figure —
   including the liability H-MIG-03 already posted — and `openingRemainder` in
   `packages/core/src/ledger/period-lock.ts` subtracts what `opening_balance` entries already hold at the
   boundary. A stated figure BELOW what is posted, or on the other side of zero from it, is REFUSED by
   name and never netted: that is not a remainder, it is a disagreement with a liability another import
   has already been signed off for, and ADR 0071 settled the direction.

And two shapes that are not what the acceptance lines first suggest:

6. **One staged ROW for the whole statement, not one per account.** Every other H-MIG importer stages one
   row per line because every other imported artefact is one row per line. An opening position is not:
   0027 settled "one entry, not one per account … a per-account entry would let half of it commit", and
   the staging has to agree or the framework's per-row transaction would BE the per-account entry 0027
   refused. The permanent copy the ledger then keeps is the attested statement itself, figure for figure —
   which, unlike every other import's payload, is a feature: it holds account codes and integer fils, no
   personal data at all, so an opening figure somebody disputes in two years traces to the bytes that were
   signed off.

7. **`coa.ts` CHECKS the chart; it does not import one.** The fifth acceptance line reads like a second
   importer and is not. `account_carries_a_vat201_attribution` (0089, `ZY009`) refuses an account with no
   `vat201_box_mapping` behind it, so an importer that created accounts would have to supply those
   attributions — and **an attribution is a decision about what feeds a VAT return**: which box, measured
   on net supplies or on tax, contributing credit-less-debit or the other way. That is the owner's and the
   accountant's, not a column somebody fills in to get an import to run. So the chart is the migrations'
   and `coa.ts` answers what the line is about: is the chart complete, and does the statement name anything
   outside it. Both are refusals the import acts on, so nothing is asserted that is not also enforced.

## The alternatives, and the specific way each fails

**Hold `ZY382` to every `opening_balance` line at the boundary, not to the entry it names.** This was
built first and it is the stronger rule: it would make a double count impossible in the SCHEMA rather than
in the importer, because an import that left H-MIG-03's liability out would attest too little and one that
posted its own copy would attest a balanced figure twice the size. It fails mechanically.
`importOpeningBalances` — 0027's own writer, which predates this unit and is tested — computes its totals
from its own lines, so the moment any other entry shared the boundary that writer could not commit at all.
Holding the whole position together is therefore the importer's, with the reconciliation asserted per
account to the fils, which is what the acceptance line asks for in its own words ("asserted by a
reconciliation test") rather than a refusal.

**Lock the pre-boundary period with a `period_lock` row.** `period_lock` is for closing a month that has
been reported (0073) and its `period_lock_no_overlap` exclusion is over dated ranges. The pre-boundary
period has no start that is not invented: the earliest journal entry moves as history is imported, the
financial year's start is a figure the handover does not give, and `0001-01-01` is a magic value.
`raise_if_period_locked` would then be a second answer to the question `ZL004` and `ZY381` already answer,
and the second answer is the one that goes stale.

**Add a core `openingTrialBalance` that names the imbalance in fils.** Written, then removed.
`openingImbalanceFils` and `assertImportable` in `packages/db/src/services/opening-balances.ts` already
add a stated balance up and refuse an unbalanced one before anything is written, naming the difference —
which is this unit's first acceptance line, satisfied by code that predates it. A third adder would have
been the statement that drifts. What `period-lock.ts` holds instead is what did not exist: the boundary
predicate and the remainder.

**Net a stated figure that is below what is posted.** It balances, it needs no refusal, and it silently
overrides an attestation somebody has already signed. The figure it would change is a customer liability.

**Quarantine a bad line, as the other four importers do.** A trial balance with one line held back does
not balance, so there is nothing to import and nothing to record a quarantine against. This importer has
no quarantine vocabulary at all, which is the one place it departs from H-MIG-04, H-MIG-05 and H-MIG-06.

## The consequence somebody will have to live with

**This is the one import that cannot be corrected by re-running it.** The unique key refuses a second
import at the same boundary, the attestation is append-only, and nothing may be dated behind the boundary
afterwards. A correction is a dated reversal plus a fresh import at a NEW boundary —
`opening_date_for()`'s `min()` was written for exactly that, so the guard moves to the earliest of them
and nothing behind it reopens. `--dry-run` is therefore not a nicety: it is the only rehearsal of this
import that exists, and it forces the deferred constraints before rolling back so the rehearsal is as
strong as the run.

**The import order between H-MIG-03 and H-MIG-07 is now enforced rather than documented.** Running the
trial balance first makes the package liability unimportable at that boundary. That is the correct
direction — a trial balance attested without a liability it should contain is wrong, and the alternative
is a liability posted into a period already summarised — but it is a constraint on the operator and it is
stated in the workbook's own preamble as well as here.

**`packages/core/src/ledger/period-lock.ts` is a second statement of migration 0132's triggers.** That is
deliberate: the database holds, because there are five posting paths, and the core module is what lets a
refusal be EXPLAINED before it is attempted rather than arriving as a SQLSTATE from inside a transaction.
`packages/fixtures/src/opening-boundary.itest.ts` drives both over the same inputs, which is the check
that holds them equal — written in the same commit, as this repository's own rule requires.

**The integration suite for this unit commits nothing.** An attested opening balance locks the whole
database behind its boundary, and the integration suite runs sequentially against one database, so a
committed fixture here would refuse entries in suites that have nothing to do with this unit. Every case
therefore runs inside a transaction it rolls back, drives the importer's `apply` directly — `runImport`
opens a transaction of its own and cannot be nested — and the cases about the framework's own behaviour
use its `dry-run` mode instead.

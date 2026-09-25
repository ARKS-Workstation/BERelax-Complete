# ADR 0026 — reopening a closed accounting period requires a migration

- **Status:** accepted
- **Date:** 2026-09-25
- **Unit:** M-VAT-06
- **Covers:** docs/01 decisions — none; this is the mechanism behind the period locking ADR 0017 chose
  for decision 13

## Decision

There is no way to reopen a closed accounting period from any code path in this system. No function
exported from `@berelax/db` performs one; the application role holds no `UPDATE` and no `DELETE` on
`period_lock`; and removing a lock therefore requires a migration, connecting as the owner, reviewed
like any other schema change.

The three layers, and what each one refuses:

| Layer | What it refuses | How it says so |
| --- | --- | --- |
| The export surface | a function that reopens | `period-close.itest.ts` reads every symbol `@berelax/db` exports and fails on one matching `/reopen\|unlock\|delete.*period\|update.*period/i` |
| The grant (0018) | `UPDATE` and `DELETE` on `period_lock` for `berelax_app` | `42501`, asserted by issuing both statements as that role |
| The close itself (0073) | a close whose books do not balance, or whose documents are not all posted | `ZE001`, `ZE002`, from a `BEFORE INSERT` trigger that binds every role including the owner |

## Why not a refusal trigger, when the journal has one

`journal_entry` and `journal_line` refuse `UPDATE` and `DELETE` for every role including the owner
(`ZL001`), and `invoice`, `credit_note`, `flow_definition` and the merge tables all do the same. The
obvious move is a fourth pair of triggers on `period_lock`. It was considered when the table was created
and rejected, and the reasoning in `0018_ledger.sql` still holds:

> `account` and `period_lock` get no refusal trigger, and the difference is deliberate. A journal row is
> history. An account is a classification and a lock is an administrative fact ABOUT history: a
> mis-typed lock range or a misspelled account name must be correctable by a migration without someone
> having to drop a trigger first, and dropping a trigger to fix a typo is how the trigger ends up
> dropped.

Two pieces of evidence have arrived since, and both point the same way. `journal.itest.ts` resets between
its period-lock cases by deleting every `period_lock` row, and block 97 of `scripts/test-gates.mjs`
clears the locks in its own year before each credit-note probe so that a leftover cannot make a probe
report a rule it is not about. A `BEFORE DELETE` refusal binding the owner would have turned both red on
the day it landed, and the cheapest repair available to whoever hit it would have been to drop the
trigger — which is exactly the failure 0018 predicted, arriving from the direction it predicted.

So the rule is held where it can be held without that pressure. What matters is that no *code path*
reopens a period, because a code path is what runs unattended, at the till, on a schedule, or in a
retry; the layer that has to bind it is the grant, and the grant binds it absolutely. A human with owner
credentials and a migration to write is a different situation, and one this record is addressed to.

## What the trade actually costs

**A period can be reopened by someone with database owner access and no code review.** That is true, it
is stated here rather than implied, and it is the same exposure as every other owner-only capability in
this schema: the owner can also `TRUNCATE` the journal, which no trigger stops either, and seven
integration suites depend on being able to. The control is that the owner is not a role any application
process connects as, and that a migration is a reviewed artefact in the repository.

**It also means the absence cannot be proved by a statement being refused for every role.** The
structural proof of "nothing reopens a period" is therefore the export-surface test rather than a
`SQLSTATE`, and an export-surface test is only as good as its pattern. That pattern lives in
`packages/db/src/services/period-close.itest.ts` with a control that must fail: the test asserts that
the pattern *would* catch a reopening name, by running it against a fabricated symbol list, so a pattern
that had stopped matching anything cannot report success.

## What a reopening migration has to do

If a period genuinely has to be reopened — a filed return withdrawn, an opening position restated — the
migration does three things and states all three in its header:

1. deletes the `period_lock` row, naming the period and the authority for the decision;
2. records the reopening in `audit_event` with `operation = 'delete'`, because the close wrote
   `ledger.period.closed` with the content hash of the trial balance and the pair has to be readable as
   a pair;
3. states what the previously recorded `trialBalanceHash` was, so the difference between the books as
   filed and the books as they end up is computable afterwards rather than lost.

`period_trial_balance_hash(as_at)` is in SQL for this reason among others: the hash the close recorded
can be recomputed from the reopened ledger by the migration itself, and a hash that still matches means
the reopening changed nothing and probably should not have happened.

## Consequences

- A correction to a closed period is a **dated reversal in the next open period**, always. That is
  `postDatedCorrection` in `packages/db/src/services/period-close.ts` and `planCorrection` in
  `packages/core/src/ledger/period.ts`, and there is no other way in.
- A screen that offers "reopen period" cannot be built against this schema without a migration first,
  which is the intended friction and not an oversight to route around.
- The close is refused unless it is sound (`ZE001`, `ZE002`), so the friction is bearable: the common
  reason to want a period reopened is that it was closed too early, and a close with documents still
  unposted or books that do not balance is now impossible.

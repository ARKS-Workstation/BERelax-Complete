# ADR 0023 — gap-free document numbering uses a row-locked counter, not a Postgres SEQUENCE

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** M-TILL-03
- **Covers:** docs/01 decisions — none; this is an implementation mechanism

## Decision

Statutory document numbers — tax invoices, simplified invoices, credit notes — are allocated from a
**counter row per series** in `document_series`, with

```sql
update document_series set next_number = next_number + 1 where code = $1 returning next_number - 1
```

run **inside the same transaction as the document insert**. The `UPDATE` takes a row-level exclusive
lock held to the end of the transaction, so concurrent issuers serialise on that one row and a
rollback returns the number to the pool.

A PostgreSQL `SEQUENCE` is not used, and neither is `IDENTITY`, `serial`, or anything else built on
`nextval`.

## Why a SEQUENCE cannot do this

`nextval` is **non-transactional by design**. It takes no transaction-duration lock and it does not
roll back, because that is exactly what lets a sequence serve thousands of concurrent inserts without
them queueing behind each other. The consequence is that a transaction which calls `nextval` and then
fails — a declined card, a constraint violation, a dropped connection, a deploy mid-checkout — has
consumed that number permanently. The issued range then reads 1, 2, 3, 5.

For a surrogate key that is the right trade and nobody ever notices. For a tax invoice number it is
the defect: a missing number in a statutory range is the first thing an FTA auditor asks about, and
the honest answer — "the till crashed in March" — is not a record. Under UAE VAT the taxable person
has to be able to produce the invoices behind a filed return, and a hole means either a document that
exists and was not disclosed, or a control that cannot tell the difference.

There is no configuration that fixes this. `CACHE 1` reduces how *many* numbers are lost on a crash;
it does not make `nextval` roll back. Nothing does.

## Why serialising costs nothing here

The objection to a locked counter is throughput: every issuer waits for the one holding the row. That
objection is real in a system issuing thousands of documents a second. This one issues **tens a day**.
Two therapists and a reception desk cannot generate contention worth measuring, and if they ever
could, the correct response would be more series, not a leakier counter.

So the trade is stated the right way round: the mechanism that scales loses numbers, the mechanism
that loses no numbers does not scale, and this business needs the second one.

## Why the counter is unreachable except through a function

`allocate_document_number()` is `SECURITY DEFINER` with a pinned `search_path`, and the application
role holds **no `UPDATE` privilege on `next_number` or `period_key`** — only on the format columns
(`prefix`, `padding`, `reset_policy`). It holds no `INSERT` or `DELETE` on the table at all.

A gap is recoverable evidence: you can show what was voided. A **duplicate** is not — two customers
hold the same invoice reference and neither copy is wrong. Any code path able to write `next_number`
directly, including an injected statement, can produce one. Removing the privilege removes the class.

The cost, accepted: adding or retiring a statutory series is a migration, not a settings screen. That
is the correct weight for the decision anyway — a series inserted at `next_number = 500` starts its
issued range at 500, which the gap report then reports forever.

## Why the formatted number is stored, not derived

`display_number` (`TI-2026-00042`) is composed once, by `document_number_display()` in the database,
and stored on the document. It is never re-derived from `prefix + number` at read time, and the format
is deliberately **not** reimplemented in TypeScript.

Both halves matter. Re-deriving would mean an admin changing a prefix renumbers every invoice already
filed and already in a customer's inbox. Reimplementing the format in the application would give a
statutory identifier two definitions, and the day they disagree is discovered on a document that has
already been filed under one of them.

One detail that looks like a formatting nicety and is not: padding is a **minimum** width. `lpad()`
truncates when the value is wider than the pad, so a series padded to three would render number 1000
as `100` — byte-identical to number 100's identifier, in a value whose entire job is to identify one
document.

## Consequences

- **Every document insert must call `allocateDocumentNumber` inside its own transaction.** The
  repository takes a `UnitOfWork` rather than a connection so there is no signature that compiles for
  the allocate-then-insert-later shape. This is the single rule a later document module can break.
- The counter row is a serialisation point. A long-running transaction that allocates early and then
  does slow work — a PDF render, a provider call — blocks every other issuer for its whole duration.
  Allocate last, commit fast.
- `pg_dump`/restore carries the counter correctly, which a sequence's `setval` state notoriously does
  not when a table is restored without its sequence.
- Gap reporting (`findNumberingGaps`) is `number - row_number() over (partition by series, period
  order by number)`, which is constant within a contiguous run and **zero** for a run starting at 1.
  Any returned row is a gap, a duplicate, or a range that does not start at 1.
- Annual reset makes the period part of the identity, so the gap report partitions on
  `(series, period)`. `TI-2026-00001` and `TI-2027-00001` are different documents, not a duplicate.

## Rejected

**A `SEQUENCE` plus a nightly gap-repair job.** Rejected because a number consumed by a rollback
cannot be recovered after the fact — there is no record of what it would have been attached to — and
because a job that rewrites issued document numbers is a worse control than the gap it closes.

**Allocating at commit time with a trigger.** Rejected: it hides the serialisation point from the code
that causes it, and a `BEFORE INSERT` trigger reading a counter has exactly the same locking behaviour
with none of the visibility.

**A separate numbering service or advisory locks.** Rejected as a distributed transaction with extra
steps. The number and the document must commit together or not at all, which is what one transaction
already means.

## See also

- [ADR 0017](0017-accounting-journal-and-no-auto-filing.md) — append-only journal, corrections by
  dated reversal, and why invoice numbering has to be gap-free.
- [ADR 0006](0006-sql-first-migrations.md) — the migration is the schema; Drizzle mirrors it.
- `docs/03-modules.md` §7 and `packages/db/migrations/0013_document_series.sql`.

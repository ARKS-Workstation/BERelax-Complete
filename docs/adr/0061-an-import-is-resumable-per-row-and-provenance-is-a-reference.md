# ADR 0061 — an import commits one row at a time, and provenance is a reference rather than a copy

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** H-MIG-01
- **Covers:** docs/01 decisions — none. This is the storage- and transaction-shaped consequence of
  [ADR 0008](0008-unit-of-work-and-exactly-once-per-handler.md) for the migration workstream; it locks a
  mechanism every H-MIG importer inherits, not a new scope decision.

## Decision

**Every H-MIG import runs through one function, `runImport`, and commits ONE SOURCE ROW AT A TIME. The
entity insert, its provenance row, its audit row, its outbox event and the staged row's
`pending` -> `applied` transition share that transaction and no state is recorded outside it. Provenance is a
REFERENCE — `(target_schema, target_table, target_id)` plus the staged row's id — and carries no copy of the
source file, the line number or the content hash; those live once each and resolve through one view. A row
that reaches `applied` with no provenance cannot be COMMITTED (`ZY196`, a deferred constraint trigger), and a
dry run forces the deferred constraints before it rolls back.**

Migration 0111 is the schema. `packages/migration/src/framework.ts` is the only write path, and
`packages/migration/src/write-path.test.ts` is what keeps it the only one.

The constraint everything here follows from is stated in H-MIG-01's own manifest entry: **there is no
incumbent export.** Every figure that arrives through this schema comes from a spreadsheet a human typed.
There is no foreign primary key to reconcile against, nothing to re-query, and no way to re-derive a row once
the file has been edited — so the only identity a source row has is (file, line, content hash), and the only
defence of an imported figure is that those three are recorded and still resolve.

## The alternatives, and the specific way each fails

**Batch the rows.** One transaction per batch, or per file, is faster and is what an importer written in an
afternoon does. It fails at the only moment that matters: the process dies, and the database holds either all
of the batch or none of it with nothing saying which rows of the FILE were in flight. The recovery is then to
re-run the import into a database that already holds part of the data, and the only safe way to do that is to
know, per row, what was applied — which is the record a per-row commit already is. An import that cannot be
resumed is an import that is run twice, and the second run of a package-liability import is a second
liability.

**Let the importer record its own provenance.** It is one line at each call site and it is the shape that
cannot be enforced: the database has no way to see an INSERT into an arbitrary target table, so "every
imported row has provenance" would be a claim about nine importers rather than a rule. Instead `apply`
RETURNS the entities it created and the framework writes the provenance row — which makes the reachable
mistake (returning nothing after inserting something) a COMMIT-time refusal rather than a figure nobody can
defend. It also keeps the provenance shape in one module, so the nine importers cannot disagree about it.

**Copy the file, line and hash onto every provenance row.** Faster to read, and wrong in a way nobody would
see. A provenance row holding its own copy of the file hash cannot be checked against the run it came from,
so a corrected re-import that edited a single row of the spreadsheet would leave provenance claiming a hash
the file no longer has — and the claim would still resolve, cleanly, to the wrong evidence. The reference
version cannot say anything the ledger does not say.

**Make the provenance rule an immediate trigger.** An immediate trigger would force provenance to be written
before the staged row is marked applied, which is a rule about statement ORDER rather than about state. A
reasonable importer that marked the row and then wrote provenance would be refused for nothing. Deferred to
COMMIT, the rule is exactly the claim it means: you may not commit an applied row with no provenance.

**Let the dry run simply roll back.** This is the one that would have shipped silently. Every constraint
trigger in `import_staging` is deferred, so a transaction that never commits never fires one — and the
rehearsal whose whole purpose is to find out what a live run would refuse would report success over exactly
that. `set constraints all immediate` before the rollback is one line, and without it the rehearsal is weaker
than the run it rehearses.

## What follows from it

- **An importer cannot open its own transaction.** `apply` is handed the unit of work the framework opened.
  Anything an importer needs to do atomically with the row it is importing goes in that transaction; anything
  it wants to do afterwards is a different import.
- **Idempotence is decided on the row's content hash**, against the `applied` rows of COMPLETED runs. A
  re-saved spreadsheet rewrites every byte of every line without changing a value, so hashing the raw line
  would re-import the file. This is why `ZY198` exists: a run that reached `completed` with rows still
  pending would make the next import skip rows that were never imported, which is the only failure in this
  schema that loses data while reporting success.
- **The staging ledger is append-only and nothing deletes an import.** Both foreign keys are ON DELETE
  RESTRICT and the application role holds no DELETE or TRUNCATE in the schema. A run that should not have
  happened is recorded as having happened.
- **One import, one file, one actor.** The run records the importer's VERSION as well as its name, because a
  figure that disagrees with what the owner believes may be wrong through a typed digit or through this
  code's rounding, and without the version the second possibility is not investigable.
- **Every claim about an import is asserted by a checksum**, so the checksum is the thing whose being wrong
  would make the whole framework report success while measuring nothing. It therefore lives in the database —
  one implementation for the report and for every suite — an empty relation answers `empty:<relation>` rather
  than `md5('')`, and an exclusion list that has removed every column raises `ZY197` instead of returning a
  constant that compares equal for ever.
- **The cost to live with:** a per-row commit is slower than a batch, by roughly the cost of a transaction
  per row. For an import of a few thousand hand-typed rows that is seconds; for an import of a million rows
  it would not be, and the answer then is a different mechanism rather than a larger batch here — because the
  property being bought is per-row recoverability, and a batch of a hundred is only recoverable to a hundred
  rows.

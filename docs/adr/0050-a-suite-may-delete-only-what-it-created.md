# ADR 0050 — a suite may delete only what it created

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** W-SYS-13
- **Covers:** docs/01 decisions — none; this is a rule about the test estate rather than about the product,
  and it is the enforcement half of a hazard the contributing brief states (rule 12: the integration suite
  runs sequentially against ONE database and earlier files leave rows behind) but which nothing measured

## Decision

**A suite may remove rows it created. Anything wider is DECLARED, and every declaration is checked.**

Concretely, for every `delete` or `truncate` in a test file:

1. it carries a predicate, so it can only reach rows the suite can name; **or**
2. it is listed in `packages/db/src/suite-table-declarations.ts`, naming the file, the tables, why that
   suite may issue it, and — for a table the seed writes — the fixture loader that puts the rows back.

Three checks hold it, and they are deliberately in three places because each needs something the others do
not have:

- **The scan** (`packages/db/src/seeded-row-deletes.test.ts`, over
  `packages/db/src/suite-table-ownership.ts`) derives the offending set by reading the suites. It is a unit
  test; it needs no database and it can be run in a second.
- **The derivation** (`packages/fixtures/src/seeded-tables.itest.ts`) answers which tables the seed writes,
  by running the loaders against a real database inside a transaction it rolls back, and proves that a
  loader named as a restorer really can restore.
- **The run invariant** (`packages/fixtures/src/seeded-rows-global-setup.ts`, wired as the integration
  suite's `globalSetup`) reads the seeded rows before the run and again after it, with the loaders re-run in
  between. The run that lost a row is the run that fails.

The offending set is never a written list of known sites. The 67 statements this unit was opened for were
the remainder after two were fixed, and a check against that remainder would have passed the sixty-eighth.

## Why the rule needs three checks and not one

Each check can prove exactly one kind of claim, and a declaration makes three.

"This statement names a table and no rows" is a fact about source, so the scan can settle it. "The seed
writes this table" is a fact about a database, so only something with one can settle it. "This suite's
declaration is TRUE — the rows really do come back" is a fact about a whole run, and neither of the first
two can see it: whichever file a test sits in, it runs at one point in an order no file controls.

That last one is why the invariant is a `globalSetup` rather than a test. The symptom of this defect never
appears in the file that caused it. It appeared as `sell-package.itest.ts` skipping all 21 of its cases with
"the seed creates customers", as M-TILL-13 measuring 140 tables where 153 were expected, and as a salon
answering about a rota it no longer had.

## Why a declaration and not a ban

A ban would be wrong, and the invoice family is why. `invoice` refuses DELETE for every role, so TRUNCATE by
its owner is the only legal removal — and PostgreSQL refuses a truncate while a table referencing one of the
named tables is missing from the statement, which is why those statements are lists of six or eight names.
Nine suites legitimately start from no invoice, because each numbers its own documents from the `TAX-INV`
series and asserts on the number it got.

What was wrong was that this was a convention in comments. Truncating the invoice family as its owner is now
a declaration: a line naming the file, the tables and the reason, which a reader can disagree with and a
check can refuse when it stops being true.

## Why `customer` can never be declared

`packages/db/src/suite-table-declarations.ts` holds `NEVER_DECLARABLE`, and `customer` is in it. The
allowlist for that table was empty and had to STAY empty, which a comment cannot enforce.

It is not a stricter rule for its own sake. Measured: on a database whose customers a suite had removed,
re-running `pnpm seed` left the rows missing wherever a loader short-circuits on a non-empty table — and
`package_sale.customer_id` is `on delete restrict` while `package_sale` refuses DELETE, so a single seeded
sale pins its customer for the life of the database. There is no loader that can be named as the restorer,
because no loader can be one.

## A loader that cannot repair what it created is part of this rule

`seedPackageTemplates` short-circuited on `count(*) from package_template > 0` — idempotent per TABLE. Two
consequences, and both are the rule:

- a PARTLY emptied family looks seeded. Truncate the versions and the lines, leave the templates standing,
  and the loader reported "nothing to do" for ever after: four templates with no version, which every reader
  treats as four templates that do not exist. This is the general shape of the 140-of-153 measurement.
- a loader that reaches for nothing on a healthy database is invisible to the derivation, so the tables it
  owns drop out of the set the invariant watches, and every check built on that set goes on passing. The
  guard is per-loader attribution: a loader that issues no write at all fails
  `every-loader-reaches-for-its-tables`.

So the loader is now idempotent per template KEY, and it ensures its template rows in every state — which is
the loader saying, in a way the derivation can read, which table it owns.

## Why the seeded set is derived from statements rather than from row counts

Counting rows before and after a seed sounds stronger and is useless here. Every loader is idempotent, so on
a database that has already been seeded the row diff is zero everywhere. Emptying the database first is not
available either: `seedCatalogue` reads the `service` rows migration 0017 creates and refuses to invent them,
so a fully truncated database cannot be seeded at all.

What a loader *reaches for* is observable in every state, which is what makes the derivation work against
the database the suites actually run against. Its limit is stated where it lives: a table written only when a
repair is needed — `package_template_version`, `package_template_line` — is not in the derived set on a
healthy database. Those two are covered by the repair property instead, which is stronger evidence anyway.

## What this costs, measured

The derivation is one rolled-back transaction: 508 ms on this container, nine loaders, seventeen tables. The
before-and-after reads are counts and primary keys for those tables, about 370 rows. The repair at teardown
is `pnpm seed`, about 8 s. Against an integration suite measured in tens of minutes, that is not a budget
question.

## The alternative, and the specific way it fails

The alternative was what existed: `packages/db/src/seeded-row-deletes.test.ts` scanning for
`delete from customer` and `truncate … customer …` by name.

It was the right thing to write at the time — it held the line where damage was proven — and it could not
generalise, for a reason worth stating. It is a rule about ONE table in TWO syntactic shapes. Everything it
does not name is permitted, and nothing says which tables those are: 67 statements stood against `premises`,
`business_day`, `app_setting`, `premises_hours`, `message_template`, `package_template` and others while it
was green. A pattern per table would be 17 patterns that go stale the first time a loader is added, and the
staleness is silent — a pattern that stops matching reports no offences, which reads exactly like a
repository with no offences (ADR 0002).

The second failure is subtler and is why the comment rule is part of this ADR. Nine files ordered their own
cleanup around two suites clearing the `customer` table and wrote that down in the present tense. Both
statements were then scoped, and every one of those sentences became a description of something that does not
happen — in files whose own reason for their own cleanup then had to be reconstructed from a false premise.
A file documenting another file's cleanup is a statement that drifts when that file is fixed. So a comment
states its own suite's reason, and the check that holds it is derived: a restatement is allowed only while
the file it names really does hold that statement, which makes the sentence fail at the moment the other file
is fixed rather than years later when somebody reads it.

## Consequences

- Adding an unqualified `delete` or `truncate` to a test file now costs a line of declaration, or a
  predicate. Both are cheap and the second is usually right.
- A suite that empties a seeded table must name the loader that repairs it, and the run proves the claim.
- The integration run does one extra derivation, two reads and one seed. It also leaves the database seeded,
  which is the state the next run wants.
- A declaration that stops describing a statement fails, so the table shrinks when the suites improve. An
  entry left behind is standing permission to put the statement back, which is how the allowlist this
  replaced came to exist.

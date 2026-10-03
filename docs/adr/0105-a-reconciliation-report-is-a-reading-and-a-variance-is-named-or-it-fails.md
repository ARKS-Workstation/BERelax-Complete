# ADR 0105 — a reconciliation report is a READING, its run instant lives outside the compared content, and a variance is named or it fails

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-MIG-08
- **Covers:** docs/01 decisions — none new. It is the reporting-shaped consequence of
  [ADR 0061](0061-an-import-is-resumable-per-row-and-provenance-is-a-reference.md) (provenance is a
  reference, so every imported figure resolves to the line it was typed on) meeting
  [ADR 0070](0070-an-unattributable-cost-is-a-refusal-and-never-a-zero.md) (an unattributable figure is a
  refusal and never a zero), and it is what H-MIG-09's gate reads. It stands on
  [ADR 0007](0007-money-and-business-day-primitives.md) (integer fils, so a residual is an integer),
  [ADR 0065](0065-a-reconstructed-balance-is-validated-against-the-workbook-and-an-attested-one-is-admitted.md)
  (a workbook is all-or-nothing on validity, which is why two of the five record relations can hold no
  quarantine at all), [ADR 0069](0069-a-reconstructed-package-sale-is-the-outstanding-entitlement-held-to-its-workbook-row.md),
  [ADR 0072](0072-the-consent-floor-is-a-refusal-and-the-import-ledger-stages-a-digest.md),
  [ADR 0082](0082-a-reconstructed-visit-is-history-the-live-machine-cannot-touch.md),
  [ADR 0083](0083-a-staff-import-writes-the-facts-the-file-carried-and-infers-nothing.md) and
  [ADR 0084](0084-an-opening-position-is-attested-once-and-nothing-is-dated-behind-its-boundary.md),
  which are the seven importers this report is about.

## Decision

**Three things, and each one is a shape rather than a figure.**

1. **The report is a READING.** `generateReconciliationReport` takes an `Sql` and never a `UnitOfWork`,
   writes nothing, opens no transaction, adds no table, no migration and no private SQLSTATE, and is
   absent from `packages/migration/src/write-path.test.ts`'s permitted write path for the same reason it
   is absent from `IMPORTERS`.

2. **The run instant is held OUTSIDE the compared content.** `ReconciliationReport` holds no timestamp
   anywhere — not `generatedAt`, and not the `started_at` / `finished_at` of any `import_run`, which are
   not even selected. The instant is on the wrapper, `ReconciliationRun = { generatedAt, contentDigest,
   report }`, and `contentDigest` is the sha-256 of `report`'s canonical form. Two runs are held equal on
   `report` and on that digest.

3. **A variance is tied to a named cause or it is UNEXPLAINED, and an unexplained one fails.** Every
   variance is `sourceFigure - importedFigure` for one measure of one source file, decomposed into
   contributions from a closed vocabulary of three — `rejected_rows`, `skipped_already_imported`,
   `pending_rows` — each carrying its own MEASURED magnitude in the variance's own units. What is left
   over is the residual, and any non-zero residual on any measure makes the command's exit status 1.
   There is no epsilon, no rounding allowance and no "close enough".

## Why the instant cannot be inside the report, which is the non-obvious one

The acceptance line reads "two runs on the same seed produce byte-identical reports apart from the
declared run timestamp", and the obvious implementation satisfies its words and not its purpose: put
`generatedAt` on the report and compare the two with that field excluded. Then the thing being compared is
not an artefact anybody holds. It is a projection computed at comparison time, by code that has to know
which fields to drop — and the list of fields to drop is exactly the kind of second statement this
repository keeps paying for. The first `ranAt`, `asOf` or `importedAt` somebody adds to a nested row is
outside that list, the comparison starts failing for a reason that proves nothing, and the response is to
widen the exclusion list until it is wider than the claim.

So the artefact is split instead. `report` is the thing that is compared, and it is compared whole: no
exclusions, no projection, `JSON.stringify` on one side and `JSON.stringify` on the other. A timestamp
added anywhere inside it breaks the determinism test immediately and visibly, which is the correct
response rather than a nuisance. `contentDigest` is the same claim in a form a gate can hold across
processes, which is what `scripts/check-dry-runs.mjs` needs one unit later.

The same split decides the human-readable form: `renderReconciliationRun` prints the instant in a header
ABOVE the body and `renderReconciliationReport` puts it nowhere inside, so the body of two runs over the
same data is byte-identical too. A report whose machine form was comparable and whose human form was not
would be two forms of one report that disagree about what they are.

## Why the causes are SUBTRACTED and not listed

A report that annotated — "this file had rejections" — would call a four-row variance explained because
one row was rejected. Each cause therefore carries its magnitude and the residual is arithmetic: three
rows of four are accounted for and **the fourth is the one somebody has to go and find**. The three causes
are not a judgement about what is forgivable; they are the three states of `import_staging.import_row`
that account for a staged row producing no entity, and a fourth cause would have to be a fourth row state.
There is none.

**A quarantine is deliberately NOT a cause.** A quarantined line DOES produce a record row — that is what
`imported_contact.outcome = 'quarantined'` is (ADR 0072), and `imported_appointment` and
`imported_staff_row` the same (ADRs 0082 and 0083) — so it appears on both sides of the count and
contributes nothing to a variance. Listing it would be an allowance for a difference that does not exist,
and the first row it absorbed would be a real one.

**The money contributions are measured in fils per row state, not inferred from a row count.** A rejected
row and a skipped row are not the same money, and a count-based allowance would absorb the difference
between them.

### The one tolerance that exists, stated rather than hidden

A REJECTED row's money cell is allowed to be unreadable, because that is frequently why it was rejected —
`price-not-integer-fils` is one of H-MIG-02's named rejections. Such a row is excluded from the source
total AND from every cause, so the residual is unaffected, and the count of them is reported as
`unreadableMoneyCells` so a total summed over fewer rows than the file has says so. On an applied, skipped
or pending row the same cell is a REFUSAL: it passed `validate`, so an unreadable value there is a
disagreement between the validator and the reader, and reporting it as 0 would make the file total quietly
smaller than the file. That asymmetry is the whole of the allowance and it is one branch of one function.

## Why the imported side is read through PROVENANCE and not through the target table

`importedRows` counts `import_staging.import_provenance` rows for the run whose target is that importer's
record relation — not rows of the relation. Three consequences, and the second is why:

- a second import of a second file reconciles separately, instead of both files reconciling against the
  sum of the table;
- **a record row that no staged row explains is INVISIBLE to the count and visible to the quarantine
  reconciliation**, which is where it belongs. `enumerated` joins quarantined rows to provenance with an
  INNER join and `counted` counts them in SQL without touching provenance, so a hand-inserted record is
  `counted` and not `enumerated`, and the difference has no named cause. That is the planted single-row
  discrepancy the third acceptance line asks for, and it is the only discrepancy that CAN be planted: the
  staging ledger is immutable (ZY192) and append-only (ZY195), so a row cannot be taken out of it — the
  only way a record and the ledger can disagree is a record that arrived from outside it;
- a LEFT JOIN there would have enumerated such a row with empty provenance fields, which reads as a row
  that came from nowhere and reconciles.

## Why the two forms have no field list anywhere

`reportFigures` walks the report generically and yields one `path = value` pair per leaf;
`renderReconciliationReport` renders nothing but those pairs under headings derived from the paths. A
hand-written list of headings and figures satisfies "generated from one source" in letter and is the thing
the line is aimed at: it drifts the first time a field is added, and the symptom is a page a person reads
that is missing a figure the JSON holds, with both forms still looking complete. `render.test.ts` counts
the leaves of the machine form independently of the renderer and requires one line per leaf.

A null leaf renders as `—` and never as `0` or as blank, which is ADR 0070 in one character.

## What this costs

- **No migration and no private SQLSTATE, and that is the same conclusion ADR 0070 reached for R-REP-04.**
  Every refusal here is a refusal of ARITHMETIC — an unreadable money cell on an applied row, a run of an
  importer the report has no record relation for, a fractional contribution — and none of them can be
  raised by the database, because there is no new relation and nothing is written. A private code is for a
  refusal that needs a runbook answer at the database boundary (ADR 0043). The migration number **0152**
  and the band **ZY721–ZY730** are released unused, as is the test port band
  `{ start: 22_700, width: 300 }`: nothing here starts a server. `SCHEMA_VERSION` is untouched and no
  paragraph was added to the migration ledger, there being no migration to document.
- **`IMPORT_RECORDS` and `SOURCE_TOTALS` are a second statement of two facts each importer already
  states**, and they arrive with the checks that hold them equal in the same commit:
  `report/generate.test.ts` asserts the key set equals the six importers in the build, that every record
  relation is one the importer declares as a target, and that every payload key a source total reads is
  one that importer's own declared payload keys contain. A renamed cell is therefore a test failure rather
  than a total that silently reads zero.
- **The report describes the whole staging ledger, so it cannot assert zero unexplained variance about a
  shared database.** `migration-reconciliation.itest.ts` asserts the figures of the sources it created and
  the planted discrepancy as a DELTA, because the integration suite runs sequentially against one database
  and earlier files leave rows behind (brief rule 12). The zero-unexplained claim over a database with
  nothing else in it is H-MIG-09's, from a fresh restore, three times — which is the only place it can
  honestly be made.
- **Leave liability has no money figure and will not until Y8-staff is answered.**
  `employee.basic_wage_fils` is null for every employment record, so a money value for accrued leave would
  be a sum over an empty wage set — 0 fils, reading as a workforce owed nothing. The DAYS are measured and
  stated; the money is `unattributable` and names the question.

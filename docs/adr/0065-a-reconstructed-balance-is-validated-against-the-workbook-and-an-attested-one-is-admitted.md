# ADR 0065 — a reconstructed balance is validated against the workbook, and an attested one is admitted

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** H-MIG-02
- **Covers:** docs/01 decisions — none. This is the source-side consequence of
  [ADR 0061](0061-an-import-is-resumable-per-row-and-provenance-is-a-reference.md) for the artefacts that have
  no incumbent export; it locks the SHAPE of a hand-reconstructed source and the vocabulary its refusals use,
  not a new scope decision.

## Decision

**Where there is no system to export from, the WORKBOOK is the schema.** For outstanding packages that means:

- Its twelve columns are stated once (`WORKBOOK_COLUMNS`). The generator writes the header from that list, the
  parser demands it back, and the per-column instructions on the file's face come from the same entries. A
  file whose header is not the generated one is refused WHOLE, before any row has a verdict.
- The generated file is a pure function of the database: no timestamp, no run id, no serial number. Two
  generations against an unchanged database are the same bytes.
- Every row names its holder by phone in E.164, the `package_template` whose terms it inherits, what it paid
  in integer fils, its own session counts and its own expiry, the EVIDENCE the balance rests on, and the
  owner's sign-off **per row**.
- A row that contradicts ITSELF is refused: `sessions_remaining` is asked for although total minus used would
  give it, because a reconstructed balance has no second source and this is the only cross-check available.
- A file with any rejected row imports NOTHING, and the report names every rejected line as
  `<file>:<line>  <reason>` from a closed vocabulary (`PACKAGE_REJECTIONS`), each reason having a named fixture
  file that must produce exactly it.
- `evidence_kind` is a closed set, and `owner_attestation` — no document of any kind — is **admitted, counted
  separately and marked**, not refused.

## The alternatives, and the specific way each fails

**Ask only for what cannot be derived.** `sessions_remaining` is total minus used, and `expires_on` is the
purchase date plus the template's validity. A form that asks for neither is shorter and has NOTHING to check:
every figure in it is a single unverifiable assertion, so a transposed digit in `sessions_used` becomes a
balance and the first symptom is a customer at the desk being told they have two sessions when they have
four. Asking for the redundant figure is what converts a typing mistake into a refusal. Deriving the expiry
fails differently and worse: the validity was provisional when the package was sold and may not have been six
months, so a derived expiry would silently restate a term the customer agreed to.

**Refuse a balance with no document.** The tempting reading of "the evidence it demands", and it is the wrong
direction. The business took the money; the absence of a receipt is a fact about the salon's record-keeping,
not about whether the liability exists. Refusing the row leaves a real obligation off the balance sheet AND
turns the customer away at the desk, against recording one whose support is a recollection — which costs
nothing as long as it is marked. Y9-package-thin's provisional answer is exactly this ("honour once on
evidence, logged"), so the vocabulary makes the distinction and H-MIG-03 makes the policy: the flag reaches
the customer record and the liability report.

**Import the valid rows and report the rest.** Standard for a tolerant importer and wrong for this artefact.
What is being imported is a LIABILITY: the sum of remaining package value has to equal the opening
deferred-revenue balance and reconcile to cash actually received (H-MIG-03's acceptance). A half-imported set
is a deferred-revenue figure that reconciles to nothing, and the person holding it cannot tell whether the
difference is a missing row or a wrong one. All-or-nothing also makes the report useful in the only way that
matters here — every bad line at once, for one correcting pass over the spreadsheet rather than nine.

**Cross-check the price against the template, and the expiry against the validity.** Both would refuse real
liabilities. A package may have been sold at a discount nobody recorded, and under terms this build has never
seen; the workbook's whole premise is that these are the packages the system has never held. The figure the
price has to reconcile to is cash received, which is a property of the FILE and not of a row.

**Let the reasons be messages.** `import_row.outcome_detail` is free text, deliberately — H-MIG-01 refused to
put a CHECK on it because a list in the schema would be a second list for this unit's to disagree with. Free
text at the database is not licence to write prose at the caller: nobody can branch on a sentence, a reworded
one silently stops matching whatever matched it, and the acceptance line asks for *named* malformed fixtures.
So the vocabulary is a constant, each reason has a fixture file, and the test iterates the pairing.

**A per-file sign-off instead of a per-row one.** H-MIG-03 stores the file-level sign-off, against the hash of
the file it attests to, and that is the right shape for the reconstruction as a whole. It is not a substitute
for the column: a signature over rows nobody read individually is how a wrong balance gets signed for, and the
per-row flag is what makes "the owner has seen this liability" a statement about each liability.

## What follows from it

- **One reason per row, in a stated order**: identity, then the file contradicting itself, then the figures,
  then the evidence and the sign-off. A row whose holder or template cannot be read is not a row with a bad
  number — it is a row nobody can say what liability it is about — so reporting the price would send somebody
  to the wrong cell. Each committed fixture therefore breaks exactly ONE cell, and the test asserts the file
  produced exactly one rejection carrying the named reason: a fixture that broke two would still report one,
  and the case would pass with the rule it names unexercised.
- **Validation takes the template keys as an argument.** `ImporterDefinition.validate` is synchronous and sees
  only the payload (ADR 0061), so the caller reads the keys once and hands them in. That keeps the validator
  pure and testable with nothing running, and it is what lets the same code answer the generator, the
  command-line validator and H-MIG-03's importer.
- **A RETIRED template is still a template a row may name.** `retired_at` withdraws a package from sale and
  leaves the balances sold under it redeemable (migration 0078), which is the ordinary case here. The
  workbook's reference block lists only the live ones, because that is what somebody filling in a new row
  should choose from, and the validator answers the wider question — whether the terms exist at all. A
  template with no VERSION is refused with its own reason, because "unknown" would send somebody to create a
  template that is already there.
- **A column added later is a change to files people have already filled in.** The header refusal is what
  makes that visible instead of silently parsing rows into the wrong fields, and the cost is that every
  outstanding copy has to be regenerated and re-pasted. That is the right cost: the alternative is a workbook
  that accepts a file whose `sessions_used` column holds a price.
- **The generator must stay pure.** `import_run.source_file_hash` is the sha-256 of the file's bytes and
  H-MIG-03's sign-off attests to that hash, so a timestamp in the preamble would give every regeneration a
  different identity — and a person who regenerated the blank before filling it in would hold a file no
  sign-off could be about.
- **The cost to live with:** twelve columns is a lot to ask of somebody reconstructing a hundred packages from
  a drawer, and two of them are redundant by construction. That is the price of the only cross-check this
  source has. The other cost is that nothing here can be *verified* — a signed-off workbook is the best
  evidence that will ever exist for these figures, so the marker on an attested row is permanent rather than
  something a later reconciliation clears.

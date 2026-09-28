# ADR 0047 — a commission run is reproducible because it pins the version that judged it and the instant it read

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** P-HR-11
- **Covers:** docs/01 decisions — none; this is the mechanism behind the therapist commission docs/03 §7
  describes, and it sits under ADR 0007 (money is integer fils, gross authoritative) and ADR 0008 (unit of
  work, append-only records)

## Decision

A commission figure has to survive being asked about. "Why is my March 1,904 fils and not 2,857?" is a
question about a month that has already been paid, and the only answer that holds is the same computation
producing the same bytes. Four things make it so, and each one is a refusal to let a fact be resolved twice.

1. **The rule version is stored on the run, and a recompute takes it from there.** `commission_run
   .rule_version_id` is `not null`; `commission_line` carries the same column and a COMPOSITE foreign key
   `(run_id, rule_version_id) → commission_run (id, rule_version_id)` makes the two ONE fact rather than a
   copy somebody keeps in step. `recomputeCommissionRun` is a separate function from
   `executeCommissionRun` and finds the version BY ID; only the first run resolves by date, through
   `commissionRuleFor` in `@berelax/core`.

2. **The instant the source figures were read at is stored too, and for a filed period it is the lock's.**
   `commission_run.source_as_of` bounds every clause of the earnings read (`created_at <= …`), and
   `assert_commission_run_reads_the_lock` (ZY076) refuses a run over a period `period_lock` covers whose
   `source_as_of` is not that lock's own `locked_at`. So a payment applied after the close, or a sale
   backdated into a filed month, cannot move a figure that has been paid.

3. **A published version is immutable and a run is evidence.** `refuse_commission_rule_change` (ZY071) and
   `refuse_commission_run_change` (ZY072) refuse every UPDATE and DELETE for every role including the owner,
   and the application role holds neither privilege. A rate that is wrong is a NEW version naming the one it
   supersedes; a run that is wrong is a NEW run, whose purpose is to be compared with the first.

4. **A line's band, rate and figure are held to the version it names, by the database.**
   `assert_commission_line_follows_its_rule` (ZY077) recomputes the figure with `commission_fils_for()` and
   compares. Without it a run could store anything and satisfy every constraint above, so "recomputing
   reproduces the stored line" would be a claim about whichever program wrote the row.

## Why the figures are rows and NOTHING is seeded

`docs/OPEN-QUESTIONS.md` Y9-commission is open, and its provisional answer is not a number: **no commission
structure is configured, and the module ships disabled.** So `commission_rule` seeds no version, unlike
`working_hours_rule` (0059), `leave_entitlement_rule` (0066), `rota_coverage_rule` (0081) and
`attendance_grace_rule` (0086) — each of which seeds the build's strictest reading of a law that exists to be
read. There is no law about commission and no figure in the handover.

An empty table is therefore the strictest safe option: `commissionRuleFor` throws, `planCommissionRun`
reports `no_rule_version`, and nothing can be paid at a rate nobody chose. A seeded "10%" would be
indistinguishable from an agreed one on the payslip that resulted, which is brief rule 15's whole subject and
is sharper here than anywhere else in this build, because what the figure decides is somebody's pay.

The module being off is `hr.commission_enabled` in the settings registry — `false`, `OWNER_ONLY`, flagged
provisional against Y9-commission so it appears on the Unconfirmed Assumptions panel. A flag and not a
missing table, because docs/12 §1.3 is explicit that the switch is flipped by configuration rather than by a
code change: answering the question is one audited settings change plus one published version.

`commission_run.module_enabled` is recorded on every run for a related reason. A run that produced no lines
because the module is off and a run that produced no lines because nobody worked are the same empty table and
very different facts, and the first must never be reported as "no commission is due".

## The rounding direction is a versioned FIGURE, not a convention

It is worth one fil per line and real money over a month, and both available answers are defensible: `floor`
never overpays, `half_up` is what a spreadsheet does. Nobody has chosen. So `commission_rule.rounding_mode` is
a column with a closed set of two members, `commissionFilsFor` in `@berelax/core` implements exactly those
two, and an unknown mode RAISES rather than falling through — a mode nobody implemented silently becoming
`floor` is an unpublished rounding rule paying somebody less, and nothing would ever report it.

The same reasoning puts `basis` on the version: commission on the net or on the VAT-inclusive gross is a
business fact, VAT is not the salon's money, and neither reading is guessed here. The column is `not null`
with no default, so a version cannot be published without somebody saying which.

## What the shape deliberately CANNOT express

`commission_rule_band` holds rates as ordered rows over the value of the APPOINTMENT, which covers the two
readings that are arithmetic: one band from zero is a flat percentage, several ascending bands are a tiered
one. Two other readings exist and this schema refuses to guess at either:

- a tier over the MONTH'S running total, which makes the figure depend on the order the month is walked in
  and therefore needs a stated order to be reproducible at all;
- a per-SERVICE rate.

Either is a new column and a NEW version, never a reinterpretation of rows already published. Both are
recorded on Y9-commission as part of what answering it must state. Whether a credit note raised after a
commission was paid claws it back is recorded there too: the earnings read excludes a credited document as
the strictest safe reading, and a CLAWBACK is a different rule nobody has stated.

## Three alternatives, and why each is worse

- **Resolve the rule version at read time from the effective date.** This is the defect, not the
  alternative, and it looks like working code: a rate published in June answers for March, the arithmetic is
  correct the whole way, and the only symptom is a figure that differs from the payslip. The superseding
  version in `packages/fixtures/src/hr-commission.itest.ts` is effective-dated BEFORE the closed month for
  exactly this reason — a fresh resolve really would pick it, which is what makes the reproduction a claim
  about the pin rather than about the calendar.
- **Store the computed lines and call a recompute unnecessary.** Then nothing ever checks that the stored
  figures follow from the rules, and the first time somebody asks, the answer is "because the table says so".
  The recompute IS the proof, and ZY077 is what makes each line independently checkable by a `psql` session.
- **Let the header total be a sum of the lines.** A sum cannot disagree with its own rows, so the derivation
  view's "rows summing exactly to the header total" would be a claim about nothing. `total_fils` and
  `line_count` are independent figures and `assert_commission_run_matches_its_lines` (ZY074) holds them
  equal at COMMIT.

## The consequence to live with

A period may hold several runs and they may say different things, because each names the version and the
instant that produced it. That is the correct residue and it is deliberately not tidied away: a run is not
superseded by a later one, it is *joined* by it, and the screen prints both with their versions. What must
never happen — one run whose figures change — is the thing every trigger in `0097_hr_commission.sql` exists
to refuse.

## A defect this unit shipped, recorded because it will recur

`${iso}::timestamptz` in a postgres.js template is sent as an OID 1184 parameter and serialised by the
driver's own date serialiser, `new Date(v).toISOString()` — **millisecond** precision. A `timestamptz` column
holds microseconds, so the `locked_at` the repository had just read out of `period_lock` arrived 633
microseconds early and ZY076 refused every run over the filed month. `psql` with the same literal is exact
either way, so it cannot be found without going through the driver. Every instant parameter is now written
`${iso}::text::timestamptz`, and `packages/fixtures/src/hr-commission.test.ts` scans for the bare form,
because the next instant parameter added there would have the same defect and the symptom would again name
the trigger rather than the cast.

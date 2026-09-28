# ADR 0044 — a filed VAT return is a snapshot of bytes, not a query over the ledger

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** M-VAT-08
- **Covers:** docs/01 decisions — none; this is the mechanism behind the VAT return, and it is the other half
  of the decision ADR 0017 already argued (docs/01 decision 13 says this system keeps an internal journal and
  has *no capability to file tax*; that record says what is never built, and this one says what the artefact a
  human files is made of, and who has to have signed it)

## Decision

**The VAT return is stored as the canonical BYTES of its own working paper, with a sha256 over exactly those
bytes; everything a caller reads afterwards is a projection of that stored text, never a recomputation from
the journal. It becomes final only when two DIFFERENT people in the accountant or owner role have signed it,
and a correction is a new version naming the one it supersedes.**

Concretely, six refusals in the database, each of which holds when the other five are absent:

1. **`content_hash = encode(sha256(convert_to(snapshot_json, 'UTF8')), 'hex')`, as a CHECK.** The same value
   `vat201ContentHash()` computes in TypeScript over the same bytes. A hash of anything but the stored text
   cannot be stored, during a restore with triggers off as well, and any reader can reproduce it from the
   row.
2. **The figures are VIEWS over `snapshot_json`.** `vat_return_box_figure` and
   `vat_return_not_fileable_reason` touch `vat_return` and nothing else. There is no join to `journal_line`,
   no call to `vat201_box_total()`, and gate case 122x asserts that over the view definitions with a fixture
   that plants such a join and requires it to be found.
3. **`vat_return`, `vat_return_sign_off` and `vat_return_finalisation` are append-only for every role
   including the owner** — a BEFORE trigger pair raising `ZY051`, with `update`, `delete` and `truncate`
   revoked from `berelax_app` as well, because the two answer different questions ("may this role" and "may
   anybody").
4. **Preparer and reviewer are two different people, refused in the database.**
   `unique (return_id, signatory_user_id)` is the storage layer; `ZY052` (`SamePersonSignOff`) fires first and
   names the person and the capacity they already signed in. Who may sign at all is a CHECK against
   `vat_return_signing_roles()`, with `ZY053` naming the permitted set.
5. **An unsigned return cannot be marked final and cannot be read for filing.** `ZY055`, from a BEFORE INSERT
   trigger on `vat_return_finalisation` and from `vat_return_for_filing()` — a read as well as a write. Both
   call `vat_return_sign_off_state()`, the single reader of "is this signed".
6. **`fileable = true` is impossible while the snapshot itself refuses filing.** A CHECK reads the hashed
   bytes: a `notFileableReasons` entry or a box marked `isProvisional` refuses it. Every box is provisional
   today, against [UNVERIFIED] Y11-vat201-boxes, and Y11-tax-agent records an FTA-registered tax agent's
   review as not optional.

## The alternative, and the specific way it fails

The obvious design is the one M-VAT-07 already built: a function of the ledger. `vat201WorkingPapers()` reads
`vat201_box_total()` over `vat201_box_line()` and recomputes every figure on every read. It is shorter, it has
no storage, it cannot go stale, and for a WORKING PAPER it is exactly right — it is what makes a box total and
the drill-down a preparer clicks into impossible to disagree by a fils.

For a FILED return it fails in a way nothing in the system would report. A return is a statement made on a
date about a period: "we declared 20,000 dirhams of standard-rated supplies and 1,000 of output tax, and these
two people signed it." Recomputed, that sentence is not stored anywhere — what is stored is a recipe, and the
answer it produces is whatever the ledger says today.

The failure is not hypothetical, and ADR 0026 is what makes it reachable: reopening a closed accounting period
is a migration, which means it is a thing this build expects to happen. The day it does — a period reopened to
post a correction an auditor asked for — every return already filed against that period would silently restate
itself. The hash would still verify, because the hash would be recomputed too. The signatures would still be
attached, to figures neither signatory ever saw. And nothing anywhere would say that the number on the filed
return and the number in the system had ever differed.

`packages/db/src/services/vat-return-signoff.itest.ts` reproduces exactly that: it snapshots a period, reopens
it, posts a second sale into it, closes it again, and requires the stored figures and the stored hash not to
move — with the control that the regenerated paper's hash DOES, because "the figures did not move" is also
what a ledger that did not move looks like.

There is a second alternative worth naming because it is the one a service layer reaches for first: **checking
the two signatories are different people in TypeScript.** It is three lines, and every one of its guarantees
is a guarantee about the callers that went through those three lines. 0087 recorded the same choice about the
promotional window — one function refused a widening and a seed, a settings import, a `psql` session and the
admin panel's own schema all accepted it — and 0093 recorded it about publication. Here the thing bypassed is a
signature on a tax filing, so the rule is a UNIQUE index and a trigger, and the service does not compare the
ids at all.

## The consequences somebody has to live with

**The figures are duplicated between the row's columns and the bytes, and that is paid for rather than
avoided.** Seven scalars — the period, its dates, the closed lock, the format version, the trial-balance hash
and `fileable` — are columns as well as JSON, because a return is looked up by period and a `psql` session
should not have to parse a document to answer which one it is holding. Two CHECKs compare each column with its
own value inside the snapshot, so the duplication cannot drift. The box figures are NOT duplicated, and that
asymmetry is the whole of decision 2 above: a second copy of a figure is the one kind of duplication SQL
cannot prove consistent.

**The figures carry no index.** A view cannot have one. That is acceptable because a VAT return is quarterly —
a few dozen rows a decade, each read by `id` — and it would not be acceptable for anything with a real row
count. A later unit that wants to report across many periods at once reads the columns, not the views.

**Answering Y11-vat201-boxes does not change a snapshot already taken, and must not.** The box numbers are
provisional and a migration will renumber `vat201_box`. There is deliberately no foreign key from
`vat_return_box_figure` to it: the snapshot records what the form said when it was signed, and a cascade would
rewrite history while a restrict would block the answer. So after the numbering is confirmed, old returns and
new returns describe different forms — which is the truth, and reading them together is a reconciliation
somebody has to do rather than a join the schema offers.

**An unsigned snapshot cannot be corrected, only superseded.** There is no draft state and no edit. A figure
noticed as wrong before anybody signed still costs a new version with a stated reason, and `ZY054` requires it
to be the next version of the period in force. That is more paperwork than a delete-and-retry, and it is the
point: a version that could be deleted before it was signed is a version somebody can make disappear.

**`closed_period_id` is a plain column and not a foreign key to `period_lock`.** 0086's releasable-pin test:
a lock can be deleted — four suites delete their own to be re-runnable — and a `vat_return` row can be deleted
by nobody, so a reference from here would pin every lock it names for ever. The evidence that the ledger was
what it was is `trial_balance_hash`, which needs no row to stay true.

**Every sign-off and every finalisation needs an `audit_event` in the same transaction**, checked at COMMIT by
a deferrable constraint trigger (`ZY057`). So a caller that writes a signature outside `signOffVatReturn` does
not merely lose the audit row — it cannot commit. That is the guarantee 0081 and 0093 already take this way,
and here the thing being evidenced is a person's name against a tax figure.

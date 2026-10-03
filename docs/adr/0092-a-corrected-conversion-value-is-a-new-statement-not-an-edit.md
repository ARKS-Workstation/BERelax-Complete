# ADR 0092 — a corrected conversion value is a new statement, not an edit

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-MEAS-05
- **Covers:** docs/01 decisions — none. Decision 14 is recorded in ADR 0018 and decision 19b (prepaid
  products) in ADR 0077; this is a mechanism under them, beside ADR 0091 (the dispatch consumer), ADR 0007
  (integer fils, VAT-inclusive gross authoritative), ADR 0008 (append-only) and ADR 0002 (a pass over
  nothing must not answer "all sent").

## Context

The till is what knows a walk-in happened, and it knows it hours or days after the visit. It also knows the
first figure was wrong: a treatment is discounted, an appointment becomes a no-show, a credit note is
raised three weeks later. A-MEAS-05 has to push all of that to platforms that have already been told a
number.

## Decision

**A conversion's value is an append-only LEDGER of statements, each with its own revision, its own instant
and a signed DELTA. Nothing is ever edited.** Three separate things in this build force it and they agree:

- **ZY451** freezes a transmitted dispatch's payload, because A-MEAS-07 reconciles internal truth against
  what was PUSHED, and a pushed side that can be edited to agree with the other is not a comparison.
- **The platform deduplicates on `event_id`.** A correction re-sent under the original's id is discarded,
  so the wrong number stays and the correction LOOKS like it worked — worse than it failing.
- **The journal is append-only** and a credit note is the only correction to an issued document
  (M-TILL-08). A conversion ledger that edited would disagree with the document ledger that cannot.

So a correction carries a revision, and the revision is a component of the `event_id`. **Revision 0
contributes nothing to the canonical form**, which is the one non-obvious decision here: the original
statement's id has to be the value the on-page tag derives, and the tag knows nothing about corrections —
it has a booking and a stage. A revision written into every id would have re-identified every event already
pushed, which is the same failure as shortening the digest.

The values are DELTAS because the platform's figure is the sum over the ids it has seen and the earlier ones
cannot be withdrawn. A no-show's void is therefore exactly the negative of everything already stated, which
is what makes *"a booking followed by a no-show sums to exactly zero fils"* an arithmetic claim rather than
a description — and the sum is asserted over `payload->>'valueFils'` on the rows themselves, not over the
statements in memory, because the writer has already encoded a whole payload as a jsonb *string* once.

Four figures follow from the same rule:

- a **credit note or partial refund** is `-gross`, and the sign is the ledger's to apply: the input is a
  positive credit, because a negative credit would push a positive value and report a refund as a sale;
- a **discounted invoice** pushes the DOCUMENT's gross and never the booking estimate, because
  VAT-inclusive gross is authoritative and the journal is keyed on the document;
- a **package sale** pushes ZERO and a **redemption** pushes what it released, which is the provisional
  `Y11-vat-package` position — and a sale is a zero-value statement rather than no statement at all,
  because a sale with no dispatch is indistinguishable from a sale the pass never saw, and that
  distinction is what A-MEAS-07's `missing` against `intentionally_not_pushed` rests on;
- **the instant is the visit's, the no-show's or the credit note's**, per statement, never the pass's. The
  database's own `occurred_at <= decided_at` cannot enforce it, because equality satisfies it and equality
  is exactly what a clock read in the wrong place produces — so `assertStatementIsInThePast` refuses it.
  The platform's accepted AGE for a past event is its own figure and is not on file in this build, so
  nothing is clamped to a window and no number stands in for one (brief rule 15).

## Consequences

**The pass refuses rather than guessing, twice, and counts both refusals.** Nothing in this schema joins an
analytics session to a booking — A-FIRST-08 owns attribution and is not built — so the session comes from
an injected resolver whose shipped implementation answers "nothing on file" for every conversion. The pass
still RUNS and the log line carries the count, because "no conversions were uploaded" has to read as *the
attribution is missing* rather than as *there were none*. A session chosen here would not be a wrong
report: it would be a conversion pushed under somebody else's consent decision, which the ZY312 gate cannot
catch because the session it was handed really did grant everything. The second refusal is the action
source, for ADR 0091's reason: the value a default reaches is `website`.

**It needed no migration and no SQLSTATE.** The revision lives in the derived id and the instants in columns
0137 already added, so ZY461-ZY470 are released unused. The cost is that the pass shares
`analytics_dispatch`' agent rather than declaring its own — the two passes are one pipeline, but the
consumer writes a heartbeat every five minutes, so this pass failing for a week is invisible to a per-agent
watchdog. A second agent needs an `agent_definition` and an `agent_heartbeat` row in a migration this unit
was allocated none of, and it is handed to A-MEAS-06, whose subject is the heartbeat and the watchdog for
exactly this dispatcher.

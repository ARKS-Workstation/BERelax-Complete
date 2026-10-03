# ADR 0093 — an unreconciled day has no revenue figure to render

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-MEAS-07
- **Covers:** docs/01 decisions — none. This is a mechanism beside ADR 0002 (a report that cannot
  distinguish "no conversions" from "conversions we failed to attribute" is worse than no report), ADR 0073
  (a figure the build refuses to produce is SEEN rather than rendered as zero), ADR 0091 (the dispatch
  consumer), ADR 0092 (a corrected conversion value is a new statement) and ADR 0008 (append-only).

## Context

A-MEAS-07 compares what this business says it took against what each advertising destination was actually
told. The comparison has three possible answers in the obvious design — a number, a number with a warning,
or an error — and all three are the same thing on a screen. A figure beside a warning is read as a figure.

## Decision

**The result is a discriminated union, and the `unreconciled` variant carries no revenue figure at all.**
Not a nullable number, not a number with a confidence flag, not a number in amber: `reconcileDispatches`
returns `{ kind: 'reconciled', …, pushedFils }` or `{ kind: 'unreconciled', …, differenceFils }`, and
`pushedFils` is absent from the second type. A caller that could read a figure off it would read it, so the
type is what makes the panel's behaviour hold rather than the panel's care. `revenueBySourceApiValue`
answers the word `Unreconciled`, and the renderer emits no figure ELEMENT — stronger than an empty one,
because a stylesheet cannot reveal a number that was never written and a screenshot cannot show one.

**Every difference is classified, and one of the three is not a discrepancy.** `missing` is a conversion
the platform was never successfully told about — and a `queued` or `failed` dispatch is `missing`, not a
fourth state, because the pass runs after the day has closed and the five-minute consumer has had time to
drain. `duplicate` carries BOTH dispatch ids, because "there is a duplicate" is not actionable and "these
two rows are the same conversion" is, and its value counts ONCE: the platform's figure is the sum over the
ids it has seen, so counting it twice would report a money disagreement that does not exist on a day whose
money is right. `intentionally_not_pushed` is the visitor's refusal, which 0125 recorded and the push
correctly never happened — counting it as missing would report a growing number of entirely correct
refusals as a fault, every day, for ever, and the first response to a number like that is to make it go
away. So it is named, counted, and kept out of both the difference and the `unreconciled` condition.

A fourth difference exists and is reported on its own list rather than squeezed into the three: a dispatch
whose event id has no internal conversion behind it. It is the more alarming direction — a platform told
about revenue the journal cannot produce — and it makes the day unreconciled. Folding it into `duplicate`
would have been the convenient lie; leaving it out would have been the silent one.

**The items are ROWS and the summary's counts are held equal to them by the database.** A count that cannot
be held against its items by a constraint is a number nobody can check, and the panel renders the counts —
so ZY471 is a DEFERRED constraint trigger comparing the two at COMMIT. Deferred and not immediate: an
immediate one would apply at the statement, so the WRITER'S ORDER would decide whether the rule held, and
it would pass for every write this pass makes and fail for the first caller that wrote its items first.

**A day that has not closed may not be reconciled** (ZY472). Trading runs 11:00–02:00, so a run while the
day is open compares this build's figures against dispatches the consumer has not attempted yet and reports
every one of them as `missing` — a screen saying the conversions did not go out, on the busiest part of the
evening. A CHECK cannot state it, because the closing instant is a row in `business_day`.

**Idempotence per business day is a PRIMARY KEY.** `(business_day, destination)` on the summary and
`(business_day, destination, event_id, classification)` on the item, so a second run cannot add a row; the
writer deletes that pair's items and upserts the summary in one transaction. An append-only history was the
alternative and is wrong here: a reconciliation is the current ANSWER to a question about a day, asked again
whenever the answer might have changed, and a table of every answer ever given makes "is this day
reconciled" a query with an ordering in it. The dispatch rows are the append-only record; this is the answer
about them.

## Consequences

**The internal side is injected and the shipped resolver refuses.** "Internal paid conversions from the
rollups" is A-FIRST-09's materialisation and it is not built, so the pass runs, finds no internal side,
writes NOTHING and says so in its log line. Writing a reconciliation from an empty internal side would
report every dispatch as a push with nothing behind it: a screen saying the money does not add up, every
morning, about a question nobody has asked yet. "No reconciliation today" has to read as *the rollups are
missing*, which is what the count in the log line is for and what the `agent_heartbeat` row makes
answerable at all.

**The ordering of the two passes is load-bearing.** A-MEAS-05 uploads at 03:17 and this runs at 04:23,
after trading closes at 02:00 and after the five-minute consumer has had time to drain what the upload
enqueued. A reconciliation that ran before the upload would report every offline conversion as missing —
the same failure ZY472 refuses for a day that is still open, arriving an hour later instead.

**A duplicate is unreachable through this build's writer, and the reconciliation can still express one.**
0137's unique `(event_id, destination)` index refuses a second row for the pair whichever call site inserts
it, so the classification is proved over a pure pushed list and the STORAGE is proved over two real
dispatch rows. That is deliberate rather than a gap: rows written before 0137 had no index, and a
reconciliation that could not express a duplicate would answer `reconciled` about one.

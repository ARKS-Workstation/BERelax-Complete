# ADR 0109 — a journey the DSL cannot express is a FINDING, not a second DSL; and a birthday has no year

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** C-AUTO-11
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/03 §5's stock journeys and
  behind milestone M3, and it stands on [ADR 0081](0081-misrouting-is-made-impossible-by-a-type-and-refused-again-at-the-api.md)
  (the typed composer), [ADR 0070](0070-an-unattributable-cost-is-a-refusal-and-never-a-zero.md)
  (a refusal, never a substituted value) and brief rule 15 (nothing invented)

## Context

C-AUTO-11's three journeys are the ones that earn the automation engine its keep. Three of its acceptance
clauses turned out to have no vocabulary in the DSL C-AUTO-06 defined and C-AUTO-09 typed, and one of its
provisional values turned out to be a decision about personal data rather than a figure.

## Decision 1 — what the DSL cannot express is reported, and the journey is composed anyway

**Every stock journey is a `composeJourney` literal.** Nothing writes a `FlowDefinition` by hand: the
wrong edges do not typecheck rather than being refused at publish time (ADR 0081), and a second way to
author a journey would be a second set of rules for a reviewer to know.

Three clauses had no DSL vocabulary, and each became an arrangement rather than an extension:

| Clause | What is missing | Where it went |
|---|---|---|
| *"booking.created enrols the contact"* | `FLOW_TRIGGER_EVENTS` is appointment-level; there is no booking event | `appointment.completed`, which is the booking event these journeys are about |
| *"only on a COMPLETED and **paid** appointment"* | `FLOW_CONDITION_FACTS` has no fact about money | the TRIGGER's eligibility query, in `apps/worker/src/automation/triggers/review-solicitation.ts` |
| *"a low internal rating routes to a private follow-up"* | there is no rating fact, and nothing collects a rating | a `tag`, which the DSL does have: whoever collects a rating writes it, and the journey's condition reads it |

The second one is the interesting case, and it is not a workaround. Enrolment eligibility belongs to the
trigger because a contact who was enrolled and then found ineligible has already had the engine's
attention — the enrolment is visible on their client record, the run exists, and the step log says it
went nowhere. `invoice_settlement.outstanding_fils <= 0` is "paid", read from the view that is the one
reading of what an invoice still owes; a second subtraction in the trigger would be a second answer to
it.

**The DSL was not extended.** Adding a `paid` fact would mean the interpreter reading
`invoice_settlement` per node, and adding a `booking.created` event would mean a trigger vocabulary that
no longer matches what the appointment lifecycle emits. Both are decisions for whoever next needs them,
with this record to start from.

## Decision 2 — two of the three journeys send nothing, because no copy has been approved

**The win-back and birthday journeys end in an `action_tag` and carry no message node at all.**

The only promotional template this build ships is `review.request`, and it ships `draft` *precisely* so
that its words cannot reach a customer until somebody with the authority to approve marketing copy has
done so — `templates.ts` says so in as many words, and adds that a body carrying a `[DRAFT]` marker would
be the weaker version of the same idea, "sendable, and embarrassing". Writing win-back and birthday copy
here would be inventing exactly the thing that file refuses to invent.

So the engine identifies the contact and a person acts. The tag is the interface, the `not_eligible` exit
records "we identified them and did not act", and the day the copy is approved the message node is one
edge away. The review journey DOES carry a message node bound to `review.request`, and its shipped
behaviour today is a refusal by name because the template is draft — which is the system working: the
journey is complete, the gate is real, and what is missing is an approval rather than code.

## Decision 3 — a birthday is a day and a month, and there is nowhere to put a year

**Migration 0155 adds `customer.birth_day` and `customer.birth_month`, and no birth-year column exists
anywhere in this schema.**

A date of birth is personal data this business has no use for. Nothing in docs/03 or docs/06 asks for an
age, no treatment in the catalogue is age-restricted in a way the booking path checks, and a marketing
journey that greeted somebody from a full date of birth would be holding an identity-grade field in order
to send one SMS a year. Two `smallint`s leave the year nowhere to live, which a policy cannot: **a query
cannot derive an age from data that is not there.**

A `date` column holding 1900-05-14 was the alternative and is worse in both directions — the year is a
lie every reader has to know to ignore, and the moment one row holds a real year the column is a date of
birth with no way to tell the two apart.

29 February is permitted. Whether it is greeted on 28 February or 1 March in a common year is
`Y9-birthday-leap`'s: the ROW is a fact about a person and the SENDING rule is a decision nobody has
made.

## Decision 4 — the win-back interval is measured from the BUSINESS day, and an undatable visit refuses

Trading runs 11:00–02:00, so a treatment that ends at 01:30 belongs to the session that opened at 11:00
the previous calendar day. A win-back dated on the calendar date would give the late-evening customer one
day less of grace than the afternoon customer, every time, and nothing would look wrong.

`WINBACK_WORKED_EXAMPLE` is therefore a committed value rather than prose, with the calendar-dated answer
committed beside it so the one-day difference is visible in the source. And a visit whose end instant
falls in no trading session — the premises was closed, or the instant is between 02:00 and 11:00 — is
`not_measurable` rather than dated on the calendar: a substituted origin produces a due date that
reconciles perfectly against a day nothing happened on, which is ADR 0070's subject.

The interval itself is an argument. 90 days is a `provisional` F09 setting against `Y9-crm-pipeline`;
neither `winback.ts` nor the trigger holds a figure.

## What M3 showed that the acceptance line did not predict

The M3 chain's final refusal is recorded as **`refused_no_consent`, not `refused_suppressed`**, and that
is a fact about the preference centre rather than a defect in either.

An opt-out over the whole grid is two writes: a consent withdrawal for every send-gating purpose on every
channel, and a suppression row against the recipient. `evaluateGate` reads consent before suppression, so
the withdrawal refuses first and the suppression never gets the chance. Both are asserted —
`apps/worker/src/automation/m3-proof.itest.ts` reads the suppression row AND the withdrawal row — and a third
case drives a contact who is suppressed and whose consent still stands, which is where
`refused_suppressed` is proved. Without that third contact the gate's suppression path would have been
covered by nothing, while a test named after it passed.

## Consequences

- The three journeys are `flow_definition` rows in the seed, active, with exactly one version each; a
  second `pnpm seed` publishes nothing, because `seedStockFlows` compares the stored jsonb with the
  composed document rather than inserting unconditionally. It has to: `flow_definition` is append-only
  and every enrolment pins the version that was live when it arrived, so two seeds would leave two
  cohorts pinned to two documents.
- The daily sweep is an agent (`stock_journey_triggers`, migration 0155) and a cron
  (`automation.stock-journey-sweep`, 10:00 Asia/Dubai, inside the promotional window). It enrols and
  never sends, so its budget is 0.
- Adding win-back or birthday copy is a content decision with an approval, not a code change.

# ADR 0040 — the flow interpreter owns no window, its idempotency key is a unique constraint, and its bounds live on the run

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** C-AUTO-07
- **Covers:** docs/01 decisions — none; this is the mechanism behind the drag-and-drop journeys docs/03 §5
  describes, and it sits under ADR 0016 (messaging compliance is structural) and ADR 0008 (unit of work,
  exactly-once per handler)

## Decision

Four things, and each one is a refusal to hold a fact in two places.

1. **The promotional window lives only in the gate.** The interpreter's delay node adds its minutes to the
   instant the run last resumed and knows nothing else about time. Whether the instant it lands on is one a
   promotional message may leave at is answered by `evaluateGate` through `sendMessage`, and the instant a
   held message may be released at is the one the gate hands back — carried out of the interpreter untouched
   and used as a `startAfter`.

2. **Idempotency is a UNIQUE constraint, and `duplicate` is a typed outcome derived from it.**
   `flow_node_effect_once_per_contact` on `(flow_run, node, channel, contact)` is claimed with
   `on conflict … do nothing returning id` before any vendor is asked, and the ABSENCE of a returned row is
   what the caller reads as `duplicate`.

3. **The interpreter's three bounds are provisional ceilings, written once, and the one that governs a run is
   stored on that run's own row.** `flow_run.max_node_executions` is `not null` with no default; the database
   states the relation (`node_executions between 0 and max_node_executions`) and not the figure.

4. **A promotional flow send is gated on the `marketing` consent purpose, and the node cannot choose.** The
   DSL's `action_message` carries no purpose field.

## Why the window is not in the interpreter

The tempting design is right there: a delay node knows the instant it lands on, and adding "…and if that is
outside 07:00–21:00, push it to the next opening" is four lines. It would work, and it would be the second
implementation of quiet hours in this repository.

The failure is not that the two disagree today. It is that they disagree after one of them changes.
`messaging.promotional_window` is a **setting** an owner may narrow, `Y9-ramadan-window` narrows it again on
dated `business_calendar` rows, and `Y9-queued-staleness` expires a hold that has waited too long — so the
answer to "may this leave now" is a function of two settings, a calendar and the age of the hold. An
interpreter with its own copy would be correct on the day it was written and wrong on the day somebody
narrowed the window in the admin panel, and the symptom is a promotional SMS at 21:30 that every screen says
was compliant. TDRA's sanction is sender-ID **suspension** (docs/04 §5), which stops the booking
confirmations too.

So the rule has one home, `packages/messaging/src/gate/window.ts` over `@berelax/core`'s pure
`decidePromotionalWindow`, and the interpreter is held to containing none of it by two things rather than by
care: `apps/worker/src/automation/no-window-logic.test.ts` names the fourteen identifiers that would betray a
second implementation and scans for them with comments stripped, and
`apps/worker/src/automation/interpreter.itest.ts` drives a real hold at 02:00 Asia/Dubai and a real release at
07:00. The source-level half is there because a behavioural test proves the rule for the cases it drives; the
behavioural half is there because a scan proves nothing about what the code does.

The consequence somebody will have to live with: a flow can NEVER schedule around the window itself. A node
whose target lands at 02:00 is held, not moved — the run pauses with its cursor still on that node and the
release is a queued tick. That is one more state for the interpreter to carry and one more reason a flow's
step log has two rows for one node.

## Why `duplicate` is the constraint's answer and not a caught exception

An at-least-once queue delivers the same job twice, so the question is not whether a node can be reached
twice but what the second arrival does. Three shapes were available:

- **A read before the write.** `select … where (run, node, channel, contact)` and skip if found. It is a
  read, so two workers can both find nothing; the window is small and the consequence is two messages.
- **Catch the unique violation.** `insert`, catch 23505, report a duplicate. This is the shape that fails in
  the way this build is most careful about: the caller has to read either a SQLSTATE or a message, and the
  first person to wrap the insert in a transaction that also does something else gets a duplicate reported
  for a conflict on a different constraint entirely. It is also how "`duplicate` must be a typed outcome the
  caller can read — not a swallowed generic error whose message happens to mention uniqueness" comes to be
  violated while looking correct.
- **`on conflict … do nothing returning id`.** One statement, no exception, and the absence of a row is the
  answer. A racing worker loses on the index rather than on the read.

The third is the decision. What it costs is that the token carries no outcome and no message id: it is a
token, and everything a reader wants to know about what happened is on the `flow_step_log` row beside it. The
step log therefore has to be written for every node including a duplicate one, which is why fifty deliveries
leave fifty rows — and that is the right answer, because "why does this contact carry this tag" is a question
about arrivals and not about effects.

The second half of the decision is what makes the token survive a customer merge. `flow_node_effect` refuses
DELETE and refuses every UPDATE except one that changes `contact_customer_id`, and that one statement is
exactly what the merge participant issues (`package_sale`'s arrangement in 0078). Without it, a contact merged
mid-run would be sent every node again under the survivor's key — the key the next tick computes would find
nothing.

## Why the execution ceiling is a column and not a constant in SQL

`MAX_FLOW_NODE_EXECUTIONS` is 200 and is provisional: nobody has stated a figure, and docs/12 §1 says a
provisional value is marked and does not stall the build. A `default 200` on the column would have been a
second statement of it, and the failure mode is specific rather than theoretical — a run started under one
ceiling and reported against another is a halt nobody can explain, because the number the interpreter used
and the number the report reads came from different places.

So the writer supplies it, the column is `not null` with no default, and what the database states is the
RELATION between the two columns. A worker that ignored its own bound could not store the result.

The same reasoning is why `flow_enrolment.ended_reason` stays `text`. `FLOW_END_REASONS` is DERIVED from the
DSL's own exit reasons plus the interpreter's halts, so a Postgres enum would be a **third** statement of an
already-computed list, and the first thing it would refuse is the ninth exit reason somebody draws. The
vocabulary is held by `isFlowEndReason` at the one writer, and `flow-run-vocabulary.test.ts` asserts the
derivation in both directions. The three vocabularies that ARE enums — `flow_run_mode`, `flow_run_status`,
`flow_node_outcome` — are compared against their `@berelax/shared` lists through `pg_enum` in both directions,
which is what makes two statements of one vocabulary safe rather than latent.

## Why a flow's promotional send is gated on `marketing`

`SEND_GATING_CONSENT_PURPOSES` has two members, `marketing` and `review_request`, and a contact can hold them
independently. A per-node purpose would have been the flexible answer and is the wrong one twice over: it
would let a builder pick the gate its own message passes, which is the misrouting C-AUTO-01 spent a unit
making impossible from the other direction; and `FLOW_CONDITION_FACTS` already names
`has_marketing_consent` and no review-request equivalent, so a node gated on the narrower purpose would be
gated on something no condition in the same document can test.

`marketing` is also the stricter of the two readings (docs/12 §2: a provisional value is the strictest safe
option). A contact who granted `review_request` and withheld `marketing` is refused under this choice and
permitted under the other, and the direction in which being wrong costs something is the second one.

The consequence: a review-request journey cannot reach a contact who opted into review requests alone. That
is a real limitation and it is the safe one; the unit that wants it differently is the one that owns the stock
journeys, and it will have to ask the owner rather than widen the gate.

## What is deliberately NOT decided here

The DSL's `action_tag` grammar is lower snake_case and `customer_tag.tag` is kebab-case, so no string
satisfies both and a flow drawn with a tag validates, publishes and then cannot write it. The interpreter
records that as a named refusal (`tag_not_storable`) with the grammar in the row rather than raising, and the
reconciliation is C-AUTO-09's: changing either grammar changes what a published document may contain, and the
unit that owns the picker an operator types a tag into is the one that should change it.

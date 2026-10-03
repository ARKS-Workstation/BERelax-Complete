# ADR 0108 — a spend cap is the DATABASE's, or it is a cap until two workers run

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** C-AUTO-10
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/03 §5's campaigns, and it stands
  on [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md) (a gate nobody has seen fail is not a gate),
  [ADR 0006](0006-sql-first-migrations.md) (SQL-first) and
  [ADR 0007](0007-money-and-business-day-primitives.md) (integer fils)

## Context

C-AUTO-04 built the messaging choke point, and `CampaignSpend` in `packages/messaging/src/send.ts` has
checked a campaign's cap before every send ever since. Its own comment states the reasoning correctly: the
check is *before* the send, because an SMS cannot be un-sent and a cap discovered on an invoice is not a
cap.

It holds a counter in one process.

Two workers draining one campaign each read a spend of 400 fils of a 500 cap, each decide that one more
message fits, and both send. The cap is then exceeded by exactly as many workers as are running, and
nothing about the outcome looks wrong: each worker's arithmetic was correct, each refusal it would have
issued was correct, and the campaign's recorded spend is the sum of what actually went out. The defect is
not in the check. It is in where the check lives.

## Decision

**The cap is enforced by the database, in three layers, and the per-message check in the choke point stays
— reading the same number rather than keeping its own.**

1. **`claim_campaign_recipient` (migration 0154) reserves and claims in ONE statement**, under the
   campaign row's `for update` lock. It adds the estimate to `campaign.spent_fils` and moves the next
   pending `campaign_recipient` to `claimed` together, or — when the reservation would breach the cap —
   marks that recipient `held` with `cap_exceeded` and reserves nothing. There is no instant at which two
   workers have both read a spend and neither has written one.

2. **`campaign_spend_within_cap` is a CHECK**, so `spent_fils` cannot exceed `cap_fils` by any route at
   all: a hand-written `UPDATE`, a future function that forgets the lock, a `psql` session. This is the
   layer that still holds when layer 1 is rewritten.

3. **`ZY753` names the only two writers of `spent_fils`.** A bounded column is still a column anything may
   move, and the symptom of a hand-moved spend is the quiet one: the recorded figure is correct and the
   messages it was supposed to count have already left. `refuse_campaign_spend_move` refuses any `UPDATE`
   that changes the column from outside `claim_campaign_recipient` and `settle_campaign_recipient`.

`CampaignSpend` is **not** removed, and it gains a `spentFils` constructor argument instead. The sender
builds an instance from the figures it read out of the campaign row, so the choke point still refuses
`campaign_cap_exceeded` by name — and the per-message refusal and the reservation are two readings of one
number rather than two numbers. Deleting the choke point's check would have made the cap invisible at the
one place a reader looks for it.

This is the same two-layer shape `frequency_cap_value_is_a_cap()` has in migration 0080 and
`effectivePromotionalHours` has in `promotional-window.ts`: the readable refusal for a human, and the
structural one that holds when the readable one is bypassed. The third layer is new and is about the
writer rather than about the value.

## The second decision, which is the same argument about evidence

**A `sent` `campaign_recipient` row must carry its gate decision and the id of the consent record the send
rested on, and may not then be edited or deleted.**

`campaign_recipient_sent_row_is_answerable` is a CHECK rather than a test. A test asserting that every
sent row carries both columns is a test about the rows that exist; the constraint is a statement about
every row that ever will, and the acceptance line is *"so a regulator question is answerable from one
query"* — which it is only if the columns cannot be null.

`ZY755` then makes a sent row immutable. **The consequence is deliberate: a campaign that reached a
provider can no longer be deleted at all**, because the cascade from `campaign` hits the refusal. A
campaign that spent money and sent messages is the record of both, and `apps/worker/src/automation/campaign.itest.ts`
works around it by using a per-run key and leaving behind exactly the campaigns that sent — which is the
rule working rather than getting in the way.

`consent_record_id` is a plain `uuid` and **not** a foreign key, for `consent.contact_customer_id`'s
stated reason: the consent ledger is deliberately not joined to by reference, so a data-subject erasure
cannot cascade away the evidence that a message was sent lawfully.

## Two things this decision deliberately does not do

**It does not put the promotional window in the database.** `messaging.promotional_window` is the ceiling
and `packages/core/src/messaging/promotional-window.ts` is the rule. A CHECK on `campaign.scheduled_at`
would be a second answer to when a message may be sent, and the symptom of two answers is a 21:30 campaign
that every screen says was compliant. `scheduleCampaign` refuses an out-of-window instant at authoring
time and `campaignSendWindowVerdict` asks the same question again before every single message — because a
campaign scheduled at 20:55 is legitimate, and only the instant immediately before the next send can say
that it is now 21:00.

**It does not write a spend figure anywhere in SQL.** `cap_fils` is `NOT NULL` with no default. The AED 500
in C-AUTO-10's manifest entry is provisional and lives in the F09 settings registry, where it carries
`provisional: true` against `Y6-sender-ids` and reaches the Unconfirmed Assumptions panel. A default in the
migration would be the same number in a place that cannot say it is a guess (brief rule 15).

## Consequences

- A campaign's spend is correct under any number of concurrent workers, and the proof is a test that
  issues twenty claims at once against a cap with room for ten.
- A campaign that has sent cannot be deleted. Anything that needs to tidy campaigns must distinguish the
  ones that sent, and `campaign.itest.ts` is the worked example.
- The segment compiler is where the other half of this unit's safety lives:
  `packages/core/src/automation/segment-compile.ts` emits one parameterised query over a closed attribute
  registry, and a reference into the `clinical` schema is refused by name — because a recipient list
  selected on a contraindication is a special-category disclosure made by the list rather than by the
  message, and it would leave no trace in any message record.

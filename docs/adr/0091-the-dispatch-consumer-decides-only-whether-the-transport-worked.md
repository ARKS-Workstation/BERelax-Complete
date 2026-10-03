# ADR 0091 — the dispatch consumer decides only whether the transport worked

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-MEAS-03
- **Covers:** docs/01 decisions — none. Decision 14 is recorded in ADR 0018; this is a mechanism under it,
  beside ADR 0076 (one consent gate, asked in two places), ADR 0059 (the opaque category code and the
  whole-payload argument), ADR 0005 and ADR 0022 (a real interface, a named fake, selection by
  configuration, a visible local outbox) and ADR 0002 (a pass over nothing must not answer "all sent").

## Context

A-MEAS-03 drains `analytics_dispatch` and pushes conversions to GA4's Measurement Protocol and Meta's
Conversions API. The table, its destinations and its consent gate already exist (0125, ADR 0076). The
question this record settles is what the consumer is allowed to decide, because the obvious answer is
"whether this conversion may be sent", and that answer is the defect A-MEAS-02 was built to prevent.

## Decision

**The consumer decides exactly one thing: whether the transport worked.** Consent is not re-asked. A row
is `queued` or it is not, and it cannot have reached `queued` without the signals its destination requires
— `dispatch_consent_gap` is the one statement of the gate, called by the ZY312 trigger and by the writer,
for every role including the owner, on INSERT and on UPDATE. The consumer reads the decision.

The shape a second check would take is a `where` clause in `dueAnalyticsDispatches` reading the session's
four consent columns. It would look right, agree with the gate for a year, and then not — and the symptom
is not an error: it is a push that happens while the on-page tag correctly refuses.

The UPDATE half of the trigger is what makes a RETRY safe without the consumer knowing anything: a
dispatch that failed while consent stood and is retried after a withdrawal is refused on the way back to
`queued`. That is why `failed` is not terminal and why a retry is a state change rather than a second row.

Four consequences follow and each is load-bearing.

**One delivery per `(event_id, destination)` is three mechanisms, not one.** A unique index across every
state refuses a second ROW whichever call site inserts it, which is what makes "replaying the outbox event
twice writes no second dispatch" a property of the schema. `for no key update … skip locked` stops two
worker processes claiming one row, which the index cannot — it is the same row, not a second one. And
ZY451 freezes a transmitted row, so a delivery cannot be re-queued by a later unit or by a psql session.
The index is deliberately NOT partial: a `suppressed` row and a later `queued` row for one pair would be
two answers to whether that conversion was permitted.

**The event id is DERIVED on both surfaces, not minted and handed over.** A server that minted a random id
and rendered it into the page is the obvious design and it fails on this business's own conversions: a
walk-in and a phone booking have no page, and A-MEAS-05's corrected value needs an identity of its own or
it deduplicates against the figure it corrects and is discarded by the platform. So both sides take a
digest over the aggregate kind, the aggregate id and the funnel stage — opaque, because the value travels
to an ad platform and a business identifier that leaves the building is a join key into our records for
whoever holds it, and stable across a retry by construction rather than by a call site remembering.

**A stored payload re-enters the branded type through the guard, and the guard proves the rebuild.** The
brand is a `unique symbol` and cannot survive `jsonb`, so the consumer cannot be handed the payload the
enqueuer built. `JSON.parse(row.payload) as EgressPayload` is the repair that suggests itself and it is the
exact cast `scripts/check-egress-guard.mjs` rule 1 refuses: a forged payload has had no allowlist applied
and an adapter accepts it because the type says it is fine. `egressPayloadFromStored` instead rebuilds the
payload through the one builder and then holds the rebuild against what the row stored, so a renumbered
category table fails loudly here rather than posting a stale document. That function is also what caught a
real defect in the writer: a JSON string parameter cast with `::jsonb` is JSON-ENCODED by the driver, so
every stored payload was a jsonb *string*, every field read as `undefined`, and both adapters would have
posted a conversion with no event type — which GA4 accepts.

**`action_source` and `occurred_at` are STORED by the enqueuer and refused rather than defaulted.** Nothing
in this schema links an analytics session to the booking it produced (A-FIRST-08 owns attribution,
A-FIRST-09 the funnel materialisation), so a consumer that derived either would be deriving it from
nothing and answering confidently. `occurred_at` is a second column and not `decided_at` because a platform
dates the conversion on it and every attribution window is measured from it: an offline conversion stamped
with the enqueue instant is credited to whatever campaign was running on the night the worker ran. The
value a defaulted action source would reach is `website`, which reports a walk-in as a web order.

## Consequences

Nothing transmits. There is no GA4 property and no Meta pixel (OPEN-QUESTIONS `Y1-analytics-credentials`),
so `ANALYTICS_PROVIDER=real` resolves to `notImplemented` and both adapters are named fakes whose BODIES
are real and whose transport is not. Outside production the egress guard diverts unconditionally — one
argument, no allowlist, no override, unlike F03's message guard, because an advertising account has no test
recipient: a staging run's conversions land in the property the owner reads, inflate what a campaign is
optimised on, and cannot be removed. A diverted dispatch is recorded `sent` with the local outbox row as
the receipt, because the dispatch is COMPLETE and whether a request left the building is a property of the
deployment rather than of the row.

The cost is that two things now have to happen together. A new destination is a row in
`analytics_dispatch_destination`, a key in `CONSENT_GATED_TARGETS` and an adapter in the registry, and a
destination present in the first two and absent from the third is a dispatch the consumer REFUSES by name
rather than skipping — a skipped row stays queued for ever and reads exactly like a consumer that stopped
running. The `agent_heartbeat` row is what makes the difference visible at all.

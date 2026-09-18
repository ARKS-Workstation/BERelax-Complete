# ADR 0018 — a first-party event store is the source of truth, and the ad platforms are not

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decisions 14, 24, 25

## Decision

**Every interaction is recorded in our own PostgreSQL**, through a first-party `/api/collect` route.
That store is what business reporting reads. GA4 and Meta Pixel still run — they are how the ad
platforms optimise — but they are **outputs, not sources**.

Server-side conversions are pushed from the transactional outbox, so a conversion is reported because
a booking was actually paid for, not because a browser fired a tag.

## Why not simply read GA4

Because the question the owner asks is "which of these clicks became money", and GA4 cannot answer it
here:

- **It is sampled and thresholded.** At this traffic level, reports quietly withhold rows.
- **Ad blockers remove a material share of sessions**, and the share is not random.
- **It cannot join to a paid appointment.** The revenue truth lives in our journal
  ([ADR 0017](0017-accounting-journal-and-no-auto-filing.md)); a funnel that stops at "clicked book"
  measures intent, not business.
- **Health data must never reach Google or Meta.** An egress guard maps services to opaque category
  codes before anything leaves, because a conversion event naming a treatment is a disclosure.

A first-party store has none of those limits, and it is the reason a **server-side GTM container is
not needed** — real monthly cost and maintenance for a capability this already provides.

## The WhatsApp gap, and the honest fix

WhatsApp is the channel this business actually books on, and the conversation is invisible to us. A
click on "WhatsApp us" is the last thing we see; the booking happens in an app we have no access to.

So the prefilled WhatsApp message carries a **short reference code**, which staff paste into the
booking. That reference is the only join between a Meta or Google click and a paid appointment.

It depends on a human doing something, which means it will not always happen. So **ref-capture rate is
itself a reported metric**. When it is low the funnel says the attribution is incomplete rather than
quietly showing a smaller number and calling it truth. A dashboard that cannot distinguish "no
conversions" from "conversions we failed to attribute" is worse than no dashboard.

## Consequences

- The collect route is a write path exposed to the internet: rate-limited, schema-validated, and
  writing to a partitioned table.
- Consent gating applies to the internal store too — the stricter reading, recorded as
  `Y5-analytics-basis` in docs/OPEN-QUESTIONS.md pending advice.
- The funnel is built from our own events, so it survives a third party changing its API, its pricing,
  or its mind.

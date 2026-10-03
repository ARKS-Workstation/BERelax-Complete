# ADR 0102 — first touch belongs to the person, last touch to the booking, and neither may reference the session it names

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-FIRST-08
- **Covers:** docs/01 decisions — none. Decision 14 is recorded in ADR 0018; this is a mechanism under it,
  beside ADR 0045 (the analytics schema and its 90-day retention), ADR 0058 (origination), ADR 0066 (the
  visitor row is created AT consent, and a session says why its trading date is that date), ADR 0050 (a
  suite may delete only rows it created), ADR 0034 (what a row-level erasure cannot reach) and ADR 0002 (a
  report that cannot tell "no conversions" from "conversions we failed to attribute" is worse than none).

## Context

`analytics.attribution` (migration 0096) answers one question: what originated THIS session. It is purged
with the session at ninety days, and it says nothing about a person — one visitor arriving three times from
three sources has three rows, and none of them is the answer to *where did this customer come from*.

Two further questions have to be answerable years later, and 0096's own comment names this unit for both:
*"the first and last touch that OUTLIVE it are denormalised onto customer and booking by A-FIRST-08"*.

## Decision

### Two claims, two subjects, two tables

**The first touch belongs to the PERSON and the last touch belongs to the BOOKING.**

A person is found once, so the first touch is write-once and lives on the customer. Putting it on the
booking would give one customer three first touches and make "where did this client come from" a query with
an ordering in it.

A person books repeatedly, and each booking has its own most-recent-touch-before-it, so the last touch
lives on the booking. Putting it on the customer would mean the second booking overwriting the first
booking's last touch — and that figure is the denominator of every *which channel produced this sale*
report, so the overwrite would silently re-attribute money that had already been counted.

They may disagree, which is the whole reason there are two: a customer found through an ad in March and
booked through a reminder link in June is `cpc` by first touch and `email` by last touch. One column would
be this build choosing which of those questions the business is allowed to ask.

### Child tables rather than columns on `customer` and `booking`

The manifest asks for "denormalised first/last-touch columns on customer and booking". The columns are
here; the tables they are on are children, and the first of three reasons decides it on its own.

**A NOT NULL attribution column cannot be added to either parent without inventing one.** Both already hold
rows, so `alter table customer add column first_touch_source text not null` fails on a non-empty table and
a DEFAULT writes an attribution onto every customer the business already has. `unknown` is the least wrong
default and is still a claim nobody made — `customer_acquisition_source`'s own comment puts it exactly:
*"choosing walk_in for them would be an invented attribution"* (brief rule 15). A child row's ABSENCE is the
honest statement, and `source` is then NOT NULL for every row that exists, which is what the acceptance
line asks for.

The other two are ordinary engineering: a customer-scoped column enters C-CRM-05's merge participant
registry and C-CRM-10's erasure catalogue one classification at a time, and an unclassified column in the
latter refuses every customer erasure; and widening `customer` by seven columns widens every read and every
DTO audience list behind it.

### No foreign key to `analytics.session`, in either direction

Retention purges `analytics.session` at ninety days. A reference from the attribution to the session would
either block that purge or cascade the attribution away with it, and the attribution is the half that has
to survive. So `session_reference` is a bare `uuid` — exactly the shape A-FIRST-07 chose for
`whatsapp_ref.session_reference` and `booking_whatsapp_ref_capture.attributed_session_id`, for this reason.
A reference that resolves to nothing is the EXPECTED state of a row older than the window, not a fault.

The source, medium and campaign are therefore COPIED and not joined. A rollup that read them through a live
join would report a day's attribution correctly for ninety days and then report it as unattributed, and the
change would arrive as a cliff in a chart nobody had deployed anything near.

### `offline` is a fifth basis and not a reuse of `direct`

`direct` (0096) is a browser that arrived with nothing to resolve: a real web session whose origination
could not be attributed. `offline` is a walk-in off the road or a telephone call, where there was no browser
at all. Folding the two would make attribution coverage unanswerable, because the denominator would hold
every walk-in the salon has ever had and the figure would read as a marketing failure.

Both spellings are pinned, and one IMMUTABLE function — `attribution_origination_is_well_formed` — is
called by a CHECK on both tables. Two hand-written copies of that rule would drift into one table accepting
a row the other refuses.

### ZY691 is the rule that makes write-once and the merge fold one rule

The obvious statement of "write-once" is a trigger refusing every UPDATE. It is not available, because a
customer MERGE has to be able to carry the loser's EARLIER first touch onto the survivor.

So the rule is the one that makes both true: **a first touch may move backwards in time and never
forwards.** A resolver re-run over a longer session history converges on the same row rather than moving it,
which is what makes *replay the sessions in any order and get the same answer* a property of the schema
rather than of the writer's care. An UPDATE that changes nothing about the claim is permitted, so a
re-stamped `recorded_at` is not a refusal.

### The merge fold is a trigger on `merge_record`, not a fifth merge strategy

`repoint_update` can MOVE the loser's row or SKIP it, and when both records hold a first touch the right
answer is neither: it is the EARLIER of the two. `mergeCustomers` inserts the tombstone claim BEFORE it runs
the participant loop, so a trigger on that insert carries the earlier claim onto the survivor and the loop
then finds the survivor's key taken and retains the loser's row on the tombstone with a stated reason. The
survivor is left with exactly one first-touch row, which is its primary key.

A fifth strategy in `merge-participants.ts` was the alternative. It would have widened `sql.unsafe`'s
identifier grammar and `merge_record_table`'s balance constraints for one table's arithmetic, and the rule
would then live in a module a reader of this schema has no reason to open. The trigger also holds for a
merge somebody runs in psql.

### The last touch is bounded by the booking, and the wrong answer is self-reinforcing

ZY692 refuses a last touch dated after the booking it is attributed to. A session that began afterwards
cannot have produced the booking — and the page a customer lands on next is usually the confirmation, so an
unbounded resolver re-attributes completed sales to whatever followed them, consistently and in one
direction. It is a trigger and not a CHECK because the booking's creation instant is a row in another table,
and the bound is `<=` rather than `<` because a one-page quick-book takes the booking in the same instant as
the session that produced it.

## Consequences

**The attribution is written inside the booking transaction.** `createBooking` writes the
`booking_attribution` row with the booking, its appointments, its idempotency claim, its outbox event and
its audit row — which is what makes `booking_attribution.source` NOT NULL a statement about the build rather
than about one table. An outbox handler was the alternative and is worse for 0137's reason about a cron: a
handler that had not run yet is indistinguishable from a booking nobody could attribute, and the figure that
reads is attribution coverage.

**A-MEAS-03's and A-MEAS-05's injected session resolver now has something behind it, and it still refuses.**
ADR 0091 and ADR 0092 both recorded why neither unit chose a session: *"a session picked here would push a
conversion under somebody else's consent decision, which the ZY312 gate cannot catch because the session it
was handed really did grant everything."* The answer this unit supplies is not a choice — it is the session
the booking's own last touch names, written by the transaction that produced the booking — and it is `null`
for every walk-in and every telephone booking that carried no ref code. The pass counts those refusals
exactly as it counted the shipped resolver's.

**A bot-flagged session is not excluded, and that is a decision.** ADR 0062's rule is that the classifier's
verdict is stored and never acted on; the one unit the exclusion was deferred to is A-FIRST-09's funnel,
which counts traffic. `analytics.visitor` exists only at consent (ADR 0066) and a crawler does not answer a
consent banner, so a `bot` flag under a consented visitor is a false positive — and dropping that session
would silently move the customer's first touch.

**The rule is stated twice and held equal in the same commit.** `packages/db` may not import
`packages/core` (ADR 0001), so the ordering that picks the two touches is `order by … limit 1` in the
repository and `firstTouchOf` / `lastTouchBeforeOf` in core.
`packages/fixtures/src/attribution-coverage.itest.ts` reads the candidate touches out of a real database,
applies the pure rule in TypeScript and asserts the answer equals the row the statements wrote. Both
orderings are TOTAL — the instant, then the session's own id — because two sessions of one visitor can share
a `started_at` to the millisecond and the answer would otherwise depend on row order.

**An erasure deletes the first touch and keeps the last.** `public.customer_attribution.customer_id` is
`delete_row`: it is a measurement about a person and has no meaning once there is nobody to have found, and
nothing is built from it — the rollups keep their own per-business-day aggregates, which carry no
identifier, so every published number survives. `public.booking_attribution.booking_id` inherits the
booking's pseudonymise-and-keep, because deleting it would make a kept booking read as unattributed and move
the coverage figure for a trading day that is already closed. DELETE is granted on both tables to
`berelax_app` so the first of those stays an ordinary statement rather than needing a third branch in
0085's SECURITY DEFINER function.

**Coverage has no figure for a window with no paid booking.** `attributionCoverageOf` answers
`no_paid_bookings` rather than 0%, which is ADR 0002's rule applied to a share: reporting 0% coverage on a
day nothing was sold says the marketing failed.

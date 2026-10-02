# ADR 0078 — tracking is declared on the element and checked at build time, and the collector decides nothing

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** A-FIRST-06
- **Covers:** docs/01 decisions — none; decisions 14, 24 and 25 are recorded in ADR 0018, and this is a
  mechanism under it, beside ADR 0045 (the analytics schema and its retention), ADR 0046 (the measurement
  plan as code), ADR 0062 (a user agent is a claim) and ADR 0066 (pre-consent collection is a projection).
  It is the BROWSER half of the ingest ADR 0066 describes, and it adds nothing to the wire contract that
  unit built.

## Context

`/api/collect` exists and its envelope is settled (A-FIRST-05). What did not exist was anything that posts
to it. Two questions had to be answered to build that, and both of them have an obvious answer that is
wrong in a way nothing would notice for months.

**One: how does a page say what an interaction means?** The obvious answer is a handler per call to action
— `onClick={() => track('cta_click', { target: 'whatsapp' })}`. It works on the first day. What it costs is
that the set of events the site collects becomes a property of expressions inside components: unreadable
without running the application, uncheckable by anything, and wrong in a way that renders perfectly. A
mistyped name is a button that still works, a page that still passes every test, and a row refused at the
endpoint as `unknown_event` — discovered when somebody notices a funnel stage has been empty long enough
to look like a real figure. It also makes every tracked element a client component, which on a site where
docs/09 §3 allows exactly one heavy island is a cost paid on every page that has a button.

**Two: what may the browser decide?** The collector is the only part of this estate that runs on a device
this business does not control, inside a bundle that is cached. Every fact it holds a copy of is a fact
that can be months out of date while looking current — and the three facts in reach are the taxonomy, the
batch caps and the consent state. A-FIRST-05's own header puts the cost of the second plainly: *"a cap the
collector does not know about is a cap that silently drops a browser's whole batch."* The third is worse
than a drop: a collector that read the consent cookie and decided for itself whether to post would be a
second consent gate, disagreeing with the first exactly when a banner has just been answered.

## Decision

**Tracking is declared on the element, by attribute, and the attributes are checked statically against the
taxonomy.** `data-berelax-event` names the event and one attribute per payload field carries the rest, with
the attribute name derived from the field name in one place (`trackPayloadAttribute`). One delegated
capture-phase listener on the document reads them. `scripts/check-event-attributes.mjs` reads the same
derivation and the real `ANALYTICS_EVENT_SCHEMAS`, and fails the build on seven rules: a name outside the
taxonomy, a required payload attribute absent, a value its field's own Zod schema refuses, an attribute
that is no payload field of any event, a payload attribute on an element that declares no event, an
attribute composed from an expression rather than written as a literal, and an event whose payload schema
cannot accept the field the collector itself adds.

That last rule exists because this unit made the mistake it refuses. Every payload schema is a
`strictObject` and the collector puts `path` on every declared interaction, so `whatsapp_ref_shown` —
whose payload is `refCode` and nothing else — produced an event the server refuses whole as
`invalid_event_payload` when it was declared on a button. It rendered and it worked; what caught it was the
browser suite parsing the posted batch through `collectBatchSchema`, which is why that suite parses rather
than reading JSON. An event that is not page-located belongs to the imperative door.

**The collector holds no second statement of any fact the server owns.** Membership is
`parseAnalyticsEvent`; the caps are `COLLECT_MAX_BATCH_EVENTS` and `COLLECT_MAX_BODY_BYTES`; the queue
ceiling is derived from the first of them. There is no consent decision in the browser at all — the
collector posts and `/api/collect` decides what the post becomes, which is the arrangement ADR 0066
requires in order for a pre-consent landing to be counted without an identifier.

**The network is deferred to the `load` event, and the listener is not.** The listener costs one handler
and attaching it late would drop the clicks of a reader faster than `load`. A request before `load` would
put the collector in the LCP critical request chain, which the acceptance forbids — so there is no request
to be in any chain until then. The one exception is teardown: `pagehide` and the tab becoming hidden flush
whether or not `load` has fired, because at that point there is no largest contentful paint left to protect
and the alternative is losing the page view of every visitor who left early, which is exactly the bounce
the funnel's first stage exists to count.

## What this rejects, and why each alternative fails here

**A literal attribute rather than a composed one, even in the fixture page.** The fixture page was written
first with `{...attributes}` spread from a derived table, which is the tidier code and defeats the whole
design: an attribute behind an expression is invisible to a text scan, so the page with more declarations
than any other would have been the page the gate could not read. The derivation still has exactly one
statement — the function the runtime reader uses — and the checker is what holds the literals equal to it.
`event-attribute-is-not-a-literal` is therefore a refusal rather than a case to be clever about.

**A ring buffer for the queue.** When the queue is full the NEWEST event is refused by name. Evicting the
oldest is the obvious implementation and it is invisible in the data: the oldest event in any queue is the
`page_view` carrying `entry: true`, which is the `landing` stage — the denominator every conversion rate
divides by. Dropping it turns an over-active page into a page with conversions and no landings, which reads
as a rate above 100% or, after a chart clamps it, as a very good day.

**Splitting a flush by count alone.** The arithmetic refuses it: the largest validated event is a
2048-character path plus its envelope fields, about 2.2KB, so fifty of them are roughly 115KB against a
64KB body cap. A count-only split posts a body the route refuses as `body_too_large` — the whole batch
lost. The flush therefore splits by bytes as well, and the slice that cannot be split further is a
termination guarantee rather than a named refusal, because no event that passed `parseAnalyticsEvent` can
reach it and a refusal nothing can raise is worse than no refusal (A-FIRST-05 paid for that once already).

**Trusting `sendBeacon`'s return value.** It answers `true` while the browser is offline: it has accepted
the payload into its own queue, which is not delivery. So `navigator.onLine` is consulted before every send
and the queue is kept when the answer is no. Without that, an outage is a funnel that is quietly short on
bad-network days rather than a queue that flushes when the network returns.

**Re-minting the client event id on a retry.** A `clientEventId` is assigned when the event is ENQUEUED and
survives every retry, because `/api/collect` holds a unique index on it. Dropping a batch whose delivery
could not be confirmed loses events; re-sending it with fresh ids inflates every funnel figure by however
many retries happened, with nothing anywhere saying so. A stable id makes the retry idempotent, which is
what lets the collector keep the queue instead of guessing.

**Instrumenting the admin screens.** The unit's summary says *"instruments what exists now (/book and
admin)"* and the admin is deliberately NOT instrumented. The taxonomy holds five events and every one of
them is a statement about a visitor's journey; there is no admin-shaped event, so a staff screen could only
produce `page_view`. And a staff `page_view` is worse than useless: staff are never shown a consent banner,
so `analyticsStorageGranted` is false for every one of their requests and ADR 0066's projection would add
each one to the pre-consent landing counter — putting the front desk's own browsing into the denominator of
every conversion rate on the analytics page. The honest instrumentation of staff work is the audit trail,
which already exists. This is recorded as a NOTE on the unit rather than left as an omission.

## Consequences somebody will have to live with

**A new event is three diffs, not one.** The name and its Zod schema in
`packages/shared/src/analytics/taxonomy.ts`, the attributes on the elements that declare it, and — if its
payload has a field no existing event has — a value the checker can parse. That is the intended friction:
A-FIRST-02 closed the taxonomy at five on the argument that *"every interaction" is unbounded*, and this
makes the fifth and sixth cost the same as the first.

**A computed event name is not available.** A component that wanted to track a name chosen at runtime
cannot, and the refusal is by rule name at build time. The escape hatch is the imperative door
(`trackCollectorEvent`, which takes an already-validated `AnalyticsEvent`) and it is deliberately narrow:
A-FIRST-07's `whatsapp_ref_shown` fires when a ref code is rendered rather than when something is clicked,
and that is the shape of case it is for.

**A route opts in, and the opt-in is visible.** The island is not in the document shell, because
`build/budgets.json`'s `shared-layout-client-js` is an allow-list of two client modules plus 4KB and a
collector in the shell is a collector every page pays for. So instrumenting a route means rendering
`<CollectorIsland />` on it — and on `/book` that meant adding a third entry to `book.itest.ts`'s exact
list of the route's client modules, which is what that assertion is for.

**The second half of "not in the LCP critical request chain" is still W-SITE-11's.** There is no Lighthouse
in this repository — `lighthouse/budget.json` and `lighthouserc.cjs` are in that unit's files list and
`pnpm verify` has no step that could run one. This unit therefore changes no Lighthouse budget, enforces
the claim by construction, and asserts it two ways in a real browser: no collect request before the `load`
event, read out of the page's own Resource Timing, and no blocking build-chunk script in the served HTML.
B-UI-02's `apps/web/src/book/budget.ts` records the same deferral for the same reason.

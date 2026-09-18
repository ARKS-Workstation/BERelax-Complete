# Module Specifications — the hard parts

[docs/00-plan.md](00-plan.md) says *what* each phase delivers. This document covers *the parts
that are difficult*, where an under-specified plan turns into a rewrite.

## 1. The availability engine

The single most important piece of engineering in the project. Everything else is CRUD by
comparison.

A slot is bookable only if **every** one of these holds simultaneously:

1. Inside the **business day's** open/close instants, and not inside a `premises_closure`. Trading is
   11:00–02:00, so the business day **crosses midnight** — a naive `open <= t <= close` comparison is
   wrong, and a 01:30 slot belongs to the previous business day. Last bookable start is
   `close − duration − turnaround`, so a 120-minute treatment must begin by 23:40 with a 20-minute
   turnaround.
2. A therapist is on shift, has the required skill, has no expired mandatory credential, and
   has no overlapping appointment, block or approved leave.
3. That therapist satisfies the **gender-matching constraint** against the client.
4. A room exists whose type is compatible with the service, has capacity remaining, and is free
   for the treatment *plus its turnaround*.
5. Buffers before and after are clear; minimum lead time and maximum advance window are respected.

Implementation approach: **compute on demand, cache briefly.** Do not precompute slot rows. Slot
tables go stale the moment a shift changes or leave is approved, and staleness in an availability
table means selling a slot that does not exist. A single well-indexed query over `tstzrange`
overlaps against appointments, blocks and shifts is fast at this data volume; cache the result for
30–60 seconds keyed on (date, service) and invalidate on any write to appointments, shifts, blocks
or leave.

**Three real resource shapes** break a one-appointment-per-booking model, and this business sells all
three. **Couple Massage**: two therapists, one capacity-2 room, two clients. **Four Hands**: two
therapists, one *standard* room, one client. **Morocco Bath / Jacuzzi**: one therapist and the **wet
room**, which is a single scarce resource — mis-scheduling it is a real operational failure, which is why
`service_room_type_compat` is load-bearing rather than defensive. In every case all appointments in the
booking must succeed or none. That is why room
capacity is a *deferred* constraint trigger evaluated at commit — an immediate trigger fires
mid-insert and rejects the legitimate second row.

**Turnaround is not a buffer.** A buffer protects the therapist's time; turnaround occupies the
*room* after the client leaves. They are different resources and different durations, and
conflating them either over-books rooms or wastes 15 minutes of capacity per treatment.

Edge cases that must be in the test suite: **a slot after midnight resolving to the correct business
day**; a booking at 01:55 when close is 02:00; the last slot of the day with turnaround extending past
closing; a shift ending mid-treatment; leave approved over an existing booking; a therapist's
certificate expiring between booking and appointment; two customers taking the last slot in the
same millisecond; a service whose duration exceeds any single room's free window; DST (there is
none in Dubai, but the code must not assume a fixed offset anywhere).

## 2. Appointment lifecycle

```
                 ┌──────────┐
   (online) ────▶│ REQUESTED│──▶ CONFIRMED ──▶ CHECKED_IN ──▶ IN_PROGRESS ──▶ COMPLETED
                 └──────────┘         │             │                             │
   (staff) ──────────────────────────▶│             │                             ▼
                                      │             │                        invoice issued
                                      ▼             ▼
                              CANCELLED_*      NO_SHOW
                              RESCHEDULED
```

Every transition declares who may perform it and what fires. `CONFIRMED` schedules reminders.
`RESCHEDULED` **invalidates** the previously scheduled reminders and creates new ones — this is the
most damaging bug in the domain and it is invisible in a feature list: "you have an appointment
tomorrow at 3pm" arriving after the customer moved it destroys trust faster than sending nothing.
Every scheduled step must therefore be a row carrying an invalidation key, not a fire-and-forget
delayed job. `COMPLETED` is what emits revenue events, not `CONFIRMED` — booking value is a guess,
the till knows the truth.

Cancellation is split by actor (`CANCELLED_BY_CUSTOMER`, `CANCELLED_BY_SALON`) because the reporting
and fee consequences differ.

## 3. Service catalogue → frontend loop

The brief asks for services "set in the backend, connected with frontend". Concretely:

Admin publishes a service → the catalogue row changes → on-demand ISR revalidation fires for the
service page and the category page → the sitemap `lastmod` updates → IndexNow is pinged → the CDN
path is purged → JSON-LD regenerates from the database. The page, its structured data, its
bookability and its price are all derived from one row, so they cannot drift apart.

Guard rails so a non-technical owner cannot break the engine from the admin UI: a service with
future bookings can be archived but not deleted; duration cannot be zero; changing a slug writes a
301 automatically; a price change is effective-dated and never mutates historic bookings; and the
**public display name passes the compliance lint** while the internal name is unconstrained.

Price resolution order: base gross price → variant → effective-dated price list → promotion →
snapshot onto the booking. Snapshotting is not optional. Reading price live means a price rise
retroactively rewrites last month's revenue.

## 4. The messaging compliance gate

One choke point every outbound message passes through. In order:

1. Resolve `message_class` from the **template** (immutable; changing it is a privileged, audited
   action that re-triggers approval).
2. Select the sender ID for that class — transactional, or the `AD-` prefixed promotional identity.
3. If promotional: require an affirmative consent record, check the hashed suppression list, check
   the global per-contact frequency cap, and check the 07:00–21:00 Asia/Dubai window — queueing
   rather than dropping if outside it.
4. Detect GSM-7 vs UCS-2, compute segment count and cost, apply the per-campaign spend cap.
5. Send, record the provider message id, and reconcile delivery receipts.

**Fail closed.** If consent, window or suppression cannot be evaluated, the send does not happen.

Two properties matter more than any feature here. First, these are **code, not settings** — any
switch that can be turned off eventually will be. Second, the marketing kill switch **cannot touch
transactional traffic**, and the two sender IDs mean a suspended promotional identity does not stop
booking confirmations.

Also: alphanumeric sender IDs generally **cannot receive inbound SMS**, so "Reply STOP" is both
non-functional and a compliance lie. The opt-out mechanism is a short link to the preference centre,
which also gives you click confirmation that the opt-out was honoured.

## 5. The automation engine and the drag-and-drop flow

"Drag and drop CRM flow" is ambiguous and covers two different products. You probably want both,
and they should ship in this order:

**(a) Kanban pipeline** — client and lead *cards* dragged between stages. Cheap, immediately
useful, mostly UI over a `pipeline_stage` column. Ship first.

**(b) Node-graph journey builder** — drag triggers, delays, conditions and actions to compose a
journey. React Flow over a versioned JSON DSL. Ship once the engine underneath is proven, because
the builder is the easy half; the interpreter is the hard half.

The interpreter's difficult questions, all of which need answers before the builder is drawn:

- **What happens to 400 people mid-flow when the owner edits the flow?** Enrolments pin to a
  `flow_definition` version. Edits create a new version; existing enrolments finish on the old one.
- **Idempotency** on `(flow_run, node, channel, contact)`, because the queue is at-least-once.
- **Customer merge** re-points enrolments, frequency ledgers, suppressions and consents to the
  survivor and de-duplicates them. Duplicates are guaranteed in a phone-first flow (`+97150…` vs
  `050…` vs a typo), so merge is a first-class operation, not a cleanup script.
- **Safety limits**: loop detection, max enrolments, max sends per contact per week across *all*
  flows and campaigns, a global kill switch, and a dry-run mode.
- A drag-and-drop builder is exactly where an operator will try to route promotional content
  through a transactional template. The builder must make that **impossible**, not discouraged.

## 6. Analytics: a first-party funnel, and the WhatsApp problem

**The internal store is the source of truth.** Every page view and interaction is collected by our own
`/api/collect` endpoint into our own Postgres — non-sampled, ad-blocker resilient, needing no third-party
script, and joinable to completed and *paid* bookings. GA4 and Meta receive a push for ad-platform
optimisation only. That ordering is the whole design.

**The funnel**, ending at outcomes rather than clicks:

```
landing → service viewed → price viewed → CTA click (WhatsApp | Call | Book)
        → booking created → confirmed → attended → PAID
```

The last three steps are what make it worth building. Roughly 5–15% of bookings do not turn up, so any
funnel ending at "booking created" overstates itself and any ad platform optimising on that signal is
optimising for no-shows too.

### The WhatsApp attribution problem, and the fix

WhatsApp is the real booking channel — the prototype's form opens a prefilled chat. So the site's
conversion event is *"clicked WhatsApp"*, and the booking then happens in a conversation the system cannot
see. You can measure cost per click and never cost per booking.

**The fix: a short reference code in the prefilled message.** The `wa.me` text carries something like
`Ref: 7K2Q`, tied to that visitor's session, source and landing page. The client sends it without
thinking; staff paste it into the quick-book screen; the booking is attributed back to the original click.
That is the only path from a Meta ad to a **paid, attended appointment**.

It depends on staff actually pasting it, so **ref-capture rate is a first-class metric on the analytics
page.** If it is low, the funnel reports the gap rather than silently inventing the join. A single
prominent field on the quick-book screen and the code appearing at the top of the chat are what make it
happen.

### Origination

Resolved in strict order: **UTM parameters → click ids (`gclid`, `fbclid`, `wbraid`, `msclkid`) →
referrer → direct.** Click ids are more reliable than referrer for paid traffic and are what permits
reconciliation with the ad platforms later, so they are stored even though nothing reads them yet.
First-touch and last-touch are both persisted onto the customer and the booking.

### Two things that would otherwise make the numbers fiction

**Bot filtering.** We deliberately allow GPTBot, ClaudeBot and PerplexityBot for citation value. On a
low-traffic local site they will inflate page views substantially. Without a filter list and a `bot` flag
on every session, the funnel is meaningless.

**Volume discipline.** "Every interaction" is unbounded. Raw events take monthly partitions with 90-day
retention, rolled up nightly into daily aggregates kept indefinitely. Otherwise the event table becomes
the largest object in the database and starts competing with the booking engine for I/O.

### A privacy distinction that must not be blurred

Internal first-party measurement with **no third-party sharing** is a materially different consent
position from pushing hashed identifiers to Meta. They are governed separately: the outbound pushes stay
consent-gated via Consent Mode v2, and the internal store's lawful basis is a question for the lawyer
rather than an assumption. Conflating them either over-blocks internal reporting or under-protects the
outbound push.

### Server-side push

Runs from the transactional outbox, not the browser: shared `event_id` for dedup, phone and email
SHA-256 hashed after normalisation, `fbp`/`fbc` forwarded, `action_source` correct. The till emits
corrected values and no-shows are pushed as void. Walk-ins and phone bookings never touch the website, so
offline conversion upload with a past event time covers them, with "how did you hear about us" as the
fallback.

**Egress guard.** Service names map to opaque allowlisted category codes before any external payload is
built, with a test enumerating every service. "Arabic Hot Oil Massage" is commercially sensitive and
"prenatal massage" would be a health disclosure — neither leaves the building. The internal store keeps
real names because it never shares them.

### The analytics page

Funnel with drop-off per step · traffic and conversion by source, medium and campaign · landing-page
performance · every tracked interaction ranked · device and breakpoint split · **time-of-day conversion**,
which matters given 11:00–02:00 trading and will likely reveal something the owner does not currently
know · revenue by source joined to paid bookings · and a data-quality strip showing bot-filtered share and
ref-capture rate.

## 7. Accounting: the parts that are actually hard

**Revenue recognition.** "Revenue = sum of bookings" is wrong in at least five ways here. A gift
package sold today is a *liability*, drawn down per session as it is redeemed — not revenue on the day
the customer pays. A deposit is a liability. Tips are pass-through, not revenue. The VAT event and the
revenue event happen at **different times** for a package, and getting that wrong is discovered during a VAT reconciliation, when it is historical.

**Gapless sequential numbering.** Tax authorities check for gaps. The number must be allocated from
a Postgres sequence *inside the same transaction as the document insert* — allocate-then-insert
leaves gaps whenever a transaction rolls back.

**Reverse charge on imported services.** DigitalOcean, Resend, Google, Meta, Anthropic. Incurred
from day one, routinely missed at this size, and mechanical to automate: mark suppliers offshore in
`supplier_tax_profile` and run a nightly job flagging any bill lacking the reverse-charge pair.

**Never edit, always reverse.** No UPDATE or DELETE on `journal_line`. Corrections are dated
reversals; invoice corrections are credit notes. A filed return must be regenerable to the fils
years later, which is why periods lock.

## 8. HR: leave is a scheduling problem

The naive version of leave management is a request table and an approve button. The real version is
that **approving leave changes who can be booked**. If those two systems do not share one source of
truth, the rota says one thing and the booking engine says another, and the front desk stops
trusting the software.

So: approving leave must block therapist availability, surface conflicts with already-booked
appointments, and offer a reassignment flow rather than silently cancelling. Minimum-coverage rules
prevent the owner approving everyone off on a Saturday. And the credential registry works the same
way — an expired labour card removes a therapist from availability automatically and flags their
future appointments, because that block is the module's entire value.

Commission is the other sensitive area: it is where staff disputes happen, so rules are versioned,
calculations are reproducible, and a therapist can see how their number was derived.

## 9. The SEO agent: propose-only by construction

The agent is a scheduled job, not a chat toy. Deterministic pipeline first, LLM only for judgement
and drafting.

Jobs worth doing, roughly in value order: nightly GSC snapshots into Postgres (building the history
GSC discards); CTR outliers at positions 5–20 as title/meta rewrite candidates; queries with
impressions but no dedicated page as content-gap briefs; coverage and ranking anomaly detection;
cannibalisation; internal-link audit; structured-data validation; and a consistency check that
on-site price and hours match Google Business Profile — because when they disagree, AI answers
confidently quote the wrong one.

Guardrails that are architectural rather than advisory:

- The agent's credential is **denied publish at the permission layer.** Not a prompt instruction.
- It may never touch `robots.txt`, canonicals, redirects or `noindex`.
- Keyword expansion is filtered against the blocking lexicon, so non-compliant terms never appear
  as tempting opportunities.
- Fetched competitor pages and SERP content are **untrusted data, never instructions** — this is a
  live prompt-injection surface.
- Per-run token and cost caps; every suggestion logged with before/after and a rollback path.

First slice: the GSC warehouse plus a weekly emailed report with five prioritised actions. No
autonomy at all. Autonomy is earned by the suggestions being measurably good.

## 10. What "LLM SEO" actually requires

Concretely, beyond ordinary SEO:

- **Server-rendered HTML.** Non-negotiable; most AI crawlers do not run JavaScript.
- **Factual density and extractability** — question-shaped headings with stable anchors, direct
  answers in the first sentence, tables for comparable facts.
- **Entity clarity** — consistent name, address, phone, services and prices across the site,
  Google Business Profile, and every directory. AI answers synthesise across sources; disagreement
  produces a confidently wrong answer about your prices.
- **A machine-readable facts endpoint** so the canonical values have one home.
- **A considered `robots.txt` policy** for GPTBot, ClaudeBot, PerplexityBot and Google-Extended.
  This is a strategic trade-off, not a default: blocking protects content but forfeits citation.
  For a local service business that wants to be recommended, allowing is usually right.
- **Citation monitoring** as a KPI — track whether AI assistants recommend you for the queries
  that matter, because that is the channel being optimised.

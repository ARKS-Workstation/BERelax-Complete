# ADR 0066 — pre-consent collection is a projection and not a holding pen, and a session says why its trading date is that date

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** A-FIRST-05
- **Covers:** docs/01 decisions — none; decisions 14, 24 and 25 are recorded in ADR 0018, and this is a
  mechanism under it, beside ADR 0045 (the analytics schema and its retention), ADR 0046 (the taxonomy),
  ADR 0058 (origination) and ADR 0062 (the bot classifier whose verdict this unit stores and never acts on).
  It fills in the columns ADR 0045's schema created and adds the two things that schema could not know the
  ingest would need.

## Context

`/api/collect` is the first-party ingest. Two things about it could not be decided by following an existing
rule, and both would have been decided by accident if nobody wrote them down.

**One.** The internal measurement store is treated as consent-gated while `Y5-analytics-basis` is open —
docs/03's "privacy distinction that must not be blurred" says the lawful basis for the internal store is a
lawyer's question rather than an assumption, and this build takes the stricter reading. So
`analytics.visitor` and `analytics.session` are created **at** consent and never before it. That leaves the
funnel's first stage with nothing to count: `landing` is the denominator every conversion rate on the
analytics page divides by, and a visitor who arrives, reads a treatment page and leaves without answering a
banner has landed. Throwing the event away loses the denominator. Keeping it as though it were consented
loses the position.

**Two.** `analytics.session.trading_date` is `not null` with a real foreign key to `public.business_day`
(migration 0096). Trading runs 11:00–02:00, so between 02:00 and 11:00 `resolveTradingDate` correctly
answers that an instant belongs to **no** trading date — and web traffic does not stop for nine hours a day.
A-FIRST-02 refused to invent an answer and recorded the question as `Y5-funnel-gap-bucket`; but the ingest
has to write a row, today, and the row has to name a date.

## Decision

### Pre-consent collection is an irreversible projection

An event that arrives before a consent decision is reduced, at the boundary, to `+1` against
`analytics.pre_consent_landing` — a bucket of (business day, gap basis, route) and a count. Nothing else is
written: no visitor, no session, no event row, no `Set-Cookie`.

### A session records the BASIS of its trading date, and the database holds it honest

`analytics.session.trading_date_basis` is `trading` when `started_at` fell inside that business day's
`[opens_at, closes_at)` window, and otherwise one of `resolveTradingDate`'s three named reasons — the row is
then filed under the next date the calendar opens. `analytics.assert_session_trading_basis` raises `ZY222`
when the two disagree, in **both** directions.

## The alternative rejected, and the specific way it fails

### Staging the event in a holding pen

The obvious answer to the first problem is to keep the event somewhere provisional and promote it when
consent arrives, or expire it when it does not. It is not available, and the reason is not a difficulty — it
is a contradiction:

- **To promote a row later you must be able to find it**, which means writing an identifier for a visitor
  who has agreed to nothing. That is the same identifier the stricter position exists to withhold, with the
  word "pending" written beside it. A store of pending identifiers is not a weaker version of the position;
  it is the position abandoned with extra bookkeeping.
- **To expire it you need a clock over that identifier**, which is a second retention mechanism over data
  that should never have existed — and the first thing a future maintainer would do with a nearly-working
  promotion path is widen it.

So the reduction happens at the boundary and cannot be undone. Two consequences follow, and they are the
reason this is worth an ADR rather than a comment:

- **When consent never arrives, nothing happens.** There is nothing to promote, nothing to expire and
  nothing for retention to purge — which is why `pre_consent_landing`'s retention policy is
  `keep_indefinitely` beside the nightly rollups rather than a purge with a window. An aggregate with no
  identifier does not age.
- **A subject access request finds nothing, and cannot.** Not "we would decline to return it": the row holds
  no column any of C-CRM-10's five erasure probes can reach, no foreign key for the fourth probe to follow,
  and **no instant of any kind**. That last absence is load-bearing and is why there is no `created_at` and
  no `computed_at` on a table where every sibling has one: a timestamp on a row whose count is 1 is a
  timestamp of one person's visit, and it would make "identifier-free" false. The coarsest thing on the row
  is a date, and it is also the finest.

### Attributing a gap session silently

The alternative to `trading_date_basis` is to pick a trading date and say nothing — which is what a
`not null` column with a default of `trading` produces on its own. It fails in a way nothing can see:
A-FIRST-09 rolls the funnel up per business day and would read nine hours of daily browsing as daytime
trade, every figure internally consistent and every figure wrong. Recording the basis is 0096's own argument
for `attribution.basis` one table over — *"the same tuple reached two ways is different evidence, and the
second is the one that goes wrong quietly."*

Three details of the enforcement are decisions rather than implementation:

- **It compares against `business_day`'s own `opens_at` and `closes_at`,** not against a re-derived
  11:00–02:00 rule. A second derivation would disagree with the materialised calendar on exactly the dates
  somebody overrode the hours for — the days it matters most.
- **It fires in both directions.** A writer that stamped every row with a gap reason would lose precisely as
  much as one that stamped every row `trading`, and a one-sided check would accept it.
- **The column has no DEFAULT.** `trading` is exactly the value a caller who has not thought about the gap
  would receive, and it is wrong for nine hours out of every twenty-four.

## Consequences somebody will have to live with

- **A pre-consent visit is one landing and never a journey.** It contributes to no session, so it can never
  be linked to a booking. The consented share of landings therefore has to be a data-quality figure on the
  analytics page (A-FIRST-10), because a funnel whose first bucket exceeds its second for a reason that is
  not drop-off reads as catastrophic drop-off.
- **The pre-consent count is the client's own claim about its first page view.** With no session there is
  nothing to measure "first page view of a session" against, so the route counts the `entry` flag the
  collector sent. For a consented session the flag is **overwritten** by the server, because a browser has
  never been told which session it is in; pre-consent that correction is not available. The figure is
  therefore a count of arrivals, which is what a funnel's first bucket is, and not a count of people.
- **A session fixture now has to be calendar-consistent.** `packages/db/src/analytics.itest.ts` needed its
  session fixtures moved onto a trading day's own opening instant, because a row whose `started_at` had
  nothing to do with its `trading_date` was always a nonsense row and is now a refused one. Any later unit
  writing a session fixture pays the same small cost.
- **If `Y5-analytics-basis` is answered "legitimate interest",** the pre-consent branch becomes dead code
  and `pre_consent_landing` becomes a historical table — not a migration to unpick, because nothing
  references it and nothing was ever promoted out of it. That asymmetry is the point of choosing the
  stricter position now: the strict answer is cheap to relax and the loose answer cannot be tightened,
  because identifiers already written cannot be un-written.
- **The trading-date basis is not an answer to `Y5-funnel-gap-bucket`.** It makes the cohort visible and
  re-bucketable. The business decision about which trading date daytime traffic belongs to is still open, and
  A-FIRST-09 is the unit that has to act on it.

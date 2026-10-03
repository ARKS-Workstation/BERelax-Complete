# ADR 0103 — the funnel ends at a settled invoice, and the daytime gap is counted rather than resolved

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-FIRST-09
- **Covers:** docs/01 decisions — none. Decision 14 is recorded in ADR 0018; this is a mechanism under it,
  beside ADR 0045 (the analytics schema and its retention), ADR 0066 (a session says why its trading date
  is that date, and `Y5-funnel-gap-bucket` is left open), ADR 0062 (the bot classifier's verdict is stored
  and never acted on), ADR 0102 (first touch and last touch), ADR 0093 (an unreconciled day has no revenue
  figure), ADR 0007 (integer fils, VAT-inclusive gross authoritative) and ADR 0002 (a pass over nothing
  must not answer "all done").

## Context

The funnel has eight ordered steps and ends at `paid` (0096). Three questions had to be answered before it
could be materialised, and each has an obvious answer that is wrong here.

## Decision

### `paid` is a settled INVOICE, and the funnel never computes its own

The terminal step is written from `invoice_settlement.outstanding_fils <= 0` — the same quantity ZT001
refuses to let go negative — and never from a booking status, a payment sum or an event. Conversion is
`paid ÷ landing`, and `conversionRateOf` takes the counts and nothing else: there is no parameter a caller
could pass a different numerator through, and the numerator is derived from `FUNNEL_TERMINAL_STAGE`, which
is the last element of `FUNNEL_STAGES`.

The obvious alternative is `booking_created ÷ landing`. It is the figure every advertising platform's own
dashboard will show the business, because a platform knows about a form submission and not about a payment.
It is higher, it is not revenue, and the gap between the two IS the no-show and cancellation rate — which
is exactly the figure a spa needs and the one a build that reported bookings would hide.

A funnel that counted its own idea of paid fails differently and worse: it would agree with the invoice
until the first refund, and the disagreement would then be between two numbers neither of which was wrong
when it was computed.

### The show-adjusted rate falls out of the counts rather than needing a second query

A no-show carries an `excluded_reason` on `confirmed`: the booking WAS confirmed, and then was not kept.
The show-adjusted conversion is therefore `paid ÷ (confirmed.entered − confirmed.excluded)`, and the
subtraction is what puts the no-show out of both sides — it is in `entered` and in `excluded`, so it
cancels out of the denominator, and it never paid, so it is out of the numerator. Nothing downstream has to
know what a no-show is.

The exclusion is written on `confirmed` and not as a step of its own, because `no_show` is not one of the
eight stages and a ninth member would be a bucket no funnel draws. 0096's
`daily_funnel_excluded_within_entered` is what makes the subtraction exact rather than approximate: an
exclusion is a SUBSET of the step's arrivals, held so by the database.

### A bot's steps are materialised and excluded at the COUNT

ADR 0062's rule is that the classifier's verdict is stored and never acted on; A-FIRST-04 deferred the
funnel's exclusion to this unit by name. So `funnel_step` rows are written for every session including the
crawlers — a step a crawler reached still happened — and `funnelCountRows` excludes bot sessions unless
asked. The two answers then differ by exactly the bot count, because they are the same rows and only the
predicate moves, which is the only arrangement in which that difference is a measurement rather than a
claim.

Filtering at the materialisation was the alternative and it is irreversible: a crawler re-classified as a
human could never be counted back in, because the raw events it would have to be rebuilt from are purged at
ninety days.

### The daytime gap is COUNTED, and nothing in this unit resolves a trading date

Trading runs 11:00–02:00, so between 02:00 and 11:00 no business day contains the instant at all while web
traffic carries on. ADR 0066 records the mechanism 0116 used for `analytics.session` — the row is filed
under the next date the calendar opens and says why in `trading_date_basis`, with ZY222 holding it against
`business_day`'s own instants in both directions — and states plainly that this is **not** an answer to
`Y5-funnel-gap-bucket` and that A-FIRST-09 is the unit that has to act.

**The action is two counts and no third resolver.** `daily_traffic.gap_sessions` and
`daily_funnel.gap_entered` are read off that stored basis, so the cohort is visible and re-bucketable the
day the business answers the question. The business decision stays open; what is now closed is that the
figure cannot be wrong without saying so.

An `analytics.rollup_trading_date(timestamptz)` function was written, applied to a database and removed
before this migration was finished. Two statements of "which trading date does this instant belong to"
already exist and both are enforced — `analytics.session.trading_date` by ZY222 and
`appointment.trading_date` by a foreign key into `business_day` — and a third, consulted only by the
rollups, would disagree with both on exactly the dates somebody overrode the hours for: the days it matters
most. ADR 0066 makes the same argument about re-deriving the 11:00–02:00 rule instead of reading
`business_day`.

The counts sit BESIDE the totals rather than in the key, which is 0096's own shape for `bot_sessions`
beside `sessions`. `analytics.daily_ref_capture` (0127) is keyed on `(trading_date, trading_date_basis)`
and that was right for a table 0127 created; adding to a key 0096 owns would turn one day into four rows,
and A-FIRST-10, R-REP-07 and A-MEAS-07 would each have to learn to sum them before showing a day's traffic.

### Recompute, never accumulate

Every rollup row is a `group by` over the raw tables, deleted and re-inserted per trading date, so two runs
produce byte-identical rows and a corrected derivation converges. The delete is not an optimisation: an
origination tuple that existed last night and does not tonight — a campaign renamed, a session
re-attributed — would otherwise sit in the table for ever at its old count, and nothing would ever
contradict it. A drifted rollup is a figure nobody can audit, because there is no second place to check it
against.

ZY702 refuses a rollup for a trading day that has not closed. A pass at 22:00 would write a day's figures
from half a day's trade; the row would look complete, and the next morning's report would show takings that
fell by half for no reason anybody could find. It is A-MEAS-07's ZY472 about the same calendar one table
over, and it has to exist separately: a reconciliation refusing an open day says nothing about a rollup
writing one.

ZY701 makes the funnel's first bucket a count of SESSIONS unfalsifiable. A session that produced two
bookings would otherwise contribute two `booking_created` rows and report a conversion rate above the share
of people who converted. It is a trigger and not a unique constraint, because `funnel_step` is RANGE
partitioned on `occurred_at` and PostgreSQL requires every unique constraint on a partitioned table to
contain the partition key — a unique `(session_id, step, occurred_at)` would permit exactly the second row
the rule is about.

## Consequences

**The two funnel mappings travel DOWN from `@berelax/core`, as data.** `COLLECTED_EVENT_FUNNEL` and
`APPOINTMENT_STATUS_FUNNEL` are total over their own vocabularies by compilation, and `packages/db` may
never import core (ADR 0001) — so the worker reads them and hands the repository a values list, and a
`Record<AnalyticsEventName, …>` entry nobody added is a build failure rather than an event collected and
never counted. The cost is that the repository's statements join against an array, and a unit test asserts
that no event name or appointment status is a literal anywhere in `packages/db`.

**The funnel is a measurement of WEB journeys, and an offline booking has none.** A booking with no
attributed session contributes no funnel step at all. Its revenue is still attributed, because
`daily_source_revenue` reads `booking_attribution` directly and an offline booking carries
`source = 'offline'` (ADR 0102) — so the till's takings and the funnel's denominator are different
populations on purpose, and a reader comparing them is comparing two answers to two questions.

**The pass gains DELETE on `analytics.funnel_step` and nothing else in that schema.** 0096's rule is that
rows leave `analytics` through `analytics.run_retention` alone; it makes this one exception itself, because
a funnel step is derived and a corrected derivation has to be able to replace it. Without the grant the
re-materialisation is not expressible and the pass would have to accumulate.

**The ordering of three nightly passes is load-bearing and is now fixed in three cron expressions.** This
pass runs at 02:35 — after trading closes at 02:00, which ZY702 enforces, and before A-MEAS-05's 03:17
upload and A-MEAS-07's 04:23 reconciliation, whose internal side it produces. ADR 0093's resolver is no
longer the refusing one: `internalPaidConversions` reads the day's settled documents and the worker derives
each event id through `analyticsEventId`, the same function the enqueuer uses, so the two sides of the
comparison cannot be two different digests. `NO_INTERNAL_TRUTH_ON_FILE` is kept, because `null` and an
empty array remain different answers — a day this pass has not run for must read as *the internal side is
missing*, not as *everything agreed*.

**A-FIRST-07's expired-ref purge rides in this pass.** It was handed here by name, because a nightly pass
needs a cron and a cron needs an agent row. It is the last step, so a failure in it cannot cost the night's
figures, and the "nothing references it" half of the rule is `booking_whatsapp_ref_capture.ref_code`'s
`ON DELETE RESTRICT` rather than a predicate — the statement anticipates the refusal so that one claimed
code cannot abort the purge, and the foreign key remains the authority.

**The funnel's first bucket can legitimately be exceeded by its second.** `landing` counts consented
sessions only, and a pre-consent visit contributes to no session at all (ADR 0066) — so
`funnelOrderViolations` reports that rather than refusing it, and A-FIRST-10 renders it as a data-quality
figure instead of as catastrophic drop-off.

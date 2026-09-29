# ADR 0049 — Places reads are aggregate only, and review content is never cached

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** G-REV-02
- **Covers:** docs/01 decisions — none; this is the mechanism behind the count tripwire in docs/10 §6, and
  it is the answer this build takes to the `[UNVERIFIED]` question docs/10 §8 records under *whether Places
  API terms permit caching review content or only rating and count*

## Decision

**Nothing in this build stores a review body, an author name or a review id that came from the Places API.
Only the aggregate rating and the review count are read, and only those are persisted.**

docs/10 §6 is explicit that Places API (New) is *not* a review feed and is useful for exactly one thing:
reading the aggregate so an INCREASE in the count can be detected without seeing which review is new. It is
equally explicit that whether the terms permit caching review CONTENT is **unverified** — *"Places has
historically been restrictive, so check before storing"* — and docs/10 §8 lists it under build-time items
that are still open. Nobody has checked. The strictest safe reading of an unanswered licensing question is
that the answer is no, which is the rule docs/12 §2 states for every provisional value in this build: they
are always the strictest safe option, never the convenient one.

The obvious alternative is to cache the curated sample and use it. It is genuinely tempting rather than
lazy, because it would make the tripwire *better*: the email could say which reviews arrived instead of how
many, and the reply generator would have text to draft against on launch day instead of waiting for
somebody to paste it. That is the whole of the value this decision gives up, and it is given up because the
downside is not symmetrical. Caching in breach of the terms puts the **listing itself** at risk — the same
category of risk docs/10 §6 gives for refusing to scrape, *"it breaches Google's terms, breaks without
warning, and puts the listing itself at risk"* — and a business whose Google listing is suspended has lost
the acquisition channel this entire Google module exists to serve. Waiting for one answer costs a feature.
Getting it wrong costs the listing.

## How it is made structural rather than remembered

Three mechanisms, and the point of having three is that the first two would each pass on their own while
the decision quietly stopped holding:

1. **The adapter's return type has no field that can hold a body.** `PlaceAggregateReading` in
   `packages/google/src/adapters/places-aggregate.ts` is a place id and three numbers. A caller cannot
   persist what it was never given, which is a stronger guarantee than a caller remembering not to.
   `aggregateOf` is exported separately from the transport call so a test can hand it a payload carrying
   bodies and assert what comes out.
2. **The table has no text column at all.** `google_place_aggregate` (migration 0094) holds
   `rating_tenths`, `review_count` and `curated_reviews_discarded`. Adding a column for a body would be a
   migration somebody has to write and justify, rather than a line inside a function.
3. **A test scans every text column of every table in the schema** for the three fixture bodies after a
   real tripwire run, and a control smuggles one of them into a column and asserts the same scan finds it.
   `apps/worker/src/jobs/review-fallback-intake.itest.ts`. A query against the table the bodies were
   expected in would have passed on the day somebody cached them somewhere else, which is the failure this
   record is about.

The **port deliberately still returns the bodies**, exactly as the real API does. That is not an oversight:
a port that pre-filtered them would move the decision into the fake, and the aggregate-only test would then
pass just as well for an adapter that stored everything it was given.

## The consequences somebody has to live with

- **The tripwire email cannot say what the reviews say.** It says *"2 new reviews"* and carries a deep link,
  and the owner reads them on Google. That is docs/10 §6's own design and it is also the ceiling this
  decision sets: no wording change can improve it while the question is open.
- **`curated_reviews_discarded` is a column that exists to record an absence.** It counts the bodies that
  arrived and were dropped. Without it, a run that discarded three and a run against an API that returned
  none are the same row — and the day somebody asks whether the terms question was ever a real constraint,
  a non-zero number is the evidence that it was.
- **Answering the question is a one-line change and a migration.** If the terms permit caching, the port
  already carries the data, the adapter's narrowing is where it stops, and a column plus a field is the
  whole of the work. This decision is therefore cheap to reverse and expensive to have got wrong, which is
  the shape a provisional decision should have.
- **`docs/10 §8` stays open until somebody reads the terms.** This record is not the answer to that
  question; it is what the build does while there is no answer.

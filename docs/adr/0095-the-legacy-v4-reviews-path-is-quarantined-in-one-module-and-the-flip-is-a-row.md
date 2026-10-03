# ADR 0095 — the legacy v4 Reviews path is quarantined in one module, the flip to API mode is a ROW and not a deploy, and reconciliation has one statement of what a review is

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** G-REV-07
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/10 §6's *"switching to API mode
  is a row in the capability table, not a deploy"* and §7's *"Reviews remaining on legacy v4 while
  everything else migrated is the clearest possible signal it will move."* It stands on ADR 0002 (a check
  that examined nothing is worse than one that failed), ADR 0003 (every gate needs a known-bad fixture
  asserted by rule name), ADR 0008 (append-only evidence), ADR 0022 (every external service behind a port
  with a fake), ADR 0063 (the reply linter is a send-path chokepoint the database enforces) and ADR 0087
  (one sliding window for the per-profile edit cap)

## Why this record is 0095 and not 0009

The manifest's acceptance list names `docs/adr/0009`. **0009 is taken** — it is the authorisation matrix
and mandatory TOTP — and has been since F07. The number allocated to this unit is 0095. A NOTE on the
manifest entry says so, in the same shape ADR 0086 recorded for G-SEO-05's migration number.

## The problem this record is about

There is no Business Profile API access in this build (docs/10 §4, `OPEN-QUESTIONS Y3-gbp-api`, status
**open**), so the entire API path is built against a fake and never selected. That makes it the most
dangerous kind of code in the repository: untested in production, written once, and read again on the day
somebody is under pressure to turn it on. Three things had to be decided.

## Decision 1 — the quarantine is TWO checks, because no single one can make the claim

The acceptance line asks for *"a dependency-cruiser rule asserts only
`packages/google/src/adapters/reviews-v4.ts` references the `mybusiness.googleapis.com/v4` host string"*.
Half of that is not a thing dependency-cruiser can do: it sees module **edges**, not strings. A rule
written as though it could would be a rule that passes for ever while the host is pasted into a worker.

So the claim is held by two checks with a known-bad fixture each:

- **the string half** is `packages/fixtures/src/reviews-v4-quarantine.test.ts`, which scans every
  non-test module under `packages/*/src` and `apps/*/src` and asserts the host appears in exactly one of
  them. It also asserts it appears in that one — a clean tree and a broken pattern read identically — and
  that the pattern does not match `mybusinessbusinessinformation` or `mybusinessaccountmanagement`, which
  are `v1` APIs with a different approval state and whose modules must not be condemned.
- **the edge half** is `.dependency-cruiser.cjs`'s `reviews-v4-is-quarantined`, which permits an import of
  the adapter only from `packages/google/src/reviews/` and the package barrel. A **direct**-dependency
  rule, not `reachable`, for `messaging-providers-only-inside-a-transport`'s reason: the barrel
  legitimately re-exports the factory, so reachability would report the intended design as a violation.

The scan assembles the host from two halves rather than writing it out, because a file that wrote it
would be a second occurrence of the string it scans for — and the exemption that would then be needed is
how a quarantine stops being one. This is the same split `seo-nap-literals.test.ts` makes, and for the
same reason: a rule that cannot see the hazard is not a rule, however strict it is about something else.

**What the quarantine buys** is the manifest's own claim: *a migration is a day not a month*. The cost of
that migration is the number of modules that know the old shape, and that is only one while something
checks.

## Decision 2 — the path is built from the PERSISTED accountId, and a v1-shaped row fails loudly

`v1` returns `locations/{l}`; the `v4` reviews path is `accounts/{a}/locations/{l}/reviews`. The account
is **not recoverable from the location** — it is the thing you enumerated under — which is why
`GbpResourceRef` carries it and why `reviewsPathFor` is reused rather than re-written here. A second
assembler is a second answer to what the URL is, and the day they disagreed one of them would 404 on a
cron job at 03:00.

A capability row holding a `v1`-shaped ref therefore refuses **before any transport call**, at three
points: both URL builders, and the submitter's own **construction** — so a misconfigured row is loud when
it is wired rather than at the first reply. Asserted with a transport spy at zero calls and a limiter with
zero admitted slots, because *the check is before the network call* is the kind of claim a refactor
reverses silently.

There is a second refusal beside it that the acceptance line does not ask for and the schema makes
necessary: `google_reviews.google_review_id` is **nullable** and is NULL on every fallback-mode row, so a
row that has never been reconciled has nothing on the listing to reply to. The first version of that read
was `review.googleReviewId ?? ''`, which would have built `.../reviews//reply` and spent a slot
discovering it. `REVIEW_HAS_NO_GOOGLE_ID` is the named refusal, and it is raised before the limiter.

## Decision 3 — the flip is a ROW, and the module that reads it is the only one

`packages/google/src/reviews/api-mode.ts` is the one place in this build that reads
`google_reviews.delivery_mode` and selects a path from it. There is deliberately no feature flag and no
configuration: a flag would be a second answer to which mode a reply goes out in, and the row is the one
the `google_reviews_delivery_fields_match_mode` constraint already holds the timestamps against.

`manual` makes **no Google call at all** and does not go through `withGoogle`. That asymmetry is the
feature: there is no token to refresh and nothing to degrade, and wrapping it would report a reply the
owner pasted by hand as a degraded API call. It is what makes fallback mode work with no Google
connection whatsoever.

**Why the API call is inside the chokepoint and a lint refusal is not.** `withGoogle` is what turns an
upstream failure into a declared degradation — `quota_exhausted` and `access_not_granted` both degrade
`gbp_reviews` to `draft_only`, append a `health_check_failed` connection event the owner's dashboard
reads, update the capability health, and **return rather than throw**. So the transport call has to be in
the body, which means `deliverApprovedReply` is too, because lint and delivery are one call by design
(ADR 0063: an exported "lint this reply" is an injectable linter with extra steps).

A lint refusal is **not** an upstream failure. `classifyGoogleError` would file it as `TransientUpstream`,
which does not degrade, so the caller would be handed a Google error naming a correlation id instead of
the rule the owner has to fix. The body therefore catches exactly that case — discriminated by
`replyDeliveryRefusalRulesOf`, which answers null for every other error — and returns it as a value.
Anything else is re-thrown for `withGoogle` to classify.

**The degradation is not re-implemented.** `draft_only` is the declared mode in `../consumers.ts` and the
dashboard row is `withGoogle`'s `health_check_failed` event. Both halves are asserted in
`review-api-mode.itest.ts` against the real rows — a **delta** on the event count, never a total, because
other suites write to that table. One figure there is worth recording: `capabilityHealthFor` maps
**both** `AccessNotGranted` and `QuotaZero` to `quota_zero`, because both are *a valid token with no quota
behind it*; the `cause` is what distinguishes them and it is asserted separately. The first version of
that test expected `permission_missing` for one of them and was wrong about the code rather than the other
way round.

## Decision 4 — reconciliation has ONE statement of what a review is, and it is not in this unit

`reconcileApiReviewId` and `ingestApiReview` are G-REV-02's, in `packages/db`, and
`packages/google/src/reviews/reconcile.ts` calls them rather than writing SQL of its own. The matching
rule (`lower(btrim(reviewer_display_name))`, the rating, the review date in a **named** zone), the
`ambiguous` answer, the `for update` lock, the audit row and every CHECK that makes a backfill legal are
stated once. A second reconciliation written for the API path would be a second answer to *is this the
same review*, and the day they disagreed one of them would attach an id — and every later reply — to the
wrong draft.

What this unit adds is the only thing those two cannot decide between them: **which of them to call**. An
API review either matches a manual row (a backfill) or it does not (a new row). `no_match` covers two
situations and `ingestApiReview` tells them apart from its unique index — `inserted` for a review never
seen, `unchanged` for a re-run of the sync — so the pass does not decide that either.

**`ambiguous` writes nothing and is carried out of the pass.** Reviewer name, rating and date are all
Google gives us, and two star-only five-star reviews from *"A Google user"* on one day is an ordinary
Saturday. Picking one would attach the id to the wrong draft silently, so the candidates come back for a
human. That is why the acceptance line's *zero duplicates* is asserted as a row COUNT rather than as the
absence of an error: three pasted rows and four API reviews leave exactly four rows, and the ambiguity
case leaves exactly two.

The date is derived with `toLocal`, which is this build's one instant-to-wall-clock conversion, because
`reconcileApiReviewId` matches on `(reviewed_at at time zone $zone)::date` and a review left at 23:58 UTC
is the next day in Asia/Dubai.

## Decision 5 — the quarterly changelog reading is a calendar ROW, and `obligation_class` gains a value

docs/10 §8's build-time list ends in prose: *read the Business Profile API changelog and deprecation pages
before writing the Reviews adapter, with a recurring quarterly reminder to re-read them*. A recurring
reminder written in a document is a reminder nobody receives. Migration 0145 seeds it into `obligation`,
which is the one table in this build holding a duty with a cadence, an owner role and a blocking
consequence — and therefore the only form of this duty that is visible to the person who owes it. The
alternative, a comment in the adapter, is read when somebody is already changing the file; the whole point
of a quarterly re-read is to notice a deprecation before anybody has a reason to open it.

`obligation_class` gains `operational`, additively. The five classes 0052 declared are `licence`,
`credential`, `hygiene`, `tax` and `labour`, and this duty is none of them — and the compliance calendar
and M-VAT-11's dashboard both GROUP by class, so filing a vendor changelog reading under the nearest one
would show it to an operator under a heading a regulator owns. 0052's own table comment already said the
table holds *"statutory and operational obligation definitions"*. It cannot make anything newly blocking:
`obligation_blocking_effect_matches_class` permits `blocking_effect = 'none'` for every class and reserves
the two blocking effects for `credential` and `licence`.

The row is **not** `is_unverified`, although every row 0052 seeded is. That flag means *the duty itself is
our reading of a secondary source* and it drives the open-compliance dashboard; this duty is stated in the
imperative in this build's own handover, and nobody has to confirm that Google deprecates APIs. A false
positive there is a legal question nobody owes an answer to. `evidence_required` is true, because the
question the reading answers later is *did we know*, and a tick in a box would not.

## Decision 6 — there is still NO reply signature, and that is deferred rather than decided

G-REV-06 handed this unit the SOURCE of the auto-appended signature, and it is **still blocked**.
`OPEN-QUESTIONS Y9-reply-signature` is open: nobody has said what this business signs its replies with,
or whether it wants one. The mechanism exists and is unchanged — `deliverApprovedReply` takes
`signature: string | null` and the 1,200-character cap is measured over the rendered total either way —
so what is missing is the setting, not the code.

`api-mode.ts` passes `signature: null` and the v4 adapter appends nothing, asserted byte for byte. A
plausible sign-off invented here would be indistinguishable from a configured one and would be published
under the owner's name on an indexed page (the brief's rule 15). The settings card is G-REV-06's, and
ADR 0063 records the consequence it meets: a signature is linted like the rest of the reply, so one
naming a person cannot be configured into one.

## What this unit does NOT build

- **No real adapter and no credential.** Every call goes through `BusinessProfileProvider`, a port with a
  fake (ADR 0022), and `delivery_mode` stays `manual` on every row the intake writes. Flipping it at
  deploy-and-check is one audited row change, which is the manifest's own `provisional` note and is now a
  fact a test demonstrates rather than a plan.
- **No new limiter.** The 6/min bucket is `reviewReplyLimit` from ADR 0087's module, deliberately under
  the 10 the profile allows, and it is an **argument** so that one profile has one window across both
  callers. A limiter constructed inside the adapter would be a limiter per instance, which is no limiter:
  the eleventh edit of the minute is the eleventh across every caller.
- **`packages/google/src/reviews/api-mode.ts` is not in the manifest's file list.** It is the flip, and the
  acceptance line asks for the flip to be a row change observed mid-test — which needs a function that
  reads the row. A NOTE on the entry says so.

# ADR 0087 — a manual snapshot is a named human's CLAIM and never an observation, the only write to a Google profile is one field wide, and the edit cap is one sliding window shared by both callers

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** G-SEO-06
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/09's NAP section (*the address on
  the website, the address on the Google profile and the address in the directory listings drift because
  each is a copy*) and docs/10 §7's *"Ramadan variations belong in `specialHours` and a naive write wipes
  them"*. It stands on ADR 0002 (a check that examined nothing is worse than one that failed), ADR 0003
  (every gate needs a known-bad fixture asserted by rule name), ADR 0007 (money is integer fils), ADR 0008
  (append-only evidence), ADR 0022 (every external service behind a port with a fake), ADR 0070 (an
  unattributable figure is a refusal and never a zero), ADR 0085 (an absence a recorded refusal explains is
  not a finding, and NAP comes from the premises row) and ADR 0086 (an admin screen is a `route.ts`, because
  a registry document must be served in both locales)

## The problem this record is about

When the website and the Google Business Profile disagree about when this business closes, an AI assistant
asked the question answers from whichever one it can see — confidently, and wrongly, under the business's
own name. docs/09 says the same of prices. The check that finds the disagreement is easy; the three things
that are hard are what it may do about it, what it is allowed to say it knows, and what it is allowed to
spend.

**There is no Business Profile API access in this build.** The reference is docs/10 §4 and
`OPEN-QUESTIONS Y3-gbp-api` — *"GBP Basic API Access application"*, status **open** — an application
nobody has answered. It is explicitly NOT ADR 0005, which is about non-production not using real
providers: the constraint here is that the access does not exist for anybody, in any environment, and no
configuration change produces it. A previous attempt at this unit was handed ADR 0005 as the citation and
correctly refused to copy it.

## Decision 1 — the degraded mode is a MANUAL SNAPSHOT, and a snapshot is a claim with an author

`localSeoChecker` declares `degradesTo: 'manual_snapshot'` and that mode is the ordinary path at launch,
not an error state. docs/10 §6 states the rule for the whole Google surface: *"A fallback designed as
something you hope not to need is a fallback you never finish."* So the snapshot form is a working screen,
the comparison runs from the pasted values, and the acceptance criterion is the measurable form of it — the
finding count is the same in both arms.

What the record is about is the **epistemics**, which is the part a schema cannot force. A snapshot is *a
named human's claim about what Google shows*. It is not an observation this system made, and the two must
never render as one thing. So:

- `GbpFactProvenance` is a union whose manual arm carries `claimedBy` and `claimedAtIso` as **required**
  fields. There is no optional-provenance shape for a snapshot to be stored without an author.
- every finding names the provenance of **each** of its two values, so a reader sees which side is
  evidence and which is testimony;
- `describeGoogleProvenance` says it in words — *"their account of it rather than an observation"* — and
  the API arm deliberately does **not** carry that hedge, so the distinction is load-bearing rather than
  decorative. A test asserts both halves.

**The snapshot is recorded as an `audit_event` and there is no `gbp_snapshot` table.** That is a decision,
not an omission. `audit_event` is append-only (ADR 0008) and already answers *who said so and when* for
ever, with the actor kind and the staff label on the row. A table of its own would be a second answer to
what the profile said on a given day, with nothing holding the two equal — the brief's rule against a
second statement of a fact. The claim's whole value is the comparison it is made for, and that happens in
the same request.

**The form does not pre-fill the Google column**, and this is the most important line in the unit. A form
that showed the premises row's own hours beside an empty field is answered by pressing Enter, and the check
would then report *"consistent"* about a profile nobody looked at. That is the self-comparison the NAP rule
exists to prevent, arriving through the one door a lint cannot close, so the fields are empty and the
website's figures appear only **after** a submission, in the findings, where they read as a comparison
rather than as a crib. `apps/web/src/gbp-snapshot-render.test.ts` asserts the negative.

**The instant is the person's and is not defaulted.** A blank `observed-at` is refused rather than filled
in with `now()`: a timestamp this build chose would be the system's claim wearing a person's attribution.

## Decision 2 — one finding per DISAGREEMENT, not per day

A wrong closing time on the profile is wrong on all seven days. Seven identical rows is ADR 0085's
cry-wolf failure in its purest form: a reader cannot tell seven copies of one problem from seven problems,
and the section they learn to scroll past is the one the real defect will eventually be in. So days that
disagree in the same way are grouped into one finding carrying the days it covers, and the acceptance
criterion is stated in those terms — a whole-week closing-time divergence plus one price is **exactly
two** findings.

A day or a price only one side holds is **not** a finding. It is reported as coverage, for ADR 0085
decision 4's reason: the comparison has nothing to say about it, and a "missing" finding has no second
value to quote, so it is indistinguishable from a divergence.

**The WhatsApp number is deliberately not compared.** `premises.phone_whatsapp` holds
`WHATSAPP-PENDING-Y1-NAP`, which `is_placeholder_text()` refuses. `Y1-nap` resolved to **neither**
candidate — B-CAT-06 reversed the earlier *"use the prototype number"*, because promoting one would
publish a number that may not reach the business and would be indistinguishable from one the owner had
confirmed. The manifest's `provisional` note for this unit predates that reversal and still says to take
the prototype's `052 510 8633`; it is not taken, and a NOTE on the entry says so. A comparison against a
placeholder would report a divergence on every run about a value nobody has confirmed.

## Decision 3 — the checker cannot reach a write, and the one write is one field wide

Two modules, and the split is the cage:

- `packages/google/src/seo/gbp-consistency.ts` compares and cannot patch;
- `packages/google/src/adapters/business-information-write.ts` patches and is not reachable from the
  checker. `.dependency-cruiser.cjs`'s `gbp-consistency-check-is-read-only` is a **`reachable`** rule
  rather than a direct-dependency one, because the hazard is a hop: a helper that re-exported the write
  would satisfy a direct rule while leaving the checker one import from the PATCH. Gate case 165a is the
  known-bad fixture that proves it fires by name.

This is not tidiness. The checker reports that the two disagree; the obvious next feature is a button that
fixes it, and the obvious implementation is the checker calling the write while it already holds both
values — at which point an agent-driven pass writes to the business's Google profile with no human in
between. The write adapter takes *the periods a human approved* as an argument, and it is reached from the
screen.

The write refuses three different things, each before the transport, because each has a different fix:

1. **no `updateMask`** — Google answers 400 and the round trip is spent proving what the check knows;
2. **a mask this build has not approved** — `UPDATABLE_FIELDS` holds **one** field, `regularHours`. `'*'`
   is the whole-object PATCH, and `storefrontAddress` would be this system overwriting the business's
   address on Google when the authority runs the other way (ADR 0085 decision 6);
3. **a payload wider than its mask** — the naive write, and the only one of the three that destroys data
   rather than failing. A field mask CLEARS a named field the payload does not carry, so a request
   assembled from a whole `getLocation` answer wipes everything the read mask did not cover,
   `specialHours` among them.

The fake reproduces exactly that clearing behaviour, which is what makes *"the Ramadan hours survive"* a
fact rather than an intention: `business-information-write.test.ts` asserts the surviving periods **and**
drives a `updateMask: ['*']` patch through the transport directly to show the fake really would have wiped
them. Without that control the assertion is satisfied by a fake that merges.

An approved update carrying **no** periods is refused too. Patching `regularHours` with an empty list is a
legitimate API call that clears the trading hours, and it is never what an approval to change them means.

## Decision 4 — one sliding window, shared, and it is a sliding window for a measured reason

docs/10 §7 states two caps that are the same cap read twice: *"Edits are capped at 10 per minute per
profile and Google states this cannot be raised"*, and *"Plan a 6/min token bucket against the 10
edits/min cap"* for reviews. `packages/google/src/rate-limit/token-bucket.ts` is one mechanism with two
named figures (`businessInformationEditLimit`, `reviewReplyLimit`), because two limiters would be two
answers to how many edits this profile has spent and the one that is wrong is whichever ran second.

**Why a sliding window and not a refilling bucket.** A continuously refilling bucket at 6/min admits one
call every ten seconds, so twenty calls submitted at once produce **eleven** in the first minute — over the
cap the acceptance criterion names and over the cap Google enforces. A fixed window is wrong differently:
it refills on a boundary, so twelve calls fit inside one sixty-second span that straddles it, and the
limiter's own claim is then false of every window but the ones it chose. A sliding window is the only one
of the three whose claim is true of **every** window.

It queues and never drops. A submitted edit is delivered when its slot arrives, however long that takes,
because the alternative is a change a human approved and a rate limiter silently discarded. A failed call
still spends its slot: Google counted it.

**What it is NOT is durable.** The window lives in one process, so two workers each hold their own. Stated
rather than hidden, and it is the reason the reviews figure is 6 and not 10: the four edits a minute of
headroom is what covers a second worker, a second caller of the same cap, and the fact that *the quota
actually applied to legacy v4* is on docs/10 §8's must-confirm list.

## Decision 5 — the clock AND the wait are injected, as one seam

A limiter is a statement about time, and a test that cannot move time can only assert that nothing was
delayed. `setTimeout` in a suite turns a one-minute window into a one-minute test, so the alternative
every suite reaches for is shortening the window — which proves arithmetic about a figure production does
not use. `simulatedRateLimitClock` advances to whatever instant the limiter asks to wait until, so every
assertion in `token-bucket.test.ts` is about the real sixty seconds and runs in milliseconds.

It is exported from the module under test rather than written twice, because both callers need it and the
brief forbids a second statement of a fact without the check that holds the two equal — and there is no
such check available for a test helper.

## What is NOT built, and where the manifest is wrong

- The manifest's file list names `apps/web/app/(admin)/agents/seo/gbp-snapshot/page.tsx`. The screen is a
  `route.ts` + `handler.ts` + `render.ts` + `view.ts`, for ADR 0086's reason: a registry **document** must
  be served in both locales, which needs the Arabic admin document W-SYS-01 has not built. A NOTE on the
  entry says so.
- The API arm compares **hours only**. Business Information v1 carries no service prices — a profile's
  prices live in a `priceLists` resource docs/10 §7 does not cover and nothing in this build has ever read
  — so a price divergence is the snapshot's to report. Feeding the website's own prices into the API arm
  would make every price agree with itself, which is why the *"finding count is unchanged between modes"*
  assertion is made over the hours divergence both arms can see.
- `integration:connect` is the permission the POST requires, and this is its **first** caller. Only the
  owner holds it. That is a consequence rather than an accident: a snapshot is evidence this build cannot
  check, so who may record one is a decision.

# ADR 0128 — A milestone gate is a WALKTHROUGH plus a CENSUS over the estate, not a registry of tests; and what the walkthrough cannot reach it reports rather than simulates quietly

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** B-M1
- **Covers:** docs/01 decisions — none; this is ADR 0074's "named set" argument taken the other way for a
  different kind of claim, ADR 0002's floor applied to a census, and docs/14 §6's "the loop pauses here
  and reports" turned into assertions

## Context

M1 Bookable is the first of docs/00 §5's seven integration milestones, and docs/14 §6 says the loop
**pauses** at each one and reports rather than rolling on. The unit asks for one walkthrough proving the
whole chain composes, the same walkthrough for the two hard resource shapes, the docs/14 §3 domain
invariant subset wired to fail the build, a deliberately broken fixture proving that gate fires, and the
critique pass recorded.

Every one of the chain's links is already proved by the unit that built it. So the question this unit
had to answer is what a milestone gate adds that forty-two unit test suites do not, and the answer
turned out to be two different things with two different shapes.

## Decision 1 — the walkthrough is a BROWSER pass over the real application, in one session

`apps/web/src/m1-walkthrough.itest.ts` publishes a service it created, reads the treatment select on
`/book`, clicks a day and a slot, fills the phone form, types a code written into the challenge through
the repository's own hasher, confirms, reads the appointment off PostgreSQL, finds it on `/calendar`
behind a real session cookie, and reschedules it.

Driven rather than fetched, and that is the decision. W-SITE-06 deferred *"a Playwright pass over the
whole five-step flow"* here by name, and its own note says why a fetch was right for the claim it was
making and not for this one: steps 1–3 are a GET form set, so a fetch can reach every state the server
renders — but it cannot show that a reader can GET from one to the next. Two things only the browser
found:

- **The measurement-consent banner is fixed to the viewport and intercepts the continue link.** A reader
  has to answer it before they can book. That is the banner working, and it is invisible to a fetch.
- **The seeded database cannot be booked against at all.** Every seeded therapist has `gender` NULL and
  under strict same-gender matching — the provisional answer and the safe direction (`Y9-gender`) — a
  therapist with no gender is eligible for nobody; and `shift` and `shift_assignment` hold no rows, so
  the solver correctly offers nothing until somebody is rostered. The walkthrough therefore owns its own
  therapists and its own rota. A suite that had reused the seed would have reported "no availability" and
  looked like a solver bug.

## Decision 2 — the invariant gate is a CENSUS over every row, not a registry of tests

`MONEY_INVARIANTS` (ADR 0074) is a registry of existing tests, and that was right because each of the
seven money claims is already proved in the only place it can be. The four domain invariants are not
like that. Each is **already enforced** — an exclusion constraint, a capacity trigger, the availability
solver — so a registry of tests over them would re-prove that the guards work, which nobody doubts.

What nothing checked is whether the ESTATE those guards protect actually holds. The rows this gate is
about are the ones written while a guard was absent: before it existed, with it deferred, imported from
the previous arrangement (`appointment.migrated`), or planted by a migration. Every one of those
satisfies every test in the repository and breaks the claim. So `pnpm domain-invariants` re-derives all
four over every row the database holds, the way `pnpm money-invariants` re-adds every money identity.

Three consequences:

- **Each claim is re-derived from the ONE statement of its rule.** The room census calls
  `room_peak_concurrency`, which is the function `assert_room_capacity` itself calls, so the gate and
  the trigger cannot come to disagree about what capacity means. The therapist census is the exclusion
  constraint's claim as a self-join. The close comparison is `hoursOverrideStrandedAppointments`'
  comparison — `endsAt + turnaround > closesAt`, with the close INCLUSIVE, because a treatment plus its
  turnaround may end exactly at close and an exclusive comparison would strand the last booking of every
  day.
- **The floors are most of the value.** Every claim is a query returning the rows that BREAK it, and an
  empty result is a pass — so a wrong join, a filter that matched nothing or an empty table produces
  four passes about nothing. A census that examined no appointment, no room or no trading date is
  refused. That is not hypothetical: a freshly migrated and seeded database holds **no appointment at
  all**, so the floor fires on the most ordinary state there is.
- **The after-midnight population is PRINTED on every run, including a clean one.** Claim four is about
  a 01:30 start belonging to the previous trading date, and an estate with no such appointment has not
  exercised it. Brief rule 22's rule applied to a census rather than to a generator: count how many of
  the examined rows could actually disagree, and say so out loud when the answer is zero.

### Why it is a verify step AND a CI job of its own

docs/14 §3 says the domain invariants *"run on every unit regardless of what changed"*, so it is a step
of `pnpm verify`, immediately after `pnpm money-invariants` — both read the estate the integration suite
just wrote. The acceptance line also asks for *"its own CI job"*, and that job runs the **walkthrough
first and the census second**: the census refuses an empty estate, so a job that only migrated and
seeded would fail on the floor, correctly and uselessly. Judged over the rows the milestone is actually
about, it is the milestone's own reading.

## Decision 3 — what the chain cannot reach is REPORTED, with the assertion that says so

Three links do not compose, and each is recorded as an assertion rather than as a comment, so the day
somebody wires it the walkthrough fails and sends them here:

- **Nothing consumes `booking.created`.** The booking transaction publishes that outbox event in the
  same transaction as the rows (ADR 0008), and no handler is registered for it anywhere in
  `apps/worker`. So no confirmation SMS is sent by anything. The walkthrough asserts the event exists
  **and that it is still unpublished afterwards**, with the message that says what to do when that stops
  being true.
- **Nothing confirms an online booking.** The public flow leaves the appointment `requested`, and the
  reminder set is built by the CONFIRMED transition — which is the one seam where "confirmed creates the
  set, rescheduled supersedes it" is true. The walkthrough confirms it through the real transition with
  the real maintainer injected, and says that only the confirmation is simulated.
- **No screen can book a couple or a four-hands treatment.** Neither `/book` nor `/quick-book` has a
  party-size or shape field. The couple shape is therefore booked through `bookSlot` — the real
  transaction, with the real room lock — and its two therapists, its capacity-2 room and its two client
  places are asserted; the five-step walk is not repeated for it, because there is nowhere to walk.

The money leg stops for a fourth reason and a different kind: an issued tax invoice needs the issuer's
TRN, none is configured (`Y1-trn`) and none may be invented (brief rule 15). So the walkthrough asserts
the identity the booking transaction wrote and every later document derives from — `net + vat === gross`
exactly — and leaves the invoice, the payment and the journal entry to `till.itest.ts`'s M2 slice, which
proves them at the handler level with a fixture issuer.

## Consequences

- `pnpm domain-invariants` joins `pnpm verify` and CI and is registered in `scripts/test-gates.mjs` case
  29. A future migration that adds a table with appointments in it adds nothing here: the census derives
  its table list from the catalogue and its claims from the rows.
- The census will FAIL on a database nobody has written appointments to, which is the correct answer and
  will surprise somebody. The failure says so in as many words.
- `/tag-loader`, `/therapists` and `/therapists/[slug]` are removed from
  `lighthouse/budget.json`'s `matrixCoverage.alreadyUncovered` because this suite now audits them with
  axe in both themes and baselines each. The coverage is DERIVED from the suites, so the gate case that
  proves it works removes the axe call and watches the three read as uncovered again — and that case
  found a real defect in its own first version: the file's doc comment quoted the scan's search string,
  which kept the string alive after the call was removed and made the case pass against a suite that
  audited nothing. Brief rule 20's failure in a comment rather than in a `replace`.

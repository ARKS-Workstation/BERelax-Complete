# ADR 0041 — approving leave never cancels an appointment, and the coverage refusal is a difference

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** P-HR-09
- **Covers:** docs/01 decisions — none; this is the boundary between two things the build already had, the
  leave period ADR 0007's `business_day` primitives define and the appointment lifecycle ADR 0015 protects

## Decision

Three things, and each one is a refusal to do something that would look like a feature.

1. **No code path reachable from a leave approval writes `appointment.status`.** A conflict between approved
   leave and a booking is resolved by P-HR-04's reassignment or by an audited override that leaves the booking
   standing. There is no third option, and in particular there is no "cancel the appointments" path — not
   behind a flag, not behind a confirmation, not as a bulk action.

2. **The coverage refusal is a DIFFERENCE, not a total.** An approval is refused for the segments that are
   covered without this leave and not covered with it. A segment already short is reported and is not a reason
   to refuse.

3. **A leave period is stored over trading-session instants, and the database holds it so.** A day of leave on
   the 17th runs 11:00 on the 17th to 02:00 on the 18th. `leaveCoveragePeriod()` in `@berelax/core` computes
   it, and migration 0092 refuses (`ZY006`) a `leave_request.period` bounded by a LOCAL MIDNIGHT that falls
   inside an open trading session — so the rule does not depend on the caller having used that function.

   The rule is that narrow on purpose. "No bound may fall strictly inside a session" is the same claim in a
   more plausible costume and it is wrong: a PARTIAL day off is stored as 11:00–15:00, five existing suites
   store one, and `tp_net` in `eligibility.ts` subtracts the fragment exactly as it subtracts a whole session.
   That version shipped for an hour and `availability-perf.itest.ts` — a file this unit never touched — is what
   said so, from a gate run.

## Why an approval may not cancel a booking

The obvious alternative is attractive and it is what an operator asks for: the therapist is away, the
appointment cannot happen, cancel it. It fails for a reason that is not about leave at all.

`appointment.holds_resources` is GENERATED from the status (migration 0024), so **any** new status releases the
therapist and the room. `cancelled_by_salon` additionally carries a cancellation policy, a refund position and
a customer notification — docs/03 §2 makes all three depend on *who* cancelled. So a cancellation as a side
effect of an HR decision tells a customer their booking is gone, sets a refund in motion, and does it under a
reason that names the salon, because somebody was granted a holiday they had earned. The customer learns about
it from a message. Nobody decided it.

0058's header already recorded the same conclusion for the credential sweep, and P-HR-04 built the alternative:
a reassignment writes **one column** and leaves the booking, the price, the room, the period and the delivery
byte-identical. The override is the other half — some appointments should not move, because the client asked
for that therapist — and it is a recorded decision with a role and a written reason rather than a silence.

**The cost we accept.** An approval can be blocked indefinitely by a conflict nobody resolves. That is
deliberate: the blocked thing is an HR decision inside the business, and the alternative is a customer-facing
cancellation. Of the two, only the first is visible to somebody who can act on it.

**How the claim is checked, and why a list would not do.** `packages/fixtures/src/hr-leave-approval.test.ts`
walks the module graph reachable from the approval entry points — resolving imports **per symbol**, so
`@berelax/core`'s barrel does not drag in the whole lifecycle machine — and collects every appointment status
any reached module can write, out of the source with comments stripped and strings kept. A hand-written list of
"statuses we do not write" would be a second statement of the fact, it would still pass if the approval path
started cancelling appointments tomorrow, and it would pass with the approval module deleted. The scan is shown
firing over `cancel.ts` and over the approval path with a cancellation spliced in, because every assertion it
makes is an empty result (ADR 0002).

## Why the coverage refusal is a difference

"An approval that would **drop** floor coverage below the configured minimum is refused" — the word is
load-bearing. An absolute reading refuses an approval whenever any segment of the leave's days is short, for
any reason:

- On a database whose `shift` table is empty — which is every seeded database in this build — every segment of
  every day breaches, so no leave could ever be approved.
- The refusal would name a segment the requester cannot do anything about.
- A rota that is short on Tuesday afternoon would block leave on Tuesday morning.

So `coverageBreachesCausedBy` calls P-HR-06's `validateRota` **twice** over identical arguments bar the leave,
and returns the set difference. Both halves are that validator's, which is what "reusing the P-HR-06 validator"
has to mean: if the floor minimum, the containment test or the segment grid changes, both halves change with it
and this unit says nothing new. A second coverage rule would disagree with the first on the boundary minute,
and the screen would print one answer while the transaction refused for the other.

**The consequence to live with.** The floor can be eroded one approval at a time down to the minimum but never
through it, and a rota that is already non-compliant stays non-compliant — leave approval is not the surface
that fixes it. The rota screen is.

**And the presence the check reads is net of leave already approved**, which the publish path's use of
`validateRota` is not: `publishRota` hands it raw `shift_assignment` rows, which is right for the question a
publish asks — is this DRAFT publishable — and wrong for "is the floor covered". Without the subtraction, a
second approval would be judged against a floor that still counted somebody who is away. The subtraction is
PostgreSQL's multirange difference, the same operator `tp_net` in `eligibility.ts` uses, so there is one
implementation of "presence net of leave" in the system.

## Why two concurrent approvals need a lock you can see

Two approvals for two **different** therapists on one trading date conflict on no row.
`leave_request_no_overlapping_approved` is per employee; no constraint can express "at least two therapists are
on the floor", because that is a count over other people's rows. So without serialisation each transaction
reads a floor that still holds the other therapist, both coverage checks pass, and the floor ends up one short
with every check having said yes.

`leave_coverage_lock` is one row per trading date, taken `for update` in ascending date order at the top of
`approveLeaveRequest`. The second transaction blocks, and then re-reads `employee_approved_leave` — which the
first approval has committed to — so it is refused **by the coverage check inside its own transaction**.

An advisory lock would do the same thing and be invisible in the schema. ADR 0023's row-locked counter is the
precedent and the reason carries over: a lock you can see is a lock the next person knows not to remove.
Ascending order because two transactions taking two dates in opposite orders deadlock, and a deadlock arrives
as a 40P01 that names neither leave request.

## What this forecloses

- **A bulk "cancel everything and approve" action is now a schema change**, not a feature: there is no path to
  write a status from here, and the scan fails if one appears.
- **An approval cannot be recorded without the coverage version that judged it.** `leave_approval` carries
  `coverage_rule_effective_from` NOT NULL, so answering Y9-coverage publishes a new rule version and leaves
  every earlier approval's record true — 0081's argument, taken a fifth time.
- **The reservation and the release of leave DAYS stay outside this unit.** 0066 is explicit that a request
  reserves when it is made and approval only makes the reservation final, so this unit writes no
  `leave_movement` row in either direction. The submission path is P-HR-14's, and a release with no reservation
  would create leave out of nothing.

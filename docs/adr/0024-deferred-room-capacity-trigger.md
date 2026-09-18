# ADR 0024 — the room-capacity trigger is DEFERRABLE INITIALLY DEFERRED, and the therapist constraint is not

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** B-AVAIL-01
- **Covers:** docs/01 decisions — none; this is the mechanism behind the one ADR 0015 chose for decision 9

## Decision

Room capacity is enforced by

```sql
create constraint trigger appointment_room_capacity
  after insert or update on appointment
  deferrable initially deferred
  for each row execute function assert_room_capacity();
```

The trigger counts the **peak number of overlapping resource-holding appointments** in the room and
compares it to `rooms.capacity`. The therapist half of the same requirement is a plain, immediate
exclusion constraint:

```sql
constraint appointment_therapist_no_overlap
  exclude using gist (therapist_id with =, period with &&) where (holds_resources)
```

Two mechanisms, and only one of them is deferred. Both decisions are in
`packages/db/migrations/0024_appointment_constraints.sql`.

## Why the room cannot be an exclusion constraint at all

An exclusion constraint says "no two rows may both satisfy this". It has no form that says "at most
*N* rows may". The couples room holds two clients: two overlapping appointments are correct and a
third is not, and there is no `EXCLUDE` that expresses the difference. So the room is a count, and a
count in PostgreSQL is a trigger.

That is the whole reason the two halves of "no double booking" look so different in the schema. A
reviewer's first instinct is that the trigger is the sloppy one and should be an exclusion constraint
too; it cannot be.

## Why DEFERRED, and the fixture that proves it

A counting constraint can never be *transiently* violated by INSERTs alone, because counts only go
up. Deferral therefore looks like decoration. It is not, and the case that shows why is the UPDATE —
a rearrangement, which is the most ordinary thing a front desk does.

The regression is kept as a fixture in `packages/db/src/schema/booking-constraints.itest.ts`
(`the IMMEDIATE variant is the regression that justifies DEFERRED`). It attaches an **identical**
trigger without `deferrable`, runs a legitimate transaction against it, and asserts exactly where it
fails.

The transaction: the capacity-2 couples room holds a couples booking **B** (two appointments,
19:00–20:00) and a single appointment **C** at 20:00–21:00. They swap slots.

| statement | state after it | IMMEDIATE | DEFERRED |
|---|---|---|---|
| move B's first appointment to 20:00 | 20:00 holds C and B₁ — two, the room's capacity | accepted | accepted |
| move B's **second** appointment to 20:00 | 20:00 holds C, B₁ and B₂ — three | **refused, `room_over_capacity`** | accepted |
| move C to 19:00 | 19:00 holds C, 20:00 holds B₁ and B₂ | never reached | accepted |
| COMMIT | valid: peak is two, in a capacity-two room | — | accepted |

The immediate variant refuses the **legitimate second couples row**. There is no ordering of those
three statements that avoids it: the swap is a permutation, and a permutation applied one row at a
time passes through a state where one slot holds one row too many. The only alternatives an immediate
trigger leaves are to express the whole rearrangement as a single `UPDATE ... FROM` — and hope nobody
ever writes the loop — or to cancel the bookings and re-take them, which loses their history and
their idempotency keys.

Deferring the check to COMMIT makes the transaction, rather than the statement, the unit the invariant
applies to. That is the same argument M-TILL-02 made for the journal balance trigger (ADR 0017): an
entry balances as a whole, its lines arrive one at a time, and an immediate check would reject the
first line of every entry ever posted.

The second half of that fixture is what stops the decision being vacuous: after the immediate variant
is dropped, the identical three statements are run again under the shipped deferred trigger and the
transaction **commits**. And a third case proves the deferred trigger is not simply a trigger that
never fires — the same swap with C left where it is ends genuinely over capacity, and COMMIT refuses
it.

## Why the exclusion constraint is NOT deferred

`appointment_therapist_no_overlap` is immediate, and the asymmetry is deliberate. A therapist in two
places is wrong at every instant, including inside a transaction: there is no rearrangement that
legitimately passes through it, because a swap of two therapists' appointments changes
`therapist_id` or the period of each row exactly once and never produces a moment where one therapist
holds two overlapping rows — unless the final state does too.

Failing immediately is also better for the caller. The statement that caused the conflict is the one
that reports it, which is what lets the booking path say *which* therapist is unavailable rather than
"something in this transaction was". A deferred exclusion constraint would surface as a COMMIT
failure with the two conflicting rows named and no indication of which of them the user just asked
for.

`btree_gist` is what allows the `uuid` equality and the `tstzrange` overlap in one index. Without it
the constraint cannot be written at all, which is why the extension is installed by `0001` and listed
in `REQUIRED_EXTENSIONS` rather than merely being available.

## Why the predicate is on the constraint, and why it is a generated column

Three things read "does this appointment still hold its therapist and its room": the exclusion
constraint, the partial GiST index the capacity trigger's overlap lookups run through, and the
trigger itself. Spelled out three times it is a rule that will disagree with itself the first time a
status is added and two of the three are updated.

So it is one stored generated column, `appointment.holds_resources`, which the database itself keeps
in step and which an `EXCLUDE ... WHERE` can still reference (the expression is immutable: an enum
compared against an array of literals).

**PostgreSQL 16 does accept a `WHERE` predicate on an `EXCLUDE` table constraint**, both inline in
`CREATE TABLE` and through `ALTER TABLE ... ADD CONSTRAINT`. This was verified against the running
server before the constraint was written, because the answer decides the shape: it is `UNIQUE` that
has no partial constraint form and must be spelled as a partial unique *index* instead. Writing the
exclusion as an index was therefore never an option — there is no such thing as an `EXCLUDE` index
without a constraint — and the constraint form is what makes a violation arrive as SQLSTATE `23P01`
naming the rule, rather than as a generic index error.

Without the predicate, cancelling an appointment and re-booking the freed period for the same
therapist — the correction a front desk makes most often — would be refused by the constraint that
exists to protect that slot.

## Why the capacity check counts overlap, not the day

`assert_room_capacity` and the `rooms.capacity` guard both call one function,
`room_peak_concurrency(room, window)`, so there is no second query that could answer differently.

It computes a true peak: for `[)` intervals the greatest number simultaneously open is always attained
**at one of their lower bounds**, so evaluating the count at each lower bound inside the window is
exhaustive rather than a sample. Two wrong implementations were rejected:

- **Count the appointments overlapping the new one.** In a capacity-2 room holding 10:00–12:00 and
  18:00–20:00, a new 09:00–21:00 appointment overlaps both, so the count is three — but at no instant
  are three people in the room. This refuses legitimate bookings, which is the worse direction to be
  wrong in: it presents as "no availability" with no reason given.
- **Count the room's appointments for the trading day.** Wrong the same way and more often. It also
  makes `rooms.capacity` impossible to reduce: a capacity-2 room with two appointments at different
  times of one evening would refuse a reduction to 1 for ever, and an admin who cannot correct data
  is worse off than one with no guard.

## The mirror-image guard, and its time window

`rooms.capacity` is data (0012) precisely so a second couples room with three plinths is not a
migration. That means an admin can lower it, and the appointment trigger — which only fires on
appointment writes — would never see it. The invariant would break from the side nothing was
watching, and the failure would be discovered by a customer standing in a room with no plinth.

So `rooms` carries `rooms_capacity_covers_commitments`, raising a named `capacity_below_committed`
error. It is **immediate**: reducing a capacity is a single-row administrative change with nothing
transient about it, and a deferred version would report the failure from the COMMIT of whatever else
the admin screen happened to be doing.

It counts only appointments that have **not yet ended**. A past appointment happened; no capacity
number changes that, and refusing a reduction because of last year's bookings is the "can never be
corrected" failure above in a slower form.

One trap the fixture room exists to avoid, and which the test asserts by name: 0012's
`rooms_couples_holds_two` already refuses *any* couples room below capacity 2. Testing the reduction
against the seeded couples room would be rejected by that constraint instead, and
`capacity_below_committed` could have been dead code for ever while the test reported success. The
case therefore uses a capacity-2 `standard` room and asserts the two rules separately, each by its
own name.

## Consequences

- **A booking transaction must handle a failure arriving from COMMIT.** `room_over_capacity` is not
  raised by any statement the booking path issued; it arrives from `withUnitOfWork`'s commit, the
  same way `UnbalancedEntry` does. A caller that only wraps its INSERTs in a try/catch will report
  success on a booking that did not happen.
- **Concurrency still needs the room lock.** Deferral moves *when* the count is taken, not whether
  two concurrent transactions can each take it and each see two. docs/01 decision 9 pairs this
  trigger with `SELECT … FOR UPDATE` on the `rooms` row inside the booking transaction; that lock is
  B-AVAIL-06's to take, and without it two simultaneous bookings can both commit a third overlapping
  appointment. The trigger is necessary and not sufficient.
- The deliberate serialisation point is therefore the room row, on the busiest write path in the
  system. At this volume it is the cheapest correct option.
- Every appointment write pays one peak-concurrency query at commit. It runs through
  `appointment_room_period_idx`, a partial GiST index on `(room_id, period)`.
- Tests assert that the constraints **reject** overlaps, never that the application avoided them.

## Rejected

**An immediate constraint trigger.** Rejected by the fixture above: it refuses a legitimate
rearrangement, and the workarounds are a single-statement update nobody will maintain or a
cancel-and-rebook that destroys history.

**A materialised `room_occupancy` count column with a `CHECK`.** Rejected because the count would have
to be maintained by a trigger anyway, and a denormalised count that disagrees with the rows it counts
is a worse failure than no check: it fails *open*, and nothing ever tells you.

**Serialisable isolation instead of a trigger.** Rejected as a much larger commitment for a narrower
guarantee. It would push retry handling into every write path in the application, and it protects only
against concurrent transactions — a single transaction that over-books a room on its own would still
commit.

## See also

- [ADR 0015](0015-double-booking-prevented-in-the-database.md) — double-booking is prevented in the
  database; this record is the mechanism it named for the room half.
- [ADR 0017](0017-accounting-journal-and-no-auto-filing.md) — the same deferred-to-COMMIT argument for
  the journal balance invariant.
- [ADR 0006](0006-sql-first-migrations.md) — the migration is the schema; Drizzle mirrors it, and
  neither the exclusion constraint nor the trigger is expressible in the mirror.
- `packages/db/migrations/0024_appointment_constraints.sql` and
  `packages/db/src/schema/booking-constraints.itest.ts`.

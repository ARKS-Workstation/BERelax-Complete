# ADR 0015 — double-booking is prevented in the database, not in the application

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decisions 9, 18

## The problem is a race, so the fix has to be a constraint

Two receptionists, two phones, the same 8pm slot. An application-level check reads availability, finds
it free, and writes — twice. The window is milliseconds and the failure is a customer arriving to
find no therapist. No amount of careful application code closes it; only the database can, because
only the database serialises.

There are two different constraints hiding in one requirement.

**A therapist cannot be in two places.** That is exact, and PostgreSQL can express it directly:

```sql
exclude using gist (therapist_id with =, period with &&)
```

`btree_gist` is what allows the integer equality and the `tstzrange` overlap in the same index. This
was proved against a real database in F02, before any scheduling logic existed — the point of doing it
first was that the whole availability engine rests on it.

**A room holds as many people as it holds.** A couples room with capacity 2 legitimately allows two
overlapping appointments and must refuse a third. An exclusion constraint cannot express "at most N
overlaps", so this one is a **deferred constraint trigger** that counts overlapping appointments
against `rooms.capacity` at commit time, plus `SELECT … FOR UPDATE` on the room row inside the booking
transaction so two concurrent bookings for the same room serialise rather than both passing the count.

Deferred matters: a legitimate reschedule may move two appointments through a momentarily invalid
state within one transaction, and a non-deferred trigger would reject it.

## Consequences

- The application still checks availability, for the user experience. The database check is what makes
  it *true*, and a violation surfaces as a constraint error the booking path must handle rather than
  as a wrong answer nobody notices.
- Every appointment write goes through one transaction that touches the room row. That is a
  deliberate serialisation point on the busiest write path, and it is the cheapest correct option at
  this volume.
- Tests assert the constraint rejects overlaps rather than asserting the application avoided them.

## Extensions

`btree_gist` (the above), `pgcrypto`, `pg_trgm` (customer and service search), `unaccent`. **No
PostGIS** — it was only needed for outcall zones, and outcall is out of scope. Extensions are
installed by migration `0001` and their presence is asserted by an integration test, because an
extension that is *available* and not *installed* fails at the first booking rather than at deploy.

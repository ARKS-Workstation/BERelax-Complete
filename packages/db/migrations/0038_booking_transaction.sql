-- 0038 — the booking transaction: what a room place actually is, and the four figures an
--        appointment has to freeze at the moment it is sold.
--
-- Three defects that earlier units found, measured and deliberately left to the transaction that
-- would have to write the columns. All three are corrected here, and the first is a change of meaning
-- rather than an addition.
--
-- ## 1. `rooms.capacity` counts CLIENTS; the trigger counted appointment ROWS
--
-- `0012_rooms.sql` documents `rooms.capacity` as the clients a room holds at once, and docs/13 §4
-- states the Four Hands footprint as **2 therapists, 1 standard room, 1 client**. B-CAT-06 measured
-- the inventory against that and seeded three standard rooms at capacity 1, correctly — there is one
-- client.
--
-- `0024_appointment_constraints.sql` then stores **one appointment row per therapist** and counts
-- those rows against that column. So a Four Hands is one client to the inventory and two places to
-- the trigger, and in every standard room the salon owns the second row is refused at COMMIT with
-- `room_over_capacity`. B-AVAIL-03 verified it against real PostgreSQL and returned zero slots for
-- Four Hands rather than a slot the booking transaction could not commit; B-AVAIL-04 found the mirror
-- image in `packages/core` (`roomPlacesTaken` counting records where the SQL counts rows) and left
-- both to this unit. The two units disagreed about what a "place" is, and a shape the business sells
-- was unbookable in consequence.
--
-- The counting rule is the defect, not the inventory. A row is a *therapist*; a place is a *client*.
-- Two columns of two different units cannot be compared, and the one with a stated meaning is
-- `rooms.capacity`. So this migration gives the appointment the two facts the count actually needs:
--
--   * `delivery_id` — the rows of ONE delivery share it. Two therapists over one client is one
--     delivery, two rows, one delivery id.
--   * `room_places` — the clients that delivery puts in the room. 1 for solo and Four Hands, 2 for
--     Couple Massage; `service_resource_shape.min_room_capacity` is where it comes from.
--
-- and `room_peak_concurrency` is re-issued to sum places over DISTINCT deliveries instead of counting
-- rows. The name is kept: the measurement is unchanged — a true peak at an instant, never a daily
-- total (ADR 0024) — and only its unit is corrected, from rows to clients, which is what the name said
-- all along. Two functions answering one question during a change is how the two units came to
-- disagree in the first place.
--
-- Both columns carry a DEFAULT, and the defaults are not a convenience. `uuid_generate_v7()` per row
-- means "this row is its own delivery" and `1` means "one client", so a writer that has never heard of
-- a delivery produces exactly the old row count — the STRICTER reading. The permissive direction here
-- would be a caller silently merging rows into one delivery and being handed a place the trigger
-- refuses at COMMIT, and no default can reach it.
--
-- One delivery is one room over one period, so `appointment_delivery_is_coherent` refuses a delivery
-- whose rows disagree about the room, the period, the trading date, the shape or the places. Without
-- it, `max(room_places)` per delivery is a guess about which row to believe, and a reschedule that
-- moved one row of a Four Hands would silently split it into two deliveries — two places, and the
-- refusal would arrive at the next booking rather than at the move. DEFERRABLE INITIALLY DEFERRED for
-- exactly the reason the capacity trigger is: the statements of a legitimate rearrangement arrive one
-- at a time, and the intermediate state is not the state being judged.
--
-- ## 2. The appointment snapshotted neither turnaround nor the therapist buffer
--
-- `solve.ts` states that it does — "both figures are snapshotted onto the appointment when it is
-- booked, so a Morocco Bath booked yesterday still holds its wet room for 30 minutes after the owner
-- reduces the standard turnaround to 15 today" — and the columns were not there, so
-- `readCommittedAppointments` re-derived both from the catalogue at today's figures. That is the
-- retroactive occupancy change the comment warns about: shortening the turnaround moves the busy
-- interval of every appointment already taken, and the first sign of it is a double booking.
--
-- Both are NOT NULL with no default. There is no honest default for either — 0 is a claim that the
-- room is free the instant the treatment ends — so every writer states them and a missing snapshot is
-- a `not_null_violation` rather than a quiet zero.
--
-- ## 3. The price was a gross with no split and no provenance
--
-- `gross_price_fils` was already snapshotted (0024) and is authoritative (ADR 0007). What was missing
-- is the rest of what `resolvePrice` returns: the net/VAT split, and WHICH rule produced the figure.
-- `price_list_id` and `promotion_id` are null-when-considered-and-not-applied rather than absent, the
-- distinction `ResolvedPrice` makes, because those two fields are how a disputed figure is settled a
-- year later.
--
-- `net_fils + vat_fils = gross_price_fils` is a CHECK and not a comment: VAT is derived as the
-- remainder precisely so the identity holds exactly, and a stored pair that fails it is a one-fils
-- discrepancy somebody has to explain to an auditor.
--
-- ## What is deliberately NOT here
--
-- `appointment.therapist_id` still has no foreign key. `references employee (id)` is the constraint
-- that fits and it is not the claim worth making: `employee` holds every employee, so it would accept
-- a receptionist as the therapist of a massage while reading as though it had proved otherwise
-- (B-AVAIL-04's NOTE). The claim is "an employee holding the skill this treatment's style requires, on
-- shift, not on leave, credentialled, and gender-matched" — B-AVAIL-04's read model and B-AVAIL-05's
-- rule, re-applied inside the booking transaction against rows read under the room lock. That is
-- `createBooking`'s, and a `therapist_not_eligible` refusal names it.
--
-- `booking_idempotency` gains nothing. Its PRIMARY KEY on `idempotency_key` (0024) already is the
-- unique constraint the acceptance line asks for, and it is what makes a double tap block rather than
-- race: the second transaction waits on the index until the first commits or rolls back. A second
-- UNIQUE on the same column would be a duplicate index and a second answer to one question.
begin;

-- ------------------------------------------------------------------------------------------------
-- The delivery, the places it occupies, and the figures it freezes
-- ------------------------------------------------------------------------------------------------

alter table appointment
  -- The rows of one delivery share this. Defaulted per row so an existing writer produces one
  -- delivery per row, which is the old row count and the stricter reading of capacity.
  add column delivery_id              uuid        not null default uuid_generate_v7(),
  -- Clients this delivery puts in the room, from service_resource_shape.min_room_capacity. NOT the
  -- therapist count: that is what made a Four Hands unbookable.
  add column room_places              smallint    not null default 1,
  -- Minutes the ROOM stays held after the treatment, as configured when the booking was taken.
  add column turnaround_minutes       smallint,
  -- Minutes the THERAPIST is held either side. A different resource and a different duration; there
  -- is no derivation between the two (docs/06 B1).
  add column therapist_buffer_minutes smallint,
  -- The net/VAT split of the snapshotted gross. Derived as net = roundHalfUp(gross x 10000 / 10500)
  -- and vat = gross - net, so the identity below holds exactly (ADR 0007).
  add column net_fils                 fils_nonneg,
  add column vat_fils                 fils_nonneg,
  -- The rate the split was taken at, in basis points. 500 is the UAE standard rate and the only rate
  -- this catalogue supplies; the column exists so a stored split says how it was arrived at rather
  -- than leaving a reader to infer it from the digits.
  add column vat_rate_bp              smallint    not null default 500,
  -- Which effective-dated override produced the gross, when one did. RESTRICT: the row is the
  -- explanation of a figure already taken, so it cannot be deleted out from under it.
  add column price_list_id            uuid        references price_list (id) on delete restrict,
  -- The promotion that discounted it. No `promotion` table exists and no unit in the manifest owns
  -- one (B-CAT-04's NOTE), so this references nothing yet and the unit that adds the table adds the
  -- foreign key.
  add column promotion_id             text;

-- Backfilled before the NOT NULLs below. In a fresh database this touches zero rows; in a developer's
-- it is the same arithmetic the pure resolver does, run once, so an existing appointment ends up with
-- the split it would have been sold at rather than with a zero.
-- Correlated subqueries rather than an UPDATE ... FROM: the buffer lookup has to match on
-- `a.shape`, and a join condition in the FROM list cannot reference the UPDATE target.
update appointment a
   set turnaround_minutes = (
         select s.turnaround_minutes
           from service_variant v
           join service s on s.id = v.service_id
          where v.id = a.service_variant_id
       ),
       therapist_buffer_minutes = coalesce((
         select srs.therapist_buffer_minutes
           from service_variant v
           join service s on s.id = v.service_id
           join service_resource_shape srs
             on srs.service_style = s.style
            and srs.service_treatment_key = s.treatment_key
            and srs.shape = a.shape
          where v.id = a.service_variant_id
       ), 0)
 where a.turnaround_minutes is null;

update appointment
   set net_fils = round(gross_price_fils * 20 / 21.0),
       vat_fils = gross_price_fils - round(gross_price_fils * 20 / 21.0)
 where net_fils is null;

alter table appointment
  alter column turnaround_minutes       set not null,
  alter column therapist_buffer_minutes set not null,
  alter column net_fils                 set not null,
  alter column vat_fils                 set not null;

alter table appointment
  -- Bounded exactly as the shape schema and 0017 bound their sources, so a snapshot cannot hold a
  -- figure the catalogue itself would refuse.
  add constraint appointment_room_places_bounded
    check (room_places between 1 and 4),
  add constraint appointment_turnaround_bounded
    check (turnaround_minutes between 0 and 240),
  add constraint appointment_therapist_buffer_bounded
    check (therapist_buffer_minutes between 0 and 60),
  add constraint appointment_vat_rate_bounded
    check (vat_rate_bp between 0 and 10000),
  -- The identity that makes the split reconcilable. VAT is the remainder, never independently
  -- rounded, so this is exact for every input rather than for almost every input.
  add constraint appointment_price_split_exact
    check (net_fils + vat_fils = gross_price_fils),
  -- An empty string is not a promotion id; it is a caller that meant null and said something else.
  add constraint appointment_promotion_id_nonempty
    check (promotion_id is null or btrim(promotion_id) <> '');

comment on column appointment.delivery_id is
  'The rows of ONE delivery share this. Two therapists over one client (Four Hands) is one delivery, '
  'two rows, one id - and one place in the room. Defaults to a fresh id, so a writer that knows '
  'nothing about deliveries produces one delivery per row, which is the stricter count.';
comment on column appointment.room_places is
  'Clients this delivery puts in the room, from service_resource_shape.min_room_capacity. What '
  'rooms.capacity is measured in (0012). Counting appointment ROWS here instead is what made Four '
  'Hands unbookable in every standard room the salon owns.';
comment on column appointment.turnaround_minutes is
  'Minutes the ROOM stays held after the treatment, snapshotted. Re-reading service.turnaround_minutes '
  'later would move the occupancy of every appointment already taken when the owner changes it, and '
  'the first sign of that is a double booking (solve.ts, ScheduledAppointment).';
comment on column appointment.therapist_buffer_minutes is
  'Minutes the THERAPIST is held either side, snapshotted. A different resource from the turnaround '
  'and a different duration; no derivation between them (docs/06 B1).';
comment on column appointment.net_fils is
  'The net of the snapshotted gross, VAT derived as the remainder so net + vat = gross exactly '
  '(ADR 0007). Stored rather than re-derived, so a rate change cannot move a figure already filed.';
comment on column appointment.price_list_id is
  'The effective-dated override that produced the gross, or NULL meaning considered and did not apply '
  '- the distinction ResolvedPrice makes. This and promotion_id are how a disputed figure is settled.';
comment on column appointment.promotion_id is
  'The promotion that discounted the gross. No `promotion` table exists yet (B-CAT-04 NOTE), so this '
  'references nothing; the unit that introduces promotions adds the foreign key.';

-- One index for the grouping the capacity function now reads. Without it every commit's peak query
-- would seq-scan the room's rows to group them.
create index appointment_delivery_idx on appointment (delivery_id);

-- ------------------------------------------------------------------------------------------------
-- The peak, re-measured in client places
-- ------------------------------------------------------------------------------------------------
--
-- Same signature, same output column names, same measurement. `concurrent` is now concurrent CLIENT
-- PLACES rather than concurrent rows, which is what `rooms.capacity` holds and what the name meant.
--
-- The instants are unchanged and still exhaustive: for '[)' intervals the greatest number
-- simultaneously open is attained at one of their lower bounds, so measuring at the window's own start
-- and at every appointment start inside it examines every candidate peak.
create or replace function room_peak_concurrency(p_room_id uuid, p_window tstzrange)
returns table (concurrent integer, at timestamptz)
language sql
stable
as $$
  with instant as (
    select lower(p_window) as at where lower(p_window) is not null
    union
    select lower(a.period)
      from appointment a
     where a.room_id = p_room_id
       and a.holds_resources
       and (p_window is null or lower(a.period) <@ p_window)
  ),
  measured as (
    select i.at,
           -- Places summed over DISTINCT deliveries. `max(room_places)` inside the group is the one
           -- figure the rows of a delivery agree on (appointment_delivery_is_coherent); max rather
           -- than min so a delivery that somehow disagreed is counted at its larger footprint.
           -- `sum` over no rows is NULL, which is why the coalesce is here rather than decorative.
           coalesce((
             select sum(d.places)::integer
               from (select b.delivery_id, max(b.room_places) as places
                       from appointment b
                      where b.room_id = p_room_id
                        and b.holds_resources
                        and b.period @> i.at
                      group by b.delivery_id) d
           ), 0) as concurrent
      from instant i
  )
  -- An aggregate with no GROUP BY returns one row over an empty input, which is what makes the
  -- zero-appointment case a 0 rather than an absent row.
  select coalesce(max(m.concurrent), 0),
         (select m2.at from measured m2 order by m2.concurrent desc, m2.at asc limit 1)
    from measured m;
$$;

comment on function room_peak_concurrency(uuid, tstzrange) is
  'Greatest number of CLIENT PLACES held in one room at any single instant of the window, with the '
  'instant it happens at. Places are summed over DISTINCT deliveries, because rooms.capacity counts '
  'clients (0012) and one delivery is one client party however many therapists work it. Exactly one '
  'row, zero for an empty room. Counts OVERLAP, never a total: a capacity-2 room with two '
  'appointments at different times of one evening peaks at 1, not 2.';

-- Re-issued for its message alone: it said "overlapping appointments", which is the unit that was
-- wrong. A trigger whose message names the wrong unit is how the next reader concludes the inventory
-- is too small and invents a room to fix it.
create or replace function assert_room_capacity() returns trigger
language plpgsql
as $$
declare
  v_capacity integer;
  v_peak     integer;
  v_at       timestamptz;
  v_code     text;
begin
  -- A row that holds nothing cannot push a room over capacity, and short-circuiting here is what
  -- makes cancel-then-rebook inside one transaction cheap rather than merely correct.
  if not new.holds_resources then
    return null;
  end if;

  select r.capacity, r.code into v_capacity, v_code from rooms r where r.id = new.room_id;
  -- Unreachable through the foreign key, and checked anyway: a null capacity would make the
  -- comparison below null, which is neither true nor false and would let everything through.
  if v_capacity is null then
    raise exception 'room "%" has no capacity row', new.room_id
      using errcode = 'foreign_key_violation';
  end if;

  select p.concurrent, p.at into v_peak, v_at
    from room_peak_concurrency(new.room_id, new.period) p;

  -- No coalesce: room_peak_concurrency always returns exactly one row, and 0 for an empty room.
  if v_peak > v_capacity then
    raise exception
      'room_over_capacity: room "%" would hold % client places at % but its capacity is %',
      v_code, v_peak, v_at, v_capacity
      using errcode = 'ZB001';
  end if;

  return null;
end $$;

comment on function assert_room_capacity() is
  'Raises ZB001 at COMMIT when a room would hold more CLIENT PLACES than its capacity at any instant '
  'of the written row''s own period. Places, not rows: two therapists over one client is one place '
  '(0038). Counts inside that period only, so a row written into one evening cannot change another '
  'evening''s peak.';

-- Re-issued for its message too. It reads the same function, so it was already counting places the
-- moment the function changed; only the word "appointments" was left saying otherwise.
create or replace function assert_room_capacity_covers_commitments() returns trigger
language plpgsql
as $$
declare
  v_peak integer;
  v_at   timestamptz;
begin
  select p.concurrent, p.at
    into v_peak, v_at
    from room_peak_concurrency(new.id, tstzrange(now(), null, '[)')) p;

  if v_peak > new.capacity then
    raise exception
      'capacity_below_committed: room "%" already holds % client places at %; capacity cannot be '
      'reduced from % to %',
      new.code, v_peak, v_at, old.capacity, new.capacity
      using errcode = 'ZB002';
  end if;

  return new;
end $$;

comment on function assert_room_capacity_covers_commitments() is
  'Raises ZB002. Counts the CLIENT PLACES of OVERLAPPING unfinished deliveries, not the day''s total, '
  'so a capacity-2 room holding two appointments at different times of one evening is still reducible '
  'to 1.';

-- ------------------------------------------------------------------------------------------------
-- A delivery is one room, one period, one footprint
-- ------------------------------------------------------------------------------------------------

create function assert_delivery_is_coherent() returns trigger
language plpgsql
as $$
declare
  v_rows     integer;
  v_distinct integer;
begin
  -- Only the rows that still hold their resources. A half-cancelled Four Hands is one row and one
  -- delivery, which is coherent; judging cancelled rows would refuse the cancellation.
  select count(*),
         count(distinct (room_id, period, room_places, trading_date, shape))
    into v_rows, v_distinct
    from appointment
   where delivery_id = new.delivery_id
     and holds_resources;

  if v_rows > 0 and v_distinct > 1 then
    raise exception
      'delivery_incoherent: delivery "%" has % resource-holding row(s) describing % different '
      'deliveries. The rows of one delivery share a room, a period, a trading date, a shape and a '
      'places figure; two therapists in two rooms is not one delivery.',
      new.delivery_id, v_rows, v_distinct
      using errcode = 'ZB004';
  end if;

  return null;
end $$;

comment on function assert_delivery_is_coherent() is
  'Raises ZB004 at COMMIT. What makes max(room_places) per delivery a fact rather than a guess, and '
  'what stops a reschedule that moves one row of a Four Hands splitting it into two deliveries - two '
  'places, refused at the NEXT booking rather than at the move.';

create constraint trigger appointment_delivery_is_coherent
  after insert or update on appointment
  deferrable initially deferred
  for each row execute function assert_delivery_is_coherent();

commit;

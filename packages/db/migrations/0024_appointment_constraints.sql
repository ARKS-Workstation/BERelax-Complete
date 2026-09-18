-- 0024 — booking, appointment, and the two concurrency constraints that make double-booking
--        impossible rather than unlikely.
--
-- ADR 0015 and docs/01 decision 9: the failure is a race, so the fix has to be a constraint. Two
-- receptionists, two phones, the same 8pm slot; an application-level read-then-write finds the slot
-- free twice. Only the database serialises, so only the database can refuse.
--
-- There are TWO different constraints hiding inside "no double booking", and they need two
-- mechanisms. Five decisions carry this migration, and four of them are the non-obvious choice.
--
-- ## A therapist is an exclusion constraint; a room is not
--
-- "A therapist cannot be in two places" is exact, and PostgreSQL expresses it directly:
--
--   exclude using gist (therapist_id with =, period with &&)
--
-- `btree_gist` (0001, and REQUIRED_EXTENSIONS in packages/db/src/connection.ts) is what allows the
-- uuid equality and the tstzrange overlap in one index; without it the constraint cannot be declared
-- at all, which is why the extension is installed rather than merely available.
--
-- "A room holds as many people as it holds" is NOT expressible that way. An exclusion constraint
-- says "no two rows may overlap"; it has no form that says "at most N may overlap". The capacity-2
-- couples room legitimately holds two overlapping appointments and must refuse a third, so that half
-- is a constraint trigger counting against `rooms.capacity`.
--
-- ## The exclusion constraint carries its own WHERE predicate
--
-- A cancelled appointment must stop holding its therapist, or cancelling and re-booking the same
-- period — the single most common front-desk correction — would be refused by the constraint that
-- exists to protect it.
--
-- PostgreSQL 16 accepts a `WHERE` predicate on an `EXCLUDE` **table constraint**, both inline in
-- `CREATE TABLE` and through `ALTER TABLE ... ADD CONSTRAINT`; this was verified against the running
-- server before the constraint was written this way, because the answer decides the shape. It is
-- `UNIQUE` that has no partial form as a constraint and has to be spelled as a partial unique INDEX
-- instead. So the constraint below is a real named constraint whose backing index is partial, rather
-- than a bare index, and that matters for three reasons: a violation arrives as SQLSTATE 23P01
-- naming the constraint, `pg_constraint` can be asserted against, and an index alone cannot enforce
-- an exclusion at all — there is no such thing as an `EXCLUDE` index without a constraint.
--
-- ## "Still holds its room and therapist" is ONE definition, and it is a generated column
--
-- The predicate appears in three places: the exclusion constraint, the partial gist index the
-- capacity trigger reads through, and the capacity trigger itself. Written out three times it is a
-- rule that will eventually disagree with itself — the day a sixth status is added, two of the three
-- are updated. So it is `appointment.holds_resources`, a STORED GENERATED column, which is the one
-- form the database itself keeps in step and which an `EXCLUDE ... WHERE` can still reference.
--
-- ## The capacity trigger is DEFERRED, and that is load-bearing
--
-- See docs/adr/0024-deferred-room-capacity-trigger.md. A counting constraint cannot be transiently
-- violated by INSERTs alone — counts only rise — so the case that makes DEFERRED necessary is the
-- UPDATE: swapping two bookings between two slots in one room moves them through a momentarily
-- over-capacity state and lands valid. An IMMEDIATE variant of the identical trigger refuses the
-- second row of the legitimate couples booking mid-swap. That variant is kept as a
-- fixture in packages/db/src/schema/booking-constraints.itest.ts; it is the whole argument for
-- DEFERRED, and without it this declaration is a preference rather than a decision.
--
-- ## Capacity may be reduced, but not below what is already promised
--
-- `rooms.capacity` is data (0012), so an admin can lower it. Lowering it below the appointments the
-- room has already committed to would not be refused by the appointment trigger, which only fires on
-- appointment writes: the invariant would be broken from the other side and discovered by a customer
-- standing in a room with no plinth. So `rooms` carries the mirror-image guard.
--
-- It counts OVERLAPPING appointments, not the day's total. A capacity-2 room holding two
-- appointments at different times of the same evening must still be reducible to 1, and a check on
-- the day's total would refuse that — which is an admin unable to correct data, i.e. the guard
-- becoming the problem it exists to prevent.

begin;

-- ---------------------------------------------------------------------------------------------
-- Status vocabulary
-- ---------------------------------------------------------------------------------------------
-- The nine states B-LIFE-01 declares. The enum is created here because the tables are, but WHICH
-- transitions between them are legal is B-LIFE-01's transition table and deliberately not encoded
-- here: a state machine split between a migration and a data structure is a state machine with two
-- answers.
--
-- CANCELLED_BY_CUSTOMER and CANCELLED_BY_SALON are separate labels, not one 'cancelled'. They carry
-- different cancellation-policy and reporting consequences, and collapsing them means the
-- distinction has to be recovered later from an audit row — which is to say it cannot be.
create type appointment_status as enum (
  'requested',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'no_show',
  'cancelled_by_customer',
  'cancelled_by_salon',
  'rescheduled'
);
comment on type appointment_status is
  'The nine states B-LIFE-01 declares. Two distinct cancellations on purpose: the policy and the '
  'reporting treatment differ, and one shared label loses which happened.';

-- ---------------------------------------------------------------------------------------------
-- booking — the commercial container
-- ---------------------------------------------------------------------------------------------
-- One booking, n appointments. That shape is what lets Four Hands and Couple Massage be resource
-- SHAPES of existing services (0017) rather than extra menu items: two therapists over one or two
-- clients is two appointment rows under one commercial record, and the capacity trigger below counts
-- them correctly without knowing anything about shapes.
--
-- There is deliberately NO `booking.status`. A booking's state is a projection of its appointments,
-- and a second status column would make "is this cancelled?" a question with two answers that drift
-- apart the first time a multi-appointment booking is half-cancelled. B-LIFE-01 owns the lifecycle
-- and B-LIFE-03 the partial-cancellation rule; both read the appointments.
create table booking (
  id          uuid        primary key default uuid_generate_v7(),
  -- The customer this booking belongs to. B-LIFE-02 built `customer` (0019) and its NOTE hands the
  -- attachment to this unit; `ensureCustomer(created_via => 'guest_booking')` is what produces the
  -- row, so a guest booking has a customer with no credential and no account (ADR 0014).
  --
  -- ON DELETE RESTRICT, not CASCADE: a booking is a commercial record and, once invoiced, a
  -- statutory one. Deleting a customer must fail loudly rather than quietly erase the takings.
  customer_id uuid        not null references customer (id) on update cascade on delete restrict,
  -- How it came in. Reporting cuts on this and so does the messaging consent path: a walk-in has
  -- given no online consent.
  source      text        not null default 'front_desk'
                check (source in ('online', 'front_desk', 'phone', 'walk_in')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table booking is
  'The commercial container: one booking, n appointments (0017 header). Carries no status column - '
  'a booking''s state is a projection of its appointments, and two status columns is two answers.';
comment on column booking.customer_id is
  'Attached here per the NOTE on B-LIFE-02: the customer half existed from 0019, the booking half '
  'is this unit. RESTRICT because a booking is a financial record, not a detail of a contact.';

create trigger booking_updated_at before update on booking
  for each row execute function set_updated_at();

create index booking_customer_idx on booking (customer_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- appointment — one delivery, one therapist, one room, one period
-- ---------------------------------------------------------------------------------------------
create table appointment (
  id                 uuid        primary key default uuid_generate_v7(),
  booking_id         uuid        not null references booking (id) on delete cascade,
  -- The trading date, materialised (0011), not derived. Trading runs 11:00-02:00, so a 01:30
  -- appointment belongs to the PREVIOUS trading date and no truncation of `lower(period)` gets that
  -- right. The foreign key is the point: a booking on a date the premises does not trade has no row
  -- to join to, and every cash-up, rota and commission figure cuts on this column.
  --
  -- It lives on the appointment rather than the booking because a reschedule moves ONE appointment,
  -- and B-LIFE-03 re-resolves the trading date per appointment across midnight.
  trading_date       date        not null
                       references business_day (trading_date) on update cascade on delete restrict,
  -- The (service x duration) actually sold. RESTRICT: a variant a booking points at is the price
  -- that was quoted, so it cannot be deleted out from under the record.
  service_variant_id uuid        not null references service_variant (id) on delete restrict,
  -- The resource footprint delivered (0017). Descriptive here: whether this (service, shape, room)
  -- triple is ELIGIBLE is the solver's question (B-AVAIL-03 assign-shape) and the booking
  -- transaction's to enforce (B-AVAIL-06), because the composite key service_resource_shape is
  -- keyed on is the service natural key, which this table reaches only through service_variant.
  shape              service_shape not null,
  -- No foreign key, because there is no `employee` table yet: B-AVAIL-04 builds it and depends on
  -- this unit, so the reference would be to a parent that does not exist. See the NOTE on
  -- B-AVAIL-01 in build/manifest.yaml. The exclusion constraint below does not need one - it
  -- compares this column to itself.
  therapist_id       uuid        not null,
  -- RESTRICT rather than CASCADE: 0012 decommissions a room with `is_bookable = false` precisely so
  -- that historical appointments keep the room they happened in.
  room_id            uuid        not null references rooms (id) on delete restrict,
  -- The treatment itself, '[)' bounds. NOT the room occupancy: turnaround extends the room's busy
  -- interval and the therapist buffer extends the therapist's, and the solver (B-AVAIL-02) keeps
  -- those three apart. Storing the padded interval here would make the padding unrecoverable and
  -- re-padding it a second time the first bug.
  period             tstzrange   not null,
  status             appointment_status not null default 'requested',
  -- The ONE definition of "this appointment still holds its therapist and its room". Generated and
  -- stored, so the exclusion constraint, the partial gist index and the capacity trigger below all
  -- read the same column instead of restating the same status list three times.
  --
  -- 'completed' DOES hold: a finished appointment still occupied the room and the therapist, and a
  -- second booking over the same past period is a double-booking that happened, not a free slot.
  -- 'rescheduled' does not: B-LIFE-03 supersedes such a row, and a superseded row holding its old
  -- period would block the very slot the reschedule released.
  holds_resources    boolean     not null generated always as (
                       status <> all (array[
                         'no_show',
                         'cancelled_by_customer',
                         'cancelled_by_salon',
                         'rescheduled'
                       ]::appointment_status[])
                     ) stored,
  -- The price as quoted, snapshotted. VAT-inclusive gross in integer fils (ADR 0007). Snapshotted
  -- rather than read through service_variant at report time, because a price change must not
  -- retro-price a booking already taken - and must not move a figure already filed.
  gross_price_fils   fils        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- The acceptance criterion, literally: upper strictly after lower. On an EMPTY range both bounds
  -- are null, so this evaluates to null and PASSES - which is why the bounded check below is a
  -- separate constraint rather than a nicety.
  constraint appointment_period_upper_after_lower
    check (upper(period) > lower(period)),
  -- An unbounded appointment holds its therapist and room for ever, and the way that is discovered
  -- is that they never appear in availability again.
  constraint appointment_period_bounded
    check (lower(period) is not null and upper(period) is not null),
  -- Half-open, always, matching resource_block (0012). This is what makes two treatments abutting
  -- exactly at 14:00 both legal; a '[]' range would refuse the second and silently shorten every
  -- day. Mixing bound styles in one schema guarantees two of them are compared one day.
  constraint appointment_period_half_open
    check (lower_inc(period) and not upper_inc(period)),
  -- Zero is not a free treatment, it is a missing price: it passes a non-negative check, invoices as
  -- 0.00 and reconciles to nothing.
  constraint appointment_price_positive check (gross_price_fils > 0),
  -- A therapist cannot be in two places. Exact, so it is a constraint rather than a count.
  --
  -- The WHERE predicate is what makes cancel-and-re-book work: without it the cancelled row would
  -- keep holding the period, and the correction the front desk makes most often would be refused by
  -- the constraint protecting it. Verified above to be legal on an EXCLUDE table constraint in
  -- PostgreSQL 16.
  constraint appointment_therapist_no_overlap
    exclude using gist (therapist_id with =, period with &&) where (holds_resources)
);

comment on table appointment is
  'One delivery: one therapist, one room, one period. Double-booking is refused by the database '
  '(ADR 0015): an exclusion constraint for the therapist, a deferred constraint trigger for room '
  'capacity. The application still checks availability, for the interface; this is what makes it true.';
comment on column appointment.period is
  'The treatment, ''[)'' bounds. Room turnaround and therapist buffer are added by the solver and '
  'are deliberately NOT baked in here - padding a stored padded interval is the first bug.';
comment on column appointment.holds_resources is
  'Generated: true while the appointment still holds its therapist and room. The single definition '
  'read by the exclusion constraint, the partial gist index and the capacity trigger.';
comment on column appointment.therapist_id is
  'Deliberately not a foreign key: B-AVAIL-04 creates `employee` and depends on this unit, so there '
  'is no parent to reference yet. See the NOTE on B-AVAIL-01 in build/manifest.yaml.';
comment on constraint appointment_therapist_no_overlap on appointment is
  'SQLSTATE 23P01 on violation. Partial: a cancelled, no-show or superseded appointment releases the '
  'therapist, so the same period can be re-booked.';

create trigger appointment_updated_at before update on appointment
  for each row execute function set_updated_at();

create index appointment_booking_idx on appointment (booking_id);
create index appointment_trading_date_idx on appointment (trading_date);

-- The index the capacity trigger's overlap lookups run through. Partial on the same generated
-- column, so a cancelled appointment is absent from the index rather than filtered out of it.
create index appointment_room_period_idx on appointment using gist (room_id, period)
  where holds_resources;

-- ---------------------------------------------------------------------------------------------
-- Peak room concurrency — one definition, two callers
-- ---------------------------------------------------------------------------------------------
-- "How many appointments does this room hold at once, at its busiest" is asked by the appointment
-- trigger and by the rooms-capacity guard. Two queries would be two answers, and the pair that
-- disagreed would let a capacity reduction commit an over-booked room.
--
-- The naive form -- count the appointments overlapping the new one -- is WRONG, and wrong in the
-- direction that refuses legitimate bookings. In a capacity-2 room holding 10:00-12:00 and
-- 18:00-20:00, a new 09:00-21:00 appointment overlaps both, so the count is 3; but at no instant are
-- three people in the room. The day's total is wrong the same way, and worse.
--
-- So this computes a true PEAK. For half-open intervals the maximum number of simultaneously open
-- intervals is always attained AT one of their lower bounds, so evaluating the count at each lower
-- bound inside the window is exhaustive rather than a sample. `p_window` narrows the candidate
-- instants: an appointment written into one evening cannot change the peak of another, and the
-- window's own lower bound is included so an appointment already in progress at that instant counts.
--
-- It always returns EXACTLY ONE ROW, zero for an empty room. A set-returning function that returns
-- nothing would make every caller write `coalesce(...)`, and the one caller that forgot would compare
-- a capacity against NULL — which is neither true nor false, so the guard would pass silently.
create function room_peak_concurrency(p_room_id uuid, p_window tstzrange)
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
           (select count(*)::integer
              from appointment b
             where b.room_id = p_room_id
               and b.holds_resources
               and b.period @> i.at) as concurrent
      from instant i
  )
  -- An aggregate with no GROUP BY returns one row even over an empty input, which is what makes the
  -- zero-appointment case a 0 rather than an absent row.
  select coalesce(max(m.concurrent), 0),
         (select m2.at from measured m2 order by m2.concurrent desc, m2.at asc limit 1)
    from measured m;
$$;

comment on function room_peak_concurrency(uuid, tstzrange) is
  'Greatest number of resource-holding appointments in one room at any single instant of the window, '
  'with the instant it happens at. Exactly one row, zero for an empty room. Counts OVERLAP, never a '
  'total: a capacity-2 room with two appointments at different times of one evening peaks at 1, not 2.';

-- ---------------------------------------------------------------------------------------------
-- The room-capacity invariant, DEFERRED to COMMIT
-- ---------------------------------------------------------------------------------------------
-- See docs/adr/0024-deferred-room-capacity-trigger.md for the argument. In short: a legitimate
-- rearrangement inside one transaction -- a couples booking and a single appointment swapping slots
-- in the one couples room -- passes through a state where three appointments overlap at 20:00, and
-- ends valid. An IMMEDIATE trigger refuses the SECOND row of the couples booking mid-swap; the
-- identical trigger, deferred, accepts the transaction and refuses only a final state that is
-- genuinely over capacity.
--
-- `deferrable initially deferred` moves the check to COMMIT.
-- packages/db/src/schema/booking-constraints.itest.ts asserts that shape the way M-TILL-02's
-- journal.itest.ts does for the balance invariant: rows inserted one at a time, each succeeding,
-- read back inside the transaction, and the failure arriving from COMMIT. A test that failed on the
-- third INSERT would have proved the opposite of what is wanted.
create function assert_room_capacity() returns trigger
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
      'room_over_capacity: room "%" would hold % overlapping appointments at % but its capacity is %',
      v_code, v_peak, v_at, v_capacity
      using errcode = 'ZB001';
  end if;

  return null;
end $$;

comment on function assert_room_capacity() is
  'Raises ZB001 at COMMIT. Counts the PEAK overlap inside the written row''s own period only: a row '
  'written into one evening cannot change another evening''s peak.';

-- Insert and update, not delete: a delete can only lower a count. Update matters twice over - a
-- reschedule moves a period, and a cancellation reversal flips holds_resources back to true.
create constraint trigger appointment_room_capacity
  after insert or update on appointment
  deferrable initially deferred
  for each row execute function assert_room_capacity();

-- ---------------------------------------------------------------------------------------------
-- The mirror image: capacity may not be reduced below what the room already owes
-- ---------------------------------------------------------------------------------------------
-- The appointment trigger only fires on appointment writes, so `update rooms set capacity = 1` on a
-- room already holding a couples booking would break the invariant from the side nothing was
-- watching. The failure would surface as a customer standing in a room with one plinth.
--
-- Scoped to appointments that have NOT yet ended. A past appointment happened; no capacity number
-- changes that, and refusing a reduction because of last year's bookings would mean a room whose
-- capacity can never be corrected — the guard becoming the problem it exists to prevent.
--
-- IMMEDIATE, and rightly so: this is a single-row administrative change with nothing transient about
-- it. The deferral argument for the appointment trigger does not apply here, and a deferred version
-- would report the failure from COMMIT of whatever else the admin screen was doing.
create function assert_room_capacity_covers_commitments() returns trigger
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
      'capacity_below_committed: room "%" already holds % overlapping appointments at %; capacity '
      'cannot be reduced from % to %',
      new.code, v_peak, v_at, old.capacity, new.capacity
      using errcode = 'ZB002';
  end if;

  return new;
end $$;

comment on function assert_room_capacity_covers_commitments() is
  'Raises ZB002. Counts OVERLAPPING unfinished appointments, not the day''s total, so a capacity-2 '
  'room holding two appointments at different times of one evening is still reducible to 1.';

create trigger rooms_capacity_covers_commitments
  before update of capacity on rooms
  for each row when (new.capacity < old.capacity)
  execute function assert_room_capacity_covers_commitments();

-- ---------------------------------------------------------------------------------------------
-- appointment_status_history — the transition chain, append-only
-- ---------------------------------------------------------------------------------------------
-- Written by a trigger rather than by the application, so a transition cannot be made without one.
-- A history table the caller is trusted to write is a history table with gaps in it exactly where
-- somebody was in a hurry, and the gaps are invisible: the chain still reads as complete.
--
-- `appointment_id` is a plain uuid with NO foreign key, the same choice audit_event (0005) and
-- google_connection_events (0016) make and for the same reason: an append-only log with a foreign
-- key to a mutable table is a contradiction, because the parent's delete either fails or rewrites
-- history, and history a delete can rewrite is not history.
--
-- It carries no actor and no reason. Attribution belongs to audit_event, written in the same
-- transaction by the repository layer (F06), and duplicating it here would give one fact two
-- sources. B-LIFE-01's acceptance asks for actor, role and reason on the transition; that is a
-- column set this unit deliberately leaves to it, because the transition API that knows the actor
-- is the thing it builds. See the NOTE on B-AVAIL-01 in build/manifest.yaml.
create table appointment_status_history (
  id             bigint             generated always as identity primary key,
  appointment_id uuid               not null,
  -- Null on the row recording the appointment's creation: there was no previous state.
  from_status    appointment_status,
  to_status      appointment_status not null,
  occurred_at    timestamptz        not null default now(),
  -- A "transition" from a state to itself is not a transition; it is a row that makes the chain
  -- read as activity where nothing happened.
  constraint appointment_status_history_is_a_change
    check (from_status is null or from_status <> to_status)
);

comment on table appointment_status_history is
  'Every appointment status transition, in order. Append-only: UPDATE and DELETE raise, for every '
  'role including the owner. Written by a trigger, so a transition without a history row is not '
  'reachable. Attribution lives in audit_event - one fact, one source.';
comment on column appointment_status_history.appointment_id is
  'Plain uuid, deliberately not a foreign key. An append-only log cannot hold a reference to a '
  'mutable parent: the delete either fails or rewrites history (see audit_event, 0005).';

create index appointment_status_history_appointment_idx
  on appointment_status_history (appointment_id, occurred_at, id);

create function record_appointment_status() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    insert into appointment_status_history (appointment_id, from_status, to_status)
    values (new.id, null, new.status);
  elsif old.status <> new.status then
    insert into appointment_status_history (appointment_id, from_status, to_status)
    values (new.id, old.status, new.status);
  end if;
  return null;
end $$;

comment on function record_appointment_status() is
  'Appends the transition chain. AFTER, so a row that fails a constraint leaves no history; and it '
  'judges nothing - which transitions are legal is B-LIFE-01''s transition table, not a trigger.';

create trigger appointment_status_recorded
  after insert or update of status on appointment
  for each row execute function record_appointment_status();

-- Append-only, and it RAISES rather than silently doing nothing.
--
-- `create rule ... do instead nothing`, which 0005 and 0010 use, reports SUCCESS to the caller. Code
-- that UPDATEs a transition row is code that believes it is correcting history, and it must be told
-- it cannot rather than left believing it did. 0016 and 0018 made the same choice.
create function refuse_appointment_history_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. A wrong status is corrected by a further transition, never by '
    'editing the record of the last one.',
    tg_table_name, tg_op
    using errcode = 'ZB003';
end $$;

comment on function refuse_appointment_history_change() is
  'Raises ZB003. Fires for EVERY role including the owner: privileges cover the application role, '
  'and a migration or a psql session does not connect as the application role.';

create trigger appointment_status_history_no_update before update on appointment_status_history
  for each row execute function refuse_appointment_history_change();
create trigger appointment_status_history_no_delete before delete on appointment_status_history
  for each row execute function refuse_appointment_history_change();

-- ---------------------------------------------------------------------------------------------
-- booking_idempotency — one request, one booking
-- ---------------------------------------------------------------------------------------------
-- A double-tapped Book button, a retried request after a timeout, a customer who refreshes the
-- confirmation page: all three arrive as the same request twice. Without this the second one takes
-- a second slot, and the failure is discovered by two therapists rostered for one customer.
--
-- The row is written in the SAME transaction as the booking, which is what makes it work: if the
-- booking rolls back the claim rolls back with it, so a genuine retry gets a fresh attempt rather
-- than a permanent refusal. The primary key is where two concurrent retries serialise.
create table booking_idempotency (
  idempotency_key     text        primary key
                        constraint booking_idempotency_key_nonempty check (btrim(idempotency_key) <> ''),
  -- A hash of the request that claimed the key. Replaying a key with a DIFFERENT body is a bug in
  -- the caller, not a retry, and must be told apart from one: without this the second request gets
  -- back a booking for a different slot than the one it asked for, and reads it as success.
  request_fingerprint text        not null
                        constraint booking_idempotency_fingerprint_nonempty
                        check (btrim(request_fingerprint) <> ''),
  booking_id          uuid        not null unique references booking (id) on delete cascade,
  created_at          timestamptz not null default now()
);

comment on table booking_idempotency is
  'Idempotency key -> booking, written in the booking''s own transaction so a rolled-back booking '
  'releases its key. UNIQUE on booking_id too: one booking is created by exactly one request.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 sets default privileges granting the application role select, insert, update and delete on
-- every table created in `public` afterwards. An append-only table that does not revoke them is
-- append-only by comment only. Stated explicitly first rather than relied upon, because a managed
-- database restored from a dump does not necessarily carry the same defaults.
grant select, insert on appointment_status_history to berelax_app;
revoke update, delete on appointment_status_history from berelax_app;

-- TRUNCATE is the statement that slips past a row-level trigger, so it matters more here than the
-- rest. 0009 never granted it, which is not the same fact as "we checked".
revoke truncate on appointment_status_history from berelax_app;

-- A booking is cancelled, never deleted. Cancellation is a status transition that leaves the record
-- and its history in place; a DELETE erases the takings and the audit trail's subject at once. A
-- later unit that genuinely needs a delete path adds it as a migration, which is the right weight
-- for that decision.
revoke delete on booking, appointment from berelax_app;

-- Reporting reads and never writes. 0009 grants it SELECT on everything in public and never granted
-- anything else, so there is nothing to revoke - said here because "never granted" and "checked"
-- are different facts.

commit;

-- 0045 — the waitlist, and the one row that makes a cached availability answer detectably stale.
--
-- B-AVAIL-07 is a READ path. It adds no slot table, no availability cache and no materialised view of
-- either: `no-precomputed-slot-table` in scripts/check-schema-conventions.mjs forbids all three and the
-- reason it gives is exactly right — a stored answer is stale from the next block, closure, shift change
-- or walk-in, and the way that is discovered is a customer standing at a locked door. Two tables arrive
-- here and neither is a stored answer.
--
-- ## 1. `availability_epoch` stores no availability
--
-- It stores ONE integer per trading date: how many times anything that could change that date's
-- availability has been written. No slot, no room, no therapist, no period — nothing a caller could
-- mistake for an answer, and nothing that can be served instead of computing one. What it makes possible
-- is the opposite of a cache of answers: a process holding a 30-second memo of a computed answer can ask
-- "has the schedule moved since I computed this" in one primary-key lookup, and throw the memo away when
-- it has. Without the row the only honest options are to recompute everything on every keystroke or to
-- serve a memo that cannot know it is wrong, and the second is what the convention rule exists to stop.
--
-- The four write types the manifest names are the four causes, and they are an ENUM rather than free text
-- so a test can assert WHICH write purged a tag. A `text` column would let a fifth writer invent a fifth
-- spelling and the four separate assertions would silently collapse into one.
--
--   * `appointment`     — a booking, a cancellation, a reschedule. Keyed on `trading_date`, which is the
--                         column the appointment already carries and a foreign key into `business_day`.
--   * `shift`           — the roster. Also keyed on `trading_date`, because `readEligibleTherapists`
--                         joins the roster on that column and a shift filed under another date covers no
--                         candidate of this one (0030).
--   * `resource_block`  — room unavailability that is not a booking. It has no trading date, only a
--                         period, so the dates it touches are computed from `business_day`.
--   * `approved_leave`  — and ONLY approved. A PENDING request must not purge anything, for the same
--                         reason `employee_approved_leave` exists: a pending request that removed a
--                         therapist from the roster presents as "no availability" with no reason
--                         attached, and is invisible until the therapist asks why they have no bookings.
--
-- The two period-keyed causes match the trading day's window PADDED by four hours each side, and the
-- padding is load-bearing rather than defensive. A candidate slot's THERAPIST interval is
-- `[start - buffer, end + buffer)` and its ROOM interval is `[start, end + turnaround)`; the buffer can
-- reach before the day opens, and the appointment-side read in `availability.ts` widens its window by the
-- same four hours for exactly that reason (240 minutes is `appointment_turnaround_bounded`'s ceiling and
-- 60 is `appointment_therapist_buffer_bounded`'s). The invalidation set must therefore be a SUPERSET of
-- the read set, never the other way round: bumping a date whose answer did not actually change costs one
-- recomputation, and failing to bump a date whose answer did change sells a slot that no longer exists.
--
-- There is deliberately NO foreign key from `availability_epoch.trading_date` to `business_day`. The row
-- is bookkeeping about a cache KEY, not a fact about a trading day, and an `on delete restrict` would let
-- this table refuse a calendar regeneration while an `on delete cascade` would silently resurrect every
-- stale memo for a date whose hours had just been rewritten. An orphaned epoch row is inert: nothing
-- reads it but the key it belongs to.
--
-- ## 2. `waitlist`, and the NULL that would have made a repeat join non-idempotent
--
-- `waitlist_one_row_per_window` is declared `UNIQUE NULLS NOT DISTINCT`, and that is the whole of the
-- idempotency claim. `therapist_id` is nullable because "any therapist" is the ordinary request, and
-- under PostgreSQL's default `NULLS DISTINCT` two joins for the same customer, variant, date and window
-- with no therapist named are two DIFFERENT keys — so `on conflict do nothing` inserts both, the second
-- join is not idempotent, and the table grows one row per page refresh. `NULLS NOT DISTINCT` (PostgreSQL
-- 15) is what makes "any therapist" one key. The constraint is asserted by NAME in the refusal, so a
-- caller branches on the rule rather than on a message.
--
-- The window is a `tstzrange` and not a pair of dates, for the reason `leave_request.period` is: a day of
-- leave stored as a date range starts at midnight, and midnight is the middle of a trading day here.
-- `trading_date` is carried BESIDE it and foreign-keyed into `business_day`, so a waitlist row cannot be
-- filed against a date the premises does not trade — the same claim `appointment.trading_date` and
-- `shift.trading_date` make, and the reason 01:30 belongs to the previous trading date is recoverable
-- from the row rather than re-derived from the instants.
--
-- ## What is deliberately NOT here
--
-- No status column and no `notified_at`. Both would be columns nothing writes: the unit that offers a
-- released slot to the next person waiting does not exist in build/manifest.yaml, and a status enum whose
-- every row reads `waiting` for ever is a column that claims a lifecycle the system does not have. The
-- consequence is stated rather than hidden: a customer cannot withdraw and re-join, because the UNIQUE
-- key is total rather than partial on an active flag. Withdrawal belongs to the unit that owns the
-- notification, and it arrives as a nullable `withdrawn_at` plus a partial unique index — a change to one
-- index, not a table rewrite.
--
-- No `position` column either. A queue position is derived from `created_at` by the reader that offers
-- the slot; stored, it is a second answer that goes wrong the first time a row is deleted.
begin;

-- ------------------------------------------------------------------------------------------------
-- The epoch: one integer per trading date, and the four writes that move it
-- ------------------------------------------------------------------------------------------------

create type availability_epoch_cause as enum (
  'appointment',
  'shift',
  'resource_block',
  'approved_leave'
);

comment on type availability_epoch_cause is
  'The four write types that can change a trading date''s availability. An enum and not text, so a '
  'test can assert WHICH write purged a cache tag: with free text a fifth writer invents a fifth '
  'spelling and four separate assertions collapse into one that proves only that something fired.';

create table availability_epoch (
  -- No foreign key into business_day, on purpose. See the header: this is bookkeeping about a cache
  -- key, and an FK would let it either refuse a calendar regeneration or resurrect stale memos.
  trading_date   date        primary key,
  -- Monotonic. A holder compares the integer it recorded against this one; equal means nothing that
  -- could change the answer has been written since. Never reset: a counter that goes backwards makes
  -- a stale memo look current exactly once, and that once sells a slot that no longer exists.
  epoch          bigint      not null default 1 check (epoch > 0),
  invalidated_at timestamptz not null default now(),
  last_cause     availability_epoch_cause not null
);

comment on table availability_epoch is
  'How many times anything that could change a trading date''s availability has been written. Holds no '
  'slot, no room, no therapist and no period - it is not a cache of answers and cannot be served '
  'instead of computing one (no-precomputed-slot-table). It is what lets a 30-second in-process memo '
  'of a COMPUTED answer discover, in one primary-key lookup, that the schedule has moved.';
comment on column availability_epoch.last_cause is
  'Which of the four write types moved it last. The four invalidation cases are asserted separately by '
  'this column; one test that writes all four and re-queries proves only that at least one purge works.';

-- The upsert, in one place. Four triggers call it, and four copies of an `on conflict` clause is four
-- chances for one of them to reset the counter instead of advancing it.
create function bump_availability_epoch(
  p_trading_date date,
  p_cause availability_epoch_cause
) returns void
language sql
as $$
  insert into availability_epoch (trading_date, epoch, invalidated_at, last_cause)
  values (p_trading_date, 1, now(), p_cause)
  on conflict (trading_date) do update
    set epoch          = availability_epoch.epoch + 1,
        invalidated_at = now(),
        last_cause     = excluded.last_cause;
$$;

comment on function bump_availability_epoch(date, availability_epoch_cause) is
  'Advances one trading date''s epoch. Runs inside the writer''s own transaction, so an UNCOMMITTED '
  'booking purges nothing - which is what stops a rolled-back attempt throwing away a memo that was '
  'still correct.';

-- The period-keyed half. `resource_block` and `leave_request` carry no trading date, so the dates they
-- touch are the ones whose trading WINDOW, padded by four hours each side, overlaps the written period.
--
-- Padded, and the direction matters. A candidate slot's therapist interval is
-- `[start - buffer, end + buffer)`, so a block or a leave boundary shortly BEFORE the day opens can
-- remove the day's first slot; availability.ts widens its own read window by the same four hours. The
-- invalidation set must be a SUPERSET of the read set: an extra bump costs one recomputation, a missing
-- one sells a slot that no longer exists.
create function bump_availability_epoch_for_period(
  p_period tstzrange,
  p_cause availability_epoch_cause
) returns void
language sql
as $$
  insert into availability_epoch (trading_date, epoch, invalidated_at, last_cause)
  select d.trading_date, 1, now(), p_cause
    from business_day d
   where tstzrange(d.opens_at - interval '4 hours', d.closes_at + interval '4 hours', '[)') && p_period
  on conflict (trading_date) do update
    set epoch          = availability_epoch.epoch + 1,
        invalidated_at = now(),
        last_cause     = excluded.last_cause;
$$;

comment on function bump_availability_epoch_for_period(tstzrange, availability_epoch_cause) is
  'Advances the epoch of every trading date whose window, padded by four hours each side, overlaps the '
  'period. The padding is the therapist buffer and the room turnaround reaching outside the window '
  '(0038 bounds them at 60 and 240 minutes); the invalidation set is deliberately a superset of the '
  'read set.';

-- ------------------------------------------------------------------------------------------------
-- The four triggers
-- ------------------------------------------------------------------------------------------------

-- AFTER, and STATEMENT-level would be wrong: the trading date is per row, and one statement can touch
-- several. FOR EACH ROW with a function that upserts one row is cheap - the epoch row is already in
-- cache after the first row of the statement.
create function appointment_bumps_availability_epoch() returns trigger
language plpgsql
as $$
begin
  -- Both sides on an UPDATE. A reschedule that moves an appointment to another trading date changes
  -- the answer for the date it LEFT as well as the one it arrived at, and bumping only `new` would
  -- leave the vacated slot unsellable until the memo expired.
  if tg_op <> 'INSERT' then
    perform bump_availability_epoch(old.trading_date, 'appointment');
  end if;
  if tg_op <> 'DELETE' then
    perform bump_availability_epoch(new.trading_date, 'appointment');
  end if;
  return null;
end $$;

comment on function appointment_bumps_availability_epoch() is
  'Purges the availability memo of every date an appointment write touches. Both OLD and NEW on an '
  'UPDATE: a reschedule across trading dates changes the answer for the date it left as well.';

create trigger appointment_invalidates_availability
  after insert or update or delete on appointment
  for each row execute function appointment_bumps_availability_epoch();

create function shift_bumps_availability_epoch() returns trigger
language plpgsql
as $$
begin
  -- `trading_date` and not the period. `readEligibleTherapists` joins the roster on that column, so a
  -- shift filed under another date covers no candidate of this one (0030) - the date it is FILED under
  -- is the date whose answer it changes.
  if tg_op <> 'INSERT' then
    perform bump_availability_epoch(old.trading_date, 'shift');
  end if;
  if tg_op <> 'DELETE' then
    perform bump_availability_epoch(new.trading_date, 'shift');
  end if;
  return null;
end $$;

create trigger shift_invalidates_availability
  after insert or update or delete on shift
  for each row execute function shift_bumps_availability_epoch();

create function resource_block_bumps_availability_epoch() returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' then
    perform bump_availability_epoch_for_period(old.period, 'resource_block');
  end if;
  if tg_op <> 'DELETE' then
    perform bump_availability_epoch_for_period(new.period, 'resource_block');
  end if;
  return null;
end $$;

create trigger resource_block_invalidates_availability
  after insert or update or delete on resource_block
  for each row execute function resource_block_bumps_availability_epoch();

-- The one with a predicate, and the predicate is the point. Availability reads
-- `employee_approved_leave`, never `leave_request`, so only an APPROVED row changes an answer. A
-- pending request that purged the memo would be harmless on its own; the reason it must not is that the
-- test asserting "approved leave purges" would then pass against a build in which the status was never
-- consulted at all.
--
-- Both sides of the transition count: approving a request removes presence, and un-approving one gives
-- it back. `old.status = 'approved' or new.status = 'approved'` is the whole condition, spelled in the
-- body rather than in a WHEN clause because DELETE has no NEW and INSERT no OLD.
create function leave_request_bumps_availability_epoch() returns trigger
language plpgsql
as $$
begin
  if tg_op <> 'INSERT' and old.status = 'approved' then
    perform bump_availability_epoch_for_period(old.period, 'approved_leave');
  end if;
  if tg_op <> 'DELETE' and new.status = 'approved' then
    perform bump_availability_epoch_for_period(new.period, 'approved_leave');
  end if;
  return null;
end $$;

comment on function leave_request_bumps_availability_epoch() is
  'Purges only for APPROVED leave, on both sides of a status change. A pending request must not move '
  'the epoch: availability reads employee_approved_leave (0030), and a trigger that ignored the status '
  'would make the "approved leave purges" assertion pass against a build that never consulted it.';

create trigger leave_request_invalidates_availability
  after insert or update or delete on leave_request
  for each row execute function leave_request_bumps_availability_epoch();

-- ------------------------------------------------------------------------------------------------
-- The index the availability read runs through
-- ------------------------------------------------------------------------------------------------
--
-- 0024 already has a GiST index on `appointment (room_id, period)`, and it is the right index for the
-- question the capacity trigger asks: "what else is in THIS room over this period". The availability
-- query asks a different one - "what occupies ANY room and ANY therapist during this trading day's
-- window" - and constrains no room, so the leading column of that index is unconstrained and the
-- planner falls back to reading the table.
--
-- Keyed on `period` and not on `trading_date`, deliberately. The btree on `trading_date` would serve a
-- single date more cheaply and it answers the wrong question twice over: the window is a span of
-- INSTANTS (0011 materialises `[opens_at, closes_at)`), the read has to be widened past both ends of it
-- by the turnaround and the buffer, and the alternatives half of a no-availability answer asks about
-- several trading dates at once. A denormalised date column cannot express any of the three; an overlap
-- against the period asks the data itself.
--
-- Partial on `holds_resources`, the same generated column the exclusion constraint and the capacity
-- trigger read, so a cancelled appointment is ABSENT from the index rather than filtered out of it.
create index appointment_period_idx on appointment using gist (period)
  where holds_resources;

comment on index appointment_period_idx is
  'The availability read path: every appointment overlapping a trading day''s padded window, across all '
  'rooms and all therapists. appointment_room_period_idx (0024) leads with room_id, which this query '
  'does not constrain. Partial on holds_resources, so a cancelled appointment is absent from the index.';

-- ------------------------------------------------------------------------------------------------
-- waitlist
-- ------------------------------------------------------------------------------------------------

create table waitlist (
  id                 uuid        primary key default uuid_generate_v7(),
  -- CASCADE: a waitlist entry is a request by a person, and it has no meaning without them. Nothing
  -- financial hangs off it, which is what makes this the one direction that is safe here.
  customer_id        uuid        not null references customer (id) on delete cascade,
  -- RESTRICT: the variant is what was asked for. Deleting it out from under a waiting customer would
  -- leave a row that cannot say what it is waiting for.
  service_variant_id uuid        not null references service_variant (id) on delete restrict,
  -- The trading date, materialised and foreign-keyed exactly as appointment.trading_date and
  -- shift.trading_date are. 01:30 belongs to the PREVIOUS trading date, and a row keyed on the
  -- calendar date of the instants would file the last two hours of every day under tomorrow.
  trading_date       date        not null
                       references business_day (trading_date) on update cascade on delete restrict,
  -- The window the customer will accept, '[)' bounds like every other period in this schema. Instants
  -- and not a pair of times, for leave_request's reason: a window "from midnight" is the middle of a
  -- trading day here.
  desired_period     tstzrange   not null,
  -- The footprint asked for. A Four Hands waiting list is not a solo waiting list, and without this
  -- column the reader that offers a released slot cannot tell whether the slot fits the request.
  shape              service_shape not null default 'solo',
  -- The therapist asked for, when one was. NULL means "any", which is the ordinary request - and the
  -- reason waitlist_one_row_per_window is NULLS NOT DISTINCT.
  therapist_id       uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- An empty window accepts nothing while reading as a request, so the row would sit in the table
  -- looking like a waiting customer and never match a released slot.
  constraint waitlist_period_nonempty check (not isempty(desired_period)),
  -- An unbounded window waits for ever; the way that is discovered is that the customer is offered a
  -- slot two years out.
  constraint waitlist_period_bounded
    check (lower(desired_period) is not null and upper(desired_period) is not null),
  -- Half-open, always, matching appointment, resource_block, shift and leave_request. Mixing bound
  -- styles in one schema guarantees two of them are compared one day.
  constraint waitlist_period_half_open
    check (lower_inc(desired_period) and not upper_inc(desired_period)),
  -- The idempotency of a repeat join, as a constraint rather than as a SELECT-then-INSERT.
  --
  -- NULLS NOT DISTINCT is the whole of it. `therapist_id` is null for "any therapist", and under the
  -- default NULLS DISTINCT two joins for the same customer, variant, date and window would be two
  -- different keys - so `on conflict do nothing` would insert both and the table would grow one row
  -- per page refresh. Checked by row count after two joins, and named in the refusal.
  constraint waitlist_one_row_per_window
    unique nulls not distinct (customer_id, service_variant_id, trading_date, desired_period,
                               therapist_id)
);

comment on table waitlist is
  'Who is waiting for a window that is full. No status column and no notified_at: the unit that offers '
  'a released slot does not exist yet, and a status enum whose every row reads "waiting" for ever '
  'claims a lifecycle the system does not have. Withdrawal arrives with that unit as a nullable '
  'withdrawn_at plus a partial unique index.';
comment on column waitlist.therapist_id is
  'The therapist asked for, or NULL for "any" - which is why the unique key is NULLS NOT DISTINCT. '
  'Deliberately not a foreign key into employee, for appointment.therapist_id''s reason (0038): '
  '`references employee (id)` would accept a receptionist while reading as though it had proved '
  'otherwise, and the claim worth making is the eligibility read model, which the query re-applies.';
comment on constraint waitlist_one_row_per_window on waitlist is
  'SQLSTATE 23505. NULLS NOT DISTINCT, so two joins for the same window with no therapist named are '
  'ONE key: without it a repeat join is not idempotent and the table grows per page refresh.';

create trigger waitlist_updated_at before update on waitlist
  for each row execute function set_updated_at();

-- The reader that offers a released slot asks "who is waiting for a window overlapping this one, on
-- this variant". btree_gist (0001) is what puts the date equality and the range overlap in one index.
create index waitlist_date_period_idx on waitlist using gist (trading_date, desired_period);
create index waitlist_customer_idx on waitlist (customer_id, created_at desc);

commit;

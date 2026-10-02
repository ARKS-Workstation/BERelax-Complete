-- 0123 — the operational holiday calendar, the announcement a confirmation rests on, and the hours
--        override that may not strand a booking.
--
-- ============================================================================================
-- What this file is for
-- ============================================================================================
--
-- Three tables' worth of subject and only two tables, because the third already exists.
--
--   1. **`holiday_observance`** — the operational calendar. One row per observance, carrying a
--      `confirmation_state` of `provisional` or `confirmed`, a `date_basis` of `gregorian` or `lunar`,
--      and the `source` the date came from in the author's own words.
--   2. **`holiday_confirmation`** — the announcement a confirmed date rests on, append-only, carrying
--      the dates the observance held BEFORE it as well as the ones it holds now.
--   3. **`premises_hours_override`** already exists (0011) and is not redefined here. What is added is
--      the refusal that keeps a Ramadan schedule from stranding a booking somebody has already taken.
--
-- ============================================================================================
-- Why a confirmation STATE is a column and not a convention
-- ============================================================================================
--
-- UAE public holidays are lunar and announced at short notice (docs/04 §6, docs/06 B5), so a date in
-- this calendar is one of two completely different claims: a date somebody has announced, and a date
-- somebody has predicted. `reporting.calendar_observance` (0110) already makes that distinction with
-- `is_provisional`, and its header gives the reason this file inherits: a plausible lunar date is
-- indistinguishable from a confirmed one in the one place every report keys on.
--
-- So it is a COLUMN, on the row, with a `check` that holds it to the OPEN-QUESTIONS id that owns it —
-- `holiday_observance_provisional_names_a_question`, which is 0110's own convention and 0026's before
-- it. A reader of the row can tell the two apart without reading anything else, and a `provisional`
-- observance that names no question is unstorable rather than merely undocumented.
--
-- **No row is SEEDED, and that is deliberate rather than unfinished.** Every date is
-- `Y9-holiday-calendar` in docs/OPEN-QUESTIONS.md. Inventing one here would be brief rule 15's
-- "plausible is indistinguishable from configured" applied to a date the rota, the payslip and three
-- reports would then key on, and it would be invented in a REPLAYED migration — so every tree would
-- carry it and nothing would ever say where it came from. The mechanism is here; the figures are not.
-- `packages/fixtures/src/hr-holiday-calendar.itest.ts` exercises it against rows the suite inserts.
--
-- ============================================================================================
-- Why a confirmed LUNAR date needs an announcement on file (ZY291)
-- ============================================================================================
--
-- 0110 put the same rule in as a CHECK — `calendar_observance_lunar_is_provisional` refuses a
-- lunar-dated observance that is not provisional — and said in its own comment why that was the right
-- shape THEN and would not be once this unit landed:
--
--     "It is safe to assert NOW because nothing in this build can record an announcement: the lunar
--      calendar is `Y9-holiday-calendar` and the confirmation flow is P-HR-10's third acceptance line."
--
-- Something can record an announcement now, so the flat refusal is no longer the strict reading — it is
-- a refusal of the correct answer. Its successor is the same rule with the escape it was always missing:
-- **a lunar-dated observance may be `confirmed` only where a `holiday_confirmation` row names the
-- announcement it was confirmed from.** A lunar date presented as settled with nothing on file behind it
-- is still refused, which is the claim 0110 was making; a lunar date settled BY an announcement is now
-- storable, which is the claim it could not express.
--
-- `reporting.calendar_observance` keeps its CHECK untouched, and the deferral that would remove it is
-- recorded on P-HR-10's manifest entry rather than discharged here. See the NOTE there for the
-- measurement behind that: thirteen files and two ADRs read that table, one of them asserting the
-- constraint BY NAME, so dropping it is an integrating change and not a unit's.
--
-- ============================================================================================
-- Why the impact report is DERIVED and never stored
-- ============================================================================================
--
-- Confirming a provisional holiday onto a different date affects appointments, shift assignments and
-- approved leave, and the acceptance line asks for a report of what it affected. There is no
-- `holiday_impact_report` table, and ADR 0075 records why: the report is a function of the confirmation
-- row and the rows it is about, so storing it is a second statement of a derived figure — and the
-- figure it would disagree with first is the one somebody acts on, because an appointment moved after
-- the confirmation makes a stored report wrong and leaves it looking authoritative.
--
-- `holiday_confirmation` therefore carries `previous_starts_on` and `previous_ends_on` as well as the
-- confirmed dates, which is what makes the report REPRODUCIBLE from the row rather than remembered:
-- the two ranges are the report's whole input on the calendar side.
--
-- And the confirmation MUTATES NOTHING it reports on. No appointment is moved, no shift is reassigned
-- and no leave is withdrawn — those are decisions with their own actors, and a calendar edit that
-- silently rescheduled a customer would be the worst kind of helpful. ZY293 holds the confirmation row
-- and the observance row to each other so the pair is one fact; nothing in this file writes to
-- `appointment`, `shift`, `shift_assignment` or `leave_request` at all.
--
-- ============================================================================================
-- Why an observance does NOT close the premises
-- ============================================================================================
--
-- `premises_closure` (0003) carries `kind = 'public_holiday'` and looks like the holiday calendar. It is
-- not, and 0110's header already records the direction of the error: a closure means the premises is
-- SHUT, and a shut date has no `business_day` row at all (0011), while a public holiday the salon
-- TRADES THROUGH has no closure row — which `Y9-overtime` states in so many words.
--
-- So the two tables answer different questions and this one answers neither of the other's. A row in
-- `holiday_observance` is a PAY and ROTA fact: it decides which bucket a worked minute is paid in
-- (P-HR-05's `publicHoliday`) and it is rendered on the rota. It changes no trading hour and no
-- availability, which is the first acceptance line — "a provisional holiday changes no availability" —
-- true BY CONSTRUCTION rather than by a flag somebody remembered to check. Closing the premises for a
-- holiday is a `premises_closure` row, written by somebody who decided to close.
--
-- ============================================================================================
-- Private SQLSTATEs
-- ============================================================================================
--
-- `ZY291`–`ZY294`, allocated through `packages/db/src/sqlstate-registry.ts` and not by reading the
-- migrations a worktree can see (ADR 0043). `ZY295`–`ZY300` of the allocated band are left FREE and
-- deliberately UNREGISTERED: an entry for a code no migration raises is what direction 3 of
-- `pnpm sqlstate` refuses.
--
-- Four and not one, because each has a different thing to go and do: "record the announcement first",
-- "post a superseding confirmation rather than editing this one", "confirm the observance in the same
-- transaction" and "move the four appointments this names, or narrow the override" are four different
-- answers, which is the argument for a private code at all.
--
-- See docs/adr/0075-a-holiday-confirmation-reports-its-impact-and-mutates-nothing.md.

begin;

-- ---------------------------------------------------------------------------------------------
-- holiday_observance — the operational calendar
-- ---------------------------------------------------------------------------------------------
create table holiday_observance (
  id                 uuid        primary key default uuid_generate_v7(),

  -- `public_holiday` or `ramadan`, matching `reporting.calendar_observance.kind` rather than inventing a
  -- second vocabulary for the same two things.
  kind               text        not null check (kind in ('public_holiday', 'ramadan')),

  -- The observance's own name. A statutory holiday's NAME is a published fact; its DATE, for a lunar
  -- observance, is not, which is what `confirmation_state` is about.
  name               text        not null
    constraint holiday_observance_name_stated
      check (btrim(name) <> '' and not is_placeholder_text(name)),

  -- Fixed in the Gregorian calendar, or announced against the lunar one at short notice.
  date_basis         text        not null check (date_basis in ('gregorian', 'lunar')),

  -- **The column the whole unit turns on.** Not a boolean: `is_provisional = false` reads as an absence
  -- of a flag, and the two states here are two positive claims about where a date came from. 0110's
  -- mirror of this is a boolean because it predates the confirmation flow and has nothing to transition.
  confirmation_state text        not null
    check (confirmation_state in ('provisional', 'confirmed')),

  starts_on          date        not null,
  ends_on            date        not null,

  -- Which OPEN-QUESTIONS id owns the provisional date, as DATA, so a reader of the database can see that
  -- a date is an assumption awaiting an announcement (0026's convention, 0110's spelling).
  open_question_id   text,

  -- Where the date came from, in the author's own words. No vocabulary: a closed set here would read as
  -- the list of authorities this build recognises, and brief rule 15 refuses an invented issuing
  -- authority. Checked for placeholder text so "TBD" cannot stand in for a provenance.
  source             text        not null
    constraint holiday_observance_source_stated
      check (btrim(source) <> '' and not is_placeholder_text(source)),

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint holiday_observance_range_ordered check (ends_on >= starts_on),

  -- 0110's `calendar_observance_provisional_names_a_question`, as the state column spells it. A
  -- provisional date names the question that owns it; a confirmed one may not, because a confirmed date
  -- is an answer and a question id beside it would say the opposite.
  constraint holiday_observance_provisional_names_a_question
    check ((confirmation_state = 'provisional') = (open_question_id is not null))
);

comment on table holiday_observance is
  'The operational holiday calendar: public holidays and Ramadan as date ranges, each carrying whether '
  'its date is ANNOUNCED or PREDICTED. Deliberately EMPTY on a fresh database — every date is '
  'Y9-holiday-calendar, and a plausible lunar date is indistinguishable from a confirmed one (brief '
  'rule 15). A row here does NOT close the premises and changes no trading hour: that is '
  'premises_closure, and a public holiday the salon trades through has no closure row at all '
  '(Y9-overtime). What it decides is which bucket a worked minute is paid in and what the rota shows.';

comment on column holiday_observance.confirmation_state is
  'provisional for a date predicted against the lunar calendar or otherwise not announced; confirmed '
  'for one an announcement on file names. A lunar-dated observance may be confirmed only where a '
  'holiday_confirmation row names that announcement (ZY291).';

comment on column holiday_observance.source is
  'Where the date came from, in the author''s own words. Free text on purpose: a vocabulary here would '
  'read as the list of issuing authorities this build recognises, and brief rule 15 refuses an invented '
  'one. Placeholder text is refused so a marker cannot stand in for a provenance.';

create index holiday_observance_range_idx on holiday_observance (kind, starts_on, ends_on);

create trigger holiday_observance_updated_at before update on holiday_observance
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- holiday_confirmation — the announcement, append-only
-- ---------------------------------------------------------------------------------------------
--
-- One row per confirmation. `unique (observance_id)` rather than a history: an observance is confirmed
-- ONCE, and a second confirmation of the same row is a different observance (next year's) rather than a
-- correction. A date announced and then re-announced is a new observance naming the one it supersedes,
-- which is the shape 0107's gratuity corrections take, for the same reason — editing the first one
-- would leave the report that was read from it unexplainable.
create table holiday_confirmation (
  id                  uuid        primary key default uuid_generate_v7(),
  observance_id       uuid        not null unique references holiday_observance (id) on delete restrict,

  -- The dates the observance held BEFORE the confirmation, and the ones it holds after. Both, because
  -- the impact report is a function of the two ranges and is DERIVED rather than stored (ADR 0075): a
  -- confirmation that recorded only the new dates would make its own report unreproducible the moment
  -- somebody asked which appointments it had been about.
  previous_starts_on  date        not null,
  previous_ends_on    date        not null,
  confirmed_starts_on date        not null,
  confirmed_ends_on   date        not null,

  -- The announcement, in the author's own words — a published notice, a circular, a dated statement.
  -- Free text for `holiday_observance.source`'s reason: brief rule 15 refuses an invented issuing
  -- authority, and a vocabulary here would be exactly that list.
  announcement_source text        not null
    constraint holiday_confirmation_announcement_stated
      check (btrim(announcement_source) <> '' and not is_placeholder_text(announcement_source)),

  -- Who recorded it. Stated and never derived: a confirmation is an act with an actor, and
  -- `is_placeholder_text` refuses a placeholder rather than taking one (0107's convention).
  recorded_by         text        not null
    constraint holiday_confirmation_recorded_by_stated
      check (btrim(recorded_by) <> '' and not is_placeholder_text(recorded_by)),

  recorded_at         timestamptz not null default now(),

  constraint holiday_confirmation_previous_range_ordered
    check (previous_ends_on >= previous_starts_on),
  constraint holiday_confirmation_confirmed_range_ordered
    check (confirmed_ends_on >= confirmed_starts_on)
);

comment on table holiday_confirmation is
  'The announcement a confirmed observance rests on, with the dates the observance held before it. '
  'Append-only: UPDATE and DELETE raise (ZY292), because a report somebody acted on was read from this '
  'row and an edited announcement makes it unexplainable. It carries BOTH ranges so the impact report '
  'is reproducible from the row rather than stored beside it (ADR 0075). It mutates nothing it reports '
  'on — no appointment, shift assignment or approved leave is touched by a confirmation.';

create index holiday_confirmation_recorded_at_idx on holiday_confirmation (recorded_at);

-- ---------------------------------------------------------------------------------------------
-- A confirmation and its observance are ONE fact (ZY293)
-- ---------------------------------------------------------------------------------------------
--
-- The composite-key argument P-HR-11's `commission_line` makes about a rule version, applied to a date:
-- a confirmation row whose `confirmed_*` dates disagree with the observance's is a copy somebody has to
-- keep in step, and the first time it drifts the report names a range nobody confirmed.
--
-- DEFERRED, because the repository writes the observance's new dates and the confirmation row in one
-- transaction and neither order can be the wrong one.
create function assert_holiday_confirmation_matches_its_observance() returns trigger
language plpgsql
as $$
declare
  v_state   text;
  v_starts  date;
  v_ends    date;
begin
  select confirmation_state, starts_on, ends_on into v_state, v_starts, v_ends
    from holiday_observance where id = new.observance_id;

  -- Guaranteed by the foreign key, so a NULL here means the key was dropped.
  if v_state is null then
    raise exception
      'A holiday confirmation names observance % which does not exist.', new.observance_id
      using errcode = 'ZY293';
  end if;

  if v_state <> 'confirmed' then
    raise exception
      'Observance % is %, so the confirmation recorded against it is not the observance''s own state. '
      'Set confirmation_state to confirmed in the SAME transaction: the row and the announcement are '
      'one fact, and a confirmed date with a provisional row behind it is a date every report reads as '
      'settled.',
      new.observance_id, v_state
      using errcode = 'ZY293';
  end if;

  if v_starts <> new.confirmed_starts_on or v_ends <> new.confirmed_ends_on then
    raise exception
      'A confirmation of observance % names % to %, but the observance holds % to %. The confirmed '
      'range IS the observance''s range; a second copy of it drifts, and the report then names a range '
      'nobody announced.',
      new.observance_id, new.confirmed_starts_on, new.confirmed_ends_on, v_starts, v_ends
      using errcode = 'ZY293';
  end if;

  return new;
end $$;

comment on function assert_holiday_confirmation_matches_its_observance() is
  'Raises ZY293. The observance must be confirmed and must hold exactly the dates the confirmation '
  'names, so the two rows are one fact rather than two copies of it.';

create constraint trigger holiday_confirmation_matches_its_observance
  after insert on holiday_confirmation
  deferrable initially deferred
  for each row execute function assert_holiday_confirmation_matches_its_observance();

-- ---------------------------------------------------------------------------------------------
-- A confirmed LUNAR observance names the announcement it rests on (ZY291)
-- ---------------------------------------------------------------------------------------------
--
-- 0110's `calendar_observance_lunar_is_provisional` with the escape it was always missing. See this
-- file's header for why the flat refusal stopped being the strict reading the moment a confirmation
-- could be recorded.
--
-- DEFERRED and on BOTH tables, because the two orders are both legitimate: the repository may confirm
-- the observance and then record the announcement, or record the announcement against an observance it
-- confirms in the same statement. An immediate trigger would refuse the first order, which is the one
-- a reader writes.
create function assert_lunar_observance_is_announced() returns trigger
language plpgsql
as $$
declare
  v_id       uuid;
  v_name     text;
  v_basis    text;
  v_state    text;
begin
  -- One function, two tables: the row that reaches it is either the observance or the confirmation, so
  -- the observance id is read from whichever column the table has.
  if tg_table_name = 'holiday_observance' then
    v_id := new.id;
  else
    v_id := new.observance_id;
  end if;

  select id, name, date_basis, confirmation_state into v_id, v_name, v_basis, v_state
    from holiday_observance where id = v_id;

  if v_id is null then return new; end if;
  if v_basis <> 'lunar' or v_state <> 'confirmed' then return new; end if;

  if exists (select 1 from holiday_confirmation where observance_id = v_id) then return new; end if;

  raise exception
    '% is lunar-dated and confirmed, but no holiday_confirmation names the announcement it was '
    'confirmed from. A lunar date is announced at short notice (docs/04 section 6), so a lunar '
    'observance presented as settled with nothing on file behind it is indistinguishable from a '
    'predicted one — which is the whole reason reporting.calendar_observance refused the row outright '
    'until a confirmation could be recorded. Record the announcement in the same transaction.',
    coalesce(v_name, v_id::text)
    using errcode = 'ZY291';
end $$;

comment on function assert_lunar_observance_is_announced() is
  'Raises ZY291. A lunar-dated observance may be confirmed only where a holiday_confirmation row names '
  'the announcement. The successor to 0110''s calendar_observance_lunar_is_provisional, which refused '
  'the case outright because nothing in the build could record an announcement.';

create constraint trigger holiday_observance_lunar_is_announced
  after insert or update on holiday_observance
  deferrable initially deferred
  for each row execute function assert_lunar_observance_is_announced();

create constraint trigger holiday_confirmation_lunar_is_announced
  after insert on holiday_confirmation
  deferrable initially deferred
  for each row execute function assert_lunar_observance_is_announced();

-- ---------------------------------------------------------------------------------------------
-- The announcement is append-only (ZY292)
-- ---------------------------------------------------------------------------------------------
--
-- 0107's argument, in a different currency: code that UPDATEs one of these rows is code that believes it
-- is correcting an announcement, and it must be TOLD that it cannot rather than left believing it did.
-- The report somebody acted on was read from this row.
create function refuse_holiday_confirmation_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'holiday_confirmation is append-only; % is refused. An announcement that turns out to name the '
    'wrong date is superseded by a new observance naming the one it replaces, never by editing the row '
    'the impact report was read from.',
    tg_op
    using errcode = 'ZY292';
end $$;

comment on function refuse_holiday_confirmation_change() is
  'Raises ZY292. Fires for EVERY role, including the owner: privileges cover the application role, and '
  'a migration or a psql session does not connect as the application role.';

create trigger holiday_confirmation_no_update before update on holiday_confirmation
  for each row execute function refuse_holiday_confirmation_change();
create trigger holiday_confirmation_no_delete before delete on holiday_confirmation
  for each row execute function refuse_holiday_confirmation_change();

-- ---------------------------------------------------------------------------------------------
-- holiday_override_stranded_appointments — the one statement of what "stranded" means in SQL
-- ---------------------------------------------------------------------------------------------
--
-- A dated hours override replaces `premises_hours` for its range (0011). Narrowing one — which is what a
-- reduced Ramadan schedule IS — can leave an appointment somebody has already taken outside the hours
-- the premises now keeps.
--
-- This function is the ONE statement of that in SQL. The refusal below calls it and so does
-- `packages/db/src/repositories/hours-override.ts`, so the report a caller gets back and the refusal the
-- database makes cannot disagree about which appointments are affected: the alternative is the
-- repository computing its own list, which is a second statement of the rule and would drift in the
-- direction where the report is empty and the write still fails.
--
-- `packages/core/src/availability/hours-override.ts` states the same rule in TypeScript, because
-- `packages/core` is pure and SQL cannot read TypeScript — so the check that holds the two equal ships
-- in the same commit: `packages/fixtures/src/holiday-hours-agreement.itest.ts` drives one probe set,
-- stated once, through both and requires identical verdicts. That is 0117's `is_card_shaped` /
-- `cardShapedRuns` arrangement, and the drift it guards is the dangerous direction: a database still
-- accepting what the availability engine had started refusing, so a test asserting the refusal would be
-- satisfied by the wrong layer.
--
-- **The ROOM period and not the treatment.** An appointment holds its room for its turnaround after the
-- treatment ends (0038), and a treatment that finishes at 01:55 with a 20-minute turnaround needs the
-- premises open until 02:15. Comparing the treatment alone would pass an override that sends the last
-- customer out through a locked door with the room still dirty.
create function holiday_override_stranded_appointments(
  p_starts_on   date,
  p_ends_on     date,
  p_day_of_week smallint,
  p_open_time   time,
  p_close_time  time
) returns table (appointment_id uuid, trading_date date)
language sql
stable
as $$
  select a.id, a.trading_date
    from appointment a
   where a.holds_resources
     and a.trading_date between p_starts_on and p_ends_on
     and (p_day_of_week is null
          or p_day_of_week = extract(dow from a.trading_date)::smallint)
     and (
       -- Half-open on the opening side, inclusive on the closing side: nothing may START at close
       -- (0011), and a treatment plus its turnaround may END exactly at it — which is the boundary
       -- `latestStartIn` is computed from and which solve.worked.test.ts pins at 02:00.
       lower(a.period)
         < (a.trading_date + p_open_time) at time zone 'Asia/Dubai'
       or upper(a.period) + make_interval(mins => a.turnaround_minutes)
         > (a.trading_date
            + case when p_close_time <= p_open_time then 1 else 0 end
            + p_close_time) at time zone 'Asia/Dubai'
     )
   order by a.trading_date, a.id
$$;

comment on function holiday_override_stranded_appointments(date, date, smallint, time, time) is
  'The appointments a premises_hours_override over this range and these hours would leave outside '
  'trading hours, room turnaround included. The ONE statement of the rule in SQL: the refusal (ZY294) '
  'and the repository that reports the ids both call it, so the report and the refusal cannot name '
  'different appointments. Held equal to hoursOverrideStrandedAppointments in packages/core by '
  'packages/fixtures/src/holiday-hours-agreement.itest.ts.';

-- ---------------------------------------------------------------------------------------------
-- An hours override may not strand a booked appointment (ZY294)
-- ---------------------------------------------------------------------------------------------
--
-- DEFERRED, so the transaction that moves the affected appointments and then narrows the hours is
-- possible at all — which is the only honest way to do it. An immediate trigger would make the override
-- unwritable until the appointments had moved, and the appointments unmovable in the same statement.
create function assert_hours_override_strands_no_appointment() returns trigger
language plpgsql
as $$
declare
  v_ids   text;
  v_count integer;
begin
  select count(*), string_agg(s.appointment_id::text, ', ' order by s.trading_date, s.appointment_id)
    into v_count, v_ids
    from holiday_override_stranded_appointments(
           new.starts_on, new.ends_on, new.day_of_week, new.open_time, new.close_time) s;

  if v_count = 0 then return new; end if;

  raise exception
    'A premises_hours_override of %-% over % to % would leave % already-booked appointment(s) outside '
    'trading hours, room turnaround included: %. Move them, or narrow the override''s range: reduced '
    'hours that strand a booking do not cancel it, they produce a customer standing outside a locked '
    'door.',
    new.open_time, new.close_time, new.starts_on, new.ends_on, v_count, v_ids
    using errcode = 'ZY294';
end $$;

comment on function assert_hours_override_strands_no_appointment() is
  'Raises ZY294 and names every stranded appointment id. Deferred, so a transaction may move the '
  'appointments and narrow the hours together; immediate would make each impossible without the other.';

create constraint trigger premises_hours_override_strands_no_appointment
  after insert or update on premises_hours_override
  deferrable initially deferred
  for each row execute function assert_hours_override_strands_no_appointment();

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
--
-- `update` on `holiday_observance` and not on `holiday_confirmation`: confirming an observance moves its
-- dates and its state, which is an update of the calendar row, while the announcement behind it is
-- append-only (ZY292). No `delete` on either — an observance entered in error is superseded, for the
-- reason the confirmation is append-only, and nothing in the application has a reason to remove a date
-- a report has already been read against.
grant select, insert, update on holiday_observance to berelax_app;
grant select, insert on holiday_confirmation to berelax_app;
grant execute on function holiday_override_stranded_appointments(date, date, smallint, time, time)
  to berelax_app;

commit;

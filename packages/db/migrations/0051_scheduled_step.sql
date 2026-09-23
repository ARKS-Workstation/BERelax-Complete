-- 0051 — the scheduled step: a reminder is a ROW carrying an invalidation key, never a delayed job.
--
-- This is the table B-LIFE-03 wrote a probe for and could not read, and the manifest calls the bug it
-- exists to remove "the most damaging bug in the domain". The bug has one shape, and it is worth stating
-- before the columns are:
--
--   A booking is confirmed for Friday 19:00 and a reminder job is queued with a 24-hour delay. The
--   customer moves the appointment to Saturday. The delayed job is still in the queue, still holding the
--   body it was built with, and on Thursday evening it tells the customer to come tomorrow at seven. She
--   arrives on the wrong day, the room is sold to somebody else, and nothing anywhere recorded a fault:
--   the send succeeded, the receipt was positive, and every log line is green.
--
-- Nothing at the queue layer prevents that. pg-boss has no notion of a job that should no longer run, and
-- a `singletonKey` does not help because the job is not a duplicate — it is correct about a world that
-- has changed. The only thing that can refuse it is a check made at the MOMENT of sending against the
-- appointment as it is THEN. So:
--
--   * the schedule is a row in this table, and the queue carries a step id and nothing else;
--   * every row carries an `invalidation_key` that is a deterministic function of
--     (appointment_id, step_type, period) — `invalidationKeyFor` in
--     packages/core/src/lifecycle/invalidation-key.ts;
--   * the worker re-derives the key from the appointment's CURRENT period and refuses any step whose
--     stored key disagrees.
--
-- A key rather than a period comparison because the key is the whole comparison in one value: it can be
-- carried in an event payload (B-LIFE-03's `appointment.rescheduled` already does), logged, and compared
-- by equality without a reader having to know how a `tstzrange` renders or which bound is inclusive.
--
-- ## Why the key is NOT unique, which is the subtle part
--
-- Reschedule Friday -> Saturday -> Friday. The final period is the original one, so the key re-derives to
-- the SAME string the first (now superseded) row holds. A UNIQUE constraint on `invalidation_key` would
-- refuse that third state — a legal move — and the obvious repair, reviving the superseded row, is the
-- resurrection this unit is asked to make impossible.
--
-- So the key answers exactly one question — "is this step still about the appointment's current period?"
-- — and it answers nothing about WHICH row to send. Row identity is `id`, and liveness is `state`:
-- `scheduled_step_one_pending_step_per_type` allows at most one `pending` row per (appointment, step
-- type), and `refuse_scheduled_step_resurrection` makes leaving `pending` a one-way door. Those two
-- together are "exactly one live step per step_type, and a superseded one never comes back".
--
-- ## Why `step_type` is text with a pattern and not an enum
--
-- The reminder set is a SETTING (`booking.reminder_offsets_hours`, F09 registry), and the step type is
-- derived from the offset: 24 hours is `reminder_24h`. An enum would make changing the reminder timing a
-- migration, which is precisely what docs/07 §2 says a bounded setting must not require — and the
-- acceptance criterion that a timing change produces NEW KEYS only holds because the type is in the key.
-- The bound the registry's Zod schema puts on an offset (1 to 168 hours) is restated in SQL below,
-- because the database cannot import the registry and a `reminder_9999h` row would schedule a reminder
-- for a year before the booking.
--
-- ## Why there is no `body`, `recipient` or `template_id` column
--
-- All three are resolved at send time, and that is the same decision as the key: a body stored on
-- Thursday is a body written about Friday's appointment. The recipient comes from the booking's customer,
-- the template from `message_template`, and the words from the template version current when the message
-- actually leaves. `message_id` is the link to what was sent, after the fact, which is the direction that
-- cannot go stale.

begin;

-- Five states, and the four that are not `pending` are all terminal. `superseded` and `cancelled` are
-- kept apart because they answer different questions about the same row: superseded means the
-- appointment moved and another step took over, cancelled means there is no longer an appointment to
-- remind anybody about. A single `void` state would make "how many reminders did rescheduling cost us"
-- unanswerable.
create type scheduled_step_state as enum ('pending', 'sent', 'skipped', 'superseded', 'cancelled');

create table scheduled_step (
  id               uuid                 primary key default uuid_generate_v7(),
  -- CASCADE, unlike almost every other foreign key in this schema. A scheduled step is not evidence of
  -- anything on its own: it is an intention about an appointment, so an appointment that no longer exists
  -- leaves nothing worth keeping. `message`, which IS the evidence, is referenced with RESTRICT below.
  appointment_id   uuid                 not null references appointment (id) on delete cascade,
  -- `reminder_24h`. Bounded by pattern rather than by an enum: see the header.
  step_type        text                 not null,
  -- The deterministic function of (appointment_id, step_type, period). Not unique, deliberately: see the
  -- header. Long enough for a uuid, a type label and two ISO instants, which is what it is made of.
  invalidation_key text                 not null,
  -- When the step wants to be sent. Derived from the period and the offset, so it moves with the period —
  -- which is why a moved appointment produces new rows rather than an UPDATE of this column.
  send_at          timestamptz          not null,
  state            scheduled_step_state not null default 'pending',
  -- The message the send produced. RESTRICT because it is the evidence the step was honoured, and UNIQUE
  -- below because two steps claiming one message would make "was this reminder sent" unanswerable.
  message_id       uuid                 references message (id) on delete restrict,
  -- Set when the step was sent AFTER its send instant had passed: a worker outage, a long deploy, a
  -- machine that was asleep. The note says how late, in words, because a customer reading "your booking
  -- tomorrow" six hours late is a different conversation from one reading it on time.
  staleness_note   text                 check (staleness_note is null or btrim(staleness_note) <> ''),
  -- Why it was not sent. A CLOSED set, because this column is what a report groups by and free text
  -- there is a column nobody can count. SCHEDULED_STEP_SKIP_REASONS in packages/core is the same list.
  skipped_reason   text                 check (skipped_reason in (
                                          'invalidation_key_stale',
                                          'appointment_not_live',
                                          'send_window_missed',
                                          'content_unavailable',
                                          -- The message was built and the choke point did not hand it to
                                          -- a vendor: a gate refusal, or F03's staging guard diverting it
                                          -- to the local outbox. Neither writes a `message` row, so the
                                          -- step has nothing to point at - and the second is the ORDINARY
                                          -- case on a staging worker.
                                          'send_refused')),
  -- The instant the worker decided. This column is the whole of "no step ends in a silent unrecorded
  -- state": a row that left `pending` without one is not storable, so the third outcome the acceptance
  -- criterion forbids cannot be written at all rather than being looked for afterwards.
  settled_at       timestamptz,
  created_at       timestamptz          not null default now(),
  updated_at       timestamptz          not null default now(),

  -- The reminder set is a setting, so the type is a label; the bound is the registry's own (1 to 168
  -- hours), restated because the database cannot import the registry.
  constraint scheduled_step_type_is_a_declared_reminder check (
    step_type ~ '^reminder_[1-9][0-9]{0,2}h$'
    and (regexp_replace(step_type, '^reminder_([0-9]+)h$', '\1'))::integer between 1 and 168
  ),
  constraint scheduled_step_invalidation_key_nonempty check (btrim(invalidation_key) <> ''),

  -- A pending step has decided nothing. Without this, a row can be `pending` and carry a message id or a
  -- skip reason, which reads as a step that was both sent and not sent.
  constraint scheduled_step_pending_has_settled_nothing check (
    state <> 'pending'
    or (settled_at is null and message_id is null and skipped_reason is null
        and staleness_note is null)
  ),
  -- And the other half: every terminal state records WHEN it was reached.
  constraint scheduled_step_terminal_is_settled check (
    state = 'pending' or settled_at is not null
  ),
  -- A send is a message and a message is a send, in both directions. `sent` with no message id is the
  -- invisible-stub shape docs/12 §1 forbids; a message id on a step that is not `sent` is a message
  -- nobody can account for.
  constraint scheduled_step_sent_carries_its_message check (
    (state = 'sent') = (message_id is not null)
  ),
  -- Same, for the skip. A skip with no reason code is the silent state again, wearing a label.
  constraint scheduled_step_skipped_carries_a_reason check (
    (state = 'skipped') = (skipped_reason is not null)
  ),
  -- Lateness is a property of a send. A superseded step was never late; it was replaced.
  constraint scheduled_step_staleness_is_about_a_send check (
    staleness_note is null or state = 'sent'
  ),
  -- One message, one step.
  constraint scheduled_step_message_claimed_once unique (message_id)
);

comment on table scheduled_step is
  'One scheduled message as a ROW. The queue carries this row''s id and nothing else; the body, the '
  'recipient and the template are resolved when it is sent, against the appointment as it is then.';
comment on column scheduled_step.invalidation_key is
  'A deterministic function of (appointment_id, step_type, period). The worker re-derives it from the '
  'appointment''s CURRENT period and refuses any step whose stored key disagrees. NOT unique: a '
  'reschedule back to the original period legitimately re-derives a superseded row''s key.';
comment on column scheduled_step.state is
  'pending is the only non-terminal state, and leaving it is a one-way door '
  '(refuse_scheduled_step_resurrection). At most one pending row per (appointment, step_type).';
comment on column scheduled_step.settled_at is
  'When the worker decided. Required for every terminal state, which is what makes "sent with a '
  'recorded note or skipped with a recorded reason, never silently neither" a thing the database '
  'refuses rather than a thing a test looks for.';

create trigger scheduled_step_updated_at before update on scheduled_step
  for each row execute function set_updated_at();

-- At most one LIVE step per (appointment, step type). This is the database's half of "exactly one live
-- step per step_type remains" after a reschedule and a reschedule back: the new row can only be inserted
-- because the old one left `pending` first, and the old one can never return to it.
--
-- Partial, because every terminal row is allowed to repeat the pair — an appointment rescheduled four
-- times has four superseded `reminder_24h` rows, which is the history of the booking.
create unique index scheduled_step_one_pending_step_per_type
  on scheduled_step (appointment_id, step_type)
  where state = 'pending';

-- The due sweep: pending rows whose send instant has passed. Partial on the same predicate, because a
-- settled row is never due again.
create index scheduled_step_due_idx on scheduled_step (send_at) where state = 'pending';
-- Every step of one appointment, which is what the lifecycle reads to supersede or cancel them, and what
-- B-LIFE-03's `readScheduledStepKeys` reads to put the keys into the event.
create index scheduled_step_appointment_idx on scheduled_step (appointment_id, step_type);

/*
  Leaving `pending` is a ONE-WAY DOOR.

  The acceptance criterion is that a reschedule and a reschedule back "does not resurrect the first
  superseded step". The application does that by inserting a new row, and this is the half that holds
  when somebody reaches past the application: a sweep, a migration, a psql session at 2am. Two layers for
  the reason 0035 gives for the status-regression rule — the repository makes the normal case quiet and
  the trigger makes every other writer obey it too.

  The rule is stated as "the OLD state must be pending" rather than as a list of permitted pairs,
  because that is the whole of it: `pending -> anything` is the worker or the lifecycle settling a step,
  and every other transition is a row being re-opened.
*/
create or replace function refuse_scheduled_step_resurrection() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state and old.state <> 'pending' then
    raise exception
      'scheduled_step_must_not_be_resurrected: % -> % on step %. A step that has been sent, skipped, '
      'superseded or cancelled is settled; the schedule moves forward by inserting a new row.',
      old.state, new.state, old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger scheduled_step_must_not_be_resurrected
  before update of state on scheduled_step
  for each row execute function refuse_scheduled_step_resurrection();

/*
  A pending step may not outlive the appointment it is about, and may not be scheduled past its start.

  This is the backstop, and it is the reason the damaging bug cannot be reintroduced by forgetting a
  line. `appointment.holds_resources` (0024) is generated false for exactly the four statuses that end an
  appointment — no_show, both cancellations, and `rescheduled` — so "this appointment is over or has been
  superseded" is already one column. A `pending` step attached to such a row is a reminder waiting to be
  sent about something that will not happen, which is the bug in its purest form.

  DEFERRED, and that is load-bearing. A cancellation moves the status and then settles the steps, and a
  reschedule releases the predecessor and then inserts the successor's steps; an immediate trigger would
  refuse both for the state they hold momentarily in the middle. Deferred, the transaction is judged on
  what it COMMITS, which is the only question worth asking — and `set constraints all immediate`, which
  both the booking and the reschedule transactions already issue, brings the refusal forward to where the
  context is.

  The second clause catches the other way in: an UPDATE of `period` on a live appointment, which is not
  the reschedule path (a reschedule inserts a successor) and therefore leaves every attached key stale.
  The database cannot re-derive the key — that rule is `packages/core`'s — but it CAN see that a reminder
  is now scheduled at or after the treatment it is reminding somebody about, which a period pulled
  earlier produces. It is half the check and it is the half SQL can make.
*/
create or replace function refuse_stale_pending_scheduled_step() returns trigger
language plpgsql as $$
declare
  v_appointment_id uuid;
  v_offender       record;
begin
  -- An IF and not a CASE expression over `tg_table_name`: `new` carries `appointment_id` on one of these
  -- two tables and not on the other, and an expression that merely looks unevaluated is not a guarantee
  -- that it is.
  if tg_table_name = 'appointment' then
    v_appointment_id := new.id;
  else
    v_appointment_id := new.appointment_id;
  end if;

  select s.id, s.step_type, s.send_at, a.status, a.holds_resources, lower(a.period) as starts_at
    into v_offender
    from scheduled_step s
    join appointment a on a.id = s.appointment_id
   where s.appointment_id = v_appointment_id
     and s.state = 'pending'
     and (not a.holds_resources or s.send_at >= lower(a.period))
   limit 1;

  if found then
    raise exception
      'scheduled_step_must_not_outlive_its_appointment: step % (%) is still pending on appointment % '
      '(status %, starts at %), and it is due at %. %',
      v_offender.id, v_offender.step_type, v_appointment_id, v_offender.status, v_offender.starts_at,
      v_offender.send_at,
      case
        when not v_offender.holds_resources
          then 'The appointment no longer holds its resources, so this is a reminder about something '
               'that will not happen.'
        else 'The step is due at or after the treatment starts, so it would arrive too late to be a '
             'reminder.'
      end
      using errcode = 'restrict_violation';
  end if;
  return null;
end;
$$;

-- On the appointment, because that is where the status moves, and on the step, because that is where a
-- writer could attach one to a row that is already over. Both DEFERRED: see the function's comment.
create constraint trigger appointment_leaves_no_pending_scheduled_step
  after update of status, period on appointment
  deferrable initially deferred
  for each row execute function refuse_stale_pending_scheduled_step();

create constraint trigger scheduled_step_attaches_to_a_live_appointment
  after insert or update on scheduled_step
  deferrable initially deferred
  for each row execute function refuse_stale_pending_scheduled_step();

-- 0009's default privileges cover a table created later only if they were granted to the schema; every
-- other migration restates the grant rather than relying on it, because a managed database restored from
-- a dump does not necessarily carry the same defaults. No DELETE: a settled step is the record of what
-- the system decided to do about a booking, and the one legitimate removal — the appointment itself
-- going — happens through the CASCADE, which is performed as the table owner.
grant select, insert, update on scheduled_step to berelax_app;

commit;

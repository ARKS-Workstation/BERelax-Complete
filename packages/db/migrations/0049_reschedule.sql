-- 0049 — the reschedule link and the late-cancellation flag that charges nothing.
--
-- B-LIFE-03 needs exactly two facts on `appointment` that no earlier migration holds, and it needs them
-- for opposite reasons: one records a move the lifecycle already declares, the other records a judgement
-- the business has not yet decided what to do about.
--
-- ## 1. `rescheduled_from_id` — which row this one replaced
--
-- B-LIFE-01 decided the shape of a reschedule before this unit wrote a line of it, and the decision is in
-- `packages/core/src/lifecycle/transitions.ts`: `rescheduled` is a TERMINAL state whose repeat is refused,
-- because "the appointment that still exists is the SUCCESSOR". So a reschedule is not an UPDATE of
-- `period`. It is the old row moving to `rescheduled` — which makes `holds_resources` false (0024) and
-- releases the therapist and the room in the same statement — and a NEW row acquiring the new period.
--
-- Without a link, the only record of which row replaced which is in `audit_event` and the outbox. Both are
-- append-only logs read by time, and neither can answer the front desk's question ("this booking was
-- moved — to when?") without scanning them. So the successor carries the predecessor's id.
--
-- Three decisions in that one column, each of which could have gone the other way:
--
--   * **On the SUCCESSOR, not the predecessor.** `rescheduled_to_id` on the old row would need a second
--     UPDATE after the insert, and `transitionAppointment` (B-LIFE-01's write path, which this unit must
--     not fork) writes the status by itself. Here the value is part of the INSERT that creates the
--     successor, so there is no window in which a superseded row points at nothing.
--   * **UNIQUE, partial.** One predecessor has at most one successor. That is the database half of
--     `repeat: 'refused'` on `rescheduled`: a second reschedule of an already-superseded row would insert
--     a second successor for the same predecessor, and the unique index refuses it by name even if a
--     caller reached past the transition table. Partial, because NULL is the ordinary case — every row
--     that was never rescheduled — and a total unique index would permit exactly one of them.
--   * **NO ACTION on delete, not CASCADE and not SET NULL.** CASCADE would delete the LIVE appointment
--     when the superseded one is removed, which is backwards. SET NULL would silently erase the link. NO
--     ACTION is checked at the end of the statement, so `delete from booking` (which cascades to every
--     appointment of the booking, predecessor and successor together) still works, while deleting a
--     predecessor on its own is refused — an orphaned chain is a reschedule that cannot be explained.
--
-- ## 2. `late_cancellation` — the flag that is not a charge
--
-- The cancellation window is `booking.cancellation_window_hours` in the F09 registry, declared
-- `provisional: true` against Y9-windows with the note "24 hours, flagged only, no fee". The business has
-- agreed no fee policy and takes no card payments, so there is nothing to charge against and no
-- instrument to charge with. A `fee_fils` column here would be a capability the business does not have,
-- pre-written into the schema where a later reader would find it and assume it is used; and the seam where
-- a fee arrives is a settings change plus the unit that owns money, not a migration.
--
-- So what is stored is the JUDGEMENT and the figure it was made against, and nothing else:
--
--   * `late_cancellation` — true when the cancellation arrived inside the window.
--   * `late_cancellation_window_hours` — the window in force at that moment.
--
-- The second column exists because the first is otherwise unexplainable. The setting is provisional: the
-- owner may move it from 24 hours to 48 tomorrow, and a bare boolean would then be a flag nobody can
-- account for — "late by whose figure?" — on precisely the rows a future fee policy will read. The two are
-- constrained WHOLE-OR-NOTHING (`appointment_late_cancellation_is_whole`), the same shape 0046's
-- `attribution_is_whole` takes and for the same reason: half of this record cannot answer the question the
-- pair exists for.
--
-- A no-show is deliberately NOT flagged here. It is already a status (`no_show`), and the fact that makes
-- it one is the client's absence rather than the moment a message arrived; giving it a second
-- representation as a "late" flag would be two columns answering one question.
begin;

alter table appointment
  add column rescheduled_from_id uuid
    references appointment (id) on update cascade,
  add column late_cancellation boolean not null default false,
  add column late_cancellation_window_hours smallint,

  -- A row cannot supersede itself. Reachable only through a caller that composed the insert by hand, and
  -- it would make the chain a cycle that no reader terminates on.
  add constraint appointment_reschedule_is_not_self
    check (rescheduled_from_id is null or rescheduled_from_id <> id),

  -- Half the record is always a defect: a flag with no figure cannot be accounted for, and a figure with
  -- no flag is a window recorded against a cancellation that was inside nothing.
  add constraint appointment_late_cancellation_is_whole
    check ((late_cancellation) = (late_cancellation_window_hours is not null)),

  -- Only a cancellation can be a late cancellation. A completed treatment carrying the flag is the shape
  -- of a sweep that updated the wrong rows, and a future fee policy reading it would charge for a
  -- massage that was delivered.
  add constraint appointment_late_cancellation_needs_a_cancellation
    check (
      not late_cancellation
      or status in ('cancelled_by_customer', 'cancelled_by_salon')
    ),

  -- The same bounds the F09 registry's Zod schema puts on the setting (0 to 168 hours). Restated here
  -- because the database cannot import the registry, and a stored window of 10,000 hours would flag
  -- every cancellation the salon ever takes.
  add constraint appointment_late_cancellation_window_bounded
    check (late_cancellation_window_hours is null
           or late_cancellation_window_hours between 0 and 168);

-- Partial: NULL is the ordinary case and a total unique index would allow exactly one never-rescheduled
-- appointment in the whole table. This is the database's half of `repeat: 'refused'` on `rescheduled`.
create unique index appointment_one_successor_per_predecessor
  on appointment (rescheduled_from_id)
  where rescheduled_from_id is not null;

comment on column appointment.rescheduled_from_id is
  'The appointment this row replaced, when it was created by a reschedule. The predecessor is the row in '
  'status `rescheduled`, whose holds_resources is false, so the two never contend for the same period. '
  'UNIQUE (partial), because a predecessor has at most one successor.';
comment on column appointment.late_cancellation is
  'True when the cancellation arrived inside booking.cancellation_window_hours. A FLAG and never a '
  'charge: the setting is provisional (Y9-windows), no fee policy is agreed, and the business takes no '
  'card payments - so a cancellation writes no payment, invoice or fee row of any kind.';
comment on column appointment.late_cancellation_window_hours is
  'The window in force at the moment the flag was set. Stored because the setting is provisional and '
  'changeable, and a flag whose figure is unrecoverable cannot be accounted for by the fee policy that '
  'later reads it.';

-- `appointment` gained three columns, and 0009's default privileges plus 0024's grants already cover
-- them: a column added later inherits the table's grants. Re-stated rather than relied upon, exactly as
-- 0046 does, because a managed database restored from a dump does not necessarily carry the same
-- defaults.
grant select, insert, update on appointment to berelax_app;

commit;

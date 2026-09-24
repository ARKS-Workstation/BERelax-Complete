-- 0065 — the reassignment as a RECORDED change, and the three ways a flag leaves the queue.
--
-- P-HR-04 acts on the queue 0058 produces: a different therapist takes an appointment the current one
-- may no longer deliver, and the customer keeps their booking. Two tables learn one thing each, and
-- neither of them is `appointment` — a reassignment writes `appointment.therapist_id` and nothing else,
-- which is what makes "the booking survives, only the therapist changes" a claim about one column.
--
-- Numbering: 62, 63 and 64 are allocated to units in flight, so this is 65. Nothing is renumbered to
-- close the gap — 0055's header records why, and it is the same reason: a number is a high-water mark,
-- and two branches that each tidy the sequence apply one number to two different files.
--
-- ## 1. `appointment_status_history` records a reassignment, because a reassignment IS a change
--
-- The acceptance line asks for an `appointment_status_history` row carrying the actor and a reason from
-- a closed set. Nothing in the chain could hold one before this migration, and the two obvious ways of
-- forcing one in are both worse than a column:
--
--   * A row with `from_status = to_status` is refused by `appointment_status_history_is_a_change` — and
--     rightly, because a row that records no change is a chain reading as activity where none occurred.
--   * A row with `from_status` NULL is the shape 0024 gives an appointment's CREATION. Borrowing it
--     would make "when was this booking taken" unanswerable for every reassigned appointment.
--
-- So `from_therapist_id` and `to_therapist_id` join the row, and the change a history row must record
-- becomes "the status moved, OR the therapist did". `appointment_status_history_is_a_change` keeps its
-- NAME and widens its expression: the two callers that assert on that name — the self-transition control
-- in `packages/db/src/schema/booking-constraints.itest.ts` and its gate case — are asserting the rule
-- this migration deliberately does not relax, since a row whose status does not move and whose therapist
-- does not either is still refused.
--
-- **The trigger stays the only writer.** 0024's argument is that a history table the application writes
-- is a history table with gaps exactly where somebody was in a hurry, and the gaps are invisible. So
-- `record_appointment_status()` is re-issued with a third branch rather than the application being
-- granted a new kind of insert: a reassignment cannot be performed without its history row, in the same
-- sense that a transition cannot.
--
-- The branch is an `elsif` and not a second `if`, which is a decision about one statement nothing in
-- this build writes. An UPDATE moving the status AND the therapist at once would then append TWO rows,
-- and `transitionAppointment` refuses a transition that appended anything but exactly one — so the
-- permissive shape would turn a hypothetical future statement into a broken lifecycle transition. The
-- status is the more consequential fact and keeps the row; `reassignAppointment` writes `therapist_id`
-- alone, and `packages/fixtures/src/reassignment.itest.ts` asserts that the status column is untouched
-- either way.
--
-- The reason vocabulary is a CHECK and not an enum, for the reason 0046 gives for `actor_role`: `reason`
-- is a free-text column shared with every lifecycle transition, whose reasons are prose an operator
-- typed. Only a reassignment row's reason is closed, and it is closed to the four the acceptance names.
-- A reassignment row with NO reason is refused too — `reason in (...)` is NULL rather than false for a
-- NULL reason, and a CHECK whose expression is NULL passes, which is the trap 0026 records and 0057
-- records again.
--
-- ## 2. The flag names WHICH of the three exits ended it
--
-- 0058 clears a flag by stamping `cleared_at`, and until now the sweep was the only thing that could:
-- the therapist became eligible again, so the queue entry was withdrawn. P-HR-04 adds two more exits —
-- a reassignment, and a human deciding the appointment needs none — and the acceptance line is that a
-- flagged appointment "cannot leave the queue except by reassignment or an audited explicit resolution".
--
-- That claim is only checkable if the exit is ON the row, so `cleared_reason` is NOT NULL exactly when
-- `cleared_at` is: the clearance is whole in three columns instead of two, and there is no fourth way
-- out. DELETE is already revoked (0058) and the flag is never deleted; an UPDATE that stamped
-- `cleared_at` without naming which exit it was is now refused by the database rather than by review.
--
-- `resolved_by_hand` additionally carries a note, because that exit is the one with no external fact
-- behind it — a renewal is a document and a reassignment is another therapist, and a human deciding the
-- queue entry is finished is answerable only through what they wrote down. The note is mandatory for
-- that label and refused for the other two, which is the shape 0046's `attribution_is_whole` and 0049's
-- `late_cancellation_is_whole` both take: half a resolution answers nothing.
--
-- `reassigned_to_therapist_id` is the mirror of `therapist_id` on the same row, and 0058's reason for
-- copying that column is exactly why this one exists: after a reassignment the join to `appointment` no
-- longer answers "who was it taken away from", and after a SECOND reassignment it no longer answers
-- "who took it" either. Both halves of the swap are therefore on the flag that recorded it.
--
-- `is not distinct from` throughout rather than `=`. A live flag has `cleared_reason` NULL, and
-- `null = 'reassigned'` is NULL, so the `=` spelling would let a LIVE flag carry a successor therapist
-- and a resolution note — the permissive answer, reached by writing the obvious operator (0024's
-- `is distinct from` note for `employee.gender` makes the same point from the other direction).

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. appointment_status_history: the therapist pair
-- ---------------------------------------------------------------------------------------------
alter table appointment_status_history
  -- The therapist the appointment was taken FROM, and the one it went TO. Plain uuids and deliberately
  -- not foreign keys: `appointment.therapist_id` is not one either (0024), and this table is
  -- append-only, which 0024's own comment says cannot hold a reference to a mutable parent.
  add column from_therapist_id uuid,
  add column to_therapist_id   uuid,
  -- Whole or nothing. A row naming who lost the appointment and not who took it describes half a swap,
  -- and half a swap cannot answer the question the pair exists for.
  add constraint appointment_status_history_reassignment_is_whole
    check ((from_therapist_id is null) = (to_therapist_id is null)),
  -- A "reassignment" to the therapist who already holds it is not one. It would also be refused by
  -- `appointment_therapist_no_overlap` on the appointment itself, which is a constraint about a
  -- different table: this one is about the chain being a record of something that happened.
  add constraint appointment_status_history_reassignment_changes_therapist
    check (from_therapist_id is null or from_therapist_id <> to_therapist_id),
  -- The four reasons P-HR-04 declares, mirrored in `REASSIGNMENT_REASONS` in
  -- `packages/core/src/hr/reassignment.ts` and pinned to this constraint by
  -- `packages/fixtures/src/reassignment.itest.ts`, which parses the accepted set out of `pg_constraint`
  -- and asserts it equals that list in both directions — the arrangement 0046 made for `actor_role`.
  -- `reason is not null` is written out because `reason in (...)` is NULL for a NULL reason and a CHECK
  -- passes on NULL.
  add constraint appointment_status_history_reassignment_reason_known
    check (to_therapist_id is null or (reason is not null and reason in
      ('credential_expiry', 'leave_approved', 'therapist_archived', 'manual')));

comment on column appointment_status_history.from_therapist_id is
  'The therapist the appointment was taken from, on the row recording a reassignment. NULL on a status '
  'transition, which is about the appointment rather than about who delivers it.';
comment on column appointment_status_history.to_therapist_id is
  'The therapist the appointment went to. NOT NULL exactly when from_therapist_id is, and its presence '
  'is what makes the row a reassignment: the status is unchanged on such a row by design, because '
  'holds_resources is GENERATED from the status (0024) and the booking is being kept.';

-- Widened, same name. A row must still record a change; there is now a second kind of change it can
-- record. The `<>` half is unchanged, so the self-transition control and its gate case still fail.
alter table appointment_status_history
  drop constraint appointment_status_history_is_a_change,
  add constraint appointment_status_history_is_a_change
    check ((from_status is null or from_status <> to_status) or to_therapist_id is not null);

comment on constraint appointment_status_history_is_a_change on appointment_status_history is
  'A history row records a change: the status moved, or the therapist did (0065). A row where neither '
  'moved is a chain reading as activity where nothing occurred.';

-- The chain read per therapist: "every appointment taken off this person, and every one handed to them".
-- Partial, because the pair is NULL on every status transition and those are most of the table.
create index appointment_status_history_reassignment_idx
  on appointment_status_history (to_therapist_id, occurred_at desc)
  where to_therapist_id is not null;

-- ---------------------------------------------------------------------------------------------
-- The trigger, re-issued a second time: same chain, now recording a reassignment too.
-- ---------------------------------------------------------------------------------------------
-- Unchanged in every other respect, deliberately and for the reasons 0046 lists: it still fires AFTER,
-- so a row that fails a constraint leaves no history; it still judges nothing; and it still writes on
-- INSERT with `from_status` NULL, because a creation is not a transition.
create or replace function record_appointment_status() returns trigger
language plpgsql
as $$
declare
  v_actor_kind  text;
  v_actor_id    uuid;
  v_actor_label text;
  v_actor_role  text;
  v_reason      text;
begin
  -- Empty-string-normalised, exactly as 0036 and 0046 do it: `set_config` cannot store SQL NULL, so a
  -- caller with nothing to say sets '' and that must not be recorded as an actor somebody named.
  v_actor_kind  := nullif(btrim(coalesce(current_setting('berelax.transition_actor_kind',  true), '')), '');
  v_actor_label := nullif(btrim(coalesce(current_setting('berelax.transition_actor_label', true), '')), '');
  v_actor_role  := nullif(btrim(coalesce(current_setting('berelax.transition_actor_role',  true), '')), '');
  v_reason      := nullif(btrim(coalesce(current_setting('berelax.transition_reason',      true), '')), '');
  -- A malformed uuid is a caller bug and is left to raise: recording the transition with the actor
  -- silently dropped is how an unattributed row comes to look like a psql correction.
  v_actor_id    := nullif(btrim(coalesce(current_setting('berelax.transition_actor_id',    true), '')), '')::uuid;

  if tg_op = 'INSERT' then
    insert into appointment_status_history
      (appointment_id, from_status, to_status, actor_kind, actor_id, actor_label, actor_role, reason)
    values (new.id, null, new.status,
            v_actor_kind, v_actor_id, v_actor_label, v_actor_role, v_reason);
  elsif old.status <> new.status then
    insert into appointment_status_history
      (appointment_id, from_status, to_status, actor_kind, actor_id, actor_label, actor_role, reason)
    values (new.id, old.status, new.status,
            v_actor_kind, v_actor_id, v_actor_label, v_actor_role, v_reason);
  -- The reassignment (P-HR-04, 0065). `is distinct from` rather than `<>`: therapist_id is NOT NULL
  -- today, and the day anything makes it nullable `<>` would be NULL — which an `elsif` treats as
  -- false, so the change would go unrecorded. An elsif and not a second if; the header says why.
  elsif old.therapist_id is distinct from new.therapist_id then
    insert into appointment_status_history
      (appointment_id, from_status, to_status, from_therapist_id, to_therapist_id,
       actor_kind, actor_id, actor_label, actor_role, reason)
    -- The status is carried on BOTH sides because it did not move. That is the fact the row is making:
    -- a reassignment leaves the appointment confirmed, so the customer's booking is still a booking.
    values (new.id, old.status, new.status, old.therapist_id, new.therapist_id,
            v_actor_kind, v_actor_id, v_actor_label, v_actor_role, v_reason);
  end if;
  return null;
end $$;

-- And the TRIGGER, re-issued with it — which is the half that would have made the branch above dead
-- code. 0024 declared it `after insert or update OF STATUS`, so an UPDATE that touches `therapist_id`
-- and nothing else does not fire it at all: the function would have been correct and never called, and
-- the only symptom would be a reassignment with no history row. It was written that way on purpose
-- (a trigger that fires for every column is a trigger that runs on every price correction), so the
-- column list grows by exactly the column that now has a chain entry of its own.
create or replace trigger appointment_status_recorded
  after insert or update of status, therapist_id on appointment
  for each row execute function record_appointment_status();

comment on function record_appointment_status() is
  'Appends the transition chain, taking the actor, role and reason from the transaction-local '
  'berelax.transition_* settings (0046). Since 0065 it also appends a REASSIGNMENT row - the status '
  'unchanged on both sides, the therapist pair recorded - so a reassignment cannot be performed without '
  'its history row any more than a transition can. AFTER, so a row that fails a constraint leaves no '
  'history; and it judges nothing.';

-- 0009's default privileges cover columns added later, and 0024 revoked update and delete on this
-- table. Re-stated rather than relied upon, for the reason 0046 gives: "inherits" and "we checked" are
-- different facts, and a managed database restored from a dump need not carry the same defaults.
grant select, insert on appointment_status_history to berelax_app;
revoke update, delete, truncate on appointment_status_history from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- 2. appointment_reassignment_flag: which exit ended the queue entry
-- ---------------------------------------------------------------------------------------------
create type appointment_reassignment_clearance as enum (
  -- The sweep found the therapist eligible again for the appointment's own trading date: a renewal, or
  -- a profile that no longer demands the document. P-HR-03's clearance, and the only one that existed
  -- before this migration.
  'credential_restored',
  -- Another therapist now holds the appointment. P-HR-04's reassign transaction.
  'reassigned',
  -- A human decided this appointment needs no reassignment and said why. The exit with no external
  -- fact behind it, which is why it is the one that carries a note.
  'resolved_by_hand'
);

comment on type appointment_reassignment_clearance is
  'The three ways a live reassignment flag ends, one of which must be named for cleared_at to be '
  'storable. A fourth way out would be a new label here and a new writer, both visible in review; '
  'without this column "the appointment left the queue" and "somebody dealt with it" are one state.';

alter table appointment_reassignment_flag
  add column cleared_reason appointment_reassignment_clearance,
  -- Why a human closed it, in their words. Mandatory for `resolved_by_hand` and refused otherwise.
  add column resolution_note text,
  -- Who took the appointment. The mirror of `therapist_id`, which 0058 copies onto this row precisely
  -- because a reassignment replaces `appointment.therapist_id` and the join then answers neither half.
  add column reassigned_to_therapist_id uuid;

-- Every row cleared before this migration was cleared by the sweep, which is the only writer 0058
-- shipped: `clearReassignmentFlags` is called from `apps/worker/src/jobs/credential-sweep.ts` and from
-- nowhere else, and it clears exactly when the therapist is credential-eligible again. So the backfill
-- is the fact rather than a guess, and it is written before the constraint below demands it.
update appointment_reassignment_flag
   set cleared_reason = 'credential_restored'
 where cleared_at is not null
   and cleared_reason is null;

alter table appointment_reassignment_flag
  -- Whole in three columns now. Half a clearance cannot answer the questions the set exists for: when
  -- it was cleared, on which trading day the pass that cleared it ran, and which exit it was.
  drop constraint appointment_reassignment_flag_clearance_is_whole,
  add constraint appointment_reassignment_flag_clearance_is_whole
    check ((cleared_at is null) = (cleared_on is null)
       and (cleared_at is null) = (cleared_reason is null)),
  -- The note belongs to the hand resolution and to nothing else. A note on a sweep clearance would be
  -- prose attached to a decision no human took; a hand resolution without one is the audit trail's
  -- subject missing from the audit trail.
  add constraint appointment_reassignment_flag_note_is_for_a_hand_resolution
    check ((cleared_reason is not distinct from 'resolved_by_hand') = (resolution_note is not null)),
  add constraint appointment_reassignment_flag_note_nonempty
    check (resolution_note is null or btrim(resolution_note) <> ''),
  -- The successor belongs to the reassignment and to nothing else, and it is not the therapist who lost
  -- the appointment: that is not a reassignment, and `appointment_therapist_no_overlap` would refuse
  -- the write on `appointment` in any case.
  add constraint appointment_reassignment_flag_reassignment_names_the_successor
    check ((cleared_reason is not distinct from 'reassigned') = (reassigned_to_therapist_id is not null)),
  add constraint appointment_reassignment_flag_successor_is_not_the_incumbent
    check (reassigned_to_therapist_id is null or reassigned_to_therapist_id <> therapist_id);

comment on column appointment_reassignment_flag.cleared_reason is
  'Which of the three exits ended this queue entry. NOT NULL exactly when cleared_at is, so "it left '
  'the queue" cannot be recorded without saying how - the database half of P-HR-04''s acceptance line '
  'that a flagged appointment leaves only by reassignment, by an audited explicit resolution, or '
  'because the credential position was restored.';
comment on column appointment_reassignment_flag.resolution_note is
  'Why a human closed this entry without a reassignment. Mandatory for resolved_by_hand and refused for '
  'the other two labels: the other two have an external fact behind them and this one has only what '
  'somebody wrote down.';
comment on column appointment_reassignment_flag.reassigned_to_therapist_id is
  'The therapist who took the appointment. Copied here for 0058''s reason for copying therapist_id: '
  'after a reassignment the join to appointment no longer answers who it was taken from, and after a '
  'second one it no longer answers who took it either.';

-- No DELETE, still. A flag is cleared, never removed; 0058 says why and this migration adds two more
-- ways to clear one rather than any way to remove one. Re-stated for 0046's reason.
grant select, insert, update on appointment_reassignment_flag to berelax_app;
revoke delete, truncate on appointment_reassignment_flag from berelax_app;

commit;

-- 0046 — attribution on the transition chain: who moved the appointment, under which role, and why.
--
-- B-LIFE-01's acceptance asks that every transition append one `appointment_status_history` row carrying
-- **actor, role, reason and timestamptz**. 0024 built the chain with `from_status`, `to_status` and
-- `occurred_at` and deliberately left the other three to this unit, with the reason written out in its
-- comment: "Attribution belongs to audit_event ... duplicating it here would give one fact two sources."
--
-- That objection is answered rather than overruled, and two facts answer it.
--
-- **The grain differs.** `audit_event` holds one row per repository ACTION. A couples booking cancelled
-- in one call is ONE audit row and TWO history rows, so per-appointment attribution is not recoverable
-- from it: both appointments point at the same action, and a later correction to one of them is
-- indistinguishable from the original decision about both. The chain is per-appointment, and so is the
-- question it is read to answer — "who moved THIS appointment, and why".
--
-- **The role is not in `audit_event` at all.** It records `actor_kind` ('staff', 'customer', 'system',
-- 'agent'), which is what KIND of actor acted. The F07 ROLE — owner, manager, receptionist — is what the
-- permission check actually consulted (`can(role, 'booking:cancel_as_salon')` in
-- packages/core/src/lifecycle/transitions.ts), and it has no other home in the schema. A trail that
-- cannot say which role authorised a move cannot answer whether it was authorised.
--
-- ## The trigger keeps writing the row, and the values arrive through transaction-local settings
--
-- 0024 writes history from a trigger so that "a transition without a history row is not reachable", and
-- that property is worth more than the convenience of letting the caller insert one. A trigger cannot see
-- a value that is not a column on `appointment`, so the actor arrives the way 0036 solved exactly this
-- problem for `app_setting_history.justification`: `set_config('berelax.transition_actor_kind', $1, true)`
-- in the same transaction, read back with `current_setting(..., true)`.
--
-- `set_config(..., true)` is transaction-local, so an actor cannot leak into the next statement on a
-- pooled connection — which a column on `appointment` or a session-level variable would both allow. And
-- `current_setting(..., true)` returns NULL rather than raising when unset, which is what keeps every
-- pre-existing writer working.
--
-- ## Why the columns are NULLABLE, and what enforces attribution instead
--
-- A NOT NULL on a transition row is the stricter reading and it is the wrong tool here, for a reason that
-- is specific rather than general: `set_config` is transaction-local, so making attribution mandatory
-- would make every correcting `UPDATE appointment SET status = …` from a psql session or a migration
-- **impossible** rather than merely unattributed, and it would require each of the seven existing direct
-- status updates across the schema and eligibility suites to be wrapped in an explicit transaction that
-- sets three settings first. An unattributed row is honest — nobody recorded who did it — and a refusal
-- there would push the correction outside the chain entirely, which is the one outcome worse than a null.
--
-- What enforces it for the application is `transitionAppointment`
-- (packages/db/src/repositories/appointment-transition.ts), which sets the settings, performs the update,
-- and then READS BACK the row the trigger appended, refusing with `transition_not_recorded` unless
-- exactly one row was written carrying exactly this actor, role and reason. Gate 51k removes the
-- `set_config` call and watches the pair suite fail; gate 51l removes the read-back comparison and watches it fail
-- again. A rule proven to fire is worth more than a NOT NULL nobody tried to violate (ADR 0003).
--
-- The six CHECK constraints below are the half the database can own without that cost: an attribution
-- that is HALF written is always a defect, whoever wrote it.

begin;

alter table appointment_status_history
  -- The same three columns `audit_event` (0005) and `google_connection_events` (0016) use, spelled the
  -- same way on purpose: one vocabulary for "who", so a reader joining the two does not have to map it.
  add column actor_kind  text,
  add column actor_id    uuid,
  add column actor_label text,
  -- The F07 role the permission check consulted. Text rather than an enum, and the vocabulary is
  -- restated here as a CHECK rather than being read from `packages/core`: the database cannot import the
  -- policy layer, and a role the enum does not know is worse than a duplicated list. The duplication is
  -- made safe by `packages/fixtures/src/appointment-lifecycle.itest.ts`, which parses this constraint out
  -- of pg_constraint and asserts its accepted set equals `ROLES` exactly — in both directions.
  add column actor_role  text,
  -- Why. NULL where none was given, never '' — one fact, one representation. Which transitions REQUIRE
  -- one is the transition table's declaration (`reasonRequired`): a salon cancellation and a reschedule
  -- do, a customer cancellation does not, because refusing a customer's cancellation for want of a
  -- reason turns it into a no-show.
  add column reason      text,
  add constraint appointment_status_history_actor_kind_known
    check (actor_kind is null or actor_kind in ('staff', 'customer', 'system', 'agent')),
  add constraint appointment_status_history_actor_role_known
    check (actor_role is null or actor_role in
      ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')),
  -- Half an attribution is always a defect. A row that names a role and no kind of actor, or a kind and
  -- no role, is a row somebody wrote from two places; and either way it cannot answer the question the
  -- columns exist for.
  add constraint appointment_status_history_attribution_is_whole
    check ((actor_kind is null) = (actor_role is null)),
  -- A reason with nobody attached to it is the shape of a writer that set the justification and lost the
  -- actor - which is precisely the 0036 failure, where a value was demanded of the operator, validated,
  -- and then dropped on the floor with nothing reporting it.
  add constraint appointment_status_history_reason_needs_an_actor
    check (reason is null or actor_role is not null),
  add constraint appointment_status_history_reason_nonempty
    check (reason is null or btrim(reason) <> ''),
  add constraint appointment_status_history_actor_label_nonempty
    check (actor_label is null or btrim(actor_label) <> '');

comment on column appointment_status_history.actor_kind is
  'staff | customer | system | agent, the same vocabulary as audit_event.actor_kind (0005). NULL for a '
  'row nobody attributed - a psql correction or a migration - which is honest rather than absent.';
comment on column appointment_status_history.actor_id is
  'The employee or customer id, when the actor has one. NULL for system and agent actors, which carry a '
  'label instead.';
comment on column appointment_status_history.actor_role is
  'The F07 role the permission check consulted (packages/core/src/access/permissions.ts). audit_event '
  'records the KIND of actor and never the role, and the role is what says whether the move was '
  'authorised at all.';
comment on column appointment_status_history.reason is
  'Why, as the actor stated it. Mandatory for the transitions the table declares reasonRequired - a '
  'salon cancellation and a reschedule - and NULL, never '''', otherwise.';

-- The chain is read per appointment in order, and `occurred_at, id` already serves that (0024). What is
-- new is the audit question - "every move this actor made" - which scans the whole table without this.
create index appointment_status_history_actor_idx
  on appointment_status_history (actor_id, occurred_at desc)
  where actor_id is not null;

-- ---------------------------------------------------------------------------------------------
-- The trigger, re-issued: same chain, now attributed.
-- ---------------------------------------------------------------------------------------------
-- Unchanged in every other respect, and deliberately so. It still fires AFTER, so a row that fails a
-- constraint leaves no history; it still judges nothing, because which transitions are legal is
-- B-LIFE-01's transition table in packages/core and not a trigger (0024's own comment, and the reason
-- the table can be enumerated by a test at all); and it still writes on INSERT with `from_status` NULL,
-- because a creation is not a transition.
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
  -- Empty-string-normalised, exactly as 0036 does it: `set_config` cannot store SQL NULL, so a caller
  -- with nothing to say sets '' and that must not be recorded as an actor somebody named.
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
  end if;
  return null;
end $$;

comment on function record_appointment_status() is
  'Appends the transition chain, taking the actor, role and reason from the transaction-local '
  'berelax.transition_* settings (0046, the mechanism 0036 uses for the settings justification). AFTER, '
  'so a row that fails a constraint leaves no history; and it judges nothing - which transitions are '
  'legal is B-LIFE-01''s transition table in packages/core, not a trigger.';

-- 0009's default privileges grant the application role select, insert, update and delete on every table
-- created in `public` afterwards, and 0024 revoked update, delete and truncate on this table. A column
-- added later inherits the table's grants, so there is nothing to re-grant - said here rather than
-- relied upon, because "inherits" and "we checked" are different facts. Re-stated anyway, because a
-- managed database restored from a dump does not necessarily carry the same defaults.
grant select, insert on appointment_status_history to berelax_app;
revoke update, delete, truncate on appointment_status_history from berelax_app;

commit;

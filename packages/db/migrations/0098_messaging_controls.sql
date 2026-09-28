-- 0098 — the marketing kill switch has ONE home, and no control row can ever name transactional traffic.
--
-- C-AUTO-05. The unit's acceptance line is structural rather than behavioural: the switch *"stops every
-- promotional send and structurally cannot touch transactional traffic"*. A switch that merely checks a flag
-- before promotional sends is one edit away from stopping booking confirmations, so the separation has to be
-- something the storage layer refuses rather than something a reviewer notices.
--
-- ## Why a table and not an `app_setting` row
--
-- `app_setting` holds business CONFIGURATION with a bounded change rule — the promotional window is the
-- example one migration back (0087), narrowable inside 07:00-21:00 and nothing else. The kill switch is not
-- that. It is an operator stopping a running thing now, and this schema already draws exactly that
-- distinction: `agent_definition` carries both `enabled` and `kill_switch`, and its own comment says why —
-- *"`enabled` is configuration — this agent is part of the product. `kill_switch` is an operator stopping a
-- running thing now: a disabled agent is silent by design, a killed one is an incident, and the two want
-- different audit stories."*
--
-- Three consequences follow, and each is a column here that `app_setting` could not carry honestly:
--
--   * a toggle has a DIRECTION and a REASON, and both belong on the row a screen reads, not only in the
--     append-only history behind it;
--   * the tier system would have to classify it, and both available answers are wrong: `compliance_locked`
--     means owner-only (`assertRoleMayEdit`), which would stop the floor manager engaging the switch at
--     22:00, and `operational` would put "stop all marketing" in the same tier as a turnaround time;
--   * the second control this table holds — the promotional sender ID being suspended by TDRA — is not a
--     setting in any reading. Nobody CONFIGURES a suspension. It is a fact about the vendor's registration
--     that staff have to be shown.
--
-- ## The four refusals, and which layer each one is the only layer for
--
-- Same division of labour as 0080's frequency cap and 0087's window: ONE predicate function called from a
-- CHECK and from a trigger. The trigger is what gives a human a sentence they can act on; the CHECK is the
-- layer that still holds when `session_replication_role = 'replica'` has triggers off, which is how a
-- restore from a dump runs.
--
--   * **`ZY081` — the control key is not one of the two.** Deny-by-default fails in the WRONG DIRECTION for
--     this table: a missing row reads as "not engaged", so a misspelled `marketing_killswitch` inserted at
--     02:00 is a kill switch that a screen shows as engaged and the gate never reads. And the closed set is
--     the storage half of "cannot touch transactional traffic": there is deliberately no key naming
--     transactional traffic, and this refusal is what makes one unstorable rather than merely absent.
--   * **`ZY082` — the acting role may not toggle.** Owner and manager may; receptionist, marketer,
--     therapist, accountant, auditor and `system` may not. `assertCan(role, 'settings:write')` in
--     `@berelax/core` is the refusal a person sees, and it is correct; this is the one that holds for a
--     `psql` session, a seed, and an import of another environment's rows.
--   * **`ZY083` — the reason is blank.** A toggle with no reason is a switch nobody can explain the next
--     morning, and `''` is how a required field arrives from a form that did not require it. Refused by
--     SHAPE before anything else, so the message says "this has no reason" rather than naming a role.
--   * **`ZY084` — the row was DELETEd.** This is the subtle one and it is why DELETE is refused rather than
--     merely discouraged. `delete from messaging_control where control_key = 'marketing_kill_switch'` is a
--     DISENGAGEMENT: the row is gone, the reader finds nothing, nothing is engaged, and there is no
--     direction, actor or reason anywhere because no UPDATE happened. Every other way of disengaging writes
--     an audit row. This one would not, so it is not available.
--
-- `ZY081`-`ZY084` rather than a mnemonic class, and NOT one code for four rules. The class no longer
-- identifies a file — `ZA` through `ZZ` are all in use, and four migrations claimed `ZY001` on one day
-- because units in separate worktrees each reasoned correctly from the migrations they could see. A refusal
-- is identified by all five characters, a unit takes a subclass RANGE, and this file's allocated range is
-- `ZY081`-`ZY090`. Four codes because each has a different runbook answer, which is 0061's argument for
-- having a private code at all: `ZY081` is "fix the key", `ZY082` is "fetch somebody who may", `ZY083` is
-- "say why", `ZY084` is "disengage it properly so the audit row exists".
--
-- ## Why both rows are seeded here, disengaged
--
-- A reader that has to cope with a missing row is a reader with a default written into it, and a default in
-- the reader is a second statement of the switch's state (brief: a second statement of a fact drifts). Both
-- rows exist from this migration onwards, and the only question a caller ever asks is `engaged`.
--
-- Seeded DISENGAGED in every environment, including the non-production ones the provisional answer says must
-- behave as engaged. That is deliberate and it is not a contradiction: "engaged outside production" is a
-- property of the ENVIRONMENT, resolved by `resolveMarketingKillSwitch` in `@berelax/messaging` from
-- `APP_ENV`, which SQL cannot read. Seeding `true` on staging would make the row disagree with production's
-- row for a reason no column explains, and would let somebody disengage it with a legitimate-looking UPDATE.
-- The stored row is the OPERATOR's decision; the environment's answer is applied on top of it and cannot be
-- switched off by a row at all.
--
-- `changed_by` is a label rather than a `staff_credential` reference, for 0075's reason restated: the actor
-- on an audit row is text, and a foreign key here would mean a control row could not record a toggle made
-- by an operator whose credential was later removed — which is precisely the row somebody wants to read.

begin;

-- ---------------------------------------------------------------------------------------------
-- The predicate
-- ---------------------------------------------------------------------------------------------
-- `case` rather than `and`, which is 0080's finding and 0087's restatement of it: SQL does not guarantee the
-- evaluation order of `and`, so a shape test and a value test in one expression can evaluate in either order.
--
-- NOT strict, for `is_placeholder_text`'s reason: a strict function returns NULL for NULL, and a CHECK whose
-- expression is NULL is SATISFIED — so a strict version would accept every NULL it exists to refuse.
create function messaging_control_is_promotional_only(p_control_key text) returns boolean
language sql
immutable
as $$
  select case
           when p_control_key is null then false
           else p_control_key in ('marketing_kill_switch', 'promotional_sender_suspended')
         end;
$$;

comment on function messaging_control_is_promotional_only(text) is
  'True only for the two promotional operator controls. There is deliberately no key naming transactional '
  'traffic: a control row that could name it would be one UPDATE away from stopping booking confirmations '
  'and OTPs, which is the outage two registered sender identities exist to remove (ADR 0016). NOT strict: a '
  'strict function returns NULL for NULL and a CHECK whose expression is NULL is satisfied.';

create function messaging_control_role_may_toggle(p_role text) returns boolean
language sql
immutable
as $$
  select case
           when p_role is null then false
           -- Owner and manager, and no others. The floor manager has to be able to stop marketing at 22:00
           -- without fetching the proprietor; a marketer must not be able to un-stop their own campaign,
           -- and a receptionist has no marketing role at all. This is the same answer `settings:write`
           -- gives in `@berelax/core`, restated where SQL can read it — the two are held equal
           -- behaviourally by gate case 126d, which drives this function with the role matrix's own answer.
           else p_role in ('owner', 'manager')
         end;
$$;

comment on function messaging_control_role_may_toggle(text) is
  'True only for owner and manager, the two roles that hold settings:write in @berelax/core. The refusal a '
  'person sees is assertCan() in TypeScript; this is the layer that holds for a psql session, a seed and an '
  'import of another environment''s rows. NOT strict, for the reason above.';

-- ---------------------------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------------------------
create table messaging_control (
  control_key text primary key,
  engaged boolean not null,
  -- Not nullable, and no DEFAULT. A control row with no recorded change is a control row whose state
  -- nobody accounted for, and the seed below supplies all four for the initial disengaged state.
  changed_at timestamptz not null,
  changed_by text not null,
  changed_by_role text not null,
  reason text not null,
  /*
    Which way the row was last moved.

    Derivable from `engaged` today — engaged means the last direction was `engage` — and stored anyway,
    because the pair is what a screen renders and what the audit row must agree with. The CHECK below ties
    them together, so the redundancy cannot drift into a row saying "disengaged by an engage".
  */
  direction text not null,
  constraint messaging_control_key_is_promotional_only
    check (messaging_control_is_promotional_only(control_key)),
  constraint messaging_control_role_may_toggle
    check (messaging_control_role_may_toggle(changed_by_role)),
  -- Blank-hostile rather than merely NOT NULL: `''` is how a required field arrives from a form that did
  -- not require it, and `btrim` catches the single space somebody types to get past the validation.
  constraint messaging_control_reason_is_stated check (btrim(reason) <> ''),
  constraint messaging_control_changed_by_is_stated check (btrim(changed_by) <> ''),
  constraint messaging_control_direction_matches_state
    check (direction = case when engaged then 'engage' else 'disengage' end)
);

comment on table messaging_control is
  'The operator controls that stop PROMOTIONAL traffic, one row per control, with who moved it, which way '
  'and why. The ONE home of the marketing kill switch''s state: the gate takes it as an argument and the '
  'worker reads it from here, so neither holds a copy. There is deliberately no row for transactional '
  'traffic and messaging_control_key_is_promotional_only makes one unstorable.';
comment on column messaging_control.engaged is
  'True when this control is stopping promotional sends. The OPERATOR''s decision only: the provisional rule '
  'that the kill switch is engaged in every non-production environment is a property of APP_ENV, applied by '
  'resolveMarketingKillSwitch in @berelax/messaging, and is not stored here because no row may switch it off.';
comment on column messaging_control.changed_by_role is
  'The role that made the change, refused unless it may toggle. Stored as well as checked because the '
  'question a reader asks six weeks later is who, not whether.';
comment on column messaging_control.reason is
  'Why. Required and blank-hostile: a toggle nobody can explain the next morning is the state this column '
  'exists to make unstorable.';

-- "Which controls are engaged" is the banner's read and is asked on every admin page load.
create index messaging_control_engaged_idx on messaging_control (control_key) where engaged;

-- ---------------------------------------------------------------------------------------------
-- The trigger, which says the same thing in a sentence
-- ---------------------------------------------------------------------------------------------
-- The CHECKs above hold under a restore. This exists for the person: a `23514` naming
-- `messaging_control_role_may_toggle` says a constraint was violated, and what somebody at 02:00 needs to
-- read is which role they used, which roles may, and where the audited path is.
--
-- The SHAPE refusals come first and the role refusal last, deliberately: a row with a blank reason AND a
-- refused role should report the reason, because "this has no reason" is actionable by the person holding
-- the keyboard and "not you" sends them to find somebody else for a change they have not finished writing.
create function refuse_messaging_control_change() returns trigger
language plpgsql
as $$
begin
  if not messaging_control_is_promotional_only(new.control_key) then
    raise exception
      'ZY081: ''%'' is not a messaging control. The two are marketing_kill_switch and '
      'promotional_sender_suspended. A key outside that set is worse than a missing row, because a missing '
      'row reads as "not engaged" — so a misspelled key is a switch a screen shows as engaged and the gate '
      'never reads. There is deliberately NO control naming transactional traffic: booking confirmations '
      'and OTPs must not be stoppable by a marketing decision (ADR 0016).',
      new.control_key
      using errcode = 'ZY081';
  end if;
  if btrim(coalesce(new.reason, '')) = '' then
    raise exception
      'ZY083: a messaging control may not be toggled without a reason. ''%'' was moved to engaged=% with a '
      'blank one. The reason is what the next person reads before deciding whether the switch can come back '
      'off, and an empty string is how a required field arrives from a form that did not require it.',
      new.control_key, new.engaged
      using errcode = 'ZY083';
  end if;
  if not messaging_control_role_may_toggle(new.changed_by_role) then
    raise exception
      'ZY082: role ''%'' may not toggle the messaging control ''%''. Owner and manager may — they are the '
      'two that hold settings:write — and nobody else does: a marketer must not be able to un-stop their '
      'own campaign, and a receptionist has no marketing role at all. Go through '
      'toggleMessagingControl(), which writes the audit_event in the same transaction.',
      new.changed_by_role, new.control_key
      using errcode = 'ZY082';
  end if;
  return new;
end $$;

comment on function refuse_messaging_control_change() is
  'Raises ZY081 for a control key outside the closed set, ZY083 for a blank reason and ZY082 for a role '
  'that may not toggle. The CHECK constraints beside it hold the same three rules under a restore with '
  'triggers off; this exists for the sentence a human reads.';

create trigger messaging_control_is_answerable_on_insert before insert on messaging_control
  for each row execute function refuse_messaging_control_change();
create trigger messaging_control_is_answerable_on_update before update on messaging_control
  for each row execute function refuse_messaging_control_change();

-- ---------------------------------------------------------------------------------------------
-- A control row cannot be deleted
-- ---------------------------------------------------------------------------------------------
-- See the header. A DELETE of the kill switch row is a disengagement with no direction, no actor and no
-- reason, because no UPDATE happened for an audit row to hang off.
create function refuse_messaging_control_delete() returns trigger
language plpgsql
as $$
begin
  raise exception
    'ZY084: the messaging control ''%'' may not be DELETEd. Removing the row is a DISENGAGEMENT that writes '
    'no audit event: the reader finds nothing, nothing is engaged, and there is no direction, actor or '
    'reason anywhere. Disengage it with an UPDATE through toggleMessagingControl(), which records who and '
    'why in the same transaction.',
    old.control_key
    using errcode = 'ZY084';
end $$;

comment on function refuse_messaging_control_delete() is
  'Raises ZY084 for any DELETE on messaging_control. The row is the switch; removing it is an unaudited '
  'disengagement.';

create trigger messaging_control_is_undeletable before delete on messaging_control
  for each row execute function refuse_messaging_control_delete();

-- ---------------------------------------------------------------------------------------------
-- The two rows
-- ---------------------------------------------------------------------------------------------
-- Both, disengaged, from this migration onwards, so no reader needs a default for a missing row — and
-- `owner` as the actor because a migration is the proprietor's own act, which is how 0010 records the
-- settings it seeds. The reason is the honest one: nothing has been engaged.
insert into messaging_control (control_key, engaged, changed_at, changed_by, changed_by_role, reason, direction)
values
  ('marketing_kill_switch', false, now(), 'migration 0098', 'owner',
   'Seeded disengaged. Promotional sending has never been stopped in this deployment.', 'disengage'),
  ('promotional_sender_suspended', false, now(), 'migration 0098', 'owner',
   'Seeded disengaged. The promotional sender ID has never been recorded as suspended.', 'disengage');

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards, so this table arrives with all four and the revokes are load-bearing. The door is held twice,
-- 0072's and 0078's arrangement: the trigger refuses for every role, and the grant refuses before a trigger
-- is reached.
--
-- The table-level REVOKE has to come FIRST: a column-list grant does not narrow an existing table-level
-- one, and leaving the revoke out cost 0076 a whole run.
revoke insert, delete, truncate on messaging_control from berelax_app;
-- UPDATE stays, because toggling IS an update. INSERT does not: the two rows exist and a third is not a
-- control, so the only reason to insert here is to invent one.

commit;

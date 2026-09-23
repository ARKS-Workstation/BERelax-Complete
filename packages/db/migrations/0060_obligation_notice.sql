-- 0060 — the compliance calendar's notices: multi-step reminders, escalation to a named role, the
-- acknowledgement that stops escalating, and the expiring grant that serves a private evidence file.
--
-- docs/04 §9 asks for dated instances "with multi-step reminders, escalation if unacknowledged, and
-- evidence attachment". 0052 built the dated instances and left three things to this migration, each
-- recorded in that unit's own NOTE: the (instance, step) idempotency key, the escalation interval, and
-- serving `obligation_evidence` privately with every download audited.
--
-- ## The mechanism is 0051's, restated, and deliberately not a second one
--
-- A reminder about a deadline that has moved is the same bug as a reminder about an appointment that has
-- moved, and 0051 already answered it: the schedule is a ROW, the queue carries the row's id and nothing
-- else, every row carries an `invalidation_key` derived from the state it is about, and the worker
-- re-derives that key under the row's lock at the moment of sending. Every structural decision below is
-- that file's, for that file's reasons:
--
--   * `pending` is the only non-terminal state and leaving it is a ONE-WAY DOOR
--     (`refuse_obligation_notice_resurrection`), so a settled notice never comes back;
--   * every terminal state carries `settled_at`, which is what makes "no notice ends in a silent
--     unrecorded state" a thing the database refuses rather than a thing a test looks for;
--   * `skipped_reason` is a CLOSED set, because it is what a report groups by;
--   * there is no `body`, `recipient` or `template_id` column: all three are resolved at send time.
--
-- What differs, and why:
--
--   1. **`notify_on` is a `date`, not a `timestamptz`.** An obligation falls due at the END of a day and
--      `obligation_instance.due_on` is a date (0052). Whether a notice has arrived is therefore decided
--      against the TRADING date, the same unit "overdue" is decided in — trading runs 11:00–02:00, so at
--      01:30 the business is still working the previous trading date. A notice timed to the minute would
--      need a zone at every comparison and would buy nothing: the pass that sends it runs once a day.
--   2. **Two partial unique indexes, not one.** 0051 allows one PENDING step per (appointment, step type)
--      and lets a superseded pair repeat, because a reschedule legitimately re-derives an old key. Here
--      the acceptance criterion is stronger and explicit — "each declared reminder offset fires exactly
--      one message per instance and never twice, enforced by idempotency on (instance, step)" — so there
--      is a second partial unique index on `state = 'sent'`. One live notice per step, and at most one
--      SENT notice per step for ever. A moved due date supersedes the pending row and inserts a fresh one
--      with the new key; if the first had already been sent, the second cannot be, which is the
--      idempotency the criterion asks for expressed as a constraint rather than as a convention in the
--      writer.
--   3. **`to_role` is NOT NULL and CHECKed against the F07 vocabulary.** An escalation nobody is
--      accountable for is decoration, and a notice addressed to nobody is the purest form of it. The
--      trigger below goes further: a REMINDER must name the duty's declared owner (or the owner), and an
--      ESCALATION must name somebody else. Which somebody is `escalationRoleFor` in `@berelax/core`; that
--      it is not the same role is the half SQL can make, and it is the half that catches an escalation
--      ladder that has quietly collapsed onto its own first rung.
--
-- ## Acknowledgement is a column on the OCCURRENCE, not a state on the notice
--
-- Because it is a fact about the duty and not about one message. Recorded on the notice, an
-- acknowledgement would stop only the rung it was recorded against, so the second escalation would fire
-- at 21 days about a duty somebody picked up on day eight — which is the false alarm this unit exists not
-- to produce. It is also why acknowledgement stops ESCALATION and not reminders: a reminder is "this
-- falls due on the 14th" and stays true however many people have read it, and letting one click at 60
-- days silence the notice at 7 would silence the notice that matters.
--
-- ## Evidence is served through an expiring GRANT, and every download is audited
--
-- 0052's `obligation_evidence` holds a private-bucket storage key and a content hash and nothing has ever
-- read it back over HTTP. M-TILL-12's NOTE records the reason: nothing in this repository can sign a URL —
-- `MediaStorage` (packages/media/src/storage/port.ts) exposes put, head, get and list and no signing —
-- and it asks whichever unit lands first to own the capability rather than build a second one.
--
-- This is that capability, and it is a stored grant rather than an HMAC over the URL. Three reasons, in
-- order of weight: a stored grant needs no new signing secret, so the key-rotation inventory does not
-- grow a fourth entry for a link that lives fifteen minutes; it is revocable, because a grant that should
-- never have been minted is a DELETE and a signature is not; and the row records who asked for the link,
-- which is the question an inspection asks about a hygiene report that left the building. Only the
-- sha256 of the token is stored, exactly as `repositories/otp.ts` stores a code: a grant table that held
-- its own tokens would be a table that grants access to every evidence file in the business.
--
-- The grant is the ONLY gate today and that is stated rather than implied: there is no admin session
-- until W-SYS-01, exactly as `/hr/credentials` and the two Google routes record next door.

begin;

-- ---------------------------------------------------------------------------------------------
-- Acknowledgement, on the occurrence
-- ---------------------------------------------------------------------------------------------
-- Expand-only over 0052. `refuse_obligation_shape_change()` guards `obligation`, the DEFINITION, and not
-- `obligation_instance`, so these columns need no exemption from it — which is worth stating, because the
-- obvious worry on reading 0052 is that any new column on either table is refused.
alter table obligation_instance
  add column acknowledged_at       timestamptz,
  add column acknowledged_by_role  text
    constraint obligation_instance_acknowledged_by_role_known
    check (acknowledged_by_role is null or acknowledged_by_role in
      ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')),
  add column acknowledged_by_label text
    constraint obligation_instance_acknowledged_by_label_nonempty
    check (acknowledged_by_label is null or btrim(acknowledged_by_label) <> ''),
  -- All three or none. An acknowledgement with no actor is a compliance control that stops escalating
  -- because somebody unknown clicked something, which is the shape of an off switch.
  add constraint obligation_instance_acknowledgement_is_whole
    check ((acknowledged_at is null) = (acknowledged_by_role is null)
       and (acknowledged_at is null) = (acknowledged_by_label is null));

comment on column obligation_instance.acknowledged_at is
  'When somebody took responsibility for this occurrence. Stops ESCALATION and deliberately not the '
  'reminders: a reminder stays true however many people have read it, and an acknowledgement at 60 days '
  'must not silence the notice at 7.';

create index obligation_instance_unacknowledged_idx
  on obligation_instance (due_on)
  where status = 'open' and acknowledged_at is null;

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
create type obligation_notice_kind as enum ('reminder', 'escalation');

comment on type obligation_notice_kind is
  'reminder is addressed to the duty''s declared owner BEFORE the due date; escalation is addressed to '
  'the role above it AFTER an unacknowledged one. Two kinds and not one, because acknowledgement stops '
  'the second and must not stop the first.';

-- Four states. 0051 has five: `cancelled` is absent here because an obligation occurrence is never
-- cancelled — `obligation_instance_status` is open or completed — and a completed one is recorded as a
-- SKIP with its own reason, so "how many notices did we not send because the renewal was already filed"
-- stays answerable. A fifth state meaning the same thing would make that count depend on which writer
-- reached the row first.
create type obligation_notice_state as enum ('pending', 'sent', 'skipped', 'superseded');

-- ---------------------------------------------------------------------------------------------
-- obligation_notice
-- ---------------------------------------------------------------------------------------------
create table obligation_notice (
  id                     uuid                    primary key default uuid_generate_v7(),

  -- CASCADE, and for 0051's reason rather than by symmetry. A pending notice is an INTENTION about an
  -- occurrence, and 0052 deliberately keeps DELETE granted on `obligation_instance` so the generator may
  -- withdraw a future occurrence whose horizon changed; a RESTRICT here would make that withdrawal
  -- impossible the moment a notice existed. What a SENT notice leaves behind is the `message` row, which
  -- is referenced RESTRICT below and is the evidence somebody was told.
  obligation_instance_id uuid                    not null
                           references obligation_instance (id) on delete cascade,

  kind                   obligation_notice_kind  not null,

  -- `reminder_60d`, `escalation_7d`. Bounded by pattern rather than by an enum, for 0051's reason: both
  -- ladders are SETTINGS, so changing the timing must not be a migration — and the acceptance criterion
  -- that a timing change produces NEW KEYS only holds because the label is inside the key.
  step                   text                    not null,

  -- The F07 role this notice names. A notice nobody is accountable for is decoration, so this is NOT
  -- NULL; the CHECK restates the F07 vocabulary exactly as `obligation.owner_role` does, and for the same
  -- reason — the database cannot import the policy layer, and a role the list does not know is worse than
  -- a duplicated list. The duplication is kept honest by the itest, which parses the accepted set out of
  -- pg_constraint and compares it with ROLES in both directions.
  to_role                text                    not null
                           constraint obligation_notice_to_role_known
                           check (to_role in
                             ('owner', 'manager', 'accountant', 'receptionist', 'therapist',
                              'marketer', 'auditor', 'system')),

  -- The deterministic function of (step, instance, due date). Not unique, deliberately: two different
  -- occurrences of one obligation may carry the same step label, and the key answers only "is this notice
  -- still about the occurrence's current deadline?".
  invalidation_key       text                    not null,

  -- The DATE the notice falls due. A date and not an instant: see the header.
  notify_on              date                    not null,

  state                  obligation_notice_state not null default 'pending',

  -- The message the send produced. RESTRICT because it is the evidence the notice was honoured, and
  -- UNIQUE because two notices claiming one message would make "was this escalation sent" unanswerable.
  message_id             uuid                    references message (id) on delete restrict,

  -- Set when the notice went out later than its own notify date: a worker outage, a long deploy, an
  -- occurrence entered after the notice date had already passed.
  staleness_note         text
                           constraint obligation_notice_staleness_note_nonempty
                           check (staleness_note is null or btrim(staleness_note) <> ''),

  -- Why it was not sent. A CLOSED set: OBLIGATION_NOTICE_SKIP_REASONS in packages/core is the same list.
  skipped_reason         text
                           constraint obligation_notice_skipped_reason_known
                           check (skipped_reason in (
                             'invalidation_key_stale',
                             'obligation_completed',
                             -- What acknowledgement does. An escalation exists to say nobody has picked
                             -- this up, and an acknowledgement makes that false.
                             'obligation_acknowledged',
                             'notice_window_missed',
                             -- No contact detail on file for the role. The honest shipped state: no table
                             -- in this build holds a staff phone number, and a plausible UAE mobile would
                             -- be indistinguishable from a configured one.
                             'no_recipient_on_file',
                             'content_unavailable',
                             -- Built, and the choke point did not hand it to a vendor: a gate refusal or
                             -- F03's staging guard. Neither writes a message row, and the second is the
                             -- ORDINARY case on a staging worker.
                             'send_refused')),

  -- The instant the worker decided. This column is the whole of "no notice ends in a silent unrecorded
  -- state": a row that left `pending` without one is not storable.
  settled_at             timestamptz,
  created_at             timestamptz             not null default now(),
  updated_at             timestamptz             not null default now(),

  -- The ladders are settings; the bound is the registry's own (1 to 365 days), restated because the
  -- database cannot import the registry and a `reminder_9999d` row would put a renewal notice in the
  -- calendar twenty-seven years before the renewal.
  constraint obligation_notice_step_is_a_declared_rung check (
    step ~ '^(reminder|escalation)_[1-9][0-9]{0,2}d$'
    and (regexp_replace(step, '^(reminder|escalation)_([0-9]+)d$', '\2'))::integer between 1 and 365
  ),
  -- The label and the kind are one fact written twice, which is only safe if they cannot disagree: a
  -- notice whose kind says escalation and whose step says `reminder_7d` would be counted one way by the
  -- report and addressed the other way by the sender.
  constraint obligation_notice_step_matches_its_kind check (
    step like kind::text || '\_%'
  ),
  constraint obligation_notice_invalidation_key_nonempty check (btrim(invalidation_key) <> ''),

  -- A pending notice has decided nothing.
  constraint obligation_notice_pending_has_settled_nothing check (
    state <> 'pending'
    or (settled_at is null and message_id is null and skipped_reason is null
        and staleness_note is null)
  ),
  -- And the other half: every terminal state records WHEN it was reached.
  constraint obligation_notice_terminal_is_settled check (
    state = 'pending' or settled_at is not null
  ),
  constraint obligation_notice_sent_carries_its_message check (
    (state = 'sent') = (message_id is not null)
  ),
  constraint obligation_notice_skipped_carries_a_reason check (
    (state = 'skipped') = (skipped_reason is not null)
  ),
  -- Lateness is a property of a send. A superseded notice was never late; it was replaced.
  constraint obligation_notice_staleness_is_about_a_send check (
    staleness_note is null or state = 'sent'
  ),
  constraint obligation_notice_message_claimed_once unique (message_id)
);

comment on table obligation_notice is
  'One reminder or escalation about one obligation occurrence, as a ROW. The queue carries this row''s id '
  'and nothing else; the recipient, the template and the body are resolved when it is sent, against the '
  'occurrence as it is then (the mechanism migration 0051 established for appointment reminders).';
comment on column obligation_notice.invalidation_key is
  'A deterministic function of (step, occurrence id, due date). The worker re-derives it from the '
  'occurrence''s CURRENT due date and refuses any notice whose stored key disagrees. The occurrence''s '
  'STATUS is deliberately absent: a completed duty is a skip reason, because "already filed" and "the '
  'date moved" are different answers a report has to be able to separate.';
comment on column obligation_notice.to_role is
  'The F07 role the notice names. NOT NULL and CHECKed, because an escalation nobody is accountable for '
  'is decoration. A reminder names the duty''s declared owner; an escalation must name somebody else.';

-- One LIVE notice per (occurrence, step). Partial, because a terminal row is allowed to repeat the pair:
-- a moved due date supersedes the pending notice and a fresh one is inserted with the new key.
create unique index obligation_notice_one_pending_per_step
  on obligation_notice (obligation_instance_id, step)
  where state = 'pending';

-- At most one SENT notice per (occurrence, step), for ever. THIS is the idempotency the acceptance
-- criterion names: "each declared reminder offset fires exactly one message per instance and never
-- twice". Repeated job runs are then harmless by construction rather than by the sweep being careful,
-- which is what makes the claim survive a reclaimed job, a double enqueue and a manual re-run.
create unique index obligation_notice_one_send_per_step
  on obligation_notice (obligation_instance_id, step)
  where state = 'sent';

-- The due sweep: pending notices whose date has arrived. Partial on the same predicate, because a settled
-- notice is never due again.
create index obligation_notice_due_idx on obligation_notice (notify_on) where state = 'pending';
create index obligation_notice_instance_idx on obligation_notice (obligation_instance_id, step);

create trigger obligation_notice_updated_at before update on obligation_notice
  for each row execute function set_updated_at();

/*
  Leaving `pending` is a ONE-WAY DOOR.

  0051's rule, restated for the same reason: the application moves the schedule forward by inserting a new
  row, and this is the half that holds when somebody reaches past the application — a sweep, a migration,
  a psql session at 2am. Stated as "the OLD state must be pending" rather than as a list of permitted
  pairs, because that is the whole of it: `pending -> anything` is the worker settling a notice, and every
  other transition is a settled notice being re-opened so it can fire again.
*/
create function refuse_obligation_notice_resurrection() returns trigger
language plpgsql as $$
begin
  if new.state is distinct from old.state and old.state <> 'pending' then
    raise exception
      'obligation_notice_must_not_be_resurrected: % -> % on notice %. A notice that has been sent, '
      'skipped or superseded is settled; the calendar moves forward by inserting a new row.',
      old.state, new.state, old.id
      using errcode = 'ZN002';
  end if;
  return new;
end;
$$;

comment on function refuse_obligation_notice_resurrection() is
  'Raises ZN002 for every role. Without it, re-opening a sent notice would defeat '
  'obligation_notice_one_send_per_step, which is partial on state = ''sent''.';

create trigger obligation_notice_must_not_be_resurrected
  before update of state on obligation_notice
  for each row execute function refuse_obligation_notice_resurrection();

/*
  A notice must name a role that could act on it.

  This is the trap this unit is judged on, in the database. A reminder is addressed to the duty's declared
  owner — the role 0052's completion trigger already requires to sign the occurrence off — and an
  escalation must be addressed to somebody ELSE, because a notice sent to the same role twice is not an
  escalation, it is the noise that trains whoever reads it to ignore the first one.

  The ladder itself is `OBLIGATION_ESCALATION_LADDER` in `@berelax/core`: which role sits above which
  follows from ROLE_DEFINITIONS, and the database cannot read that. "It is not the same role" is the half
  SQL can make, and it is the half that catches a ladder that has quietly collapsed onto its own first
  rung — which is what a `?? ownerRole` fallback produces, and it looks correct in review.

  A trigger and not a CHECK because it joins: the declared owner is a column on `obligation`, two tables
  away. BEFORE INSERT OR UPDATE OF, so a writer cannot re-address a notice after the fact either.
*/
create function assert_obligation_notice_names_an_accountable_role() returns trigger
language plpgsql as $$
declare
  v_key   text;
  v_owner text;
begin
  select o.key, o.owner_role
    into v_key, v_owner
    from obligation_instance i
    join obligation o on o.id = i.obligation_id
   where i.id = new.obligation_instance_id;

  if new.kind = 'reminder' and new.to_role <> v_owner and new.to_role <> 'owner' then
    raise exception
      'ObligationNoticeMisaddressed: "%" is owed by the % and a reminder about it was addressed to %. '
      'The declared owner is part of the obligation, not a label on it.',
      v_key, v_owner, new.to_role
      using errcode = 'ZN001',
            hint = 'Address a reminder to the declared owner role, or to the owner.';
  end if;

  if new.kind = 'escalation' and new.to_role = v_owner then
    raise exception
      'ObligationEscalationGoesNowhere: "%" is owed by the % and the escalation was addressed to the '
      'same role. An escalation to the role that already has the reminders is decoration: nobody new '
      'is accountable, and the second message trains the first one''s reader to ignore both.',
      v_key, v_owner
      using errcode = 'ZN001',
            hint = 'escalationRoleFor() in @berelax/core gives the role above this one, or null when '
                   'there is none — and null means no escalation is planned, not one addressed to '
                   'whoever is left.';
  end if;

  return new;
end $$;

comment on function assert_obligation_notice_names_an_accountable_role() is
  'Raises ZN001 for every role. A reminder must name the declared owner (or the owner); an escalation '
  'must name somebody else. WHICH somebody is the ladder in @berelax/core; that it is not the same role '
  'is the half SQL can make.';

create trigger obligation_notice_names_an_accountable_role
  before insert or update of to_role, kind on obligation_notice
  for each row execute function assert_obligation_notice_names_an_accountable_role();

-- ---------------------------------------------------------------------------------------------
-- obligation_evidence_grant — a private evidence file, served for fifteen minutes
-- ---------------------------------------------------------------------------------------------
create table obligation_evidence_grant (
  id                     uuid        primary key default uuid_generate_v7(),
  -- RESTRICT, unlike the notice's cascade. Evidence is append-only (ZO004) and cannot be deleted at all,
  -- so this is a statement about intent rather than a reachable path: the grant is a record that somebody
  -- was given a link to a specific filed document, and it outlives the link.
  obligation_evidence_id uuid        not null
                           references obligation_evidence (id) on delete restrict,

  -- The sha256 of the token, hex, never the token. A grant table that held its own tokens would be a
  -- table that grants access to every evidence file in the business — the reason repositories/otp.ts
  -- stores a digest of a six-digit code rather than the code.
  token_sha256           text        not null unique
                           constraint obligation_evidence_grant_token_shape
                           check (token_sha256 ~ '^[a-f0-9]{64}$'),

  expires_at             timestamptz not null,

  -- Who the link was minted for. A role and a label, never a person's name: nineteen of these people
  -- have no name recorded and this is not the table where somebody types one in (ADR 0020).
  issued_to_role         text        not null
                           constraint obligation_evidence_grant_role_known
                           check (issued_to_role in
                             ('owner', 'manager', 'accountant', 'receptionist', 'therapist',
                              'marketer', 'auditor', 'system')),
  issued_to_label        text        not null
                           constraint obligation_evidence_grant_label_nonempty
                           check (btrim(issued_to_label) <> ''),
  -- Why. The audit row carries it too; it is here as well so a grant that outlives the audit partition
  -- still says what it was for.
  purpose                text        not null
                           constraint obligation_evidence_grant_purpose_not_placeholder
                           check (not is_placeholder_text(purpose)),

  created_at             timestamptz not null default now(),

  -- A grant that has already expired when it is written is one nobody can use, and it would read on the
  -- screen as a link that is simply broken.
  constraint obligation_evidence_grant_expires_after_issue check (expires_at > created_at)
);

comment on table obligation_evidence_grant is
  'An expiring capability to download one filed evidence file. The bytes are in the private bucket and '
  'the route refuses a request with no valid grant with 403; every download writes an audit_event. A '
  'stored grant rather than an HMAC over the URL: no new signing secret, revocable by DELETE, and the row '
  'records who asked for the link — which is what an inspection asks about a hygiene report that left '
  'the building.';

create index obligation_evidence_grant_evidence_idx
  on obligation_evidence_grant (obligation_evidence_id, expires_at desc);

-- ---------------------------------------------------------------------------------------------
-- The agent this unit's cron reports to
-- ---------------------------------------------------------------------------------------------
-- G-AGT-01's registry-completeness gate enumerates `cronRegistrations()` and fails naming any cron with
-- no `agent_definition` row, so a scheduled job without one is refused by the build.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('compliance_calendar', 'Compliance calendar',
   'Generates the next twelve months of obligation occurrences, plans their reminders and escalations, '
   'and hands every notice whose date has arrived to the sender (M-VAT-11, docs/04 §9).',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with no heartbeat row does not
-- appear in the watchdog's list at all — and an agent that does not appear is one the watchdog silently
-- never checks, which is worse than unwatched because the completeness check reports it present.
insert into agent_heartbeat (agent_key) values ('compliance_calendar')
on conflict (agent_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on every table created
-- in public afterwards, so these revokes are load-bearing rather than decorative.
--
-- No DELETE on `obligation_notice`: a settled notice is the record of what the system told whom about a
-- statutory deadline, and the one legitimate removal — a withdrawn future occurrence — happens through
-- the CASCADE, which is performed as the table owner.
revoke delete, truncate on obligation_notice from berelax_app;
-- DELETE stays granted on the grant table, and that is the revocation path: a link that should never have
-- been minted is removed, and the audit row for the minting remains because audit_event is append-only.
revoke truncate on obligation_evidence_grant from berelax_app;

commit;

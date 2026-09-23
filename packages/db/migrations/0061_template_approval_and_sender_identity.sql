-- 0061 — the template's approval state machine, and the sender identity as a fact the database keeps.
--
-- C-AUTO-01 extends the template model 0014 shipped; it does not replace it. 0014 already made
-- `message_class` immutable on a row and already carried `approval_state` and `customer_care_window` on
-- the variant, and 0015 already made a reclassification a NEW VERSION rather than an edit. What was
-- missing is everything that turns those columns into rules:
--
--   1. the immutability raise had no private SQLSTATE, so nothing could assert it was THAT rule that
--      fired rather than any of the seven other `restrict_violation`s in this schema;
--   2. `approval_state` could move anywhere — `draft` straight to `approved` skipped review entirely,
--      and `rejected` to `approved` approved a rejection without anybody re-authoring it;
--   3. an APPROVED variant's body could be edited in place, which is the class-relabelling defect wearing
--      different clothes: the approval stays attached while the words underneath it change;
--   4. `message.sender_id` was documented as "sms only, null for email" and nothing enforced it — and
--      nothing at all held a promotional message to the AD-prefixed identity TDRA registers it under;
--   5. `message.message_class` was documented as "copied from the template at send time" and nothing
--      checked that the copy agreed with the template it was copied from.
--
-- ## Why the SQLSTATEs are private codes and not `restrict_violation`
--
-- `restrict_violation` (23001) is raised by seven triggers in this schema and by every `ON DELETE
-- RESTRICT` foreign key. A probe that asserts 23001 passes when the statement bounced off something else
-- entirely, which is the failure ADR 0003 exists to refuse. So the three rules here raise ZM001-ZM004 in
-- the same private range 0050 and 0056 use, and the gate asserts the code rather than prose that a
-- reword would silently break.
--
--   ZM001  message_class changed on an existing template
--   ZM002  approval_state moved along an edge that does not exist
--   ZM003  an approved variant's words, channel, locale or care-window flag changed while approved
--   ZM004  a message's message_class disagrees with the template version it points at
--
-- ## Why reclassification resets to `draft` and not to `pending`
--
-- 0015 reset the carried-over variants to `pending`, which puts them in an approver's queue. That is the
-- wrong queue. `pending` means "these words are finished, decide about them", and the words of a template
-- that has just become promotional are NOT finished: a promotional SMS needs an opt-out route and leaves
-- from a different registered identity, and the body written for a booking confirmation says neither.
-- Landing in `pending` means the reviewer is shown transactional copy with a promotional label and asked
-- yes or no — and the likely answer, because the words look fine, is yes. That is the laundering the
-- immutability rule exists to prevent, arriving one screen later.
--
-- `draft` forces an author to touch it before a reviewer ever sees it. `refuse_template_approval_jump`
-- below is what makes that more than a default: `draft` cannot reach `approved` without passing through
-- `pending`, so the reset cannot be undone by one UPDATE.
--
-- ## Why the reclassification writes an audit_event and the sends do not
--
-- `audit_event` answers "who did that" about a human action (0005). A reclassification is exactly that —
-- somebody decided this template is a different kind of message — and it is the one change in the
-- messaging domain that no other row records: the superseded version is left behind with `is_current`
-- false and nothing on it says who superseded it or why. A SEND, by contrast, already has two rows
-- describing it (the `message` row and its receipts), which is why `send-scheduled-step.ts` deliberately
-- writes no audit row and says so.
--
-- ## Why the AD- prefix is restated in SQL
--
-- `PROMOTIONAL_SENDER_PREFIX` in `packages/messaging/src/sender-identity.ts` is the same string, and the
-- duplication is the point, for the reason 0056 gives about zod and its CHECKs: the module refuses the
-- send with a reason an operator can act on and cannot be reached from psql, a restored dump or a data
-- migration; the constraint can be reached by all of those and refuses with a name and no explanation.
-- `packages/fixtures/src/message-template.itest.ts` holds the two to each other, in both directions, so
-- they cannot drift into two readings of one registration.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. message_class immutability, with a code of its own
-- ---------------------------------------------------------------------------------------------
-- The body is 0014's. Only the SQLSTATE changes, and the message text is kept verbatim so the assertions
-- written against it in packages/db/src/schema/messaging.itest.ts still read what they were written for.
create or replace function refuse_message_class_change() returns trigger
language plpgsql as $$
begin
  if new.message_class is distinct from old.message_class then
    raise exception 'message_class is immutable on a template (template_key=%, version=%). '
      'Create a new version instead; it starts at approval_state=draft.',
      old.template_key, old.version
      using errcode = 'ZM001';
  end if;
  return new;
end;
$$;

comment on function refuse_message_class_change() is
  'Refuses an UPDATE that changes message_class, with SQLSTATE ZM001. A class that can be edited after '
  'the fact is a promotional template that can be relabelled transactional, which defeats every gate '
  'built on the class: the sender identity, the promotional window, the consent check and the kill '
  'switch all read it.';

-- ---------------------------------------------------------------------------------------------
-- 2. The approval state machine, and the freeze on approved words
-- ---------------------------------------------------------------------------------------------
-- The edges, once, as a function so the trigger and a reader see the same list. IMMUTABLE and not STRICT:
-- a NULL argument must answer false rather than NULL, because a NULL answer inside the trigger's `if not`
-- would read as "permitted".
create or replace function template_approval_transition_allowed(
  p_from template_approval,
  p_to   template_approval
) returns boolean
language sql immutable as $$
  select (p_from, p_to) in (
    -- Submitted for review. The only way into the reviewer's queue.
    ('draft',    'pending'),
    -- Reviewed. These two are the reviewer's decision and are the ONLY edges into them.
    ('pending',  'approved'),
    ('pending',  'rejected'),
    -- Pulled back by the author before anybody looked.
    ('pending',  'draft'),
    -- Re-authored after a rejection. Deliberately NOT rejected -> pending: a rejection answered by
    -- resubmitting the identical words is the reviewer being asked the same question until they say yes.
    ('rejected', 'draft'),
    -- Approval withdrawn, either to change the words (see the freeze below, which is what makes this the
    -- only way to change them) or on compliance grounds.
    ('approved', 'draft'),
    ('approved', 'rejected')
  );
$$;

comment on function template_approval_transition_allowed(template_approval, template_approval) is
  'The declared edges of the template approval state machine. TEMPLATE_APPROVAL_TRANSITIONS in '
  'packages/shared/src/messaging.ts is the same list, and packages/fixtures/src/message-template.itest.ts '
  'asserts the two agree on all sixteen ordered pairs rather than on the seven that are legal.';

create or replace function refuse_template_variant_change() returns trigger
language plpgsql as $$
begin
  if new.approval_state is distinct from old.approval_state
     and not template_approval_transition_allowed(old.approval_state, new.approval_state) then
    raise exception 'approval_state may not move from % to % (template_id=%, channel=%, locale=%). '
      'The declared edges are in template_approval_transition_allowed; nothing reaches approved '
      'except from pending.',
      old.approval_state, new.approval_state, old.template_id, old.channel, old.locale
      using errcode = 'ZM002';
  end if;

  -- The words are frozen while the approval is attached to them. Editing an approved body in place is
  -- the same defect as editing message_class: the review stays and the message changes. The permitted
  -- path is approved -> draft, edit, draft -> pending, pending -> approved, and every step of it is
  -- visible.
  if old.approval_state = 'approved' and new.approval_state = 'approved'
     and (new.body                 is distinct from old.body
       or new.subject              is distinct from old.subject
       or new.variables            is distinct from old.variables
       or new.category             is distinct from old.category
       or new.channel              is distinct from old.channel
       or new.locale               is distinct from old.locale
       or new.customer_care_window is distinct from old.customer_care_window) then
    raise exception 'an approved template variant may not be edited in place (template_id=%, '
      'channel=%, locale=%). Move it to draft first: an approval belongs to the words it was granted '
      'for, and a body edited underneath one is a reviewed message nobody reviewed.',
      old.template_id, old.channel, old.locale
      using errcode = 'ZM003';
  end if;

  return new;
end;
$$;

create trigger message_template_variant_approval_state_machine
  before update on message_template_variant
  for each row execute function refuse_template_variant_change();

-- ---------------------------------------------------------------------------------------------
-- 3. The one privileged path that changes a class, now resetting to draft and recording who
-- ---------------------------------------------------------------------------------------------
-- Replaces 0015's body. The signature is unchanged so no caller has to move; what changes is the state
-- the carried-over variants land in and the audit row that says who moved them. The actor comes from the
-- transaction-local settings 0036 introduced and 0053 reuses, empty-string-normalised the same way:
-- `set_config` cannot store SQL NULL, so a caller with nothing to say sets '' and that must not be
-- recorded as an actor somebody named.
create or replace function reclassify_template(
  p_template_key text,
  p_new_class    message_class,
  p_purpose      text
) returns uuid
language plpgsql as $$
declare
  v_current     message_template;
  v_new         message_template;
  v_actor_kind  text;
  v_actor_id    uuid;
  v_actor_label text;
begin
  select * into v_current
  from message_template
  where template_key = p_template_key and is_current
  for update;

  if not found then
    raise exception 'No current template with key %', p_template_key
      using errcode = 'no_data_found';
  end if;

  if v_current.message_class = p_new_class then
    raise exception 'Template % is already %', p_template_key, p_new_class
      using errcode = 'restrict_violation';
  end if;

  update message_template set is_current = false where id = v_current.id;

  insert into message_template (template_key, version, message_class, purpose, is_current)
  values (p_template_key, v_current.version + 1, p_new_class, p_purpose, true)
  returning * into v_new;

  -- Bodies carry over; approval does not, and it lands in `draft` rather than `pending`. The header of
  -- this migration says why: promotional words are not transactional words with a different label.
  insert into message_template_variant
    (template_id, channel, locale, category, approval_state, customer_care_window,
     subject, body, variables, encoding, segments, cost_fils)
  select v_new.id, channel, locale, category, 'draft', customer_care_window,
         subject, body, variables, encoding, segments, cost_fils
  from message_template_variant
  where template_id = v_current.id;

  v_actor_kind  := nullif(btrim(coalesce(current_setting('berelax.audit_actor_kind',  true), '')), '');
  v_actor_label := nullif(btrim(coalesce(current_setting('berelax.audit_actor_label', true), '')), '');
  -- A malformed uuid is left to raise rather than silently dropped: an unattributed reclassification
  -- that looks like a psql correction when it was a person is the one reading this row must not permit.
  v_actor_id    := nullif(btrim(coalesce(current_setting('berelax.audit_actor_id',    true), '')), '')::uuid;

  insert into audit_event
    (actor_kind, actor_id, actor_label, action, entity_type, entity_id, operation,
     before_state, after_state)
  values
    (coalesce(v_actor_kind, 'system'),
     v_actor_id,
     coalesce(v_actor_label, 'Direct change with no transaction-local actor (migration or psql)'),
     'message_template.reclassified',
     'message_template',
     v_new.id::text,
     'update',
     to_jsonb(v_current),
     to_jsonb(v_new));

  return v_new.id;
end;
$$;

comment on function reclassify_template(text, message_class, text) is
  'The only path that changes a template''s class. Creates a new version, resets every carried-over '
  'variant to DRAFT — not pending, because promotional words are not transactional words relabelled — '
  'and writes a message_template.reclassified audit_event naming the actor.';

-- ---------------------------------------------------------------------------------------------
-- 4. The sender identity, as a fact about the message row
-- ---------------------------------------------------------------------------------------------
alter table message
  -- A biconditional, not two independent rules. `sender_id` is a TDRA-registered alphanumeric identity
  -- and only SMS has one: email leaves from a verified sending subdomain the transport holds (docs/05 §2,
  -- Y6-email-sender), so an address there would be a second kind of value in one column. And an SMS row
  -- with NO identity is the other half: `deliverMessage` resolves the identity before the first attempt
  -- precisely so a message accepted on the second one still records what it left from — which is the
  -- evidence a sender-ID suspension investigation asks for, and which `recordAttempt` cannot supply
  -- because it updates by id and never sees the message.
  add constraint message_sender_id_is_sms_only
    check ((channel = 'sms') = (sender_id is not null)),
  -- The rule the two registrations exist for. A promotional message under the transactional identity is
  -- the send that gets `BERELAX` suspended, and a suspension of the transactional identity stops every
  -- booking confirmation, reminder and OTP in the business. Refused here as well as in
  -- `resolveSenderIdentity` because this column is what an audit reads back.
  add constraint message_sms_identity_matches_its_class
    check (
      channel <> 'sms'
      or (message_class = 'promotional') = (sender_id like 'AD-%')
    );

-- `message.message_class` is a COPY of the template's, deliberately (0035: the frequency cap describes
-- what was sent, so a later reclassification must not move a message into or out of the count). A copy
-- that is never checked against its source is two readings of one question, and the one that matters is
-- the one nobody looks at. Checked at INSERT, and on an UPDATE that touches either column — not
-- continuously, because the template version this row points at is frozen by `on delete restrict` and a
-- reclassification produces a NEW version the old rows do not follow.
create or replace function assert_message_class_matches_template() returns trigger
language plpgsql as $$
declare
  v_class message_class;
begin
  select message_class into v_class from message_template where id = new.template_id;
  if v_class is null then
    -- Unreachable while template_id is a NOT NULL foreign key. Raised rather than passed, because a
    -- message whose template cannot be read has no class to be checked against.
    raise exception 'message.template_id % names no template row', new.template_id
      using errcode = 'ZM004';
  end if;
  if new.message_class is distinct from v_class then
    raise exception 'message.message_class is % and template % is % (template_id=%). The class on a '
      'message is a copy of the template''s taken at send time; a copy that disagrees with its source '
      'makes every promotional count, gate and report read one of the two at random.',
      new.message_class, (select template_key from message_template where id = new.template_id),
      v_class, new.template_id
      using errcode = 'ZM004';
  end if;
  return new;
end;
$$;

create trigger message_class_matches_its_template
  before insert or update of template_id, message_class on message
  for each row execute function assert_message_class_matches_template();

comment on trigger message_class_matches_its_template on message is
  'ZM004. The message''s class must equal the class of the template version it points at, at the moment '
  'the row is written. A reclassification creates a new version rather than editing one, so an existing '
  'row keeps pointing at the class it really left with and this stays true for ever after.';

commit;

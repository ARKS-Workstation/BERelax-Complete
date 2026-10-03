-- ---------------------------------------------------------------------------------------------
-- 0163 — credential_expiry_notice (P-HR-14)
-- ---------------------------------------------------------------------------------------------
-- One row per notice the credential-expiry pass has decided about: which employee, which document on
-- their file, and which warning window it was inside when the pass looked. The acceptance line is that
-- the notices are "idempotent per (employee, document, window) — a second run sends nothing", and this
-- table is where that lives: a UNIQUE on exactly those three columns plus an `on conflict do nothing`
-- insert, so a second pass inserts no row, sends no message and writes no audit event.
--
-- ## Why the idempotency is the INDEX's and not the pass's
--
-- `appointment_reassignment_flag_one_live_per_appointment` is the precedent (0068, and the credential
-- sweep's header argues it at length): a pass that remembered what it had already sent would be a second
-- copy of the truth, and the copy is lost the first time the worker restarts mid-run. A unique index
-- cannot be lost, holds against two workers running at once, and holds for a `psql` session as well.
--
-- ## Why `window_days` is part of the key, and `expires_on` is not
--
-- `window_days` is the configured EXPIRING_SOON window (`hr.credential_expiring_soon_days`, 60
-- provisionally against Y1-licence) as it stood when the pass ran. It is in the key because a change to
-- the window is a change to the question: widening 60 to 90 means documents that were not previously
-- inside it now are, and a notice for one of those is a new fact rather than a repeat. Narrowing it
-- cannot produce a second notice about the same document, because the narrower window is a subset.
--
-- `expires_on` is stored and deliberately NOT in the key. It is a function of the document —
-- `employee_document.expires_on` is immutable in practice, since 0030 makes a renewal a NEW ROW with a
-- later expiry rather than an update — so adding it would widen the key by a column that cannot vary,
-- and a key with a redundant column in it is a key that permits a duplicate the day that column does
-- vary. It is on the row so a reader can see what the notice was about without joining.
--
-- ## Why a SKIPPED notice is a row
--
-- 0081's argument, unchanged, and it is the whole reason this table is not "the sends we made". No table
-- in this build holds a staff phone or an email address, so every notice today resolves to
-- `no_recipient_on_file` and nothing leaves. A table that could only record a send would be
-- indistinguishable from a notification path that does nothing, and the pass would report success for
-- ever. So the outcome is recorded either way, and `skipped` carries the reason.
--
-- It also makes the idempotency honest: a skipped notice is still a notice decided, so a second pass
-- must not reconsider it. Otherwise the pass would re-derive the same skip every night and the idempotency
-- claim would be true only of the branch that never runs.
--
-- ## Append-only, ZY841
--
-- A notice is evidence that somebody was told, or that nothing could be sent to them. `rota_publication_notice`
-- (0081) and `leave_approval_notice` (0092) both make the same argument: a record that can be edited is
-- not evidence. A correction is a further row under a different window, never an UPDATE of this one.
--
-- ## No private SQLSTATE but ZY841
--
-- ZY842 through ZY850 were allocated to this unit and are RELEASED UNUSED and deliberately unregistered.
-- Everything else this table has to say is a CHECK — the outcome vocabulary, the skip reason, the pinned
-- template key — and `pnpm sqlstate` refuses an entry for a code no migration raises. A trigger carrying
-- a code a CHECK already enforces would be a second statement of one rule.

-- ---------------------------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------------------------
create table credential_expiry_notice (
  id                   uuid        primary key default uuid_generate_v7(),
  -- RESTRICT, for 0030's reason: somebody who has been warned about a document has a history, and
  -- deleting the person to clear the warning is the delete this refuses. Ending employment is
  -- `employee.employed_until`.
  employee_id          uuid        not null references employee (id) on delete restrict,
  -- RESTRICT as well, and NOT the `on delete cascade` that `employee_document` itself takes to
  -- `employee`: the notice is the record that a warning was decided about THAT document, and a document
  -- row removed under it would leave a notice about nothing while reading as though none had been sent.
  employee_document_id uuid        not null references employee_document (id) on delete restrict,
  -- The configured window the pass ran with, in whole days. Part of the idempotency key: see the header.
  window_days          integer     not null,
  -- What the document says, denormalised so a reader does not have to join to see what the notice was
  -- about. NOT part of the key.
  expires_on           date        not null,
  -- The business day the pass detected it on. A date and not an instant, because the pass runs once per
  -- trading day and "which night did we notice" is the question an operator asks.
  detected_on          date        not null,
  -- Pinned to the one template that may carry this notice, for `rota_publication_notice`'s reason: a
  -- notice addressed at another template is a notice about something else.
  template_key         text        not null,
  -- 'sent' or 'skipped', with the reason on the second. The vocabulary is a CHECK rather than an enum
  -- for 0081's reason: two values that will not grow do not need a type, and a type would need a
  -- migration to add the third.
  outcome              text        not null,
  skip_reason          text,
  -- The `message` row's id when something left. Text and not a uuid reference: the message store is
  -- reached through its own repository and a foreign key here would make this table un-insertable from a
  -- pass whose send was diverted to the local outbox.
  message_id           text,
  created_at           timestamptz not null default now(),
  -- Who or what wrote it. A label, not a uuid: the audit_event row written in the same transaction
  -- carries the full actor and request context (F06).
  created_by           text        not null,

  -- THE idempotency key. Three columns, and the header says why each is in it and why expires_on is not.
  constraint credential_expiry_notice_once
    unique (employee_id, employee_document_id, window_days),
  constraint credential_expiry_notice_window_is_plausible
    check (window_days >= 0 and window_days <= 365),
  constraint credential_expiry_notice_outcome_is_known
    check (outcome in ('sent', 'skipped')),
  -- Both directions, as one constraint each: a skip with no reason is a skip nobody can act on, and a
  -- skip with a message id is a send recorded as a skip.
  constraint credential_expiry_notice_skip_has_a_reason
    check ((outcome = 'skipped') = (skip_reason is not null)),
  constraint credential_expiry_notice_send_has_a_message
    check ((outcome = 'sent') = (message_id is not null)),
  constraint credential_expiry_notice_template_is_the_credential_one
    check (template_key = 'hr.credential_expiring'),
  constraint credential_expiry_notice_created_by_not_placeholder
    check (not is_placeholder_text(created_by))
);

comment on table credential_expiry_notice is
  'One row per credential-expiry notice DECIDED, sent or skipped, append-only and raising ZY841 on '
  'UPDATE and DELETE. Idempotent per (employee, document, window) by '
  'credential_expiry_notice_once: a second pass inserts nothing, sends nothing and writes no audit '
  'row. A skipped notice is a row for rota_publication_notice''s reason (0081) - no table in this build '
  'holds a staff phone, so a table that could only record a send would be indistinguishable from a '
  'notification path that does nothing.';
comment on column credential_expiry_notice.window_days is
  'The configured hr.credential_expiring_soon_days the pass ran with. Part of the idempotency key: '
  'widening the window is a change to the question, so a notice under a wider one is a new fact.';
comment on column credential_expiry_notice.expires_on is
  'What employee_document.expires_on said. Denormalised for a reader and deliberately NOT in the key: '
  'a renewal is a NEW document row (0030), so this cannot vary for one document.';

create index credential_expiry_notice_employee_idx
  on credential_expiry_notice (employee_id, detected_on desc);

-- ---------------------------------------------------------------------------------------------
-- Append-only: ZY841
-- ---------------------------------------------------------------------------------------------
create function refuse_credential_expiry_notice_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'A credential expiry notice is append-only; % on % is refused. The row is the record that a warning '
    'was decided about one document on one person''s file - sent, or skipped because nothing in this '
    'build holds a staff phone number - and a record that can be edited is not evidence the warning was '
    'decided. A correction is a further row under a different window, never an edit of this one.',
    tg_op, tg_table_name
    using errcode = 'ZY841';
end $$;

comment on function refuse_credential_expiry_notice_change() is
  'Raises ZY841 (CredentialExpiryNoticeImmutable) for credential_expiry_notice, for every role '
  'including the owner.';

create trigger credential_expiry_notice_no_update before update on credential_expiry_notice
  for each row execute function refuse_credential_expiry_notice_change();
create trigger credential_expiry_notice_no_delete before delete on credential_expiry_notice
  for each row execute function refuse_credential_expiry_notice_change();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select/insert/update/delete on every table created in `public`
-- afterwards, so these revokes are load-bearing rather than decorative - and stated explicitly because a
-- managed database restored from a dump does not necessarily carry the same defaults.
--
-- The triggers above already refuse UPDATE and DELETE for every role. These revokes are the second
-- layer, and they are the one that gives a caller a privilege error rather than a raised exception,
-- which is the difference between "you may not" and "you tried and it failed".
revoke update, delete, truncate on credential_expiry_notice from berelax_app;

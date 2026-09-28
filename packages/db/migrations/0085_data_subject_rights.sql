-- 0085 — data-subject rights, retention and the erasure/retention conflict.
--
-- docs/04 §8 asks for "data-subject rights as a policy engine, not a manual process: export,
-- rectification, erasure with per-class resolution (anonymise marketing identity, retain the financial
-- record under statutory obligation, record the conflict), objection, withdrawal — each with an SLA and
-- audit trail", plus "retention and legal hold per data class, with automated purge jobs and a stated
-- position on backups". docs/04 §4 states the conflict itself: five-year record retention conflicts with
-- PDPL erasure rights, and the resolution is to anonymise the CRM identity, retain the financial record,
-- and RECORD the conflict and the reason.
--
-- Everything in this file exists to make "recorded" mean a row a constraint refuses to accept if it is
-- incoherent, rather than a sentence somebody wrote.
--
-- ## Three refusals this file makes, and what each is built against
--
--   1. **An erasure cannot complete while a table's outcome is unaccounted for.** `rights_resolution_class`
--      carries, per participant, the rows that were there and the rows that were acted on or retained, with
--      `rows_before = rows_acted + rows_retained` as a CHECK and a retained reason required exactly when
--      something was retained. This is 0069's `merge_record_table` argument applied to the operation whose
--      defects are even quieter: a merge that leaves rows behind shows up as a record nobody reads, and an
--      erasure that leaves rows behind shows up as a message to somebody who asked to be forgotten. An
--      engine that cannot store its own report cannot commit, and the refusal happens inside the erasure's
--      own transaction.
--
--   2. **A rights request cannot be back-dated, re-typed or re-opened.** `rights_request_guard` freezes the
--      subject, the type, the instant it was received, the due instant and the verification method, and
--      permits only the transitions `rights-policy.ts` declares. The failure this closes is the one that
--      makes an SLA meaningless: a request answered on day forty is compliant if somebody may edit
--      `received_at` to day thirty-nine, and nothing about the row would look wrong afterwards.
--
--   3. **A clinical data key may be destroyed only under a verified erasure request.** `destroy_customer_deks`
--      is SECURITY DEFINER because 0009 revokes every privilege on the `clinical` schema from the
--      application role, so this is the only way an application operation can reach it at all — and a
--      function that hands the application write access to the most sensitive schema in the database has to
--      earn it. It refuses unless there is an `in_progress` erasure request for exactly that customer with a
--      verification method recorded, it acts on one customer id, and it records every destruction in an
--      append-only table. A bug in the application cannot shred a clinical record because there is no
--      request row saying it may.
--
-- ## Crypto-erasure, and why the marker is an EMPTY wrapped key
--
-- A clinical submission is append-only, encrypted, and bound to its row by its AAD. It cannot be deleted
-- (no privilege, and no DELETE grant anywhere in the schema), cannot be edited (0043's ZK002 freezes every
-- column but the wrapped key, the KEK version and `superseded_at`), and cannot be re-pointed (the AAD
-- includes the customer id). Exactly one mutation is therefore available, and it happens to be the right
-- one: replace the WRAPPED DATA KEY and the content becomes unreadable while the ciphertext stays
-- byte-identical. That is crypto-erasure, and it is the only erasure this schema admits.
--
-- The destroyed marker is a ZERO-LENGTH `wrapped_data_key`. A real wrapped key is always exactly 60 bytes
-- (12-byte nonce + 32-byte data key + 16-byte GCM tag), so zero is a value `seal()` cannot produce, and
-- `length(wrapped_data_key) = 0` is checkable identically in SQL and in TypeScript — which matters because
-- two places have to agree about it: the erasure that writes it and the KEK rotation that must SKIP it.
--
-- **What this file deliberately does NOT add is a CHECK saying the length is 0 or 60.** It was written and
-- removed. `packages/clinical/src/intake.itest.ts` inserts one-byte placeholder keys (`'\x02'::bytea`) in
-- the cases that prove the consent gate and the version guard fire, and those guards are a DEFERRED
-- constraint trigger and a row trigger respectively — a CHECK would have fired FIRST and two of C-CRM-08's
-- passing tests would have failed with this file's error instead of the one they assert. The positive
-- record of a destruction is `clinical.dek_destruction`, which is append-only and is the authority; the
-- empty key is the mechanism.
--
-- ## The position on backups, stated rather than implied
--
-- Row-level erasure does not reach a backup, and nothing in this schema pretends it does.
-- `rights_resolution.backup_position` is `not null` with no default, so every completed erasure carries
-- the sentence in its own row and a reader never has to infer it from silence. This is the manifest's
-- provisional position and it is marked as such.
--
-- ## `ZY` is this file's private SQLSTATE prefix, and `ZA` was
--
-- `ZB` through `ZW` were taken (0082's header lists most of them and ZV and ZW went to 0080 and 0081), so
-- the alphabet was exhausted in the direction everybody walks it. This file therefore took `ZA` rather
-- than `ZX`, reasoning that a unit continuing the sequence from ZW would reach for ZX next while 0083,
-- 0084, 0086 and 0087 sat in other worktrees.
--
-- 0084 had taken `ZA`. Neither file could see the other, and the collision did not exist until both
-- merged: `ZA001` then meant both "this flag row claims a template version its source submission does not
-- have" and "rights_request refuses DELETE", `ZA002` both "this flag cites another customer's submission"
-- and "a frozen SLA column changed". Every translator in `packages/db` matches on the code ALONE, so an
-- erasure refusal would have been reported as a clinical provenance defect, and a probe asserting either
-- code would have passed on the other rule entirely.
--
-- So this file's codes are ZY001-ZY008. 0084's did not move: it merged first and its two codes are
-- asserted by C-CRM-09's suite, while this file's were a day old and referenced only by its own unit. What
-- a private code has to be is unique to one file, not memorable, which is 0077's argument verbatim — and
-- `ZZ` is now the only free class, so this is the last time that sentence can be satisfied by taking a
-- fresh one. W-SYS-12 owns the allocator that replaces the convention.

-- ---------------------------------------------------------------------------------------------
-- New enum label — OUTSIDE the transaction, and that is the point
-- ---------------------------------------------------------------------------------------------
--
-- 0054's convention exactly: `alter type ... add value` is legal inside a transaction block on
-- PostgreSQL 12+, but the new label may not be USED until that transaction commits. `psql -f` sends
-- statements in autocommit, so this commits on its own and the block below may reference it.
--
-- An erasure request from somebody who never opted out leaves NO suppression entry to preserve, so the
-- erasure writes one — and it needs a source that says why. `manual` would be a lie (nobody typed it),
-- `preference_centre` would be a lie (they did not use it), and `complaint` would put a complaint on the
-- record that nobody made. A right exercised is its own source.
alter type suppression_source add value if not exists 'erasure_request';

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. The request.
-- ---------------------------------------------------------------------------------------------

create table rights_request (
  id                    uuid        primary key default uuid_generate_v7(),
  -- The five rights docs/04 §8 names. Text behind a CHECK rather than an enum, for 0069's reason about
  -- `merge_record_table.strategy`: the vocabulary is declared in `packages/shared/src/privacy.ts`, a test
  -- asserts the two lists are equal, and an enum would make every future alignment a migration.
  request_type          text        not null
                          constraint rights_request_type_known
                          check (request_type in ('export', 'rectification', 'erasure', 'objection',
                                                  'withdrawal')),
  -- The subject. A plain uuid and NOT a foreign key, which is 0056's and 0069's decision restated: an
  -- append-only-adjacent record cannot reference a mutable parent whose deletion would cascade, and four
  -- integration files clear `customer` — a foreign key here would make `delete from customer` raise for
  -- every one of them. It is also correct on its own terms: the record of a request outlives the record it
  -- was about.
  subject_customer_id   uuid        not null,
  -- When the subject asked. Supplied by the caller's clock and NOT defaulted, for the reason 0056 gives for
  -- `consent.recorded_at` and 0064 for `suppression.recorded_at`: every deadline assertion in this area is
  -- made under a frozen clock, and a column that defaults to `now()` cannot be frozen.
  received_at           timestamptz not null,
  -- The SLA the due instant was derived from, STORED rather than looked up when read. The setting can
  -- change; what this request was owed cannot, and a due date recomputed from today's setting would
  -- retroactively make a late answer punctual.
  sla_days              smallint    not null
                          constraint rights_request_sla_is_a_deadline check (sla_days between 1 and 90),
  due_at                timestamptz not null
                          constraint rights_request_due_after_received check (due_at > received_at),
  state                 text        not null default 'received'
                          constraint rights_request_state_known
                          check (state in ('received', 'in_progress', 'completed',
                                           'partially_completed', 'refused')),
  -- How the requester was proved to be the subject. Required, because an erasure performed for an
  -- unverified requester destroys somebody else's record, and a phone number is not a secret.
  verified_via          text        not null
                          constraint rights_request_verification_known
                          check (verified_via in ('otp', 'in_person_id', 'staff_attested')),
  -- Who recorded it. The same trio `consent` and `suppression` record, and never a person's name
  -- (ADR 0020): PDPL asks who decided and when, and a record missing either cannot answer the question it
  -- exists for.
  actor_kind            text        not null
                          constraint rights_request_actor_kind_known
                          check (actor_kind in ('customer', 'staff', 'system')),
  actor_label           text        not null
                          constraint rights_request_actor_is_stated
                          check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  -- What was asked, in the subject's terms. Mandatory and not a placeholder (0026): a rights request with
  -- no stated substance cannot be answered and cannot be reviewed.
  request_detail        text        not null
                          constraint rights_request_detail_is_stated
                          check (not is_placeholder_text(request_detail)
                                 and length(request_detail) <= 2000),
  closed_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- A terminal state and a closing instant are the same fact, so they may not disagree. The engine cannot
  -- report a request as answered without saying when, nor leave one closed while claiming it is in flight.
  constraint rights_request_closure_matches_state
    check ((state in ('completed', 'partially_completed', 'refused')) = (closed_at is not null)),
  constraint rights_request_closed_after_received
    check (closed_at is null or closed_at >= received_at)
);

comment on table rights_request is
  'One data-subject request, its deadline and its lifecycle. DELETE raises for every role: the record of a '
  'request is the evidence that it was answered, and a request answered wrongly is answered by a NEW '
  'request with its own deadline rather than by editing this row.';
comment on column rights_request.sla_days is
  'Stored, not looked up. 30 days is provisional against OPEN-QUESTIONS Y1-entity — the shortest deadline '
  'of the regimes this build can see, because the entity type that decides which regime applies is '
  'unanswered. A request keeps the deadline it was taken under even after the setting changes.';
comment on column rights_request.verified_via is
  'Required. An erasure for an unverified requester destroys somebody else''s record, and a phone number '
  'is not a secret: "please erase +971..." costs nothing to send.';

-- One open request per subject per type. A partial unique index, so a subject may exercise the same right
-- again once the first is answered — which is their right — but two live erasures for one person would race
-- each other and each write a resolution claiming to be the complete account of the same work.
create unique index rights_request_one_open_per_subject_and_type
  on rights_request (subject_customer_id, request_type)
  where closed_at is null;

-- The overdue query's index: open requests by deadline. Partial on the open ones, because the question is
-- only ever asked of those and the closed ones outnumber them for ever.
create index rights_request_overdue_idx on rights_request (due_at)
  where closed_at is null;
create index rights_request_subject_idx on rights_request (subject_customer_id, received_at desc);

create trigger rights_request_updated_at before update on rights_request
  for each row execute function set_updated_at();

/**
 * Freezes what a request WAS, and permits only the transitions the policy declares.
 *
 * The columns listed here are the ones an SLA is measured against, and an SLA nobody can edit is the only
 * kind worth having: a request answered on day forty is compliant if `received_at` can be moved to day
 * thirty-nine, and the row would look perfectly ordinary afterwards. The same argument covers
 * `subject_customer_id` (a request re-pointed at another person is a different request) and `verified_via`
 * (a verification added after the fact is not a verification).
 *
 * The transition table is duplicated from `packages/core/src/privacy/rights-policy.ts` on purpose, and
 * `packages/fixtures/src/rights.itest.ts` asserts the two agree edge by edge. It is here as well as there
 * for ADR 0010's reason: the rules that matter are the ones a `psql` session is also held to, and a state
 * machine enforced only in TypeScript is a state machine a migration or a support script walks straight
 * through.
 */
create or replace function refuse_rights_request_rewrite() returns trigger
language plpgsql
as $$
declare
  v_frozen text[] := array['request_type', 'subject_customer_id', 'received_at', 'due_at', 'sla_days',
                           'verified_via', 'created_at'];
  v_changed text;
begin
  if tg_op = 'DELETE' then
    raise exception
      'RightsRequestNotDeletable: rights_request refuses DELETE. The record of a request is the evidence '
      'that it was answered within its deadline, and deleting it would remove the only thing that says '
      'so. A request taken in error is closed as refused, with the reason.'
      using errcode = 'ZY001';
  end if;

  select key into v_changed
    from jsonb_each(to_jsonb(new)) as n(key, value)
   where n.key = any (v_frozen)
     and (to_jsonb(old) -> n.key) is distinct from n.value
   order by key
   limit 1;

  if v_changed is not null then
    raise exception
      'RightsRequestFrozenColumn: rights_request.% may not change. The deadline is measured against '
      'these columns, so a request answered late becomes compliant the moment one of them can be '
      'edited — and nothing about the row would look wrong afterwards.',
      v_changed
      using errcode = 'ZY002';
  end if;

  if new.state is distinct from old.state then
    if not (
      (old.state = 'received'    and new.state in ('in_progress', 'refused'))
      or (old.state = 'in_progress' and new.state in ('completed', 'partially_completed', 'refused'))
    ) then
      raise exception
        'RightsRequestTransitionRefused: a request may not move from "%" to "%". Nothing leaves a '
        'terminal state: a request answered wrongly is answered by a NEW request with its own deadline, '
        'so the record of what was done to which rows is never rewritten.',
        old.state, new.state
        using errcode = 'ZY003';
    end if;
  end if;

  return new;
end $$;

comment on function refuse_rights_request_rewrite() is
  'Raises ZY001 (DELETE), ZY002 (a frozen column changed) or ZY003 (a transition the policy does not '
  'declare). A trigger and not privileges alone, because a migration or a psql session does not connect '
  'as the application role.';

create trigger rights_request_guard before update on rights_request
  for each row execute function refuse_rights_request_rewrite();
create trigger rights_request_no_delete before delete on rights_request
  for each row execute function refuse_rights_request_rewrite();

-- ---------------------------------------------------------------------------------------------
-- 2. The resolution: what the request DID, and the conflict it resolved.
-- ---------------------------------------------------------------------------------------------

create table rights_resolution (
  id                    uuid        primary key default uuid_generate_v7(),
  -- A real foreign key, unlike the customer ids: the parent is this migration's own table and nothing
  -- deletes from it (ZY001), so no cascade can ever fire.
  rights_request_id     uuid        not null references rights_request (id)
                          constraint rights_resolution_one_per_request unique,
  resolved_at           timestamptz not null,
  -- WHICH profile decided. `regulatory_profile` is append-only and versioned precisely so a past decision
  -- stays explainable (0004), and this is the column that makes it so for an erasure: "we retained that
  -- because the profile in force said erasure does not override retention" is answerable years later, after
  -- the profile has been superseded twice.
  regulatory_profile_version integer not null references regulatory_profile (version),
  -- The pseudonym the CRM identity became, so the resolution can be joined back to the record it acted on
  -- without holding anything that identifies the person. Null for a request that is not an erasure.
  pseudonym             text
                          constraint rights_resolution_pseudonym_shape
                          check (pseudonym is null or pseudonym ~ '^erased-[a-p]{32}$'),
  -- The privacy regime assumed, and that it was assumed. Both, because a regime recorded without its
  -- provisional flag reads as one somebody confirmed.
  privacy_regime        text        not null
                          constraint rights_resolution_regime_is_stated
                          check (not is_placeholder_text(privacy_regime)
                                 and length(privacy_regime) <= 120),
  regime_is_provisional boolean     not null,
  -- The OPEN-QUESTIONS ids whose answers would change this resolution. An array and not a single id:
  -- Y1-entity decides the regime and Y1-licence decides the clinical retention, and a resolution that
  -- named one of them would hide the other.
  open_question_ids     text[]      not null
                          constraint rights_resolution_open_questions_are_ids
                          check (array_length(open_question_ids, 1) >= 1
                                 and array_position(open_question_ids, null) is null),
  -- The stated position on backups. `not null` with NO default, which is the whole point of the column:
  -- row-level erasure does not reach a backup, and the manifest requires that position be "recorded in the
  -- resolution row rather than implied". A default would make it implied again.
  backup_position       text        not null
                          constraint rights_resolution_backup_position_is_stated
                          check (not is_placeholder_text(backup_position)
                                 and length(backup_position) <= 1000),
  -- Whether the written response could be issued, and if not, why. See
  -- `decideRightsResponse` in packages/core: while no supervisory authority is recorded (Y1-entity), the
  -- rights are PERFORMED and the letter is withheld, because a letter naming an invented regulator would
  -- send somebody with a real complaint to an office that cannot hear it.
  response_issued       boolean     not null,
  response_withheld_reason text
                          constraint rights_resolution_withholding_is_explained
                          check ((response_issued = false) = (response_withheld_reason is not null)),
  created_at            timestamptz not null default now()
);

comment on table rights_resolution is
  'One completed request''s account of itself: the profile version that decided it, the regime it was '
  'decided under and that the regime is an assumption, the pseudonym the identity became, the position on '
  'backups, and whether the written response could be issued. UPDATE and DELETE raise for every role '
  'including the owner — this row is the evidence, and evidence that can be edited is not evidence.';
comment on column rights_resolution.backup_position is
  'Required with no default. Row-level erasure cannot reach a backup; the position is carried on every '
  'resolution so a reader never infers it from silence.';

create index rights_resolution_resolved_idx on rights_resolution (resolved_at desc);

-- ---------------------------------------------------------------------------------------------
-- 3. Per data class: the accounting that makes "nothing was left behind" a fact.
-- ---------------------------------------------------------------------------------------------

create table rights_resolution_class (
  id                    uuid        primary key default uuid_generate_v7(),
  rights_resolution_id  uuid        not null references rights_resolution (id),
  data_class            text        not null
                          constraint rights_resolution_class_known
                          check (data_class in ('identity', 'contact_channel', 'credential',
                                                'consent_record', 'suppression_record', 'operational',
                                                'clinical', 'financial', 'audit', 'not_customer_data')),
  -- `schema.table`, spelled as `packages/core/src/privacy/rights-policy.ts` spells it and checked with the
  -- same regex 0069 uses for a merge participant.
  participant           text        not null
                          constraint rights_resolution_class_participant_is_qualified
                          check (participant ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  -- The column the rule was keyed on, or `*` for a table-wide rule.
  column_name           text        not null
                          constraint rights_resolution_class_column_is_an_identifier
                          check (column_name = '*' or column_name ~ '^[a-z_][a-z0-9_]*$'),
  action                text        not null
                          constraint rights_resolution_class_action_known
                          check (action in ('pseudonymise', 'redact', 'delete_row', 'crypto_erase',
                                            'retain_statutory', 'retain_append_only',
                                            'retain_for_subject', 'retain_legitimate_interest',
                                            'inherits_parent', 'not_customer_data')),
  rows_before           integer     not null check (rows_before >= 0),
  rows_acted            integer     not null check (rows_acted >= 0),
  rows_retained         integer     not null check (rows_retained >= 0),
  -- Why the retained rows are lawful to keep. Required exactly when there are any — 0069's
  -- `merge_record_table_retention_is_explained`, and for the identical reason: a row left in place with
  -- nothing saying why is the failure this whole registry exists to prevent.
  retained_reason       text
                          constraint rights_resolution_class_retention_is_explained
                          check ((rows_retained > 0) = (retained_reason is not null)),
  constraint rights_resolution_class_retained_reason_is_stated
    check (retained_reason is null
           or (not is_placeholder_text(retained_reason) and length(retained_reason) <= 1000)),
  -- The obligation a statutory retention is under, and the figure, taken from the profile rather than
  -- written as a literal. Required exactly when the action is `retain_statutory`, because "retained under
  -- an obligation" with no obligation named is the sentence this column exists to refuse.
  obligation_column     text
                          constraint rights_resolution_class_obligation_known
                          check (obligation_column is null
                                 or obligation_column in ('financial_retention_years',
                                                          'clinical_retention_years')),
  obligation_years      smallint    check (obligation_years is null or obligation_years > 0),
  constraint rights_resolution_class_statutory_names_its_obligation
    check ((action = 'retain_statutory')
           = (obligation_column is not null and obligation_years is not null)),
  created_at            timestamptz not null default now(),
  constraint rights_resolution_class_one_row_per_column
    unique (rights_resolution_id, participant, column_name),
  -- The claim of the table, as a constraint. Every row that was there is either acted on or retained with
  -- a stated reason, so an erasure that silently left rows behind cannot store its own report — and the
  -- refusal happens inside the erasure's transaction and rolls it back. This is what makes "erasure
  -- worked" something the database keeps rather than something a test remembered to look for.
  constraint rights_resolution_class_every_row_is_accounted_for
    check (rows_before = rows_acted + rows_retained),
  -- A retaining action cannot have acted on anything, and an acting action cannot have retained without
  -- saying so. The pair is what stops a participant reporting a plausible-looking split it did not perform.
  constraint rights_resolution_class_a_retained_table_was_not_acted_on
    check (action not in ('retain_statutory', 'retain_append_only', 'retain_for_subject',
                          'retain_legitimate_interest')
           or rows_acted = 0)
);

comment on table rights_resolution_class is
  'What one request did to one column of one table: the rows that were there, the rows acted on, the rows '
  'retained and why. UPDATE and DELETE raise for every role including the owner. '
  'rights_resolution_class_every_row_is_accounted_for is the claim — an erasure that could not account '
  'for a row cannot write its report, and the refusal rolls the erasure back.';
comment on column rights_resolution_class.retained_reason is
  'The reason it is lawful to keep the rows, which is the sentence a data subject is entitled to be '
  'given. Required whenever rows_retained > 0.';

create index rights_resolution_class_resolution_idx
  on rights_resolution_class (rights_resolution_id);

-- ---------------------------------------------------------------------------------------------
-- 4. Exports, and the insider-threat control.
-- ---------------------------------------------------------------------------------------------

create table rights_export (
  id                    uuid        primary key default uuid_generate_v7(),
  -- Nullable: an export is usually a right being exercised, but a staff export for an audit is a real
  -- operation too. What is NOT optional is that one of the two is stated.
  rights_request_id     uuid        references rights_request (id),
  purpose               text        not null
                          constraint rights_export_purpose_is_stated
                          check (not is_placeholder_text(purpose) and length(purpose) <= 500),
  exported_at           timestamptz not null,
  row_count             integer     not null check (row_count >= 0),
  -- How many distinct data subjects the export covered. docs/06 D4's insider-threat control turns on this
  -- one number: a single-subject export is somebody exercising a right, and a multi-subject one is a bulk
  -- read of the client list, which is the realistic breach for this business.
  subject_count         integer     not null check (subject_count >= 1),
  -- Set when the export covered more than one subject. A boolean rather than a derived read, because the
  -- acceptance line requires the alert to be enqueued in the SAME transaction as the export record, and a
  -- column the constraint below ties to `subject_count` is what makes "we alerted" un-forgeable.
  alerted               boolean     not null,
  constraint rights_export_multi_subject_alerts
    check (alerted = (subject_count > 1)),
  actor_kind            text        not null
                          constraint rights_export_actor_kind_known
                          check (actor_kind in ('customer', 'staff', 'system')),
  actor_label           text        not null
                          constraint rights_export_actor_is_stated
                          check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  created_at            timestamptz not null default now()
);

comment on table rights_export is
  'Every export of subject data, with how many subjects it covered and whether it alerted. UPDATE and '
  'DELETE raise for every role including the owner: an export record that could be edited would let '
  'somebody who exported the client list rewrite it as a single-subject request.';
comment on column rights_export.alerted is
  'Tied to subject_count by rights_export_multi_subject_alerts, so a bulk export cannot be recorded as '
  'un-alerted. The alert itself is an outbox event published in the same transaction (0007), so the '
  'export and the notification commit or roll back together.';

create index rights_export_exported_idx on rights_export (exported_at desc);
create index rights_export_multi_subject_idx on rights_export (exported_at desc)
  where subject_count > 1;

-- ---------------------------------------------------------------------------------------------
-- 5. Legal hold.
-- ---------------------------------------------------------------------------------------------

create table legal_hold (
  id                    uuid        primary key default uuid_generate_v7(),
  -- Null means every subject; null `data_class` means every class. A hold on neither is not a hold, which
  -- the constraint below refuses — an all-null row would silently stop every purge in the system.
  subject_customer_id   uuid,
  data_class            text
                          constraint legal_hold_class_known
                          check (data_class is null
                                 or data_class in ('identity', 'contact_channel', 'credential',
                                                   'consent_record', 'suppression_record', 'operational',
                                                   'clinical', 'financial', 'audit',
                                                   'not_customer_data')),
  constraint legal_hold_holds_something
    check (subject_customer_id is not null or data_class is not null),
  reason                text        not null
                          constraint legal_hold_reason_is_stated
                          check (not is_placeholder_text(reason) and length(reason) <= 1000),
  placed_at             timestamptz not null,
  placed_by_kind        text        not null
                          constraint legal_hold_placed_by_kind_known
                          check (placed_by_kind in ('staff', 'system')),
  placed_by_label       text        not null
                          constraint legal_hold_placed_by_is_stated
                          check (not is_placeholder_text(placed_by_label)
                                 and length(placed_by_label) <= 200),
  lifted_at             timestamptz,
  lifted_reason         text,
  constraint legal_hold_lifting_is_explained
    check ((lifted_at is null) = (lifted_reason is null)),
  constraint legal_hold_lifted_after_placed check (lifted_at is null or lifted_at >= placed_at),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table legal_hold is
  'A decision that rows must not be purged, per subject, per data class, or both. A hold on neither is '
  'refused by legal_hold_holds_something: an all-null row would stop every purge in the system and read '
  'like an ordinary entry.';

-- One live hold per scope. `coalesce` onto a sentinel because NULL is a real value here ("every subject")
-- rather than an absent one, and two identical live holds would each claim to be the reason a row survived.
create unique index legal_hold_one_live_per_scope
  on legal_hold (coalesce(subject_customer_id, '00000000-0000-0000-0000-000000000000'::uuid),
                 coalesce(data_class, '*'))
  where lifted_at is null;

create trigger legal_hold_updated_at before update on legal_hold
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- 6. Append-only, for every role.
-- ---------------------------------------------------------------------------------------------
--
-- A trigger and not `create rule ... do instead nothing`, which reports success and lets the caller go on
-- believing the edit happened (0018's argument). For EVERY role including the owner: privileges cover the
-- application role, and a migration or a psql session does not connect as the application role.

create function refuse_rights_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'RightsRecordImmutable: %.% is append-only; % is refused. The resolution, its per-class accounting '
    'and the export log are the evidence that a request was answered and that what was retained was '
    'retained for a reason. An erasure that was wrong is not corrected by editing the row that records '
    'it: it is answered by a new request with its own deadline.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'ZY004';
end $$;

comment on function refuse_rights_record_change() is
  'Raises ZY004 for UPDATE and DELETE on rights_resolution, rights_resolution_class and rights_export, '
  'for every role including the owner.';

create trigger rights_resolution_no_update before update on rights_resolution
  for each row execute function refuse_rights_record_change();
create trigger rights_resolution_no_delete before delete on rights_resolution
  for each row execute function refuse_rights_record_change();
create trigger rights_resolution_class_no_update before update on rights_resolution_class
  for each row execute function refuse_rights_record_change();
create trigger rights_resolution_class_no_delete before delete on rights_resolution_class
  for each row execute function refuse_rights_record_change();
create trigger rights_export_no_update before update on rights_export
  for each row execute function refuse_rights_record_change();
create trigger rights_export_no_delete before delete on rights_export
  for each row execute function refuse_rights_record_change();

-- The application role must not be able to edit its own evidence either. Stated explicitly rather than
-- relying on the triggers alone: the two answer different questions ("may this role" and "may anybody"),
-- and a privilege is what a reader of `\dp` sees.
revoke update, delete, truncate on rights_resolution       from berelax_app;
revoke update, delete, truncate on rights_resolution_class from berelax_app;
revoke update, delete, truncate on rights_export           from berelax_app;
revoke delete, truncate         on rights_request          from berelax_app;

-- ---------------------------------------------------------------------------------------------
-- 7. The CRM identity: the pseudonym, and why the E.164 check has to widen.
-- ---------------------------------------------------------------------------------------------
--
-- `customer.phone_e164` is `not null unique` and IS the identity (ADR 0014), so an erasure cannot null it
-- and cannot leave it: it can only replace it. Everything matching the existing check is a PLAUSIBLE phone
-- number, and brief rule 15 is exactly about that — a plausible value is indistinguishable from a
-- configured one, and here it is worse still, because a plausible number may be a real stranger's. Erasing
-- one customer would write somebody else's number into the identity column and the next send resolved from
-- that record would reach them.
--
-- So the check admits a second shape that cannot be a phone number: `erased-` and thirty-two letters from
-- `a` to `p`, the bijective hex encoding `erasurePseudonym` produces from the customer's own uuid. It holds
-- NO DIGITS, which is the property that matters twice over — it cannot be dialled, and `phone_match_key` is
-- GENERATED as the trailing nine digits of this column, so it derives to the empty string and an erased
-- record can never surface as a merge candidate for a living person. A hex or base-36 pseudonym would have
-- derived nine digits that could equal somebody's real match key.
alter table customer
  drop constraint customer_phone_is_e164,
  add constraint customer_phone_is_e164
    check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$' or phone_e164 ~ '^erased-[a-p]{32}$');

comment on constraint customer_phone_is_e164 on customer is
  'A canonical E.164 number, or the digit-free erasure pseudonym (0085). Nothing else: the shape check is '
  'what catches an un-normalised value written straight into the column, which is the failure that splits '
  'one person into several rows.';

alter table customer add column erased_at timestamptz;

comment on column customer.erased_at is
  'When this record''s identity was pseudonymised under a data-subject erasure. Null for every live '
  'record. It is a marker and not the authority: the authority is the rights_resolution row, which says '
  'which request did it and what was retained. This column exists so a read path can exclude erased '
  'records without joining, and so the invariant below can be enforced.';

/**
 * The pseudonym and the erasure marker are one fact, so they may not disagree.
 *
 * Both directions are wrong in a way nothing else would catch. A row carrying the pseudonym with
 * `erased_at` null reads as a live customer whose phone number happens to be unusable — it would appear in
 * every list, and a member of staff would try to ring it. A row with `erased_at` set and a real number
 * still in place is the failure this unit exists to prevent: a completed erasure that leaves the person
 * reachable, recorded as complete.
 */
alter table customer
  add constraint customer_erasure_and_pseudonym_agree
    check ((erased_at is not null) = (phone_e164 ~ '^erased-[a-p]{32}$'));

create index customer_erased_idx on customer (erased_at) where erased_at is not null;

-- ---------------------------------------------------------------------------------------------
-- 8. Crypto-erasure of clinical data keys.
-- ---------------------------------------------------------------------------------------------

create table clinical.dek_destruction (
  id                uuid        primary key default public.uuid_generate_v7(),
  -- The two sealed tables, and no third: `contraindication_flag` holds booleans and no key, and is
  -- DELETED rather than crypto-erased (there is nothing to shred).
  target_table      text        not null
                      constraint dek_destruction_target_known
                      check (target_table in ('intake_submission', 'treatment_note')),
  record_id         uuid        not null,
  -- UUID reference only, like every other customer id in this schema: a foreign key would weld the two
  -- schemas together and defeat the relocation ADR 0010's boundary exists to enable.
  customer_id       uuid        not null,
  -- Which request authorised it. Also a plain uuid and not a foreign key ACROSS the boundary, for the same
  -- reason — the clinical schema must be relocatable without taking `public` with it.
  rights_request_id uuid        not null,
  destroyed_at      timestamptz not null,
  -- The KEK version the key was wrapped under when it was destroyed. Recorded because it is the one fact
  -- that stops a future rotation being blamed: a row whose key is gone was never re-wrapped, and this says
  -- which version it stopped at.
  kek_version_at_destruction text not null,
  constraint dek_destruction_one_per_record unique (target_table, record_id)
);

comment on table clinical.dek_destruction is
  'Every clinical data key destroyed under an erasure request, and which request authorised it. '
  'UPDATE and DELETE raise for every role including the owner. This table — not the empty wrapped key — '
  'is the AUTHORITY on whether a record was crypto-erased: the empty key is the mechanism, and a '
  'mechanism with no record beside it cannot say who decided or when.';

create index dek_destruction_customer_idx on clinical.dek_destruction (customer_id, destroyed_at desc);

create function clinical.refuse_dek_destruction_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'DekDestructionImmutable: clinical.dek_destruction is append-only; % is refused. It is the record '
    'that a person''s health data was destroyed and on whose authority, and it has to outlive every '
    'other trace of the data it is about.',
    tg_op
    using errcode = 'ZY005';
end $$;

create trigger dek_destruction_no_update before update on clinical.dek_destruction
  for each row execute function clinical.refuse_dek_destruction_change();
create trigger dek_destruction_no_delete before delete on clinical.dek_destruction
  for each row execute function clinical.refuse_dek_destruction_change();

grant select, insert on clinical.dek_destruction to berelax_clinical;

/**
 * Destroys one customer's clinical data keys, and nothing else.
 *
 * SECURITY DEFINER because 0009 revokes every privilege on the clinical schema from the application role,
 * so this is the only way an application operation can reach it — and a function that lends the application
 * write access to the most sensitive schema in the database has to earn it. Four things make it narrow
 * enough:
 *
 *   1. **It refuses without a verified erasure request in flight.** There must be a `rights_request` row
 *      for this exact customer, of type `erasure`, in state `in_progress`, with a verification method
 *      recorded. A bug in the application cannot shred a clinical record, because a bug does not first
 *      insert a request row saying it may — and the row names who asked and how they were verified.
 *   2. **It acts on one customer id**, passed as a parameter and used in every WHERE clause. There is no
 *      variant that takes a predicate.
 *   3. **It records every destruction** in the append-only table above, in the same transaction.
 *   4. **It is idempotent.** A key already destroyed is counted and skipped rather than destroyed twice,
 *      so a retried erasure does not raise on the unique index and does not double its own report.
 *
 * **It lives in `public`, not in `clinical`, and that is deliberate.** EXECUTE on a function is not enough
 * to call one: the caller also needs USAGE on the schema holding it, and granting `berelax_app` usage on
 * `clinical` would make "the application role holds no privilege on the clinical schema" stop being
 * literally true — which is the sentence `packages/db/src/clinical-boundary.itest.ts` exists to keep. It
 * would not have let the role read a table (0009 revokes those separately), so it would have been a
 * weakening nobody could see in a test, which is the worst kind. `public.customer_contraindication_flags`
 * is a SECURITY DEFINER view in `public` for exactly this reason and this follows it. The function's
 * `search_path` is pinned, so its own unqualified references cannot be captured.
 *
 * What it does NOT do is decide. The three-way clinical conflict — synthetic, real-with-override,
 * real-without — is resolved by `planClinicalErasure` in `packages/core`, and the caller passes the rows it
 * decided for. Putting that judgement in here would have hidden it inside a privileged function nobody
 * reads, and it depends on `regulatory_profile.erasure_overrides_retention`, which is a policy the owner
 * changes rather than a rule this function should own.
 */
create function public.destroy_customer_deks(
  p_customer_id       uuid,
  p_rights_request_id uuid,
  p_at                timestamptz
) returns table (target_table text, rows_destroyed integer, rows_already_destroyed integer)
language plpgsql
security definer
set search_path = clinical, public, pg_temp
as $$
declare
  v_ok boolean;
begin
  -- `merge_survivor_of(p_customer_id)` and not `= p_customer_id`, and this is a correctness fix rather
  -- than a convenience. An erasure request names ONE customer, and a record merged into that customer is
  -- the same person: a merge leaves the loser's `customer` row in place (0069) and the clinical rows
  -- captured before the merge still carry the LOSER's customer_id, because this schema resolves the
  -- tombstone on read instead of being re-pointed (0069 grants `merge_survivor_of` to berelax_clinical for
  -- exactly that). Matching the subject exactly therefore refused every merged-away id, so an honoured
  -- erasure left that record's health data readable under a key nobody had destroyed — and the engine
  -- reported a complete crypto-erasure, because it had counted only the survivor's rows.
  --
  -- The function FOLLOWS the chain and returns its input when the input is not a tombstone, so one
  -- condition covers the survivor and every record merged into it, and a record merged into somebody ELSE
  -- still resolves to that other survivor and is still refused.
  select exists (
    select 1 from public.rights_request r
     where r.id = p_rights_request_id
       and r.subject_customer_id = public.merge_survivor_of(p_customer_id)
       and r.request_type = 'erasure'
       and r.state = 'in_progress'
  ) into v_ok;

  if not v_ok then
    raise exception
      'ClinicalDekDestructionNotAuthorised: no in-progress erasure request % names customer % as its '
      'subject, or the survivor of the merge chain it belongs to. A clinical data key is destroyed only '
      'under a request that records who asked and how they were verified; there is no path that destroys '
      'one without.',
      p_rights_request_id, p_customer_id
      using errcode = 'ZY006';
  end if;

  -- `wrapped_data_key = ''` is the destroyed marker: a real wrapped key is always 60 bytes (12-byte
  -- nonce + 32-byte data key + 16-byte tag), so zero is a length `seal()` cannot produce. `kek_version`
  -- is deliberately UNCHANGED, which is what lets this statement through 0043's sealed-row trigger:
  -- `wrapped_data_key` is in its mutable set, and leaving the version alone skips the re-wrap branch that
  -- would otherwise raise ZK003 for a key that did not change onto a new version.
  return query
  with destroyed_intake as (
    update clinical.intake_submission s
       set wrapped_data_key = ''::bytea
     where s.customer_id = p_customer_id
       and length(s.wrapped_data_key) > 0
    returning s.id, s.kek_version
  ), logged_intake as (
    insert into clinical.dek_destruction
      (target_table, record_id, customer_id, rights_request_id, destroyed_at,
       kek_version_at_destruction)
    select 'intake_submission', d.id, p_customer_id, p_rights_request_id, p_at, d.kek_version
      from destroyed_intake d
    returning 1
  ), destroyed_notes as (
    update clinical.treatment_note n
       set wrapped_data_key = ''::bytea
     where n.customer_id = p_customer_id
       and length(n.wrapped_data_key) > 0
    returning n.id, n.kek_version
  ), logged_notes as (
    insert into clinical.dek_destruction
      (target_table, record_id, customer_id, rights_request_id, destroyed_at,
       kek_version_at_destruction)
    select 'treatment_note', d.id, p_customer_id, p_rights_request_id, p_at, d.kek_version
      from destroyed_notes d
    returning 1
  )
  select 'intake_submission'::text,
         (select count(*)::integer from logged_intake),
         (select count(*)::integer from clinical.intake_submission
           where customer_id = p_customer_id and length(wrapped_data_key) = 0)
           - (select count(*)::integer from logged_intake)
  union all
  select 'treatment_note'::text,
         (select count(*)::integer from logged_notes),
         (select count(*)::integer from clinical.treatment_note
           where customer_id = p_customer_id and length(wrapped_data_key) = 0)
           - (select count(*)::integer from logged_notes);
end $$;

comment on function public.destroy_customer_deks(uuid, uuid, timestamptz) is
  'Crypto-erases one customer''s clinical payloads: the ciphertext is left byte-identical and the wrapped '
  'data key is replaced with zero bytes, so nothing can decrypt it. Raises ZY006 unless an in-progress '
  'erasure request names that customer. Idempotent. SECURITY DEFINER, and in `public` rather than in '
  '`clinical`, because EXECUTE needs USAGE on the holding schema and granting that would make "the '
  'application role holds no privilege on the clinical schema" stop being true.';

grant execute on function public.destroy_customer_deks(uuid, uuid, timestamptz) to berelax_app;

/**
 * Deletes the derived contraindication booleans for one customer.
 *
 * Separate from the function above because it is a different operation on a different kind of data, and
 * collapsing the two would hide that. There is no key here to destroy — five booleans and an `updated_at`
 * — so crypto-erasure cannot apply; and leaving them would keep "this person requires consultation"
 * readable in a booking decision after the submission it was derived from had been destroyed, which is a
 * health assertion with no evidence behind it.
 *
 * 0009 revokes DELETE from `berelax_clinical` as well as everything from `berelax_app`, so SECURITY
 * DEFINER is the only route for either. The same authorisation gate applies, and it is in `public` for the
 * same schema-usage reason as its sibling above.
 */
create function public.delete_customer_contraindications(
  p_customer_id       uuid,
  p_rights_request_id uuid
) returns integer
language plpgsql
security definer
set search_path = clinical, public, pg_temp
as $$
declare
  v_ok boolean;
  v_deleted integer;
begin
  -- `merge_survivor_of` for the reason its sibling above gives at length: a record merged into the
  -- subject is the same person, and its derived flags still carry the loser's customer_id.
  select exists (
    select 1 from public.rights_request r
     where r.id = p_rights_request_id
       and r.subject_customer_id = public.merge_survivor_of(p_customer_id)
       and r.request_type = 'erasure'
       and r.state = 'in_progress'
  ) into v_ok;

  if not v_ok then
    raise exception
      'ClinicalContraindicationDeleteNotAuthorised: no in-progress erasure request % names customer % '
      'as its subject, or the survivor of the merge chain it belongs to.',
      p_rights_request_id, p_customer_id
      using errcode = 'ZY006';
  end if;

  delete from clinical.contraindication_flag where customer_id = p_customer_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.delete_customer_contraindications(uuid, uuid) is
  'Deletes the derived contraindication booleans for one customer under a verified erasure request. '
  'Raises ZY006 without one. SECURITY DEFINER: 0009 revokes DELETE from berelax_clinical and every '
  'privilege from berelax_app.';

grant execute on function public.delete_customer_contraindications(uuid, uuid) to berelax_app;

/**
 * Counts one customer's clinical rows, and says whether any payload is REAL. Reads nothing else.
 *
 * This function exists because the engine was reading the clinical schema directly and could therefore
 * only ever have run as the database OWNER. 0009 revokes every privilege on `clinical` from the
 * application role, so `select data_origin from clinical.intake_submission` — which the erasure issued on
 * every single run, before it decided anything — raised `permission denied for schema clinical` for
 * `berelax_app`. Every integration test passed because the suite connects as the owner, and
 * `rights.itest.ts` even asserted the role "cannot reach the clinical schema at all" while the engine did
 * exactly that. The privilege was right, the test was right, and the engine walked through the gap between
 * them.
 *
 * So the READS go the same way the writes already did: through a SECURITY DEFINER function in `public`,
 * for the schema-usage reason `destroy_customer_deks` sets out — granting `berelax_app` USAGE on
 * `clinical` would make "the application role holds no privilege on the clinical schema" stop being
 * literally true, which is the sentence `clinical-boundary.itest.ts` exists to keep.
 *
 * It is authorised exactly as its two siblings are, and that is deliberate although this is only a count:
 * without the check it would be a general-purpose clinical row counter available to the application role
 * at any time, which is a narrower disclosure than the payloads but not one anybody asked for. With it,
 * "no clinical access without a verified erasure request in flight" stays literally true of every route.
 *
 * It takes ONE customer id, like both siblings, so the caller loops over the merge lineage and each id is
 * authorised on its own. It discloses no health content: four counts and a boolean saying whether a
 * payload is a fixture.
 */
create function public.clinical_erasure_census(
  p_customer_id       uuid,
  p_rights_request_id uuid
) returns table (
  has_real_payload  boolean,
  intake_rows       integer,
  note_rows         integer,
  consent_rows      integer,
  destruction_rows  integer
)
language plpgsql
security definer
set search_path = clinical, public, pg_temp
as $$
declare
  v_ok boolean;
begin
  select exists (
    select 1 from public.rights_request r
     where r.id = p_rights_request_id
       and r.subject_customer_id = public.merge_survivor_of(p_customer_id)
       and r.request_type = 'erasure'
       and r.state = 'in_progress'
  ) into v_ok;

  if not v_ok then
    raise exception
      'ClinicalCensusNotAuthorised: no in-progress erasure request % names customer % as its subject, or '
      'the survivor of the merge chain it belongs to. The clinical schema is not readable by the '
      'application role outside a verified erasure request.',
      p_rights_request_id, p_customer_id
      using errcode = 'ZY006';
  end if;

  return query
  select
    exists (select 1 from clinical.intake_submission
             where customer_id = p_customer_id and data_origin = 'real'),
    (select count(*)::integer from clinical.intake_submission  where customer_id = p_customer_id),
    (select count(*)::integer from clinical.treatment_note     where customer_id = p_customer_id),
    (select count(*)::integer from clinical.treatment_consent  where customer_id = p_customer_id),
    (select count(*)::integer from clinical.dek_destruction    where customer_id = p_customer_id);
end $$;

comment on function public.clinical_erasure_census(uuid, uuid) is
  'Counts one customer''s clinical rows and reports whether any intake payload is real, under the same '
  'authorisation gate as destroy_customer_deks. SECURITY DEFINER and in `public` because the application '
  'role holds no privilege on the clinical schema: without this the erasure engine could only run as the '
  'database owner, which is how it shipped until the app-role case in rights.itest.ts was written.';

grant execute on function public.clinical_erasure_census(uuid, uuid) to berelax_app;

/**
 * Removes one customer from the two CRM workflows a DELETE was revoked on, under the erasure gate.
 *
 * ## Why this function has to exist at all
 *
 * `flow_enrolment` (0070) and `customer_pipeline_card` (0077) both revoke DELETE from `berelax_app`, and
 * both give the same reason in almost the same words: *"DELETE has no legitimate caller; the cascade from
 * `customer` still works, because a referential action runs with the privileges of the referencing table's
 * owner rather than the caller's."*
 *
 * That reasoning is sound and its premise does not hold for an erasure. **An erasure cannot delete the
 * `customer` row** — `invoice.customer_id` names it and an issued tax document must be kept for the
 * statutory period — so it pseudonymises instead, and the cascade those two migrations were relying on
 * never runs. Without this function a completed erasure leaves the person on a sales board a human drags
 * cards around, and inside a marketing automation that goes on stepping. Neither is a statutory record and
 * neither has any purpose once there is nobody to serve.
 *
 * ## Why it is a gated function and NOT a grant
 *
 * Granting `berelax_app` blanket DELETE on these tables would undo exactly what 0070 and 0077 were
 * protecting: any request handler, not just an erasure, could then remove a card or an enrolment and leave
 * "not on the board" and "never was" indistinguishable. What those migrations said was that DELETE has no
 * legitimate caller. This is one — a named, single-row, authorised caller — so it is added as a caller
 * rather than as a privilege. That is `destroy_customer_deks`'s argument above, applied to a `public`
 * table for a different reason: there the schema is unreachable, here the verb is.
 *
 * ## `p_target` is a BRANCH SELECTOR, not dynamic SQL
 *
 * Both statements below are static and fully qualified; the parameter only chooses which one runs, and an
 * unrecognised value raises. There is no `execute`, no `format`, no identifier interpolation — so widening
 * this function to a third table is a visible edit to this file rather than a new string a caller may pass.
 * One function rather than two because the gate is the part worth having once: two copies of an
 * authorisation check are two things that can come to disagree, which is the defect the erasure rule
 * registry exists to refuse elsewhere in this unit.
 */
create function public.erase_customer_workflow_rows(
  p_customer_id       uuid,
  p_rights_request_id uuid,
  p_target            text
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok      boolean;
  v_deleted integer;
begin
  -- The same gate, and the same `merge_survivor_of` reason, as `destroy_customer_deks`: a record merged
  -- into the subject is the same person, the tombstone keeps its own id (0069), and matching the subject
  -- exactly would refuse every merged-away id — leaving that record on the board under an honoured erasure.
  select exists (
    select 1 from public.rights_request r
     where r.id = p_rights_request_id
       and r.subject_customer_id = public.merge_survivor_of(p_customer_id)
       and r.request_type = 'erasure'
       and r.state = 'in_progress'
  ) into v_ok;

  if not v_ok then
    raise exception
      'ErasureWorkflowRemovalNotAuthorised: no in-progress erasure request % names customer % as its '
      'subject, or the survivor of the merge chain it belongs to. 0070 and 0077 revoke DELETE on these '
      'tables from the application role; this function is the one authorised caller, not a way around '
      'that.',
      p_rights_request_id, p_customer_id
      using errcode = 'ZY007';
  end if;

  if p_target = 'flow_enrolment' then
    delete from public.flow_enrolment where customer_id = p_customer_id;
  elsif p_target = 'customer_pipeline_card' then
    delete from public.customer_pipeline_card where customer_id = p_customer_id;
  else
    raise exception
      'ErasureWorkflowTargetUnknown: % is not one of the two tables this function removes rows from. '
      'The target chooses a static statement; it is not an identifier this function will interpolate.',
      p_target
      using errcode = 'ZY008';
  end if;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.erase_customer_workflow_rows(uuid, uuid, text) is
  'Deletes one customer''s flow_enrolment or customer_pipeline_card rows under a verified in-progress '
  'erasure request. SECURITY DEFINER because 0070 and 0077 revoke DELETE on those tables from '
  'berelax_app on the stated grounds that removal happens by cascade from `customer` - which an erasure '
  'cannot do, because a retained tax invoice references that row. Raises ZY007 without an authorising '
  'request and ZY008 for an unknown target.';

grant execute on function public.erase_customer_workflow_rows(uuid, uuid, text) to berelax_app;

-- ---------------------------------------------------------------------------------------------
-- 9. The retention purge's agent, so the pass is watched and capped.
-- ---------------------------------------------------------------------------------------------
--
-- A cron with no `agent_definition` row is a cron nobody watches and nothing caps, which is the failure
-- G-AGT-01 exists to remove and `pnpm jobs` refuses statically. The declared interval is what makes the
-- watchdog's "no success within twice the interval" alert mean something: 24 hours, so a purge that has
-- not run for two days raises.
--
-- The budget is 0 fils. The purge makes no external call and consults no model; a non-zero budget would
-- suggest it spends something and would make the spend report wrong about where money goes.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('retention_purge', 'Retention purge',
   'Anonymises or deletes rows past their retention period, per data class, skipping and reporting '
   'anything under legal hold (C-CRM-10, docs/04 §8).',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- 0031's note, which is the one every later agent has to repeat: `agentsWithHeartbeat` INNER joins, so an
-- agent with no heartbeat row does not appear — and an agent that does not appear is one the watchdog
-- silently never checks.
insert into agent_heartbeat (agent_key) values ('retention_purge')
on conflict (agent_key) do nothing;

commit;

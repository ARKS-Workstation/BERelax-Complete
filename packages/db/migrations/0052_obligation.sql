-- 0052 — the compliance calendar: obligation definitions, their dated instances, and the blocking
-- behaviour that gives the module its value.
--
-- docs/04 §9 is the specification and it is one paragraph: "Obligation definitions (statutory,
-- recurring or event-driven) generate dated instances with multi-step reminders, escalation if
-- unacknowledged, and evidence attachment. Some obligations are blocking: an overdue blocking
-- obligation changes system behaviour — a therapist leaves bookable availability, publishing is
-- blocked, the owner sees a banner."
--
-- Abu Dhabi, not Dubai (docs/04 §1, docs/13 §1): the authorities named in the seeded rows are ADDED,
-- Abu Dhabi Municipality, DoH Abu Dhabi, MOHRE and the FTA. No Dubai DET or DHA obligation exists here.
--
-- ## What this migration refuses, and why each refusal is in the database
--
--   1. **A blocking flag anything can switch off.** `is_blocking` is GENERATED from `blocking_effect`,
--      so no writer can set it, disagree with it or forget it — the same technique 0050 used for
--      `employee.is_publishable`. That closes the direct route; `refuse_obligation_shape_change()`
--      closes the indirect one by refusing an UPDATE that changes ANY column but the due date. A
--      settings key that turned blocking off would therefore have to be a migration, which is a
--      reviewed act, and not a row in `app_setting`, which is a screen.
--   2. **A completion by the wrong role, or with no evidence.** Both are enforced by a trigger rather
--      than by the service that writes the row: the service is one caller, and a `psql` session, a
--      later admin tool and a background job are three more. The refusals are named in the message
--      (`RoleNotPermitted`, `EvidenceRequired`) and carried as SQLSTATEs so TypeScript matches on the
--      code and never on the wording.
--   3. **An invented renewal date.** `obligation.anchor_on` is NULL on every seeded row. The build has
--      not seen the trade licence, the municipality permit or a therapist's certificate, so it does not
--      know when any of them expires — and a plausible date would be indistinguishable from one read
--      off the document (rule 15, `is_placeholder_text`, 0026). NULL generates no instances and is
--      visibly unanswered; the first real due date arrives through the audited due-date writer.
--
-- ## Instances are generated, and the arithmetic is NOT here
--
-- `packages/core/src/compliance/obligation.ts` computes which dates a cadence falls due on over a
-- horizon; this schema stores the answer. That is the same division `business_day` uses (horizon.ts
-- computes, the job writes) and it is the one `pnpm boundaries` enforces: `packages/db` may never
-- import `packages/core`, so a second implementation in SQL would be a second answer to "when is this
-- due" — and the day the two disagree is the day a blocking obligation blocks on a date nobody expected.
-- Idempotence is the schema's half: `obligation_instance_one_per_due_date` is UNIQUE NULLS NOT
-- DISTINCT, so re-running generation over the same horizon inserts nothing and the rows — ids and
-- creation instants included — are byte-identical to the first run's.
--
-- ## Dates, not instants, and the trading date is the unit of comparison
--
-- `due_on` and `anchor_on` are `date`, for the reason `employee_document.expires_on` is: an obligation
-- falls due at the end of a day, which is what the renewal notice says. Overdue is decided against the
-- TRADING date and never the calendar date — trading runs 11:00–02:00 (0011), so at 01:30 the business
-- is still working the previous trading date and an obligation due that date is not yet overdue.
-- `resolveTradingDate` in `@berelax/core` is the one implementation of that rule; every reader here
-- takes the trading date as an argument.

begin;

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
-- What kind of obligation this is. Enums rather than free text for the reason
-- `employee_document_type` gives: the blocking consequence is CHECKed against the class below, and a
-- class spelled two ways is a blocking rule that silently applies to nothing.
create type obligation_class as enum (
  'licence',    -- the trade licence and the permits that let the premises trade at all (docs/04 §9)
  'credential', -- a person's licence, certificate or permit (docs/04 §7)
  'hygiene',    -- inspection records, sanitation and linen logs, water safety (docs/04 §9)
  'tax',        -- returns and filings (docs/04 §4)
  'labour'      -- MOHRE and WPS duties that are not a single person's credential (docs/04 §7)
);

comment on type obligation_class is
  'What kind of duty this is. The BLOCKING CONSEQUENCE is constrained against it: only a credential '
  'obligation may take a therapist out of availability, and only a licence obligation may block '
  'publishing. A third consequence is a migration, not a row.';

create type obligation_cadence as enum ('monthly', 'quarterly', 'annual', 'event_driven');

comment on type obligation_cadence is
  'How the next instance is dated. event_driven generates NO instance from a cadence: its due date '
  'comes from the event (a renewal notice, a document expiry), and generating one on a guessed '
  'interval would put a date in the calendar that nothing on file supports.';

-- The consequence of this obligation being overdue. NOT a boolean plus a comment: "blocking" alone
-- cannot say WHICH behaviour changes, and the two behaviours are enforced in two different code paths
-- — the availability read and the publication guard. A flag would leave the pairing to a `case`
-- somewhere, which is where the third caller gets it wrong.
create type obligation_blocking_effect as enum (
  'none',
  'therapist_unbookable',
  'publishing_blocked'
);

comment on type obligation_blocking_effect is
  'none | therapist_unbookable | publishing_blocked. Read by the availability exclusion '
  '(overdueBlockingObligationExclusion) and by the publication guard (assertPublishingNotBlocked). '
  'is_blocking is GENERATED from it, so nothing can hold a flag that disagrees with the consequence.';

create type obligation_subject_scope as enum ('business', 'therapist');

comment on type obligation_subject_scope is
  'Whether one instance covers the business or one covers each therapist. A credential obligation is '
  'per therapist, because the overdue one takes THAT therapist out of availability and no one else.';

create type obligation_instance_status as enum ('open', 'completed');

-- ---------------------------------------------------------------------------------------------
-- obligation — the definitions
-- ---------------------------------------------------------------------------------------------
create table obligation (
  id                uuid                     primary key default uuid_generate_v7(),

  -- The stable handle. Named in refusals, in tests and in the calendar UI, so it may never be a
  -- generated id: `PublishingBlocked: trade_licence_renewal is overdue` is actionable and a UUID is not.
  key               text                     not null unique
                      constraint obligation_key_shape
                      check (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  title             text                     not null
                      constraint obligation_title_not_placeholder
                      check (not is_placeholder_text(title)),
  obligation_class  obligation_class         not null,
  cadence           obligation_cadence       not null,
  subject_scope     obligation_subject_scope not null,

  -- Who owes it. Text with a CHECK restating the F07 vocabulary rather than an enum, exactly as
  -- `appointment_status_history.actor_role` (0046) does and for the same reason: the database cannot
  -- import the policy layer, and a role the list does not know is worse than a duplicated list. The
  -- duplication is made safe by packages/fixtures/src/obligation-calendar.itest.ts, which parses this
  -- constraint out of pg_constraint and asserts its accepted set equals ROLES in both directions.
  owner_role        text                     not null
                      constraint obligation_owner_role_known
                      check (owner_role in
                        ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer',
                         'auditor', 'system')),

  blocking_effect   obligation_blocking_effect not null default 'none',

  -- GENERATED, so there is no writer at all. A boolean column here would be one UPDATE — or one
  -- settings screen — away from switching a compliance control off, and the whole value of this unit is
  -- that it cannot be switched off from settings.
  is_blocking       boolean                  not null
                      generated always as (blocking_effect <> 'none') stored,

  -- Whether completing an instance requires an attachment. A photographed inspection sheet is what an
  -- inspection asks for; a tick in a box is not.
  evidence_required boolean                  not null,

  -- Our reading of secondary sources, not a confirmed legal duty. docs/04 marks these [UNVERIFIED] and
  -- M-VAT-11's open-compliance-questions dashboard is driven by this flag, which is why it is a column
  -- on the obligation rather than a note in a document: an unresolved legal question stays visible in
  -- the product instead of being lost in docs/04.
  --
  -- Deliberately NOT named `is_provisional`. That trio (0010, 0017, 0025) means "the build chose this
  -- VALUE because no answer existed"; this means "the duty itself is our reading of a secondary
  -- source". A confirmed obligation may still have no due date on file, and one flag covering both
  -- would clear the dashboard for an answer nobody gave.
  is_unverified     boolean                  not null default false,
  unverified_note   text,
  open_question_id  text,

  -- Where the duty is written down, so a reader can check it. A document section, never prose.
  source_reference  text                     not null
                      constraint obligation_source_reference_not_placeholder
                      check (not is_placeholder_text(source_reference)),

  -- The authority that owes the answer. NULL where the build has not been told which body it is —
  -- naming a plausible one is the defect rule 15 describes, and it reads as configured.
  authority         text
                      constraint obligation_authority_not_placeholder
                      check (authority is null or not is_placeholder_text(authority)),

  -- The FIRST due date, and the only column an UPDATE may change. NULL on every seeded row: see the
  -- header. Generation over a horizon steps from this date, so a NULL anchor produces no instances
  -- rather than a calendar of invented dates.
  anchor_on         date,

  created_at        timestamptz              not null default now(),
  updated_at        timestamptz              not null default now(),

  -- An unverified duty without its open question is invisible on the dashboard that exists to show it.
  constraint obligation_unverified_names_a_question
    check (not is_unverified or (open_question_id is not null and unverified_note is not null)),
  constraint obligation_unverified_note_nonempty
    check (unverified_note is null or btrim(unverified_note) <> ''),

  -- The two blocking consequences, each tied to the class that can carry it. docs/04 §9 names exactly
  -- these two behaviours, and the manifest's acceptance pairs them with these two classes: an overdue
  -- CREDENTIAL obligation removes the affected therapist from availability, an overdue LICENCE
  -- obligation blocks publishing. A hygiene log that silently stopped a booking would be a blocking
  -- rule nobody declared.
  constraint obligation_blocking_effect_matches_class
    check (
      blocking_effect = 'none'
      or (blocking_effect = 'therapist_unbookable' and obligation_class = 'credential')
      or (blocking_effect = 'publishing_blocked'   and obligation_class = 'licence')
    ),
  -- An obligation that takes ONE therapist out of availability has to be about one therapist. A
  -- business-scoped credential obligation would either block everybody or nobody, and which of the two
  -- it did would depend on a join.
  constraint obligation_therapist_effect_is_per_therapist
    check (blocking_effect <> 'therapist_unbookable' or subject_scope = 'therapist')
);

comment on table obligation is
  'Statutory and operational obligation definitions (docs/04 §9). The blocking ones change system '
  'behaviour when overdue and cannot be switched off from settings: is_blocking is GENERATED and '
  'refuse_obligation_shape_change() refuses an UPDATE to anything but the due date.';
comment on column obligation.anchor_on is
  'The first due date. NULL until somebody reads it off the licence, permit or certificate — the build '
  'has seen none of them, and a plausible renewal date is indistinguishable from a configured one. '
  'Changed only through the audited due-date writer, which is the only permitted UPDATE on this table.';
comment on column obligation.is_blocking is
  'GENERATED from blocking_effect. There is no writer, which is the point: a compliance control with a '
  'settings writer is a compliance control with an off switch.';

create index obligation_blocking_idx on obligation (blocking_effect) where is_blocking;

-- ---------------------------------------------------------------------------------------------
-- obligation_instance — the dated occurrences
-- ---------------------------------------------------------------------------------------------
create table obligation_instance (
  id                  uuid                       primary key default uuid_generate_v7(),
  obligation_id       uuid                       not null references obligation (id) on delete restrict,

  -- The therapist this occurrence is about, for a per-therapist obligation. NULL for a business-wide
  -- one, and `nulls not distinct` below is what keeps the generator idempotent across both.
  subject_employee_id uuid                       references employee (id) on delete restrict,

  due_on              date                       not null,
  status              obligation_instance_status  not null default 'open',

  completed_at        timestamptz,
  completed_by_role   text
                        constraint obligation_instance_completed_by_role_known
                        check (completed_by_role is null or completed_by_role in
                          ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer',
                           'auditor', 'system')),
  completed_by_label  text
                        constraint obligation_instance_completed_by_label_nonempty
                        check (completed_by_label is null or btrim(completed_by_label) <> ''),

  created_at          timestamptz                not null default now(),
  updated_at          timestamptz                not null default now(),

  -- One occurrence per (obligation, subject, due date). NULLS NOT DISTINCT because the subject is NULL
  -- for a business-wide obligation and the default NULL-is-distinct reading would let the generator
  -- insert the trade-licence renewal again on every run — which is exactly the determinism the
  -- acceptance asks for, expressed as a constraint rather than as a convention in the writer.
  constraint obligation_instance_one_per_due_date
    unique nulls not distinct (obligation_id, subject_employee_id, due_on),

  -- A completed row with no instant, or an instant with no completion, is half a fact.
  constraint obligation_instance_completion_is_whole
    check ((status = 'completed') = (completed_at is not null)),
  -- Who completed it is part of completing it: the role is what the trigger below checks against the
  -- declared owner, so a completion with no role recorded is a completion nothing authorised.
  constraint obligation_instance_completion_has_an_actor
    check (status <> 'completed' or (completed_by_role is not null and completed_by_label is not null))
);

comment on table obligation_instance is
  'One dated occurrence of an obligation. Generated deterministically over a horizon from the '
  'definition''s anchor date by packages/core/src/compliance/obligation.ts; re-running the generator '
  'inserts nothing.';
comment on column obligation_instance.due_on is
  'Compared against the TRADING date, never the calendar date: trading runs 11:00–02:00, so at 01:30 '
  'the business is still working the previous trading date and an obligation due that date is not yet '
  'overdue.';

create index obligation_instance_open_due_idx
  on obligation_instance (due_on, obligation_id)
  where status = 'open';
create index obligation_instance_subject_idx
  on obligation_instance (subject_employee_id)
  where subject_employee_id is not null;

create trigger obligation_updated_at before update on obligation
  for each row execute function set_updated_at();
create trigger obligation_instance_updated_at before update on obligation_instance
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- obligation_evidence — what was filed against a completion
-- ---------------------------------------------------------------------------------------------
-- The minimum M-VAT-10 needs to make `EvidenceRequired` a fact the database holds rather than a
-- convention in a service: a completion that requires evidence must have a row here first. M-VAT-11
-- owns serving these privately by signed URL and auditing every download; the storage key and the
-- content hash are here now because the completion check needs something real to join to, and a
-- nullable text column on the instance would be a reference to nothing.
create table obligation_evidence (
  id                     uuid        primary key default uuid_generate_v7(),
  obligation_instance_id uuid        not null references obligation_instance (id) on delete restrict,

  -- Where the file is, in the private bucket. Never a public URL: evidence of a hygiene inspection
  -- names the premises and the inspector.
  storage_key            text        not null
                           constraint obligation_evidence_storage_key_not_placeholder
                           check (not is_placeholder_text(storage_key)),
  -- So a re-upload of the same file is recognisable and a substituted one is not.
  content_hash           text        not null
                           constraint obligation_evidence_content_hash_shape
                           check (content_hash ~ '^[a-f0-9]{64}$'),
  uploaded_at            timestamptz not null default now(),
  uploaded_by_label      text        not null
                           constraint obligation_evidence_uploaded_by_label_nonempty
                           check (btrim(uploaded_by_label) <> ''),

  constraint obligation_evidence_one_row_per_file
    unique (obligation_instance_id, content_hash)
);

comment on table obligation_evidence is
  'Attachments filed against an obligation instance. Append-only: UPDATE and DELETE raise. Evidence '
  'that can be edited after the fact is not evidence, and an inspection asks for what was filed at the '
  'time rather than for what somebody would file today.';

create function refuse_obligation_evidence_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'obligation_evidence is append-only; % is refused. What was filed against a completion is the '
    'record of what was filed, and a corrected attachment is a new row.',
    tg_op
    using errcode = 'ZO004';
end $$;

comment on function refuse_obligation_evidence_change() is
  'Raises ZO004 for every role. A trigger and not `create rule ... do instead nothing`, because a rule '
  'reports success and the caller believes the substitution happened.';

create trigger obligation_evidence_no_update before update on obligation_evidence
  for each row execute function refuse_obligation_evidence_change();
create trigger obligation_evidence_no_delete before delete on obligation_evidence
  for each row execute function refuse_obligation_evidence_change();

-- ---------------------------------------------------------------------------------------------
-- The blocking flag has no writer
-- ---------------------------------------------------------------------------------------------
-- `is_blocking` is GENERATED, so the direct route is closed by the column definition. This closes the
-- indirect one: changing `blocking_effect` would change the generated flag, and so would retyping the
-- obligation's class.
--
-- Written as a `to_jsonb` difference rather than as a list of `is distinct from` comparisons, which is
-- the technique 0043 uses for the re-wrap guard and for the same reason: a column some later migration
-- adds to this table is covered the day it appears rather than the day somebody remembers to extend a
-- column list. The due date is the one exception, because it is the one thing about an obligation that
-- legitimately changes — a licence is renewed and the next renewal is a year later — and `updated_at`
-- is excluded because the `set_updated_at` trigger above writes it on the same statement.
-- `is_blocking` is subtracted as well, and NOT because it is allowed to change — it is GENERATED and
-- nothing can write it. It is subtracted because PostgreSQL computes a generated column AFTER the BEFORE
-- triggers have run, so inside this function `new.is_blocking` is NULL while `old.is_blocking` is the
-- stored value: comparing them would make EVERY update to this table fail, including the due-date change
-- that is the one thing permitted. It cost a run to find, and the flag is covered anyway because
-- `blocking_effect`, the column it is generated from, is compared.
create function refuse_obligation_shape_change() returns trigger
language plpgsql
as $$
declare
  v_before jsonb := to_jsonb(old) - 'anchor_on' - 'updated_at' - 'is_blocking';
  v_after  jsonb := to_jsonb(new) - 'anchor_on' - 'updated_at' - 'is_blocking';
begin
  if v_before = v_after then
    return new;
  end if;

  raise exception
    'ObligationShapeIsNotConfigurable: "%" may only have its due date changed. Whether an obligation '
    'blocks, and what it blocks, is not configuration: it follows from the licence and the duty, and a '
    'compliance control with an off switch is one somebody switches off at 23:00 to take a booking.',
    old.key
    using errcode = 'ZO003',
          hint = 'Only anchor_on may be updated. A changed duty is a new migration and a reviewed act.';
end $$;

comment on function refuse_obligation_shape_change() is
  'Raises ZO003 for every role. The reason it compares to_jsonb rather than named columns: a column '
  'added by a later migration is covered the day it appears.';

create trigger obligation_shape_is_fixed before update on obligation
  for each row execute function refuse_obligation_shape_change();

-- ---------------------------------------------------------------------------------------------
-- Completion requires the declared role, and the evidence the definition demands
-- ---------------------------------------------------------------------------------------------
-- In the database and not only in the service, because the service is one caller. `psql`, a migration,
-- a later admin screen and a background job are four more, and a compliance control that holds for one
-- of five callers is a convention.
--
-- The owner is permitted alongside the declared role. ROLE_DEFINITIONS gives `owner` every permission
-- by definition (packages/core/src/access/permissions.ts), and a rule that locked the proprietor out of
-- their own compliance calendar would be worked around by reassigning the obligation — which loses the
-- declared owner as well as the refusal.
create function assert_obligation_completion_is_permitted() returns trigger
language plpgsql
as $$
declare
  v_key      text;
  v_role     text;
  v_evidence boolean;
begin
  -- Only the transition INTO completed is judged. A due-date correction on an already-completed row,
  -- or any other UPDATE, is not a completion and must not be refused for want of a role.
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  select o.key, o.owner_role, o.evidence_required
    into v_key, v_role, v_evidence
    from obligation o
   where o.id = new.obligation_id;

  if new.completed_by_role <> v_role and new.completed_by_role <> 'owner' then
    raise exception
      'RoleNotPermitted: "%" is owed by the % and was completed as %. The declared owner is part of '
      'the obligation, not a label on it: an inspection asks who signed the log off.',
      v_key, v_role, new.completed_by_role
      using errcode = 'ZO001',
            hint = 'Complete it as the declared owner role, or as the owner.';
  end if;

  if v_evidence and not exists (
    select 1 from obligation_evidence e where e.obligation_instance_id = new.id
  ) then
    raise exception
      'EvidenceRequired: "%" requires an attachment and none is filed against this occurrence. A tick '
      'in a box is not what an inspection asks for.',
      v_key
      using errcode = 'ZO002',
            hint = 'File the evidence against the instance first, then complete it.';
  end if;

  return new;
end $$;

comment on function assert_obligation_completion_is_permitted() is
  'Raises ZO001 (RoleNotPermitted) and ZO002 (EvidenceRequired) on the transition into completed, for '
  'every role. The service maps the SQLSTATE to a named refusal; nothing matches on the message.';

create trigger obligation_instance_completion_is_permitted
  before update on obligation_instance
  for each row execute function assert_obligation_completion_is_permitted();

-- ---------------------------------------------------------------------------------------------
-- The seeded obligations
-- ---------------------------------------------------------------------------------------------
-- Seeded by the MIGRATION rather than by `pnpm seed`, for the reason 0004 seeds the regulatory profile:
-- a compliance calendar that exists only in a seeded database is a compliance calendar production can
-- be missing. Every row carries its cadence, owner role, blocking consequence, evidence requirement
-- and unverified flag, and none carries a date — see the header.
--
-- The authorities are the Abu Dhabi ones (docs/04 §1, docs/13 §1). No licence number, permit number or
-- TRN appears anywhere in this table: those are Y1-trn and Y1-licence, and a plausible one is worse
-- than a blank one.
insert into obligation (
  key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
  evidence_required, is_unverified, unverified_note, open_question_id, source_reference, authority
) values
  (
    'trade_licence_renewal',
    'Renew the ADDED trade licence',
    'licence', 'annual', 'business', 'owner', 'publishing_blocked',
    true, false, null, null,
    'docs/04-uae-compliance.md §9; docs/13-business-profile.md §1',
    'ADDED'
  ),
  (
    'municipality_health_permit_renewal',
    'Renew the Abu Dhabi Municipality health approval for the premises',
    'licence', 'annual', 'business', 'owner', 'publishing_blocked',
    true, true,
    'docs/04 §1 names the municipality health approval alongside the ADDED trade licence under a '
      'commercial wellness classification. Whether it is a separate permit with its own renewal, and '
      'at what interval, follows the licence classification nobody has confirmed.',
    'Y1-licence',
    'docs/04-uae-compliance.md §1, §9',
    'Abu Dhabi Municipality'
  ),
  (
    'hygiene_inspection_log_review',
    'Review the hygiene, linen, waste and equipment sanitation logs',
    'hygiene', 'monthly', 'business', 'manager', 'none',
    true, true,
    'docs/04 §9 lists municipality hygiene inspection records, linen and waste handling, equipment '
      'sanitation logs and water safety. The review interval an inspection expects is not stated in '
      'any source the build has, so monthly is the conservative reading and not a confirmed duty.',
    'Y1-licence',
    'docs/04-uae-compliance.md §9',
    'Abu Dhabi Municipality'
  ),
  (
    'therapist_professional_licence_renewal',
    'Renew each therapist''s professional practice licence',
    'credential', 'annual', 'therapist', 'manager', 'therapist_unbookable',
    true, true,
    'docs/04 §1: individually licensed practitioners are required under a HEALTHCARE classification '
      'and not under a commercial wellness one. Whether this obligation applies at all, and to whom, '
      'is the licence question; the renewal interval is unconfirmed with it.',
    'Y1-licence',
    'docs/04-uae-compliance.md §1, §7',
    'DoH Abu Dhabi'
  ),
  (
    'therapist_health_certificate_renewal',
    'Renew each therapist''s occupational health card and medical fitness certificate',
    'credential', 'annual', 'therapist', 'manager', 'therapist_unbookable',
    true, true,
    'docs/04 §7 marks the occupational health card, medical fitness test, good-conduct certificate and '
      'screening requirements [UNVERIFIED], "with renewal intervals" explicitly unknown. Annual is the '
      'conservative reading; the certificate expiry on file is what the calendar should follow once '
      'there is one.',
    'Y1-licence',
    'docs/04-uae-compliance.md §7',
    'Abu Dhabi Municipality'
  ),
  (
    'therapist_work_permit_renewal',
    'Renew each therapist''s MOHRE work permit, with the profession matching the work performed',
    'credential', 'event_driven', 'therapist', 'manager', 'therapist_unbookable',
    true, true,
    'docs/04 §7: the profession on the permit must match the work performed AND the licence '
      'classification, so whether a therapist''s permit is valid for the work is unanswered while the '
      'classification is. The permit''s own expiry dates the obligation, which is why the cadence is '
      'event_driven rather than an interval nothing on file supports.',
    'Y1-licence',
    'docs/04-uae-compliance.md §7',
    'MOHRE'
  ),
  (
    'vat_return_filing',
    'Prepare and file the VAT return working papers with preparer and reviewer sign-off',
    'tax', 'quarterly', 'business', 'accountant', 'none',
    true, true,
    'docs/04 §4: VAT201 is produced as working papers with drill-down and sign-off, and the codebase '
      'contains no auto-file capability. The filing FREQUENCY is assigned by the FTA per registrant '
      'and is not on file, so quarterly is the common case and not a confirmed obligation.',
    'Y11-tax-agent',
    'docs/04-uae-compliance.md §4',
    'FTA'
  );

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on every table
-- created in public afterwards, so these revokes are load-bearing rather than decorative.
--
-- DELETE on `obligation` goes because a deleted obligation is a compliance control that stops existing
-- with no trace — the quiet version of the off switch this migration exists to refuse. An obligation
-- that no longer applies is a decision for a migration, which leaves a record.
revoke delete, truncate on obligation from berelax_app;
revoke update, delete, truncate on obligation_evidence from berelax_app;
revoke truncate on obligation_instance from berelax_app;
-- DELETE on an instance stays granted: an instance generated against a horizon that later changed is
-- data the generator may withdraw, and withdrawing a future occurrence is not rewriting a record. A
-- COMPLETED one is protected by its evidence, which cannot be deleted.

commit;

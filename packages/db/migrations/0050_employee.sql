-- 0050 — the employment record, and staff PII under field-level envelope encryption.
--
-- docs/04 §7 states the requirement in one sentence: "field-level encryption plus separate access
-- control on identity document numbers and bank details, with every read audited." This migration is
-- the storage half of it. The access control is `packages/core/src/hr/employee.ts` (deny-by-default,
-- field group per field) and the audited read is `packages/hr/src/employee-repository.ts`.
--
-- ## Expand-only over 0030, deliberately
--
-- B-AVAIL-04 created `employee`, `employee_skill`, `shift`, `shift_assignment`, `leave_request` and
-- `employee_document` as the therapist side of availability, and its NOTE hands this unit the seam:
-- "P-HR extends employee, employee_skill, shift, shift_assignment, leave_request and employee_document
-- rather than introducing its own tables." So there is no second `staff` table here and no second
-- answer to "is this therapist bookable". Every statement below either ADDs a column to an existing
-- table or creates a new one that references it; nothing is dropped, renamed or retyped, and the
-- eligibility read of 0030 keeps working unchanged against the same rows.
--
-- ## The three things this schema refuses, and why each is in the database
--
--   1. **A published therapist page with no consent.** 0030 deliberately left `display_name` out,
--      because "a nullable one is what an admin screen fills in without a consent row, and the guard
--      would be invisible". The column arrives here WITH the guard: `is_publishable` is GENERATED from
--      `display_name is not null and photo_consent`, so no caller can set it, disagree with it or
--      forget it. ADR 0020 is the rule; `isPublishable()` in packages/fixtures/src/salon.ts is the
--      same predicate on the fixture side, and now there is one spelling of it the database owns.
--   2. **An identity number in a plaintext column.** `employee_document.reference` (0030) is free
--      text for a licence or certificate number. An Emirates ID or passport number filed there would
--      be the exact disclosure the envelope exists to prevent, and it would look like ordinary data
--      entry. `employee_document_identity_number_is_encrypted` refuses it: for the two identity types
--      the number goes in `number_ct` or nowhere.
--   3. **A re-wrap that rewrites a ciphertext.** 0043 established the technique for the clinical
--      estate and this reuses it, including the `to_jsonb(new)` versus `to_jsonb(old)` comparison, so
--      a column some later migration adds to a sealed table is covered the day it appears rather than
--      the day somebody remembers to extend a column list.
--
-- ## A THIRD key-encrypting key, and what that costs
--
-- H-HARD-03 answered G-CONN-04 with two KEKs — clinical and Google — and the argument it used decides
-- this one too. The clinical store is designed to relocate to a UAE-hosted database and takes its key
-- with it (ADR 0010, Y5-residency); an employment record does not move with it. Sealing staff PII
-- under `CLINICAL_KEK` would either strand the staff estate at relocation or require the clinical key
-- to exist in two places, which is the coupling that decision exists to avoid. So the sealed columns
-- here name a version label from `STAFF_PII_KEK` (build/secret-inventory.json,
-- docs/runbooks/key-rotation.md#rotating-the-staff-pii-kek).
--
-- The cost is stated rather than hidden: `scripts/rotate-kek.mjs` cannot rotate these columns. Its
-- table list is a literal union of the two clinical tables, every query in
-- packages/clinical/src/crypto/postgres-key-store.ts names `customer_id`, and its registry is
-- `clinical.kek_version` — which lives in the clinical schema precisely so that it moves with the
-- store. Widening that command to reach this estate would also put two of the three most sensitive
-- keys in the system in one process, which is the thing H-HARD-03 refused to do for the Google key
-- ("one function reaching both would put the two most sensitive keys in the system in the same
-- process for no reason"). The per-row primitive exists — `rewrapStaffSecret` in
-- packages/hr/src/staff-secret.ts, the same shape packages/google/src/rewrap.ts has — and the command
-- that drives it is deferred, exactly as the Google one is. There is therefore also NO
-- `staff_pii_kek_version` registry here: its whole purpose is to refuse a RETIRED key for encryption,
-- and retirement is not a state anything can reach until a rotation exists to create it. The future
-- unit that writes the command adds the registry and the ZS001 check that reads it.
--
-- ## What the seed does NOT invent
--
-- The 19 therapists are real, identifiable people (19 photographs in assets/media/, Y12-consent-photo)
-- and the handover has supplied nothing about them but the headcount. `packages/db/src/seed/therapists.ts`
-- writes 19 employment records with `display_name` NULL, `photo_consent` false, gender NULL, contract
-- type NULL and every wage column NULL, flagged `is_provisional` against Y8-staff so the Unconfirmed
-- Assumptions panel lists them. The columns below are therefore nullable where a NOT NULL would have
-- made the seed invent a fact: the same reasoning 0030 wrote against `employee.gender`.

begin;

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------

-- Two labels, and a third is a migration — the weight 0030 chose for `employee_gender`, for the same
-- reason. Federal Decree-Law 33 of 2021 replaced the limited/unlimited distinction, and MOHRE's work
-- models (flexible, temporary, job-sharing, condensed) are listed in docs/04 §7 under an explicit
-- "all figures to confirm with MOHRE" — so enumerating them here would be this build's guess at the
-- vocabulary of contracts nobody has shown it. full_time and part_time are the two the rota and the
-- leave accrual actually distinguish.
create type employee_contract_type as enum ('full_time', 'part_time');
comment on type employee_contract_type is
  'The work pattern, not the MOHRE contract class. NULLABLE on employee: nineteen employment records '
  'and no contracts is the real handover position (Y8-staff). Adding a label as MOHRE''s work models '
  'are confirmed (docs/04 SS7, [UNVERIFIED]) is a migration, which is the right weight for a change '
  'that alters leave entitlement.';

-- The same two-label argument, and it matters more here. A language is an attribute of a real person:
-- the business publishes EN and AR and nothing has been said about the nineteen, so these are the two
-- labels the system can name without inventing one. An enum rather than text[] for 0030's reason - a
-- typo in a text[] is a language nothing matches, so a client asking for Arabic is offered nobody.
create type staff_language as enum ('arabic', 'english');
comment on type staff_language is
  'Languages a member of staff speaks. NO rows are seeded: which languages the nineteen therapists '
  'speak is Y8-staff, and a plausible list is indistinguishable from a confirmed one.';

-- ---------------------------------------------------------------------------------------------
-- employee — the employment terms, the publication guard and the provenance trio
-- ---------------------------------------------------------------------------------------------
alter table employee
  -- The public name, set in the backend by the admin (docs/13 §5). NULL is the launch state and the
  -- current state: 19 photographs, 0 names (Y12-names).
  add column display_name              text,
  -- Photography consent for an identifiable person (Y12-consent-photo). FALSE by default, because the
  -- default of a consent flag is the answer nobody has given.
  add column photo_consent             boolean     not null default false,
  add column photo_consent_recorded_at timestamptz,
  add column photo_consent_recorded_by text,
  add column contract_type             employee_contract_type,
  -- Integer fils in the `fils_nonneg` domain (ADR 0007). Nullable, all four: a wage nobody has
  -- supplied is not zero - zero is a figure that would flow into a WPS file and a gratuity accrual as
  -- though somebody had agreed it.
  add column basic_wage_fils           fils_nonneg,
  add column housing_allowance_fils    fils_nonneg,
  add column transport_allowance_fils  fils_nonneg,
  add column other_allowance_fils      fils_nonneg,
  -- The provenance trio every other provisional row in this database carries (app_setting 0010,
  -- service 0017, service_room_type_compat 0012, employee_skill 0030). `unconfirmedAssumptionRows`
  -- reads it, which is what puts the unnamed-therapist assumption on the Unconfirmed Assumptions
  -- panel instead of in a comment.
  add column is_provisional            boolean     not null default false,
  add column provisional_note          text,
  add column open_question_id          text;

-- A separate statement, because a generated column's expression may not reference a column added by
-- the same ALTER TABLE.
alter table employee
  -- The guard 0030 said a nullable display_name would make invisible, made a column nothing can set.
  -- ADR 0020: a therapist page is publishable only with a display name AND a recorded photography
  -- consent. GENERATED, so an admin screen that sets one of the two cannot publish the page, and a
  -- reader cannot compute the predicate differently.
  add column is_publishable  boolean not null generated always as
    (display_name is not null and photo_consent) stored,
  -- The WPS file's monthly total. Generated for the same reason: two screens computing "basic plus
  -- allowances" is two figures, and the one that disagrees is discovered by an employee.
  -- End-of-service gratuity accrues on the BASIC wage alone (docs/04 §7), which is why basic is its
  -- own column and not a share of this total.
  add column total_wage_fils fils_nonneg generated always as
    (basic_wage_fils
       + coalesce(housing_allowance_fils, 0)
       + coalesce(transport_allowance_fils, 0)
       + coalesce(other_allowance_fils, 0)) stored;

alter table employee
  -- A published name must be unique or two therapist pages are indistinguishable to a reader and to a
  -- search engine. NULLs are distinct in Postgres, so nineteen unnamed therapists are legal.
  add constraint employee_display_name_unique unique (display_name),
  -- 'TBC', 'pending', a blank string. A provisional name here is one consent row away from being
  -- PUBLISHED as somebody's name, and a reader cannot tell a placeholder from a nickname.
  -- is_placeholder_text is 0026's.
  add constraint employee_display_name_not_placeholder
    check (display_name is null or not is_placeholder_text(display_name)),
  -- Consent is a record of an act by a person, not a boolean somebody ticks. Without this, the
  -- publication guard is one UPDATE away from being satisfied with no evidence behind it.
  add constraint employee_photo_consent_has_a_record
    check (
      not photo_consent
      or (photo_consent_recorded_at is not null
          and photo_consent_recorded_by is not null
          and not is_placeholder_text(photo_consent_recorded_by))
    ),
  -- The same shape as employee_skill_provisional_names_a_question (0030): a provisional row that names
  -- no question is an assumption the panel lists with nothing to chase.
  add constraint employee_provisional_names_a_question
    check (not is_provisional or open_question_id is not null);

comment on column employee.display_name is
  'The public name, set in the backend by the admin (docs/13 SS5). NULL for all nineteen therapists '
  '(Y12-names): the build does not invent one, and is_publishable stays false until it is set.';
comment on column employee.photo_consent is
  'Photography consent on record for an identifiable person (Y12-consent-photo). The 19 committed '
  'portraits are of real people; consent for publication is not on file, so this is false and the '
  'therapist card renders a photograph with no name and no link.';
comment on column employee.is_publishable is
  'GENERATED from display_name and photo_consent, never written. ADR 0020 needs both before a '
  'therapist page exists; a nullable display_name with no generated guard is what an admin screen '
  'fills in without the consent row, and 0030 left the column out rather than ship that.';
comment on column employee.basic_wage_fils is
  'Integer fils, VAT-irrelevant, in the fils_nonneg domain (ADR 0007). End-of-service gratuity '
  'accrues on this figure alone (docs/04 SS7), not on total_wage_fils.';
comment on column employee.total_wage_fils is
  'basic + housing + transport + other, in fils. GENERATED: the WPS salary file and the payroll screen '
  'must not be able to compute this differently. NULL while the basic wage is unknown.';
comment on column employee.is_provisional is
  'True for a row the build created without an answer. Read by unconfirmedAssumptionRows() and '
  'therefore by the Unconfirmed Assumptions panel, exactly as app_setting.is_provisional is.';

-- ---------------------------------------------------------------------------------------------
-- employee_language — a multi-valued attribute, so a table
-- ---------------------------------------------------------------------------------------------
-- One row per language, for the reason employee_skill is one row per skill (0030): a therapist speaks
-- several languages, and a single column forces either a first-language-only answer or an array whose
-- typos match nothing.
create table employee_language (
  employee_id      uuid          not null references employee (id) on delete cascade,
  language         staff_language not null,
  is_provisional   boolean       not null default false,
  open_question_id text,
  created_at       timestamptz   not null default now(),
  primary key (employee_id, language),
  constraint employee_language_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table employee_language is
  'Languages spoken, one row per language. Deliberately EMPTY after a seed: docs/13 SS5 publishes no '
  'languages and Y8-staff has not been answered, so every row here would be an invented fact about an '
  'identifiable person. The shape exists so the admin screen has somewhere to put the answer.';

create index employee_language_language_idx on employee_language (language);

-- ---------------------------------------------------------------------------------------------
-- employee_bank_detail — one sealed payload per account, superseded rather than edited
-- ---------------------------------------------------------------------------------------------
-- The IBAN and the account holder are sealed TOGETHER as one JSON payload, and there is no plaintext
-- column holding any part of either. A `bank_name` or an `iban_last4` column would be the compromise
-- that makes a raw SELECT informative again, which is the property the acceptance criterion names:
-- "a raw psql select on employee_bank_detail returns ciphertext only". `label` is what the payroll
-- screen shows to tell two accounts apart, and it is what a person typed ("salary account"), never
-- anything derived from the number.
--
-- No `updated_at` and no set_updated_at trigger, which is a decision and not an omission. A change of
-- salary account is a new record and the old one stays: it is the evidence of where money was
-- actually sent, and it is what a WPS file is reconciled against months later. So the row is
-- superseded, exactly as clinical.intake_submission is (0008), and the immutability trigger below
-- makes that the only way.
create table employee_bank_detail (
  id                uuid        primary key default uuid_generate_v7(),
  -- RESTRICT, for 0030's reason: an employee who has been paid has a history, and deleting the person
  -- to erase the account is the delete this refuses. Ending employment is `employed_until`.
  employee_id       uuid        not null references employee (id) on delete restrict,
  label             text,
  -- The envelope: AES-256-GCM ciphertext, the per-record data key wrapped by STAFF_PII_KEK, the key
  -- version so a rotation is a re-wrap, and the AAD fingerprint that binds this ciphertext to this
  -- row. `_kid` and `_aad_fp` follow 0016's spelling rather than 0008's, because this estate is the
  -- Google estate's shape - its own key, its own re-wrap primitive - and not the clinical one's.
  detail_ct         bytea       not null,
  detail_nonce      bytea       not null,
  detail_wrapped_key bytea      not null,
  detail_kid        text        not null,
  detail_aad_fp     text        not null,
  created_at        timestamptz not null default now(),
  -- Who filed the account. An audit row records the read; this records the write, on the row itself,
  -- because the question asked about a bank account is "who put this number here".
  created_by        text        not null,
  superseded_at     timestamptz,
  constraint employee_bank_detail_label_not_placeholder
    check (label is null or not is_placeholder_text(label)),
  constraint employee_bank_detail_created_by_not_placeholder
    check (not is_placeholder_text(created_by)),
  constraint employee_bank_detail_sealed_columns_nonempty
    check (length(detail_ct) > 0 and length(detail_nonce) > 0 and length(detail_wrapped_key) > 0),
  constraint employee_bank_detail_kid_shape
    check (detail_kid ~ '^[a-z0-9][a-z0-9._-]{0,31}$')
);

comment on table employee_bank_detail is
  'Staff bank accounts, one sealed JSON payload per row ({iban, accountHolder}). Superseded, never '
  'edited and never deleted: the row is the evidence of where a WPS payment was sent. A raw SELECT '
  'here returns ciphertext and nothing else - there is deliberately no bank name and no last-four.';
comment on column employee_bank_detail.detail_aad_fp is
  'sha256 of the AAD this payload was sealed under - table, row id, employee id - truncated to 32 hex '
  'characters. Compared before a decrypt is attempted, so a payload moved onto another employee''s row '
  'is refused by name rather than failing as an opaque authentication error.';
comment on column employee_bank_detail.detail_kid is
  'The STAFF_PII_KEK version, NOT the clinical one. Key material is never in this database. There is '
  'no version registry yet: see the header of this migration for why, and which unit adds it.';

-- One current account per employee. Partial on `superseded_at`, so the history is unbounded and the
-- present is unambiguous: without it, "which account does payroll pay into" has as many answers as
-- the employee has ever had accounts, and the query that picks one silently picks the wrong one.
create unique index employee_bank_detail_one_current
  on employee_bank_detail (employee_id) where superseded_at is null;

create index employee_bank_detail_employee_idx on employee_bank_detail (employee_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- employee_document — the encrypted number, added to 0030's credential registry
-- ---------------------------------------------------------------------------------------------
-- P-HR-02 owns the issuing authority and the pure MISSING/VALID/EXPIRING_SOON/EXPIRED evaluator; this
-- adds only the number, sealed. The five columns are nullable because a document may be on file before
-- its number has been entered, and `employee_document_sealed_number_is_complete` is what stops that
-- from meaning "four of the five".
alter table employee_document
  add column number_ct          bytea,
  add column number_nonce       bytea,
  add column number_wrapped_key bytea,
  add column number_kid         text,
  add column number_aad_fp      text;

alter table employee_document
  -- All five or none. Four of five is a row whose ciphertext cannot be opened, and the way that is
  -- discovered is a decrypt failing in front of an auditor.
  add constraint employee_document_sealed_number_is_complete
    check (
      (number_ct is null and number_nonce is null and number_wrapped_key is null
        and number_kid is null and number_aad_fp is null)
      or (number_ct is not null and number_nonce is not null and number_wrapped_key is not null
        and number_kid is not null and number_aad_fp is not null)
    ),
  -- The plaintext `reference` column of 0030 may hold a licence or certificate number. It may NOT
  -- hold an identity number: an Emirates ID or a passport number typed there is the disclosure this
  -- whole migration exists to prevent, and it would look exactly like ordinary data entry. For those
  -- two types the number is sealed in number_ct or it is not recorded.
  add constraint employee_document_identity_number_is_encrypted
    check (not (document_type in ('emirates_id', 'passport') and reference is not null)),
  add constraint employee_document_number_kid_shape
    check (number_kid is null or number_kid ~ '^[a-z0-9][a-z0-9._-]{0,31}$');

comment on constraint employee_document_identity_number_is_encrypted on employee_document is
  'An Emirates ID or passport number may not be stored in the plaintext `reference` column. docs/04 '
  'SS7 requires field-level encryption on identity document numbers; a plaintext one would be in every '
  'backup, every CSV export and every log line that echoed a row.';
comment on column employee_document.number_ct is
  'The document number, sealed under STAFF_PII_KEK with the row as AAD. NULL until somebody enters '
  'it - a placeholder here would be a plausible identity number, which is worse than a blank one '
  '(is_placeholder_text cannot help: this column is bytea).';

-- ---------------------------------------------------------------------------------------------
-- What a sealed staff row may accept, and what a re-wrap may change
-- ---------------------------------------------------------------------------------------------
--
-- 0043's technique, applied to this estate. `to_jsonb(new)` against `to_jsonb(old)` rather than a
-- column list, so a column a later migration adds to a sealed table is covered the day it appears.
-- The mutable set is an allow-list of three: the wrapped key and the key version, which is what a
-- re-wrap rewrites, and `superseded_at`, which is how a bank account is replaced.
--
-- Two named errors, in a private SQLSTATE class of their own rather than reusing 0043's ZK002/ZK003:
-- one rule per estate, so an operator reading a log knows which key and which runbook section they
-- are looking at.
create or replace function enforce_staff_sealed_row_writes()
returns trigger
language plpgsql
as $$
declare
  v_mutable text[] := array['detail_wrapped_key', 'detail_kid', 'superseded_at'];
  v_old     jsonb;
  v_new     jsonb;
  v_changed text;
begin
  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  select key into v_changed
    from jsonb_each(v_new) as n(key, value)
   where not (n.key = any (v_mutable))
     and (v_old -> n.key) is distinct from n.value
   order by key
   limit 1;

  if v_changed is not null then
    raise exception
      'StaffSealedRowImmutable: %.% may not change column "%" on UPDATE. A re-wrap rewrites the '
      'wrapped data key; the ciphertext, the nonce and the row identity the AAD binds it to stay as '
      'they were. Replace a staff bank account by superseding the row, never by rewriting it.',
      tg_table_schema, tg_table_name, v_changed
      using errcode = 'ZS002';
  end if;

  -- A re-wrap encrypts the data key again under a fresh nonce, so the bytes always change. Equal bytes
  -- with a new version label means the version column was bumped and the key was not re-wrapped, which
  -- leaves a row labelled with a key that cannot open it.
  if new.detail_kid <> old.detail_kid and new.detail_wrapped_key = old.detail_wrapped_key then
    raise exception
      'StaffRewrapDidNotRewrap: %.% moved from key version "%" to "%" with an unchanged wrapped key. '
      'The row is now labelled with a key that cannot open it.',
      tg_table_schema, tg_table_name, old.detail_kid, new.detail_kid
      using errcode = 'ZS003';
  end if;

  return new;
end $$;

comment on function enforce_staff_sealed_row_writes() is
  'Raises ZS002 (an UPDATE touching anything but the wrapped key, the key version or superseded_at) '
  'or ZS003 (a version change with an unchanged wrapped key). The staff estate''s half of 0043''s '
  'ZK002/ZK003, with its own error names because it has its own key and its own runbook section.';

create trigger employee_bank_detail_sealed_writes
  before update on employee_bank_detail
  for each row execute function enforce_staff_sealed_row_writes();

-- employee_document gets a NARROWER rule, and the difference is a decision.
--
-- The blanket to_jsonb comparison cannot be used there: 0030 gave that table an `updated_at` column
-- and a `set_updated_at` trigger, so every UPDATE changes a column outside any sensible mutable set —
-- and a trigger comparing whole rows would refuse the ordinary correction of an expiry date. It is
-- also the wrong rule for that table: `employee_document_one_row_per_expiry` means a mistyped number
-- cannot be corrected by inserting a second row, so re-sealing a corrected number in place has to
-- stay possible.
--
-- What must not happen is the row being MOVED. The AAD binds the ciphertext to (table, row id,
-- employee id), so changing the employee under a sealed number produces a row nothing can decrypt —
-- the failure looking, months later, exactly like key loss. And a sealed number must not be erased by
-- an UPDATE, because a document number is evidence of a credential check.
create or replace function enforce_employee_document_sealed_writes()
returns trigger
language plpgsql
as $$
begin
  if old.number_ct is not null then
    if new.employee_id <> old.employee_id or new.id <> old.id then
      raise exception
        'StaffSealedRowRebound: employee_document % carries a sealed number bound to employee %; '
        'moving the row to % would leave a ciphertext nothing can decrypt. File the document against '
        'the other employee instead.', old.id, old.employee_id, new.employee_id
        using errcode = 'ZS004';
    end if;
    if new.number_ct is null then
      raise exception
        'StaffSealedNumberCannotBeCleared: employee_document % may not have its sealed number set back '
        'to NULL. A recorded document number is evidence of a credential check; supersede the '
        'credential instead of emptying it.', old.id
        using errcode = 'ZS005';
    end if;
  end if;

  if new.number_kid is not null and old.number_kid is not null
     and new.number_kid <> old.number_kid
     and new.number_wrapped_key = old.number_wrapped_key then
    raise exception
      'StaffRewrapDidNotRewrap: employee_document % moved from key version "%" to "%" with an '
      'unchanged wrapped key. The row is now labelled with a key that cannot open it.',
      old.id, old.number_kid, new.number_kid
      using errcode = 'ZS003';
  end if;

  return new;
end $$;

comment on function enforce_employee_document_sealed_writes() is
  'Raises ZS004 (a sealed document row moved to another employee, which breaks the AAD binding), '
  'ZS005 (a sealed number cleared by UPDATE) or ZS003 (a version change with an unchanged wrapped '
  'key). Narrower than enforce_staff_sealed_row_writes because employee_document is mutable by '
  'design - 0030 gave it updated_at and a renewal is a new row.';

create trigger employee_document_sealed_writes
  before update on employee_document
  for each row execute function enforce_employee_document_sealed_writes();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on tables created
-- in public afterwards, so the revokes below are load-bearing rather than decorative — and they are
-- stated explicitly because a managed database restored from a dump does not necessarily carry the
-- same defaults.
--
-- A bank account is superseded, never deleted: the row is the record of where a salary payment was
-- sent, and a DELETE erases the only evidence of that. A language row IS deletable — a correction to
-- a list of languages is a correction, not a history.
revoke delete on employee_bank_detail from berelax_app;

-- The reporting role has no business in the bank table at all. 0009 grants it select on every future
-- public table through `alter default privileges`, so this revoke is what makes that true.
revoke select on employee_bank_detail from berelax_readonly;

-- `employee_document` is deliberately NOT column-revoked, and the reason is a fact about PostgreSQL
-- worth writing down rather than rediscovering. This unit first wrote:
--
--   revoke select (number_ct, number_nonce, …) on employee_document from berelax_readonly;
--
-- and it is a NO-OP. A column-level REVOKE does not subtract from a TABLE-level grant, and 0009's
-- default privileges give berelax_readonly select on the whole table, so `has_column_privilege(…,
-- 'number_ct', 'SELECT')` still answers true — which the integration suite caught and now asserts, so
-- the next reader sees the fact rather than a comment claiming a protection that is not there. Making
-- it real would mean revoking the table and re-granting the other columns one by one, which takes the
-- credential-expiry report with it the day P-HR-02 adds a column and forgets the grant: a
-- fail-closed default in a place where the failure is a silently empty report.
--
-- The column that matters is protected by the KEY and not by the grant. `number_ct` is a ciphertext,
-- berelax_readonly holds no `STAFF_PII_KEK`, and a reporting role reading those bytes learns the
-- length of a document number and nothing else. That is the property the envelope exists to provide
-- and the one ADR 0010 relies on for the clinical estate too.

-- berelax_clinical is NOT mentioned here, and that is correct rather than forgotten: 0009 grants it
-- `select on all tables in schema public` as a one-time grant with no `alter default privileges`
-- alongside it, so a table created by this migration is unreachable to it already. Checked rather
-- than assumed — packages/hr/src/employee.itest.ts asserts it with has_table_privilege.

commit;

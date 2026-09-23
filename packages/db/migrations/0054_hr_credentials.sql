-- 0054 — the credential registry: the document types the licence answer names, the issuing
--        authority, and the one legitimate way a credential has no expiry date.
--
-- 0030 created `employee_document` with six document types and made `regulatory_profile.
-- mandatory_therapist_document_types` the answer to "which of them must a bookable therapist hold",
-- because that follows the licence class nobody has confirmed (Y1-licence). It could not express the
-- combination docs/01 decision 20 calls the stricter reading — labour card, Emirates ID, residence
-- visa, occupational health card, medical fitness, good-conduct certificate — because four of those
-- six labels did not exist in the enum. This migration adds them, plus the two records docs/04 §7
-- lists in the same paragraph ("mandatory unemployment insurance and employee health insurance;
-- Emiratisation thresholds by headcount") as document types in the SAME registry rather than as three
-- more tables with three more expiry columns.
--
-- ## Three things this migration does NOT do, each for a stated reason
--
-- **1. It does not supersede the profile in force.** 0030 chose the column DEFAULT as the place to
-- record the provisional answer, and said why: "introducing a column is not a change to the profile,
-- and superseding the seeded row to carry it would record a decision nobody took." That default was
-- `{professional_licence, health_certificate}` — the strictest set expressible in the enum of the
-- day — and this migration revises it to decision 20's six, which is a revision of the BUILD'S
-- PROVISIONAL ANSWER and not of a decision anybody took.
--
-- Writing decision 20's six into the row IN FORCE would be a different act with a different blast
-- radius, and that is the reason it is not done here rather than a preference. Nine integration files
-- across four other units seed a therapist with a professional licence and a health certificate and
-- then assert that therapist is offered a slot (`availability-query`, `availability-perf`,
-- `booking-transaction`, `booking-concurrency`, `appointment-reschedule`, `queries/availability`,
-- `repositories/eligibility`, `therapist-eligibility`). Changing the set in force makes every one of
-- those therapists `credential_missing` — on somebody else's branch, in a file this unit does not
-- own, which is brief rule 12 exactly. Reconciling the row in force with this default belongs to
-- P-HR-03, the unit whose whole subject is credential expiry removing a therapist from availability,
-- and it belongs there together with the seeded documents that keep the rest of the suite green.
--
-- So after this migration the DEFAULT is the stricter six and the ROW IN FORCE still carries 0030's
-- two. That divergence is deliberate, it is asserted in
-- `packages/fixtures/src/hr-credentials.itest.ts` in both directions, and nothing reads the default
-- at runtime: every consumer reads `regulatory_profile_current`, which is the row.
--
-- **2. It does not name a single licence, certificate or document number.** Brief rule 15, and
-- 0030's own words on `employee_document.reference`: a plausible-looking licence number is
-- indistinguishable from a configured one, while a NULL is visibly unanswered. The same argument
-- applies to `issuing_authority`, which is why it is nullable and carries an `is_placeholder_text`
-- check rather than a default of 'MOHRE'.
--
-- **3. It does not make a NULL expiry mean "valid for ever".** 0030 made `expires_on` NOT NULL and
-- said why: "a nullable expiry would read as valid for ever, which is the permissive default that
-- makes an unrenewed licence invisible." That reasoning is kept, not reversed. The column becomes
-- nullable and a TRIGGER refuses the NULL unless the document's type is listed in
-- `regulatory_profile.non_expiring_document_types` — which defaults to the EMPTY set. So on every
-- database that exists today the guarantee is bit-for-bit 0030's: no row may have a NULL expiry. What
-- changes is that "this kind of document does not expire" becomes a claim somebody has to make, in
-- the versioned row that carries every other consequence of the licence answer, instead of being
-- unsayable.
--
-- The existing availability SQL needs no change for this, and that is worth stating because it looks
-- like it should. `packages/db/src/repositories/eligibility.ts` already computes
-- `any_expired = bool_or(ld.expires_on is not null and ld.expires_on < trading_date)`, so a NULL
-- expiry is already "held and not expired" there. Before this migration that arm was unreachable;
-- after it, it is reachable exactly for a type somebody declared non-expiring, which is the answer it
-- should give.

-- ---------------------------------------------------------------------------------------------
-- New enum labels — OUTSIDE the transaction, and that is the point
-- ---------------------------------------------------------------------------------------------
-- `alter type ... add value` is legal inside a transaction block on PostgreSQL 12+, but the new label
-- may not be USED until that transaction commits: a `default array['labour_card', ...]` in the same
-- block fails with "unsafe use of new value of enum type". `psql -f` sends statements in autocommit,
-- so each of these commits on its own and the block below can then reference them.
--
-- `if not exists` on every one, because these are the statements a re-run reaches: the transaction
-- below either commits whole or rolls back whole, and a half-applied migration must not be a
-- half-applied ENUM as well.
--
-- Two labels are absent on purpose. There is no `residence_permit` beside `residence_visa` and no
-- `municipality_health_card` beside `occupational_health_card`: docs/04 §7 marks the whole health-card
-- paragraph **[UNVERIFIED]**, and two labels for one document is the failure 0030's comment describes
-- from the other end — a mandatory type spelled two ways matches nothing, and the therapist is
-- bookable with no certificate at all.
alter type employee_document_type add value if not exists 'labour_card';
alter type employee_document_type add value if not exists 'residence_visa';
alter type employee_document_type add value if not exists 'occupational_health_card';
alter type employee_document_type add value if not exists 'medical_fitness_certificate';
alter type employee_document_type add value if not exists 'good_conduct_certificate';
alter type employee_document_type add value if not exists 'health_insurance';
alter type employee_document_type add value if not exists 'unemployment_insurance';
alter type employee_document_type add value if not exists 'emiratisation_record';

begin;

comment on type employee_document_type is
  'Document kinds an employee file holds. Which of them are MANDATORY for a bookable therapist is '
  'data, in regulatory_profile.mandatory_therapist_document_types, because it follows the licence '
  'class nobody has confirmed (Y1-licence). 0054 added the six of docs/01 decision 20''s stricter '
  'healthcare reading plus the two insurance records and the Emiratisation record of docs/04 SS7, '
  'which live in THIS registry rather than in tables of their own: each is a dated record with an '
  'issuing authority and an expiry, which is what this table already is.';

-- ---------------------------------------------------------------------------------------------
-- regulatory_profile — which types do not expire, beside which types are mandatory
-- ---------------------------------------------------------------------------------------------
-- Here and not in `app_setting` for the reason 0030 gives for the mandatory set: it is a consequence
-- of the same unanswered question. Whether an Emiratisation registration has to be renewed, and on
-- what cycle, is part of the same [UNVERIFIED] paragraph as which credentials a therapist must hold,
-- and one read of one row should answer the whole credential policy rather than two reads that can
-- disagree about which profile version they belong to.
--
-- The default is the EMPTY set, which is the strict option: every credential must be renewed until
-- somebody says otherwise. An empty set is also what makes clause 3 of this migration's header true —
-- the NULL-expiry trigger below refuses everything while this array is empty.
alter table regulatory_profile
  add column non_expiring_document_types employee_document_type[] not null
    default array[]::employee_document_type[];

comment on column regulatory_profile.non_expiring_document_types is
  'Document types whose records carry no expiry date. EMPTY by default, which is the strict reading: '
  'a credential must be renewed until somebody confirms it need not be (Y1-licence). A type listed '
  'here may hold a NULL expires_on and is never reported EXPIRED; a type not listed here may not hold '
  'a NULL expires_on at all (employee_document_expiry_is_declared, ZS006).';

-- 0030's lesson, applied again and for the same reason. `regulatory_profile_current` was created in
-- 0004 as `select *`, and a view's column list is FIXED at CREATE time: the star was expanded then, so
-- adding a column to the table does not add it to the view. Every consumer reads the view and never
-- the table (0004), so without this line the column is unreadable by exactly the callers it exists
-- for — and the failure is a missing column at runtime, not at migration time.
--
-- `create or replace` is legal because the column is APPENDED: a replacement may add columns to the
-- end of the list and may not reorder or retype the existing ones.
create or replace view regulatory_profile_current as
  select * from regulatory_profile where superseded_at is null;

comment on view regulatory_profile_current is
  'The profile in force. Every consumer reads this, never the table. Replaced by 0030 to pick up '
  'mandatory_therapist_document_types and by 0054 to pick up non_expiring_document_types: a view '
  'created with select * has a FIXED column list, so every column added to the table needs this line.';

-- The provisional answer, revised. Clause 1 of the header is why this is the DEFAULT and not an
-- update of the row in force.
alter table regulatory_profile
  alter column mandatory_therapist_document_types set default array[
    'labour_card', 'emirates_id', 'residence_visa',
    'occupational_health_card', 'medical_fitness_certificate', 'good_conduct_certificate'
  ]::employee_document_type[];

comment on column regulatory_profile.mandatory_therapist_document_types is
  'Document types a therapist must hold, unexpired, to be offered in availability. PROVISIONAL '
  '(Y1-licence, Y8-staff): docs/01 decision 20''s stricter healthcare reading of an unconfirmed '
  'licence, which is what this column''s DEFAULT now holds. The row IN FORCE still carries 0030''s '
  'two-label set; reconciling the two is P-HR-03''s, together with the seeded documents that keep the '
  'availability suites green (0054''s header, clause 1). An empty array means no credential gate at '
  'all, which is a decision a lawyer takes, not a default.';

-- ---------------------------------------------------------------------------------------------
-- employee_document — the issuing authority, and a declared absence of expiry
-- ---------------------------------------------------------------------------------------------
alter table employee_document
  -- Who issued it: MOHRE, ICP, the municipality, a training provider. NULL until somebody enters the
  -- real one, and a placeholder is refused outright — the same rule 0030 put on `reference`, for the
  -- same reason. It is deliberately NOT an enum: docs/04 §7 marks the health-card paragraph
  -- [UNVERIFIED], so the set of issuing bodies is not known, and an enum missing the right label is a
  -- data-entry dead end where free text is merely untidy.
  add column issuing_authority text
    constraint employee_document_issuing_authority_not_placeholder
    check (issuing_authority is null or not is_placeholder_text(issuing_authority));

comment on column employee_document.issuing_authority is
  'The body that issued the document. NULL until somebody enters the real one; a placeholder marker '
  'is refused (is_placeholder_text, 0026). Free text and not an enum because docs/04 SS7 marks the '
  'issuing bodies [UNVERIFIED], and an enum without the right label has no correct value to enter.';

-- Clause 3 of the header. The NOT NULL goes, and the trigger below is what keeps its guarantee.
alter table employee_document
  alter column expires_on drop not null;

comment on column employee_document.expires_on is
  'The date the credential expires at the END of, compared against the appointment''s TRADING date '
  'inclusively: a licence valid through the 18th covers the 18th''s 01:30 appointment, whose calendar '
  'date is the 19th. The boundary is Asia/Dubai and never UTC — Dubai is UTC+4, so a UTC comparison '
  'keeps an expired document valid for the four hours after local midnight '
  '(packages/core/src/hr/credentials.ts). NULL is permitted ONLY for a type listed in '
  'regulatory_profile.non_expiring_document_types (0054); for every other type it is refused by '
  'employee_document_expiry_is_declared, which is how 0030''s NOT NULL survives the column becoming '
  'nullable.';

-- One current record per non-expiring type. `employee_document_one_row_per_expiry` cannot cover this:
-- UNIQUE treats two NULLs as distinct, so without a partial index a type declared non-expiring could
-- accumulate an unbounded number of identical rows and "does this employee hold it" would have as many
-- answers as somebody clicked save.
create unique index employee_document_one_row_per_non_expiring
  on employee_document (employee_id, document_type)
  where expires_on is null;

comment on index employee_document_one_row_per_non_expiring is
  'A type declared non-expiring has ONE record per employee. The UNIQUE constraint of 0030 cannot say '
  'this: it includes expires_on, and two NULLs are distinct to a unique constraint.';

-- The trigger that carries 0030's guarantee across the loss of the NOT NULL.
--
-- A CHECK constraint cannot do this: the permitted set lives in another table, and a CHECK may not
-- read one. It is BEFORE INSERT OR UPDATE and reads `regulatory_profile_current` — the view, never the
-- table (0004) — so a profile version that declares a type non-expiring takes effect on the next
-- write with no deploy, which is the same property the mandatory set has.
--
-- SQLSTATE ZS006, continuing 0050's private class for this estate (ZS002–ZS005) so an operator
-- reading a log knows which table and which runbook section they are looking at.
create or replace function enforce_employee_document_expiry_is_declared()
returns trigger
language plpgsql
as $$
declare
  v_non_expiring employee_document_type[];
begin
  if new.expires_on is not null then
    return new;
  end if;

  select non_expiring_document_types into v_non_expiring from regulatory_profile_current;

  -- No profile in force is not "permit it". 0004 seeds one precisely so the system is never without
  -- one, so an empty result means somebody stamped superseded_at on every row — and the permissive
  -- answer here would silently turn every credential into one that never expires.
  if v_non_expiring is null then
    raise exception
      'ExpiryIsDeclaredButNoProfile: no regulatory profile is in force, so whether "%" expires is '
      'unknown. A NULL expiry is refused rather than assumed.', new.document_type
      using errcode = 'ZS006';
  end if;

  if not (new.document_type = any (v_non_expiring)) then
    raise exception
      'EmployeeDocumentExpiryIsDeclared: "%" is not listed in '
      'regulatory_profile.non_expiring_document_types, so its record must carry an expiry date. A '
      'NULL expiry reads as valid for ever, which is the permissive default that makes an unrenewed '
      'credential invisible (0030). Declare the type non-expiring in a new profile version, or enter '
      'the date the document itself carries.', new.document_type
      using errcode = 'ZS006';
  end if;

  return new;
end $$;

comment on function enforce_employee_document_expiry_is_declared() is
  'Raises ZS006 unless a NULL employee_document.expires_on belongs to a type listed in '
  'regulatory_profile_current.non_expiring_document_types. This is 0030''s NOT NULL, re-expressed so '
  'that "this kind of document does not expire" is a claim somebody makes in the versioned profile '
  'rather than something the schema cannot say.';

create trigger employee_document_expiry_is_declared
  before insert or update on employee_document
  for each row execute function enforce_employee_document_expiry_is_declared();

-- ---------------------------------------------------------------------------------------------
-- An identity number typed into the plaintext column — the new types that carry one
-- ---------------------------------------------------------------------------------------------
-- 0050 refuses a plaintext `reference` for `emirates_id` and `passport`, because for those two the
-- number IS an identity number and a plaintext one would be in every backup, every CSV export and
-- every log line that echoed a row. `residence_visa` is the third: a UAE residence file number
-- identifies the person for life in ICP's records exactly as an Emirates ID does.
--
-- A SECOND named constraint rather than a rewrite of 0050's, and that is the expand-only rule rather
-- than laziness: dropping and re-adding a constraint is a window in which neither exists, and a
-- constraint named in another unit's gate probe ('an Emirates ID in the plaintext reference column is
-- refused', case 57) must keep firing under its own name.
alter table employee_document
  add constraint employee_document_visa_number_is_encrypted
    check (not (document_type = 'residence_visa' and reference is not null));

comment on constraint employee_document_visa_number_is_encrypted on employee_document is
  'A residence-visa file number may not be stored in the plaintext `reference` column, for the reason '
  '0050''s employee_document_identity_number_is_encrypted gives for an Emirates ID and a passport: it '
  'identifies the person for life. Seal it in number_ct or do not record it.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- Nothing is granted or revoked here, and that is a conclusion rather than an omission. This
-- migration creates no table: every statement above alters `regulatory_profile` or
-- `employee_document`, whose grants 0009 and 0030 already settled, and 0050 records at length why
-- `employee_document` is deliberately not column-revoked from `berelax_readonly` (a column-level
-- REVOKE does not subtract from a table-level grant, so the statement that looks like a protection is
-- a no-op). `issuing_authority` is not an identity number and needs none: the number is in
-- `number_ct`, and a reporting role holds no STAFF_PII_KEK.

commit;

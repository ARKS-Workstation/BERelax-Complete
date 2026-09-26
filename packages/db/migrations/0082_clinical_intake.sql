-- 0082 — clinical intake: the template that is versioned rather than edited, the consent that must
--        exist before an answer may be stored, and the step-up grant a read is refused without.
--
-- 0008 built the tables and 0043 built the rotation rules. This file adds the three refusals that
-- turn those tables into a store a clinician may actually be given, and every one of them is HERE
-- rather than in the application for ADR 0010's reason: the clinical boundary exists to survive a
-- mistake in the application, so the rules that matter are the ones a `psql` session is also held to.
--
--   1. **A template is versioned, never edited.** An UPDATE may change only `is_current` and
--      `superseded_at`; an INSERT must carry the next version for its locale. A submission references
--      the template row it was captured under, so "what did they actually answer, against which
--      question set" stays answerable after the questions change — which is the whole reason the
--      version is a row and not a column somebody edits.
--   2. **No answer may be stored without a consent record.** A DEFERRED constraint trigger requires a
--      non-withdrawn `clinical.treatment_consent` for the same customer AND the same consent wording
--      hash as the template being answered. The failure mode this closes is the one that must never
--      exist: "we could not establish consent" falling through to "proceed".
--   3. **A real intake payload is refused while OPEN-QUESTIONS Y5-residency is open.** UAE Federal Law
--      2 of 2019 may prohibit storing health data outside the country and DigitalOcean has no UAE
--      region (ADR 0010). Until the owner answers, only `data_origin = 'synthetic'` rows may be
--      written, and the gate is a SETTING the trigger reads — so answering the question is a
--      configuration change (docs/12 §1.3) and not a migration.
--
-- The AAD gains a fourth term. 0008 binds a ciphertext to `table | record id | customer id`; an intake
-- payload is now also bound to the template version it was captured under, because the version is what
-- decides how the answers are READ. Without it, a payload captured under version 3 could be moved onto
-- a row labelled version 4 and would decrypt cleanly against a question set that gives its answers
-- different meanings — an answer to "any recent surgery?" read as an answer to "any allergies?". The
-- term is stored in `aad_context` rather than derived, so every term of the AAD is a column of the row
-- and 0043's ZK002 freezes all four; a trigger asserts the stored term matches `template_version`, so
-- the two cannot disagree.
--
-- `ZJ` is this file's private SQLSTATE prefix. `ZI` is 0026's and 0072's, and every other mnemonic
-- letter is taken (`ZK` the KEK's, `ZP` consent's, `ZS` staff's, `ZU` the pipeline's) — what a private
-- code has to be is unique to one file, not memorable, which is 0077's argument verbatim.

-- ---------------------------------------------------------------------------------------------
-- 1. The template: versioned, never edited.
-- ---------------------------------------------------------------------------------------------

alter table clinical.intake_form_template
  add column superseded_at timestamptz,
  add constraint intake_template_version_positive check (version > 0);

comment on column clinical.intake_form_template.superseded_at is
  'When a later version replaced this one. Set by an UPDATE, which is one of exactly two columns an '
  'UPDATE may touch; the question set, the wording and the version itself are immutable.';

/**
 * A template row is immutable apart from its currency.
 *
 * `to_jsonb(new)` against `to_jsonb(old)` rather than a column list, for 0043's reason: a column added
 * by a later migration is covered the day it appears rather than the day somebody remembers to add it
 * here. The mutable set is two columns, and neither of them changes what a client was asked.
 *
 * This is what makes "editing a template creates a new version" a fact about the database. The obvious
 * alternative — trusting the repository to insert instead of update — fails in the one case that
 * matters: a correction typed straight into `psql` to fix a typo in a question would silently change
 * the meaning of every submission already captured against that row, because a submission holds only a
 * reference to it.
 */
create or replace function clinical.forbid_intake_template_edit()
returns trigger
language plpgsql
as $$
declare
  v_mutable text[] := array['is_current', 'superseded_at'];
  v_changed text;
begin
  select key into v_changed
    from jsonb_each(to_jsonb(new)) as n(key, value)
   where not (n.key = any (v_mutable))
     and (to_jsonb(old) -> n.key) is distinct from n.value
   order by key
   limit 1;

  if v_changed is not null then
    raise exception
      'IntakeTemplateImmutable: clinical.intake_form_template may not change column "%" on UPDATE. '
      'Editing a template means INSERTing the next version for its locale; every submission already '
      'captured references this row and must keep rendering against the questions it was asked.',
      v_changed
      using errcode = 'ZJ001';
  end if;
  return new;
end $$;

create trigger intake_template_no_edit
  before update on clinical.intake_form_template
  for each row execute function clinical.forbid_intake_template_edit();

/**
 * A new template version is strictly NEWER than every version of its locale. Monotonic, not contiguous.
 *
 * `unique (version, locale)` already stops two templates sharing a label, so the thing left to stop is a
 * template inserted BELOW the current one: it becomes `is_current`, reads as the newest question set on
 * every screen, and its number says it is older than the version it replaced. `superseded_at` and
 * `is_current` are the only other signals, and both then disagree with the number.
 *
 * Monotonic rather than "must be max + 1", and the difference is not cosmetic. A contiguous rule makes
 * this table's contents ORDER-DEPENDENT across the integration suite, which runs sequentially against one
 * database and leaves rows behind (brief rule 12): the first suite to insert version 1 would make every
 * later suite that wanted version 1 fail, on a database nobody had touched deliberately. The first draft
 * of this file had the contiguous rule and justified it with a claim that is simply untrue — that a gap
 * lets two question sets share one AAD label — which the unique index already prevents. It was caught by
 * the collateral: `crypto/rotation.itest.ts` seeds a fixture template numbered 10043 and the contiguous
 * rule refused it.
 */
create or replace function clinical.enforce_intake_template_version()
returns trigger
language plpgsql
as $$
declare
  v_highest integer;
begin
  -- An INSERT of a version that ALREADY exists for this locale is left to `unique (version, locale)` and
  -- to whatever ON CONFLICT clause the statement carries. This is not laxity, it is the only way the
  -- trigger can coexist with an idempotent upsert: a BEFORE INSERT trigger fires before ON CONFLICT is
  -- resolved, so refusing here would make `on conflict (version, locale) do nothing` raise on the second
  -- run instead of doing nothing. `crypto/rotation.itest.ts` seeds its fixture template exactly that way
  -- and is how this was found — on the SECOND run of the suite, which is the worst kind of red.
  if exists (
    select 1 from clinical.intake_form_template
     where locale = new.locale and version = new.version
  ) then
    return new;
  end if;

  select max(version) into v_highest
    from clinical.intake_form_template
   where locale = new.locale;

  if v_highest is not null and new.version <= v_highest then
    raise exception
      'IntakeTemplateVersionNotNewer: locale "%" is already at version %, so a new template must be '
      'numbered above it, not %. A version below the current one becomes is_current while its number '
      'says it is older than the version it replaced.',
      new.locale, v_highest, new.version
      using errcode = 'ZJ002';
  end if;
  return new;
end $$;

create trigger intake_template_version_is_newer
  before insert on clinical.intake_form_template
  for each row execute function clinical.enforce_intake_template_version();

-- ---------------------------------------------------------------------------------------------
-- 2. The submission: the version it was captured under, its AAD term, its origin and its retention.
-- ---------------------------------------------------------------------------------------------

-- Added nullable and back-filled rather than given a DEFAULT. A default would write a plausible value
-- onto any row that already existed, and for `template_version` a plausible value is a wrong reading of
-- somebody's answers (brief rule 15). The back-fill reads the truth from the referenced template.
alter table clinical.intake_submission
  add column template_version integer,
  add column aad_context      text,
  add column data_origin      text,
  add column retain_until     timestamptz;

update clinical.intake_submission s
   set template_version = t.version,
       aad_context       = 'template_version=' || t.version::text
  from clinical.intake_form_template t
 where t.id = s.template_id
   and s.template_version is null;

-- `real` and not `synthetic` for a row nobody classified: the conservative reading of an unrecorded
-- origin is that it is somebody's health data. The retention figure comes from the profile in force,
-- which defaults to the healthcare-grade 25 years (0004) because unconfirmed resolves to stricter.
update clinical.intake_submission s
   set data_origin  = 'real',
       retain_until = s.submitted_at
                    + (select clinical_retention_years from regulatory_profile_current) * interval '1 year'
 where s.data_origin is null;

alter table clinical.intake_submission
  alter column template_version set not null,
  alter column aad_context      set not null,
  alter column data_origin      set not null,
  alter column retain_until     set not null,
  add constraint intake_submission_data_origin
    check (data_origin in ('synthetic', 'real')),
  add constraint intake_submission_aad_context_matches_version
    check (aad_context = 'template_version=' || template_version::text),
  add constraint intake_submission_retention_after_capture
    check (retain_until > submitted_at);

comment on column clinical.intake_submission.aad_context is
  'The fourth term of this payload''s AAD, stored rather than derived so that every term the GCM tag '
  'covers is a column of the row and 0043''s ZK002 freezes all four. A CHECK ties it to '
  'template_version, so the label and the version cannot disagree.';
comment on column clinical.intake_submission.data_origin is
  'synthetic or real. A real payload is REFUSED while OPEN-QUESTIONS Y5-residency is open, because the '
  'answer decides whether this database may be outside the UAE at all (ADR 0010).';
comment on column clinical.intake_submission.retain_until is
  'Computed at capture from regulatory_profile_current.clinical_retention_years, which defaults to the '
  'healthcare-grade 25 years. Stored so a past decision is explainable: "we kept it because the profile '
  'in force when it was captured said to".';

/**
 * The template version an intake submission claims must be the version of the template it references.
 *
 * A CHECK cannot say this — it spans two rows — and nothing else can either, because `template_id` is
 * a foreign key to a table whose rows are immutable but whose version column a DIFFERENT row may hold.
 * Without it, `template_version` is a column an INSERT may simply get wrong, and then the AAD term
 * disagrees with the question set the submission renders against: the payload decrypts, the labels come
 * from version 3 and the answers were given to version 4.
 */
create or replace function clinical.enforce_intake_submission_version()
returns trigger
language plpgsql
as $$
declare
  v_actual integer;
begin
  select version into v_actual
    from clinical.intake_form_template
   where id = new.template_id;

  if v_actual is distinct from new.template_version then
    raise exception
      'IntakeSubmissionVersionMismatch: submission claims template version % but template % is at '
      'version %. The version is a term of this payload''s AAD and decides how its answers are read.',
      new.template_version, new.template_id, coalesce(v_actual::text, '(no such template)')
      using errcode = 'ZJ004';
  end if;
  return new;
end $$;

create trigger intake_submission_version_matches_template
  before insert on clinical.intake_submission
  for each row execute function clinical.enforce_intake_submission_version();

-- ---------------------------------------------------------------------------------------------
-- 3. The consent gate.
-- ---------------------------------------------------------------------------------------------

create index treatment_consent_gate_idx
  on clinical.treatment_consent (customer_id, consent_hash)
  where withdrawn_at is null;

/**
 * No answer may be stored without a consent record for the wording that template carries.
 *
 * Matched on the **hash of the wording** and not on the template id, which is the point of the gate
 * rather than a detail of it: a consent given against version 3's wording covers version 4 only if
 * the wording did not change, and `consent_hash` is the only column that can say so. A gate keyed on
 * `template_id` would refuse a client who consented last week to wording nobody has touched, and — far
 * worse in the other direction — would ACCEPT a client whose consent predates a rewritten consent
 * paragraph.
 *
 * DEFERRED, for the reason 0077's transition trigger is: the submission and its consent row are
 * written in one transaction and either order must work. An immediate trigger would force the caller
 * to order two statements correctly, which is a rule that holds until somebody reorders them.
 *
 * `withdrawn_at is null` is checked at COMMIT, so a withdrawal in the same transaction as a submission
 * refuses the submission. That is the intended reading of a withdrawal: it is not a request to stop
 * later.
 */
create or replace function clinical.enforce_intake_consent()
returns trigger
language plpgsql
as $$
declare
  v_hash text;
begin
  select consent_hash into v_hash
    from clinical.intake_form_template
   where id = new.template_id;

  if not exists (
    select 1
      from clinical.treatment_consent c
     where c.customer_id = new.customer_id
       and c.consent_hash = v_hash
       and c.withdrawn_at is null
  ) then
    raise exception
      'IntakeConsentNotEstablished: no live clinical.treatment_consent for customer % against the '
      'consent wording of template % (hash %). An intake answer may not be stored until consent to '
      'THAT wording is on record; "consent could not be established" is a refusal, never a default.',
      new.customer_id, new.template_id, coalesce(v_hash, '(no such template)')
      using errcode = 'ZJ003';
  end if;
  return new;
end $$;

create constraint trigger intake_submission_requires_consent
  after insert on clinical.intake_submission
  deferrable initially deferred
  for each row execute function clinical.enforce_intake_consent();

-- ---------------------------------------------------------------------------------------------
-- 4. The residency gate: a real payload is refused while Y5-residency is open.
-- ---------------------------------------------------------------------------------------------

/**
 * Whether non-synthetic intake data may be stored at all.
 *
 * The wording avoids one word deliberately: check-schema-conventions.mjs scans a migration line by line
 * for column TYPES, blanking single-quoted strings and dash comments first but not a block comment, so
 * that word in prose here is reported as a floating-point column. Reported rather than fixed, because
 * that scanner belongs to another unit.
 *
 * Reads `app_setting`, which is a public-schema READ and not a foreign key — the boundary rule is about
 * references that weld the two schemas together for a relocation (ADR 0010), and a relocated clinical
 * store carries this function with it and reads the setting in whatever database it lands in.
 *
 * Absent means false. A gate whose default is "permitted" when its configuration row is missing is a
 * gate that opens during a restore, which is precisely when nobody is looking.
 */
create or replace function clinical.real_intake_permitted()
returns boolean
language sql
stable
as $$
  select coalesce(
    (select value = to_jsonb(true) from app_setting where key = 'clinical.real_intake_permitted'),
    false
  )
$$;

comment on function clinical.real_intake_permitted() is
  'The Y5-residency gate. False until the owner confirms that intake notes may be stored outside the '
  'UAE, or that they are not health data subject to localisation. Absent setting reads as false.';

create or replace function clinical.enforce_intake_residency()
returns trigger
language plpgsql
as $$
begin
  if new.data_origin = 'real' and not clinical.real_intake_permitted() then
    raise exception
      'ClinicalRealIntakeNotPermitted: refusing to store a real intake payload. OPEN-QUESTIONS '
      'Y5-residency is open — whether intake notes are health data subject to UAE localisation is '
      'unconfirmed, this database is not UAE-hosted, and the strict reading is the safe one. Set '
      'clinical.real_intake_permitted once the owner has answered; until then only data_origin = '
      '''synthetic'' may be written.'
      using errcode = 'ZJ005';
  end if;
  return new;
end $$;

create trigger intake_submission_residency_gate
  before insert on clinical.intake_submission
  for each row execute function clinical.enforce_intake_residency();

-- ---------------------------------------------------------------------------------------------
-- 5. Step-up authentication: a grant, a purpose, and a ceiling the setting cannot raise.
-- ---------------------------------------------------------------------------------------------
--
-- Lives in the `clinical` schema, not in `public`, and that is a decision rather than a filing choice.
-- ADR 0010's test for what belongs here is whether it MOVES with the store: a step-up grant is
-- consumed by exactly one code path — the audited clinical read — and nothing else joins it, so a
-- relocated store that had left its grants behind would have to reach back across a database boundary
-- for its own authorisation decision, which is the coupling the boundary exists to prevent. It holds no
-- health data: an employee id, an instant, a method and a stated purpose.
--
-- `employee_id` is a plain uuid and NOT a foreign key, for 0008's reason unchanged.

create table clinical.step_up_grant (
  id             uuid        primary key default public.uuid_generate_v7(),
  employee_id    uuid        not null,
  method         text        not null check (method in ('totp')),
  -- What the reads under this grant are for. Required, and required to be real: a purpose nobody
  -- stated is an access nobody can justify afterwards, which is the only thing an audit trail is for.
  stated_purpose text        not null
                             check (length(btrim(stated_purpose)) >= 8)
                             check (not public.is_placeholder_text(stated_purpose)),
  granted_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  constraint step_up_grant_window_forward check (expires_at > granted_at),
  -- The ceiling. The window itself is a setting so it can be tightened without a deploy, and a
  -- setting can be widened too: a mistyped figure that minted an eight-hour grant would turn step-up
  -- into a formality nobody notices has stopped working. Fifteen minutes is three times the
  -- provisional window and the database refuses anything longer whatever the setting says.
  constraint step_up_grant_window_ceiling
    check (expires_at <= granted_at + interval '15 minutes')
);

comment on table clinical.step_up_grant is
  'A second-factor re-authentication, valid for a short window and for ONE stated purpose. Every read '
  'of a submission or a treatment note is refused without a live grant whose purpose matches the '
  'purpose the read declares.';

create index step_up_grant_live_idx
  on clinical.step_up_grant (employee_id, expires_at desc)
  where revoked_at is null;

/**
 * A grant is not editable, only revocable.
 *
 * The same argument as the template's, one notch sharper: a grant is the evidence that somebody
 * re-authenticated before reading a health record, and evidence whose window can be extended after the
 * fact is not evidence. `revoked_at` is the one column an UPDATE may set, and only from null.
 */
create or replace function clinical.forbid_step_up_grant_edit()
returns trigger
language plpgsql
as $$
declare
  v_changed text;
begin
  select key into v_changed
    from jsonb_each(to_jsonb(new)) as n(key, value)
   where n.key <> 'revoked_at'
     and (to_jsonb(old) -> n.key) is distinct from n.value
   order by key
   limit 1;

  if v_changed is not null then
    raise exception
      'StepUpGrantImmutable: clinical.step_up_grant may not change column "%". A grant is the evidence '
      'that somebody re-authenticated; only revoked_at may be set, and only once.',
      v_changed
      using errcode = 'ZJ006';
  end if;

  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception
      'StepUpGrantImmutable: clinical.step_up_grant % was already revoked at %. Revocation is one-way.',
      old.id, old.revoked_at
      using errcode = 'ZJ006';
  end if;
  return new;
end $$;

create trigger step_up_grant_no_edit
  before update on clinical.step_up_grant
  for each row execute function clinical.forbid_step_up_grant_edit();

-- ---------------------------------------------------------------------------------------------
-- 6. Privileges.
-- ---------------------------------------------------------------------------------------------
--
-- Stated explicitly rather than relying on 0009's `alter default privileges`, which applies only to
-- objects created by the role that set it — 0043 records the same reason. No DELETE: 0009 revokes it
-- across the schema and a grant here would quietly reinstate it for the one table whose rows are the
-- record of who looked at a health record.
grant select, insert, update on clinical.step_up_grant to berelax_clinical;

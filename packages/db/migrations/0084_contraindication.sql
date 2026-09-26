-- 0084 — the boolean-only crossing: the three flags the closed set was missing, the provenance that
--        makes a stale set detectable, and the view rebuilt so that what crosses is booleans and nothing
--        else.
--
-- 0008 created `clinical.contraindication_flag` with five booleans and 0009 built the view over it.
-- 0082 built the store and wrote no flag row at all, deferring the derivation here — so until this
-- migration the view answered empty for every submission in the database and nothing in the build read
-- it. This file makes it the thing its own comment claims: the ONLY path from the application to
-- clinical data, and a path that can carry nothing but a boolean.
--
-- Four changes, and each one closes a way the crossing could say something it has no right to say.
--
--   1. **The closed set is eight keys, so three columns are added.** `allergy_present`,
--      `blood_thinners` and `acute_injury` are in `CONTRAINDICATION_FLAG_KEYS` and had no column. A key
--      without a column is a flag that derives and then is not stored, which is indistinguishable from
--      a client who answered no. The eighth key is `requires_consultation`, which 0008 already has —
--      see `packages/shared/src/clinical.ts` for why it is not `practitioner_review_required` and what
--      widens when OPEN-QUESTIONS Y1-licence is answered.
--
--   2. **A flag row carries its own provenance: which derivation produced it, and which template
--      version the answers were given to.** Without those two columns a stale set is indistinguishable
--      from a fresh one, and the front desk reads a marker derived from a form the client has since
--      replaced. `resolveContraindicationFreshness` in `@berelax/core` is the verdict; these are the
--      facts it reads.
--
--   3. **"We could not read an answer" implies "ask a human", as a CHECK.** `undetermined_count` is how
--      many of the flags the captured version asked about had an answer this system will not interpret,
--      and `undetermined_count = 0 or requires_consultation` is the rule that stops the derivation
--      silently swallowing them. It is HERE as well as in the derivation for ADR 0010's reason: the
--      boundary exists to survive a mistake in the application, so the rule that matters is the one a
--      `psql` session is also held to. A row written by hand that claims four unreadable answers and no
--      consultation is refused.
--
--   4. **The view is rebuilt to expose the crossing and nothing else**, and it resolves a merged-away
--      customer id. `updated_at` is dropped from it (a fact about when somebody filled in a health
--      form, of no use to a booking), and `merge_survivor_of()` is applied to `customer_id` — which is
--      exactly the deferral `packages/db/src/merge-participants.ts` records against this table, coming
--      due because this unit is the first reader the view has ever had.
--
-- `ZA` is this file's private SQLSTATE prefix. `ZB` through `ZW` are taken, one file each; what a
-- private code has to be is unique to one file rather than memorable, which is 0077's argument and
-- 0082's verbatim.

-- ---------------------------------------------------------------------------------------------
-- 1. The three missing flags.
-- ---------------------------------------------------------------------------------------------

alter table clinical.contraindication_flag
  add column allergy_present boolean not null default false,
  add column blood_thinners  boolean not null default false,
  add column acute_injury    boolean not null default false;

comment on column clinical.contraindication_flag.allergy_present is
  'Derived from a boolean question keyed `allergy_present`, and from nothing else. A free-text answer '
  'naming a substance is NEVER read for this: interpreting what a client wrote would be this system '
  'asserting a fact about somebody''s health that nobody stated.';
comment on column clinical.contraindication_flag.blood_thinners is
  'Derived from a boolean question keyed `blood_thinners`. False means no answer on record said yes; it '
  'does not mean the question was asked, and it never means anything has been ruled out.';
comment on column clinical.contraindication_flag.acute_injury is
  'Derived from a boolean question keyed `acute_injury`. Same reading of false as every other flag.';

-- ---------------------------------------------------------------------------------------------
-- 2. Provenance: which derivation, which template version, and how much it could not read.
-- ---------------------------------------------------------------------------------------------

-- Added with a default and then stripped of it, which is deliberate in both directions.
--
-- The default is what any row that already exists gets, and `0` is the honest value: no version of this
-- derivation produced it, because none existed. It is NOT 1. A back-filled `1` would claim the row was
-- produced by the current derivation, `resolveContraindicationFreshness` would call it fresh, and the
-- first client whose flags predate this file would have a marker nobody can account for presented as
-- current. `0` reads as `derivation_version_changed` — stale, visible on the screen, and re-derivable
-- by somebody who has stepped up. Brief rule 15 applied to a version number: a plausible value is
-- worse than a visibly unanswered one.
--
-- The default is then dropped, for the opposite reason. A writer that omits `undetermined_count` would
-- get `0`, which asserts every answer was readable — the unsafe direction — and one that omits
-- `derivation_version` would write a permanently stale row. After this migration every INSERT states
-- all three.
alter table clinical.contraindication_flag
  add column derivation_version      integer not null default 0,
  add column source_template_version integer,
  add column undetermined_count      integer not null default 0;

update clinical.contraindication_flag f
   set source_template_version = s.template_version
  from clinical.intake_submission s
 where s.id = f.source_submission_id
   and f.source_template_version is null;

alter table clinical.contraindication_flag
  alter column source_template_version set not null,
  alter column derivation_version      drop default,
  alter column undetermined_count      drop default,
  add constraint contraindication_derivation_version_non_negative
    check (derivation_version >= 0),
  add constraint contraindication_template_version_positive
    check (source_template_version > 0),
  add constraint contraindication_undetermined_count_non_negative
    check (undetermined_count >= 0),
  -- The rule this file exists to make undeniable. An answer the derivation could not read as yes or no
  -- must not disappear: it sets the flag that means "a human has to ask". The derivation holds the same
  -- rule (`deriveContraindicationFlags`), and neither layer makes the other redundant — that one refuses
  -- before a row is built, this one refuses a row built by anything else.
  add constraint contraindication_undetermined_requires_consultation
    check (undetermined_count = 0 or requires_consultation);

comment on column clinical.contraindication_flag.derivation_version is
  'The version of the DERIVATION that produced this row (CONTRAINDICATION_DERIVATION_VERSION), not of '
  'the template and not of the schema. Bumped when the rules change what the same answers would '
  'produce. 0 means "produced before the derivation existed", which reads as stale on purpose.';
comment on column clinical.contraindication_flag.source_template_version is
  'The template version the source submission was captured under. A flag derived against version 3 of '
  'the form is not an answer to version 4''s questions, and this column is what lets a screen say so.';
comment on column clinical.contraindication_flag.undetermined_count is
  'How many flags the captured version asked about and whose answer could not be read as yes or no. '
  'Never crosses the boundary: it is a fact about how readable the form was, and a count of anything '
  'about a client''s answers is more than a boolean. Its only consumers are the CHECK above and an '
  'audit row.';

/**
 * A flag row's claimed template version must be the version its source submission was captured under.
 *
 * A CHECK cannot say it — it spans two rows — and nothing else can either. Without it
 * `source_template_version` is a column an INSERT may simply get wrong, and then the staleness verdict
 * is computed from a number nobody derived anything against: a set derived from version 3 that claims
 * version 4 reads as fresh for ever, which is the one state the whole provenance pair exists to make
 * visible. Exactly the shape of 0082's ZJ004, one table along, and for the same reason.
 */
create or replace function clinical.enforce_contraindication_provenance()
returns trigger
language plpgsql
as $$
declare
  v_version  integer;
  v_customer uuid;
begin
  select s.template_version, s.customer_id
    into v_version, v_customer
    from clinical.intake_submission s
   where s.id = new.source_submission_id;

  if v_version is distinct from new.source_template_version then
    raise exception
      'ContraindicationProvenanceMismatch: flag row for customer % claims template version % but its '
      'source submission % was captured under %. The version decides how the answers behind these '
      'flags were read, so a row that gets it wrong is a stale set that reads as fresh for ever.',
      new.customer_id, new.source_template_version, new.source_submission_id,
      coalesce(v_version::text, '(no such submission)')
      using errcode = 'ZA001';
  end if;

  -- The one that would be a disclosure rather than a stale marker. `customer_id` is this table's
  -- primary key and `source_submission_id` references a submission whose own customer is a different
  -- column, so nothing structural stops a row attributing one client's answers to another — and the
  -- result is a contraindication marker on somebody who never answered anything. There is no reading of
  -- that which is merely untidy.
  if v_customer is distinct from new.customer_id then
    raise exception
      'ContraindicationSubmissionNotThisCustomer: flag row for customer % cites submission %, which '
      'belongs to customer %. A derived flag has to be traceable to an answer THIS client gave; a row '
      'like this is a claim about somebody''s health that nobody made.',
      new.customer_id, new.source_submission_id, coalesce(v_customer::text, '(no such submission)')
      using errcode = 'ZA002';
  end if;
  return new;
end $$;

create trigger contraindication_provenance_matches_submission
  before insert or update on clinical.contraindication_flag
  for each row execute function clinical.enforce_contraindication_provenance();

-- The derivation is re-run and overwrites; the index is what makes "which clients were derived against
-- an old version" answerable without a sequential scan once there are rows.
create index contraindication_flag_stale_idx
  on clinical.contraindication_flag (derivation_version, source_template_version);

-- ---------------------------------------------------------------------------------------------
-- 3. Staleness, in SQL, because the reader of the crossing cannot see the clinical schema.
-- ---------------------------------------------------------------------------------------------
--
-- `resolveContraindicationFreshness` in `@berelax/core` is the verdict and it names a REASON, which is
-- what a clinical screen shows. It cannot be the whole answer: 0009 revokes all privileges on the
-- clinical schema from `berelax_app`, so the front desk's reader can see neither which submission is
-- live nor what version the form is at. A staleness check it cannot perform is a staleness check it
-- silently skips.
--
-- So the rule is also here, and what it drives is the one flag that means "a human has to ask". The view
-- below ORs this into `requires_consultation`, and that is the decision worth arguing for:
--
--   * A consumer cannot forget it. There is no second column to check and no `if (stale)` for anybody to
--     leave out — a stale set arrives at the front desk as "ask the client", which is exactly what a set
--     of markers derived from a form the client has since replaced warrants.
--   * The crossing stays the closed set. A `flags_are_stale` column would be a ninth boolean crossing the
--     boundary and a second shape to keep in step with the type; this is the eighth flag doing the job it
--     was named for.
--   * What is LOST is the reason, and losing it is correct for this reader. A receptionist learns that
--     there is something to ask about. Why — an answer nobody could read, a newer form, a newer
--     derivation — is detail, and detail is what this boundary keeps in.
--
-- The stored column and the view's column can therefore differ, and that is deliberate: the row records
-- what the derivation FOUND, and the view reports what the front desk must DO.

/**
 * The derivation version the code is at, in SQL.
 *
 * A second spelling of `CONTRAINDICATION_DERIVATION_VERSION`, and the only honest way to have one: the
 * staleness check has to run as SQL for the reason above, and the constant lives in TypeScript because
 * that is where the derivation it names lives. Two numbers that must agree, so
 * `packages/clinical/src/flags-view.itest.ts` asserts they DO agree rather than trusting it — the same
 * arrangement `packages/shared/src/clinical.ts` uses for a setting key that migration 0082 also spells.
 *
 * Bumping the TypeScript constant therefore requires a migration. That is the intended cost: a derivation
 * that changes what the same answers mean is a re-derivation of every stored row, which is a release
 * rather than a deploy.
 */
create or replace function clinical.contraindication_derivation_version()
returns integer
language sql
immutable
as $$ select 1 $$;

comment on function clinical.contraindication_derivation_version() is
  'CONTRAINDICATION_DERIVATION_VERSION, in SQL, because the staleness check runs where berelax_app has '
  'no privilege to read the clinical schema. An integration test asserts this equals the TypeScript '
  'constant; a bump needs both.';

/**
 * Whether one flag row no longer says what a fresh derivation would say.
 *
 * Mirrors `resolveContraindicationFreshness` minus the reason, and each of the three clauses is one of
 * that function's cases. `no_flags_derived` is absent on purpose and is not a gap: it is the case where
 * there is no row to ask about, so the view has no row either, and a reader that treated a missing row as
 * "no contraindications" would be making a claim nobody made. That is the READER's rule, stated where the
 * reader is — `packages/db/src/repositories/contraindication-flags.ts` returns null and says so.
 */
create or replace function clinical.contraindication_flags_are_stale(p_customer_id uuid)
returns boolean
language sql
stable
-- SECURITY DEFINER, and it is the one in this file that needs an argument rather than a comment.
--
-- `security_invoker = false` on the view makes the view's own BASE RELATIONS checked against the view
-- owner. It does not do that for a function called from the view body: a SECURITY INVOKER function runs
-- as whoever called the view, so this one read the clinical schema as `berelax_app` and the front desk's
-- page answered `permission denied for schema clinical` — found by running one statement as the
-- application role rather than as the owner the test pool connects as.
--
-- The alternative was to inline these three clauses into the view, which needs no elevated function at
-- all. It was rejected because the rule would then exist only inside a view body: it could not be called
-- by a re-derivation sweep, it could not be asserted against `resolveContraindicationFreshness` directly,
-- and a gate case could not mutate it in isolation. What is elevated is bounded to the narrowest thing
-- that could be: one uuid in, one boolean out, two columns of provenance and a version number read, no
-- payload and no answer reachable through it in any argument.
--
-- `search_path` is pinned, because a SECURITY DEFINER function that resolves unqualified names through
-- the caller's path is the standard way this feature becomes a privilege escalation.
security definer
set search_path = clinical, public, pg_temp
as $$
  select coalesce(
    (
      select f.derivation_version <> clinical.contraindication_derivation_version()
          -- The client has filled in a newer form than the one these flags came from. The old submission
          -- is retained and superseded (ADR 0010); its flags are not the current answer.
          or f.source_submission_id is distinct from live.id
          -- The form has moved on and this client has not answered the newer question set, so a flag the
          -- new version asks about has no answer behind it.
          or coalesce(current_version.version, 0) > f.source_template_version
        from clinical.contraindication_flag f
        left join lateral (
          select s.id, s.template_id
            from clinical.intake_submission s
           where s.customer_id = f.customer_id and s.superseded_at is null
           order by s.submitted_at desc, s.id desc
           limit 1
        ) live on true
        left join lateral (
          select max(t2.version) as version
            from clinical.intake_form_template t2
           where t2.locale = (
             select t1.locale from clinical.intake_form_template t1
              where t1.id = live.template_id
           )
        ) current_version on true
       where f.customer_id = p_customer_id
    ),
    false
  )
$$;

comment on function clinical.contraindication_flags_are_stale(uuid) is
  'True when a stored flag row was derived by an older derivation, from a submission the client has since '
  'replaced, or against a template version the form has moved past. ORed into the view''s '
  'requires_consultation so that a stale set arrives at the front desk as "ask the client" rather than as '
  'a marker nobody checked the age of. SECURITY DEFINER, because a function called from a view body runs '
  'as the CALLER even when the view does not; one uuid in, one boolean out, and no payload reachable.';

-- PUBLIC holds EXECUTE on a new function by default, which for a SECURITY DEFINER one is the grant nobody
-- made. Revoked, then given to the two roles that need it: the application role reaches it through the
-- view, and the clinical role calls it directly from a re-derivation sweep. `berelax_readonly` is
-- deliberately absent — 0009 revokes the whole clinical schema from it, and a boolean about a clinical row
-- is still a clinical read.
revoke all on function clinical.contraindication_flags_are_stale(uuid) from public;
grant execute on function clinical.contraindication_flags_are_stale(uuid)
  to berelax_app, berelax_clinical;

-- ---------------------------------------------------------------------------------------------
-- 4. The view: the crossing, and nothing else.
-- ---------------------------------------------------------------------------------------------
--
-- Dropped and recreated rather than `create or replace`, because a replacement may only APPEND columns:
-- it cannot drop `updated_at` and it cannot change the shape to a grouped one. Nothing depends on the
-- view — no other view, no function, no committed query — so the drop is safe, and the grant is
-- restated below because a drop takes it with it.
--
-- ## Why `updated_at` goes
--
-- It is the one non-boolean the crossing carried, and it is a date on which somebody filled in a health
-- form. A booking decision needs whether to route or to ask; it has never needed when. Leaving it would
-- also make the SQL crossing a different shape from the TypeScript one, and then "the exported crossing
-- type is booleans and nothing else" would be true of the type and false of the view somebody actually
-- reads. It stays on the table, where the clinical screen can show it behind the step-up gate.
--
-- ## Why the view resolves a merged-away customer id
--
-- `packages/db/src/merge-participants.ts` registers `clinical.contraindication_flag.customer_id` as a
-- column a customer merge deliberately does not re-point — the application role has no privilege on the
-- clinical schema at all — and records that the tombstone is therefore resolved ON READ, by
-- `merge_survivor_of()`. It also records that nothing in the build reads the view yet. This unit is the
-- first reader it has ever had, so the deferral comes due here: without this, a client whose duplicate
-- record was merged away would silently lose every contraindication flag, which is the worst possible
-- shape for a data-quality fix to take.
--
-- `bool_or` rather than picking one row, because a merge joins two histories and either of them may
-- hold the affirmative. A flag set on either record is set on the survivor; that is the only reading
-- that cannot lose one. The aggregate is also what makes the view one row per LIVE customer, so a
-- reader still queries `where customer_id = $1`.

drop view if exists public.customer_contraindication_flags;

create view public.customer_contraindication_flags
  with (security_invoker = false) as
  select merge_survivor_of(f.customer_id) as customer_id,
         bool_or(f.pregnancy)             as pregnancy,
         bool_or(f.recent_surgery)        as recent_surgery,
         bool_or(f.cardiovascular)        as cardiovascular,
         bool_or(f.skin_condition)        as skin_condition,
         bool_or(f.allergy_present)       as allergy_present,
         bool_or(f.blood_thinners)        as blood_thinners,
         bool_or(f.acute_injury)          as acute_injury,
         -- The escalation flag, ORed with staleness per ROW — so a merged-away record whose flags are
         -- out of date escalates for the survivor too, which is the half a survivor-level check misses.
         bool_or(f.requires_consultation
                 or clinical.contraindication_flags_are_stale(f.customer_id))
                                          as requires_consultation
    from clinical.contraindication_flag f
   group by merge_survivor_of(f.customer_id);

comment on view public.customer_contraindication_flags is
  'The ONLY path from the application to clinical data, and it carries the closed set of booleans and '
  'the customer id they belong to. No free text, no diagnosis, no payload, no count and — since 0084 — '
  'no timestamp: a date on which somebody filled in a health form is not a booking decision. '
  'security_invoker = false so the application role reads it holding no privilege on the clinical '
  'schema. customer_id is resolved through merge_survivor_of(), so a client whose duplicate record was '
  'merged away keeps their flags; bool_or unions the two histories, because either may hold the yes.';

grant select on public.customer_contraindication_flags to berelax_app;

-- ---------------------------------------------------------------------------------------------
-- 4. Privileges on the table.
-- ---------------------------------------------------------------------------------------------
--
-- Stated explicitly rather than relying on 0009's `alter default privileges`, which applies only to
-- objects created by the role that set it — 0043 and 0082 record the same reason, and this table
-- predates neither. No DELETE: 0009 revokes it across the schema, and a flag set is superseded by the
-- next derivation rather than removed. An UPDATE is how a re-derivation lands, so it is granted.
grant select, insert, update on clinical.contraindication_flag to berelax_clinical;

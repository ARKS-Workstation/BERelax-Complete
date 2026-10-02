-- 0133 — the SEO suggestion store: the before-state is STORED, so a change always has a way back.
--
-- G-SEO-05. ADR 0086 is the decision. `packages/core/src/seo/suggestion.ts` is the arithmetic and
-- `packages/db/src/repositories/seo-suggestion.ts` is the writer; what this file is for is the half of
-- that arithmetic a `psql` prompt can reach.
--
-- ## 1. Why the before-state is a COLUMN and not something the rollback recomputes
--
-- The acceptance line is *"a NOT NULL rollback descriptor"*, and the reason it is a line at all is that the
-- obvious implementation does not store one: you apply the suggestion, and when somebody wants it undone
-- you read what the page says now and work backwards. That fails in the two cases a rollback exists for.
-- An editor who touched the page between the apply and the rollback has made the current content a
-- different document, so "work backwards" restores an edit nobody asked to lose. And a suggestion that
-- changed a title the agent had itself changed a week earlier has no recoverable earlier state at all.
--
-- So `before_regions` and `before_content_sha256` are on the row, written at the moment the suggestion was
-- drafted, and `publication_record` is what the restore goes through. A suggestion that can be applied and
-- not un-applied is a change with no way back, and the before/after pair is this unit's primitive rather
-- than a convenience.
--
-- `rollback_descriptor` is therefore NOT a second copy of the before-state — that would be the brief's
-- "second statement of a fact", with two answers to compare on the day somebody needs one. It says HOW the
-- stored before-state is put back: the method, and the surface it is put back on. `ZY401` is what makes it
-- a claim rather than a blob.
--
-- ## 2. Why there is no `content` column, and the hash is the whole point
--
-- `before_regions` and `after_regions` are the regions a human read, in `publicationCanonicalContent`'s
-- shape (`{region, text}`), and the two `*_content_sha256` columns are that canonical string's digest,
-- computed by PostgreSQL through `publicationContentHash` so there is ONE implementation of the digest.
--
-- The acceptance line asks for byte-for-byte restoration *"asserted by comparing the stored content hash
-- before and after the round trip"*, and that assertion is only worth making because `ZY403` holds the
-- hash to the publication it names: an `applied` row's `publication_record` must carry
-- `after_content_sha256`, and a `rolled_back` row's must carry `before_content_sha256`. Without it the two
-- columns are a claim about a publication nothing compared them against, and "rollback is exact" would be
-- a property of the TypeScript that happened to call them in the right order.
--
-- ## 3. Why a suggestion that changes nothing is refused by a CHECK
--
-- `seo_suggestion_changes_something` refuses `before_content_sha256 = after_content_sha256`. A no-op
-- suggestion is not harmless: it spends a human's attention, it spends an LLM call out of a per-run cap,
-- and once applied it writes a `publication_record` that supersedes the live one with identical content —
-- so the surface's history grows a revision nobody made. It is a CHECK and not a trigger because both
-- columns are on the row, which is the same division 0124 drew for its per-row identity.
--
-- ## 4. The cost is on the ROW, in integer fils, and the cap is the run's
--
-- `input_tokens`, `output_tokens` and `cost_fils` per suggestion, because the question an owner asks is
-- *"what did this recommendation cost"* and a per-run total cannot answer it. The CAP is `agent_run`'s —
-- `agent_definition.budget_fils_per_run`, enforced mid-run by `createRunBudget` through `withAgentRun`
-- (G-AGT-01) — and it is deliberately NOT duplicated here: a second cap would be a second answer to
-- whether a run may continue, and the one that aborted the run is the one that matters. `cost_fils` is
-- integer fils per ADR 0007, and `costOfFils` rounds UP for the reason its own header gives: a run that
-- under-reports its cost is a cap that does not hold.
--
-- ## 5. Append-only in everything that is evidence
--
-- The state moves — `proposed` to `approved` to `applied` to `rolled_back`, or `proposed` to `refused` —
-- so the table is not append-only in ADR 0008's full sense. Everything that is EVIDENCE is:
-- `run_id`, the surface, both region sets, both hashes, the rollback descriptor, the lint stamp and the
-- cost may not be changed by an UPDATE, and no row may be DELETEd at all. `ZY402` is both. A suggestion
-- log whose rows can be edited after the fact is not a log, and the specific thing it would stop being
-- able to answer is *"was the content that was published the content that was linted"*.
--
-- A suite therefore asserts a DELTA on this table and never a total, and never deletes from it (ADR 0008,
-- ADR 0050).
--
-- ## 6. What is deliberately NOT here
--
-- **No `approved_by` column.** The named approver is `publication_approval.approver_user_id` and
-- `approver_display_name`, snapshotted there by 0093 so a later rename cannot rewrite who approved what.
-- A copy here would be a second answer to who approved a publication, and the approval row is the one the
-- deferred-constraint trigger in 0093 already requires.
--
-- **No `lint_findings` column for a PASSED lint.** A lint that passed has no findings, and
-- `publication_lint_pass` is the row a publication cites. `refused_rules` exists for the other case: a
-- suggestion the lint refused never reaches the publication chain at all, so there is no
-- `publication_lint_pass` row to carry the reason, and a refusal with no reason on it is a refusal nobody
-- can act on. It is `text[]` and not jsonb because it is a set of rule NAMES — `banned_claim_term`,
-- `service_outside_the_licence` — from a closed list, and an array is what a `cardinality() > 0` CHECK can
-- see.
--
-- **No foreign key from `rollback_descriptor` into anything.** It is a method name and a surface, and the
-- surface is a locator (`collection:slug`) that no table holds as a key — the same shape
-- `publication_lint_pass.surface` and `CmsCopy.where` use, and 0093's own reason for not keying it.
--
-- ---------------------------------------------------------------------------------------------
-- Three private SQLSTATEs, `ZY401`-`ZY403`, of the band `ZY401`-`ZY410` issued to this unit. Allocated
-- through `packages/db/src/sqlstate-registry.ts` and not by reading the migrations a worktree can see
-- (ADR 0043). `ZY404`-`ZY410` are unused and are NOT registered: an entry for a code no migration raises
-- is what direction 3 of that gate refuses, and that is the direction which lets the registry shrink.
--
--   * `ZY401` SeoSuggestionRollbackDescriptorUnusable — a descriptor that names no restorable before-state.
--   * `ZY402` SeoSuggestionEvidenceImmutable — an UPDATE of an evidence column, or any DELETE.
--   * `ZY403` SeoSuggestionPublishedHashDisagrees — the publication named does not carry the hash the row
--             says was applied or restored.

begin;

create table seo_suggestion (
  id                    uuid        primary key default uuid_generate_v7(),
  -- WHICH run proposed it. `agent_run` is where the cost, the outcome and the trading date live, so the
  -- acceptance line's "the run id" is a foreign key rather than a copied label.
  run_id                uuid        not null references agent_run (run_id),
  -- The locator of what is being changed: a collection and a slug, never the copy. The same shape
  -- `publication_lint_pass.surface` uses, so a refusal in an admin screen and a row here name one thing.
  surface               text        not null
                          constraint seo_suggestion_surface_is_stated
                          check (not is_placeholder_text(surface) and length(surface) between 3 and 300),
  state                 text        not null
                          constraint seo_suggestion_state_known
                          check (state in ('proposed', 'refused', 'approved', 'applied', 'rolled_back')),
  -- The before-state, STORED. See §1. `{region, text}` objects in document order, exactly what
  -- `publicationCanonicalContent` is given.
  before_regions        jsonb       not null
                          constraint seo_suggestion_before_regions_is_an_array
                          check (jsonb_typeof(before_regions) = 'array' and jsonb_array_length(before_regions) > 0),
  before_content_sha256 text        not null
                          constraint seo_suggestion_before_hash_is_sha256
                          check (before_content_sha256 ~ '^[0-9a-f]{64}$'),
  after_regions         jsonb       not null
                          constraint seo_suggestion_after_regions_is_an_array
                          check (jsonb_typeof(after_regions) = 'array' and jsonb_array_length(after_regions) > 0),
  after_content_sha256  text        not null
                          constraint seo_suggestion_after_hash_is_sha256
                          check (after_content_sha256 ~ '^[0-9a-f]{64}$'),
  -- HOW the stored before-state goes back. NOT NULL is the constraint the acceptance line names, and
  -- `ZY401` is what refuses a descriptor that is present and says nothing.
  rollback_descriptor   jsonb       not null,
  -- The lint that judged the drafted copy, by version. Not a boolean: the question is WHICH rules judged
  -- it, and a stored decision under a rule set that has since been edited is unreproducible (ADR 0063's
  -- argument for `reply_lint_version`, which is the same lint one subject along).
  lint_version          text        not null
                          constraint seo_suggestion_lint_version_is_stated
                          check (not is_placeholder_text(lint_version) and length(lint_version) between 3 and 100),
  -- How many banned terms the lint compared against. ADR 0002 in the schema, exactly as
  -- `publication_lint_pass.terms_checked` is: a lint over an empty vocabulary passes everything.
  lint_terms_checked    smallint    not null
                          constraint seo_suggestion_lint_examined_something
                          check (lint_terms_checked > 0),
  -- The rule names that refused it, for a refused row only. See §6.
  refused_rules         text[]      not null default '{}',
  -- Which provider drafted it, from `LLM_PROVIDER_NAMES`. A text column rather than an enum because the
  -- name set lives in `packages/shared/src/llm-provider.ts` and is already held equal to the setting.
  llm_provider          text        not null
                          constraint seo_suggestion_provider_is_stated
                          check (not is_placeholder_text(llm_provider) and length(llm_provider) between 2 and 60),
  input_tokens          integer     not null
                          constraint seo_suggestion_input_tokens_not_negative check (input_tokens >= 0),
  output_tokens         integer     not null
                          constraint seo_suggestion_output_tokens_not_negative check (output_tokens >= 0),
  -- Integer fils (ADR 0007), through the `fils_nonneg` DOMAIN rather than a CHECK of its own: the domain
  -- is what `agent_run.cost_fils` uses, so the per-suggestion figure and the per-run total it sums into
  -- cannot disagree about what a fils is or about whether a negative one exists.
  cost_fils             fils_nonneg not null,
  applied_record_id     uuid        references publication_record (id),
  rolled_back_record_id uuid        references publication_record (id),
  -- The caller's clock, NOT defaulted, for 0093's reason: every ordering assertion in this area is made
  -- under a frozen clock and a column defaulting to now() cannot be frozen.
  proposed_at           timestamptz not null,
  created_at            timestamptz not null default now(),

  -- A suggestion that changes nothing. See §3.
  constraint seo_suggestion_changes_something
    check (before_content_sha256 <> after_content_sha256),
  -- The publication chain, per state. A CHECK and not a trigger: every column it reads is on the row.
  constraint seo_suggestion_names_the_publications_its_state_implies
    check (
      case state
        when 'applied' then applied_record_id is not null and rolled_back_record_id is null
        when 'rolled_back' then applied_record_id is not null and rolled_back_record_id is not null
        else applied_record_id is null and rolled_back_record_id is null
      end
    ),
  -- A refusal with no reason on it is a refusal nobody can act on; a rule name on a row nothing refused
  -- is a reason for a decision that was not made. Both directions, because only one of them is the
  -- mistake somebody makes.
  constraint seo_suggestion_refusal_names_its_rules
    check ((state = 'refused') = (cardinality(refused_rules) > 0))
);

comment on table seo_suggestion is
  'One SEO recommendation, with the before-state STORED rather than reconstructed, the after-state, and a '
  'NOT NULL descriptor saying how the before-state goes back. Applying one is a human action through the '
  'publication control plane (0093); this table never publishes anything. Every evidence column is '
  'immutable and no row may be deleted (ZY402), so a suite asserts a delta and never a total.';

comment on column seo_suggestion.rollback_descriptor is
  'HOW the stored before-state is restored - the method and the surface - and deliberately NOT a second '
  'copy of before_regions, which would be two answers to compare on the day somebody needs one. ZY401 '
  'refuses a descriptor that names no restorable before-state.';

create index seo_suggestion_surface_idx on seo_suggestion (surface, proposed_at desc);
create index seo_suggestion_run_idx on seo_suggestion (run_id);
-- The queue an admin screen reads: what is waiting for a decision, newest first.
create index seo_suggestion_open_idx on seo_suggestion (proposed_at desc)
  where state in ('proposed', 'approved');

-- ---------------------------------------------------------------------------------------------
-- ZY401 — a rollback descriptor that names no restorable before-state.
-- ---------------------------------------------------------------------------------------------
--
-- NOT NULL already refuses an absent one, which is what the acceptance line asks for. This is the other
-- half: `'{}'::jsonb` is not null, and a descriptor that says nothing is a rollback nobody can perform —
-- discovered at the moment somebody needs it, which is the worst moment to discover it.
--
-- The method set is closed and has one member. `publication_revert` is how the before-state goes back:
-- `revertSurfaceTo` in 0093's repository, which appends a record superseding the live one rather than
-- editing anything. A second method would need its own entry here, which is the point of a closed set — a
-- descriptor naming a mechanism nothing implements is the same defect as a null one, one step later.
--
-- The surface is compared because the descriptor and the row are written together and a mismatch means the
-- restore would be attempted on another page. That is not a hypothetical class of bug: `surface` is a
-- string locator with no foreign key (§6), so nothing else in the schema can notice.

create or replace function assert_seo_suggestion_rollback_usable()
returns trigger
language plpgsql
as $$
begin
  if jsonb_typeof(new.rollback_descriptor) is distinct from 'object' then
    raise exception
      'ZY401: the rollback descriptor of suggestion % is %, not an object. The before-state is stored on '
      'the row; the descriptor is what says how it goes back, and a rollback that cannot be performed is '
      'a change with no way back.',
      new.id, coalesce(jsonb_typeof(new.rollback_descriptor), 'null')
      using errcode = 'ZY401';
  end if;

  if new.rollback_descriptor ->> 'method' is distinct from 'publication_revert' then
    raise exception
      'ZY401: the rollback descriptor of suggestion % names method %, which nothing implements. The one '
      'method is publication_revert, which appends a record superseding the live one (0093) rather than '
      'editing a published surface.',
      new.id, coalesce(new.rollback_descriptor ->> 'method', 'nothing')
      using errcode = 'ZY401';
  end if;

  if new.rollback_descriptor ->> 'surface' is distinct from new.surface then
    raise exception
      'ZY401: the rollback descriptor of suggestion % would restore surface % while the suggestion is '
      'about %. surface is a locator with no foreign key, so nothing else in this schema could notice a '
      'restore aimed at another page.',
      new.id, coalesce(new.rollback_descriptor ->> 'surface', 'nothing'), new.surface
      using errcode = 'ZY401';
  end if;

  return new;
end;
$$;

create trigger seo_suggestion_rollback_usable
  before insert or update on seo_suggestion
  for each row execute function assert_seo_suggestion_rollback_usable();

-- ---------------------------------------------------------------------------------------------
-- ZY402 — the evidence is immutable, and nothing may be deleted.
-- ---------------------------------------------------------------------------------------------
--
-- The permitted state moves are the only mutation this table has:
--
--   proposed  -> approved     a human approved the drafted copy
--   proposed  -> refused      the lint or the response screen refused it; it never reaches a publication
--   approved  -> applied      the publication control plane published it
--   applied   -> rolled_back  the stored before-state went back
--
-- Nothing else, and in particular NOT `refused -> approved`: a refused suggestion is re-drafted as a new
-- row under a new run, because the thing that refused it was a lint version and a profile version, and a
-- row promoted past its own refusal would carry a lint stamp for a decision the lint did not make.
--
-- `rolled_back` is terminal. Re-applying is a new suggestion: the before-state of the second apply is what
-- the page says after the rollback, which is a different document from the one this row recorded.

create or replace function assert_seo_suggestion_evidence_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'ZY402: suggestion % may not be deleted. This row is the evidence that the content published was '
      'the content linted, and evidence that can be removed after the fact is not evidence. Assert a '
      'DELTA on this table rather than a total.',
      old.id
      using errcode = 'ZY402';
  end if;

  if new.run_id is distinct from old.run_id
     or new.surface is distinct from old.surface
     or new.before_regions is distinct from old.before_regions
     or new.before_content_sha256 is distinct from old.before_content_sha256
     or new.after_regions is distinct from old.after_regions
     or new.after_content_sha256 is distinct from old.after_content_sha256
     or new.rollback_descriptor is distinct from old.rollback_descriptor
     or new.lint_version is distinct from old.lint_version
     or new.lint_terms_checked is distinct from old.lint_terms_checked
     or new.llm_provider is distinct from old.llm_provider
     or new.input_tokens is distinct from old.input_tokens
     or new.output_tokens is distinct from old.output_tokens
     or new.cost_fils is distinct from old.cost_fils
     or new.proposed_at is distinct from old.proposed_at then
    raise exception
      'ZY402: an UPDATE of suggestion % would change an evidence column. Only the state and the two '
      'publication references move; the run, the surface, the before and after content, the rollback '
      'descriptor, the lint stamp and the cost are what the row exists to record.',
      new.id
      using errcode = 'ZY402';
  end if;

  if (old.state, new.state) not in (
       ('proposed', 'approved'),
       ('proposed', 'refused'),
       ('approved', 'applied'),
       ('applied', 'rolled_back')
     ) and new.state is distinct from old.state then
    raise exception
      'ZY402: suggestion % may not move from % to %. The permitted moves are proposed to approved or '
      'refused, approved to applied, and applied to rolled_back. A refused suggestion is re-drafted as a '
      'NEW row, because what refused it was a lint version and a profile version.',
      new.id, old.state, new.state
      using errcode = 'ZY402';
  end if;

  return new;
end;
$$;

create trigger seo_suggestion_evidence_immutable
  before update or delete on seo_suggestion
  for each row execute function assert_seo_suggestion_evidence_immutable();

-- ---------------------------------------------------------------------------------------------
-- ZY403 — the publication named must carry the hash the row says was applied or restored.
-- ---------------------------------------------------------------------------------------------
--
-- This is what makes *"rollback is exact"* a fact in the database rather than a property of the order in
-- which some TypeScript happened to call two functions. A composite foreign key would be better — it is
-- what 0093 uses to tie an approval to the hash its lint pass cleared — and it is not available: that
-- shape needs `unique (id, content_sha256)` on `publication_record`, which 0093 did not add, and adding a
-- unique index to another unit's append-only evidence table from this migration would be a wider change
-- than this unit needs. The trigger is the narrower answer and it is exact; the cost is that it is a
-- lookup rather than a constraint the planner can see.
--
-- Both directions, because they fail differently. An `applied` row whose record carries the BEFORE hash is
-- a suggestion recorded as live that never changed anything. A `rolled_back` row whose record carries the
-- AFTER hash is a rollback that published the suggestion a second time — and the screen would show it as
-- reverted.

create or replace function assert_seo_suggestion_published_hash()
returns trigger
language plpgsql
as $$
declare
  applied_hash   text;
  reverted_hash  text;
begin
  if new.applied_record_id is not null then
    select content_sha256 into applied_hash
      from publication_record where id = new.applied_record_id;
    if applied_hash is distinct from new.after_content_sha256 then
      raise exception
        'ZY403: suggestion % says it was applied as publication_record %, which carries content hash %, '
        'and the suggestion''s after-content hashes to %. The content published must be the content '
        'approved.',
        new.id, new.applied_record_id, coalesce(applied_hash, 'nothing'), new.after_content_sha256
        using errcode = 'ZY403';
    end if;
  end if;

  if new.rolled_back_record_id is not null then
    select content_sha256 into reverted_hash
      from publication_record where id = new.rolled_back_record_id;
    if reverted_hash is distinct from new.before_content_sha256 then
      raise exception
        'ZY403: suggestion % says it was rolled back as publication_record %, which carries content hash '
        '%, and the stored before-content hashes to %. A rollback that lands on anything else is not a '
        'rollback.',
        new.id, new.rolled_back_record_id, coalesce(reverted_hash, 'nothing'), new.before_content_sha256
        using errcode = 'ZY403';
    end if;
  end if;

  return new;
end;
$$;

create trigger seo_suggestion_published_hash
  before insert or update on seo_suggestion
  for each row execute function assert_seo_suggestion_published_hash();

commit;

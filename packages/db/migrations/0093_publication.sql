-- 0093 — nothing reaches the public without a lint pass, a named approval against a content hash, and an
--        append-only record; and none of those four facts is a promise a caller keeps.
--
-- W-SITE-10. The unit's summary is one sentence and every clause of it is a refusal in THIS file rather
-- than a guard in TypeScript, for the reason 0087 states about the promotional window: a rule that lives
-- only in the service layer is a rule for the callers that went through the service layer.
--
-- ## What already existed, and what was still only a claim
--
-- Three of the four halves were built and correct:
--
--   * `packages/core/src/access/publication.ts` (G-SEO-02) authorises a publication and says in its own
--     header that the state machine, the lint, the approval and the record "belong to W-SITE-10, which is
--     `todo`".
--   * `packages/cms/src/publication.ts` (W-SITE-07) lints CMS copy against the profile in force and
--     refuses a journal post with no byline.
--   * `apps/web/src/media/publish-gate.ts` (W-SYS-10) measures a slot image's served weight and refuses
--     one over its budget — and its own comment says a 200 "does NOT mean a page went live … there is no
--     draft → approved → published state machine yet".
--
-- What no layer held was the SEQUENCE. Nothing recorded that a lint had passed, nothing recorded who
-- approved WHAT, and nothing stopped a row reaching a published state without either. Every one of those
-- gaps is reachable from a `psql` session, from a restored dump, and from the next caller who writes a
-- publish path without reading this one — which is the definition of a rule that is not enforced.
--
-- ## Why the state machine is a CHECK and a trigger rather than one of them
--
-- 0080 and 0087 both settled this division of labour and it is exactly right here:
--
--   * the **CHECK** (`publication_record_published_needs_evidence`) is the layer that still holds when
--     `session_replication_role = 'replica'` has triggers off, which is how a restore from a dump runs.
--     A restore that silently republished a page without its approval is the one route in that nobody is
--     watching. It is also the layer that answers an UPDATE as well as an INSERT, which is what the
--     acceptance criterion asks for in those words.
--   * the **trigger** (`assert_publication_transition`, ZZ002) is what gives a human a sentence they can
--     act on: which surface, which state it is in, which state was attempted, and what has to happen
--     first. A CHECK cannot do that, because a CHECK cannot read the previous row.
--
-- The two answer different questions — "is this row self-consistent" and "does it follow the one before
-- it" — so neither is a copy of the other.
--
-- ## Why the hash chain is a FOREIGN KEY and not a trigger
--
-- `publication_approval.content_sha256` must be the hash the lint passed on, and
-- `publication_record.content_sha256` must be the hash the approval approved. Both are composite foreign
-- keys against a `unique (id, content_sha256)` on the parent, which is stronger than a trigger in the two
-- ways that matter: a foreign key is enforced during a restore with triggers off, and it cannot be
-- satisfied by a row that was edited afterwards, because the parent is append-only.
--
-- That is the whole of "approving content whose hash differs from the linted content is refused". There is
-- no message to word and no code to allocate: it is `23503`, naming the constraint, and the reason a
-- composite key is used rather than a pair of separate ones is that two single-column keys would let a
-- row cite lint pass A and hash B where both exist separately.
--
-- `match simple` is the default and is deliberately kept: a draft row has no `approval_id` and no
-- approved hash to agree with, so a NULL in the pair leaves the key unenforced, which is the behaviour
-- wanted rather than an oversight. The `published` rows are the ones the CHECK forces both columns onto.
--
-- ## Why the weight check is in the database at all
--
-- docs/08 §8 names three independent enforcement layers and the third is *"Publish — a synthetic weight
-- check inside the existing draft → lint → approval → publication record plane, so an editor's oversized
-- photo fails BEFORE publication rather than a week later in CrUX"*. The measurement itself is not a
-- thing SQL can do; what SQL can do — and what makes the layer real rather than a habit — is refuse to
-- STORE a published record that does not carry the figure it was judged on. So a published row must carry
-- the measured critical-path weight and the budget it was measured against, and the measurement must be
-- inside the budget. A publish that skipped the check has nothing to write.
--
-- The trigger carries both numbers in its message (ZZ005) and the CHECK beside it carries none, for
-- 0087's reason: the trigger is the layer a human reads and the CHECK is the layer that survives a
-- restore. The refusal an editor actually sees is `@berelax/core`'s, which carries the measured number in
-- the same sentence as the budget, because "the first question anybody asks of a breached budget is by how
-- much" (`scripts/check-budgets.mjs`, and `apps/web/src/home/budget.ts` after it).
--
-- ## Why the audit row is a DEFERRED constraint trigger
--
-- "Every publish writes an `audit_event`" is the sort of sentence that is true of the code that was
-- reviewed and false of the third caller. 0081 answered the same problem the same way (ZW003, an
-- unchanged re-publish refused at COMMIT): a `deferrable initially deferred` constraint trigger runs at
-- COMMIT, by which time the audit row either is in the transaction or is not. That makes "in the same
-- transaction" a property of the database rather than of whichever caller remembered — and it cannot be
-- satisfied by an audit row written afterwards in a second transaction, which is the failure a plain
-- AFTER trigger would have allowed.
--
-- ## Why `publication_state` is text behind a CHECK and not an enum
--
-- 0069's `merge_record_table.strategy` and 0085's `rights_request.request_type` both landed on this and
-- the reasoning transfers unchanged: the vocabulary is declared once in
-- `packages/core/src/publication/state-machine.ts`, the transition table with it, and
-- `packages/fixtures/src/publication-control-plane.itest.ts` drives EVERY pair from that table through
-- this database and asserts the two agree. An enum would make each future alignment a migration and
-- would still not have proved the two agree about the arrows, which is the part that matters.
--
-- ## The one term this file adds to `regulatory_profile`, and why it is added THERE
--
-- The banned vocabulary is the profile's (0004, ADR 0020) and this unit adds no list of its own: the page
-- lint calls `lintPublicDisplayName` with the profile in force, which is the same function the catalogue's
-- public names go through. One term was missing for a PAGE, and it is missing for a reason rather than by
-- omission: 0004's list was written for service display names, where the word cannot appear, and the
-- lint's stemmer stops at plurals and `-ing` on purpose ("a real stemmer starts matching words nobody
-- banned"), so `clinical` does not match `clinic`. A page that calls the premises a clinic is claiming a
-- Department of Health facility licence in one word, which is the exact exposure the list exists for.
--
-- So it is added where the fact lives — a new `regulatory_profile` version, which is what that table's
-- append-only versioning is FOR — and not as a second list in the lint file. Every other column is copied
-- from the row in force rather than restated, which is `opening-balances.itest.ts`'s lesson (brief rule
-- 12): a singleton ensured with hand-typed values is how a wrong registered name reached every tax
-- invoice. The new row stays `is_provisional` and its `source_note` names Y1-licence, because it is still
-- the stricter reading of an unanswered licence question and belongs on the Unconfirmed Assumptions panel.
--
-- ## The private SQLSTATEs
--
-- `ZZ001`-`ZZ005`, and `ZZ` because it is the LAST free class: 116 private codes exist across 24 classes,
-- and the convention that a class identifies a file has exactly this allocation left in it.
-- `packages/db/src/sqlstate-uniqueness.test.ts` says so in its own header, and W-SYS-12 owns replacing the
-- convention with an allocator. This file is the unit that NOTE means by "taking the last one". It does
-- not extend another file's class, which is what `ZY` had to be renamed out of after 0084 and 0085 both
-- reached for `ZA` in worktrees that could not see each other.
--
--   * `ZZ001` PublicationRecordImmutable — UPDATE or DELETE on any of the three tables.
--   * `ZZ002` PublicationTransitionNotPermitted — a state that does not follow the one before it.
--   * `ZZ003` PublicationCorrectionMustSupersede — a correction or revert that names no superseded record,
--             or names one that is not the surface's current published record.
--   * `ZZ004` PublicationNotAudited — a published record with no `audit_event` in the same transaction.
--   * `ZZ005` PublicationOverWeightBudget — a published record whose measured critical-path weight is over
--             the budget it was measured against, or which carries no measurement at all.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. The lint pass.
-- ---------------------------------------------------------------------------------------------
--
-- One row per lint run that PASSED. A failing lint writes nothing here, because a record of a failure is
-- not evidence for a publication and the failure is already an `audit_event` with the rule names on it.

create table publication_lint_pass (
  id                         uuid        primary key default uuid_generate_v7(),
  -- The locator of what was linted: a collection and a slug, never the copy. The same shape
  -- `CmsCopy.where` uses, so a refusal in an admin screen and a row here name the same thing.
  surface                    text        not null
                               constraint publication_lint_pass_surface_is_stated
                               check (not is_placeholder_text(surface) and length(surface) between 3 and 300),
  -- The sha256 of EXACTLY the content that was linted, lower-case hex. The anchor of the whole chain: an
  -- approval cites this row and this hash together, and a publication cites the approval and the same
  -- hash again.
  content_sha256             text        not null
                               constraint publication_lint_pass_hash_is_sha256
                               check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- WHICH profile decided. Stored rather than looked up when read, for 0004's own stated reason: a
  -- historical decision has to be explainable — "we published that copy because the profile in force said
  -- we could" — and a version recomputed from today's row would rewrite the past.
  regulatory_profile_version integer     not null references regulatory_profile (version),
  -- How many banned terms the pass actually compared against. ADR 0002 in the schema: a lint that
  -- examined an empty vocabulary passes everything, and a row recording such a pass would be evidence for
  -- a check that ran and looked at nothing. Zero is refused here rather than noticed later.
  terms_checked              smallint    not null
                               constraint publication_lint_pass_examined_something
                               check (terms_checked > 0),
  -- The caller's clock, NOT defaulted: every deadline and ordering assertion in this area is made under a
  -- frozen clock, and a column that defaults to now() cannot be frozen (0056, 0064, 0085).
  linted_at                  timestamptz not null,
  actor_kind                 text        not null
                               constraint publication_lint_pass_actor_kind_known
                               check (actor_kind in ('staff', 'system')),
  actor_label                text        not null
                               constraint publication_lint_pass_actor_is_stated
                               check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  created_at                 timestamptz not null default now(),
  -- The parent side of the approval's composite key. `id` is already unique; the PAIR is what makes
  -- "this approval is for the hash this lint passed" a foreign key rather than a trigger.
  constraint publication_lint_pass_id_and_hash unique (id, content_sha256)
);

comment on table publication_lint_pass is
  'One PASSED run of the banned-claims lint over one surface, against the regulatory_profile version that '
  'decided it. UPDATE and DELETE raise (ZZ001): this row is the evidence a publication cites, and '
  'evidence that can be edited after the fact is not evidence. A re-lint is a NEW row.';
comment on column publication_lint_pass.content_sha256 is
  'sha256 of exactly the content that was linted, lower-case hex. The approval and the publication both '
  'carry the same value through composite foreign keys, so content that changed after the lint cannot be '
  'approved or published.';
comment on column publication_lint_pass.terms_checked is
  'How many banned terms the pass compared against. > 0, because a lint over an empty vocabulary passes '
  'everything and a row recording it would be evidence for a check that examined nothing (ADR 0002).';

create index publication_lint_pass_surface_idx on publication_lint_pass (surface, linted_at desc);

-- ---------------------------------------------------------------------------------------------
-- 2. The approval.
-- ---------------------------------------------------------------------------------------------
--
-- A named human act against a content hash. The three snapshot columns are the point of the table: an
-- approval that stored only a user id would be rewritten by a rename, and "who approved this copy" is the
-- question an inspection asks.

create table publication_approval (
  id                        uuid        primary key default uuid_generate_v7(),
  lint_pass_id              uuid        not null references publication_lint_pass (id),
  content_sha256            text        not null
                              constraint publication_approval_hash_is_sha256
                              check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Who. The id is the audit key and is NOT a foreign key to a staff table, because there is none yet
  -- (W-SYS-11 is building the real admin session) and because the record of an approval outlives the
  -- record of the person, which is 0085's reasoning for `rights_request.subject_customer_id`.
  approver_user_id          text        not null
                              constraint publication_approval_approver_is_identified
                              check (not is_placeholder_text(approver_user_id)
                                     and length(approver_user_id) between 1 and 200),
  -- A SNAPSHOT of the display name as it stood at the moment of approval. Not a join: a later rename
  -- would otherwise rewrite who approved what, which is the same failure `invoice.issuer_legal_name`
  -- (0026) is a snapshot against. There is no invented name here and none is possible — the value comes
  -- from the row the approver was signed in as, and a blank one is refused rather than defaulted.
  approver_display_name     text        not null
                              constraint publication_approval_name_is_stated
                              check (not is_placeholder_text(approver_display_name)
                                     and length(approver_display_name) between 1 and 200),
  -- And the role they held then, for the same reason. Constrained against F07's role set: a role this
  -- database has never heard of is refused rather than stored, because `can(role, …)` deciding on an
  -- unknown string is worse than a refusal (`apps/web/src/payload/principal.ts`).
  approver_role             text        not null
                              constraint publication_approval_role_known
                              check (approver_role in ('owner', 'manager', 'accountant', 'receptionist',
                                                       'therapist', 'marketer', 'auditor', 'system')),
  approved_at               timestamptz not null,
  created_at                timestamptz not null default now(),
  -- The hash the lint passed on, and this approval's hash, as ONE key. Approving content whose hash
  -- differs from the linted content is 23503 naming this constraint — during a restore too, which is why
  -- it is a key and not a trigger.
  constraint publication_approval_is_for_the_linted_content
    foreign key (lint_pass_id, content_sha256)
    references publication_lint_pass (id, content_sha256),
  constraint publication_approval_id_and_hash unique (id, content_sha256)
);

comment on table publication_approval is
  'One named human approval of one content hash, with the approver''s display name and role snapshotted '
  'beside their id. UPDATE and DELETE raise (ZZ001). A withdrawn approval is not an edit: it is a new '
  'draft record for the surface, which puts the state machine back at the start.';
comment on constraint publication_approval_is_for_the_linted_content on publication_approval is
  'Approving content whose hash differs from the linted content is refused here, by key rather than by '
  'trigger, so it holds during a restore with triggers off and cannot be satisfied by editing the lint '
  'pass afterwards (that row is append-only).';
comment on column publication_approval.approver_display_name is
  'Snapshotted at approval. A join would let a later rename rewrite who approved what — the same reason '
  'invoice.issuer_legal_name is a snapshot (0026).';

create index publication_approval_approver_idx on publication_approval (approver_user_id, approved_at desc);

-- ---------------------------------------------------------------------------------------------
-- 3. The publication record.
-- ---------------------------------------------------------------------------------------------

create table publication_record (
  id                           uuid        primary key default uuid_generate_v7(),
  -- The total append order within a surface. A uuid v7 is time-ordered and two rows written in one
  -- transaction share `created_at` to the microsecond, so "the row before this one" needs a column that
  -- cannot tie. The transition trigger reads it, and so does every "current state of this surface" query.
  seq                          bigint      not null generated always as identity,
  surface                      text        not null
                                 constraint publication_record_surface_is_stated
                                 check (not is_placeholder_text(surface) and length(surface) between 3 and 300),
  -- The four states of the machine. Declared in packages/core/src/publication/state-machine.ts and
  -- asserted equal to this list behaviourally; see the header on why this is text and not an enum.
  state                        text        not null
                                 constraint publication_record_state_known
                                 check (state in ('draft', 'lint_passed', 'approved', 'published')),
  content_sha256               text        not null
                                 constraint publication_record_hash_is_sha256
                                 check (content_sha256 ~ '^[0-9a-f]{64}$'),
  lint_pass_id                 uuid        references publication_lint_pass (id),
  approval_id                  uuid        references publication_approval (id),
  -- A correction or a revert. References the record it supersedes, which is how "a correction is a new
  -- record referencing the superseded one" is a column rather than a convention. Same surface, enforced
  -- by ZZ003 — a cross-surface supersession would make one page's history read as another's.
  supersedes_id                uuid        references publication_record (id),
  -- What the publish-time weight check measured, and what it measured it against. Both required on a
  -- published row: see the header on why the figure is stored rather than merely checked.
  measured_critical_path_bytes integer
                                 constraint publication_record_measurement_is_positive
                                 check (measured_critical_path_bytes is null
                                        or measured_critical_path_bytes > 0),
  critical_path_budget_bytes   integer
                                 constraint publication_record_budget_is_positive
                                 check (critical_path_budget_bytes is null
                                        or critical_path_budget_bytes > 0),
  recorded_at                  timestamptz not null,
  actor_kind                   text        not null
                                 constraint publication_record_actor_kind_known
                                 check (actor_kind in ('staff', 'system')),
  actor_label                  text        not null
                                 constraint publication_record_actor_is_stated
                                 check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  created_at                   timestamptz not null default now(),

  -- THE state machine's evidence rule, and the acceptance criterion in one line: a published state needs
  -- both a lint pass and an approval. A CHECK and not a trigger, so it answers an UPDATE as well as an
  -- INSERT and so it still answers when a restore has triggers off.
  constraint publication_record_published_needs_evidence
    check (state <> 'published' or (lint_pass_id is not null and approval_id is not null)),
  -- And an approved state needs the lint pass, for the same reason one step earlier. Written separately
  -- rather than folded in, so a violation names which step was skipped.
  constraint publication_record_approved_needs_lint
    check (state <> 'approved' or lint_pass_id is not null),
  -- The weight figures, present and inside the budget, exactly on the published rows. An earlier state
  -- carries neither: there is nothing rendered to weigh.
  constraint publication_record_published_carries_its_weight
    check ((state = 'published')
           = (measured_critical_path_bytes is not null and critical_path_budget_bytes is not null)),
  constraint publication_record_published_is_within_budget
    check (state <> 'published'
           or measured_critical_path_bytes <= critical_path_budget_bytes),
  -- Only a published row supersedes anything, and only a published row is superseded. A draft that
  -- claimed to supersede a live page would make the ledger unreadable in the one direction it is read.
  constraint publication_record_only_published_supersedes
    check (supersedes_id is null or state = 'published'),
  -- The content this row publishes is the content the approval approved. Composite key for the same
  -- reason the approval's is: it holds during a restore and cannot be satisfied by an edit, and a NULL
  -- `approval_id` on a draft leaves it unenforced, which is what `match simple` is wanted for here.
  constraint publication_record_is_the_approved_content
    foreign key (approval_id, content_sha256)
    references publication_approval (id, content_sha256)
);

comment on table publication_record is
  'The publication ledger: one row per state of one surface, appended. UPDATE and DELETE raise (ZZ001) '
  'for every role including the owner. A correction is a NEW published row naming the one it supersedes, '
  'and a revert is the same thing carrying the earlier row''s approved content hash — so the superseded '
  'record stays readable, which is the only way "what was live on that date" can be answered.';
comment on column publication_record.seq is
  'The append order within a surface. A uuid v7 ties for two rows written in one transaction, and the '
  'transition trigger needs an unambiguous "row before this one".';
comment on column publication_record.measured_critical_path_bytes is
  'What the publish-time synthetic weight check measured, stored so a publish that skipped the check has '
  'nothing to write. docs/08 SS8 enforcement layer 3.';
comment on constraint publication_record_published_needs_evidence on publication_record is
  'state = published requires both a lint_pass_id and an approval_id. A CHECK rather than a trigger so it '
  'answers an UPDATE as well as an INSERT, and so it still answers when a restore has triggers off.';

create unique index publication_record_surface_seq_idx on publication_record (surface, seq desc);
create index publication_record_state_idx on publication_record (state, recorded_at desc);
-- The revert read: the published history of one surface, newest first.
create index publication_record_published_idx on publication_record (surface, seq desc)
  where state = 'published';

-- ---------------------------------------------------------------------------------------------
-- 4. The state machine, as a refusal.
-- ---------------------------------------------------------------------------------------------
--
-- `plpgsql` and not a CHECK, because the rule is about the PREVIOUS row and a CHECK cannot read one. The
-- CHECK beside it (`publication_record_published_needs_evidence`) answers the other half; see the header.

create function assert_publication_transition() returns trigger
language plpgsql
as $$
declare
  previous_state text;
  previous_id    uuid;
  permitted      text;
begin
  select state, id into previous_state, previous_id
    from publication_record
   where surface = new.surface
   order by seq desc
   limit 1;

  -- Every state may be followed by `draft`: editing the copy is what returns a surface to the start, and
  -- it has to be available from `published` as well, or a live page could never be revised. The forward
  -- arrows are one step each, which is what makes the sequence a sequence.
  permitted := case coalesce(previous_state, '')
                 when ''            then 'draft'
                 when 'draft'       then 'draft,lint_passed'
                 when 'lint_passed' then 'draft,approved'
                 when 'approved'    then 'draft,published'
                 when 'published'   then 'draft,published'
               end;

  if permitted is null or not (new.state = any (string_to_array(permitted, ','))) then
    raise exception
      'PublicationTransitionNotPermitted: surface % is %, so it cannot move to %. Permitted from here: '
      '%. The sequence is draft -> lint_passed -> approved -> published, one step at a time, and any '
      'state may return to draft because editing the copy invalidates the hash the approval was given '
      'for. A published page is revised by a new draft, and corrected in place only by a published row '
      'that names the one it supersedes.',
      new.surface,
      coalesce(previous_state, 'unrecorded (no publication_record row)'),
      new.state,
      permitted
      using errcode = 'ZZ002';
  end if;

  -- A correction or a revert. `published` following `published` is the only way a live page changes
  -- without going back to draft, and it is exactly the shape a revert needs — so it must name what it
  -- replaces, and must name the row that is actually live rather than any older one.
  if new.state = 'published' and previous_state = 'published' then
    if new.supersedes_id is null then
      raise exception
        'PublicationCorrectionMustSupersede: surface % is already published, so this row is a correction '
        'or a revert and must name the record it supersedes (%). A second published row with no '
        'supersedes_id makes the ledger two unrelated claims about one page, and "what was live on that '
        'date" stops being answerable.',
        new.surface, previous_id
        using errcode = 'ZZ003';
    end if;
    if new.supersedes_id <> previous_id then
      raise exception
        'PublicationCorrectionMustSupersede: surface % supersedes %, which is not the record currently '
        'live (%). Superseding an older record leaves the live one unaccounted for, which reads in the '
        'ledger as two pages published at once.',
        new.surface, new.supersedes_id, previous_id
        using errcode = 'ZZ003';
    end if;
  elsif new.supersedes_id is not null then
    raise exception
      'PublicationCorrectionMustSupersede: surface % names a superseded record (%) while moving from % to '
      '%. Only a published row following a published row supersedes anything; anywhere else the column '
      'would record a replacement that did not happen.',
      new.surface, new.supersedes_id, coalesce(previous_state, 'unrecorded'), new.state
      using errcode = 'ZZ003';
  end if;

  -- Same surface, both ends. A cross-surface supersession would make one page's history read as another's
  -- and is not reachable through the branch above, because `previous_id` is this surface's.
  if new.supersedes_id is not null
     and not exists (select 1 from publication_record
                      where id = new.supersedes_id and surface = new.surface) then
    raise exception
      'PublicationCorrectionMustSupersede: record % is not a record of surface %.',
      new.supersedes_id, new.surface
      using errcode = 'ZZ003';
  end if;

  return new;
end $$;

comment on function assert_publication_transition() is
  'Raises ZZ002 for a state that does not follow the surface''s previous record, and ZZ003 for a '
  'correction or revert that names no superseded record, the wrong one, or one belonging to another '
  'surface. The transition table is mirrored in packages/core/src/publication/state-machine.ts and the '
  'two are driven against each other pair by pair in publication-control-plane.itest.ts.';

create trigger publication_record_transition before insert on publication_record
  for each row execute function assert_publication_transition();

-- ---------------------------------------------------------------------------------------------
-- 5. The weight figures, as a refusal a human can read.
-- ---------------------------------------------------------------------------------------------
--
-- The CHECKs above already refuse the row. This exists for the same reason 0087's trigger exists beside
-- its CHECK: a CHECK violation names a constraint and cannot print the two numbers, and the first
-- question anybody asks of a breached budget is by how much.

create function assert_publication_within_weight_budget() returns trigger
language plpgsql
as $$
begin
  if new.state <> 'published' then return new; end if;
  if new.measured_critical_path_bytes is null or new.critical_path_budget_bytes is null then
    raise exception
      'PublicationOverWeightBudget: surface % cannot be published without a measured critical-path '
      'weight and the budget it was measured against. docs/08 SS8 makes the publish-time weight check one '
      'of three independent layers, and a published row carrying no figure is a publish that skipped it.',
      new.surface
      using errcode = 'ZZ005';
  end if;
  if new.measured_critical_path_bytes > new.critical_path_budget_bytes then
    raise exception
      'PublicationOverWeightBudget: surface % measured % bytes on its critical path against a budget of '
      '% (over by %). docs/08 SS8 budgets the critical above-fold weight at 250KB on a phone; the cut '
      'order in that section starts with the desktop AV1 rendition and ends with poster quality, and '
      'lowering the budget is not on it.',
      new.surface,
      new.measured_critical_path_bytes,
      new.critical_path_budget_bytes,
      new.measured_critical_path_bytes - new.critical_path_budget_bytes
      using errcode = 'ZZ005';
  end if;
  return new;
end $$;

comment on function assert_publication_within_weight_budget() is
  'Raises ZZ005 with both numbers for a published row that is over its critical-path budget or carries no '
  'measurement. The CHECK constraints beside it refuse the same rows without the numbers, and are the '
  'layer that still holds when a restore has triggers off.';

create trigger publication_record_weight_budget before insert on publication_record
  for each row execute function assert_publication_within_weight_budget();

-- ---------------------------------------------------------------------------------------------
-- 6. Every publish writes an audit_event, in the same transaction.
-- ---------------------------------------------------------------------------------------------
--
-- Deferred to COMMIT, which is what makes the claim a property of the database. See the header.

create function assert_publication_audited() returns trigger
language plpgsql
as $$
begin
  if new.state <> 'published' then return null; end if;
  if exists (select 1 from audit_event
              where entity_type = 'publication_record'
                and entity_id = new.id::text
                and action = 'publication.publish') then
    return null;
  end if;
  raise exception
    'PublicationNotAudited: publication_record % (surface %) reached COMMIT with no '
    'audit_event(action=publication.publish, entity_type=publication_record, entity_id=%) in the same '
    'transaction. An audit row written afterwards in a second transaction is not the same guarantee: the '
    'publish can commit and the audit can fail, and the only evidence that a page went live would be the '
    'page.',
    new.id, new.surface, new.id
    using errcode = 'ZZ004';
end $$;

comment on function assert_publication_audited() is
  'Raises ZZ004 at COMMIT for a published record with no matching audit_event in the same transaction. A '
  'deferrable constraint trigger rather than an AFTER trigger, so the audit row may be written either '
  'side of the record and neither may be written in a later transaction (0081 ZW003''s shape).';

create constraint trigger publication_record_audited
  after insert on publication_record
  deferrable initially deferred
  for each row execute function assert_publication_audited();

-- ---------------------------------------------------------------------------------------------
-- 7. Append-only, for every role.
-- ---------------------------------------------------------------------------------------------
--
-- A trigger and not `create rule … do instead nothing`, which reports success and lets the caller go on
-- believing the edit happened (0018's argument, restated by 0085). For EVERY role including the owner:
-- privileges cover the application role, and a migration or a psql session does not connect as it.

create function refuse_publication_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'PublicationRecordImmutable: %.% is append-only; % is refused. The lint pass, the approval and the '
    'publication record are the evidence that a page was checked, approved by a named person against a '
    'content hash, and put live. A publication that was wrong is not corrected by editing the row that '
    'records it: it is corrected by a NEW published record naming the one it supersedes, which is what '
    'keeps the superseded version readable.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'ZZ001';
end $$;

comment on function refuse_publication_record_change() is
  'Raises ZZ001 for UPDATE and DELETE on publication_lint_pass, publication_approval and '
  'publication_record, for every role including the owner.';

create trigger publication_lint_pass_no_update before update on publication_lint_pass
  for each row execute function refuse_publication_record_change();
create trigger publication_lint_pass_no_delete before delete on publication_lint_pass
  for each row execute function refuse_publication_record_change();
create trigger publication_approval_no_update before update on publication_approval
  for each row execute function refuse_publication_record_change();
create trigger publication_approval_no_delete before delete on publication_approval
  for each row execute function refuse_publication_record_change();
create trigger publication_record_no_update before update on publication_record
  for each row execute function refuse_publication_record_change();
create trigger publication_record_no_delete before delete on publication_record
  for each row execute function refuse_publication_record_change();

-- The application role must not be able to edit its own evidence either. Stated explicitly rather than
-- relying on the triggers alone: the two answer different questions ("may this role" and "may anybody"),
-- and a privilege is what a reader of `\dp` sees.
grant select, insert on publication_lint_pass to berelax_app;
grant select, insert on publication_approval  to berelax_app;
grant select, insert on publication_record    to berelax_app;
revoke update, delete, truncate on publication_lint_pass from berelax_app;
revoke update, delete, truncate on publication_approval  from berelax_app;
revoke update, delete, truncate on publication_record    from berelax_app;
-- `seq` is an identity column, so an INSERT needs nothing extra; there is no sequence to grant because
-- `generated always as identity` owns it and the insert never names it.

-- ---------------------------------------------------------------------------------------------
-- 8. The one term the page lint needs and 0004's list does not carry.
-- ---------------------------------------------------------------------------------------------
--
-- A new version, because `regulatory_profile` is append-only and versioned for exactly this (ADR 0008,
-- ADR 0020). Every column except the term list is COPIED from the row in force rather than restated: a
-- singleton re-ensured with hand-typed values is how `opening-balances.itest.ts` wrote a wrong registered
-- name onto every tax invoice (brief rule 12). `array_append` rather than a literal array, so the fourteen
-- terms 0004 seeded stay in their order — `seo-agent-cage.itest.ts` reads `banned_claim_terms[0]` as its
-- fixture term — and so this file states one term rather than fifteen.

with retired as (
  update regulatory_profile
     set superseded_at = now()
   where superseded_at is null
  returning *
)
insert into regulatory_profile (
  licence_class, emirate, clinical_retention_years, financial_retention_years,
  erasure_overrides_retention, medical_claims_permitted, permitted_public_titles,
  banned_claim_terms, mandatory_therapist_document_types, non_expiring_document_types,
  is_provisional, source_note, effective_from, created_by
)
select
  retired.licence_class, retired.emirate, retired.clinical_retention_years,
  retired.financial_retention_years, retired.erasure_overrides_retention,
  retired.medical_claims_permitted, retired.permitted_public_titles,
  array_append(retired.banned_claim_terms, 'clinic'),
  retired.mandatory_therapist_document_types, retired.non_expiring_document_types,
  retired.is_provisional,
  'Migration 0093 (W-SITE-10). Adds "clinic" to banned_claim_terms for the page lint: 0004''s list was '
  'written for service display names, where the word cannot appear, and the lexicon''s stemmer stops at '
  'plurals and -ing on purpose, so "clinical" does not match "clinic". A page calling the premises a '
  'clinic claims a Department of Health facility licence in one word. Still the stricter reading of an '
  'unanswered licence question: see OPEN-QUESTIONS Y1-licence.',
  now(), 'migration_0093'
from retired;

commit;

-- 0048 — the reply draft's provenance, and the quarantine that is the absence of one.
--
-- ## Why a migration at all, when reply_draft already exists
--
-- 0020 gave `google_reviews.reply_draft` a text column, and that is genuinely enough to store a reply.
-- It is not enough to answer any of the three questions the approval queue has to answer about a draft a
-- machine wrote:
--
--   1. **Where did these words come from?** A draft is a rendering of one of a closed set of house
--      skeletons (packages/core/src/reviews/skeletons.ts). Recording which one, with the aspects, makes
--      the draft reproducible from its provenance — so "is this what the generator produced, or did
--      somebody edit it" is a comparison rather than a memory.
--   2. **Which review text was it written against?** A reviewer edits or deletes a review far more often
--      in the first day than after it, which is why docs/07 SS4 has a cooling-off delay at all. A draft
--      approved against text that has since changed is a reply to something nobody said, and the
--      fingerprint of the untrusted region is what detects it without storing a second copy of the text.
--   3. **Was this review quarantined, and why?** A model response showing signs of having been steered by
--      the review is evidence, not noise. "No draft" and "no draft because the review tried to hijack the
--      model" are different states of the queue and only the second one is worth an operator's attention.
--
-- A NULL in any of these is the honest spelling of "not yet", the same argument 0037 makes for
-- `routing_verdict`.
--
-- ## The constraint that matters: no machine draft for an unrouted review
--
-- G-REV-03 takes the routing verdict; this unit consumes one. `google_reviews_draft_needs_a_verdict`
-- makes that ordering a fact the database holds rather than a property of the order two functions happen
-- to be called in. A reply drafted for a review nobody routed is a reply outside docs/07 SS4 entirely —
-- the table never decided whether a human must read it — and that is the failure this business would be
-- judged on.
--
-- It is scoped to the **provenance** columns rather than to `reply_draft`, deliberately. `reply_draft` has
-- been writable since 0020 and rows exist that carry a hand-typed draft with no verdict; a constraint over
-- that column would be a constraint about history rather than about this unit. Every row the generator
-- writes carries provenance, so scoping it here refuses exactly the case that can now occur and invents no
-- claim about the ones that already did.
--
-- ## And the one that keeps a quarantine honest
--
-- `google_reviews_draft_quarantine_has_no_machine_draft`. A quarantined review is one a human writes the
-- reply for. A row carrying both a quarantine reason and a machine draft would present the bland house
-- sentence beside the words "this review attempted a prompt injection", and the owner would approve the
-- sentence — which is the whole outcome the quarantine exists to prevent.

begin;

alter table google_reviews
  -- The provenance of a machine-written draft. All six together or none (see the CHECK below).
  add column reply_draft_skeleton_id        text,
  add column reply_draft_aspects            text[],
  add column reply_draft_language           text,
  add column reply_draft_prompt_version     text,
  add column reply_draft_prompt_fingerprint text,
  add column reply_draft_generated_at       timestamptz,
  -- The quarantine: a model response that showed signs of having been steered by the review.
  add column draft_quarantine_reason        text,
  add column draft_quarantined_at           timestamptz;

comment on column google_reviews.reply_draft_skeleton_id is
  'Which house skeleton the draft is a rendering of. The closed set lives in '
  'packages/core/src/reviews/skeletons.ts; deliberately NOT a check constraint here, for the reason 0037 '
  'gives about routing_rule_id — packages/db may not import packages/core, so a copy of the list here '
  'would be a second list that silently disagrees between deploys.';
comment on column google_reviews.reply_draft_aspects is
  'The aspects the model selected, in the order the skeleton renders them. With the skeleton id and the '
  'language this reproduces the draft byte for byte, which is what makes an edit detectable.';
comment on column google_reviews.reply_draft_language is
  'en | ar. The language the reply is written in, which for a review with text is the language the review '
  'was identified as.';
comment on column google_reviews.reply_draft_prompt_version is
  'The prompt shape the draft was asked for with. A draft is only explainable against the instructions '
  'that were in force, the same argument routing_lexicon_version makes for a verdict.';
comment on column google_reviews.reply_draft_prompt_fingerprint is
  'The fingerprint of the review text as it was sent to the model, after control characters were stripped '
  'and the length cap applied. A reviewer who edits their review changes it, which is how a stale draft '
  'is spotted without storing the text twice.';
comment on column google_reviews.reply_draft_generated_at is
  'When the draft was generated. Distinct from routed_at and from created_at.';
comment on column google_reviews.draft_quarantine_reason is
  'Why no draft was produced: the screen rule that refused the model response '
  '(packages/core/src/reviews/prompt-builder.ts). NULL on every ordinary row.';
comment on column google_reviews.draft_quarantined_at is
  'When the quarantine was recorded.';

-- All six together or none. A skeleton id with no fingerprint is a draft whose input is unknown, and a
-- fingerprint with no skeleton is an input whose output is unknown; either half alone reads as provenance
-- and answers nothing.
alter table google_reviews add constraint google_reviews_draft_provenance_together check (
  (reply_draft_skeleton_id is null and reply_draft_aspects is null and reply_draft_language is null
     and reply_draft_prompt_version is null and reply_draft_prompt_fingerprint is null
     and reply_draft_generated_at is null)
  or (reply_draft_skeleton_id is not null and reply_draft_aspects is not null
     and reply_draft_language is not null and reply_draft_prompt_version is not null
     and reply_draft_prompt_fingerprint is not null and reply_draft_generated_at is not null)
);

-- Provenance describes a draft, so there must be one.
alter table google_reviews add constraint google_reviews_draft_provenance_needs_a_draft check (
  reply_draft_skeleton_id is null or reply_draft is not null
);

-- THE ORDERING, as a fact the database holds: generation consumes a verdict, so a machine-written draft
-- cannot exist for a review the docs/07 SS4 table has never seen.
alter table google_reviews add constraint google_reviews_draft_needs_a_verdict check (
  reply_draft_skeleton_id is null or routing_verdict is not null
);

-- The reply language vocabulary. Two members, both of which this build can identify a review as; a third
-- would be a language nothing can recognise and therefore a reply nobody can check.
alter table google_reviews add constraint google_reviews_draft_language_known check (
  reply_draft_language is null or reply_draft_language in ('en','ar')
);

-- Blank passes NOT NULL and answers nothing. One representation of absent, and it is NULL (0020's
-- argument for comment_text).
alter table google_reviews add constraint google_reviews_draft_skeleton_not_blank check (
  reply_draft_skeleton_id is null or length(btrim(reply_draft_skeleton_id)) > 0
);
alter table google_reviews add constraint google_reviews_draft_prompt_version_not_blank check (
  reply_draft_prompt_version is null or length(btrim(reply_draft_prompt_version)) > 0
);
alter table google_reviews add constraint google_reviews_draft_fingerprint_not_blank check (
  reply_draft_prompt_fingerprint is null or length(btrim(reply_draft_prompt_fingerprint)) > 0
);

-- Both quarantine columns together or neither, same argument as the provenance group.
alter table google_reviews add constraint google_reviews_draft_quarantine_together check (
  (draft_quarantine_reason is null and draft_quarantined_at is null)
  or (draft_quarantine_reason is not null and draft_quarantined_at is not null)
);
alter table google_reviews add constraint google_reviews_draft_quarantine_reason_not_blank check (
  draft_quarantine_reason is null or length(btrim(draft_quarantine_reason)) > 0
);

-- A quarantined review carries no machine draft. See the header: a bland house sentence offered beside
-- "this review attempted a prompt injection" is a sentence that gets approved.
alter table google_reviews add constraint google_reviews_draft_quarantine_has_no_machine_draft check (
  draft_quarantine_reason is null or reply_draft_skeleton_id is null
);

-- The read the generator makes: routed, and neither drafted nor quarantined yet. Partial, because it is a
-- small and differently-growing fraction of the table — the same reason 0037's two indexes are partial,
-- and it must not degrade into a scan of every review ever left.
create index google_reviews_undrafted_idx
  on google_reviews (connection_id, reviewed_at)
  where routing_verdict is not null and reply_draft is null and draft_quarantine_reason is null;

commit;

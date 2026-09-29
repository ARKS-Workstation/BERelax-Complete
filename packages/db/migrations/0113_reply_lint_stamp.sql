-- 0113 — the reply lint stamp: a delivery timestamp becomes impossible without one.
--
-- G-REV-05. docs/10 §6 says the same linter runs in both delivery modes and the manifest says it "sits on
-- the send path, so a caller cannot route around it". This file is the half of that claim a TypeScript
-- signature cannot make.
--
-- ## What the columns are for, and why there are four of them
--
-- `reply_approved_text` is the bytes that were linted and delivered — not `reply_draft`, which is the
-- MACHINE's sentence and the thing an owner edits in the approval queue (0048, `recordReplyDraft` is
-- guarded by `reply_draft is null` precisely so an edit is never overwritten). The two are different facts
-- the moment anybody edits anything, and the one that matters afterwards is what was published: it is what
-- G-REV-06's *Copy reply* puts on the clipboard byte for byte, and it is the only thing a stored hash can
-- be a hash OF.
--
-- `reply_lint_version` names the rule set that cleared it (`SEND_PATH_LINT_VERSION` in
-- `packages/core/src/reviews/reply-linter.ts`), so "why was this reply publishable" is answerable against
-- the rules that judged it rather than against today's — the same device `routing_lexicon_version` is for
-- a verdict, and the same reason.
--
-- `reply_lint_content_sha256` is a hash over exactly those bytes, lower-case hex, computed by the caller.
-- Stored rather than recomputed because its whole job is to be COMPARED: a reply whose text no longer
-- hashes to it has been changed since it was judged, and that is a question no amount of re-linting
-- answers.
--
-- `reply_lint_passed_at` is when. The four move together or not at all
-- (`google_reviews_reply_lint_stamp_is_whole`): three of the four is a stamp that reads as evidence and
-- cannot be checked, which is worse than none.
--
-- ## The constraint that is the unit
--
-- `google_reviews_delivery_needs_a_lint_pass`. `submitted_at` (API mode) and `posted_manually_at` (fallback
-- mode, which is the launch mode) are the only two ways a reply becomes public, and neither may be set on a
-- row carrying no lint stamp. The TypeScript half is that `recordReplySubmittedToApi` and
-- `recordReplyPostedManually` now take the stamp as a required argument, so a caller cannot reach the
-- timestamp without presenting one; this is what holds when somebody writes the UPDATE by hand, which is
-- how 0037's autosend floor is argued for and the same answer.
--
-- Both modes, in one constraint and not two, because the claim is about delivery rather than about either
-- mode: a second constraint per mode is the shape that ends up covering one of them.
--
-- ## Validated, not NOT VALID, and why that is safe here
--
-- A CHECK added over existing rows fails if any row breaks it. No row can: nothing in `apps/` writes either
-- timestamp — G-REV-06, which adds the *Marked as posted* action, is `todo` — and the only callers of the
-- two repository functions in the whole repository are integration suites that remove their own
-- `google_reviews` rows in `afterAll`. So the set of delivered rows in any database this migration reaches
-- is empty, and stating the constraint the strict way is free. If it ever does fail, the rows it names are
-- test residue and the message says which constraint refused them.
--
-- ## The cap in the schema, and the check that holds the two numbers equal
--
-- `google_reviews_reply_approved_text_within_cap` carries 1,200 — the published cap from docs/10 §6 by way
-- of `REPLY_LENGTH_CAP`. That IS a second statement of a figure, so it arrives with the check that refuses a
-- disagreement: `packages/google/src/reviews/reply-delivery.itest.ts` reads this constraint's own
-- definition out of
-- `pg_constraint` and asserts the number in it equals `REPLY_LENGTH_CAP`. Without that the two drift the
-- first time the cap moves, and the direction it drifts in is the dangerous one — a database that still
-- accepts what the linter has started refusing.
--
-- That check is in `packages/google` and not beside the other `google_reviews` constraint probes in
-- `packages/db/src/schema/reviews.itest.ts`, and the reason is ADR 0001: `packages/db` may not import
-- `packages/core`, so a suite living there cannot NAME the constant it is holding this number equal to.
-- The whole 0113 constraint block therefore lives with the send path, where both sides are reachable.
--
-- No new SQLSTATE. Every refusal here is an ordinary `23514` check violation naming its own constraint,
-- which is all an operator needs: the constraint name says which rule refused and the row says why. A
-- private code exists for a refusal that has a RUNBOOK answer (ADR 0043, 0061), and the answer to all four
-- of these is the same one sentence — lint the reply and deliver it through the send path.

begin;

alter table google_reviews
  -- The bytes delivered. See the header on why this is not `reply_draft`.
  add column reply_approved_text       text,
  add column reply_lint_version        text,
  add column reply_lint_content_sha256 text,
  add column reply_lint_passed_at      timestamptz;

comment on column google_reviews.reply_approved_text is
  'The exact reply that was linted and delivered, including any auto-appended signature. NOT reply_draft, '
  'which is the machine draft an owner edits: after an edit the two differ, and what was published is the '
  'one a stored hash can be over.';
comment on column google_reviews.reply_lint_version is
  'The reply-linter rule set that cleared it (SEND_PATH_LINT_VERSION). Resolves back through '
  'replyLinterFor(), so a past decision is explained by the rules that took it.';
comment on column google_reviews.reply_lint_content_sha256 is
  'sha256 of reply_approved_text, lower-case hex, computed by the caller. Compared, never trusted: a reply '
  'that no longer hashes to it has changed since it was judged.';
comment on column google_reviews.reply_lint_passed_at is
  'When the lint passed. Part of the whole-stamp constraint, so a stamp cannot be half written.';

alter table google_reviews
  -- All four or none. Three of four is evidence nobody can check.
  add constraint google_reviews_reply_lint_stamp_is_whole
    check (
      (reply_approved_text is null and reply_lint_version is null
       and reply_lint_content_sha256 is null and reply_lint_passed_at is null)
      or
      (reply_approved_text is not null and reply_lint_version is not null
       and reply_lint_content_sha256 is not null and reply_lint_passed_at is not null)
    ),
  -- Lower-case hex, 64 characters. An upper-case or truncated digest compares unequal to a correctly
  -- computed one, so a hash that is not this shape is a hash that will silently never match.
  add constraint google_reviews_reply_lint_sha256_is_hex
    check (reply_lint_content_sha256 is null or reply_lint_content_sha256 ~ '^[0-9a-f]{64}$'),
  -- The cap, in the schema. Held equal to REPLY_LENGTH_CAP by reply-delivery.itest.ts — see the header.
  add constraint google_reviews_reply_approved_text_within_cap
    check (
      reply_approved_text is null
      or (btrim(reply_approved_text) <> '' and length(reply_approved_text) <= 1200)
    ),
  -- The unit. Neither delivery mode may record a delivery on a reply nothing has linted.
  add constraint google_reviews_delivery_needs_a_lint_pass
    check (
      (submitted_at is null and posted_manually_at is null)
      or reply_lint_version is not null
    );

comment on constraint google_reviews_delivery_needs_a_lint_pass on google_reviews is
  'The send-path chokepoint as a floor: submitted_at (API mode) and posted_manually_at (fallback mode) are '
  'the two ways a reply becomes public, and neither may be set on a row with no lint stamp. The '
  'TypeScript half is that both repository writers take the stamp as a required argument; this is what '
  'holds for an UPDATE written by hand.';
comment on constraint google_reviews_reply_approved_text_within_cap on google_reviews is
  'The 1,200-character cap from docs/10 SS6, measured on the delivered bytes. reply-delivery.itest.ts '
  'holds this '
  'number equal to REPLY_LENGTH_CAP in @berelax/core.';

commit;

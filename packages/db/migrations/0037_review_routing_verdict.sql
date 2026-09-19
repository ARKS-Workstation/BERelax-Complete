-- 0037 — the routing verdict on a review: the decision, the rule that took it, and the lexicon it was
-- taken against. Plus the floor, in the database, that no setting and no application bug can lower.
--
-- G-REV-01 deliberately did not add these columns (its manifest note says so): a column no code writes is
-- worse than a missing one, because it reads as "no rule fired" rather than as "nothing has been built".
-- G-REV-03 is the code, so this is the migration.
--
-- Three columns, and each of them answers a question the reply queue cannot answer without it:
--
--   1. `routing_verdict` — auto_send or escalate. The decision.
--   2. `routing_rule_id` — WHICH row of the docs/07 §4 table decided it. docs/07 §4 is a safety control in
--      a health-adjacent business, and "escalated" with no reason is a control nobody can audit: the
--      operator cannot tell a one-star review from a five-star one mentioning an injury, and neither can
--      an inspector. The id is a closed set in `packages/core/src/reviews/routing.ts`, and this column is
--      deliberately NOT a check constraint against that set — see the note below.
--   3. `routing_lexicon_version` — which version of the escalation lexicon the text was compared against.
--      Without it a verdict is only explainable against today's terms, so an audit of a decision taken
--      before a term was added reaches the wrong conclusion about it. `reviewEscalationLexiconFor` resolves
--      this string back to the lexicon that produced the verdict.
--
-- Plus `routed_at`, because "not yet routed" and "routed and escalated" are different states of the queue
-- and a NULL verdict is the only honest spelling of the first.
--
-- ## Why the rule id has no check constraint and the verdict does
--
-- The verdict is a two-member vocabulary that a database can own: a third value would be a third outcome
-- nobody designed, and the constraint is what refuses it. The rule id is a list of fourteen that changes
-- when the table changes, and a copy of it here would be a second list — one that a migration has to
-- rewrite every time a row is added, and that silently disagrees with `packages/core` in the meantime.
-- `packages/db` may not import `packages/core` (ADR 0001), so the two could not be kept in step by the
-- type system either. So the database owns what it can own alone, and the closed set is proved where it is
-- declared: `reviewVerdictForRule` answers `escalate` for any id this build does not know, which is the
-- direction that matters when an old row is read by a new build.
--
-- ## The floor: three CHECK constraints that no setting can relax
--
-- This is the part that makes the routing table settings-proof rather than merely correct. docs/07 §4
-- permits an auto-sent reply in exactly one case — 4-5 star, no free text, API mode — so those three
-- conditions are asserted by the database on the row itself. An owner cannot enable their way past them, a
-- future caller cannot write an auto_send verdict onto a one-star review, and a bug in any of the ten rows
-- of the routing table fails loudly at the INSERT instead of publishing a reply.
--
-- The deliberate duplication is the point, and it is the same argument `google_reviews_delivery_fields_
-- match_mode` makes in 0020: a rule that lives only in application code is a rule that holds for the paths
-- somebody remembered.

begin;

alter table google_reviews
  -- NULL means "not routed yet", which is the state of every row between intake and the router running.
  add column routing_verdict         text,
  add column routing_rule_id         text,
  add column routing_lexicon_version text,
  add column routed_at               timestamptz;

comment on column google_reviews.routing_verdict is
  'auto_send | escalate, or NULL for a review that has not been routed yet. Constrained to those two: a '
  'third outcome is not a state docs/07 SS4 describes.';
comment on column google_reviews.routing_rule_id is
  'Which row of the docs/07 SS4 routing table decided the verdict, so an audit can explain any decision. '
  'The closed set lives in packages/core/src/reviews/routing.ts; an id this build does not know reads as '
  'escalate through reviewVerdictForRule, never as auto_send.';
comment on column google_reviews.routing_lexicon_version is
  'The escalation lexicon version the text was compared against. Reproduces a historical verdict: without '
  'it a decision is only explainable against today terms.';
comment on column google_reviews.routed_at is
  'When the verdict was taken. Distinct from created_at, which is when the review was recorded.';

-- All four together or none. A verdict with no rule id is an unexplainable decision, and a rule id with no
-- verdict is a reason for nothing; either half alone is a row that reads as routed and cannot be audited.
alter table google_reviews add constraint google_reviews_routing_recorded_together check (
  (routing_verdict is null and routing_rule_id is null
     and routing_lexicon_version is null and routed_at is null)
  or (routing_verdict is not null and routing_rule_id is not null
     and routing_lexicon_version is not null and routed_at is not null)
);

-- The vocabulary. `in (...)` rather than an enum type because the set is two members and the migration
-- that would add a third is the place to think about it; an enum would also need an ALTER TYPE outside a
-- transaction on some paths.
alter table google_reviews add constraint google_reviews_routing_verdict_known check (
  routing_verdict is null or routing_verdict in ('auto_send','escalate')
);

-- A blank rule id or lexicon version passes NOT NULL and answers nothing. One representation of "absent",
-- and it is NULL (the same argument 0020 makes for comment_text).
alter table google_reviews add constraint google_reviews_routing_rule_id_not_blank check (
  routing_rule_id is null or length(btrim(routing_rule_id)) > 0
);
alter table google_reviews add constraint google_reviews_routing_lexicon_version_not_blank check (
  routing_lexicon_version is null or length(btrim(routing_lexicon_version)) > 0
);

-- THE FLOOR, part 1: an auto-sent reply requires a 4-5 star review. docs/07 SS4 row 2 — "1-2 star: always
-- escalated to a human, never auto-sent" — is the row this business would be judged on, and a rating is on
-- the same row as the verdict, so the database can hold it without consulting anything.
alter table google_reviews add constraint google_reviews_autosend_needs_high_rating check (
  routing_verdict is distinct from 'auto_send' or rating >= 4
);

-- THE FLOOR, part 2: no free text. docs/07 SS4 row 1 permits an auto-send only for a review with none, and
-- 0020 already guarantees that "no free text" has exactly one spelling here — NULL, never ''.
alter table google_reviews add constraint google_reviews_autosend_needs_no_comment check (
  routing_verdict is distinct from 'auto_send' or comment_text is null
);

-- THE FLOOR, part 3: API mode. "In draft mode nothing auto-sends, because there is no API to send
-- through" (docs/07 SS4). delivery_mode is already the column that says which mode this row's reply went
-- out in, so an auto_send verdict on a manual-delivery row is a contradiction rather than a policy choice.
alter table google_reviews add constraint google_reviews_autosend_needs_api_delivery check (
  routing_verdict is distinct from 'auto_send' or delivery_mode = 'api'
);

-- The escalation queue: everything a human still has to read, newest first, per listing. Partial, because
-- the queue is a small fraction of the table and grows at a different rate from it.
create index google_reviews_escalated_idx
  on google_reviews (connection_id, place_id, reviewed_at desc)
  where routing_verdict = 'escalate';

-- Everything intake has recorded and the router has not yet judged. Partial for the same reason, and it is
-- the read an agent run does first, so it must not degrade into a scan of every review ever left.
create index google_reviews_unrouted_idx
  on google_reviews (connection_id, reviewed_at)
  where routing_verdict is null;

commit;

-- 0128 — "Marked as posted" is a named human's CLAIM, and a delivered reply's lint stamp is frozen.
--
-- G-REV-06, the approval queue. Two refusals, and they are the two halves of one sentence in docs/10 §6:
-- *"owner sees the draft with Copy reply and a deep link → posts → clicks Marked as posted."*
--
-- ## Why "Marked as posted" is a claim and not an observation
--
-- There is no Business Profile API access in this build (docs/10 §4, Y3-gbp-api), which is the whole reason
-- the approval queue exists. So when `posted_manually_at` is written, **nothing in this system has seen
-- the reply on the listing.** A person pressed a button to say they had pasted it into Google. That is a
-- claim about the outside world, and the honest way to store a claim is with whoever made it and when:
-- a row that says only *the reply was posted at 14:02* is a fact nobody is answerable for, and the first
-- question asked of it — *who said so?* — has no answer at all.
--
-- `audit_event` is where who-and-when lives for every write in this build, and a second copy of the
-- claimant on `google_reviews` would be the brief's "a second statement of a fact drifts": the trail
-- already carries `actor_kind`, `actor_id` and `occurred_at` for the write. What was missing was any
-- guarantee that the trail is there. ZY341 is that guarantee, and it is the device ZZ004 (0093) already
-- uses for a publication: a deferrable constraint trigger, so the audit row may be written either side of
-- the update and neither may be written in a LATER transaction. An audit row written afterwards is not the
-- same promise — the delivery can commit and the audit can fail, and the only record that a named person
-- claimed anything would be gone.
--
-- `actor_kind = 'staff'` and `actor_id is not null`, both. `actor_kind` alone would be satisfied by a row
-- whose label names a SURFACE rather than a person, which is what the diary, the pipeline board and the
-- quick-book screen correctly record for themselves — they have no session to read. This screen does
-- (W-SYS-11), so it has no excuse, and `actor_id` is the employee uuid the session resolves. An agent or
-- the system claiming to have pasted something into Google would be a machine's claim about a human act.
--
-- ## Scoped to the UPDATE, deliberately, and the hole is stated rather than hidden
--
-- ZY341 fires on the TRANSITION of `posted_manually_at` from NULL to non-null, which is what the screen
-- does and what `recordReplyPostedManually` issues. It does NOT fire on an INSERT that arrives already
-- carrying the timestamp. That is not an oversight and it is not free: an insert like that would slip
-- past this rule.
--
-- It is scoped that way because rows like that exist and are correct. `packages/db/src/schema/
-- reviews.itest.ts` inserts a manual delivery directly to prove 0020's two data-model decisions — that
-- `submitted_at` and `posted_manually_at` coexist and exclude each other per row — and those probes are
-- about the SHAPE of a row rather than about a queue action. Demanding an audit row from them would make
-- this migration refuse a correct test of a different rule, and the usual way that gets resolved is by
-- weakening the rule afterwards. No production path inserts a delivered row: `recordManualReview` and
-- `ingestApiReview` write neither timestamp, and 0113's `google_reviews_delivery_needs_a_lint_pass`
-- already refuses an INSERT that claims a delivery with no lint stamp.
--
-- ## ZY342 — a delivered reply's stamp is frozen, and only once it is DELIVERED
--
-- G-REV-05 deferred this here in so many words: *"0113 makes the stamp whole-or-nothing and within the
-- cap, and immutability after delivery is a trigger that unit should add."* After DELIVERY, and not after
-- approval, and the difference is the screen this unit builds: an owner approves a reply, reads it again,
-- and edits it before pasting it anywhere. Freezing the stamp at approval would make the second thought
-- impossible and the first approval final, so a re-approval overwrites the stamp and writes a second
-- `google_review.reply_approved` audit row carrying the new hash. The TRAIL is append-only (ADR 0008), so
-- every version an owner approved is recoverable even though the column holds only the last.
--
-- Once either delivery timestamp is set the row is evidence of something public, and then:
--
--   - `reply_lint_version` and `reply_lint_content_sha256` may not change. Those two ARE the decision:
--     which rule set cleared the reply, and a digest over the bytes it cleared.
--   - an already-set `submitted_at` or `posted_manually_at` may not change either, because the INSTANT is
--     half of the claim. A posting instant that can be moved is a claim with no time in it.
--
-- ## What is deliberately NOT frozen, which is the sharper half of the design
--
-- **`reply_approved_text` is not frozen, and freezing it would destroy the detector that catches a
-- tampered row.** G-REV-05 built `reproduceReplyLint`, whose `content_changed` outcome is *the stored text
-- no longer hashes to the stored digest, so it has been changed since it was judged* — and the reason that
-- outcome is reachable at all is that the DIGEST cannot move. Freeze both and a row that was edited is
-- indistinguishable from one that was not; freeze neither and whoever edits the text recomputes the hash
-- and nothing notices. Freezing exactly the digest is what makes an edit **detectable**, which is the
-- honest limit `deliver.ts` already states about this whole mechanism: the floor stops the accident, and
-- the reproduction catches the fabrication. `reply-delivery.itest.ts` constructs precisely that row.
--
-- **`reply_lint_passed_at` is not frozen either**, for a plainer reason: nothing compares it. It exists so
-- 0113's whole-stamp constraint can refuse a half-written stamp, and the one writer that legitimately
-- touches a delivered row — `recordReplyPostedManually` on a review the API had already answered, which
-- `google_reviews_delivery_fields_match_mode` is the rule that refuses — sets it to `now()` in the same
-- statement. A trigger raising first there would answer `review-queue.itest.ts`'s assertion about THAT
-- rule with this one's name, which is how a correct test of one rule comes to be about another.
--
-- `confirmed_at` is NOT frozen: it is Google's own acknowledgement arriving after an API submission
-- (0020), so it is written on a row that is already delivered by construction, and `recordReply
-- ConfirmedByGoogle` is the one writer that touches a delivered row on purpose.
--
-- Neither does ZY342 fire when a timestamp moves from NULL to non-null on an already-delivered row. That
-- sounds like a hole and is the opposite: `google_reviews_delivery_fields_match_mode` (0020) is the rule
-- that refuses a row claiming both modes, and `review-queue.itest.ts` asserts that refusal BY NAME. A
-- BEFORE trigger raising first would answer that test with this unit's code instead, which is how a
-- correct assertion about one rule comes to be about another.
--
-- ## Why both are triggers and not CHECK constraints
--
-- Neither claim is a statement about one row's columns. ZY341 compares the row to `audit_event`, which no
-- CHECK may read, and ZY342 compares NEW to OLD, which a CHECK cannot see at all. The refusals therefore
-- carry private SQLSTATEs rather than `23514`: a translator branches on the code, and each of these has a
-- different runbook answer (ADR 0043) — *press the button on the screen so the claim is attributed*, and
-- *a published reply is corrected by posting a new one, not by editing the record of the old one*.
--
-- ZY341-ZY342 of the band ZY341-ZY350 are used. ZY343 through ZY350 are released UNUSED and deliberately
-- left unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises.
--
-- No new table and no new column, so there is no Drizzle mirror to update: `pnpm db:drift` compares table
-- and column presence and nullability, and this file adds neither.

begin;

-- ---------------------------------------------------------------------------------------------
-- ZY341 — a manual posting is a named human's claim, audited in the same transaction
-- ---------------------------------------------------------------------------------------------

create or replace function assert_manual_post_is_a_claim()
returns trigger
language plpgsql
as $$
begin
  -- Only the transition. See the header on why an INSERT is outside this rule.
  if new.posted_manually_at is null or old.posted_manually_at is not null then
    return null;
  end if;
  if exists (select 1 from audit_event
              where entity_type = 'google_review'
                and entity_id = new.id::text
                and action = 'google_review.reply_posted_manually'
                and actor_kind = 'staff'
                and actor_id is not null) then
    return null;
  end if;
  raise exception
    'ManualPostIsNotAttributed: review % reached COMMIT with posted_manually_at set and no '
    'audit_event(action=google_review.reply_posted_manually, entity_type=google_review, entity_id=%, '
    'actor_kind=staff, actor_id not null) in the same transaction. There is no Business Profile API '
    'access in this build (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), so nothing here has seen the reply on the listing: this column '
    'records that a NAMED PERSON said they pasted it into Google, and without the actor it records that '
    'somebody did.',
    new.id, new.id
    using errcode = 'ZY341';
end $$;

comment on function assert_manual_post_is_a_claim() is
  'Raises ZY341 at COMMIT when posted_manually_at has just become non-null and no audit_event in the '
  'same transaction attributes the claim to a named staff actor. A deferrable constraint trigger, so the '
  'audit row may be written either side of the update and neither in a later transaction (ZZ004''s shape).';

create constraint trigger google_reviews_manual_post_is_a_claim
  after update on google_reviews
  deferrable initially deferred
  for each row execute function assert_manual_post_is_a_claim();

-- ---------------------------------------------------------------------------------------------
-- ZY342 — a delivered reply's lint stamp and its delivery instant are frozen
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_delivered_reply_change()
returns trigger
language plpgsql
as $$
declare
  changed text;
begin
  if old.submitted_at is null and old.posted_manually_at is null then
    return new;
  end if;
  changed := case
    -- The DECISION: which rule set cleared the reply, and the digest over the bytes it cleared. See the
    -- header on why reply_approved_text and reply_lint_passed_at are deliberately absent from this list.
    when new.reply_lint_version is distinct from old.reply_lint_version
      then 'reply_lint_version'
    when new.reply_lint_content_sha256 is distinct from old.reply_lint_content_sha256
      then 'reply_lint_content_sha256'
    -- Only an instant that was ALREADY set. A NULL moving to non-null on a delivered row is the
    -- both-modes contradiction, and google_reviews_delivery_fields_match_mode is the rule that names it.
    when old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at
      then 'submitted_at'
    when old.posted_manually_at is not null
         and new.posted_manually_at is distinct from old.posted_manually_at
      then 'posted_manually_at'
    else null
  end;
  if changed is null then
    return new;
  end if;
  raise exception
    'DeliveredReplyIsFrozen: review % has already been delivered (submitted_at %, posted_manually_at %) '
    'and % may not change. The stored digest exists to be COMPARED — a hash that can be rewritten to '
    'match edited text is evidence of nothing, which is also why the TEXT is left writable: a change to '
    'it is then detectable by reproduceReplyLint rather than silently matching. The instant is half of '
    'the claim that a named person posted it. A published reply is corrected by posting a new one, not by '
    'editing the record of the old one.',
    old.id, old.submitted_at, old.posted_manually_at, changed
    using errcode = 'ZY342';
end $$;

comment on function refuse_delivered_reply_change() is
  'Raises ZY342 naming the column, for a change to the lint VERSION, the DIGEST or an already-set '
  'delivery instant on a row that carries one. reply_approved_text and reply_lint_passed_at are '
  'deliberately outside it - see the migration header: freezing the digest is what makes a change to the '
  'text detectable, and freezing both would make an edited row indistinguishable from an untouched one. '
  'Before delivery the whole stamp is rewritable on purpose: an owner may re-approve an edited reply, and '
  'the append-only audit trail keeps every hash they approved.';

create trigger google_reviews_delivered_reply_frozen before update on google_reviews
  for each row execute function refuse_delivered_reply_change();

commit;

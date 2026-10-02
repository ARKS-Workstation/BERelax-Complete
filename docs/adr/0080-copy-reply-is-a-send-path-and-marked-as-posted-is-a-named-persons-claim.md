# ADR 0080 — *Copy reply* is a send path, and *Marked as posted* is a named person's claim

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** G-REV-06
- **Covers:** docs/10 §6 — *"the owner sees the draft with Copy reply and a deep link → posts → clicks
  Marked as posted"*; docs/07 §4 — mandatory human approval
- **Extends:** [ADR 0063](0063-the-reply-linter-is-a-send-path-chokepoint-the-database-enforces.md).
  **Rests on:** [ADR 0001](0001-monorepo-and-module-boundaries.md),
  [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md),
  [ADR 0008](0008-unit-of-work-and-exactly-once-per-handler.md),
  [ADR 0039](0039-the-admin-session-is-an-opaque-token.md),
  [ADR 0043](0043-a-private-sqlstate-is-five-characters-and-comes-from-a-registry.md)
- **The absence of API access is NOT an ADR.** It is docs/10 §4 and `OPEN-QUESTIONS` **Y3-gbp-api** — an
  application nobody has answered rather than a decision anybody took, which is exactly why it is an open
  question and not a record. G-REV-06's dispatch cited "ADR 0005" for it; ADR 0005 is *non-production
  cannot use a real provider*, and citing it here would have put a wrong reference in eleven files.

## Context

ADR 0063 made the reply linter a chokepoint: `deliverApprovedReply` builds its own linter from the
database, the repository writers demand a stamp they cannot produce, and migration 0113 refuses a delivery
timestamp on a row carrying no stamp. The claim it establishes is *nothing becomes public unlinted*, and it
is true of every path that existed when it was written.

This unit adds the path docs/10 §6 actually describes, and it is not one of those. **In fallback mode we
send nothing.** A human copies bytes onto a clipboard, switches to a browser, pastes them into Google and
comes back. So the moment a reply leaves this system is `navigator.clipboard.writeText`, and the two
decisions below are the two halves of what that implies.

## Decision 1 — *Copy reply* copies a stored column, never the textarea

There is **no copy control for an unapproved reply.** Approval is a WRITE: `approveReply` lints the posted
bytes through the same `lint(` expression `deliverApprovedReply` runs — one expression, extracted rather
than duplicated — and stores them as `reply_approved_text` with the version and the digest that cleared
them. *Copy reply* then reads that column, and the inline script names it by `data-testid="reply-approved"`
rather than reading the editable `reply-draft` beside it.

**The obvious alternative was to let the button copy the textarea** and lint at *Marked as posted*. It
reads as equivalent, it is one fewer write, and it is wrong in a way that no test of the send path would
ever notice: the owner copies, pastes a reply carrying a medical claim onto a public page under the
business's name, and the lint then fails on the way back — at which point the reply is already published
and the only thing refused is the record of it. ADR 0063's whole claim would be intact and defeated at the
same time. Every assertion about `deliverApprovedReply` would still pass.

So the copied bytes are bytes a linter has already cleared, and that is checkable rather than claimed:
nothing can write `reply_approved_text` without producing a `ReplyLintStamp`, `packages/db` may not import
`packages/core` (ADR 0001), and the clipboard is compared byte-for-byte against the column in a real
browser. Gate 158d points the script at the editable field and a named test fails.

**The consequence to live with:** approval is a round trip, so the screen has two steps where a
single-page editor would have none, and an owner who edits after approving must approve again. And
`markReplyPostedManually` **re-lints** the stored bytes rather than trusting the stamp, because the row is
deliberately editable between the two steps and the regulatory profile and the staff roster are live rows
(which `SEND_PATH_LINT_VERSION` records that it does not pin). A reply that has stopped being publishable
is refused on the way out rather than posted because it once passed.

## Decision 2 — *Marked as posted* records a claim, with whoever made it, and the database refuses it otherwise

There is no Business Profile API access (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api) — which is the reason this screen exists at all — so
**nothing in this build has ever seen a reply on the listing.** `posted_manually_at` is therefore not an
observation. It is a person saying they pasted something into Google, and a row that records only *the
reply was posted at 14:02* is a fact nobody is answerable for: the first question asked of it, *who said
so*, has no answer.

The claimant is **not a second column.** `audit_event` already carries `actor_kind`, `actor_id` and
`occurred_at` for every write in this build, and a copy of the actor on `google_reviews` would be the
brief's drifting second statement of a fact with the drifting copy on the row an auditor reads. What was
missing was any guarantee that the trail is there at all — so migration 0128's **ZY341** is a deferrable
constraint trigger that refuses the delivery at COMMIT unless an `audit_event` in the same transaction
attributes it to a staff actor with a non-null `actor_id`. That is ADR 0008's shape and ZZ004's device, for
ZZ004's reason: an audit row written in a later transaction is not the same promise, because the delivery
can commit and the audit can fail.

`actor_kind = 'staff'` alone would not do. A row whose label names a SURFACE satisfies it, and that is what
the diary, the pipeline board and the quick-book screen correctly record for themselves — they have no
session to read. This screen does (ADR 0039), so it has no excuse, and the id is the employee uuid the
session resolves.

The screen says the same thing in words. The stage is `claimed_as_posted` and reads *"a named person says
they posted it"*; there is no `posted`, `published` or `live` stage for it to be worded as, and gate 158f
rewords it and a named test fails.

**The consequence to live with:** the rule is scoped to the UPDATE, so an INSERT arriving with the
timestamp already set slips past it. That is stated rather than hidden, and it is deliberate: rows like
that exist and are correct — `packages/db/src/schema/reviews.itest.ts` inserts one to prove migration
0020's decision that the two modes' timestamps coexist and exclude each other per row, which is a claim
about a row's SHAPE rather than about a queue action. Demanding an audit row from that probe would make the
migration refuse a correct test of a different rule, and the way that gets resolved under pressure is by
weakening the rule.

## Decision 3 — the digest is frozen after delivery and the TEXT is not, because that is what makes an edit detectable

G-REV-05 deferred immutability here in so many words. **ZY342** freezes the lint VERSION, the DIGEST and an
already-set delivery instant once a reply has been delivered, and deliberately leaves
`reply_approved_text` and `reply_lint_passed_at` writable.

Freezing the text was the first implementation and it was wrong. `reproduceReplyLint`'s `content_changed`
outcome — *the stored text no longer hashes to the stored digest, so it has been changed since it was
judged* — is reachable **only because the digest cannot move.** Freeze both and a row that was edited is
indistinguishable from one that was not. Freeze neither and whoever edits the text recomputes the hash and
nothing notices. Freezing exactly the digest is what makes an edit **detectable**, which is the honest
limit ADR 0063 already states about this whole mechanism: the floor stops the accident, and the
reproduction catches the fabrication.

It was found by running G-REV-05's own suite, which constructs precisely that row. `reply_lint_passed_at`
is outside the rule for a plainer reason: nothing compares it, and the one writer that legitimately touches
a delivered row — a manual posting of a reply the API had already answered, which
`google_reviews_delivery_fields_match_mode` is the rule that refuses — sets it to `now()` in the same
statement, so a trigger raising first there would answer an existing assertion about THAT rule with this
one's name.

Immutability begins at DELIVERY and not at approval, because this screen has two steps: an owner approves a
reply, reads it again, and may edit it before pasting it anywhere. A re-approval overwrites the stamp and
writes a second `google_review.reply_approved` audit row carrying the new hash, and the trail is
append-only (ADR 0008), so every version an owner approved stays recoverable even though the column holds
only the last.

## Decision 4 — approving a reply is its own permission, and it is owner-only

`review:reply_approve`, granted to the owner alone, gates the queue's READ and both its writes. The F07
catalogue has carried the argument since G-REV-02 and this unit makes it an assertion: `review:record` is
data entry at the front desk — a review somebody else has already published — and this is the control that
puts a sentence on a public page under the business's name, at licensed health-adjacent premises, where
docs/07 §4 forbids a medical claim, a named therapist, an admission of fault and a discount promise. The
linter refuses all four and **the linter is not the authority**; it is the floor, and a floor exists because
the person approving is accountable for the sentence.

ONE permission and not two, which was the live question. Splitting approval from *Marked as posted* would
create a role that may assert a reply is public without being allowed to read the reply — a claim about a
sentence it may not see — and the claim is the compliance-relevant half, because it is what the audit trail
answers *who said this went out* with.

## Decision 5 — the deep link is reconstructed from the stored placeId, and no listing identifier is a literal anywhere

`placeReviewsDeepLink(review.placeId)`, from the id migration 0020 denormalises onto every review row.
Never configured, never stored as a URL, and a repository scan (`apps/web/src/reviews-deep-link.test.ts`,
three rules with three known-bad fixtures in gate cases 158a–158c) refuses a place id literal, an
identifier baked into a Maps URL, and a third place that builds one of those URLs at all.

A hard-coded link is the defect that keeps working. It opens the right business for months, and then the
account that actually administers the listing is connected (docs/10 §2 says it need not be the one verified
on the site), or the agency that still holds it hands it over, and from that moment the screen sends
somebody to paste a reply on **another business's reviews**. Nothing fails.

**The consequence to live with:** two functions in this build construct a Maps URL from a place id —
`placeReviewsDeepLink` for the reviews link and `mapsLinkFor` for G-CONN-07's listing picker — and the scan
names both rather than pretending there is one. That IS a second statement of how to reach a listing. It is
recorded as one, it predates this unit, and what the scan makes impossible is a third.

# ADR 0063 — The reply linter is a send-path chokepoint, and the database is what enforces it

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** G-REV-05
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/10 §6's *"the same linter runs"* in
  both delivery modes, and behind the manifest's claim that the linter *"sits on the send path, so a caller
  cannot route around it"*

## Decision

**A reply becomes public through exactly one function, that function builds its own linter and cannot be
handed one, and the database refuses a delivery timestamp on a row carrying no lint stamp.**

Three mechanisms, and they are three because each one alone leaves the decision true only while somebody
remembers it:

1. **`deliverApprovedReply` takes no linter.** It reads `regulatory_profile_current` and the staff roster
   itself and constructs `sendPathReplyLinter` from them. There is no argument on the send path that can
   change a verdict.
2. **`recordReplySubmittedToApi` and `recordReplyPostedManually` take a `ReplyLintStamp` as a required
   argument**, and `packages/db` may not import `packages/core` (ADR 0001) — so nothing in the write layer
   can *produce* a stamp, only record one. A caller who skips the send path has nothing to present.
3. **`google_reviews_delivery_needs_a_lint_pass`** (migration 0113) refuses `submitted_at` or
   `posted_manually_at` on a row with no `reply_lint_version`. This is what holds when somebody writes the
   UPDATE by hand, which is the only form in which the claim is a fact rather than a signature.

One constraint covering both delivery modes rather than one each, because the claim is about delivery: a
per-mode pair is the shape that ends up covering one of them, and fallback mode — the one every reply takes
on launch day (docs/10 §6) — is the one that would be forgotten, because it is the mode where *we* send
nothing.

## The alternative that was rejected, and the specific way it fails

The obvious shape is an injectable linter: `deliverApprovedReply(deps, input)` with `deps.linter`, matching
`generateReplyDrafts`, which G-REV-04 deliberately gave no default so that this unit could replace its
implementation. Consistency argues for it and so does testability.

It fails because the two functions are answering different questions. The generator's linter is a
**dependency**: the generator is one caller among several a scheduler may grow, and which rule set judges a
machine draft is a decision its caller is entitled to make. The send path's linter is the **rule**. A
delivery function that accepts a linter is a chokepoint with a parameter for walking past it, and the way
that gets used is not malice: it is a test that wanted a permissive linter, then a second caller that copied
the test, and then an admin screen that passed the linter it happened to have. The failure is silent —
a reply goes out, the row carries a lint version, and nothing distinguishes it from one that was judged.

So the send path is deliberately harder to test than it would otherwise be: there is no seam for a fake, and
`packages/google/src/reviews/reply-delivery.itest.ts` drives the real profile and the real roster. That cost
is the point. `deps` carries `signature` and `submitter` and nothing else that bears on a verdict, and if it
ever grows a `linter` field this record is what says why it must not.

## The corollary: provenance is asked of a machine draft and not of an approved reply

`not_a_house_skeleton_rendering` is a statement about the **generator** — a draft it produced must be one of
the finitely many strings `renderReplySkeleton` can make — and it is the strongest rule in the set, because
it does not depend on a lexicon being complete. It cannot be asked of a reply a human has edited, and editing
is the ordinary case: docs/10 §6's flow is that the owner sees the draft, edits it and posts it.

So `ReplyLintCandidate.origin` selects that one rule, defaults to `machine_draft` (the stricter reading, so
a caller that says nothing gets the rule), and the send path passes `approved_by_a_human`. **Every other rule
applies identically to both**, because every other rule is about what the sentence says rather than about who
wrote it. The consequence to live with is real: a hand-edited reply is judged by content rules that can miss
a phrase nobody thought of, where a machine draft is judged by membership of a closed set. That is the price
of letting an owner edit, and the alternative — refusing every edit — is a queue nobody uses.

## The consequences somebody has to live with

- **A fabricated stamp is detectable, not prevented.** The three mechanisms make a delivery with no stamp
  unreachable; they cannot make an invented one unreachable, because `ReplyLintStamp` is a plain object and
  no CHECK can tell a real lint pass from a composed one — the database cannot lint. `reproduceReplyLint`
  re-runs the stored rule set over the stored text, so the floor stops the accident (a new caller that
  forgot) and the reproduction catches the fabrication (a caller that lied). Stating the limit is the point:
  a claim of "cannot route around it" that quietly meant something narrower would be worse than the gap.
- **A signature has to pass the linter.** Every content rule reads the RENDERED reply, signature included, so
  a signature naming the business in a way `names_an_individual` reads as a person cannot be configured into
  a reply. That is the right direction and it will surprise whoever writes the settings card (G-REV-06). What
  the business actually signs replies with is `OPEN-QUESTIONS Y9-reply-signature`; the mechanism is built and
  the cap is measured over it.
- **The roster read happens on every delivery and is never cached.** The acceptance criterion is that adding
  a therapist changes the answer with no code change, and a cache would make that false for as long as it
  lived. Two small reads per delivery, on a path that runs a few times a week.
- **The stored lint version pins the rule set and not the profile.** `regulatory_profile` is append-only and
  versioned, so a reply that passed under one profile can be refused under the next — correctly, because the
  profile is the licence, not the rule set. Reading a historical profile back by version is not built:
  `reproduceReplyLint` re-runs the stored rules against the world as it is now, and says so.
- **An Arabic reply is not claim-linted.** `lintPublicDisplayName` is Latin-script by construction, which is
  the boundary the display-name lint already carries (Arabic public copy is linted where it is rendered,
  W-SITE-05 and W-SITE-10). Every other rule in the set is bilingual. Inventing an Arabic claim list here
  would produce a vocabulary indistinguishable from one the profile had configured, which brief rule 15
  refuses; the gap is recorded as a deferral on G-REV-05 rather than closed with a guess.
- **Two statements of the 1,200 cap exist**, one in `REPLY_LENGTH_CAP` and one in 0113's CHECK, and they are
  held equal by a test that reads `pg_constraint`. Without it the drift goes in the dangerous direction: a
  database still accepting what the linter has started refusing.

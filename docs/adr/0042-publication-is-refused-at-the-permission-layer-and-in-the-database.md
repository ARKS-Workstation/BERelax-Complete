# ADR 0042 — publication is refused at the permission layer and in the database, never by a prompt

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** W-SITE-10
- **Covers:** docs/01 decisions — none; this is the mechanism behind the publication control plane, and it
  is the enforcement half of the lexicon decision ADR 0020 already argued (docs/01 decision 26 says the
  lexicon is *owned* by `regulatory_profile`; this record says who is allowed to act on it and what refuses
  when nobody does)

## Decision

**Nothing reaches the public except through a state machine the DATABASE enforces, an approval a named human
gave against a content hash, and an append-only record — and the permission to do it is denied by the
permission layer, not by an instruction anybody was asked to follow.**

Concretely, four refusals, in four different layers, each of which holds when the other three are absent:

1. **`publication_record` is a sequence.** `state = 'published'` without both a `lint_pass_id` and an
   `approval_id` is refused by the CHECK `publication_record_published_needs_evidence`, and a state that does
   not follow the surface's previous record is refused by a trigger (`ZZ002`).
2. **The hash chain is two composite foreign keys.** `(lint_pass_id, content_sha256)` on the approval and
   `(approval_id, content_sha256)` on the record. Approving or publishing content whose hash differs from the
   linted or approved content is `23503`.
3. **Every publish writes an `audit_event` in the same transaction**, checked at COMMIT by a
   `deferrable initially deferred` constraint trigger (`ZZ004`).
4. **`content:publish` is held by the owner alone.** Every publish goes through `performPublication`, which
   takes the effect as an argument, so a refusal has no statement after it. The SEO agent's principal carries
   its own closed grant list of three read-ish capabilities and resolves through no role at all.

## The alternative, and the specific way it fails

The obvious design is a service function — `publishPage()` — that lints, checks the role, and writes. It is
shorter, it is testable, and every one of its guarantees is a guarantee about **the callers that went through
it**.

That is not a hypothetical objection in this repository; it is the recorded history of three units.
`createGuardedTransport` in `@berelax/messaging` was a second send path that bypassed consent, suppression,
the frequency cap and quiet hours, and it survived for months precisely because nothing called it (gate 114a).
`messaging.promotional_window` was refused a widening by exactly one function, and every other route into the
row — a seed, a settings import, a `psql` session at 02:00, the admin panel's own zod schema — accepted
`{"startHour": 0, "endHour": 24}` (migration 0087). `apps/web/src/media/publish-gate.ts` was written for two
*assertions* rather than two *implementations* on the stated grounds that two implementations drift and the
one that drifts is the one nobody clicks.

For publication the equivalent failure is worse than a bypassed rule, because the thing bypassed is a
regulatory position. This is a licensed massage and spa business in Abu Dhabi: ADDED licences the activity and
the Department of Health licences health services, so a page that says *cures*, *clinic* or *diagnosis* is
advertising an activity the premises may not deliver. A page published through a second path is not a
style defect discovered in review. It is indexed, cached, quoted by assistants, and the evidence that anybody
checked it does not exist.

And there is a second alternative worth naming because it is the one an LLM-shaped system reaches for first:
**telling the agent not to publish.** docs/07 §3 refuses it in one sentence — the SEO agent stays
*"propose-only, with publish denied at the permission layer — not a prompt instruction, an API permission"* —
and §2 puts the same rule in the compliance-locked tier beside consent gating, on the grounds that *"anything
that can be switched off eventually will be"*. A prompt is a request. `assertPrincipalMay` is not.

## The consequences somebody has to live with

- **A publish is four rows, not one.** Draft, lint pass, approval, publication, each appended, each audited.
  An editor who edits and republishes twice leaves eight. That is the cost of being able to answer "what was
  live on that date, who approved it, and against which regulatory profile" — and it is the reason the tables
  are partitioned by nothing and will grow monotonically. The alternative was one mutable row per page, which
  answers none of those three questions.
- **A correction is never an edit.** UPDATE and DELETE raise `ZZ001` for every role including the owner, and
  `update`, `delete` and `truncate` are revoked from `berelax_app` as well. A wrong publication is corrected
  by a new published record naming the one it supersedes — which is also what makes a revert work, and what
  keeps the superseded version readable. Anybody who expected to fix a typo in the ledger cannot.
- **An approval expires on an edit, and only on an edit.** The hash is taken over a canonical form
  (`packages/core/src/publication/content.ts`): the regions in document order, line endings unified, trailing
  whitespace dropped, and nothing else folded. So a paste from Word does not invalidate an approval and a
  moved paragraph does. The cost is that the canonicalisation is now a decision somebody can get wrong in a
  way no type catches, which is why it has its own test asserting both directions.
- **The weight check has to be in the request path.** docs/08 §8 names three enforcement layers and the third
  is a synthetic check at publish time. It fetches the page from the server it is running in and weighs the
  document plus every `<link rel="stylesheet">` and `<link rel="preload">` it declares, which makes a publish
  slower than a database write and makes an unrenderable page unpublishable. Both are deliberate: an editor's
  oversized photograph is the most common way a performance budget is breached, and the alternative is finding
  out from field data a week later. The figure is then STORED on the record and the database refuses a
  published row that carries none — so a publish that skipped the check has nothing to write.
- **The budget's number lives in exactly one place**, `apps/web/src/home/budget.ts`, and the gate reads it
  from there. `packages/core` may not import the application, so the pure judge takes the figure as an
  argument the way the lexicon takes the policy. A second copy of 250 KB would be a number nobody compares.
- **`ZZ` was the last free private SQLSTATE class and this unit took it.** The convention that a class
  identifies a migration file has no allocation left in it. W-SYS-12 owns replacing it with an allocator and
  is no longer optional: a migration needing a refusal code before that lands must extend an existing family,
  which `packages/db/src/sqlstate-uniqueness.test.ts` refuses, or wait.
- **One term was added to `regulatory_profile`, not to a lint file** — and it had to move the column's
  DEFAULT, not just the row. `clinic`, because 0004's list was written for service display names where the
  word cannot appear and the lexicon's stemmer deliberately stops at plurals and `-ing`, so `clinical` does
  not match it. The first attempt inserted a new version carrying `array_append(retired.banned_claim_terms,
  'clinic')` and left the default alone; `pnpm verify` then failed in this unit's own suite, four profile
  versions later, because three integration suites restore the seeded profile by inserting a row that names
  `source_note` and nothing else — so every other column takes its DEFAULT. That is the right design and gate
  case 75 protects it: it makes "the seeded profile" and "every column at its DEFAULT" one sentence, and it
  HEALS a database a killed suite left polluted. Migration 0058 had already answered the same question for
  `mandatory_therapist_document_types`, in the same order, for the same reason. So 0093 revises the default and
  then reconciles the row, and the consequence to live with is that the fifteen terms are written out once as
  a DDL default — a `set default array_append(<the old default>, …)` is not expressible, and a `DO` block
  synthesising one from `pg_get_expr` would make the most-read list in the schema unreadable. It stays
  `is_provisional` against `Y1-licence`, and every fixture copy of the old fourteen words is now stale, which
  is why the integration suite reads the row.

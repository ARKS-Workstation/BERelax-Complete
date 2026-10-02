# ADR 0086 — a suggestion STORES its before-state, applying one is a human action through the publication control plane, and the draft passes the same lint as a published page

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** G-SEO-05
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/07 §3's *"propose-only, with publish
  denied at the permission layer — not a prompt instruction, an API permission"*, and it stands on ADR 0002
  (a check that examined nothing is worse than one that failed), ADR 0003 (every gate needs a known-bad
  fixture asserted by rule name), ADR 0005 (no real provider outside production), ADR 0007 (money is integer
  fils), ADR 0008 (append-only evidence), ADR 0022 (every external service behind a port with a fake),
  ADR 0043 (a refusal is identified by all five SQLSTATE characters), ADR 0063 (the reply linter is a
  send-path chokepoint) and ADR 0070 (an unattributable figure is a refusal and never a zero)

## The problem this record is about

An agent that can change a website is a liability in exactly two ways, and they are different problems.

The first is that it changes something and nobody can put it back. A suggestion applied and not
un-appliable is a change with no way back, and the moment that matters is weeks later, when somebody asks
what the title used to say and the only copy of the answer is in a search engine's cache.

The second is that something it read tells it what to do. Its inputs are fetched competitor HTML, SERP text
and Search Console query strings — all three arrive through an API, which is exactly why they read as
trustworthy at the call site: nobody typed them into our form.

## Decision 1 — the before-state is STORED, and the rollback descriptor is NOT a second copy of it

`seo_suggestion` carries `before_regions`, `before_content_sha256`, `after_regions`,
`after_content_sha256`, a NOT NULL `rollback_descriptor` and the `agent_run.run_id` that proposed it. The
before-state is written at the moment the suggestion is drafted.

The obvious alternative is to reconstruct it: when somebody wants a change undone, read what the page says
now and work backwards. It fails in both cases a rollback exists for. An editor who touched the page
between the apply and the rollback has made the current content a *different document*, so working
backwards destroys an edit nobody asked to lose. And a suggestion that changed a title the agent had itself
changed a week earlier has no recoverable earlier state at all.

`rollback_descriptor` therefore says **how** the stored before-state goes back — the method, and the
surface — and deliberately does not repeat the regions. Two copies of one fact are two answers to compare
on the day somebody needs one. `ZY401` is what makes the descriptor a claim rather than a blob: NOT NULL
already admits `'{}'::jsonb`, and a rollback nobody can perform is discovered at the worst possible moment.

**The consequence somebody will live with.** A suggestion may only be applied when the surface's current
published record carries its stored before-hash. If the page has moved on, the apply is **refused by name**
and the pass has to be re-run. That is a refusal operators will meet, and it is the feature: the
alternative is an apply that overwrites an edit and a rollback that restores a document that was never
live.

## Decision 2 — `ZY403` is what makes "rollback is exact" a database fact

An `applied` row's `publication_record` must carry `after_content_sha256`; a `rolled_back` row's must carry
`before_content_sha256`. Without it the two hash columns are a claim about a publication nothing compared
them against, and "the content published was the content approved" would be a property of the order in
which some TypeScript happened to call two functions.

A composite foreign key would be better and is what 0093 uses to tie an approval to the hash its lint pass
cleared. It needs `unique (id, content_sha256)` on `publication_record`, which 0093 did not add, and adding
a unique index to another unit's append-only evidence table from this migration would be a wider change
than this unit needs. The trigger is the narrower answer and it is exact; the cost is a lookup the planner
cannot see.

## Decision 3 — applying is a HUMAN action, and the directory boundary is the cage

`packages/google/src/seo/draft-suggestions.ts` writes rows and cannot publish.
`packages/google/src/suggestions/apply.ts` publishes and is not the agent's code. The split is not tidiness:
`.dependency-cruiser.cjs`'s `seo-agent-must-not-reach-a-publish-path` forbids every module under
`packages/google/src/seo/` from holding a reference to a publish path, so putting the apply beside the
drafting pass would have required that rule to grow an exemption — and an exemption is how a cage stops
being one.

Applying goes through 0093's chain in 0093's order: a draft, a lint pass, a named approval against the
exact content hash, and a published record, with the `audit_event` the deferred trigger requires for the
COMMIT. None of it is re-implemented. The approver is `publication_approval.approver_user_id` and
`approver_display_name`, snapshotted there, so there is no `approved_by` column on `seo_suggestion` to be a
second answer to who approved what.

**`publication_record.supersedes_id` is NULL on this path, and that cost a run to learn.** `ZZ003` reserves
the column for a `published` row following a `published` row — a correction or a revert — and the apply
chain writes `draft`, `lint_passed` and `approved` first. The first version passed the live record's id and
the database refused it by name, which is the shape of mistake a service-layer-only guard would have let
through. So the rollback finds its target by walking the ledger for the newest published record before the
applied one, and the stored before-hash is asserted against it as a **post-condition**.

That hash check was first written as a condition inside the `filter`, where it was **vacuous**: the apply
refuses unless the live record carries the before-state, so the newest earlier published record always
carries it and the clause could never change which record was chosen. Gate case 164k found it — the clause
was removed and every test still passed. As an assertion it is reachable, and the gate case that proves it
fires takes the target from the wrong end of a surface with two earlier versions.

## Decision 4 — the draft passes the SAME lint as a published page, and there is no second linter

`judgeSeoSuggestion` calls `publicationCopyFindings`, which is `lintPublicDisplayName` over the live
`regulatory_profile` — the same function `sendPathReplyLinter` calls for its five `PUBLIC_NAME_RULES` and
the same one W-SITE-10's control plane calls before a publication. There is exactly one implementation of
*"is this claim publishable"* in this build, and this is a caller of it rather than a sibling.

ADR 0063 settled the argument for a review reply and the cost of getting it wrong is on the record:
G-REV-04's English reply used `treatment`, a term on `regulatory_profile.banned_claim_terms`, and 32 of 296
renderings were refused. An unlinted SEO draft path reproduces that defect where nobody is watching.

What this unit does **not** do is run the reply linter's whole rule set. Four of those rules are about a
*reply* — `not_a_house_skeleton_rendering` asks whether a draft is one of the 148 strings the review
generator can produce, and `language_mismatch` and `echoes_review_text` need a review — and asking them of
a page title is a category error that would refuse every suggestion this unit can make. Widening
`ReplyOrigin` with a third value to silence them was the first design and is worse: it edits a shared
contract so that a rule can be skipped, which is the injectable-linter shape ADR 0063 refuses.

The lint runs **again** at apply time, against the profile as it stands then. The stored stamp says which
rules judged the copy when it was drafted — evidence, for afterwards. The second run says whether the copy
may be published today: the profile is append-only and versioned, so a licence class confirmed between the
draft and the apply legitimately changes the answer in both directions.

## Decision 5 — an escalation attempt is screened on the ANSWER, and recorded as a security event

`screenSeoDraft` is G-REV-04's response screen applied to this subject: seven named rules over the model's
answer — an elevated role, a publication, a cache call, a crawler directive, a credential or the prompt, a
rating claim, and medical vocabulary the licence does not permit. Each is a capability
`SEO_AGENT_DENIED_CAPABILITIES` already withholds, which is the point: the permission layer is the
guarantee, and the screen is what makes the *attempt* visible.

It reads the whole answer and not the copy extracted from it, because the sentence in which a succumbed
model announces that it is now an administrator is not in the copy — screening the copy alone screens the
half an attacker does not need to use. `redteam.corpus/`'s 25 payloads carry clean after-copy on purpose,
so a payload refused for an unrelated reason cannot pass the case for the rule it names.

A refused draft is **stored** as a `refused` row rather than dropped: a refusal nobody can see is
indistinguishable from a model that produced nothing, so the day the screen starts refusing everything the
report would simply be empty. An escalation is additionally an `audit_event` whose `operation` is `denied`
— 0005's own vocabulary for a refused attempt, indexed on `action` — rather than a `security_event` table
only this unit would ever write to. The detail carries the rule names and the matched phrases, never the
model's answer: by the time an injection has worked the answer is a competitor's text, and an audit row is
read by a person.

## Decision 6 — the LLM is injected, and the seam is held to the port by a test

`seo-llm-only-through-a-prompt-module` forbids every non-`*prompt*` module under
`packages/google/src/seo/` from importing `packages/providers/src/llm/`, and its companion
`seo-prompt-must-use-the-untrusted-envelope` is satisfiable only from inside `packages/core`. Together they
mean **nothing under `packages/google/src/seo/` may reach a model at all** — which reads like an oversight
and is the design: a prompt is a pure function of its inputs, it belongs where it can be fuzzed over 200
adversarial strings with no provider and no database, and the provider is wired in from outside.

So `draft-suggestions.ts` takes a `draft` function and declares `SeoModelAnswer`, a structural seam, rather
than importing `LlmOutcome`. That is a fact stated twice, which the brief forbids unless the check holding
the two equal lands in the same commit: `redteam.test.ts` is that check — tests are exempt from the rule, so
it imports the real `LlmProvider` and builds a drafter on it, and a field renamed on the port is a compile
error there rather than a runtime surprise in the worker.

`LLM_PROVIDER` was **missing** from the configuration's real-provider refusal list, although it has been in
the schema since the provider registry was built: `LLM_PROVIDER=real` outside production parsed cleanly and
`notImplemented('llm')` threw at boot instead. That is the wrong failure in the right direction, which is
why nobody found it — the system did not start, and the message named a pending integration rather than a
misconfiguration. This unit adds it, for ADR 0005's own reason rather than by symmetry: a real model outside
production spends real money on a real key with no cap this build can see, and these prompts carry fetched
competitor HTML and Search Console query strings, so a staging run pointed at a live provider sends somebody
else's page content to a vendor under this business's account.

## Decision 7 — the cap is the RUN's, enforced between calls, and there is not a second one

`withAgentRun` + `createRunBudget` + `agent_definition.budget_fils_per_run` (G-AGT-01). Every answer is
charged **as it arrives**, before the next finding is drafted, because a cap checked at the end is a cap
that has already been exceeded. The pass is sequential for that reason and not for simplicity: a run that
fired ten requests at once would be ten calls past its budget before the first charge landed, and the
per-suggestion cost would be unattributable to the answer that incurred it.

A run that exceeds the cap aborts, `agent_run` records `budget_exceeded` with the **partial** cost, and
`recordHeartbeat` leaves `last_success_at` alone — so the watchdog sees the agent go quiet rather than
succeed with half a report. The suggestions drafted before the cap was reached stay on file, and that split
is correct: the work is real and the run did not succeed.

There is deliberately no second cap in this unit. A per-pass cap would be a second answer to whether a run
may continue, and the one that aborted the run is the one that matters. `cost_fils` is the `fils_nonneg`
domain, the same one `agent_run.cost_fils` uses, so the per-suggestion figure and the per-run total it sums
into cannot disagree about what a fils is.

## What is NOT built, and the one place the manifest is wrong

The manifest's file list names `apps/web/app/(admin)/agents/seo/suggestions/page.tsx`. The screen is a
`route.ts` + `handler.ts` + `render.ts` + `view.ts` instead, for the reason every admin surface in this
build records: `apps/web/src/routes/registry.ts` requires every **document** to be served in both locales,
so a `page.tsx` would need an Arabic admin document that W-SYS-01 has not built. A NOTE on the manifest
entry says so.

The manifest also names `packages/db/migrations/0047_seo_suggestion.sql`. 0047 does not exist and was never
this unit's; the number allocated to G-SEO-05 is **133**.

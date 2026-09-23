-- 0057 — the SEO agent's propose-only surface: the suggestion-target allowlist, in the database.
--
-- G-SEO-02 builds the cage before the animal. The permission half is `packages/core/src/access` — the
-- `system:seo_agent` principal holds no write capability but `seo_suggestion:propose`, and every publication
-- action is refused by the policy layer. This file is the other half: the one table that principal may write
-- to, shaped so that the rows it can hold are only ever proposals about copy a human reads.
--
-- ## Why the allowlist is a CHECK as well as code
--
-- `packages/core/src/seo/target-allowlist.ts` refuses a denied target with a rule name an operator can act
-- on, and it cannot be reached by a `psql` session, a restored dump, a data migration or a future job that
-- writes this table without going through the screen. The constraint can be reached by all of those, and
-- refuses with a constraint name and no explanation. Neither is redundant and neither is sufficient:
-- docs/07 §2 puts this rule in the compliance-locked tier, and "anything that can be switched off eventually
-- will be" applies to a code path more easily than to a constraint.
--
-- The two are held to each other by `packages/google/src/seo/seo-agent-cage.itest.ts`, which drives
-- `TARGET_REF_SPECIMENS` through both implementations and asserts they agree case by case — including on the
-- specimens both must ACCEPT, because two implementations that refuse everything agree perfectly.
--
-- ## Why the banned-claim filter is deliberately NOT a constraint here
--
-- The keyword filter from `regulatory_profile.banned_claim_terms` runs at the ingest boundary in code
-- (`packages/core/src/seo/candidate-screen.ts`) and has no counterpart in this file. That is a decision, and
-- the reason is the opposite of the one above.
--
-- The target allowlist is a closed set of literal labels plus a substring match over a locator, so SQL can
-- mirror it EXACTLY. The claim filter is `containsPhrase` over `lexiconTokens` — accent folding, splitting on
-- every non-alphanumeric character, and the inflection tolerance that makes "healing" the same claim as
-- "heal" — and `packages/core/src/compliance/lexicon.ts` says in its own comments why that comparison must
-- exist once: a phrase the catalogue lint refuses on a menu must not be admitted elsewhere by a second,
-- slightly different reading of the same list. A SQL re-implementation would be exactly that second reading,
-- and it would be the one nobody tests against a new term.
--
-- So the claim filter is proved where it runs — over the rows this table actually holds, by the integration
-- test — rather than asserted twice in two dialects that will diverge.
--
-- ## Why there is no foreign key to agent_run
--
-- `run_id` is the `agent_run` row the candidate came from, and it carries no reference. The same decision as
-- `agent_run.job_id` in 0021, for a related reason: run history is subject to cleanup — three integration
-- suites delete from `agent_run` between cases, and a retention policy eventually will — and a foreign key
-- would either block that or cascade away the propose-only record, which is the only evidence the agent ever
-- asked for anything. A candidate must outlive the run that produced it.

begin;

-- ---------------------------------------------------------------------------------------------
-- The denied-surface predicate, mirrored from DENIED_TARGET_REF_MARKERS in
-- packages/core/src/seo/target-allowlist.ts.
-- ---------------------------------------------------------------------------------------------
--
-- Deliberately NOT `strict`, for the reason 0026's `is_placeholder_text` records: a strict function returns
-- NULL for a NULL argument, a CHECK whose expression is NULL is SATISFIED, and the constraint would then
-- accept the NULL it exists to refuse while reading in the schema as though it did not. `target_ref` is NOT
-- NULL as well, so this is belt and braces — and the braces are what survives somebody relaxing the belt.
--
-- `immutable` because a CHECK constraint may only call an immutable function, and this one genuinely is: it
-- reads no table and no setting. The marker list is therefore a literal here rather than a row in
-- `regulatory_profile`, which is the one thing that makes this different from the claim list — the claim list
-- is a licence question with a provisional answer (Y1-licence), and these six are not questions at all. A
-- canonical is a canonical under every licence class.
create function seo_target_ref_is_denied(p_ref text) returns boolean
language sql
immutable
as $$
  select p_ref is null
      or exists (
           select 1
           from unnest(array[
                  'robots.txt', 'x-robots-tag', 'canonical', 'noindex', 'redirect', 'sitemap.xml'
                ]) as m(marker)
           where strpos(lower(p_ref), m.marker) > 0
         );
$$;

comment on function seo_target_ref_is_denied(text) is
  'True when a suggestion target reference names a machine directive rather than copy a reader sees. '
  'Mirrors DENIED_TARGET_REF_MARKERS in packages/core/src/seo/target-allowlist.ts; the two are asserted to '
  'agree over TARGET_REF_SPECIMENS by packages/google/src/seo/seo-agent-cage.itest.ts. NOT strict on '
  'purpose: a strict function returns NULL for NULL, and a CHECK whose expression is NULL passes.';

-- ---------------------------------------------------------------------------------------------
-- The one table the seo_agent principal may write to.
-- ---------------------------------------------------------------------------------------------
create table seo_suggestion_candidate (
  candidate_id uuid        primary key default uuid_generate_v7(),
  -- The agent_run this came from. No foreign key; see the header.
  run_id       uuid,
  -- The Search Console property, spelled as 0042 spells it: `sc-domain:example.com` or
  -- `https://example.com/`. Part of the identity below, because a domain property and a URL-prefix property
  -- for one website are two separate datasets (docs/10 §2) and a candidate derived from one is not a
  -- candidate derived from the other.
  site_url     text        not null,
  -- Which analysis produced it. A closed set, and adding a member is a migration rather than a row somebody
  -- inserted once — the same argument 0021 makes for the agent registry. G-SEO-04's analyses join this list
  -- when that unit lands.
  finding_kind text        not null
    check (finding_kind in ('ctr_outlier', 'content_gap', 'cannibalisation')),
  -- THE allowlist. Everything on this list changes copy a human reads and can be judged from a before and an
  -- after. robots.txt, a canonical, a redirect and a noindex directive are absent because they are
  -- instructions to a machine, where the damage is invisible in the diff and arrives weeks later as lost
  -- traffic. json_ld_field is absent too: the graph's @id and url ARE canonical identity, so it would be a
  -- canonical change under another name.
  target_kind  text        not null
    constraint seo_suggestion_candidate_target_kind_allowlisted
      check (target_kind in (
        'page_title', 'meta_description', 'heading', 'body_copy',
        'internal_link_anchor', 'faq_answer', 'image_alt'
      )),
  -- A LOCATOR — `/treatments/hot-oil-massage#title`, `faq:parking` — and never the copy itself. The copy is
  -- G-SEO-05's before and after. That is why the substring match below is safe here and would be wrong over
  -- prose: no legitimate locator on this site contains the word `canonical`.
  target_ref   text        not null
    constraint seo_suggestion_candidate_target_ref_is_not_a_machine_directive
      check (not seo_target_ref_is_denied(target_ref)),
  constraint seo_suggestion_candidate_target_ref_not_blank check (btrim(target_ref) <> ''),
  -- The Search Console query that produced the finding, already screened against
  -- regulatory_profile.banned_claim_terms at the ingest boundary. NULL for a finding that came from a page
  -- rather than a query — a cannibalisation between two URLs, for instance. Never a placeholder: a query that
  -- was dropped does not arrive here as an empty string, it does not arrive at all.
  query        text,
  constraint seo_suggestion_candidate_query_not_blank check (query is null or btrim(query) <> ''),
  created_at   timestamptz not null default now(),
  -- A re-run of the same analysis over the same window must not add a second row for the same proposal.
  -- NULLS NOT DISTINCT because `query` is null for a whole class of findings, and with the default NULLS
  -- DISTINCT every re-run would insert another copy of every one of them.
  constraint seo_suggestion_candidate_identity
    unique nulls not distinct (site_url, finding_kind, target_kind, target_ref, query)
);

comment on table seo_suggestion_candidate is
  'Propose-only output of the SEO agent (G-SEO-02). The system:seo_agent principal holds '
  'seo_suggestion:propose and no write capability at all beyond it: publish, revalidate, sitemap, redirect, '
  'robots, noindex, canonical and cms writes are refused by the policy layer in '
  'packages/core/src/access/principal-policy.ts. The two CHECK constraints are the database half of the '
  'target allowlist, so a writer that bypassed the application is refused as well.';
comment on column seo_suggestion_candidate.run_id is
  'The agent_run that produced it, without a foreign key: run history is subject to cleanup and a candidate '
  'must outlive the run. Same decision as agent_run.job_id in 0021.';
comment on column seo_suggestion_candidate.target_ref is
  'A locator, never copy. The copy a suggestion proposes belongs to G-SEO-05''s before/after columns.';
comment on column seo_suggestion_candidate.query is
  'Already screened against regulatory_profile.banned_claim_terms at ingest. A dropped query does not arrive '
  'as a placeholder; it does not arrive.';

create index seo_suggestion_candidate_site_created_idx
  on seo_suggestion_candidate (site_url, created_at desc);

commit;

# ADR 0113 — A 301 map is a FUNCTION with no gaps and no loops, and the proxy resolves it from a committed module

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** W-SITE-09
- **Covers:** docs/01 decisions — none; this is the relaunch-shaped consequence of migration 0029's
  one-hop `redirect_map` (reused rather than duplicated), docs/09 §"On `{treatment} in {area}` pages"'s
  reversal, and brief rule 15 applied to an open crawl baseline (`Y1-woo-baseline`)

## Context

`berelaxmassage.com` is live, is WordPress plus WooCommerce, and **already ranks** — docs/13 §6 names the
category pages and the product-tag archives. docs/09 reversed its own earlier recommendation about
`{treatment} in {area}` pages for exactly that reason: *"Deleting ranking pages to satisfy a general
principle would be a self-inflicted loss."*

The failure a relaunch has, and the only one that matters here, is **quiet**. A URL that ranks, is not in
the map, and 404s from the day of the cutover is invisible from inside the new application: nothing in
this codebase knows that URL exists, so no test can discover it. Only a declared baseline can.

## Decision 1 — the map is judged as a function, by four named properties

`redirectMapFindings` judges any set of rows against four separable failures, and each has its own rule
name because each has its own fix:

| rule | what goes wrong | what a visitor sees |
|---|---|---|
| `baseline_path_without_a_row` | totality | a 404 on a page that ranks |
| `source_mapped_twice` | single-valuedness | whichever row came back first |
| `redirect_is_a_chain` | one-hop-ness | a hop per rename, for ever |
| `redirect_is_a_loop` | acyclicity | "too many redirects" |

Plus `target_is_not_a_page`, which is the one that needs the route registry — so it is supplied as a
PREDICATE rather than a list, because `packages/core` may not read the registry and must not hold a
second copy of the URL space.

The judge is pure, so all five are provable on a fixture whose answer is known. It also carries a **step
bound** as well as its `seen` set when walking for loops, and that is not belt-and-braces: `seen` is what
detects a loop and the bound is what guarantees termination if a later edit breaks the detection. The
first version of gate case 191d removed the `break` and **hung** — a gate that produces no answer is
worse than one that misses.

## Decision 2 — `proxy.ts` resolves from a COMMITTED MODULE, and the table is still the one answer

`apps/web/proxy.ts` cannot reach a database: it is pure by construction, because a middleware that
imported a connection cannot run on the edge. W-SITE-05 predicted this layer in so many words —
*"a redirect that has to see the request belongs in a layer that always does: `proxy.ts` with a snapshot
of `redirect_map`, or a CDN rule generated from the same table"* — and the resolution is a committed
module, `LEGACY_BASELINE`, with the importer writing the same rows into `redirect_map` for everything
that CAN read it.

That is one fact in two places, so there is a check that holds them equal: `public-site.itest.ts` asserts
every committed row is in the table with the same target. **The slug-change and therapist-archival rows
are deliberately NOT in the module** — they are rows nothing commits, and the pages that own those paths
resolve them against the table themselves.

The order inside the proxy is load-bearing. Canonicalise **first**, then look up the neutral path, then
put the locale prefix back: asking before canonicalisation would need a row per casing, and keying the map
on the neutral path is what makes *"/ar/… stays under /ar/…"* structural rather than a rule somebody
maintains. The query string survives because the redirect replaces only the pathname of the URL that
arrived — a campaign parameter is how traffic on a retired URL is attributed, and dropping it turns a
tracked visit into direct traffic silently. That was the one loss W-SITE-05's treatment page had to accept
and recorded for this layer to repair.

## Decision 3 — the importer REFUSES rather than upserting

A path that already redirects somewhere else is a conflict, reported and not overwritten. `redirect_map`
is shared — B-CAT-05 writes a row on a slug change, W-SITE-06 on a therapist rename or archival — and an
import that overwrote one of those would silently undo a redirect a live page depends on. The symptom
would be a 404 on a URL that worked yesterday, with nothing in the import's output to connect the two.

The conflicts are **returned rather than thrown**, so one run reports all of them: an importer that threw
on the first would be run, fixed, run, fixed, once per conflicting path.

A chain is not collapsed by this unit's code at all, and that is the stronger arrangement:
`redirect_map_one_hop` (0029) **refuses** the second row unless the first is retargeted, so A → B → C
cannot exist to be collapsed. The acceptance line asks for a test that builds the chain and reads back
one hop; what the test actually asserts is the refusal by name and the single hop left afterwards.

## Decision 4 — the targets are pages that exist, and NO area page is invented

docs/09's reversal asks for the ranking pages to be *"preserved and improved"* with *"real differentiated
content rather than a template fill"*, and which URLs have genuine demand is `Y1-woo-baseline`'s — the
crawl and rank export that has not been captured. So every legacy URL points at the page that already
covers its content: a product URL at its own treatment page, and a style category at the treatments index,
which renders every treatment of both styles.

`RETAINED_AREA_PAGES` is therefore **empty**, and the emptiness is the decision rather than a gap. Writing
area pages before the export would be writing the template fill the same sentence forbids, for areas
nobody has shown have demand. What is built now is the **rule** that will judge them:
`pairwiseSimilarity` is a Jaccard index over word sets with a ceiling of 0.8 — the criterion's figure,
recorded as the criterion's rather than as a measurement — and `legacy-redirects.test.ts` proves it
catches a place-name swap and does not flag two genuinely different pages. The emptiness is asserted
beside that rule, so the day a retained page is added the rule is already there to hold.

Jaccard over sets rather than an edit distance, because of what template fill looks like: the same
sentences with the place name swapped, so the word set is nearly identical. It refuses an empty body
rather than answering 0 — two empty pages are identical and would score as maximally different, which is
the one input where a set measure lies.

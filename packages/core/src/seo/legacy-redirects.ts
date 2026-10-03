/**
 * The legacy WooCommerce URLs, and the proof that the 301 map is a FUNCTION.
 *
 * `berelaxmassage.com` is live, is WordPress plus WooCommerce, and **already ranks** (docs/13 §6). A
 * relaunch that drops those URLs is the self-inflicted loss docs/09 §"On `{treatment} in {area}` pages"
 * describes: real traffic arriving at a 404 on a page that was earning it.
 *
 * ## What a 301 map has to be, stated as four properties
 *
 * A map is a function with no gaps and no loops, and each of those is a separate failure:
 *
 *   - **Total over the baseline** — every ranking URL has a row. A gap is a 404 on a page that ranks, and
 *     it is invisible from inside the application: nothing here knows the URL exists.
 *   - **Single-valued** — one row per source. Two rows is two answers, and which one is served depends on
 *     row order.
 *   - **One hop** — no source is also a target. A → B followed by B → C costs the first URL two hops and
 *     the next rename makes it three; crawlers stop following, and the hop is spent on every visit for
 *     ever. This is 0029's `redirect_map_one_hop` invariant, stated here so it holds over the COMMITTED
 *     map before anything reaches a database.
 *   - **Acyclic** — no chain returns to where it started. The browser reports it as "too many redirects",
 *     which names the symptom and not the row.
 *
 * `redirectMapFindings` judges all four over any set of rows, which is what makes them provable on a
 * fixture whose answer is known rather than only against a live table.
 *
 * ## Why the map lives in `packages/core` as DATA
 *
 * Because `apps/web/proxy.ts` serves it, and the proxy cannot reach a database — it is pure by
 * construction (`src/session-cookie.ts` records why), so a redirect that has to see the request has to be
 * resolvable from a committed module. The importer writes the same rows into `redirect_map` so the table
 * remains the one answer to "where does this path go" for everything that CAN read it; `pnpm redirects`
 * and `redirects.itest.ts` hold the two equal.
 *
 * ## Why the targets are existing pages and not new area pages
 *
 * docs/09's reversal asks for the ranking pages to be *"preserved and improved"* with *"real
 * differentiated content rather than a template fill"*, and `Y1-woo-baseline` — the crawl and rank export
 * that would say which URLs have demand — is open. So nothing here invents an area page: each legacy URL
 * points at the page that already covers its content, which for a style category is the treatments index
 * (it renders every treatment of both styles). `RETAINED_AREA_PAGES` is empty, and
 * `legacy-redirects.test.ts` asserts that emptiness WITH the similarity rule that will judge them, so the
 * day the export lands the rule is already there to hold.
 */
import { AppError } from '@berelax/shared'

/** One row of the map. The same three fields `redirect_map` holds, minus its generated columns. */
export interface LegacyRedirect {
  /** The retired path, normalised: lower case, no trailing slash, no locale prefix. */
  readonly source: string
  readonly target: string
  /** Why this row exists, in words. `redirect_map_reason_nonempty` refuses a blank one. */
  readonly reason: string
}

/** Where every legacy URL lands. The treatments index covers a style category's whole content. */
const TREATMENTS_INDEX = '/treatments'

/**
 * The four known ranking URL patterns from docs/13 §6, as a committed fixture.
 *
 * `Y1-woo-baseline` is open: there is no crawl and no rank export, so this is **not** the real baseline
 * and does not claim to be. It is the four patterns the handover document names, written out as concrete
 * paths because a pattern cannot be redirected — `/product-tag/` is a prefix in prose and a URL needs a
 * tag in it.
 *
 * The product URLs are derived from the catalogue's own slugs rather than invented: WooCommerce serves a
 * product at `/product/<slug>`, and the eight services of docs/13 §4 are what those products were. A
 * ninth product nobody has told the build about is exactly what the coverage gate will report as a gap
 * the day the export lands.
 */
export const LEGACY_BASELINE: readonly LegacyRedirect[] = Object.freeze([
  {
    source: '/product-category/arabic-massage-abu-dhabi',
    target: TREATMENTS_INDEX,
    reason: 'WooCommerce baseline: ranking style category (docs/13 SS6, Y1-woo-baseline)',
  },
  {
    source: '/product-category/thai-massage-abu-dhabi',
    target: TREATMENTS_INDEX,
    reason: 'WooCommerce baseline: ranking style category with no equivalent on the new menu',
  },
  {
    source: '/product-tag/massage-abu-dhabi',
    target: TREATMENTS_INDEX,
    reason: 'WooCommerce baseline: product tag archive (docs/13 SS6)',
  },
  {
    source: '/product-tag/spa-abu-dhabi',
    target: TREATMENTS_INDEX,
    reason: 'WooCommerce baseline: product tag archive (docs/13 SS6)',
  },
  // The eight WooCommerce products, one per service of docs/13 §4. Each lands on its own treatment page,
  // which is the only case in this map where the new equivalent is a page about the same one thing.
  ...(
    [
      'asian-normal-massage',
      'asian-hot-oil-balm-massage',
      'asian-morocco-bath-jacuzzi',
      'asian-massage-with-shaving',
      'arabic-normal-massage',
      'arabic-hot-oil-balm-massage',
      'arabic-morocco-bath-jacuzzi',
      'arabic-massage-with-shaving',
    ] as const
  ).map((slug) => ({
    source: `/product/${slug}`,
    target: `/treatments/${slug}`,
    reason: 'WooCommerce baseline: product URL for a service on the new menu',
  })),
])

/**
 * The `{treatment} in {area}` pages the relaunch RETAINS, with their body text.
 *
 * **Empty**, and the emptiness is the answer rather than a gap. docs/09's reversal asks for the ranking
 * pages to be kept *"with real differentiated content rather than a template fill"*, and which ones have
 * genuine demand is `Y1-woo-baseline`'s — the crawl and rank export that has not been captured. Writing
 * area pages before that export would be writing the template fill the same sentence forbids, for areas
 * nobody has shown have demand.
 *
 * `pairwiseSimilarity` is the rule that will judge them, and it is written and tested now rather than
 * later: `legacy-redirects.test.ts` proves it catches a template-fill pair over a fixture, so the day a
 * retained page is added the rule is already there to hold. That is the whole reason this constant exists
 * instead of nothing.
 */
export const RETAINED_AREA_PAGES: readonly { readonly path: string; readonly body: string }[] =
  Object.freeze([])

/** The rules a 301 map has to satisfy. A finding names one of these. */
export const REDIRECT_MAP_RULES = [
  /** A baseline path with no row. A 404 on a page that ranks, invisible from inside the application. */
  'baseline_path_without_a_row',
  /** Two rows for one source. Two answers, resolved by row order. */
  'source_mapped_twice',
  /** A source that is also a target: the first URL costs two hops and the next rename makes it three. */
  'redirect_is_a_chain',
  /** A chain that returns to where it started. The browser says "too many redirects". */
  'redirect_is_a_loop',
  /** A row pointing at itself. The degenerate loop, named separately because the fix is different. */
  'redirect_to_itself',
  /** A target no route serves. A redirect to a 404 is a 404 with extra steps (0029's phrase). */
  'target_is_not_a_page',
  /** A source or target that is not a normalised path: upper case, a trailing slash, not absolute. */
  'path_is_not_normalised',
] as const
export type RedirectMapRule = (typeof REDIRECT_MAP_RULES)[number]

export interface RedirectMapFinding {
  readonly rule: RedirectMapRule
  readonly path: string
  readonly why: string
}

/** The shape `redirect_map_source_path_absolute` accepts — lower case, absolute, no trailing slash. */
const NORMALISED = /^\/[a-z0-9][a-z0-9/-]*$/

/** A path as the map stores it: lower case, no trailing slash, no query and no fragment. */
export function normaliseLegacyPath(path: string): string {
  const withoutQuery = path.split('?')[0]?.split('#')[0] ?? ''
  const lowered = withoutQuery.toLowerCase()
  const trimmed = lowered.length > 1 ? lowered.replace(/\/+$/, '') : lowered
  return trimmed === '' ? '/' : trimmed
}

export interface RedirectMapInput {
  readonly rows: readonly LegacyRedirect[]
  /** Every path the baseline claims ranks. Every one must have a row — that is totality. */
  readonly baseline: readonly string[]
  /**
   * Whether a target is a page this site serves.
   *
   * A predicate rather than a list, because `packages/core` cannot read the route registry (it is
   * `apps/web`'s) and must not hold a second copy of the URL space. The caller supplies the registry's
   * own answer, which is what makes `target_is_not_a_page` a claim about what is served rather than about
   * a list somebody maintained.
   */
  readonly isServedPage: (path: string) => boolean
}

/**
 * Every way this map is not a function with no gaps and no loops.
 *
 * Findings rather than a throw, and every rule over every row: the report is read by somebody fixing a
 * relaunch, and "one of your twelve redirects is wrong" is not actionable. A gap and a loop are reported
 * together, because a map with both has two different problems and fixing one does not reveal the other.
 */
export function redirectMapFindings(input: RedirectMapInput): readonly RedirectMapFinding[] {
  const findings: RedirectMapFinding[] = []
  const bySource = new Map<string, LegacyRedirect>()

  for (const row of input.rows) {
    for (const [kind, path] of [
      ['source', row.source],
      ['target', row.target],
    ] as const) {
      if (!NORMALISED.test(path)) {
        findings.push({
          rule: 'path_is_not_normalised',
          path,
          why:
            `the ${kind} ${path} is not a normalised absolute path. proxy.ts canonicalises every other ` +
            'spelling before a redirect is looked up, so a row outside this shape can never match — and ' +
            '`redirect_map_source_path_absolute` refuses it on the way into the table.',
        })
      }
    }
    if (row.source === row.target) {
      findings.push({
        rule: 'redirect_to_itself',
        path: row.source,
        why: `${row.source} redirects to itself, which a browser reports as "too many redirects".`,
      })
      continue
    }
    const existing = bySource.get(row.source)
    if (existing !== undefined) {
      findings.push({
        rule: 'source_mapped_twice',
        path: row.source,
        why:
          `${row.source} is mapped to both ${existing.target} and ${row.target}. A path with two ` +
          'redirects has no answer, and which one is served depends on row order.',
      })
      continue
    }
    bySource.set(row.source, row)
  }

  const sources = new Set(bySource.keys())
  for (const row of bySource.values()) {
    if (sources.has(row.target)) {
      findings.push({
        rule: 'redirect_is_a_chain',
        path: row.source,
        why:
          `${row.source} points at ${row.target}, which is itself a source. The first URL then costs ` +
          'two hops and the next rename makes it three; collapse it to the final destination.',
      })
    } else if (!input.isServedPage(row.target)) {
      // `else`, because a chain's target is a path this site does not serve BY DESIGN — it redirects —
      // and reporting both would name one row twice with two different fixes.
      findings.push({
        rule: 'target_is_not_a_page',
        path: row.source,
        why:
          `${row.source} points at ${row.target}, which no route serves. A redirect to a 404 is a 404 ` +
          'with extra steps.',
      })
    }
  }

  // Loops, by walking. A chain is already a finding, so a loop can only be reached through one — but a
  // loop is reported separately because the symptom and the fix differ: a chain costs a hop, a loop
  // costs the page.
  for (const start of bySource.keys()) {
    const seen = new Set<string>([start])
    let at = bySource.get(start)?.target
    // Bounded as well as `seen`-guarded, and the bound is not belt-and-braces: `seen` is what DETECTS
    // the loop and the bound is what guarantees termination if a later edit breaks the detection. A
    // judge that hangs is worse than one that misses — a hanging gate is a run nobody gets an answer
    // from, and the shape of that edit (removing the `break` with the `push`) is exactly what a
    // known-bad fixture for this rule does.
    for (let step = 0; step <= bySource.size && at !== undefined && sources.has(at); step += 1) {
      if (seen.has(at)) {
        findings.push({
          rule: 'redirect_is_a_loop',
          path: start,
          why: `following ${start} returns to ${at}, which a browser reports as "too many redirects".`,
        })
        break
      }
      seen.add(at)
      at = bySource.get(at)?.target
    }
  }

  for (const path of input.baseline) {
    if (bySource.has(path)) continue
    findings.push({
      rule: 'baseline_path_without_a_row',
      path,
      why:
        `${path} is in the crawl baseline and has no redirect. It is a 404 on a page that ranks, and it ` +
        'is invisible from inside this application: nothing here knows the URL exists.',
    })
  }

  return findings
}

/** The findings as lines, for a failing gate's message. */
export function formatRedirectMapFindings(findings: readonly RedirectMapFinding[]): string {
  return findings.map((finding) => `${finding.rule}  ${finding.path}  ${finding.why}`).join('\n')
}

/**
 * Where one path goes, or null.
 *
 * Takes a NEUTRAL path — the locale prefix removed — because the map is about the URL space and not about
 * a language: `/ar/product-category/x` and `/product-category/x` are one retired page in two documents,
 * and a map with both would be two rows to keep in step. `proxy.ts` strips the prefix, asks, and puts the
 * prefix back, which is what makes the acceptance criterion's *"/ar/… stays under /ar/…"* structural.
 */
export function resolveLegacyRedirect(
  neutralPath: string,
  rows: readonly LegacyRedirect[] = LEGACY_BASELINE,
): LegacyRedirect | null {
  const normalised = normaliseLegacyPath(neutralPath)
  return rows.find((row) => row.source === normalised) ?? null
}

/**
 * The paths the crawl baseline says RANK — the totality check's left-hand side.
 *
 * Declared separately from {@link LEGACY_BASELINE} and NOT derived from it, which is the whole mechanism.
 * The two are different facts: this one says *these URLs have traffic*, the map says *this URL goes
 * there*. Derived, the coverage check would be vacuous — removing a row would remove it from both sides
 * and totality would hold over a map that had just lost a page — and that is not hypothetical: it is how
 * the first version of this module was written, and gate case 191g is what found it.
 *
 * So a row deleted from the map fails `pnpm redirects` with the path printed, and removing a path from
 * THIS list is a deliberate claim that it no longer ranks, visible as such in a diff.
 *
 * The content is docs/13 §6's four patterns, written as concrete paths because a pattern cannot be
 * redirected. It is not the real crawl export — `Y1-woo-baseline` is open — and does not claim to be: the
 * day the export lands, every path it holds that is not here is a gap this list makes visible.
 */
export const RANKING_PATHS: readonly string[] = Object.freeze([
  '/product-category/arabic-massage-abu-dhabi',
  '/product-category/thai-massage-abu-dhabi',
  '/product-tag/massage-abu-dhabi',
  '/product-tag/spa-abu-dhabi',
  '/product/asian-normal-massage',
  '/product/asian-hot-oil-balm-massage',
  '/product/asian-morocco-bath-jacuzzi',
  '/product/asian-massage-with-shaving',
  '/product/arabic-normal-massage',
  '/product/arabic-hot-oil-balm-massage',
  '/product/arabic-morocco-bath-jacuzzi',
  '/product/arabic-massage-with-shaving',
])

/** The ranking paths, as the totality check's left-hand side. */
export function baselinePaths(): readonly string[] {
  return RANKING_PATHS
}

// ------------------------------------------------------------------------------------------------
// The similarity rule the retained area pages will be held to
// ------------------------------------------------------------------------------------------------

/** Words, lower-cased, with punctuation dropped. The unit a similarity is measured over. */
function words(body: string): readonly string[] {
  return body
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
}

/**
 * How alike two bodies of text are, as a Jaccard index over their word sets: 0 is nothing in common, 1 is
 * identical.
 *
 * Jaccard over SETS rather than a shingle or an edit distance, and the choice is about what template fill
 * actually looks like. A template-filled area page is the same sentences with the place name swapped, so
 * its word SET is almost identical and its word ORDER is identical too — which means a cheap measure
 * catches it. What a set measure deliberately does NOT catch is two genuinely different pages that happen
 * to share vocabulary, because they will not share most of it.
 *
 * Throws on an empty body rather than answering 0: two empty pages are maximally similar and would score
 * as maximally different, which is the one input where this measure lies.
 */
export function pairwiseSimilarity(left: string, right: string): number {
  const a = new Set(words(left))
  const b = new Set(words(right))
  if (a.size === 0 || b.size === 0) {
    throw new AppError(
      'validation',
      'a similarity over an empty body is undefined: two empty pages are identical and would score as ' +
        'maximally different, which is the one input where a set measure lies.',
      { details: { rule: 'similarity_needs_text' } },
    )
  }
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * The ceiling a retained area page's similarity to any other must stay below.
 *
 * 0.8 is the acceptance criterion's figure. It is not measured — there are no retained pages to measure —
 * and it is recorded as the criterion's rather than as this build's judgement, which is why it is a named
 * constant with this sentence beside it.
 */
export const AREA_PAGE_SIMILARITY_CEILING = 0.8

export interface SimilarPair {
  readonly left: string
  readonly right: string
  readonly similarity: number
}

/**
 * Every pair of retained area pages that is too alike.
 *
 * Over PAIRS rather than against a centroid, because the criterion is pairwise and because the failure is
 * pairwise: a set of six pages of which two are the same template is the realistic case, and an average
 * would absorb it.
 */
export function tooSimilarPairs(
  pages: readonly { readonly path: string; readonly body: string }[],
  ceiling = AREA_PAGE_SIMILARITY_CEILING,
): readonly SimilarPair[] {
  const pairs: SimilarPair[] = []
  for (let i = 0; i < pages.length; i += 1) {
    for (let j = i + 1; j < pages.length; j += 1) {
      const left = pages[i]
      const right = pages[j]
      if (left === undefined || right === undefined) continue
      const similarity = pairwiseSimilarity(left.body, right.body)
      if (similarity >= ceiling) {
        pairs.push({ left: left.path, right: right.path, similarity })
      }
    }
  }
  return pairs
}

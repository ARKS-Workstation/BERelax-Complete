import { CMS_ROUTE_PREFIXES } from '@berelax/cms'

/**
 * `robots.txt` — the crawl policy, and only the crawl policy.
 *
 * ## What this file is, and what the other two are not
 *
 * Three artefacts get confused with each other, and the confusion is expensive, so each one's job is
 * stated here once:
 *
 *   - **`robots.txt`** says what a crawler **may fetch**. It is advisory, it is per user-agent, and it has
 *     no opinion about indexing: a URL a crawler is forbidden to fetch can still be indexed from a link
 *     somebody else published, with a snippet Google composes from that link's anchor text.
 *   - **`x-robots-tag` / `<meta name="robots">`** says what may be **indexed**. That is a different
 *     question, it is answered by `apps/web/src/routes/registry.ts` and served by `proxy.ts`, and it can
 *     only be read on a response the crawler was allowed to fetch.
 *   - **the sitemap** (W-SITE-08) says which URLs are **worth fetching**. It is a hint about discovery and
 *     priority, not a permission and not a policy. `robots.txt` may point at one; that reference is a
 *     convenience for a crawler that arrived without one, and nothing else.
 *
 * The consequence is the one rule this file's shape turns on: **the registry's noindex prefixes are not
 * disallowed here.** `/settings`, `/analytics` and `/kitchen-sink` carry `x-robots-tag: noindex` on every
 * response (W-SITE-01), and adding `Disallow` for them would stop a crawler ever fetching that header — so
 * a URL discovered from an inbound link would stay indexable for ever, with no way to correct it. Disallow
 * and noindex are alternatives, not layers, and choosing the wrong one is the commonest robots.txt mistake
 * there is. `/admin` and `/cms-api` are different: nothing links to them, there is nothing there to index,
 * and the acceptance criterion names them.
 *
 * ## Allow, for the AI crawlers
 *
 * docs/09 §"LLM SEO" makes this an explicit decision rather than a default: *"This is a strategic
 * trade-off: blocking protects content but forfeits citation. **Recommendation: allow.** A local service
 * business that wants to be recommended by an assistant has far more to gain from citation than from
 * protecting treatment descriptions."* So the five tokens are named and allowed, which is a decision that
 * has to be written down to have been made — a crawler not mentioned in `robots.txt` is allowed by
 * default, and a reader cannot tell that from an omission.
 */

/**
 * The AI crawler tokens docs/09 §"LLM SEO" requires an explicit decision about.
 *
 * `Google-Extended` is the odd one and is here deliberately: it is **not** a crawler and never fetches
 * anything. It is a token that controls whether content already crawled by Googlebot may be used by
 * Gemini and Vertex, and `Allow` is the only way to say yes to that in this file. Omitting it because "it
 * is not a crawler" would leave the decision unmade.
 */
export const AI_CRAWLER_USER_AGENTS: readonly string[] = [
  'GPTBot',
  'ClaudeBot',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
]

/** The application's own API namespace, and the one endpoint inside it that is public (docs/09 §4). */
const API_PREFIX = '/api/'
const FACTS_PATH = '/api/facts'

export interface RobotsTxtInput {
  /** From `siteOrigin()`. The `Sitemap:` directive must be an absolute URL; nothing else here is. */
  readonly origin: string
  /**
   * The sitemap's path, or `null` while no route serves one.
   *
   * Derived from the route registry by the caller rather than typed here, because a `Sitemap:` line
   * pointing at a 404 is worse than no line: it is a reported error in Search Console and a crawler
   * spending its budget on nothing. W-SITE-08 owns the sitemap index; the day its route lands in the
   * registry this line appears with no change to this file, and `facts.test.ts` asserts both branches.
   */
  readonly sitemapPath: string | null
}

/**
 * One group's rules, identical for every user-agent, and identical **on purpose**.
 *
 * This is the mistake the repetition prevents. A crawler obeys exactly one group — the most specific one
 * that names it — and a group is a *replacement*, not an addition. So a `User-agent: GPTBot` group
 * containing only `Allow: /` does not inherit the wildcard group's `Disallow: /admin`: it grants GPTBot the
 * whole admin, including the CMS REST API, while the file reads as though it were more permissive by one
 * line. Every group therefore carries the whole policy.
 */
function ruleLines(): readonly string[] {
  return [
    'Allow: /',
    // Prefix matches, which is what a path in robots.txt is: `/admin` covers `/admin/collections/pages`
    // as well. Read from `@berelax/cms` rather than typed, because W-SYS-08 owns where the admin lives
    // and a second copy of the list is the one that stops matching the day it moves.
    ...CMS_ROUTE_PREFIXES.map((prefix) => `Disallow: ${prefix}`),
    // The trailing slash matters: `/api/` covers everything under the namespace, and the `Allow` below
    // wins for the fact sheet because a robots.txt match is decided by the longest matching path, not by
    // the order the lines appear in.
    `Disallow: ${API_PREFIX}`,
    `Allow: ${FACTS_PATH}`,
  ]
}

export function buildRobotsTxt(input: RobotsTxtInput): string {
  const lines: string[] = [
    '# What a crawler may fetch. What may be INDEXED is the x-robots-tag header, which is a different',
    '# question and is answered per route by the registry in apps/web/src/routes/registry.ts.',
    '#',
    '# The noindex routes (/settings, /analytics, /kitchen-sink) are deliberately NOT disallowed here: a',
    '# crawler forbidden to fetch them could never read the noindex header, so a URL found through an',
    '# inbound link would stay indexable for ever.',
    '',
    'User-agent: *',
    ...ruleLines(),
  ]

  for (const agent of AI_CRAWLER_USER_AGENTS) {
    lines.push('', `User-agent: ${agent}`, ...ruleLines())
  }

  lines.push(
    '',
    '# The machine-readable fact sheet and the LLM index, both allowed above and both worth naming: an',
    '# assistant that reads them quotes this address and these prices and not another business.',
    `# ${input.origin}${FACTS_PATH}`,
    `# ${input.origin}/llms.txt`,
  )

  if (input.sitemapPath !== null) {
    lines.push('', `Sitemap: ${input.origin}${input.sitemapPath}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * The AI crawler policy (A-FIRST-04): ONE table, read by the `robots.txt` policy and by the bot
 * classifier.
 *
 * ## Why this is one table and not two lists
 *
 * Allowing a crawler and being able to recognise it are two halves of one decision, and they were about
 * to be written in two places. `apps/web/src/facts/robots.ts` names the tokens docs/09 §"LLM SEO" makes
 * an explicit decision about; `packages/core/src/analytics/bots.ts` has to detect those same agents so
 * the funnel can exclude them. docs/03 §6 states why the second half matters as much as the first:
 * *"We deliberately allow GPTBot, ClaudeBot and PerplexityBot for citation value. On a low-traffic local
 * site they will inflate page views substantially. Without a filter list and a `bot` flag on every
 * session, the funnel is meaningless."*
 *
 * Two lists would drift in the direction nobody notices. Adding a crawler to `robots.txt` alone invites
 * traffic the funnel then counts as human — every figure on the analytics page moves and nothing is
 * broken enough to fail. Removing one from the classifier alone does the same thing silently. So the
 * table is here, in `@berelax/shared`, which is the only package `packages/core` and `apps/web` can both
 * reach; `apps/web/src/crawler-policy.test.ts` holds the rendered `robots.txt` equal to it in both
 * directions and refuses a second statement of any of these names anywhere in the source tree.
 *
 * It is `packages/shared` and not `packages/core` for the reason the event taxonomy is: `packages/core`
 * is reachable from `apps/web` but not from `packages/db` (ADR 0001), and a policy this build might one
 * day want to read in a query has no business being on the wrong side of that boundary. It imports
 * nothing at all, which `.dependency-cruiser.cjs`'s `analytics-taxonomy-must-be-pure` now covers.
 *
 * ## What a token means here
 *
 * A row is a name this business has taken a position on, and a position that has to be written down to
 * have been taken: a crawler nobody mentions in `robots.txt` is allowed by default, and a reader cannot
 * tell that from an omission. Every row is therefore `Allow`, and every group in the rendered file
 * carries the identical policy — see `robots.ts` for why a group is a replacement and not an addition.
 *
 * `fetches` is the field that stops this table pretending to be more than it is. `Google-Extended` never
 * makes a request: it is a token that controls whether content Googlebot already fetched may be used to
 * train Gemini and Vertex. There is no user-agent string to classify and there will never be one, so it
 * carries no `botKind`, and the type makes that pairing the only representable one rather than a
 * convention somebody has to remember.
 *
 * ## Ordered, because order is the tie-break
 *
 * The sequence is the order `robots.txt` renders its groups in, so this file is what a diff of the served
 * policy shows up as. `packages/core/src/analytics/bots.ts` also matches in table order — a user agent can
 * name two agents at once (LinkedIn's names Apache's HTTP client) and the first match must be the same one
 * on every run.
 */

/**
 * The question this policy stands on, by its `docs/OPEN-QUESTIONS.md` id.
 *
 * Named rather than described, so gate case 140w can assert it is a row in that document and a reader can
 * see which part of the policy is a decision and which is provisional (brief rule 15). An id that names
 * nothing is worse than no id: it reads as a question somebody is tracking.
 */
export const CRAWLER_POLICY_OPEN_QUESTIONS = {
  /**
   * Whether ByteDance's crawler belongs on the allowed list with the five docs/09 names. The mechanism does
   * not depend on the answer — the traffic is classified either way — so the decision was left open rather
   * than settled here. ADR 0062.
   */
  allowList: 'Y5-ai-crawler-allow-list',
} as const

interface AiCrawlerCommon {
  /** The token as `robots.txt` spells it, and as the fetcher spells itself. Case is the vendor's. */
  readonly token: string
  /** Why this name is on the list. Read by a human, not by code. */
  readonly why: string
}

/** A crawler that actually makes requests, so there is a user agent to classify. */
export interface AiCrawlerFetcher extends AiCrawlerCommon {
  readonly fetches: true
  /**
   * What `analytics.session.bot_kind` holds for its traffic (migration 0096).
   *
   * Distinct per crawler rather than a shared `ai_crawler`: the whole argument for allowing these is
   * citation, and "is ChatGPT reading us at all" is not answerable from a lumped total.
   */
  readonly botKind: string
}

/**
 * A token that governs USE of content already fetched, and fetches nothing itself.
 *
 * `botKind: null` is not an omission. There is no request to classify, so a kind here would be a value
 * `analytics.session.bot_kind` could never legitimately hold.
 */
export interface AiCrawlerUsageToken extends AiCrawlerCommon {
  readonly fetches: false
  readonly botKind: null
}

export type AiCrawlerPolicyEntry = AiCrawlerFetcher | AiCrawlerUsageToken

/**
 * The deliberately-allowed AI agents, in policy order.
 *
 * `as const` so the tokens and kinds are literal types: {@link AiCrawlerToken} and
 * {@link AiCrawlerBotKind} are derived from this array and nowhere else, which is what makes a sixth
 * entry a `pnpm typecheck` matter rather than a string somebody has to remember to add in two files.
 */
export const AI_CRAWLERS = [
  {
    token: 'GPTBot',
    botKind: 'gptbot',
    fetches: true,
    why:
      "OpenAI's training and search crawler, and the one docs/09 names first. Allowed for citation: a " +
      'local business that wants to be recommended by an assistant gains more from being quotable than ' +
      'from protecting treatment descriptions.',
  },
  {
    token: 'ClaudeBot',
    botKind: 'claudebot',
    fetches: true,
    why: "Anthropic's crawler. Same trade-off, same answer.",
  },
  {
    token: 'PerplexityBot',
    botKind: 'perplexitybot',
    fetches: true,
    why:
      'Perplexity answers with citations and links, so an allow here is the closest thing in this list ' +
      'to ordinary search referral traffic.',
  },
  {
    token: 'Google-Extended',
    botKind: null,
    fetches: false,
    why:
      'NOT a crawler and it never fetches anything: it is the token that says whether content ' +
      'Googlebot already has may be used by Gemini and Vertex. Allow is the only way to say yes to that ' +
      'in robots.txt, and omitting it because "it is not a crawler" would leave the decision unmade.',
  },
  {
    token: 'CCBot',
    botKind: 'ccbot',
    fetches: true,
    why:
      "Common Crawl, whose archive is an input to most other models' training sets. Blocking it is the " +
      'one entry with a second-order effect — it removes the business from a corpus many assistants ' +
      'were built on, including ones with no crawler of their own to allow.',
  },
  {
    token: 'Bytespider',
    botKind: 'bytespider',
    fetches: true,
    why:
      "ByteDance's crawler, which feeds TikTok search and Doubao. It is the one entry docs/09 does not " +
      'name, and it is here for the reason ADR 0062 records: on a small site it is among the highest- ' +
      'volume crawlers there is, so the classification half is load-bearing whatever the policy half ' +
      'says, and once the name is in this table it is in the policy too. Whether the business WANTS to ' +
      'be in that corpus is an owner decision, open as Y5-ai-crawler-allow-list.',
  },
] as const satisfies readonly AiCrawlerPolicyEntry[]

type AiCrawlerEntry = (typeof AI_CRAWLERS)[number]
type AiCrawlerFetcherEntry = Extract<AiCrawlerEntry, { readonly fetches: true }>

/** Every token `robots.txt` names a group for. */
export type AiCrawlerToken = AiCrawlerEntry['token']

/** Every `bot_kind` an allowed AI crawler produces. `Google-Extended` contributes none. */
export type AiCrawlerBotKind = AiCrawlerFetcherEntry['botKind']

/**
 * The tokens, in policy order — what `buildRobotsTxt` iterates.
 *
 * Derived rather than typed out. A hand-written copy of six strings is the second statement this whole
 * module exists to prevent.
 */
export const AI_CRAWLER_USER_AGENTS: readonly AiCrawlerToken[] = AI_CRAWLERS.map(
  (entry) => entry.token,
)

/** The entries with a user agent to recognise, which is what the classifier builds its rules from. */
export const AI_CRAWLER_FETCHERS: readonly AiCrawlerFetcherEntry[] = AI_CRAWLERS.filter(
  (entry): entry is AiCrawlerFetcherEntry => entry.fetches,
)

/**
 * The `bot_kind` values the allowed AI crawlers produce.
 *
 * Exported so a report can ask "how much of this is AI crawlers" without matching on a prefix inside the
 * kind. A category encoded in a string is a second statement of the category, and the first query to
 * spell the prefix wrong answers zero rather than failing.
 */
export const AI_CRAWLER_BOT_KINDS: readonly AiCrawlerBotKind[] = AI_CRAWLER_FETCHERS.map(
  (entry) => entry.botKind,
)

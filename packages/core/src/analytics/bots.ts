/**
 * Bot and AI-crawler classification (A-FIRST-04): what a request's user agent CLAIMS, and what its own
 * signals show.
 *
 * Pure, like everything in `packages/core`: no clock, no `process`, no network, no reverse DNS. Every
 * input is an argument and the answer is a function of the arguments alone —
 * `scripts/check-core-purity.mjs` and `.dependency-cruiser.cjs`'s `core-must-be-pure` prove the two
 * halves of that.
 *
 * ## A user agent is a claim, not evidence, and this module never pretends otherwise
 *
 * Anyone can send `User-Agent: GPTBot`. Nothing in an HTTP request proves who sent it, and the things
 * that come close — a reverse DNS lookup on the peer address, a published IP range — are network I/O and
 * cannot happen here even in principle. So `bot: true` from a user agent means exactly one thing: **this
 * request said it was a bot.** {@link BotClassification.basis} carries which half of the module answered
 * so a consumer can tell the two apart, because they are not equally trustworthy:
 *
 *   - `user_agent_claim` is a self-report. A crawler that declares itself is telling the truth for its own
 *     reasons (it wants `robots.txt` applied to it), and one that wants to hide simply sends Chrome's
 *     string and this half sees nothing at all.
 *   - `request_signals` is an inference from what the client DID — see {@link classifyHeadlessSignals}. It
 *     is weaker about identity and stronger about honesty: it cannot be turned off by editing a header.
 *
 * The consequence is a rule, and it is the reason this is measurement code and not security code: **no
 * verdict here may refuse, gate or authorise anything.** It sets a flag on a session so a funnel can
 * report a denominator it believes in (docs/03 §6: without a filter list and a `bot` flag "the funnel is
 * meaningless"), and a data-quality strip can show what share was filtered. Using it to serve different
 * content would be cloaking, decided on a string a visitor controls; using it to refuse a request would
 * be an access-control decision resting on a header. ADR 0062.
 *
 * ## The AI crawler list is not written here
 *
 * The six agents this business has taken a position on live in ONE table,
 * `packages/shared/src/crawlers.ts`, because `apps/web/src/facts/robots.ts` has to name the same six to
 * allow them. Allowing a crawler and being able to recognise it are two halves of one decision, and two
 * lists drift in the direction nobody notices: a crawler allowed but unclassified inflates every figure
 * on the analytics page without breaking anything. `AI_CRAWLER_RULES` below is derived from that table, so
 * a seventh entry needs no edit in this file, and `apps/web/src/crawler-policy.test.ts` holds the rendered
 * `robots.txt`, the table and this classifier equal in every direction.
 *
 * The OTHER families — search engines, link previewers, SEO tools, uptime monitors, HTTP clients, declared
 * headless browsers — are here rather than in `@berelax/shared` on purpose. Nothing but this classifier
 * reads them: they are not a policy anybody has decided, they are recognition knowledge, and moving them
 * to the shared table would put `Wget` in a file whose subject is which crawlers `robots.txt` allows.
 *
 * ## Why matching is a closed table and not a `/bot/i` search
 *
 * The obvious implementation — does the user agent contain "bot", "spider" or "crawler" — misclassifies
 * real people. `CUBOT` is an Android phone brand, so every visitor on one would be filtered out of the
 * funnel, and the fixture carries a real CUBOT user agent as the control for exactly that. The closed
 * table answers for the agents that have been looked at; {@link declaresItselfAnAgent} is the general
 * rule for the rest, and it is written as a claim about a PRODUCT TOKEN (`SeznamBot/4.0`), not a
 * substring, with an all-capitals carve-out because a device model is shouted and a product name is not.
 */
import { AI_CRAWLER_BOT_KINDS, AI_CRAWLER_FETCHERS, type AiCrawlerBotKind } from '@berelax/shared'

/**
 * The bot kinds that are not one particular AI crawler.
 *
 * A family rather than a name, for everything the business has taken no position on: what matters about
 * `AhrefsBot` is that it is an SEO tool, and a kind per vendor would be a list of vendors to maintain for
 * no reader. The AI crawlers are the exception and get one kind each, because "is ChatGPT reading us"
 * is a question somebody will ask and a lumped total cannot answer.
 */
export const OTHER_BOT_KINDS = [
  'search_crawler',
  'social_preview',
  'seo_crawler',
  'uptime_monitor',
  'http_client',
  'declared_headless',
  'declared_unnamed',
  'suspected_headless',
] as const

export type OtherBotKind = (typeof OTHER_BOT_KINDS)[number]

/** Every value `analytics.session.bot_kind` may hold (migration 0096). */
export type BotKind = AiCrawlerBotKind | OtherBotKind

/**
 * Every kind, AI crawlers first.
 *
 * One list so A-FIRST-05 can validate what it is about to write and A-FIRST-10 can enumerate what it is
 * about to display, without either of them restating the union as strings. `bots.test.ts` asserts the
 * values are distinct — an AI crawler whose kind collided with a family name would be a `bot_kind` two
 * different things produce, and no query could separate them again.
 */
export const BOT_KINDS: readonly BotKind[] = [...AI_CRAWLER_BOT_KINDS, ...OTHER_BOT_KINDS]

/** Where a verdict came from. See the module comment: these are not equally trustworthy. */
export type BotBasis = 'user_agent_claim' | 'request_signals' | 'no_evidence'

/**
 * The answer.
 *
 * `bot` and `botKind` are the two columns migration 0096 created, and the pairing here is the one its
 * CHECK constraint permits — `(bot_kind is not null) = bot`. A shape the database would refuse is
 * therefore unrepresentable before a row is built, rather than a 23514 from an INSERT that names a
 * constraint instead of the classifier that produced the value.
 */
export interface BotClassification {
  readonly bot: boolean
  readonly botKind: BotKind | null
  readonly basis: BotBasis
}

/**
 * What the client did, with no reference to what it said it was.
 *
 * Deliberately a type with no user-agent field: {@link classifyHeadlessSignals} takes this and only this,
 * so "the headless heuristic does not read the user agent" is a property of the signature rather than a
 * claim in a comment. A test can then run the same signals against a dozen different user agents and
 * require one answer.
 *
 * Every field is something A-FIRST-06's collector already sends with a batch.
 */
export interface RequestSignals {
  /**
   * The layout viewport width in CSS pixels, or `null` when the client reported none.
   *
   * Width alone, not width and height: the rule below is about PRESENCE, and the breakpoint A-FIRST-05
   * stores needs the width. A second dimension would add a field with no reader.
   */
  readonly viewportWidth: number | null
  /** How many interaction events this client has produced in the session so far. */
  readonly interactionCount: number
  /**
   * Milliseconds between consecutive events, in arrival order.
   *
   * Gaps rather than instants, because this module reads no clock: the caller already knows when its
   * events arrived and the difference is the only part of that a heuristic can use.
   */
  readonly interEventGapsMs: readonly number[]
}

/** The named signal rules, in the order they are reported. */
export const HEADLESS_SIGNAL_RULES = [
  'no_viewport',
  'no_interaction',
  'uniform_event_timing',
] as const

export type HeadlessSignalRule = (typeof HEADLESS_SIGNAL_RULES)[number]

/**
 * How many rules have to fire before an uncorroborated one is believed.
 *
 * Two, and it is not a tuned threshold — it is what "corroborated" means. The specification names three
 * signals and no figure, so no figure was invented: the number here is the smallest one that is more
 * than a single rule, and the reason it cannot be one is `no_interaction`. A real visitor who reads a
 * page and leaves produces zero interactions, which is most of the traffic on a brochure site, so a
 * one-rule verdict would filter genuine people out of the funnel denominator and the figure it exists to
 * protect would be the figure it broke.
 */
export const HEADLESS_CORROBORATION = 2

/**
 * The smallest number of gaps in which "identical timings" means anything: two, so three events.
 *
 * One gap is always identical to itself. Structural, not tuned — and the comparison is exact equality
 * rather than a tolerance for the same reason there is no threshold above: a tolerance in milliseconds is
 * a figure nobody has measured, and exactness is what makes the rule safe to fire alone. Two consecutive
 * gaps equal to the millisecond is a scheduler; a hand and an eye cannot produce it.
 */
export const UNIFORM_TIMING_MIN_GAPS = 2

interface HeadlessRule {
  /** Whether this rule fires on these signals. */
  readonly fires: (signals: RequestSignals) => boolean
  /**
   * Whether firing alone is enough.
   *
   * True only where a human cannot produce the signal at all. A rule that a bounce also satisfies is
   * corroborating and nothing more.
   */
  readonly alone: boolean
  /** Why this signal says what it says. Read by a human. */
  readonly why: string
}

/**
 * The three rules, as a `Record` over the tuple with no default branch.
 *
 * A fourth signal added to {@link HEADLESS_SIGNAL_RULES} without a rule here fails `pnpm typecheck`
 * naming this file, which is the treatment every closed table in this tree gets. It is frozen and only
 * ever indexed by a member of that tuple — never by a caller's string, which is the lookup that resolves
 * `constructor` through the prototype chain and has been fixed twice in this build.
 */
const HEADLESS_RULES: Readonly<Record<HeadlessSignalRule, HeadlessRule>> = Object.freeze({
  no_viewport: Object.freeze({
    // `> 0` rather than `!== null`: a reported `0`, and a `NaN` from a garbled payload, are the same
    // fact as an absent one — nothing laid out a page — and treating them differently would leave the
    // rule's answer depending on which of three spellings of "no viewport" a client happened to send.
    fires: (signals: RequestSignals) => !(Number(signals.viewportWidth) > 0),
    alone: false,
    why:
      'a client that reports no layout viewport ran no layout. Corroborating and not alone: a text ' +
      'browser and a payload whose viewport field was dropped in transit both look like this.',
  }),
  no_interaction: Object.freeze({
    fires: (signals: RequestSignals) => signals.interactionCount === 0,
    alone: false,
    why:
      'nothing was clicked, tapped or scrolled. The weakest of the three by a distance — a bounce is ' +
      'the commonest genuine visit there is — and it is in the table because it is what turns a second ' +
      'weak signal into a verdict.',
  }),
  uniform_event_timing: Object.freeze({
    fires: (signals: RequestSignals) => {
      const gaps = signals.interEventGapsMs
      if (gaps.length < UNIFORM_TIMING_MIN_GAPS) return false
      const first = gaps[0]
      // `Number.isFinite` first: `every` over `[NaN, NaN]` is false anyway, so without this the rule
      // would answer "not uniform" for garbage rather than "cannot be evaluated", and the two want the
      // same answer here but for different reasons worth keeping visible.
      if (first === undefined || !Number.isFinite(first)) return false
      return gaps.every((gap) => gap === first)
    },
    alone: true,
    why:
      'consecutive events the same number of milliseconds apart, to the millisecond. A person cannot ' +
      'do this twice in a row; a setInterval does nothing else. Sufficient alone because there is no ' +
      'human way to produce it.',
  }),
})

/** Which rules fired, and whether that amounts to a suspicion. */
export interface HeadlessSuspicion {
  readonly suspected: boolean
  /** The rules that fired, in declared order. Reported so a verdict can be explained. */
  readonly rules: readonly HeadlessSignalRule[]
}

/**
 * The headless heuristic, from request signals ALONE.
 *
 * It cannot read the user agent: {@link RequestSignals} has no field for one. That is deliberate and it
 * is the point of the split — a headless browser sends whatever string it is told to, so a heuristic
 * that consulted the string would be measuring the same claim twice and calling the agreement
 * corroboration.
 *
 * The verdict: any rule marked `alone`, or {@link HEADLESS_CORROBORATION} rules of any kind.
 *
 * ## What it cannot see, stated because the name says `suspected`
 *
 * A headless browser that sets a viewport, moves a pointer and varies its delays is indistinguishable
 * from a person here, and no addition to this table would change that — the signals are all the client's
 * to fabricate. `suspected_headless` is therefore a suspicion in its name as well as its shape, it is
 * reported as a share rather than acted on, and the honest reading of a low figure is "this heuristic
 * found little", never "there was little".
 */
export function classifyHeadlessSignals(signals: RequestSignals): HeadlessSuspicion {
  const fired = HEADLESS_SIGNAL_RULES.filter((rule) => HEADLESS_RULES[rule].fires(signals))
  const suspected =
    fired.some((rule) => HEADLESS_RULES[rule].alone) || fired.length >= HEADLESS_CORROBORATION
  return { suspected, rules: fired }
}

interface AgentRule {
  /** A lowercase substring of the lowercased user agent. */
  readonly token: string
  readonly botKind: BotKind
  /** Why this agent is this kind. Read by a human. */
  readonly why: string
}

/**
 * The AI crawlers, derived from the ONE table in `@berelax/shared`.
 *
 * The token a fetcher sends is the token `robots.txt` names — true of all five fetchers in that table,
 * and asserted rather than assumed: every fetcher has a real user agent in
 * `packages/core/test/fixtures/user-agents.json` and `apps/web/src/crawler-policy.test.ts` fails when one
 * does not classify as its own kind. If a vendor ever spells its fetcher differently from its policy
 * token, the fix is a field on that table — never a second list here, which is the defect this unit
 * exists to remove.
 */
const AI_CRAWLER_RULES: readonly AgentRule[] = AI_CRAWLER_FETCHERS.map((entry) => ({
  token: entry.token.toLowerCase(),
  botKind: entry.botKind,
  why: entry.why,
}))

/**
 * Everything else that identifies itself, in match order.
 *
 * ## Order is load-bearing, and one row proves it
 *
 * `LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)` names LinkedIn's
 * previewer AND the Java HTTP client it is built on. Both have a rule here, so "first match wins" has to
 * be an ordering somebody chose rather than whatever the array happened to hold: the preview families come
 * before the plumbing, because what matters about that request is that somebody pasted a link into
 * LinkedIn, not that the fetch went out through Apache's library. The fixture asserts that row resolves to
 * `social_preview`, so a reordering that reads more tidily fails a named test.
 *
 * `TelegramBot (like TwitterBot)` names two previewers and resolves to the same kind either way, which is
 * the reason the fixture cannot be the only check on the ordering.
 */
const OTHER_AGENT_RULES: readonly AgentRule[] = Object.freeze([
  // --- search engines ---------------------------------------------------------------------------
  //
  // One kind for all of them: what a report wants to know is "a search engine indexed us", and the
  // engine's name is in the raw log for anybody who needs it — except that this store keeps no user agent
  // at all (migration 0096 keeps the verdict, never its input), which is a reason to be sure the kind
  // carries what a reader needs and not a reason to split it by vendor.
  {
    token: 'googlebot',
    botKind: 'search_crawler',
    why: "Google's crawler. Matches the desktop, smartphone and image fetchers, which differ only in the rest of the string.",
  },
  {
    token: 'bingbot',
    botKind: 'search_crawler',
    why: "Bing's crawler, and the one Bing Places verification arrives behind.",
  },
  { token: 'duckduckbot', botKind: 'search_crawler', why: "DuckDuckGo's own crawler." },
  { token: 'yandexbot', botKind: 'search_crawler', why: 'Yandex.' },
  {
    token: 'applebot',
    botKind: 'search_crawler',
    why: 'Apple, for Siri and Spotlight. Its user agent is otherwise a plausible macOS Safari, which is why the token and not the shape decides.',
  },
  { token: 'baiduspider', botKind: 'search_crawler', why: 'Baidu.' },
  {
    token: 'yahoo! slurp',
    botKind: 'search_crawler',
    why: 'Yahoo. The only entry whose token contains a space, and it needs one: a bare `slurp` is three letters shy of a word that could appear in anything.',
  },
  // --- link previewers --------------------------------------------------------------------------
  //
  // Before the HTTP clients, deliberately. See the ordering note above.
  //
  // These matter more here than their volume suggests: every WhatsApp share of a booking link produces
  // one, and B-UI-04's ref loop runs over WhatsApp. Counting a previewer as a visit would credit a
  // conversion to the share rather than to the person who tapped it.
  {
    token: 'facebookexternalhit',
    botKind: 'social_preview',
    why: "Meta's link previewer, for both Facebook and Instagram.",
  },
  { token: 'twitterbot', botKind: 'social_preview', why: 'X/Twitter card previewer.' },
  {
    token: 'linkedinbot',
    botKind: 'social_preview',
    why: "LinkedIn's previewer, whose own user agent also names Apache's HTTP client.",
  },
  { token: 'slackbot', botKind: 'social_preview', why: 'Slack unfurling a pasted link.' },
  {
    token: 'whatsapp',
    botKind: 'social_preview',
    why: 'WhatsApp fetching a preview for a shared link — the share path this business actually uses.',
  },
  { token: 'telegrambot', botKind: 'social_preview', why: 'Telegram unfurling a link.' },
  { token: 'discordbot', botKind: 'social_preview', why: 'Discord unfurling a link.' },
  // --- SEO and backlink tools -------------------------------------------------------------------
  //
  // Not blocked in `robots.txt` and not a policy question this unit answers; they are classified because
  // on a low-traffic site they are a visible share of it.
  { token: 'ahrefsbot', botKind: 'seo_crawler', why: 'Ahrefs backlink index.' },
  { token: 'semrushbot', botKind: 'seo_crawler', why: 'Semrush.' },
  { token: 'mj12bot', botKind: 'seo_crawler', why: 'Majestic.' },
  { token: 'dotbot', botKind: 'seo_crawler', why: "Moz's crawler." },
  {
    token: 'screaming frog',
    botKind: 'seo_crawler',
    why: 'Screaming Frog SEO Spider — most often us, auditing our own site, which is a share worth being able to subtract.',
  },
  // --- uptime monitors --------------------------------------------------------------------------
  //
  // Two, and only the two whose exact tokens are known. A monitor polls a fixed path on a fixed interval,
  // so an unclassified one is a page view every minute for ever — and it is also the shape
  // `uniform_event_timing` was written for, which is where an unnamed monitor lands instead.
  { token: 'uptimerobot', botKind: 'uptime_monitor', why: 'UptimeRobot.' },
  { token: 'pingdom', botKind: 'uptime_monitor', why: 'Pingdom.' },
  // --- HTTP clients and libraries ---------------------------------------------------------------
  //
  // A script, not a browser, whoever wrote it. None of these ends in `bot`, `spider` or `crawler`, so the
  // general rule below would miss every one of them.
  {
    token: 'curl/',
    botKind: 'http_client',
    why: 'curl. With the slash, so `curl` inside a URL is not a match.',
  },
  { token: 'wget/', botKind: 'http_client', why: 'wget, same reasoning.' },
  { token: 'python-requests', botKind: 'http_client', why: "Python's requests." },
  { token: 'python-urllib', botKind: 'http_client', why: "Python's standard library client." },
  { token: 'go-http-client', botKind: 'http_client', why: "Go's standard library client." },
  {
    token: 'okhttp',
    botKind: 'http_client',
    why: 'OkHttp, which is most Android and Kotlin HTTP traffic.',
  },
  {
    token: 'postmanruntime',
    botKind: 'http_client',
    why: 'Postman. Usually somebody exploring the API by hand.',
  },
  {
    token: 'axios/',
    botKind: 'http_client',
    why: 'axios from Node; the browser build sends the browser string.',
  },
  { token: 'node-fetch', botKind: 'http_client', why: 'node-fetch.' },
  { token: 'apache-httpclient', botKind: 'http_client', why: "Apache's Java client." },
  {
    token: 'java/',
    botKind: 'http_client',
    why: "The JDK's own client. With the slash: `java` unqualified appears in strings that are not it.",
  },
  // --- declared automated browsers --------------------------------------------------------------
  //
  // A real browser engine, driven by a script that did not hide it. Distinct from `suspected_headless`,
  // which is the same thing inferred from behaviour — a declared one is a fact about the string and an
  // inferred one is a suspicion about the session, and collapsing them would make the honest half
  // unreadable.
  {
    token: 'headlesschrome',
    botKind: 'declared_headless',
    why: 'Chrome in headless mode, which is Puppeteer and Playwright unless they were told otherwise.',
  },
  { token: 'phantomjs', botKind: 'declared_headless', why: 'PhantomJS.' },
  {
    token: 'chrome-lighthouse',
    botKind: 'declared_headless',
    why: 'Lighthouse and PageSpeed Insights, which is headless Chrome auditing a page — often ours, from our own budget checks.',
  },
] satisfies readonly AgentRule[])

/** Every named rule, AI crawlers first. See the ordering note on {@link OTHER_AGENT_RULES}. */
const AGENT_RULES: readonly AgentRule[] = [...AI_CRAWLER_RULES, ...OTHER_AGENT_RULES]

/**
 * How much of a user agent is scanned, in characters.
 *
 * The header is already bounded — Node refuses one over its `maxHeaderSize` long before this function
 * sees it — so this is the second bound, and it is here so a change of server or a call from somewhere
 * that is not a request cannot make this the slow path. 1024 is several times the longest user agent
 * anybody has recorded. It is not a defence: a client that wants to hide omits the name rather than
 * padding past a limit, and nothing here is evidence anyway (see the module comment).
 */
export const USER_AGENT_SCAN_LIMIT = 1024

/**
 * Product-token suffixes that are a self-declaration.
 *
 * The general rule, for an agent no table names. It has to be a rule about a TOKEN and not a substring:
 * `CUBOT` is an Android phone brand, `Cubot` devices are real, and a `/bot/i` search over the user agent
 * would filter their owners out of the funnel as bots. So a token is split out of the string, its
 * version is dropped, and an all-capitals token is skipped — a device model is shouted (`CUBOT_X30`,
 * `SM-S918B`) and a crawler's product name is not (`SeznamBot`, `bingbot`, `Bytespider`).
 */
const DECLARED_AGENT_SUFFIXES = ['bot', 'spider', 'crawler'] as const

/**
 * Whether the user agent names a product that says it is an agent.
 *
 * `Sogou web spider/4.0(+http://…)` and `SeznamBot/4.0` are both real and neither is in a table above.
 * They classify as {@link OtherBotKind} `declared_unnamed`, which is the honest answer: something told us
 * it was a crawler and we do not know which one.
 */
function declaresItselfAnAgent(userAgent: string): boolean {
  // The string as it arrived, not a lowercased copy: the all-capitals carve-out needs the case the client
  // sent, and lowercasing before the split would destroy the only signal that tells `CUBOT` from `bingbot`.
  for (const raw of userAgent.split(/[\s()]+/)) {
    // Drop a leading `+` or `;`, then the version after the first slash: `SeznamBot/4.0;` is the product
    // `SeznamBot`.
    const product = (raw.replace(/^[^A-Za-z]+/, '').split('/')[0] ?? '').replace(
      /[^A-Za-z0-9._-]+$/,
      '',
    )
    if (product.length === 0) continue
    // A device model, not a product name. This is the CUBOT carve-out; see the constant above.
    if (product === product.toUpperCase()) continue
    const lowerProduct = product.toLowerCase()
    if (DECLARED_AGENT_SUFFIXES.some((suffix) => lowerProduct.endsWith(suffix))) return true
  }
  return false
}

/** What the user agent claims, or `null` when it names nothing known and declares nothing. */
function claimedBotKind(userAgent: string | null): BotKind | null {
  if (userAgent === null) return null
  const scanned = userAgent.slice(0, USER_AGENT_SCAN_LIMIT)
  if (scanned.trim().length === 0) return null
  const lowered = scanned.toLowerCase()
  for (const rule of AGENT_RULES) {
    if (lowered.includes(rule.token)) return rule.botKind
  }
  return declaresItselfAnAgent(scanned) ? 'declared_unnamed' : null
}

/** A user agent and what the client did, which are the two different kinds of input this takes. */
export interface BotInput {
  /**
   * The `User-Agent` header exactly as it arrived, or `null` when the request sent none.
   *
   * `null` rather than an optional property: the absence of a header is a fact the caller knows and
   * should have to state, and `exactOptionalPropertyTypes` makes a passed-through `undefined` awkward for
   * no gain.
   */
  readonly userAgent: string | null
  /** The client's own signals, or `null` where there are none — a `robots.txt` fetch has no session. */
  readonly signals: RequestSignals | null
}

/**
 * Classify a request.
 *
 * The claim is consulted first and wins. A crawler that declares itself should be recorded as what it
 * declared — that is the citation figure docs/09 asks to be measured, and `suspected_headless` over the
 * top of `gptbot` would lose it. The signals are what is left when the string says nothing, which is
 * also the only case in which they can disagree with anything.
 *
 * ## Absent, empty and arbitrary user agents
 *
 * An absent or blank `User-Agent` is **not** treated as a bot. It is the absence of a claim, not a claim,
 * and the cost of the two errors is not symmetric: a bot counted as a person is one row in a
 * denominator, while a person counted as a bot is a visitor A-FIRST-09 drops from the funnel by default
 * and nobody ever sees. Whatever arrives — an empty string, a megabyte of Unicode, a header that is only
 * punctuation — this function returns an answer and never throws. `bots.test.ts` holds that as a property
 * over arbitrary strings, and determinism with it: the same input gives the same answer, always, because
 * there is nothing here to read but the arguments.
 */
export function classifyBot(input: BotInput): BotClassification {
  const claimed = claimedBotKind(input.userAgent)
  if (claimed !== null) return { bot: true, botKind: claimed, basis: 'user_agent_claim' }
  if (input.signals !== null && classifyHeadlessSignals(input.signals).suspected) {
    return { bot: true, botKind: 'suspected_headless', basis: 'request_signals' }
  }
  return { bot: false, botKind: null, basis: 'no_evidence' }
}

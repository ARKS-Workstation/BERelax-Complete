/**
 * Origination (A-FIRST-03): what a session's raw signals say about where it came from, and every click
 * id it arrived with.
 *
 * docs/03 §6 states the order and this module is it: **UTM parameters → click ids (`gclid`, `fbclid`,
 * `wbraid`, `msclkid`) → referrer → direct.** The order is strict and total: exactly one basis wins, the
 * losers contribute nothing to the tuple, and the answer is a function of the arguments alone.
 *
 * ## Pure, and with no clock at all — not even an injected one
 *
 * `packages/core` reads no clock, no filesystem and no network (`pnpm purity`, `core-must-be-pure`), and
 * this module goes one step further than the rule requires: it takes no instant, because it needs none.
 * Where a session came from is a function of its query string, its referrer and which hosts are ours.
 * `analytics.attribution.resolved_at` is the WRITER's instant and A-FIRST-05 stamps it; a `resolvedAt`
 * argument here would be a parameter this code never reads, and the first person to add one would
 * reasonably assume something depended on it.
 *
 * The one host fact this needs — which hosts are this site — is {@link OriginationSignals.ownHosts}, an
 * argument, because `process.env.SITE_ORIGIN` is exactly the ambient read the purity gate exists to
 * refuse. `siteOriginFrom` in `@berelax/shared` is where the caller gets it.
 *
 * ## Nothing here indexes an object by a caller's string
 *
 * `packages/shared/src/analytics/taxonomy.ts` carries the long version: a frozen object literal indexed
 * by an attacker-supplied key resolves `constructor`, `toString`, `valueOf`, `hasOwnProperty` and
 * `__proto__` through the prototype chain, so a "lookup" returns a function and the route answers 500 on
 * a `TypeError` instead of refusing. It has been fixed twice in this build.
 *
 * Every lookup below is therefore over a closed tuple. {@link CLICK_ID_PARAMS} and {@link UTM_PARAMS} are
 * iterated, never indexed by anything a browser sent, and the query string is read through
 * `URLSearchParams`, which is map-backed and has no prototype to fall through to. `params.get('__proto__')`
 * is `null` unless `__proto__` was literally in the query, which is the behaviour wanted.
 *
 * ## The only thing that can throw is URL parsing, and it is caught where it happens
 *
 * `new URL(referrer)` throws on a string that is not a URL, and a `Referer` header is attacker-controlled.
 * The `try` is around that one call and nothing else, deliberately: a `try` around the whole resolver
 * would turn a genuine defect into a silent `direct`, and a silent `direct` is indistinguishable from a
 * visitor who typed the address in. The rest of the module cannot throw — `URLSearchParams` accepts every
 * string, and everything after it is `slice`, `trim`, `toLowerCase` and tuple iteration.
 */
import { assertNever } from '../assert-never.ts'

/**
 * The click ids, in the order they win.
 *
 * Exactly the four docs/03 §6 names and migration 0096's `analytics.session.click_ids` comment repeats.
 * A fifth platform is a data change rather than a migration — which is why that column is `jsonb` and not
 * four `text` columns — but it is still a committed diff here, because the source/medium each one implies
 * is a decision and {@link CLICK_ID_ORIGINATION} is a `Record` over this union with no default branch.
 *
 * The order is the tie-break for a URL carrying several, and it has to be declared rather than left to
 * object-key order: a visitor arriving on a link that was built by two tags must be attributed the same
 * way every time or the same session resolves differently on a replay. Google's two are first because a
 * `wbraid` accompanies a `gclid` on the same click often enough that "whichever appeared first in the
 * query" would be a coin toss between two answers that agree anyway.
 *
 * `fbp` and `fbc` — which docs/02 §4 also lists — are deliberately absent: they are Meta's own
 * first-party COOKIES, not query parameters, and a cookie is A-FIRST-05's to read.
 */
export const CLICK_ID_PARAMS = ['gclid', 'wbraid', 'fbclid', 'msclkid'] as const

export type ClickIdParam = (typeof CLICK_ID_PARAMS)[number]

/**
 * The longest click id that is stored, in characters.
 *
 * A real `gclid` is around 90 characters and a `fbclid` around 60; 512 is room for several times the
 * longest anyone has seen without the column being unbounded. An id longer than this is TRUNCATED rather
 * than dropped, and that is the deliberate choice of the two: the parameter's presence is evidence of a
 * paid click whatever its value, so dropping it would silently reclassify a paid session as organic —
 * a much worse error than a stored id that will not reconcile with the ad platform. Truncation is visible
 * to whoever tries that reconciliation; a reclassified session is visible to nobody.
 */
export const CLICK_ID_MAX_LENGTH = 512

/** What a click id says about where the click came from. */
export interface ClickIdOrigination {
  readonly source: string
  readonly medium: string
  /** Why this platform and this medium. Read by a human, not by code. */
  readonly why: string
}

/**
 * Each click id, and the source/medium it implies.
 *
 * `Record<ClickIdParam, …>` with no default branch, for `APPOINTMENT_STATUS_FUNNEL`'s reason: a fifth
 * click id added to the tuple with no decision here fails `pnpm typecheck` naming this file, rather than
 * falling into a fallback that attributes an unknown platform to `direct`.
 *
 * Every medium is a paid one, which is the whole argument for the click id outranking the referrer: a
 * paid click's referrer is frequently the ad network's own redirector or nothing at all, and a session
 * with a `gclid` is a session somebody was billed for.
 */
export const CLICK_ID_ORIGINATION: Readonly<Record<ClickIdParam, ClickIdOrigination>> =
  Object.freeze({
    gclid: Object.freeze({
      source: 'google',
      medium: 'cpc',
      why: 'Google Ads auto-tagging. The canonical paid-search click id.',
    }),
    wbraid: Object.freeze({
      source: 'google',
      medium: 'cpc',
      why:
        'Google Ads consent-mode click id: the same click as a gclid, issued when the visitor withheld ' +
        'advertising consent. Same source and same medium on purpose — a separate medium would split one ' +
        "campaign's spend across two rows on the visitor's cookie choice, which is not a media fact.",
    }),
    fbclid: Object.freeze({
      source: 'meta',
      medium: 'paid_social',
      why:
        "Meta's click id. `meta` rather than `facebook` because the same id arrives from Instagram, and a " +
        'source naming one of the two surfaces would under-report the other.',
    }),
    msclkid: Object.freeze({
      source: 'bing',
      medium: 'cpc',
      why: 'Microsoft Advertising auto-tagging. Paid search, so the same medium as Google Ads.',
    }),
  })

/**
 * Which precedence rule won, and the ONE place in TypeScript that says so.
 *
 * These four words are also written in `packages/db/migrations/0096_analytics_schema.sql`
 * (`attribution_basis_known`) and again in its Drizzle mirror, because a migration is hand-written SQL
 * (ADR 0006) and `pnpm db:drift` compares the mirror against it. `db` may never import `core` (ADR 0001),
 * so this tuple cannot be the source those two read — and a third statement nothing checks is how a
 * vocabulary drifts. Gate case 136u is what holds all three equal: it reads the migration, the mirror and
 * this tuple and requires the same four words in each.
 */
export const ORIGINATION_BASES = ['utm', 'click_id', 'referrer', 'direct'] as const

export type OriginationBasis = (typeof ORIGINATION_BASES)[number]

/**
 * The UTM parameters read, and which field of the tuple each one fills.
 *
 * A `Record` over the tuple's own fields, so a parameter read with nowhere to put it does not compile.
 * `utm_id` and the rest of Google's longer list are deliberately not here: `analytics.attribution` has
 * five columns, and reading a sixth parameter into nothing is a read that looks like a feature.
 */
export const UTM_PARAMS = Object.freeze({
  source: 'utm_source',
  medium: 'utm_medium',
  campaign: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
} as const)

/**
 * The one spelling of "there was nothing to resolve".
 *
 * Migration 0096 enforces it — `attribution_direct_has_one_spelling` refuses a `direct` row that is not
 * exactly `('direct', 'none')` — for the reason its comment gives: three callers spelling it
 * `('direct','none')`, `('(direct)','(none)')` and `('direct','')` produce three rows in the traffic
 * report for one thing.
 */
export const DIRECT_SOURCE = 'direct'
export const DIRECT_MEDIUM = 'none'

/** The medium every external referral carries. GA's word, and the one the dashboard groups on. */
export const REFERRAL_MEDIUM = 'referral'

/**
 * The medium for a UTM set that named a source and no medium.
 *
 * Three spellings were available and two of them are traps. `''` is refused by
 * `attribution_medium_not_blank`. `'none'` is worse than refused: it is the DIRECT medium, so a tagged
 * campaign with a missing `utm_medium` would group with untagged traffic in every report cut on
 * (source, medium) — a real source silently folded into direct. And `'(not set)'` is the parenthesised
 * spelling migration 0096's comment names as the confusion to avoid.
 *
 * So the tag is believed about the source and honest about the gap. `unset` is a word about the TAG,
 * distinguishes itself from every real medium, and sorts where a reader will notice it.
 */
export const UNSET_MEDIUM = 'unset'

/**
 * The resolver that produced an answer, stored beside it in `analytics.attribution.resolver_version`.
 *
 * A resolver is a pure function of a session's signals, so a corrected resolver gives a different answer
 * for the same session — and a row that did not say which version decided it would make the two
 * indistinguishable. That is migration 0096's argument for the column; this constant is the value.
 *
 * Bumping it is a deliberate committed diff, like `ANALYTICS_TAXONOMY_VERSION`. Bump it whenever a change
 * here could give an existing session a different tuple: a new click id, a changed precedence, a changed
 * normalisation, a widened public-suffix table.
 */
export const ORIGINATION_RESOLVER_VERSION = 'origination/1'

/**
 * Multi-label public suffixes, declared.
 *
 * This is NOT the Public Suffix List, and the difference is stated here rather than implied. The PSL is
 * roughly 13,000 entries with its own update cadence, distributed as a file — and `packages/core` may not
 * read a file, fetch a URL or read the environment, so vendoring it would mean either a 13,000-entry
 * TypeScript literal in a pure package or moving the registrable-domain answer out of `core` and away
 * from the resolver that is the only caller. ADR 0058 records the trade.
 *
 * What a miss costs, exactly: the referral is grouped one label too broadly — `foo.co.zz` resolves to
 * `co.zz` instead of `foo.co.zz`. It never changes WHETHER a session is attributed, never changes the
 * basis, and never affects a UTM or click-id answer, which is where every paid figure comes from. It is a
 * reporting-granularity error confined to organic referrals, so the list covers the market this business
 * sells in (the GCC), the English-speaking markets its referrers sit in, and the majors — and the
 * fallback is the last two labels, which is correct for `.com`, `.ae`, `.co` and every other single-label
 * suffix.
 *
 * Sorted by suffix so a reader can see what is and is not here.
 */
export const MULTI_LABEL_PUBLIC_SUFFIXES: readonly string[] = Object.freeze([
  'ac.ae',
  'ac.uk',
  'co.ae',
  'co.id',
  'co.il',
  'co.in',
  'co.jp',
  'co.kr',
  'co.nz',
  'co.th',
  'co.uk',
  'co.za',
  'com.au',
  'com.bh',
  'com.br',
  'com.cn',
  'com.eg',
  'com.hk',
  'com.jo',
  'com.kw',
  'com.lb',
  'com.my',
  'com.mx',
  'com.om',
  'com.pk',
  'com.ph',
  'com.qa',
  'com.sa',
  'com.sg',
  'com.tr',
  'com.vn',
  'edu.au',
  'gov.ae',
  'gov.au',
  'gov.uk',
  'mil.ae',
  'net.ae',
  'net.au',
  'net.in',
  'net.sa',
  'org.ae',
  'org.au',
  'org.in',
  'org.uk',
  'sch.ae',
])

/** The raw signals of one session, all of them arguments. */
export interface OriginationSignals {
  /**
   * The landing URL's query string as received, with or without its leading `?`.
   *
   * A string and not a parsed object, because what arrived is a string and a parse the caller did is a
   * parse this module cannot see the rules of. `null` and `undefined` both mean "there was none".
   */
  readonly query?: string | null | undefined
  /** The `Referer` header as received. `null` and `undefined` both mean "there was none". */
  readonly referrer?: string | null | undefined
  /**
   * Every host that IS this site, so an internal navigation is not read as a referral.
   *
   * An argument rather than a constant, for the purity reason in the header, and a list rather than one
   * host because the apex and `www.` are two hosts and a staging origin is a third. A referrer on a
   * SUBDOMAIN of a declared own host counts as ours too — see {@link isOwnHost} for why the obvious
   * `endsWith` is wrong.
   */
  readonly ownHosts: readonly string[]
}

/** The resolved origination, in the five dimensions `analytics.attribution` holds plus the basis. */
export interface OriginationTuple {
  readonly basis: OriginationBasis
  /** Never blank: `attribution_source_not_blank`. */
  readonly source: string
  /** Never blank: `attribution_medium_not_blank`. */
  readonly medium: string
  /** `''` when unknown, never null — a null dimension in the rollup's primary key never equals a null. */
  readonly campaign: string
  /** `utm_term`. Written to `term_value`, which is named that because `term` is a reserved word. */
  readonly term: string
  /** `utm_content`. Written to `content_value`, for `term_value`'s reason. */
  readonly content: string
}

/**
 * What the signals decided.
 *
 * `no_new_origination` is a value and not a `null`, and it carries a `why` for the reason
 * `FunnelOutcome`'s `no_step` does: "this session has no origination" and "this session's only referrer
 * was one of our own pages, so whatever originated it was decided earlier" are different facts, and the
 * second is the one a reader looking at a gap needs. It is also the answer a writer must branch on —
 * writing `direct` here would overwrite a real origination with the absence of one.
 */
export type OriginationDecision =
  | { readonly kind: 'origination'; readonly origination: OriginationTuple }
  | { readonly kind: 'no_new_origination'; readonly why: string }

/**
 * The click ids found, keyed by parameter name, ready for `analytics.session.click_ids`.
 *
 * `Partial`, because a session usually has none. An object rather than an array of pairs because that is
 * the shape of the `jsonb` column, and frozen because a caller that mutated it would be editing what it
 * is about to store.
 */
export type ClickIds = Readonly<Partial<Record<ClickIdParam, string>>>

/** Everything one session's signals yield. */
export interface OriginationResolution {
  readonly decision: OriginationDecision
  /**
   * Every click id found, verbatim — **whatever won the origination**.
   *
   * This is the acceptance line that is easy to get wrong, and the reason is that the click id and the
   * origination answer different questions. "Where did this session come from" is the tuple, and a UTM set
   * outranks a click id there because a human tagged it deliberately. "Which ad click was this" is the
   * click id, and nothing else can answer it: docs/03 §6 keeps them because they are what permits
   * reconciliation with Google and Meta later. A resolver that dropped the `gclid` because a `utm_source`
   * won would lose the only join key to the ad platform, and the loss would be invisible until somebody
   * tried the reconciliation months later against a 90-day retention window.
   */
  readonly clickIds: ClickIds
  /** {@link ORIGINATION_RESOLVER_VERSION}, so the writer cannot forget to stamp the row. */
  readonly resolverVersion: string
}

/** Trim, and nothing else. `''` for a value that was absent or was only whitespace. */
const trimmed = (value: string | null): string => (value === null ? '' : value.trim())

/**
 * A host, comparably.
 *
 * Lower-cased because a hostname is case-insensitive, and the trailing dot of a fully-qualified name is
 * removed because `example.com.` and `example.com` are the same host and a browser will send either.
 */
const normaliseHost = (host: string): string => host.trim().toLowerCase().replace(/\.+$/, '')

/**
 * Is this host ours?
 *
 * The obvious `host.endsWith(own)` is wrong and the wrongness is exploitable: it makes
 * `notberelaxmassage.com` and `berelaxmassage.com.evil.test` our own hosts, so a referral from an
 * attacker-chosen domain resolves to `no_new_origination` and the session's real origination is never
 * recorded. The label boundary is what makes it a subdomain rather than a suffix, and
 * `origination.test.ts` asserts both of those hosts are EXTERNAL.
 */
export const isOwnHost = (host: string, ownHosts: readonly string[]): boolean => {
  const candidate = normaliseHost(host)
  if (candidate === '') return false
  return ownHosts.some((own) => {
    const ours = normaliseHost(own)
    if (ours === '') return false
    return candidate === ours || candidate.endsWith(`.${ours}`)
  })
}

/**
 * The registrable domain of a host: the label that can be bought, plus its public suffix.
 *
 * `www.blog.example.co.uk` → `example.co.uk`; `news.ycombinator.com` → `ycombinator.com`. This is what
 * `source` holds for a referral, so that every page of a referring site groups into one row rather than
 * one row per subdomain — which is the difference between "Instagram sent 40 sessions" and forty rows.
 *
 * See {@link MULTI_LABEL_PUBLIC_SUFFIXES} for the bounded table this consults and what a miss costs.
 */
export const registrableDomain = (host: string): string => {
  const normalised = normaliseHost(host)
  const labels = normalised.split('.')
  if (labels.length <= 2) return normalised
  const lastTwo = labels.slice(-2).join('.')
  const take = MULTI_LABEL_PUBLIC_SUFFIXES.includes(lastTwo) ? 3 : 2
  // A host that IS a multi-label suffix (`co.uk` with nothing in front) has no registrable domain to
  // take three labels from; returning the whole host is the only honest answer and cannot happen for a
  // referrer, which always carries a registered name.
  return labels.slice(-take).join('.')
}

/** Every click id in the query, verbatim, capped, and never case-folded. */
const clickIdsFrom = (params: URLSearchParams): ClickIds => {
  const found: Partial<Record<ClickIdParam, string>> = {}
  for (const param of CLICK_ID_PARAMS) {
    const raw = params.get(param)
    if (raw === null) continue
    // No `trim` and no `toLowerCase`, and both absences are the acceptance line. A `gclid` is an opaque
    // token the platform issued: `Cj0KCQ` and `cj0kcq` are different ids, and the one that reconciles is
    // the one that arrived. `slice` is the cap — see CLICK_ID_MAX_LENGTH for why truncating beats dropping.
    const value = raw.slice(0, CLICK_ID_MAX_LENGTH)
    // An empty parameter is not a click id. `?gclid=` is a tag that fired without one or a browser that
    // stripped it, and treating it as a click would attribute the session to Google Ads on the strength
    // of a parameter name. The property test reads presence off this object for exactly that reason:
    // a second definition of "has a click id" in the test would be a second answer to this question.
    if (value === '') continue
    found[param] = value
  }
  return Object.freeze(found)
}

/** The first click id present, in {@link CLICK_ID_PARAMS} order. */
const winningClickId = (clickIds: ClickIds): ClickIdParam | null =>
  CLICK_ID_PARAMS.find((param) => clickIds[param] !== undefined) ?? null

/**
 * The UTM set, normalised.
 *
 * `source` and `medium` are lower-cased and the other three are not, and that asymmetry is the
 * acceptance line. The reason is what each one IS: source and medium are a closed-ish pair of DIMENSIONS
 * that every report groups on, so `'  Google '` and `'google'` must collapse or the traffic report shows
 * two Googles — and `medium` goes with `source` because `CPC` and `cpc` split a campaign's spend the same
 * way. `campaign`, `term` and `content` are LABELS somebody typed for themselves: `Eid_Offer_2026` is how
 * it was written in the ad platform, and lower-casing it makes the analytics row stop matching the
 * campaign name in Google Ads. All five are trimmed, because a trailing space in a rollup's primary-key
 * dimension is a second row for one campaign.
 */
const utmFrom = (params: URLSearchParams) => ({
  source: trimmed(params.get(UTM_PARAMS.source)).toLowerCase(),
  medium: trimmed(params.get(UTM_PARAMS.medium)).toLowerCase(),
  campaign: trimmed(params.get(UTM_PARAMS.campaign)),
  term: trimmed(params.get(UTM_PARAMS.term)),
  content: trimmed(params.get(UTM_PARAMS.content)),
})

/** What a referrer is, once parsed: an external site, one of ours, or nothing usable. */
type ReferrerReading =
  | { readonly kind: 'external'; readonly host: string }
  | { readonly kind: 'own' }
  | { readonly kind: 'none' }

const readReferrer = (
  referrer: string | null | undefined,
  ownHosts: readonly string[],
): ReferrerReading => {
  const raw = trimmed(referrer ?? null)
  if (raw === '') return { kind: 'none' }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // A `Referer` header is attacker-controlled and arrives malformed from real browsers too. Unparseable
    // is "no referrer", which is the only answer available — and the catch is this narrow so that a defect
    // anywhere else in this module cannot be laundered into it.
    return { kind: 'none' }
  }
  // A referral is a web page. `android-app://com.google.android.gm` parses and yields a `hostname` that
  // looks like a domain, so a protocol test is what stops an email client being reported as a referring
  // website — and `about:blank` and `data:` URLs have no hostname at all.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'none' }
  const host = normaliseHost(parsed.hostname)
  if (host === '') return { kind: 'none' }
  if (isOwnHost(host, ownHosts)) return { kind: 'own' }
  return { kind: 'external', host }
}

/**
 * Where this session came from, and every click id it arrived with.
 *
 * Strict precedence, in the order docs/03 §6 states:
 *
 *   1. **UTM** — a human tagged this link deliberately, so it outranks everything inferred. Won by a
 *      non-blank `utm_source`; a `utm_medium` with no `utm_source` does NOT win, because a medium is not
 *      a place and carrying it under another basis would produce a tuple whose basis says nothing about
 *      where half of it came from.
 *   2. **Click id** — evidence somebody was billed for this visit. More reliable than the referrer for
 *      paid traffic, whose referrer is often the ad network's redirector or nothing.
 *   3. **Referrer** — an external site, as its registrable domain, medium `referral`.
 *   4. **Direct** — nothing to resolve, spelled exactly one way.
 *
 * With one answer that is none of the four: a referrer that is one of OUR OWN hosts, with no UTM set and
 * no click id, is an internal navigation and yields `no_new_origination`. It is not `direct`: a session
 * reached from our own page was originated by whatever brought the visitor to that page, and answering
 * `direct` would overwrite that with the absence of it.
 *
 * Deterministic and total: every path returns, nothing is read that was not passed in, and the only
 * throwing call is caught at the site.
 */
export function resolveOrigination(signals: OriginationSignals): OriginationResolution {
  // `URLSearchParams` accepts every string and strips one leading `?`, so no guard is needed and none is
  // written: a hand-rolled split on `&` and `=` would be a second, worse implementation of form decoding.
  // Percent-decoding IS applied, and that is transport decoding rather than normalisation — `%2F` is how
  // a `/` inside a click id crosses a query string, and the id the platform issued is the decoded one.
  const params = new URLSearchParams(signals.query ?? '')
  const clickIds = clickIdsFrom(params)
  const utm = utmFrom(params)

  const resolution = (decision: OriginationDecision): OriginationResolution => ({
    decision,
    clickIds,
    resolverVersion: ORIGINATION_RESOLVER_VERSION,
  })
  const origination = (tuple: OriginationTuple) =>
    resolution({ kind: 'origination', origination: tuple })

  if (utm.source !== '') {
    return origination({
      basis: 'utm',
      source: utm.source,
      medium: utm.medium === '' ? UNSET_MEDIUM : utm.medium,
      campaign: utm.campaign,
      term: utm.term,
      content: utm.content,
    })
  }

  const winner = winningClickId(clickIds)
  if (winner !== null) {
    const platform = CLICK_ID_ORIGINATION[winner]
    return origination({
      basis: 'click_id',
      source: platform.source,
      medium: platform.medium,
      // A click id carries no campaign, term or content. Reading `utm_campaign` here would attach a
      // campaign label to a basis that is not the UTM set — a tuple half-tagged and half-inferred, whose
      // `basis` column would then be a lie about two of its five dimensions.
      campaign: '',
      term: '',
      content: '',
    })
  }

  const referrer = readReferrer(signals.referrer, signals.ownHosts)
  switch (referrer.kind) {
    case 'external':
      return origination({
        basis: 'referrer',
        source: registrableDomain(referrer.host),
        medium: REFERRAL_MEDIUM,
        campaign: '',
        term: '',
        content: '',
      })
    case 'own':
      return resolution({
        kind: 'no_new_origination',
        why:
          'the only signal was a referrer on one of our own hosts, which is an internal navigation; ' +
          'whatever originated this visitor was decided on the page they came from',
      })
    case 'none':
      return origination({
        basis: 'direct',
        source: DIRECT_SOURCE,
        medium: DIRECT_MEDIUM,
        campaign: '',
        term: '',
        content: '',
      })
    default:
      // No default-allow in a resolver either (`transitions.ts`: "a default in a state machine is a
      // default-allow with better manners"). A fourth reading added to `ReferrerReading` fails
      // `pnpm typecheck` here rather than falling through to `direct`.
      return assertNever(referrer, 'resolveOrigination')
  }
}

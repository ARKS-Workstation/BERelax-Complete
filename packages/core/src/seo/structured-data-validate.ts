import { AppError } from '@berelax/shared'
import type { GraphRule } from './jsonld/types.ts'
import { type GraphFinding, validateGraph } from './jsonld/validate.ts'
import type { LicenceClass } from './jsonld/vocabulary.ts'
import type { SeoUntrustedEnvelope } from './untrusted-envelope.ts'

/**
 * Structured data as the live site actually serves it: extracted from fetched HTML, then judged.
 *
 * ## Why this is not `validateGraph` with a different caller
 *
 * `jsonld/validate.ts` (W-SITE-03) judges a graph — a parsed object — and every rule it has is about what
 * the graph SAYS. It is reused here whole, and that reuse is the load-bearing decision: a second validator
 * would be a second answer to "is this markup false", and the day they disagreed the CI gate and the
 * agent's weekly report would be arguing about the same page. The brief's rule about a fact stated twice
 * applies to a rule set as much as to a constant.
 *
 * What this module adds is everything that is a property of the **page** rather than of the graph, and
 * there are three kinds:
 *
 *   1. **Extraction.** A `<script type="application/ld+json">` block that does not parse is markup Google
 *      drops silently, so it is a finding here and cannot be one there: `validateGraph` is handed an
 *      object, and an object exists only if the parse succeeded.
 *   2. **Absence.** A treatment page serving no graph at all passes every rule about a graph. The
 *      `requireTypes` option exists for this and is per page, so the caller says what the route owes.
 *   3. **Evidence.** The one rule that cannot be decided from the bytes: whether an `aggregateRating` has
 *      real reviews behind it. See below — it is the rule whose violation earns a manual action, and it is
 *      the reason this module exists at all rather than the CI gate being considered enough.
 *
 * ## The `aggregateRating` rule, and why the graph validator's version is not enough
 *
 * `validateGraph` refuses an `aggregateRating` with **no `reviewCount`** behind it (`aggregate_rating_
 * without_reviews`). That catches the careless case. It does not catch the one docs/09 actually warns
 * about — *"do not mark up your own testimonials as review snippets"* — because a testimonial block on the
 * site produces a rating with a perfectly well-formed count: fourteen testimonials, `reviewCount: 14`,
 * valid markup and a rich result Google will serve until it issues a manual action.
 *
 * So the question is not whether a count is present but whether anything outside this site evidences it,
 * and that is a fact the page cannot contain. {@link StructuredDataPageInput.evidencedReviewCount} is how
 * the caller states it, and in this build it is **zero**: there is no Business Profile API access (ADR
 * 0005), so no review this business has received is held anywhere a count could be derived from. A rating
 * of any kind is therefore refused today, which is the correct answer and not a limitation — a figure
 * nothing evidences is ADR 0070's refusal, one subject along.
 *
 * It is a required field rather than an optional one defaulting to zero. A default of zero would be the
 * safe answer and the wrong design, for exactly the reason `ValidateGraphOptions.licence` is required: the
 * caller who forgets it is the caller whose reviews have started arriving, and a validator that quietly
 * assumed none would refuse a rating that had become legitimate.
 *
 * ## The HTML arrives inside the untrusted envelope
 *
 * It is a fetched document, and in the competitor case it is written by somebody who would like to be
 * ranked above us. G-SEO-02's envelope is the one wrapper every byte the SEO agent did not write goes
 * through, and `.dependency-cruiser.cjs`'s `seo-site-analysis-must-take-the-untrusted-envelope` is what
 * keeps the argument that shape. The practical effect is not decoration: the enclosed text has had its
 * control and format characters stripped and has been capped, so the scanner below cannot be handed a NUL
 * that truncates it or a bidi run that makes the extracted JSON read in a different order than it parses.
 *
 * ## Pure
 *
 * No I/O, no clock, no `process`. The three known-bad fixtures are TypeScript data in
 * `structured-data.fixtures/`, not files on disk, for the reason `reply-linter.fixtures/` is: a fixture a
 * pure package has to read from a filesystem is a fixture only an impure test can use.
 */

/** The rules this module adds to {@link GraphRule}. A finding names one or the other. */
export const STRUCTURED_DATA_SITE_RULES = [
  /** The page serves no `<script type="application/ld+json">` block at all. */
  'jsonld_block_absent',
  /** A block is present and is not valid JSON, so Google drops it without saying so. */
  'jsonld_not_parseable',
  /** A type the route owes is in no block on the page. */
  'required_type_absent',
  /** An `aggregateRating` claiming more reviews than anything outside this site evidences. */
  'aggregate_rating_not_evidenced',
] as const
export type StructuredDataSiteRule = (typeof STRUCTURED_DATA_SITE_RULES)[number]

/** Every rule a page finding can name. */
export type StructuredDataRule = GraphRule | StructuredDataSiteRule

export interface StructuredDataFinding {
  readonly rule: StructuredDataRule
  /**
   * Where it is: the block index and the graph path, as `block[0].@graph[1].address.streetAddress`.
   *
   * Prefixed with the block because a page may serve several and a bare graph path would name the same
   * place in two of them — which is how a fix is applied to the wrong script tag.
   */
  readonly path: string
  readonly detail: string
}

export interface StructuredDataPageInput {
  /** The fetched page, enclosed. See the module header. */
  readonly html: SeoUntrustedEnvelope
  /** The route this is, for the message. Never parsed. */
  readonly pagePath: string
  /** The licence class in force. Required, for `ValidateGraphOptions.licence`'s own reason. */
  readonly licence: LicenceClass
  /** Node types this route owes. Empty means "check only what is here". */
  readonly requireTypes?: readonly string[]
  /**
   * How many reviews of this business are held outside this site, from a source Google would accept.
   *
   * Zero in this build, and required rather than defaulted: see the module header.
   */
  readonly evidencedReviewCount: number
}

/** How many subjects each extraction stage saw. Zero is legitimate and has to be visible (ADR 0002). */
export interface StructuredDataCoverage {
  /** `<script type="application/ld+json">` blocks found on the page. */
  readonly blocksFound: number
  /** Of those, how many parsed. */
  readonly blocksParsed: number
  /** How many nodes `validateGraph` was given across every parsed block. */
  readonly nodesJudged: number
}

export interface StructuredDataReport {
  readonly findings: readonly StructuredDataFinding[]
  readonly coverage: StructuredDataCoverage
}

/**
 * Every `<script type="application/ld+json">` body on a page, in document order.
 *
 * A scanner rather than an HTML parser, for `sitemapLocations`' reasons and with the same caveat: the
 * attribute match is deliberately loose about ordering and quoting, because that is what a real document
 * does, and deliberately strict about the TYPE — a block declaring anything else is not structured data
 * and parsing it as JSON would report a template's inline configuration as broken markup.
 */
export function jsonLdBlocks(html: string): readonly string[] {
  const bodies: string[] = []
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let match = pattern.exec(html)
  while (match !== null) {
    const attributes = (match[1] as string).toLowerCase()
    if (/type\s*=\s*["']?application\/ld\+json["']?/.test(attributes)) {
      bodies.push(match[2] as string)
    }
    match = pattern.exec(html)
  }
  return bodies
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every `@type` a node declares, whether it wrote one or a list. */
function typesOf(node: Record<string, unknown>): readonly string[] {
  const declared = node['@type']
  if (typeof declared === 'string') return [declared]
  if (Array.isArray(declared))
    return declared.filter((item): item is string => typeof item === 'string')
  return []
}

/**
 * Every `aggregateRating` on a parsed block, with the count it claims.
 *
 * Walked over the whole block rather than over the business node, for `validateRating`'s own reason: the
 * rule is about the claim and not about where it was attached, and hanging it off an `Organization` is
 * exactly how a self-serving rating survives a review of the business node.
 */
function ratingClaims(
  value: unknown,
  path: string,
  into: { path: string; claimed: number | null }[],
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) ratingClaims(item, `${path}[${index}]`, into)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'aggregateRating') {
      const count = isRecord(child) ? child['reviewCount'] : undefined
      into.push({
        path: `${path}.aggregateRating`,
        claimed: typeof count === 'number' && Number.isFinite(count) ? count : null,
      })
    }
    ratingClaims(child, `${path}.${key}`, into)
  }
}

/** The sentinel for a block that did not parse. A symbol, so no document can produce it. */
const NOT_PARSED = Symbol('jsonld_not_parseable')

/** Parses one block, or reports `jsonld_not_parseable` and answers the sentinel. */
function parseBlock(
  body: string,
  at: string,
  findings: StructuredDataFinding[],
): unknown | typeof NOT_PARSED {
  try {
    return JSON.parse(body) as unknown
  } catch (error) {
    findings.push({
      rule: 'jsonld_not_parseable',
      path: at,
      detail:
        `the block is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        'Google drops an unparseable block without reporting it, so the page has no structured data ' +
        'at all and nothing on it says so.',
    })
    return NOT_PARSED
  }
}

/** Every `@type` in the block's `@graph`, into `seenTypes`, and how many nodes there were. */
function countNodes(parsed: unknown, seenTypes: Set<string>): number {
  const nodes = isRecord(parsed) ? parsed['@graph'] : undefined
  if (!Array.isArray(nodes)) return 0
  for (const node of nodes) {
    if (isRecord(node)) for (const type of typesOf(node)) seenTypes.add(type)
  }
  return nodes.length
}

/** The graph rules, then the evidence rule, for one parsed block. */
function judgeParsedBlock(
  parsed: unknown,
  at: string,
  input: StructuredDataPageInput,
  findings: StructuredDataFinding[],
  _seenTypes: Set<string>,
): void {
  const graphFindings: readonly GraphFinding[] = validateGraph(parsed, {
    licence: input.licence,
    // `requireTypes` is deliberately NOT forwarded. It is a claim about the PAGE and this is one block of
    // several, so forwarding it would report a missing `Service` once per script tag on a page whose
    // second tag carries it — a finding an owner fixes by adding a second copy of the node.
  })
  for (const finding of graphFindings) {
    findings.push({ rule: finding.rule, path: `${at}.${finding.path}`, detail: finding.detail })
  }

  const claims: { path: string; claimed: number | null }[] = []
  ratingClaims(parsed, at, claims)
  for (const claim of claims) {
    /*
     * A claim of `null` — an `aggregateRating` with no usable `reviewCount` — is NOT reported here.
     * `validateGraph`'s `aggregate_rating_without_reviews` has already reported it, and a second finding
     * about one property would make a reader fix it twice. This rule is about a count that is PRESENT and
     * is not evidenced, which is the testimonial case and the one that earns a manual action.
     */
    if (claim.claimed === null) continue
    if (claim.claimed <= input.evidencedReviewCount) continue
    findings.push({
      rule: 'aggregate_rating_not_evidenced',
      path: claim.path,
      detail:
        `the markup claims ${claim.claimed} reviews and ${input.evidencedReviewCount} are held outside ` +
        'this site. docs/09 §"Schema types": do not mark up your own testimonials as review snippets — ' +
        'a rating built from on-site testimonials is valid markup and a manual action.',
    })
  }
}

/**
 * Every finding on one page, in the order a reader wants them: extraction, then absence, then content.
 *
 * Findings and not a throw, for `validateGraph`'s reason: a report printing them all is one round of fixes
 * rather than one per property.
 */
export function validatePageStructuredData(input: StructuredDataPageInput): StructuredDataReport {
  if (!Number.isInteger(input.evidencedReviewCount) || input.evidencedReviewCount < 0) {
    throw new AppError(
      'validation',
      `evidencedReviewCount for ${input.pagePath} is ${String(input.evidencedReviewCount)}. It is a ` +
        'count of reviews held outside this site, so a fraction or a negative is not an answer and ' +
        'guessing one would decide the rule that earns a manual action.',
      { details: { pagePath: input.pagePath } },
    )
  }

  const findings: StructuredDataFinding[] = []
  const blocks = jsonLdBlocks(input.html.fenced)
  let blocksParsed = 0
  let nodesJudged = 0

  if (blocks.length === 0) {
    findings.push({
      rule: 'jsonld_block_absent',
      path: input.pagePath,
      detail:
        'the page serves no <script type="application/ld+json"> block. Every rule about a graph passes ' +
        'vacuously against a page that has none, which is why the absence is the finding.',
    })
    return { findings, coverage: { blocksFound: 0, blocksParsed: 0, nodesJudged: 0 } }
  }

  const seenTypes = new Set<string>()
  for (const [index, body] of blocks.entries()) {
    /*
     * A `for...of` and not `blocks.forEach`. The body returns early twice — a block that does not parse
     * is judged no further — and `return` inside a `forEach` callback is both a lint error
     * (`useIterableCallbackReturn`) and the shape that invites somebody to write `return findings` in it
     * and wonder why the answer is empty.
     */
    const at = `block[${index}]`
    const parsed = parseBlock(body, at, findings)
    if (parsed === NOT_PARSED) continue
    blocksParsed += 1
    judgeParsedBlock(parsed, at, input, findings, seenTypes)
    nodesJudged += countNodes(parsed, seenTypes)
  }

  for (const required of input.requireTypes ?? []) {
    if (seenTypes.has(required)) continue
    findings.push({
      rule: 'required_type_absent',
      path: `${input.pagePath} @type=${required}`,
      detail:
        `the route owes a ${required} node and no block on the page carries one. A page whose graph is ` +
        'about something else is indistinguishable, to a consumer, from a page with no graph.',
    })
  }

  return {
    findings,
    coverage: { blocksFound: blocks.length, blocksParsed, nodesJudged },
  }
}

/** The findings as lines, for a report and for a failing test's message. */
export function formatStructuredDataFindings(findings: readonly StructuredDataFinding[]): string {
  return findings.map((finding) => `${finding.rule}  ${finding.path}  ${finding.detail}`).join('\n')
}

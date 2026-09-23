import { AppError } from '@berelax/shared'
import { fingerprintOf } from '../reviews/prompt-builder.ts'

/**
 * The untrusted-data envelope: the one wrapper every byte the SEO agent did not write goes through.
 *
 * ## What is untrusted here, and why it is a longer list than it looks
 *
 * A review is obviously somebody else's words (G-REV-04). The SEO agent's inputs are less obviously so, and
 * that is what makes them worse:
 *
 *   - **fetched HTML** from a competitor's page is written by somebody who would like to be ranked above us,
 *     and `<!-- ignore previous instructions -->` costs them nothing to add;
 *   - **SERP text** is a search engine's rendering of other people's titles and snippets;
 *   - **a GSC query string** is a sentence a member of the public typed into Google, which Search Console
 *     then hands back to us as data. It looks like telemetry and it is user input;
 *   - **competitor copy** extracted from a page, for the same reason as the HTML it came from.
 *
 * All four arrive through an API, which is exactly why they read as trustworthy at the call site: nobody
 * typed them into our form.
 *
 * ## The defence is structural, not careful
 *
 * The technique is G-REV-04's, deliberately unchanged, because it is proven and because a second technique
 * would be a second thing to get right. Three properties, each true by construction:
 *
 *   1. **One region per envelope, and it cannot be closed from inside.** Closing early would need a line that
 *      both starts at column 0 — no body line does, because every one carries {@link SEO_UNTRUSTED_GUTTER} —
 *      and carries the region's {@link fingerprintOf}, which is the hash of the fenced text, so the text would
 *      have to contain its own fingerprint.
 *   2. **The source label cannot be forged.** It comes from {@link SEO_UNTRUSTED_SOURCES}, a closed enum, and
 *      is upper-cased into the fence. Nothing a fetched page contains reaches it.
 *   3. **The envelope contains no instruction bytes at all.** It is the fences and the guttered body and
 *      nothing else, so a prompt's instruction section cannot be moved by its contents. That is the property
 *      `untrusted-envelope.fuzz.test.ts` asserts over 200 adversarial strings, and the one that says there is
 *      no escape to find rather than that a particular escape failed.
 *
 * ## Why the fingerprint is imported rather than written again
 *
 * `fingerprintOf` is FNV-1a over the text and lives in `../reviews/prompt-builder.ts`. There is exactly one
 * of it in this repository and there should go on being exactly one: two copies of a hash are two values that
 * agree until one of them is "improved", and the day they disagree the fences of an envelope built by one
 * cannot be matched by the other. Importing across the two subjects in this directory is the smaller cost.
 *
 * ## Why every export here is prefixed
 *
 * `SEO_UNTRUSTED_GUTTER` rather than `UNTRUSTED_GUTTER`, and so on down. `packages/core/src/index.ts`
 * re-exports both `./reviews/index.ts` and `./seo/index.ts` with `export *`, so a name shared with the review
 * builder would be an ambiguous re-export from the package barrel — and the two constants are genuinely
 * different values with genuinely different caps, so collapsing them would be worse than renaming.
 */

/** Where an untrusted string came from. A closed set: the label is part of the fence. */
export const SEO_UNTRUSTED_SOURCES = [
  'fetched_html',
  'serp_text',
  'gsc_query',
  'competitor_copy',
] as const
export type SeoUntrustedSource = (typeof SEO_UNTRUSTED_SOURCES)[number]

/**
 * The gutter every line of untrusted text carries.
 *
 * The half of the defence that does not depend on the fingerprint: a body line can contain a complete fence
 * verbatim and still close nothing, because a fence is matched as a whole line and this prefix means no body
 * line is ever a whole line of fence. `| ` rather than `> ` because `> ` is a quoting convention in the
 * Markdown a fetched page is full of, and a gutter that the source text also uses is a gutter a reader of the
 * rendered prompt cannot use to tell our framing from theirs.
 */
export const SEO_UNTRUSTED_GUTTER = '| '

const FENCE_PREFIX = '-----BEGIN UNTRUSTED SEO DATA '
const FENCE_CLOSE_PREFIX = '-----END UNTRUSTED SEO DATA '
const FENCE_SUFFIX = '-----'

/**
 * How much of each source reaches a model, per source.
 *
 * One cap per source rather than one number, because "how long can this legitimately be" has four different
 * answers and a single cap has to be the largest of them — which turns the smallest input into an unbounded
 * one. A GSC query is a sentence somebody typed into a search box; a fetched page is a document. The cap is a
 * cost and a prompt-budget control as much as a safety one: length is the one property of a competitor's page
 * that the competitor controls without limit.
 */
export const MAX_SEO_UNTRUSTED_CHARACTERS: Readonly<Record<SeoUntrustedSource, number>> =
  Object.freeze({
    fetched_html: 20_000,
    competitor_copy: 20_000,
    serp_text: 4_000,
    gsc_query: 300,
  })

/**
 * Characters removed before fencing, and why. Identical to the review builder's set, for its reasons: a NUL
 * truncates the prompt in some HTTP clients so the bytes that leave the process are not the bytes that were
 * built, and the bidi and zero-width formatters make the RENDERED prompt — what a human reads while deciding
 * whether an injection attempt happened — display in an order unrelated to the bytes. `\n`, `\r` and `\t`
 * survive, because they are how the source wrote its paragraphs and the gutter is what makes a line break
 * safe.
 */
const STRIPPED_CHARACTERS = /(?![\n\r\t])[\p{Cc}\p{Cf}]/gu

/**
 * Every line separator a renderer or a tokeniser might honour.
 *
 * `\u2028` and `\u2029` are split on rather than stripped, because they carry a paragraph — and what matters
 * is that every PHYSICAL line the model could see carries the gutter. A body split on `\n` alone leaves the
 * text after a `\u2028` un-guttered, and an un-guttered line can be a forged fence.
 */
const LINE_SEPARATORS = /\r\n|\r|\n|\u2028|\u2029/

/** The fence lines for a source and a fingerprint. Exported so a test builds them independently. */
export function seoUntrustedFences(
  source: SeoUntrustedSource,
  fingerprint: string,
): { readonly open: string; readonly close: string } {
  const label = source.toUpperCase()
  return {
    open: `${FENCE_PREFIX}${label} ${fingerprint}${FENCE_SUFFIX}`,
    close: `${FENCE_CLOSE_PREFIX}${label} ${fingerprint}${FENCE_SUFFIX}`,
  }
}

/** One enclosed region, in parts, so a caller and a test can assert each separately. */
export interface SeoUntrustedEnvelope {
  readonly source: SeoUntrustedSource
  /** Open fence line, guttered body lines, close fence line — joined with `\n`, and nothing else. */
  readonly region: string
  /** The fingerprint the fences carry: of the text AS FENCED, after stripping and truncation. */
  readonly fingerprint: string
  /** How many characters the cap dropped. Non-zero is ordinary for a fetched page. */
  readonly truncatedCharacters: number
  /** How many control or format characters were removed. Non-zero is itself a signal. */
  readonly strippedControlCharacters: number
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Encloses one untrusted string. THE wrapper — the dependency rule
 * `seo-prompt-must-use-the-untrusted-envelope` exists so there is no second one.
 *
 * Throws on a failed self-check rather than returning a region. A structural invariant that does not hold
 * means the escaping is broken, and both alternatives are worse: returning the region sends it, and returning
 * a refusal invites a caller to log it and carry on. A throw reaches `withAgentRun`, which records the run as
 * failed and leaves `last_success_at` alone — so the agent goes visibly quiet, which is what a broken
 * envelope should do.
 */
export function encloseUntrustedSeoData(args: {
  readonly source: SeoUntrustedSource
  readonly text: string
}): SeoUntrustedEnvelope {
  if (!(SEO_UNTRUSTED_SOURCES as readonly string[]).includes(args.source)) {
    throw new AppError(
      'validation',
      `untrusted SEO data must declare one of ${SEO_UNTRUSTED_SOURCES.join(', ')}, received ` +
        `${String(args.source)}`,
    )
  }
  const cap = MAX_SEO_UNTRUSTED_CHARACTERS[args.source]
  const stripped = args.text.replace(STRIPPED_CHARACTERS, '')
  /*
   * Counted and sliced in CODE POINTS, not UTF-16 units, which is the same decision the review builder made.
   * `String.prototype.slice` at a fixed length cuts a surrogate pair in half when the cap lands inside an
   * emoji, and the lone surrogate that results is an ill-formed string: it serialises differently in every
   * client, and a fingerprint taken over it binds the fences to bytes the next reader cannot reproduce.
   */
  const points = [...stripped]
  const strippedControlCharacters = [...args.text].length - points.length
  const fenced = points.slice(0, cap).join('')
  const truncatedCharacters = Math.max(0, points.length - cap)
  const fingerprint = fingerprintOf(fenced)
  const fences = seoUntrustedFences(args.source, fingerprint)
  const body = fenced.split(LINE_SEPARATORS).map((line) => `${SEO_UNTRUSTED_GUTTER}${line}`)
  const region = [fences.open, ...body, fences.close].join('\n')

  /*
   * The self-check. Both of these are impossible given the construction above, which is exactly why they are
   * asserted: an "impossible" invariant nobody checks is how the escaping quietly stops working, and the test
   * that would have caught it cannot run in production. A broken envelope in production is a prompt injection.
   *
   * Deliberately NOT a third check that `lines[0]` is the open fence. That one is a tautology rather than an
   * invariant — the region is built as `[open, ...body, close].join('\n')` and neither fence contains a
   * newline — and a tautological guard is a line a reader has to reason about before discovering it says
   * nothing.
   */
  if (occurrences(region, fences.open) !== 1 || occurrences(region, fences.close) !== 1) {
    throw new AppError(
      'invariant_violated',
      `the untrusted ${args.source} region is not delimited exactly once. The source text contains a ` +
        'fence carrying its own fingerprint, so no region was built.',
      { details: { code: 'seo_untrusted_envelope_broken', source: args.source } },
    )
  }
  if (body.some((line) => !line.startsWith(SEO_UNTRUSTED_GUTTER))) {
    throw new AppError(
      'invariant_violated',
      `a line of the untrusted ${args.source} region is not guttered, so a fence could be forged at ` +
        'column 0.',
      { details: { code: 'seo_untrusted_envelope_broken', source: args.source } },
    )
  }

  return Object.freeze({
    source: args.source,
    region,
    fingerprint,
    truncatedCharacters,
    strippedControlCharacters,
  })
}

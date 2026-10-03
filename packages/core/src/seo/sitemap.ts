/**
 * The sitemap's bytes, and the reciprocity rule that decides whether a crawler reads them at all.
 *
 * A sitemap is XML a crawler fetches, so the two things that can be wrong with it are both invisible from
 * inside the application: the SHAPE (a `<loc>` that is not a URL, a `<lastmod>` in a format nobody parses)
 * and the RECIPROCITY of the `hreflang` set. The second is the one that is usually broken, and Google's
 * rule for it is unforgiving: **every page in a set lists every page in the set, including itself.** A set
 * that is lopsided is not partially honoured — it is **ignored entirely**, and the symptom is the Arabic
 * page ranking for English queries with no explanation anywhere.
 *
 * So the alternates are not decoration on a URL entry. They are a graph, and
 * {@link reciprocityFindings} judges it: pure, over a fixture whose answer is known, which is the only
 * place this can be proven. `apps/web/src/public-site.itest.ts` then cross-checks the sitemap's set
 * against the `<head>` the page actually serves — two statements of one fact, held equal.
 *
 * ## Why `lastmod` carries the Asia/Dubai offset rather than `Z`
 *
 * Both are valid W3C datetimes and a crawler accepts either. The offset is the acceptance criterion's and
 * the reason is a reader rather than a crawler: the person who asks "did the sitemap notice my price
 * change at four this afternoon?" is in `Asia/Dubai`, and a `lastmod` of `12:00:00Z` is an answer they
 * have to do arithmetic on. ADR 0007's rule is that the zone is always an argument, which is why the
 * offset is passed in rather than read from a clock here.
 *
 * ## Why this is in `packages/core` and the builder is not
 *
 * These are string functions over declared inputs. Which URLs belong in which section is a question about
 * the catalogue, the roster and the CMS, so it lives in `apps/web/src/sitemap/build.ts` where it can read
 * them — and every rule about the RESULT lives here, where it is a unit test rather than a fetch.
 */
import { AppError } from '@berelax/shared'

/**
 * The sections of the sitemap index, in the order the index lists them.
 *
 * Four, from the acceptance criterion: `pages` is every route whose path is a literal, and the other
 * three are the ones a row decides. Enumerated as a closed set rather than derived, because a section
 * nothing fills is the failure to catch — `sitemapIndexXml` refuses a section with no URLs rather than
 * publishing an empty one, and an empty `<urlset>` tells a crawler those pages have gone.
 */
export const SITEMAP_TYPES = ['pages', 'treatments', 'therapists', 'journal'] as const
export type SitemapType = (typeof SITEMAP_TYPES)[number]

export function isSitemapType(value: string): value is SitemapType {
  return (SITEMAP_TYPES as readonly string[]).includes(value)
}

/** `<changefreq>`, as the registry declares it. */
export type SitemapChangeFrequency =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never'

/** One `<url>`: an absolute location, when it last changed, and its complete `hreflang` set. */
export interface SitemapUrl {
  /** Absolute. A relative `<loc>` is rejected by every consumer. */
  readonly loc: string
  /** W3C datetime. Built by {@link lastmodFor} so the zone is stated rather than assumed. */
  readonly lastmod: string
  readonly changefreq: SitemapChangeFrequency
  /**
   * Keyed by `hreflang` value, including this URL's own language and `x-default`.
   *
   * Self-referential on purpose: see the module header. Empty is legitimate only for a URL served in one
   * language with no alternate, and `reciprocityFindings` is what says whether that is this URL's case.
   */
  readonly alternates: Readonly<Record<string, string>>
}

/** One section of the index: where it is served and the newest `lastmod` inside it. */
export interface SitemapSection {
  readonly type: SitemapType
  readonly loc: string
  readonly lastmod: string
  /** How many URLs it holds. Zero is refused by {@link sitemapIndexXml}; see its header. */
  readonly urlCount: number
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/**
 * XML-escaped text.
 *
 * A URL can legitimately contain `&` — a query string — and an unescaped one makes the whole document
 * unparseable, so a crawler discards every URL in it rather than the one that is wrong. The ampersand is
 * replaced first by using one pass over a character class, because a sequential replace would turn `&`
 * into `&amp;` and then the `&` of `&amp;` into `&amp;amp;`.
 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPES[character] ?? character)
}

/**
 * A `<lastmod>` in a stated zone, from an ISO instant.
 *
 * `offsetMinutes` is an argument because ADR 0007 says the zone always is. The output is the W3C
 * "complete date plus hours, minutes and seconds" profile with a numeric offset — the form the acceptance
 * criterion names, and the one a reader in the UAE does not have to convert.
 *
 * Throws on an unparseable instant rather than emitting `Invalid Date`: a sitemap carrying one is a
 * document a crawler rejects whole, so the failure belongs at the moment the string is built.
 */
export function lastmodFor(iso: string, offsetMinutes: number): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new AppError('validation', `'${iso}' is not an instant a <lastmod> can be built from`, {
      details: { rule: 'sitemap_lastmod_is_an_instant' },
    })
  }
  const shifted = new Date(ms + offsetMinutes * 60_000)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  )
}

/** The rules a sitemap's `hreflang` graph has to satisfy. A finding names one of these. */
export const SITEMAP_RECIPROCITY_RULES = [
  /** A URL whose alternate set does not list the URL itself. Google discards the whole set. */
  'alternate_set_is_not_self_referential',
  /** A lists B and B does not list A. Google discards both sets. */
  'alternate_set_is_not_reciprocal',
  /** An alternate pointing at a URL the sitemap does not contain. */
  'alternate_names_an_absent_url',
  /** Two URLs in one sitemap with the same `<loc>`. */
  'duplicate_location',
] as const
export type SitemapReciprocityRule = (typeof SITEMAP_RECIPROCITY_RULES)[number]

export interface SitemapFinding {
  readonly rule: SitemapReciprocityRule
  readonly loc: string
  readonly why: string
}

/**
 * Every way this sitemap's `hreflang` graph is not a set of mutually-referencing documents.
 *
 * Findings rather than a throw, and every rule over every URL rather than the first failure: the report
 * is read by a person fixing a sitemap, and "one of your 24 entries is wrong" is not actionable.
 *
 * `alternate_names_an_absent_url` is the rule that catches the realistic defect. The other three are
 * properties of a set that was built wrong; this one fires when a set was built right and the OTHER
 * document stopped being published — an archived treatment, a therapist whose consent was withdrawn — so
 * it is the one that goes wrong after the code was correct.
 */
export function reciprocityFindings(urls: readonly SitemapUrl[]): readonly SitemapFinding[] {
  const findings: SitemapFinding[] = []
  const present = new Set<string>()
  for (const url of urls) {
    if (present.has(url.loc)) {
      findings.push({
        rule: 'duplicate_location',
        loc: url.loc,
        why: `${url.loc} appears twice in one sitemap, so a crawler is told two different lastmods for one page.`,
      })
      continue
    }
    present.add(url.loc)
  }
  const setsByLoc = new Map(urls.map((url) => [url.loc, url.alternates]))
  for (const url of urls) {
    const hrefs = Object.values(url.alternates)
    if (hrefs.length === 0) continue
    if (!hrefs.includes(url.loc)) {
      findings.push({
        rule: 'alternate_set_is_not_self_referential',
        loc: url.loc,
        why:
          `${url.loc} lists ${hrefs.length} alternate(s) and not itself. Google requires every page in a ` +
          'set to list every page INCLUDING itself, and discards a set that does not — so the whole ' +
          'group loses its language signal rather than this one entry.',
      })
    }
    for (const href of hrefs) {
      if (href === url.loc) continue
      const other = setsByLoc.get(href)
      if (other === undefined) {
        findings.push({
          rule: 'alternate_names_an_absent_url',
          loc: url.loc,
          why:
            `${url.loc} names ${href} as an alternate and this sitemap does not contain it. The usual ` +
            'cause is the other document becoming unpublishable — an archived treatment, a withdrawn ' +
            'photography consent — which leaves the surviving half of the pair pointing at nothing.',
        })
        continue
      }
      if (!Object.values(other).includes(url.loc)) {
        findings.push({
          rule: 'alternate_set_is_not_reciprocal',
          loc: url.loc,
          why: `${url.loc} names ${href}, and ${href} does not name ${url.loc}. Both sets are discarded.`,
        })
      }
    }
  }
  return findings
}

/** The findings as lines, for a report and for a failing test's message. */
export function formatSitemapFindings(findings: readonly SitemapFinding[]): string {
  return findings.map((finding) => `${finding.rule}  ${finding.loc}  ${finding.why}`).join('\n')
}

const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'

/**
 * One `<urlset>`, with an `<xhtml:link>` per alternate.
 *
 * **It refuses a sitemap whose reciprocity is broken**, rather than serving it. The alternative was to
 * serve it and report the findings somewhere, and it is wrong in this one direction: a lopsided set makes
 * Google discard the language signal for every page in the group, so serving it is worse than serving
 * nothing while somebody fixes it — and a 500 on `/sitemaps/treatments` is noticed the same day, where a
 * silently-ignored `hreflang` set is noticed in a quarterly ranking report.
 *
 * The alternates are sorted by `hreflang` so two builds of one sitemap are byte-identical: a diff of this
 * document is how a person checks what a publish changed, and an unstable key order makes every diff the
 * whole file.
 */
export function sitemapXml(urls: readonly SitemapUrl[]): string {
  const findings = reciprocityFindings(urls)
  if (findings.length > 0) {
    throw new AppError(
      'invariant_violated',
      `this sitemap's hreflang sets are not reciprocal, so Google would discard the language signal for ` +
        `every page in the affected groups:\n${formatSitemapFindings(findings)}`,
      { details: { rule: 'sitemap_alternates_are_reciprocal', findings } },
    )
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_NS}" xmlns:xhtml="${XHTML_NS}">`,
  ]
  for (const url of urls) {
    lines.push('  <url>')
    lines.push(`    <loc>${escapeXml(url.loc)}</loc>`)
    lines.push(`    <lastmod>${escapeXml(url.lastmod)}</lastmod>`)
    lines.push(`    <changefreq>${url.changefreq}</changefreq>`)
    for (const hreflang of Object.keys(url.alternates).sort()) {
      const href = url.alternates[hreflang] ?? ''
      lines.push(
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}" />`,
      )
    }
    lines.push('  </url>')
  }
  lines.push('</urlset>')
  return `${lines.join('\n')}\n`
}

/**
 * The index: one `<sitemap>` per section.
 *
 * **A section with no URLs is refused.** An empty `<urlset>` is a positive statement — *there are no
 * pages of this kind* — and a crawler acts on it by dropping the ones it knows about. The honest answer
 * for a section that is legitimately empty is to leave it out of the index, which is what the builder
 * does for `therapists` today: nobody is publishable (ADR 0020), so there is no therapist sitemap at all
 * rather than one claiming the therapist pages have gone.
 */
export function sitemapIndexXml(sections: readonly SitemapSection[]): string {
  const empty = sections.filter((section) => section.urlCount === 0)
  if (empty.length > 0) {
    throw new AppError(
      'invariant_violated',
      `the sitemap index would list ${empty.map((section) => section.type).join(', ')} with no URLs. An ` +
        'empty <urlset> tells a crawler those pages have gone; leave the section out of the index instead.',
      { details: { rule: 'sitemap_index_lists_no_empty_section' } },
    )
  }
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<sitemapindex xmlns="${SITEMAP_NS}">`]
  for (const section of sections) {
    lines.push('  <sitemap>')
    lines.push(`    <loc>${escapeXml(section.loc)}</loc>`)
    lines.push(`    <lastmod>${escapeXml(section.lastmod)}</lastmod>`)
    lines.push('  </sitemap>')
  }
  lines.push('</sitemapindex>')
  return `${lines.join('\n')}\n`
}

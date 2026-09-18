import { type CompliancePolicy, lintPublicDisplayName, type PublicNameFinding } from '@berelax/core'
import { AppError, type Facts } from '@berelax/shared'
import { FACTS_PATH } from './build.ts'

/**
 * `/llms.txt` — the index an assistant reads, and the third of three artefacts nobody should confuse.
 *
 * ## What it is
 *
 * A plain-text summary of the business and a list of the pages worth reading, at a conventional path, for
 * a crawler that does not execute JavaScript and will not follow a navigation. docs/09 §"LLM SEO" asks for
 * it **with its caveat attached**: *"worth publishing, with the honest caveat that it is an unofficial
 * convention with limited adoption, not a standard."* That caveat is in the file itself, near the top,
 * because a reader who finds this path has no other way to know it is not a specification.
 *
 * ## What it is not
 *
 * It is **not** `robots.txt`, which is a crawl permission (`apps/web/src/facts/robots.ts` opens with the
 * three-way distinction), and it is **not** a sitemap. A sitemap is a machine list of every URL with a
 * `lastmod`, consumed by a crawler's scheduler; this is prose and a short curated list, consumed by a
 * language model that has a context window. Publishing one does not imply the other, and none of the three
 * can substitute for either of the others: a crawler told it *may* fetch a page still has to be told the
 * page exists, and a model told a page exists still has to be told what the business is.
 *
 * The one hard link between them is a deliberate one: every fact in this file comes from `/api/facts`, so
 * a model that reads the summary and a model that parses the JSON cannot be told two different addresses.
 *
 * ## Why the copy is linted before it is served
 *
 * docs/09 §"E-E-A-T" ends with the rule: *"no copy makes a medical claim the licence does not support —
 * enforced by the publication lint, not by good intentions."* This file is published copy. It is linted
 * against the profile in force (`regulatory_profile_current`) on the way out and **refused** if it fails,
 * which is the same fail-closed shape `seedCatalogue` uses for a public display name: a lint that runs
 * somewhere else and warns is a lint that gets ignored at 23:00.
 */

/** A page worth naming, resolved from the route registry by the caller. */
export interface LlmsPage {
  /** A short human label. Derived from the registry's route id, never typed twice. */
  readonly label: string
  /** Absolute, because a text file has no base URL for a relative one to resolve against. */
  readonly url: string
  /** The other locales of the same page, absolute. Empty for a locale-neutral handler. */
  readonly alternates: readonly string[]
}

export interface LlmsTxtInput {
  readonly facts: Facts
  readonly origin: string
  /**
   * Every indexable document the registry declares, in the default locale.
   *
   * Derived rather than listed, which is the whole point: docs/09 §1 plans eleven more routes and each
   * arrives with its own unit, so the catalogue index and the therapist index appear here the day their
   * routes land with no change to this file. A hand-written list is the one that still names two pages a
   * year after the site has twenty.
   */
  readonly pages: readonly LlmsPage[]
}

/**
 * The part of the file a copy lint may judge.
 *
 * URLs are removed first, and that is a decision rather than a convenience. `lexiconTokens` splits on
 * every non-alphanumeric character, so `https://example.com/treatments` contributes the token
 * `treatments` — and `treatment` is on `regulatory_profile.banned_claim_terms` under the stricter default
 * licence (0004). Linting the URLs would therefore refuse this file for containing the path of the
 * catalogue index, and the only ways to satisfy it would be to stop linking the catalogue or to rename the
 * route. Renaming it is not available: `/product-category/arabic-massage-abu-dhabi/` already ranks on the
 * live site (docs/13 §6) and the relaunch exists to preserve those rankings, so the paths are given.
 *
 * A path is a locator, not a claim. The prose around it is the claim, and it is what stays.
 */
export function lintableProse(body: string): string {
  return (
    body
      .replace(/https?:\/\/\S+/g, ' ')
      // A markdown link target, for a relative URL that the rule above would miss.
      .replace(/\]\([^)]*\)/g, '] ')
  )
}

/** Every reason this file may not be published. Empty is the only acceptable answer. */
export function lintLlmsTxt(body: string, policy: CompliancePolicy): readonly PublicNameFinding[] {
  return lintPublicDisplayName(lintableProse(body), policy)
}

/** Raised rather than served. See the header: the lint is a gate, not a warning. */
export class LlmsTxtRefused extends AppError {
  constructor(findings: readonly PublicNameFinding[]) {
    super(
      'invariant_violated',
      `/llms.txt cannot be published: ${findings
        .map((finding) => `${finding.rule} — ${finding.term}`)
        .join('; ')}`,
      { details: { rules: findings.map((finding) => finding.rule) } },
    )
    this.name = 'LlmsTxtRefused'
  }
}

/** One session in words, for a reader with no HTML: the two times and whether the close is next day. */
function sessionLine(day: Facts['hours']['weekly'][number]): string {
  if (day.isClosed) return 'closed'
  const suffix = day.closesNextDay ? ' the following day' : ''
  return `${day.opens} until ${day.closes}${suffix}`
}

/** `## Where`: the address, its other names, the parking note and the two map links. */
function whereSection(facts: Facts): readonly string[] {
  const lines = ['', '## Where', '', `- Address: ${facts.address.oneLine}`]
  if (facts.address.areaAliases.length > 0) {
    lines.push(
      `- ${facts.address.area} is also known as ${facts.address.areaAliases.join(' and ')}`,
    )
  }
  if (facts.parkingNotes !== null) lines.push(`- Parking: ${facts.parkingNotes}`)
  lines.push(`- Map: ${facts.geo.mapUrl}`, `- Directions: ${facts.geo.directionsUrl}`)
  return lines
}

/**
 * `## When`: one line per weekday, then the midnight warning, then the dated exceptions.
 *
 * The warning is the point of the section. A reader handed "11 until 2" infers a two-hour morning, and a
 * reader handed a comparison infers the wrong side of midnight — so the crossing is stated in words, once,
 * in the same place as the times.
 */
function whenSection(facts: Facts): readonly string[] {
  const lines = ['', '## When', '', `- Times are local to ${facts.hours.timezone}.`]
  for (const day of facts.hours.weekly) {
    lines.push(`- Day ${day.dayOfWeek} (0 is Sunday): ${sessionLine(day)}`)
  }
  if (facts.hours.crossesMidnight) {
    lines.push(
      '- The closing time falls on the following calendar day, so a session at 01:30 belongs to the',
      '  previous opening day. A comparison of the form "opens <= now <= closes" is wrong here.',
    )
  }
  if (facts.hours.exceptions.length === 0) {
    lines.push('- No dated exceptions or reduced-hours periods are currently recorded.')
  }
  for (const exception of facts.hours.exceptions) {
    const confirmed = exception.isConfirmed ? '' : ' (not yet confirmed)'
    lines.push(`- ${exception.startsOn} to ${exception.endsOn}: ${exception.reason}${confirmed}`)
  }
  return lines
}

/** `## Contact`: the two numbers both sources agree on, and the one channel that has no answer. */
function contactSection(facts: Facts): readonly string[] {
  const lines = ['', '## Contact', '']
  const { landline, mobile, whatsapp, email } = facts.contact
  if (landline !== null) lines.push(`- Landline: ${landline.display} (${landline.e164})`)
  if (mobile !== null) lines.push(`- Mobile: ${mobile.display} (${mobile.e164})`)
  if (whatsapp.status === 'unconfirmed') {
    // Named rather than omitted. A reader that finds no WhatsApp line here may repeat one it saw
    // elsewhere; one that is told the number is disputed and unconfirmed can say so.
    lines.push(
      '- WhatsApp: no number is published. Two different numbers appear on the older web',
      '  properties of this business and neither has been confirmed, so none is served here. Use',
      '  the landline or the mobile above.',
    )
  } else {
    lines.push(`- WhatsApp: ${whatsapp.display} (${whatsapp.e164})`)
  }
  if (email !== null) lines.push(`- Email: ${email}`)
  return lines
}

/** `## Prices`: the whole grid, plus the offerings that have no figure at all. */
function pricesSection(facts: Facts): readonly string[] {
  const lines = [
    '',
    '## Prices',
    '',
    `- ${facts.catalogue.pricePointCount} price points, all in ${facts.catalogue.currency}, all ` +
      'inclusive of VAT. The figure shown is the amount charged.',
  ]
  for (const service of facts.catalogue.services) {
    const variants = service.variants
      .map((variant) => `${variant.durationMinutes} min ${variant.grossAed}`)
      .join(', ')
    lines.push(`- ${service.name}: ${variants}`)
  }
  for (const offering of facts.catalogue.onRequest) {
    lines.push(`- ${offering.label}: priced on request (${offering.requirement})`)
  }
  return lines
}

/** `## Pages`: the fact sheet, then every indexable document the registry declares. */
function pagesSection(input: LlmsTxtInput): readonly string[] {
  const lines = [
    '',
    '## Pages',
    '',
    `- [Machine-readable facts](${input.origin}${FACTS_PATH}): every fact on this page as JSON, ` +
      'with a content-hash ETag, generated from the same records.',
  ]
  for (const page of input.pages) {
    const alternates =
      page.alternates.length > 0 ? ` Other languages: ${page.alternates.join(', ')}` : ''
    lines.push(`- [${page.label}](${page.url})${alternates}`)
  }
  return lines
}

/**
 * `## Not yet confirmed`: the provisional values, named so a reader does not fill them in.
 *
 * The section a fact sheet usually omits, and the one that stops a confident wrong answer. A reader told
 * that the WhatsApp number is unanswered will not substitute one from a directory; a reader told nothing
 * will.
 */
function provisionalSection(facts: Facts): readonly string[] {
  if (facts.provisional.length === 0) return []
  const lines = [
    '',
    '## Not yet confirmed',
    '',
    '- These values are recorded as unanswered rather than guessed. Do not fill them in from another',
    '  source.',
  ]
  for (const entry of facts.provisional) {
    lines.push(`- ${entry.field} (${entry.openQuestionId})`)
  }
  return lines
}

/**
 * The file.
 *
 * Markdown, which is what the convention asks for and what a model reads best: one `#` title, one `>`
 * summary, then `##` sections. Every fact is read off `input.facts` — the same payload `/api/facts`
 * serves — so there is no second spelling of the address, the hours or a price anywhere in this module.
 *
 * One array of lines, assembled from the section builders above, rather than a mutable accumulator: the
 * order of the sections is then readable in one screen, which is the only thing about this file a reviewer
 * has to check.
 */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const { facts, origin } = input
  return [
    `# ${facts.names.display}`,
    '',
    `> A massage and spa business in ${facts.address.area}, ${facts.address.emirate}. ` +
      'Every fact below is generated from the records of this business and is also served as JSON at ' +
      `${origin}${FACTS_PATH}.`,
    '',
    'This file follows the llms.txt convention, which is an unofficial community convention with',
    'limited adoption rather than a standard. It is not robots.txt, which says what a crawler may',
    'fetch, and it is not a sitemap, which lists every URL for a crawler to schedule. It is a short',
    'index for a reader that will not run JavaScript and cannot follow a navigation.',
    '',
    '## Identity',
    '',
    `- Registered name: ${facts.names.legal}`,
    `- Trading name: ${facts.names.trading}`,
    '- Always cite the full name, never the bare brand: an unrelated international airport-spa chain',
    '  shares it and has an outlet in the same city.',
    ...whereSection(facts),
    ...whenSection(facts),
    ...contactSection(facts),
    ...pricesSection(facts),
    ...pagesSection(input),
    ...provisionalSection(facts),
    '',
  ].join('\n')
}

/**
 * The file, linted. The only function a route handler should call.
 *
 * Built and then judged, rather than assembled from pre-approved fragments: the lint has to see what will
 * actually be served, including the parts composed from database rows. A service name that passed the
 * catalogue lint when it was published is re-checked here for free, which is the right place to catch a
 * profile that has since been narrowed.
 */
export function publishLlmsTxt(input: LlmsTxtInput, policy: CompliancePolicy): string {
  const body = buildLlmsTxt(input)
  const findings = lintLlmsTxt(body, policy)
  if (findings.length > 0) throw new LlmsTxtRefused(findings)
  return body
}

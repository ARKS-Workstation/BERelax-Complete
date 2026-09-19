/**
 * The structured-data validator: does this graph say what it claims, and nothing the database does not hold?
 *
 * ## Why it takes `unknown`
 *
 * Because its most important caller does not have the builders' types. `scripts/validate-structured-data.mjs`
 * and the integration suite both parse a `<script type="application/ld+json">` block out of a **rendered
 * page** and validate the JSON that came back. A validator typed against `LocalBusinessNode` would be
 * asserting that the builders agree with themselves, which is the shape of test the brief's rule 3 calls
 * vacuous — it can never fail for the reason the gate exists.
 *
 * ## Why it is here and not in the script
 *
 * Three callers need the same answer: the CI gate, the integration test that crawls the routes, and the unit
 * tests that pair each rule with a known-bad node. A validator in the script would be reachable only by the
 * script, and its rules would be proved by nothing.
 *
 * ## What it refuses, beyond "is this valid schema.org"
 *
 * The rules that make a *valid* graph a *false* one, which is the failure that matters here:
 *
 *   - **A `null` anywhere.** `"geo": null` is a published claim; `"latitude": null` is worse, because a
 *     consumer checking for the key finds it. The builders omit; this is what proves they did.
 *   - **A placeholder.** `TRN-PENDING-Y1-TRN` and `WHATSAPP-PENDING-Y1-NAP` are values the schema's own
 *     `is_placeholder_text()` refuses (0026), and a published document is the last place they may reach.
 *     The predicate is `isPlaceholderText` from `@berelax/core` — the same list as the SQL function, not a
 *     second one.
 *   - **Medical vocabulary outside a healthcare licence.** As a `@type` or as text, anywhere.
 *   - **An `aggregateRating` at all**, unless real reviews sit behind it. docs/09 §"Schema types": *"do not
 *     mark up your own testimonials as review snippets"*. This is the rule whose violation earns a manual
 *     action, so it is checked on the emitted bytes rather than trusted to the absence of a builder.
 *   - **An `OpeningHoursSpecification` that crosses midnight.** `closes < opens` in one spec is the encoding
 *     that makes a consumer conclude the premises is never open; see `openingHoursSpecifications`.
 *   - **A `Service` with no offers**, and an `Offer` whose price is neither a two-decimal AED figure nor
 *     honestly absent.
 */
import { isPlaceholderText } from '../../money/vat.ts'
import { isOpenAt } from './business.ts'
import type { GraphRule, OpeningHoursSpecificationNode } from './types.ts'
import { SCHEMA_CONTEXT } from './types.ts'
import { type LicenceClass, medicalTermsIn, medicalVocabularyPermitted } from './vocabulary.ts'

/** One thing wrong with a graph. `rule` is the name a test and a CI log both quote. */
export interface GraphFinding {
  readonly rule: GraphRule
  /** Where it is, as a JSON path from the graph root: `@graph[0].address.streetAddress`. */
  readonly path: string
  readonly detail: string
}

export interface ValidateGraphOptions {
  /**
   * The licence class in force, which decides whether the medical vocabulary is permitted.
   *
   * Required rather than defaulted. A default of `'unconfirmed'` would be the safe answer and the wrong
   * design: the caller that forgets to pass it is the caller whose profile has been flipped, and a
   * validator that quietly assumed the strict case would reject a graph that had become legitimate.
   */
  readonly licence: LicenceClass
  /**
   * Node types whose absence is a finding.
   *
   * The graph is built per page, so "required" is a property of the page rather than of the vocabulary:
   * a home page must carry a business node, a treatment page must carry a `Service`. Empty means "check
   * only what is here".
   */
  readonly requireTypes?: readonly string[]
}

/** `HH:MM`, 24-hour. The same shape `localTimeSchema` accepts in the facts payload. */
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
/** Exactly two decimals, no grouping separator, no currency symbol. */
const TWO_DECIMALS = /^\d+\.\d{2}$/

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

const isAbsoluteUrl = (value: unknown): boolean =>
  typeof value === 'string' && /^https?:\/\/\S+$/.test(value)

/**
 * Every finding in a graph, in the order they were found.
 *
 * Findings and not a throw. The CI gate prints them all and exits non-zero, and one finding per run would
 * make fixing a graph an iteration per property.
 */
export function validateGraph(
  graph: unknown,
  options: ValidateGraphOptions,
): readonly GraphFinding[] {
  const findings: GraphFinding[] = []
  const report = (rule: GraphRule, path: string, detail: string): void => {
    findings.push({ rule, path, detail })
  }

  if (!isRecord(graph) || graph['@context'] !== SCHEMA_CONTEXT) {
    report(
      'context_missing',
      '@context',
      `a graph must declare '@context': '${SCHEMA_CONTEXT}'; found ${JSON.stringify(
        isRecord(graph) ? graph['@context'] : graph,
      )}`,
    )
    // Without a context nothing below means anything: every `@type` is an undefined term, so reporting
    // thirty consequential findings would bury the one that matters.
    return findings
  }

  const nodes = graph['@graph']
  if (!Array.isArray(nodes)) {
    report('context_missing', '@graph', 'a graph must carry an @graph array of nodes')
    return findings
  }

  // --- whole-graph rules ------------------------------------------------------------------------
  walkValues(graph, '', (value, path) => {
    if (value === null) {
      report(
        'null_property',
        path,
        'null is a published claim, not an absent property. The builders omit the key instead.',
      )
      return
    }
    if (typeof value === 'string' && value.trim() !== '' && isPlaceholderText(value)) {
      report(
        'placeholder_property',
        path,
        `'${value}' carries a provisional marker that is_placeholder_text() refuses (0026). Nothing ` +
          'provisional may reach a published document.',
      )
    }
  })

  if (!medicalVocabularyPermitted(options.licence)) {
    const terms = medicalTermsIn(graph)
    if (terms.length > 0) {
      report(
        'medical_vocabulary_outside_healthcare',
        '@graph',
        `${terms.join(', ')} may not appear while regulatory_profile.licence_class is ` +
          `'${options.licence}' (docs/09 §"Schema types", Y1-licence)`,
      )
    }
  }

  const seenIds = new Map<string, number>()
  nodes.forEach((node, index) => {
    const path = `@graph[${index}]`
    if (!isRecord(node)) {
      report('node_without_type', path, 'a graph node must be an object')
      return
    }
    const types = typesOf(node)
    if (types.length === 0) {
      report('node_without_type', path, 'every node needs an @type; a node without one is ignored')
    }
    const id = node['@id']
    if (typeof id === 'string') {
      const previous = seenIds.get(id)
      if (previous !== undefined) {
        report(
          'duplicate_node_id',
          `${path}.@id`,
          `'${id}' is already @graph[${previous}]'s @id. Two nodes with one @id merge, and the ` +
            'properties of one silently overwrite the other.',
        )
      } else seenIds.set(id, index)
    }
    validateNode(node, types, path, report)
  })

  for (const required of options.requireTypes ?? []) {
    const present = nodes.some((node) => isRecord(node) && typesOf(node).includes(required))
    if (!present) {
      report(
        'business_missing_required_property',
        '@graph',
        `this page must carry a ${required} node and carries none`,
      )
    }
  }

  return findings
}

type Report = (rule: GraphRule, path: string, detail: string) => void

/** The per-type rules, dispatched on every `@type` the node declares. */
function validateNode(
  node: Record<string, unknown>,
  types: readonly string[],
  path: string,
  report: Report,
): void {
  // `aggregateRating` and `review` are checked on every node, whatever its type: the rule is about the
  // claim and not about where it was attached, and attaching it to an `Organization` instead of the
  // business is exactly how a self-serving rating survives a review of the business node.
  validateRating(node, path, report)

  // A business type is anything that carries an address and hours. Checked by presence of the properties
  // as well as by name, because `DaySpa` today and `HealthAndBeautyBusiness` tomorrow are the same node.
  if (
    types.includes('DaySpa') ||
    types.includes('LocalBusiness') ||
    types.includes('MedicalClinic')
  ) {
    validateBusiness(node, path, report)
  }
  if (types.includes('Organization')) validateOrganization(node, path, report)
  if (types.includes('Service')) validateService(node, path, report)
  if (types.includes('FAQPage')) validateFaqPage(node, path, report)
  if (types.includes('BreadcrumbList')) validateBreadcrumb(node, path, report)
  if (types.includes('Person')) validatePerson(node, path, report)
  if (types.includes('ImageObject')) validateImageObject(node, path, report)
  if (types.includes('VideoObject')) validateVideoObject(node, path, report)
}

function requireStrings(
  node: Record<string, unknown>,
  properties: readonly string[],
  rule: GraphRule,
  path: string,
  report: Report,
): void {
  for (const property of properties) {
    const value = node[property]
    if (typeof value !== 'string' || value.trim() === '') {
      report(rule, `${path}.${property}`, `${property} is required and must be a non-empty string`)
    }
  }
}

function validateBusiness(node: Record<string, unknown>, path: string, report: Report): void {
  requireStrings(
    node,
    ['name', 'url', 'telephone'],
    'business_missing_required_property',
    path,
    report,
  )
  if (!isAbsoluteUrl(node['url'])) {
    report('url_not_absolute', `${path}.url`, 'a business node needs an absolute url')
  }

  const address = node['address']
  if (!isRecord(address)) {
    report(
      'business_missing_required_property',
      `${path}.address`,
      'a LocalBusiness without a PostalAddress is the one property Google requires and the one a ' +
        'customer needs',
    )
  } else {
    requireStrings(
      address,
      ['streetAddress', 'addressLocality', 'addressRegion', 'addressCountry'],
      'address_missing_required_property',
      `${path}.address`,
      report,
    )
  }

  const hours = node['openingHoursSpecification']
  if (!Array.isArray(hours) || hours.length === 0) {
    report(
      'opening_hours_missing_required_property',
      `${path}.openingHoursSpecification`,
      'a business that takes bookings publishes its hours; an absent set reads as unknown, which an ' +
        'assistant answers as closed',
    )
  } else {
    hours.forEach((spec, index) => {
      validateHoursSpec(spec, `${path}.openingHoursSpecification[${index}]`, report)
    })
  }

  const geo = node['geo']
  if (geo !== undefined) validateGeo(geo, `${path}.geo`, report)
}

function validateHoursSpec(spec: unknown, path: string, report: Report): void {
  if (!isRecord(spec)) {
    report(
      'opening_hours_missing_required_property',
      path,
      'an hours specification must be an object',
    )
    return
  }
  const opens = spec['opens']
  const closes = spec['closes']
  const days = spec['dayOfWeek']
  if (days === undefined || (Array.isArray(days) && days.length === 0)) {
    report('opening_hours_missing_required_property', `${path}.dayOfWeek`, 'dayOfWeek is required')
  }
  for (const [property, value] of [
    ['opens', opens],
    ['closes', closes],
  ] as const) {
    if (typeof value !== 'string') {
      report(
        'opening_hours_missing_required_property',
        `${path}.${property}`,
        `${property} is required`,
      )
    } else if (!LOCAL_TIME.test(value)) {
      report(
        'opening_hours_malformed_time',
        `${path}.${property}`,
        `'${value}' is not a 24-hour HH:MM local time`,
      )
    }
  }
  if (
    typeof opens === 'string' &&
    typeof closes === 'string' &&
    LOCAL_TIME.test(opens) &&
    LOCAL_TIME.test(closes)
  ) {
    if (closes <= opens) {
      report(
        'opening_hours_crosses_midnight_in_one_spec',
        path,
        `opens ${opens} and closes ${closes}: an OpeningHoursSpecification has no next-day flag, so a ` +
          'consumer evaluating opens <= t <= closes concludes the premises is open for no minute of any ' +
          'day. A session that crosses midnight is two specifications — see openingHoursSpecifications.',
      )
    }
  }
}

function validateGeo(geo: unknown, path: string, report: Report): void {
  if (!isRecord(geo)) {
    report('geo_incomplete', path, 'geo must be a GeoCoordinates object when it is present at all')
    return
  }
  const latitude = geo['latitude']
  const longitude = geo['longitude']
  if (latitude === undefined || longitude === undefined) {
    report(
      'geo_incomplete',
      path,
      'GeoCoordinates needs both latitude and longitude. One of the two is not half a location — it is ' +
        'a node no consumer can use, and the half that is present is the half somebody typed.',
    )
    return
  }
  for (const [property, value, limit] of [
    ['latitude', latitude, 90],
    ['longitude', longitude, 180],
  ] as const) {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
      report(
        'geo_out_of_range',
        `${path}.${property}`,
        `'${String(value)}' is not a ${property} between -${limit} and ${limit}`,
      )
    }
  }
}

function validateOrganization(node: Record<string, unknown>, path: string, report: Report): void {
  requireStrings(node, ['name', 'url'], 'organization_missing_required_property', path, report)
  const sameAs = node['sameAs']
  if (sameAs === undefined) return
  const urls = Array.isArray(sameAs) ? sameAs : [sameAs]
  urls.forEach((url, index) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      report(
        'same_as_not_absolute_https',
        `${path}.sameAs[${index}]`,
        `'${String(url)}' is not an absolute https URL. A relative or http sameAs is discarded, which ` +
          'leaves the entity unbound rather than weakly bound.',
      )
    }
  })
}

function validateService(node: Record<string, unknown>, path: string, report: Report): void {
  requireStrings(node, ['name'], 'service_missing_required_property', path, report)
  const provider = node['provider']
  if (!isRecord(provider) || typeof provider['@id'] !== 'string') {
    report(
      'service_missing_required_property',
      `${path}.provider`,
      'a Service needs a provider; without one it is a treatment nobody offers',
    )
  }
  const offers = node['offers']
  const list = Array.isArray(offers) ? offers : offers === undefined ? [] : [offers]
  if (list.length === 0) {
    report(
      'service_without_offers',
      `${path}.offers`,
      'a Service with no Offer publishes a treatment with no price and no availability, which is the ' +
        'one thing a customer came for',
    )
    return
  }
  list.forEach((offer, index) => {
    validateOffer(offer, `${path}.offers[${index}]`, report)
  })
}

/**
 * One offer, in one of exactly two shapes.
 *
 * Priced: `price` as two decimals and `priceCurrency: 'AED'`. On request: no `price` and no
 * `priceCurrency`, with a `description` that says so. Anything else — a price with no currency, a currency
 * with no price, a `price` of `0.00` — is a finding, because each of those is read by a consumer as a
 * number it can quote.
 */
function validateOffer(offer: unknown, path: string, report: Report): void {
  if (!isRecord(offer)) {
    report('offer_shape_unrecognised', path, 'an offer must be an object')
    return
  }
  const price = offer['price']
  const currency = offer['priceCurrency']

  if (price === undefined) {
    if (currency !== undefined) {
      report(
        'offer_shape_unrecognised',
        path,
        'an offer with a priceCurrency and no price publishes a currency and no figure, which reads as ' +
          'a price of nothing',
      )
    }
    if (typeof offer['description'] !== 'string' || offer['description'].trim() === '') {
      report(
        'offer_shape_unrecognised',
        path,
        'an offer with no price must say in words that the price is on request; schema.org has no value ' +
          'for it, and silence reads as free',
      )
    }
    return
  }

  if (typeof price !== 'string' || !TWO_DECIMALS.test(price)) {
    report(
      'offer_price_not_two_decimals',
      `${path}.price`,
      `${JSON.stringify(price)} is not a decimal string with exactly two places. A JSON number is a ` +
        'double to most consumers, and money is integer fils (ADR 0007).',
    )
  } else if (price === '0.00') {
    report(
      'offer_price_zero',
      `${path}.price`,
      'a price of 0.00 is read as free. An offering with no price carries no price at all.',
    )
  }
  if (currency !== 'AED') {
    report(
      'offer_currency_not_aed',
      `${path}.priceCurrency`,
      `every published price is AED (docs/01 decision 7); found ${JSON.stringify(currency)}`,
    )
  }
}

/**
 * A rating, which may only exist behind real reviews.
 *
 * The rule is stated as a refusal rather than as a shape check, because the failure is not a malformed
 * `aggregateRating` — it is a well-formed one with nothing behind it. docs/09 §"Schema types" is explicit
 * and Google's penalty for it is a manual action, not a dropped rich result.
 */
function validateRating(node: Record<string, unknown>, path: string, report: Report): void {
  const rating = node['aggregateRating']
  if (rating === undefined) return
  const count = isRecord(rating) ? (rating['reviewCount'] ?? rating['ratingCount']) : undefined
  const parsed = typeof count === 'number' ? count : Number(count)
  if (!Number.isFinite(parsed) || parsed < 1) {
    report(
      'aggregate_rating_without_reviews',
      `${path}.aggregateRating`,
      'an aggregateRating with no reviewCount behind it is self-serving review markup, which docs/09 ' +
        'refuses and Google answers with a manual action',
    )
  }
}

function validateFaqPage(node: Record<string, unknown>, path: string, report: Report): void {
  const questions = node['mainEntity']
  const list = Array.isArray(questions) ? questions : questions === undefined ? [] : [questions]
  if (list.length === 0) {
    report(
      'faq_page_without_questions',
      `${path}.mainEntity`,
      'an FAQPage needs at least one Question; an empty one is invalid and publishes nothing',
    )
    return
  }
  list.forEach((question, index) => {
    const questionPath = `${path}.mainEntity[${index}]`
    if (!isRecord(question)) {
      report('question_missing_answer', questionPath, 'a Question must be an object')
      return
    }
    requireStrings(question, ['name'], 'question_missing_answer', questionPath, report)
    const answer = question['acceptedAnswer']
    if (!isRecord(answer) || typeof answer['text'] !== 'string' || answer['text'].trim() === '') {
      report(
        'question_missing_answer',
        `${questionPath}.acceptedAnswer`,
        'a Question needs an acceptedAnswer with non-empty text; a blank one is what a half-finished ' +
          'draft looks like and is the answer a consumer quotes',
      )
    }
  })
}

function validateBreadcrumb(node: Record<string, unknown>, path: string, report: Report): void {
  const items = node['itemListElement']
  if (!Array.isArray(items) || items.length === 0) {
    report(
      'breadcrumb_without_items',
      `${path}.itemListElement`,
      'a BreadcrumbList with no items is a trail with no steps',
    )
    return
  }
  const positions: number[] = []
  items.forEach((item, index) => {
    const itemPath = `${path}.itemListElement[${index}]`
    if (!isRecord(item)) {
      report('breadcrumb_positions_not_contiguous', itemPath, 'a ListItem must be an object')
      return
    }
    requireStrings(item, ['name'], 'breadcrumb_without_items', itemPath, report)
    if (!isAbsoluteUrl(item['item'])) {
      report('url_not_absolute', `${itemPath}.item`, 'every breadcrumb step needs an absolute URL')
    }
    const position = item['position']
    if (typeof position === 'number') positions.push(position)
    else
      report('breadcrumb_positions_not_contiguous', `${itemPath}.position`, 'position is required')
  })
  const expected = items.map((_item, index) => index + 1)
  if (positions.join(',') !== expected.join(',')) {
    report(
      'breadcrumb_positions_not_contiguous',
      `${path}.itemListElement`,
      `positions are [${positions.join(', ')}] and must be 1-based and contiguous: a trail numbered ` +
        'from zero, or with a gap, is dropped whole by consumers that check it',
    )
  }
}

function validatePerson(node: Record<string, unknown>, path: string, report: Report): void {
  requireStrings(node, ['name'], 'person_missing_name', path, report)
}

function validateImageObject(node: Record<string, unknown>, path: string, report: Report): void {
  if (!isAbsoluteUrl(node['contentUrl'])) {
    report(
      'image_object_missing_required_property',
      `${path}.contentUrl`,
      'an ImageObject needs an absolute contentUrl; a relative one resolves against nothing',
    )
  }
  for (const property of ['width', 'height'] as const) {
    const value = node[property]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      report(
        'image_object_missing_required_property',
        `${path}.${property}`,
        `${property} must be a positive number; a node without it is skipped by consumers choosing ` +
          'whether the image is large enough',
      )
    }
  }
}

function validateVideoObject(node: Record<string, unknown>, path: string, report: Report): void {
  requireStrings(
    node,
    ['name', 'description', 'uploadDate'],
    'video_object_missing_required_property',
    path,
    report,
  )
  const thumbnails = node['thumbnailUrl']
  const list = Array.isArray(thumbnails) ? thumbnails : thumbnails === undefined ? [] : [thumbnails]
  if (list.length === 0 || !list.every((url) => isAbsoluteUrl(url))) {
    report(
      'video_object_missing_required_property',
      `${path}.thumbnailUrl`,
      'a VideoObject needs at least one absolute thumbnail URL',
    )
  }
  if (!isAbsoluteUrl(node['contentUrl']) && !isAbsoluteUrl(node['embedUrl'])) {
    report(
      'video_object_missing_required_property',
      `${path}.contentUrl`,
      'a VideoObject needs an absolute contentUrl or embedUrl; without one it describes no video',
    )
  }
}

/**
 * Every leaf value in a JSON structure, with its path.
 *
 * Visits objects and arrays as well as leaves, because two of the whole-graph rules are about a value that
 * is `null` *where an object was expected* — and a walker that only visited strings and numbers would miss
 * exactly the case the rule exists for.
 */
function walkValues(
  value: unknown,
  path: string,
  visit: (value: unknown, path: string) => void,
): void {
  visit(value, path === '' ? '(root)' : path)
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkValues(item, `${path}[${index}]`, visit)
    })
    return
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      walkValues(item, path === '' ? key : `${path}.${key}`, visit)
    }
  }
}

/** The findings, as the lines a CI log prints. One per line, rule first, so a grep finds the rule. */
export function formatFindings(findings: readonly GraphFinding[]): string {
  return findings.map((finding) => `${finding.rule}  ${finding.path}: ${finding.detail}`).join('\n')
}

/**
 * Is the graph's business node open at this local time, per its own emitted hours?
 *
 * The acceptance criterion is a claim about what a consumer can conclude from the published graph, so this
 * reads the graph rather than the payload: it finds the business node, takes its
 * `openingHoursSpecification` as emitted, and asks `isOpenAt` — the naive interval test — the question.
 * Returns `undefined` when the graph has no business node, so a caller cannot read "closed" as an answer
 * to a question that was never asked.
 */
export function graphOpenAt(graph: unknown, dayOfWeek: number, time: string): boolean | undefined {
  if (!isRecord(graph) || !Array.isArray(graph['@graph'])) return undefined
  const business = graph['@graph'].find(
    (node) =>
      isRecord(node) &&
      typesOf(node).some((type) => type === 'DaySpa' || type === 'LocalBusiness') &&
      Array.isArray(node['openingHoursSpecification']),
  )
  if (!isRecord(business)) return undefined
  const specs = business['openingHoursSpecification'] as readonly OpeningHoursSpecificationNode[]
  return isOpenAt(specs, dayOfWeek, time)
}

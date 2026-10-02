import { buildStructuredDataGraph, serialiseGraph } from '../jsonld/graph.ts'
import { specimenGraphs } from '../jsonld/specimen.ts'
import type { LicenceClass } from '../jsonld/vocabulary.ts'
import type { StructuredDataRule } from '../structured-data-validate.ts'

/**
 * Known-bad pages for the site-side structured-data validator, each naming the rule it must trip.
 *
 * ADR 0003 is about a gate's fixture; this is the same argument one layer in, and the acceptance criterion
 * names the three pages: *a DaySpa block missing OpeningHoursSpecification, a MedicalClinic type the
 * regulatory profile does not permit, and an AggregateRating built from the site's own testimonials.*
 *
 * ## Why each page is DERIVED from the specimen graph rather than written out
 *
 * A hand-written JSON-LD fixture is a second copy of the graph the builders emit. It would pass this
 * validator for ever while the real graph drifted away from it, which is the exact shape of the defect
 * `reply-linter.fixtures/`'s header describes: a rule stops firing because something it depends on moved,
 * and nothing in the file that proves the rule changed.
 *
 * So every page here is `serialiseGraph(buildStructuredDataGraph(...))` with **one declared mutation**, and
 * {@link KNOWN_BAD_PAGES} carries the mutation as a function so a reader can see what was changed and a
 * test can assert that removing the mutation makes the page clean. That last part is the control the
 * brief's rule 3 asks for and {@link CLEAN_PAGE} is it: the unmutated specimen, which must produce **no**
 * findings. Without it three passing refusals are consistent with a validator that refuses everything.
 *
 * ## No invented value anywhere
 *
 * The specimen's own values are used throughout — `SPECIMEN WELLNESS LLC`, `1 Specimen Road`,
 * `+97120000000`. They are visibly specimens rather than plausible facts, which is why `specimen.ts`
 * exists and why brief rule 15 is satisfied by using them rather than by writing something that looks
 * like this business's address.
 */

/** The JSON-LD of one specimen graph, as a string, before any mutation. */
function specimenJsonLd(which: number): { readonly json: string; readonly licence: LicenceClass } {
  const specimen = specimenGraphs()[which]
  if (specimen === undefined) {
    throw new Error(
      `specimenGraphs() has fewer than ${which + 1} entries, so this fixture is built from nothing. ` +
        'The specimen set changed; fix the index rather than the expectation.',
    )
  }
  return {
    json: serialiseGraph(buildStructuredDataGraph(specimen.input)),
    licence: specimen.licence,
  }
}

/**
 * A page serving one JSON-LD block.
 *
 * Minimal, and that is deliberate: the validator's job is to find the block in a document, and a fixture
 * padded out with a realistic page would make a failure ambiguous between the scanner and the rules. The
 * second `<script>` with another type is there on purpose — it is what the scanner must NOT parse, and
 * without it `jsonLdBlocks`' type test could be deleted and every fixture would still pass.
 */
export function pageServing(json: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<script type="application/json">{"notStructuredData":true}</script>',
    `<script type="application/ld+json">${json}</script>`,
    '</head><body><h1>Specimen</h1></body></html>',
  ].join('\n')
}

/** One deliberately broken page, and the rule it must be refused by. */
export interface KnownBadPage {
  readonly id: string
  readonly rule: StructuredDataRule
  /** Why this page is the one worth having, in a sentence. Read by a person, not by a matcher. */
  readonly why: string
  /** The licence class in force when the page is judged. */
  readonly licence: LicenceClass
  /** The HTML, built from the specimen with exactly one mutation. */
  readonly html: string
  /**
   * How many reviews are evidenced outside the site when this page is judged.
   *
   * Zero for every page but the rating one, which is the build's real answer (ADR 0005, no Business
   * Profile API access). It is a field rather than a constant because the rating fixture is the one whose
   * verdict depends on it, and a reader has to be able to see that.
   */
  readonly evidencedReviewCount: number
}

/**
 * The fully populated specimen under the seeded licence class, which is the clean control.
 *
 * Index 0 of `specimenGraphs()`: every node type populated, so the validator is exercised against a graph
 * that has something for every rule to look at. Index 2 — the graph shaped like the real database — would
 * pass too, and would pass with almost nothing in it.
 */
const CLEAN = specimenJsonLd(0)

/** The control. Must produce zero findings; see the header. */
export const CLEAN_PAGE: {
  readonly html: string
  readonly licence: LicenceClass
  readonly evidencedReviewCount: number
} = Object.freeze({
  html: pageServing(CLEAN.json),
  licence: CLEAN.licence,
  evidencedReviewCount: 0,
})

/**
 * Removes the business node's `openingHoursSpecification` and nothing else.
 *
 * A JSON edit on the serialised graph rather than a builder option, because there is no builder option
 * that can do it — `openingHoursSpecifications` always returns a set — and that is the point: the page
 * being tested is one a hand edit, a CMS field or a template regression could produce, which is the only
 * way this markup ever becomes wrong in practice.
 */
function withoutOpeningHours(json: string): string {
  const graph = JSON.parse(json) as { '@graph': Record<string, unknown>[] }
  const business = graph['@graph'].find((node) => {
    const types = node['@type']
    return Array.isArray(types) ? types.includes('DaySpa') : types === 'DaySpa'
  })
  if (business === undefined || business['openingHoursSpecification'] === undefined) {
    throw new Error(
      'the specimen graph has no DaySpa node carrying openingHoursSpecification, so this fixture ' +
        'removes nothing and the case that uses it proves nothing. The builders changed.',
    )
  }
  delete business['openingHoursSpecification']
  return JSON.stringify(graph)
}

/** Adds `MedicalClinic` to the business node's type list. The claim the licence does not permit. */
function withMedicalClinicType(json: string): string {
  const graph = JSON.parse(json) as { '@graph': Record<string, unknown>[] }
  const business = graph['@graph'].find((node) => {
    const types = node['@type']
    return Array.isArray(types) ? types.includes('DaySpa') : types === 'DaySpa'
  })
  if (business === undefined) {
    throw new Error('the specimen graph has no DaySpa node, so this fixture mutates nothing.')
  }
  const types = business['@type']
  business['@type'] = Array.isArray(types) ? [...types, 'MedicalClinic'] : [types, 'MedicalClinic']
  return JSON.stringify(graph)
}

/**
 * Hangs a well-formed `aggregateRating` off the Organization node.
 *
 * Fourteen, with a `reviewCount`, which is what a testimonial block on the site produces — and the whole
 * reason this rule exists rather than `aggregate_rating_without_reviews` being considered enough. It is
 * attached to the **Organization** and not to the business, because that is the placement that survives a
 * review of the business node.
 */
function withTestimonialRating(json: string): string {
  const graph = JSON.parse(json) as { '@graph': Record<string, unknown>[] }
  const organization = graph['@graph'].find((node) => {
    const types = node['@type']
    return Array.isArray(types) ? types.includes('Organization') : types === 'Organization'
  })
  if (organization === undefined) {
    throw new Error('the specimen graph has no Organization node, so this fixture mutates nothing.')
  }
  organization['aggregateRating'] = {
    '@type': 'AggregateRating',
    ratingValue: '4.90',
    reviewCount: 14,
  }
  return JSON.stringify(graph)
}

export const KNOWN_BAD_PAGES: readonly KnownBadPage[] = Object.freeze([
  {
    id: 'dayspa_without_opening_hours',
    rule: 'opening_hours_missing_required_property',
    why:
      'a day spa that takes bookings and publishes no hours reads as unknown, and an assistant asked ' +
      '"are they open" answers an unknown as closed.',
    licence: CLEAN.licence,
    html: pageServing(withoutOpeningHours(CLEAN.json)),
    evidencedReviewCount: 0,
  },
  {
    id: 'medical_clinic_outside_the_licence',
    rule: 'medical_vocabulary_outside_healthcare',
    why:
      'docs/09: claiming MedicalClinic without a licence classification that supports it is a compliance ' +
      'problem rather than an SEO tactic, and `regulatory_profile.licence_class` is unconfirmed ' +
      '(Y1-licence), which resolves to the stricter vocabulary (ADR 0020).',
    licence: CLEAN.licence,
    html: pageServing(withMedicalClinicType(CLEAN.json)),
    evidencedReviewCount: 0,
  },
  {
    id: 'aggregate_rating_from_own_testimonials',
    rule: 'aggregate_rating_not_evidenced',
    why:
      "a rating built from the site's own testimonials is VALID markup with a well-formed reviewCount, " +
      'so the graph validator passes it; what refuses it is that nothing outside this site evidences ' +
      'the count — and there is no Business Profile API access in this build (ADR 0005), so the ' +
      'evidenced count is zero.',
    licence: CLEAN.licence,
    html: pageServing(withTestimonialRating(CLEAN.json)),
    evidencedReviewCount: 0,
  },
])

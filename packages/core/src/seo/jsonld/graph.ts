/**
 * One page's graph, assembled.
 *
 * Every JSON-LD block this site serves comes out of {@link buildStructuredDataGraph}. That is the whole
 * claim of the acceptance criterion — *"zero hand-written `application/ld+json` string literals; every
 * JSON-LD block on every registry route is produced by a builder function"* — and the reason it is one
 * function rather than a convention is that a convention cannot be crawled. The integration suite fetches
 * each route, parses each block out of the HTML and matches it against this function's output for the same
 * route; a block nobody built has nothing to match.
 *
 * ## The order of the nodes, and why it is fixed
 *
 * Organization, business, services, people, FAQ, breadcrumb, media. Fixed so the emitted JSON is a
 * function of the data alone: two renders of the same row produce byte-identical blocks, which is what lets
 * a test compare them and a reviewer read a diff. An order that depended on which optional nodes were
 * present would make every addition look like a rewrite.
 *
 * ## Why the licence class is an argument
 *
 * `packages/core` may not read a database, and `regulatory_profile.licence_class` is a row. It arrives here
 * and `assertVocabularyPermitted` refuses the finished graph if any medical term reached it — from a type,
 * from a service name, from a CMS description. Under the seeded profile (`unconfirmed`) that is every path.
 */

import type { Facts } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import {
  areaServedNodes,
  businessId,
  localBusinessNode,
  organizationId,
  organizationNode,
  type SameAsProfile,
} from './business.ts'
import {
  type BreadcrumbStep,
  breadcrumbListNode,
  type FaqEntry,
  faqPageNode,
  type HeroImage,
  type HeroVideo,
  imageObjectNode,
  type PersonNodesOptions,
  personNodesFor,
  type TherapistCandidate,
  videoObjectNode,
} from './content.ts'
import { offerIdsIn, serviceNodes } from './offerings.ts'
import { SCHEMA_CONTEXT, type SiteNode, type StructuredDataGraph } from './types.ts'
import { assertVocabularyPermitted, type LicenceClass } from './vocabulary.ts'

export interface StructuredDataInput {
  /** The fact sheet: `readPremisesFacts` composed and parsed. The only source of NAP and prices. */
  readonly facts: Facts
  /** The canonical URL of the page this graph is served on, absolute. */
  readonly pageUrl: string
  /** The site origin. `@id`s hang off it, so every node's identity survives a path change. */
  readonly origin: string
  readonly licence: LicenceClass
  /**
   * Whether to publish the treatment menu on this page.
   *
   * A flag rather than "always", because a `Service` node on every page of the site would put 11 services
   * and 35 offers into every document — which is not more information, it is the same information a
   * consumer has to reconcile eleven times, and it makes the page's own subject harder to identify.
   */
  readonly includeCatalogue: boolean
  /** Candidates for a `Person` node. Every one is filtered by ADR 0020's publishing guard. */
  readonly therapists?: readonly TherapistCandidate[]
  /** `faq_entries` rows, answers already flattened to text. */
  readonly faq?: readonly FaqEntry[]
  /** The trail. Fewer than two steps emits nothing — see `breadcrumbListNode`. */
  readonly breadcrumb?: readonly BreadcrumbStep[]
  /** The hero photograph, when one is served. `null` today. */
  readonly heroImage?: HeroImage | null
  /** The hero video, when one exists. `null` today. */
  readonly heroVideo?: HeroVideo | null
  /** Profiles that are the same entity, for `Organization.sameAs`. The origin is added for you. */
  readonly sameAsProfiles?: readonly SameAsProfile[]
  /** Builds a treatment page URL from a slug, once W-SITE-05 has added the route. */
  readonly serviceUrlFor?: (slug: string) => string
  /**
   * The slugs this page is about, or absent for the whole menu.
   *
   * W-SITE-05's treatment page passes its own slug: its subject is one treatment, and eight `Service`
   * nodes on it would be the same reconciliation problem `includeCatalogue` exists to avoid, repeated on
   * nine documents. The index and `/pricing` pass nothing. See `serviceNodes`.
   */
  readonly serviceSlugs?: readonly string[]
}

/**
 * The graph for one page.
 *
 * Throws rather than returning a partial graph. Every throw in here is a fact the page cannot be rendered
 * without — no telephone, a medical term under a non-healthcare licence, a price that will not survive a
 * round trip — and a page that swallowed one would publish a document missing the property that was wrong.
 * `readFactsForPage` is where fail-soft belongs: it returns `null` for an unseeded database and the caller
 * renders no block at all, which is the honest state.
 */
export function buildStructuredDataGraph(input: StructuredDataInput): StructuredDataGraph {
  if (!input.pageUrl.startsWith(input.origin)) {
    throw new AppError(
      'validation',
      `pageUrl '${input.pageUrl}' is not under origin '${input.origin}'. Every @id in the graph hangs off ` +
        'the origin, so a mismatch publishes a node identified by a host the page is not served from.',
    )
  }

  const nodes: SiteNode[] = []

  const organization = organizationNode(input.facts, {
    origin: input.origin,
    ...(input.sameAsProfiles !== undefined ? { profiles: input.sameAsProfiles } : {}),
  })

  const services = input.includeCatalogue
    ? serviceNodes(input.facts, {
        origin: input.origin,
        licence: input.licence,
        providerId: businessId(input.origin),
        areaServed: areaServedNodes(input.facts),
        ...(input.serviceUrlFor !== undefined ? { urlFor: input.serviceUrlFor } : {}),
        ...(input.serviceSlugs !== undefined ? { onlySlugs: input.serviceSlugs } : {}),
      })
    : []

  const business = localBusinessNode(input.facts, {
    url: input.pageUrl,
    origin: input.origin,
    licence: input.licence,
    // `makesOffer` references the offers in this graph by `@id` rather than repeating them. A second copy
    // of 32 offers in one document is 32 chances for the two to disagree after an edit.
    ...(services.length > 0 ? { offerIds: offerIdsIn(services) } : {}),
  })

  nodes.push(organization, business, ...services)

  const personOptions: PersonNodesOptions = {
    origin: input.origin,
    licence: input.licence,
    organizationId: organizationId(input.origin),
  }
  nodes.push(...personNodesFor(input.therapists ?? [], personOptions))

  const faq = faqPageNode(input.faq ?? [], { url: input.pageUrl })
  if (faq !== undefined) nodes.push(faq)

  const breadcrumb = breadcrumbListNode(input.breadcrumb ?? [], { url: input.pageUrl })
  if (breadcrumb !== undefined) nodes.push(breadcrumb)

  const image = imageObjectNode(input.heroImage ?? null, { url: input.pageUrl })
  if (image !== undefined) nodes.push(image)

  const video = videoObjectNode(input.heroVideo ?? null, { url: input.pageUrl })
  if (video !== undefined) nodes.push(video)

  const graph: StructuredDataGraph = { '@context': SCHEMA_CONTEXT, '@graph': nodes }

  // The last gate before the graph leaves this package. It walks the finished document — not the type
  // lists — so a medical term that arrived as a service name or a CMS description is refused too.
  assertVocabularyPermitted(graph, input.licence)

  return graph
}

/**
 * The graph as the bytes that go inside the `<script>` element.
 *
 * `JSON.stringify` with no indentation: this is a machine-readable payload inside a document a person
 * downloads, and pretty-printing 35 offers costs bytes on every request for nothing a reader will see.
 *
 * `<` is escaped to its JSON `\u003c` form. This is the one genuinely dangerous character: a value containing
 * `</script>` would close the element early and the rest of the JSON would become document markup. React's
 * `dangerouslySetInnerHTML` does no escaping, and every value in this graph comes from a database row or a
 * CMS field that a person can type into. `&` and `>` are escaped with it because the same three characters
 * are what an HTML parser acts on, and escaping one of three invites the argument about which.
 *
 * The escapes are valid JSON string escapes, so a consumer's `JSON.parse` returns the original characters.
 */
export function serialiseGraph(graph: StructuredDataGraph): string {
  return JSON.stringify(graph)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

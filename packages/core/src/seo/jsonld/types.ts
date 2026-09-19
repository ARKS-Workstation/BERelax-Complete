/**
 * The JSON-LD vocabulary this site emits, as types.
 *
 * ## Why concrete interfaces and not one loose bag
 *
 * A JSON-LD node is a JSON object, so `Record<string, unknown>` would model it perfectly and catch
 * nothing. The failure mode here is not a wrong type — it is a **misspelled or invented property**:
 * `openingHours` instead of `openingHoursSpecification`, `priceCurrancy`, `geoCoordinates` instead of
 * `geo`. Google ignores an unknown property silently, so the symptom of a typo is a rich result that
 * never appears and a log that says nothing. Named interfaces make those a compile error.
 *
 * ## Why the validator does NOT use them
 *
 * `validateGraph` takes `unknown`. It has to: one of its callers parses a
 * `<script type="application/ld+json">` block out of a rendered page, and what a page actually served
 * is the only thing worth validating. A validator typed against these interfaces would be asserting
 * that the builders agree with themselves.
 *
 * ## The one thing no interface here has
 *
 * An optional property whose value may be `null`. Every field is either present with a value or absent.
 * A `"geo": null` in a published graph is a claim about the business, and `"latitude": null` is worse —
 * a consumer that checks for the key finds it. The builders omit instead, by conditional spread, and
 * {@link NO_NULLS_RULE} is asserted over the whole graph.
 */

/** The only `@context` this site emits. `http://schema.org` and the versioned contexts are not it. */
export const SCHEMA_CONTEXT = 'https://schema.org'

/** Every rule the graph validator can report, by name. A finding names one of these. */
export const GRAPH_RULES = [
  'context_missing',
  'node_without_type',
  'duplicate_node_id',
  'null_property',
  'placeholder_property',
  'medical_vocabulary_outside_healthcare',
  'business_missing_required_property',
  'address_missing_required_property',
  'geo_incomplete',
  'geo_out_of_range',
  'opening_hours_missing_required_property',
  'opening_hours_crosses_midnight_in_one_spec',
  'opening_hours_malformed_time',
  'organization_missing_required_property',
  'same_as_not_absolute_https',
  'service_without_offers',
  'service_missing_required_property',
  'offer_shape_unrecognised',
  'offer_price_not_two_decimals',
  'offer_price_zero',
  'offer_currency_not_aed',
  'aggregate_rating_without_reviews',
  'question_missing_answer',
  'faq_page_without_questions',
  'breadcrumb_positions_not_contiguous',
  'breadcrumb_without_items',
  'person_missing_name',
  'image_object_missing_required_property',
  'video_object_missing_required_property',
  'url_not_absolute',
] as const
export type GraphRule = (typeof GRAPH_RULES)[number]

/** The rule a `null` anywhere in the graph reports. Named because several assertions quote it. */
export const NO_NULLS_RULE: GraphRule = 'null_property'

/**
 * A postal address, as schema.org spells it.
 *
 * Every field comes from a `premises` column and none is composed here. The building reference and the
 * sector code live in `address_line_2`, for which schema.org has no property, so they ride along in
 * `streetAddress` — see `postalAddressNode`. Nothing is `null`: an absent column is an absent property.
 */
export interface PostalAddressNode {
  readonly '@type': 'PostalAddress'
  readonly streetAddress: string
  /** The district. `premises.area`, never an alias — the aliases are `areaServed`. */
  readonly addressLocality: string
  /** The emirate. `premises.emirate`. */
  readonly addressRegion: string
  /** ISO 3166-1 alpha-2, from `premises.country_code`. */
  readonly addressCountry: string
  readonly postOfficeBoxNumber?: string
}

/**
 * A coordinate pair, emitted only when the row holds both.
 *
 * `latitude` and `longitude` are `numeric(9,6)` and cross every boundary in this repository as
 * **strings** so nothing rounds them (see `readPremisesFacts`). They stay strings here: schema.org
 * accepts `Text` for both, and a coordinate parsed to a float and re-serialised is a pin that has moved
 * for no reason anybody can point at.
 */
export interface GeoCoordinatesNode {
  readonly '@type': 'GeoCoordinates'
  readonly latitude: string
  readonly longitude: string
}

/**
 * One window of opening hours. Never crosses midnight — see `openingHoursSpecifications`.
 *
 * `dayOfWeek` is an array even for one day, because a consumer that has to handle both a bare string and
 * an array handles one of them, and that is the one it was tested against.
 */
export interface OpeningHoursSpecificationNode {
  readonly '@type': 'OpeningHoursSpecification'
  readonly dayOfWeek: readonly string[]
  /** `HH:MM`, local to the premises timezone. */
  readonly opens: string
  readonly closes: string
}

/** A place the business serves: the district, each of its other names, and the emirate. */
export interface PlaceNode {
  readonly '@type': 'Place' | 'AdministrativeArea'
  readonly name: string
}

export interface ContactPointNode {
  readonly '@type': 'ContactPoint'
  readonly telephone: string
  readonly contactType: string
}

/**
 * The primary node: the premises as a business.
 *
 * `@type` is an array because the licence class decides it (`businessTypesFor`) and because a
 * one-element array and a bare string are the same thing to a JSON-LD processor while only one of them
 * has one shape in the code.
 */
export interface LocalBusinessNode {
  readonly '@type': readonly string[]
  readonly '@id': string
  readonly name: string
  readonly legalName: string
  readonly url: string
  readonly address: PostalAddressNode
  readonly telephone: string
  readonly openingHoursSpecification: readonly OpeningHoursSpecificationNode[]
  readonly areaServed: readonly PlaceNode[]
  readonly currenciesAccepted: string
  readonly parentOrganization: { readonly '@id': string }
  /** Emitted only when `premises` holds both coordinates. Absent today — docs/13 states none. */
  readonly geo?: GeoCoordinatesNode
  /** Emitted only for a second stored number. */
  readonly contactPoint?: readonly ContactPointNode[]
  readonly email?: string
  readonly hasMap?: string
  readonly makesOffer?: readonly { readonly '@id': string }[]
  readonly description?: string
}

/** The entity, bound by `sameAs` to every profile that is the same entity. */
export interface OrganizationNode {
  readonly '@type': 'Organization'
  readonly '@id': string
  readonly name: string
  readonly legalName: string
  readonly url: string
  readonly address: PostalAddressNode
  readonly sameAs: readonly string[]
  readonly telephone?: string
}

export interface QuantitativeValueNode {
  readonly '@type': 'QuantitativeValue'
  readonly value: number
  readonly unitCode: 'MIN'
}

export interface PricedOfferNode {
  readonly '@type': 'Offer'
  readonly '@id': string
  readonly name: string
  /** Two decimals, from the money helper. Never a JSON number: see `pricedOfferFor`. */
  readonly price: string
  readonly priceCurrency: 'AED'
  readonly valueAddedTaxIncluded: true
  readonly availability: string
  readonly itemOffered: { readonly '@id': string }
  readonly eligibleDuration: QuantitativeValueNode
}

export interface PriceOnRequestOfferNode {
  readonly '@type': 'Offer'
  readonly '@id': string
  readonly name: string
  readonly availability: string
  readonly itemOffered: { readonly '@id': string }
  /** Says in words that the price is not published, because schema.org has no value for it. */
  readonly description: string
}

/**
 * A priced offer, or one whose price nobody has set.
 *
 * Two shapes, discriminated by the presence of `price`. There is deliberately no third shape carrying
 * `price: '0.00'`: three offerings in docs/13 §4 have no price column at all (0032), and zero is the one
 * value a consumer reads as "free" and quotes to a customer.
 */
export type OfferNode = PricedOfferNode | PriceOnRequestOfferNode

export interface ServiceNode {
  readonly '@type': readonly string[]
  readonly '@id': string
  readonly name: string
  readonly serviceType: string
  readonly provider: { readonly '@id': string }
  readonly areaServed: readonly PlaceNode[]
  readonly offers: readonly OfferNode[]
  readonly url?: string
}

export interface PersonNode {
  readonly '@type': readonly string[]
  readonly '@id': string
  readonly name: string
  readonly worksFor: { readonly '@id': string }
  readonly knowsAbout?: readonly string[]
  readonly knowsLanguage?: readonly string[]
  readonly jobTitle?: string
  readonly image?: string
  readonly url?: string
}

export interface AnswerNode {
  readonly '@type': 'Answer'
  readonly text: string
}

export interface QuestionNode {
  readonly '@type': 'Question'
  readonly name: string
  readonly acceptedAnswer: AnswerNode
}

export interface FaqPageNode {
  readonly '@type': 'FAQPage'
  readonly '@id': string
  readonly mainEntity: readonly QuestionNode[]
}

export interface ListItemNode {
  readonly '@type': 'ListItem'
  readonly position: number
  readonly name: string
  readonly item: string
}

export interface BreadcrumbListNode {
  readonly '@type': 'BreadcrumbList'
  readonly '@id': string
  readonly itemListElement: readonly ListItemNode[]
}

export interface ImageObjectNode {
  readonly '@type': 'ImageObject'
  readonly '@id': string
  readonly contentUrl: string
  readonly url: string
  readonly width: number
  readonly height: number
  readonly caption: string
  readonly representativeOfPage?: boolean
}

export interface VideoObjectNode {
  readonly '@type': 'VideoObject'
  readonly '@id': string
  readonly name: string
  readonly description: string
  readonly thumbnailUrl: readonly string[]
  /** ISO 8601 date. A `VideoObject` without one is discarded by every consumer that reads them. */
  readonly uploadDate: string
  readonly contentUrl: string
  readonly embedUrl?: string
  readonly duration?: string
}

/** Every node this site can put in a graph. */
export type SiteNode =
  | LocalBusinessNode
  | OrganizationNode
  | ServiceNode
  | PersonNode
  | FaqPageNode
  | BreadcrumbListNode
  | ImageObjectNode
  | VideoObjectNode

/**
 * A page's structured data: one `@context`, one `@graph`.
 *
 * One graph per page rather than several sibling `<script>` blocks, and the reason is `@id`. Nodes in one
 * graph reference each other by it — a `Service`'s `provider` is the business node, a `Person`'s
 * `worksFor` is the organization — and a consumer reading two separate blocks is entitled to treat them
 * as two unrelated documents. A cross-block reference is the commonest way a correct-looking set of
 * blocks describes nothing.
 */
export interface StructuredDataGraph {
  readonly '@context': typeof SCHEMA_CONTEXT
  readonly '@graph': readonly SiteNode[]
}

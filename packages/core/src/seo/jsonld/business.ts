/**
 * The business node, its address, its hours, its geography and the `Organization` behind it.
 *
 * Everything here is built from the `/api/facts` payload — `factsSchema` in `@berelax/shared`, which is
 * `readPremisesFacts` composed and then *parsed* before anything reads it. That is deliberate and it is
 * the central design decision of this module.
 *
 * ## Why the input is the fact sheet and not the row
 *
 * docs/09 §4: *"one source of truth. No hard-coded address in a template, no hand-written schema block."*
 * A `LocalBusiness` node with a typed address is precisely where a second spelling of the street would
 * go, and `packages/db/src/seed/premises.test.ts` greps the whole repository for exactly that. Taking the
 * already-parsed payload means this module cannot restate a value even by accident: there is no literal
 * here to restate it with, and the grep gate has nothing to find.
 *
 * It also means the two published surfaces cannot disagree. `/api/facts` and the JSON-LD are the two
 * documents an assistant will read, and docs/09 §4 names their disagreement as the failure mode:
 * *"Divergence between the site, the schema and GBP is precisely what makes AI assistants state wrong
 * hours and prices with total confidence."* One payload, two renderings.
 *
 * ## What is deliberately not emitted
 *
 * **`geo`.** `premises.latitude` and `premises.longitude` are NULL because docs/13 states no coordinate
 * (see the seed). A `GeoCoordinates` node with a plausible pair is structured-data spam and puts a map pin
 * on the wrong building, and nothing on the page would say it was a guess. {@link geoNode} returns
 * `undefined` for a null pair and the property is omitted, not set to `null`.
 *
 * **`aggregateRating` and `review`.** There are no reviews in the database and docs/09 §"Schema types" is
 * explicit: *"Google's rules on self-serving review markup are strict — surface genuine reviews, do not
 * mark up your own testimonials as review snippets."* An invented rating is the single most common cause
 * of a structured-data manual action. There is no builder for either, which is the strongest form the
 * decision can take: nothing to call.
 *
 * **`priceRange`.** A `$$`-style band is an opinion, not a row. The real price grid is published as
 * `Offer` nodes with the actual figures, which is strictly more information.
 *
 * **A WhatsApp number.** `contact.whatsapp`'s unanswered branch types the number as `z.null()`
 * (Y1-nap), so there is nothing to put in `telephone` or `sameAs`, and this module never looks at the
 * candidates. See {@link telephoneOf}.
 */

import type { Facts, FactsOpeningHoursDay, FactsPhone } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import type {
  ContactPointNode,
  GeoCoordinatesNode,
  LocalBusinessNode,
  OpeningHoursSpecificationNode,
  OrganizationNode,
  PlaceNode,
  PostalAddressNode,
} from './types.ts'
import { businessTypesFor, type LicenceClass } from './vocabulary.ts'

/**
 * `dayOfWeek` values, indexed by `premises_hours.day_of_week` (0 = Sunday).
 *
 * The bare day names rather than `https://schema.org/Monday`. Both are valid and Google's own examples use
 * the bare form; the absolute form is longer and gives a consumer a second spelling to normalise.
 */
export const SCHEMA_DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/** The last minute of a calendar day, as schema.org expresses it. See {@link openingHoursSpecifications}. */
export const END_OF_DAY = '23:59'
export const START_OF_DAY = '00:00'

/** The `availability` every offer carries: the premises takes bookings. */
export const IN_STOCK = 'https://schema.org/InStock'

/**
 * The address, from the payload's address block.
 *
 * `address_line_2` holds the building reference and the sector code merged into one column (see
 * `addressLines` in `@berelax/shared`), and schema.org's `PostalAddress` has no property for either. They
 * are appended to `streetAddress` rather than dropped: a geocoder and a reader both need the building to
 * find the door, and a `PostalAddress` missing it resolves to the street. `floor` rides along for the same
 * reason — this business is on an intermediate floor of a two-block tower, and the floor is how the premises
 * is found once inside it.
 *
 * The country is the two-letter code as stored. schema.org accepts either the code or the name, and the
 * code is what the row holds; expanding it here would invent a spelling of the country name that nothing
 * else in the system uses.
 */
export function postalAddressNode(facts: Facts): PostalAddressNode {
  const street = [facts.address.line1, facts.address.line2, facts.address.floor]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ')
  return {
    '@type': 'PostalAddress',
    streetAddress: street,
    addressLocality: facts.address.area,
    addressRegion: facts.address.emirate,
    addressCountry: facts.address.countryCode,
    // Conditional spread rather than `postOfficeBoxNumber: facts.address.poBox`: the column is NULL
    // (docs/13 states none) and a `"postOfficeBoxNumber": null` is a published claim about the business.
    ...(facts.address.poBox !== null ? { postOfficeBoxNumber: facts.address.poBox } : {}),
  }
}

/**
 * The coordinate pair, or `undefined` when the row holds neither.
 *
 * Both or nothing. A `GeoCoordinates` with one of the two is not half a location — it is a node a consumer
 * cannot use and Google reports as invalid, and the half that is present is the half somebody typed.
 *
 * The strings are carried across unchanged. They arrive as `numeric(9,6)` rendered by PostgreSQL and
 * `'24.490000'` and `24.49` are the same coordinate to six decimal places only if nothing reformats them;
 * the cheapest way to keep that true is to not touch them.
 */
export function geoNode(facts: Facts): GeoCoordinatesNode | undefined {
  const { latitude, longitude } = facts.geo
  if (latitude === null || longitude === null) return undefined
  return { '@type': 'GeoCoordinates', latitude, longitude }
}

/**
 * The district, its other names, and the emirate — as places, from the row.
 *
 * docs/09 §4 lists `areaServed` as a derived output of the premises row, and docs/09 §"The brand
 * collision" says why every name of the district has to appear: `berelax.com` is an international
 * airport-spa chain with an outlet in the same city, and this district is known by three names in this
 * market — a machine that knows only one of them cannot match a query using another to this business. The
 * aliases are derived from `area` by `areaAliasesFor` in the seed and arrive in the payload; none of the
 * three is spelled here, and `packages/db/src/seed/premises.test.ts` greps this file to keep it that way.
 *
 * The emirate is an `AdministrativeArea` and the districts are `Place`s, because the emirate genuinely is
 * an administrative division and a district of it is not. `AdministrativeArea` is a subtype of `Place`, so
 * a consumer that only understands the general type still reads all of them.
 */
export function areaServedNodes(facts: Facts): readonly PlaceNode[] {
  return [
    { '@type': 'Place', name: facts.address.area },
    ...facts.address.areaAliases.map((alias): PlaceNode => ({ '@type': 'Place', name: alias })),
    { '@type': 'AdministrativeArea', name: facts.address.emirate },
  ]
}

/**
 * The opening hours, as specifications that never cross midnight.
 *
 * ## The decision, and the failure it avoids
 *
 * Trading runs 11:00–02:00 (docs/13 §2), so the close is **less** than the open and `premises_hours`
 * records that in a generated column, `crosses_midnight` — which reaches this function as
 * `closesNextDay`, read and never recomputed.
 *
 * `OpeningHoursSpecification` has no next-day flag. A single spec reading `opens: 11:00, closes: 02:00` is
 * therefore not merely ambiguous, it is **false to the only reader that matters**: a consumer evaluating
 * `opens <= t <= closes` concludes the premises is open for no minute of any day, and an assistant
 * answering "are they open now?" at 01:30 says no. That is the specific defect this function exists to
 * avoid, and it is the one implementations get wrong.
 *
 * So a midnight-crossing session is emitted as **two** specifications: the opening day from `opens` to
 * `23:59`, and the following day from `00:00` to the closing time. Any naive interval test is then correct
 * on both halves — 01:30 falls inside the second, 03:00 inside neither — which is what the acceptance
 * criterion asks a validator to be able to decide.
 *
 * The one-minute seam at `23:59` is the cost, and it is the convention rather than an oversight:
 * `closes: '24:00'` is not accepted by every consumer, and a business is not open at 23:59:30 in any sense
 * a customer can act on. `isOpenAt` below reads the emitted specs, so the seam is measured rather than
 * assumed.
 *
 * ## Why identical windows are grouped
 *
 * All seven days trade the same hours, so an ungrouped result is fourteen specs saying two things. They are
 * grouped by `(opens, closes)` in day order, which is how schema.org's own examples are written and how a
 * `dayOfWeek` array is meant to be used. A closed day contributes nothing at all: an
 * `OpeningHoursSpecification` with no `opens` is how a closed day is *sometimes* expressed and it is
 * ignored by consumers that require both, so the absence of the day is the clearer statement.
 */
export function openingHoursSpecifications(
  weekly: readonly FactsOpeningHoursDay[],
): readonly OpeningHoursSpecificationNode[] {
  /** `(opens, closes)` -> the day indices trading those hours, in the order first seen. */
  const windows = new Map<string, { opens: string; closes: string; days: number[] }>()
  const addWindow = (opens: string, closes: string, day: number): void => {
    const key = `${opens}-${closes}`
    const existing = windows.get(key)
    if (existing === undefined) windows.set(key, { opens, closes, days: [day] })
    else existing.days.push(day)
  }

  for (const day of weekly) {
    if (day.isClosed) continue
    if (day.closesNextDay) {
      addWindow(day.opens, END_OF_DAY, day.dayOfWeek)
      // The next calendar day, which is the day the session actually ends on. `% 7` rather than a
      // conditional: Saturday's session ends on Sunday, and a week that did not wrap would drop the one
      // segment that spans the week boundary — the commonest off-by-one in this whole area.
      addWindow(START_OF_DAY, day.closes, (day.dayOfWeek + 1) % 7)
      continue
    }
    addWindow(day.opens, day.closes, day.dayOfWeek)
  }

  return [...windows.values()].map((window) => ({
    '@type': 'OpeningHoursSpecification',
    // Sorted so the array reads Sunday-first like the source rows, rather than in the order the
    // midnight-crossing segments happened to be appended.
    dayOfWeek: [...window.days].sort((a, b) => a - b).map((day) => SCHEMA_DAY_NAMES[day] ?? ''),
    opens: window.opens,
    closes: window.closes,
  }))
}

/**
 * Is the premises open at `time` on `dayOfWeek`, according to the emitted specifications?
 *
 * The reader half of {@link openingHoursSpecifications}, and the reason it exists is that the acceptance
 * criterion is a claim about what a consumer can conclude — *"01:30 is inside it and 03:00 is not"* — not
 * about what the builder wrote. This is the naive interval test on purpose: `opens <= t <= closes`, string
 * comparison on zero-padded `HH:MM`, no next-day flag and no knowledge of the business. If the emitted
 * specs are right, the naive reader is right, which is the whole claim.
 *
 * Exported because both the unit tests and the graph validator use it, and a second implementation of the
 * comparison would be a second thing to be wrong.
 */
export function isOpenAt(
  specs: readonly OpeningHoursSpecificationNode[],
  dayOfWeek: number,
  time: string,
): boolean {
  const name = SCHEMA_DAY_NAMES[dayOfWeek]
  if (name === undefined) return false
  return specs.some(
    (spec) => spec.dayOfWeek.includes(name) && spec.opens <= time && time <= spec.closes,
  )
}

/**
 * The number a consumer should dial, and the second number as a contact point.
 *
 * The landline first, then the mobile, because the landline is the desk and both sources in docs/13 §3
 * agree on it. Throws when the payload carries neither: a `LocalBusiness` with no telephone is missing the
 * one property a customer acts on, and silently omitting it would publish a business nobody can reach
 * while every test about the node still passed.
 *
 * WhatsApp is not consulted at all, not even as a fallback. `contact.whatsapp` is a discriminated union
 * whose unanswered branch types the number as `z.null()` (Y1-nap): there is no digit in the payload to
 * fall back to, and the two candidates docs/13 §3 records are in the seed for the admin panel, not for a
 * published document. A `telephone` a customer cannot reach is worse than a missing one.
 */
export function telephoneOf(facts: Facts): { primary: string; others: readonly FactsPhone[] } {
  const ordered = [facts.contact.landline, facts.contact.mobile].filter(
    (phone): phone is FactsPhone => phone !== null,
  )
  const primary = ordered[0]
  if (primary === undefined) {
    throw new AppError(
      'invariant_violated',
      'The premises row holds no landline and no mobile, so there is no telephone to publish in the ' +
        'business node. A LocalBusiness without one is a business a customer cannot reach, and the ' +
        'WhatsApp column is a placeholder is_placeholder_text() refuses (Y1-nap) — it is not a fallback.',
    )
  }
  return { primary: primary.e164, others: ordered.slice(1) }
}

export interface BusinessNodeOptions {
  /** The canonical URL of the page this graph is served on. */
  readonly url: string
  /** The site origin, which is the `Organization`'s own URL and the `@id` prefix. */
  readonly origin: string
  readonly licence: LicenceClass
  /** The `@id`s of the `Offer` nodes in the same graph, so `makesOffer` is a reference and not a copy. */
  readonly offerIds?: readonly string[]
}

/** The `@id` of the one business node, which every other node references. */
export function businessId(origin: string): string {
  return `${origin}/#business`
}

/** The `@id` of the one organization node. */
export function organizationId(origin: string): string {
  return `${origin}/#organization`
}

/**
 * The `DaySpa`, from the payload.
 *
 * `legalName` is the registered entity from `legal_entity` and `name` is the display name from `premises`.
 * Both, because they are different facts and a citation checks one against the other: docs/09 §"The brand
 * collision" wants the **full** trading name everywhere, and a tax document wants the registered one.
 *
 * `hasMap` is the map link the NAP block and `/api/facts` already publish, derived by
 * `mapLinkFor` in `@berelax/shared` — the same URL, not a second one built here.
 */
export function localBusinessNode(facts: Facts, options: BusinessNodeOptions): LocalBusinessNode {
  const { primary, others } = telephoneOf(facts)
  const geo = geoNode(facts)
  const contactPoints = others.map(
    (phone): ContactPointNode => ({
      '@type': 'ContactPoint',
      telephone: phone.e164,
      contactType: 'reservations',
    }),
  )
  return {
    '@type': businessTypesFor(options.licence),
    '@id': businessId(options.origin),
    name: facts.names.display,
    legalName: facts.names.legal,
    url: options.url,
    address: postalAddressNode(facts),
    telephone: primary,
    openingHoursSpecification: openingHoursSpecifications(facts.hours.weekly),
    areaServed: areaServedNodes(facts),
    // `currenciesAccepted` rather than `priceRange`: the currency is a fact from the catalogue, a price
    // band is an opinion, and the real figures are published as Offer nodes below.
    currenciesAccepted: facts.catalogue.currency,
    parentOrganization: { '@id': organizationId(options.origin) },
    ...(geo !== undefined ? { geo } : {}),
    ...(contactPoints.length > 0 ? { contactPoint: contactPoints } : {}),
    ...(facts.contact.email !== null ? { email: facts.contact.email } : {}),
    hasMap: facts.geo.mapUrl,
    ...(options.offerIds !== undefined && options.offerIds.length > 0
      ? { makesOffer: options.offerIds.map((id) => ({ '@id': id })) }
      : {}),
  }
}

/**
 * One profile that is this same entity somewhere else.
 *
 * `kind` exists so that an absent profile can be *named* rather than merely missing: docs/09 §"The brand
 * collision" asks for `sameAs` binding "site, GBP, TripAdvisor and socials into one entity", and
 * {@link SAME_AS_UNANSWERED} says which of those has no URL and which open question holds it.
 */
export interface SameAsProfile {
  readonly kind: SameAsKind
  readonly url: string
}

export const SAME_AS_KINDS = [
  'site',
  'google_business_profile',
  'tripadvisor',
  'instagram',
  'facebook',
] as const
export type SameAsKind = (typeof SAME_AS_KINDS)[number]

/**
 * The profiles docs/09 asks `sameAs` to bind, and why each one has no URL yet.
 *
 * Published as data rather than as a comment because it is the honest answer to an acceptance criterion
 * this build cannot fully satisfy, and because the alternative is the failure the brief's rule 15
 * describes: a plausible TripAdvisor URL in a published graph is indistinguishable from a confirmed one,
 * and a `sameAs` pointing at the wrong listing binds this business to somebody else's entity — which is
 * precisely the collision with the airport-spa chain that `sameAs` is here to prevent.
 *
 * `site` is absent from this list because the site URL is known: it is the origin, and
 * {@link organizationNode} always includes it.
 */
export const SAME_AS_UNANSWERED: readonly {
  readonly kind: SameAsKind
  readonly openQuestionId: string
  readonly why: string
}[] = Object.freeze([
  {
    kind: 'google_business_profile',
    openQuestionId: 'Y2-gbp-status',
    why:
      'docs/13 §6 records the Google Business Profile status as unknown, so there is no verified listing ' +
      'URL and no place_id. A sameAs pointing at an unclaimed or wrong listing binds this entity to it.',
  },
  {
    kind: 'tripadvisor',
    openQuestionId: 'Y1-profiles',
    why:
      'docs/13 §6 records that a TripAdvisor listing exists for this business but gives no URL, and ' +
      'there are several similarly named spas in the same city.',
  },
  {
    kind: 'instagram',
    openQuestionId: 'Y1-profiles',
    why: 'no social profile URL is published by either web property (docs/13 §6).',
  },
  {
    kind: 'facebook',
    openQuestionId: 'Y1-profiles',
    why: 'no social profile URL is published by either web property (docs/13 §6).',
  },
])

/**
 * The entity, with every profile that is the same entity.
 *
 * `sameAs` is sorted and de-duplicated, and every URL must be absolute `https`. A relative or `http` URL
 * in `sameAs` is not a weaker statement of identity — it is discarded, and the entity stays two entities.
 *
 * The site's own origin is always the first entry. That is not a formality here: it is what tells a machine
 * that the `Organization` in this graph and the domain it was fetched from are one thing, which is the
 * minimum a disambiguation claim needs.
 */
export function organizationNode(
  facts: Facts,
  options: { readonly origin: string; readonly profiles?: readonly SameAsProfile[] },
): OrganizationNode {
  const urls = [options.origin, ...(options.profiles ?? []).map((profile) => profile.url)]
  for (const url of urls) {
    if (!url.startsWith('https://')) {
      throw new AppError(
        'validation',
        `sameAs must be an absolute https URL, received '${url}'. A relative or http URL is discarded ` +
          'by consumers, which leaves the entity unbound rather than weakly bound.',
        { details: { rule: 'same_as_not_absolute_https', url } },
      )
    }
  }
  const { primary } = telephoneOf(facts)
  return {
    '@type': 'Organization',
    '@id': organizationId(options.origin),
    name: facts.names.display,
    legalName: facts.names.legal,
    url: options.origin,
    address: postalAddressNode(facts),
    sameAs: [...new Set(urls)].sort(),
    telephone: primary,
  }
}

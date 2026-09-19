/**
 * `Service` and `Offer`, from the published price grid.
 *
 * Eight services × four durations = the 32 price points docs/13 §4 lists, all of them seeded by B-CAT-06
 * and all of them reaching this module through `factsSchema`'s catalogue block. Plus the three offerings
 * that have **no price column at all** (0032): Four Hands, Couple Massage and Full Body Shaving.
 *
 * ## Why a duration is an `Offer` and not a `Service`
 *
 * A 60-minute hot oil massage and a 90-minute hot oil massage are one treatment at two prices, not two
 * treatments. Modelling each duration as its own `Service` would publish 32 services, every one of them a
 * near-duplicate of three others, and would tell a consumer this business offers thirty-two different
 * things. `eligibleDuration` is what schema.org has for exactly this, and it is what makes the price grid
 * legible: one `Service` per `(style × treatment)` pair, four `Offer`s hanging off it.
 *
 * ## Why the price is a string
 *
 * `price` is `'200.00'`, never `200`. The reason is the one `factsSchema` gives for the same field: a JSON
 * number is a `double` to most consumers, and the whole purpose of publishing the figure is that a third
 * party quotes it correctly. Two decimals always, from {@link grossPriceString}, which is the money helper
 * and nothing else — `toDecimalString` is the same function the ledger and the tax documents use.
 *
 * ## Why a float cannot get in
 *
 * {@link pricedOfferFor} takes `Money`, and `Money` carries `Fils`, which is a branded integer. There is no
 * overload taking a number. `aed(1.5)` does not compile — `IntegerLiteral` refuses a fractional literal —
 * and neither does passing a bare `200.5`, because it is not a `Money`. The only runtime door is `aedFrom`
 * (or `filsFromStoredDigits`), which asserts an integer rather than rounding to one.
 *
 * `offerings.test.ts` pins the two compile-time refusals with `@ts-expect-error` and the runtime one with an
 * assertion on the thrown message, so a widened signature fails `pnpm typecheck` with `TS2578` — an unused
 * directive — rather than quietly accepting a rounded price. `scripts/test-gates.mjs` performs that widening
 * and asserts the typechecker refuses the tree.
 */

import type { Facts } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import { filsFromStoredDigits, type Money, money, toDecimalString } from '../../money.ts'
import { IN_STOCK } from './business.ts'
import type {
  OfferNode,
  PlaceNode,
  PricedOfferNode,
  PriceOnRequestOfferNode,
  QuantitativeValueNode,
  ServiceNode,
} from './types.ts'
import { type LicenceClass, serviceTypesFor } from './vocabulary.ts'

/**
 * The gross figure as schema.org wants it: two decimals, no grouping, no currency symbol.
 *
 * `toDecimalString` rather than `formatMoney`: `formatMoney` produces `AED 200.00` and
 * `formatAmount` produces `1,200.00`, and both are display strings. A grouping separator in a `price` is
 * parsed as a different number or as nothing at all, depending on the consumer — which is a wrong price
 * quoted with total confidence, the failure docs/09 §"LLM SEO" names.
 */
export function grossPriceString(price: Money): string {
  if (price.currency !== 'AED') {
    throw new AppError(
      'invariant_violated',
      `Every published price is AED (docs/01 decision 7); received ${price.currency}.`,
    )
  }
  return toDecimalString(price)
}

/**
 * The stored gross fils, as `Money`.
 *
 * The one runtime door into a published price, and it asserts an integer: `filsFromStoredDigits` refuses
 * anything that does not survive a round trip through a JavaScript number. Everything downstream of here
 * carries `Fils`, which is why {@link pricedOfferFor} cannot be handed a float.
 */
export function grossMoneyFromFils(grossFils: string): Money {
  return money(filsFromStoredDigits(grossFils, 'gross_price_fils'))
}

/** The duration, as the unit a consumer can compare. `MIN` is UN/CEFACT for a minute. */
export function durationValue(minutes: number): QuantitativeValueNode {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new AppError(
      'validation',
      `A treatment duration is a positive whole number of minutes; received ${minutes}.`,
    )
  }
  return { '@type': 'QuantitativeValue', value: minutes, unitCode: 'MIN' }
}

export interface OfferIdentity {
  readonly origin: string
  readonly slug: string
}

/** The `@id` of one service, stable across renders and referenced by every offer on it. */
export function serviceId(identity: OfferIdentity): string {
  return `${identity.origin}/#service-${identity.slug}`
}

/** The `@id` of one price point. The duration is in it, because it is what distinguishes them. */
export function offerId(identity: OfferIdentity, minutes: number): string {
  return `${serviceId(identity)}-${minutes}`
}

/** The `@id` of an offering with no price. No duration, because `price_on_request` records none. */
export function priceOnRequestOfferId(identity: OfferIdentity): string {
  return `${serviceId(identity)}-on-request`
}

export interface PricedOfferInput extends OfferIdentity {
  readonly serviceName: string
  readonly durationMinutes: number
  /**
   * The gross, VAT-inclusive amount.
   *
   * `Money` and not a number, which is the compile-time half of ADR 0007 in this module. See the header.
   */
  readonly price: Money
}

/**
 * One price point.
 *
 * `valueAddedTaxIncluded: true` is stated rather than implied. Every price in this system is
 * VAT-inclusive gross (docs/01 decision 7), and a consumer that assumes otherwise adds 5% to a figure the
 * business is legally obliged to honour — which is a wrong price published under the business's own name.
 */
export function pricedOfferFor(input: PricedOfferInput): PricedOfferNode {
  const price = grossPriceString(input.price)
  if (price === '0.00') {
    throw new AppError(
      'invariant_violated',
      `'${input.serviceName}' would publish a price of 0.00, which every consumer reads as free. An ` +
        'offering with no price is published through priceOnRequestOfferFor, which carries no price at all.',
      { details: { rule: 'offer_price_zero', slug: input.slug } },
    )
  }
  return {
    '@type': 'Offer',
    '@id': offerId(input, input.durationMinutes),
    name: `${input.serviceName} — ${input.durationMinutes} minutes`,
    price,
    priceCurrency: 'AED',
    valueAddedTaxIncluded: true,
    availability: IN_STOCK,
    itemOffered: { '@id': serviceId(input) },
    eligibleDuration: durationValue(input.durationMinutes),
  }
}

/**
 * An offering whose price nobody has set.
 *
 * Three of these exist (docs/13 §4, Y9-poa-prices) and `price_on_request` is a table with no price column,
 * so there is nothing to render. The node therefore carries **no `price` and no `priceCurrency`** and says
 * in words that the price is on request.
 *
 * The alternatives are all worse. Omitting the offering makes the menu look shorter than it is, and an
 * assistant asked about a couple's massage answers "not offered" instead of "priced on request". A
 * `price: '0.00'` reads as free. A derived figure — 1.8× the single-therapist equivalent, which an earlier
 * revision proposed — would be quoted, taken at the till and printed on a tax invoice with nothing marking
 * it as a guess; B-CAT-06 reversed exactly that, and this is the published end of the same decision.
 */
export function priceOnRequestOfferFor(input: {
  readonly origin: string
  readonly slug: string
  readonly label: string
  readonly requirement: string
}): PriceOnRequestOfferNode {
  return {
    '@type': 'Offer',
    '@id': priceOnRequestOfferId(input),
    name: input.label,
    availability: IN_STOCK,
    itemOffered: { '@id': serviceId(input) },
    description: `Price on request. ${input.requirement}`,
  }
}

export interface ServiceNodesOptions {
  readonly origin: string
  readonly licence: LicenceClass
  /** The business node's `@id`: the provider of every service. */
  readonly providerId: string
  readonly areaServed: readonly PlaceNode[]
  /** Builds the public URL of one service's page, when there is one. W-SITE-05 adds the route. */
  readonly urlFor?: (slug: string) => string
}

/**
 * Every published service, with every price point on it.
 *
 * Order is the payload's, which is the catalogue's `display_order` — the order the menu is printed in
 * (docs/13 §4). Re-sorting here would make the graph's order an opinion of this module's and put it out of
 * step with the page it describes.
 *
 * `serviceType` carries the style. Style is a property of the treatment and never of the person delivering
 * it (ADR 0021), which is also what B-CAT-05's compliance lexicon refuses in a public name — so it is
 * published as what it is, a way of working, against the treatment.
 */
export function serviceNodes(facts: Facts, options: ServiceNodesOptions): readonly ServiceNode[] {
  const nodes: ServiceNode[] = []

  for (const service of facts.catalogue.services) {
    const identity = { origin: options.origin, slug: service.slug }
    const offers = service.variants.map(
      (variant): OfferNode =>
        pricedOfferFor({
          ...identity,
          serviceName: service.name,
          durationMinutes: variant.durationMinutes,
          // The stored digits, through the one door that refuses a float. `variant.grossAed` is the same
          // figure already formatted, and reading it would make this module trust a string somebody else
          // rendered — the acceptance criterion asks for the price to come from the gross fils.
          price: grossMoneyFromFils(variant.grossFils),
        }),
    )
    nodes.push({
      '@type': serviceTypesFor(options.licence),
      '@id': serviceId(identity),
      name: service.name,
      serviceType: `${service.style} massage`,
      provider: { '@id': options.providerId },
      areaServed: options.areaServed,
      offers,
      ...(options.urlFor !== undefined ? { url: options.urlFor(service.slug) } : {}),
    })
  }

  for (const offering of facts.catalogue.onRequest) {
    const slug = slugifyLabel(offering.label)
    const identity = { origin: options.origin, slug }
    nodes.push({
      '@type': serviceTypesFor(options.licence),
      '@id': serviceId(identity),
      name: offering.label,
      // No style: `price_on_request` records the resource shape and the menu label, not a treatment style
      // (0032). Inventing one to fill the property would be a claim about the treatment.
      serviceType: 'Massage',
      provider: { '@id': options.providerId },
      areaServed: options.areaServed,
      offers: [priceOnRequestOfferFor({ origin: options.origin, slug, ...offering })],
    })
  }

  return nodes
}

/**
 * A menu label as a URL-safe fragment, for the `@id` of an offering that has no catalogue slug.
 *
 * `price_on_request` rows carry a `menu_label` and no slug, because they are not catalogue services —
 * answering Y9-poa-prices deletes the row and adds ordinary catalogue data, at which point the real slug
 * arrives with it. Derived rather than stored so there is no second column to keep in step for three rows.
 */
export function slugifyLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Every `Offer` `@id` in a set of services, for the business node's `makesOffer`. */
export function offerIdsIn(services: readonly ServiceNode[]): readonly string[] {
  return services.flatMap((service) => service.offers.map((offer) => offer['@id']))
}

/** Every price point in a set of services, flattened. Used by the property test over all 32 rows. */
export function pricedOffersIn(services: readonly ServiceNode[]): readonly PricedOfferNode[] {
  return services
    .flatMap((service) => service.offers)
    .filter((offer): offer is PricedOfferNode => 'price' in offer)
}

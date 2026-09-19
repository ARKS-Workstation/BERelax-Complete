import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { aed, aedFrom, filsFromStoredDigits, money, toDecimalString } from '../../money.ts'
import { areaServedNodes, businessId, IN_STOCK } from './business.ts'
import {
  durationValue,
  grossMoneyFromFils,
  grossPriceString,
  offerId,
  offerIdsIn,
  pricedOfferFor,
  pricedOffersIn,
  priceOnRequestOfferFor,
  serviceId,
  serviceNodes,
  slugifyLabel,
} from './offerings.ts'
import { SPECIMEN_ORIGIN, specimenFacts } from './specimen.ts'

const facts = specimenFacts()
const OPTIONS = {
  origin: SPECIMEN_ORIGIN,
  licence: 'unconfirmed' as const,
  providerId: businessId(SPECIMEN_ORIGIN),
  areaServed: areaServedNodes(facts),
}

describe('a price in a published graph is the catalogue row, through the money helper', () => {
  it('renders every price point with exactly two decimals — a property over all of them', () => {
    const offers = pricedOffersIn(serviceNodes(facts, OPTIONS))
    const rows = facts.catalogue.services.flatMap((service) =>
      service.variants.map((variant) => variant),
    )
    expect(offers).toHaveLength(rows.length)
    for (const offer of offers) {
      expect(offer.price, offer['@id']).toMatch(/^\d+\.\d{2}$/)
      expect(offer.priceCurrency).toBe('AED')
      expect(offer.valueAddedTaxIncluded).toBe(true)
    }
  })

  it('publishes the gross fils, not the payload’s pre-rendered string', () => {
    // The criterion says "price equal to the catalogue gross fils rendered through the money helper". The
    // builder reads `grossFils` and formats it; `grossAed` in the payload is the same figure rendered by
    // `buildFacts`, and reading that would make the graph trust a string somebody else produced.
    const offers = pricedOffersIn(serviceNodes(facts, OPTIONS))
    const expected = facts.catalogue.services.flatMap((service) =>
      service.variants.map((variant) => toDecimalString(grossMoneyFromFils(variant.grossFils))),
    )
    expect(offers.map((offer) => offer.price)).toEqual(expected)
    // And the two renderings agree, which is what makes `/api/facts` and the graph quotable against
    // each other — the divergence docs/09 §4 names as the cause of a confident wrong answer.
    const published = facts.catalogue.services.flatMap((service) =>
      service.variants.map((variant) => variant.grossAed),
    )
    expect(offers.map((offer) => offer.price)).toEqual(published)
  })

  it('is a property of every integer fils figure, not of the seeded ones', () => {
    // A property test over the whole domain: whatever the stored digits, the published price has two decimal
    // places and parses back to the same number of fils. The seeded 32 rows are eight values repeated.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 99_999_999 }), (fils) => {
        const price = grossPriceString(
          money(filsFromStoredDigits(String(fils), 'gross_price_fils')),
        )
        expect(price).toMatch(/^\d+\.\d{2}$/)
        expect(Math.round(Number(price) * 100)).toBe(fils)
      }),
      { numRuns: 300 },
    )
  })

  it('never renders a grouping separator, which a consumer parses as a different number', () => {
    // `formatAmount` would produce `1,200.00` and `formatMoney` `AED 1,200.00`. Both are display strings and
    // both are wrong in a `price`.
    expect(grossPriceString(aed(1200))).toBe('1200.00')
    expect(grossPriceString(aedFrom(12_345))).toBe('12345.00')
  })

  it('refuses a currency that is not AED', () => {
    // The union has one member, so this is unreachable through the types — asserted anyway, because the
    // runtime check is what protects the day a second currency is added and a default is chosen for it.
    const foreign = { fils: money(filsFromStoredDigits('100', 'x')).fils, currency: 'USD' }
    expect(() => grossPriceString(foreign as never)).toThrow(/docs\/01 decision 7/)
  })

  it('refuses stored digits that would not survive a round trip through a number', () => {
    for (const bad of ['0200', '1e3', '9007199254740993', '12.5', '']) {
      expect(() => grossMoneyFromFils(bad), bad).toThrow(/round trip/)
    }
  })

  it('refuses to publish a price of zero, which every consumer reads as free', () => {
    expect(() =>
      pricedOfferFor({
        origin: SPECIMEN_ORIGIN,
        slug: 'x',
        serviceName: 'Free massage',
        durationMinutes: 60,
        price: aed(0),
      }),
    ).toThrow(/reads as free/)
  })
})

describe('a price cannot be constructed from a float', () => {
  /**
   * `@ts-expect-error` rather than a note in a review checklist, because that is the durable form: if any of
   * these ever starts compiling, the directive becomes unused and `pnpm typecheck` fails with
   * `TS2578: Unused '@ts-expect-error' directive`. `scripts/test-gates.mjs` performs the mutation that proves
   * it — it widens `PricedOfferInput.price` to `number` and asserts the typechecker refuses the tree.
   */
  it('is a compile error, in all three spellings a caller would try', () => {
    const base = {
      origin: SPECIMEN_ORIGIN,
      slug: 'x',
      serviceName: 'Normal Massage',
      durationMinutes: 60,
    }
    expect(() =>
      pricedOfferFor({
        ...base,
        // @ts-expect-error — a bare number is not Money. Money carries branded integer Fils (ADR 0007), and
        // this is the door a rounded price would come through.
        price: 200.5,
      }),
    ).toThrow(/docs\/01 decision 7/)

    // @ts-expect-error — `aed()` takes an integer LITERAL: `${1.5}` is "1.5", which does not extend
    // `${bigint}`, so a fractional major-unit amount cannot be written.
    const bypassed = pricedOfferFor({ ...base, price: aed(1.5) })
    // And this is what the compile error protects against, stated rather than implied: had the type
    // permitted it, the published price would be 1.50 — a figure the catalogue never held, silently
    // rounded from 1.5 AED by the multiplication inside `aed`. Nothing at run time would have objected.
    expect(bypassed.price).toBe('1.50')

    // The runtime door, which is where a genuinely computed value has to come through: it asserts an
    // integer instead of rounding, so `aedFrom(200.5)` is refused rather than published as 200.50.
    expect(() => pricedOfferFor({ ...base, price: aedFrom(200.5) })).toThrow(/must be an integer/)
  })
})

describe('the three offerings with no price column', () => {
  it('publishes each one as an Offer carrying no price and no currency', () => {
    const nodes = serviceNodes(facts, OPTIONS)
    const onRequest = nodes.filter((node) => node.offers.some((offer) => !('price' in offer)))
    expect(onRequest).toHaveLength(facts.catalogue.onRequest.length)
    for (const node of onRequest) {
      const offer = node.offers[0]
      expect(offer).not.toHaveProperty('price')
      expect(offer).not.toHaveProperty('priceCurrency')
      // And it says so in words, because schema.org has no value for "price on request" and silence reads
      // as free.
      expect(offer && 'description' in offer ? offer.description : '').toMatch(/Price on request/)
      expect(offer?.availability).toBe(IN_STOCK)
    }
  })

  it('keeps the offering on the menu rather than omitting it', () => {
    // Omitting it would make the menu look shorter than it is, and an assistant asked about a couple's
    // massage would answer "not offered" instead of "priced on request".
    const names = serviceNodes(facts, OPTIONS).map((node) => node.name)
    for (const offering of facts.catalogue.onRequest) expect(names).toContain(offering.label)
  })

  it('carries the resource requirement the row states, and no derived figure', () => {
    const offering = facts.catalogue.onRequest[0]
    if (offering === undefined) throw new Error('the specimen has no price-on-request offering')
    const node = priceOnRequestOfferFor({
      origin: SPECIMEN_ORIGIN,
      slug: slugifyLabel(offering.label),
      label: offering.label,
      requirement: offering.requirement,
    })
    expect(node.description).toContain(offering.requirement)
    expect(JSON.stringify(node)).not.toMatch(/\d+\.\d{2}/)
  })

  it('gives an on-request offering a distinct @id from any priced one', () => {
    const identity = { origin: SPECIMEN_ORIGIN, slug: 'x' }
    const ids = new Set([
      offerId(identity, 45),
      offerId(identity, 60),
      priceOnRequestOfferFor({ ...identity, label: 'L', requirement: 'R' })['@id'],
    ])
    expect(ids.size).toBe(3)
  })
})

describe('the service node', () => {
  const nodes = serviceNodes(facts, OPTIONS)

  it('is one per (style x treatment) pair, not one per duration', () => {
    // 32 price points are 8 services at 4 durations. Publishing 32 services would tell a consumer this
    // business offers thirty-two different things, each a near-duplicate of three others.
    expect(nodes).toHaveLength(facts.catalogue.services.length + facts.catalogue.onRequest.length)
    for (const service of facts.catalogue.services) {
      const node = nodes.find((candidate) => candidate.name === service.name)
      expect(node?.offers).toHaveLength(service.variants.length)
    }
  })

  it('carries the duration as eligibleDuration in minutes', () => {
    const offers = pricedOffersIn(nodes)
    for (const offer of offers) {
      expect(offer.eligibleDuration.unitCode).toBe('MIN')
      expect(Number.isInteger(offer.eligibleDuration.value)).toBe(true)
    }
    expect(() => durationValue(0)).toThrow(/positive whole number/)
    expect(() => durationValue(60.5)).toThrow(/positive whole number/)
  })

  it('carries the style as serviceType and never as a type or a person', () => {
    // Style is a property of the treatment (ADR 0021). An `@type` of `ThaiMassage` is not a schema.org term,
    // and a style attached to a person is what B-CAT-05's lexicon refuses in a public name.
    for (const service of facts.catalogue.services) {
      const node = nodes.find((candidate) => candidate.name === service.name)
      expect(node?.serviceType).toBe(`${service.style} massage`)
      expect([...(node?.['@type'] ?? [])]).toEqual(['Service'])
    }
  })

  it('names the business as the provider, by @id rather than by a second copy of it', () => {
    for (const node of nodes) expect(node.provider).toEqual({ '@id': businessId(SPECIMEN_ORIGIN) })
  })

  it('publishes a url only when a route exists to publish', () => {
    expect(nodes[0]).not.toHaveProperty('url')
    const linked = serviceNodes(facts, {
      ...OPTIONS,
      urlFor: (slug) => `${SPECIMEN_ORIGIN}/treatments/${slug}`,
    })
    expect(linked[0]?.url).toBe(
      `${SPECIMEN_ORIGIN}/treatments/${facts.catalogue.services[0]?.slug ?? ''}`,
    )
  })

  it('keeps the catalogue’s own order, which is the order the menu is printed in', () => {
    expect(nodes.slice(0, facts.catalogue.services.length).map((node) => node.name)).toEqual(
      facts.catalogue.services.map((service) => service.name),
    )
  })

  it('hangs every @id off the origin and gives no two nodes the same one', () => {
    const ids = [...nodes.map((node) => node['@id']), ...offerIdsIn(nodes)]
    for (const id of ids) expect(id.startsWith(SPECIMEN_ORIGIN)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('adds MedicalTherapy only under a healthcare licence', () => {
    const wellness = serviceNodes(facts, OPTIONS)
    const healthcare = serviceNodes(facts, { ...OPTIONS, licence: 'healthcare' })
    expect(wellness.every((node) => !node['@type'].includes('MedicalTherapy'))).toBe(true)
    expect(healthcare.every((node) => node['@type'].includes('MedicalTherapy'))).toBe(true)
  })
})

describe('slugifyLabel', () => {
  it('derives a URL-safe fragment for a row that has no slug column', () => {
    expect(slugifyLabel('Four Hands Massage')).toBe('four-hands-massage')
    expect(slugifyLabel('  Couple Massage / Two rooms  ')).toBe('couple-massage-two-rooms')
    expect(slugifyLabel('Café Spécial')).toBe('cafe-special')
  })

  it('is stable, so an @id does not move between renders', () => {
    expect(serviceId({ origin: SPECIMEN_ORIGIN, slug: slugifyLabel('Four Hands') })).toBe(
      `${SPECIMEN_ORIGIN}/#service-four-hands`,
    )
  })
})

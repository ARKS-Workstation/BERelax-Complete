import { describe, expect, it } from 'vitest'
import {
  areaServedNodes,
  END_OF_DAY,
  geoNode,
  isOpenAt,
  localBusinessNode,
  openingHoursSpecifications,
  organizationNode,
  postalAddressNode,
  SAME_AS_KINDS,
  SAME_AS_UNANSWERED,
  SCHEMA_DAY_NAMES,
  START_OF_DAY,
  telephoneOf,
} from './business.ts'
import { SPECIMEN_CLOSES, SPECIMEN_OPENS, SPECIMEN_ORIGIN, specimenFacts } from './specimen.ts'

const OPTIONS = {
  url: `${SPECIMEN_ORIGIN}/`,
  origin: SPECIMEN_ORIGIN,
  licence: 'unconfirmed' as const,
}

describe('the address is the row, and only the row', () => {
  it('maps every stored line onto a schema.org property', () => {
    const facts = specimenFacts()
    const address = postalAddressNode(facts)
    expect(address.addressLocality).toBe(facts.address.area)
    expect(address.addressRegion).toBe(facts.address.emirate)
    expect(address.addressCountry).toBe(facts.address.countryCode)
    // `address_line_2` and `floor` have no schema.org property, and dropping them would publish an address
    // that resolves to the street rather than the door.
    expect(address.streetAddress).toContain(facts.address.line1)
    expect(address.streetAddress).toContain(facts.address.line2 as string)
    expect(address.streetAddress).toContain(facts.address.floor as string)
  })

  it('omits a PO box the row does not hold, rather than publishing null', () => {
    expect(postalAddressNode(specimenFacts())).not.toHaveProperty('postOfficeBoxNumber')
    // The control: when the column HAS a value it is published, so the omission above is about the null.
    const withBox = specimenFacts({
      address: { ...specimenFacts().address, poBox: 'PO Box 1' },
    })
    expect(postalAddressNode(withBox).postOfficeBoxNumber).toBe('PO Box 1')
  })

  it('drops a blank line rather than emitting a double comma', () => {
    const facts = specimenFacts()
    const blank = specimenFacts({ address: { ...facts.address, line2: '   ', floor: null } })
    expect(postalAddressNode(blank).streetAddress).toBe(facts.address.line1)
  })
})

describe('geo is emitted only when the row holds a coordinate', () => {
  it('is absent for the seeded row, which holds none', () => {
    // docs/13 states no coordinate, so `premises.latitude` and `longitude` are NULL. A plausible pair would
    // put a map pin on the wrong building and nothing on the page would say it was a guess.
    expect(geoNode(specimenFacts())).toBeUndefined()
    expect(localBusinessNode(specimenFacts(), OPTIONS)).not.toHaveProperty('geo')
  })

  it('carries the stored strings unchanged when both are present', () => {
    // The control, and it is the one that matters: "equal the premises row values" has to be checkable, so a
    // populated row must produce exactly those digits — not a float round trip of them.
    const facts = specimenFacts()
    const located = specimenFacts({
      geo: { ...facts.geo, latitude: '24.490123', longitude: '54.370987' },
    })
    expect(geoNode(located)).toEqual({
      '@type': 'GeoCoordinates',
      latitude: '24.490123',
      longitude: '54.370987',
    })
    expect(localBusinessNode(located, OPTIONS).geo?.latitude).toBe('24.490123')
  })

  it('emits nothing when only one of the pair is known', () => {
    const facts = specimenFacts()
    for (const half of [
      { latitude: '24.490123', longitude: null },
      { latitude: null, longitude: '54.370987' },
    ]) {
      expect(geoNode(specimenFacts({ geo: { ...facts.geo, ...half } }))).toBeUndefined()
    }
  })
})

describe('areaServed is the district, its other names and the emirate', () => {
  it('publishes every alias the row derives, because a query may use any of them', () => {
    const facts = specimenFacts()
    const names = areaServedNodes(facts).map((place) => place.name)
    expect(names).toContain(facts.address.area)
    for (const alias of facts.address.areaAliases) expect(names).toContain(alias)
    expect(names).toContain(facts.address.emirate)
  })

  it('types the emirate as an administrative area and the districts as places', () => {
    const nodes = areaServedNodes(specimenFacts())
    expect(nodes[0]?.['@type']).toBe('Place')
    expect(nodes.at(-1)?.['@type']).toBe('AdministrativeArea')
  })

  it('publishes no alias for an area the mapping does not know', () => {
    // The payload's `areaAliases` is derived by `areaAliasesFor`, which yields nothing for an unknown area —
    // so a business that moved publishes no aliases rather than the previous district's.
    const facts = specimenFacts()
    const moved = specimenFacts({ address: { ...facts.address, areaAliases: [] } })
    expect(areaServedNodes(moved).map((place) => place.name)).toEqual([
      facts.address.area,
      facts.address.emirate,
    ])
  })
})

describe('the opening hours, which is the thing implementations get wrong', () => {
  const specs = openingHoursSpecifications(specimenFacts().hours.weekly)

  it('never crosses midnight inside one specification', () => {
    // The rule the whole design rests on. `OpeningHoursSpecification` has no next-day flag, so a spec with
    // `closes < opens` makes a consumer evaluating `opens <= t <= closes` conclude the premises is open for
    // no minute of any day.
    for (const spec of specs) expect(spec.closes > spec.opens, JSON.stringify(spec)).toBe(true)
  })

  it('splits the session at midnight and groups identical windows', () => {
    // Seven days trading one window produces two specifications, not fourteen: the evening half and the
    // after-midnight half, each carrying all seven days.
    expect(specs).toHaveLength(2)
    const evening = specs.find((spec) => spec.opens === SPECIMEN_OPENS)
    const small = specs.find((spec) => spec.opens === START_OF_DAY)
    expect(evening?.closes).toBe(END_OF_DAY)
    expect(small?.closes).toBe(SPECIMEN_CLOSES)
    expect(evening?.dayOfWeek).toHaveLength(7)
    expect(small?.dayOfWeek).toHaveLength(7)
  })

  it('wraps the week, so Saturday night ends on Sunday', () => {
    const facts = specimenFacts()
    const saturdayOnly = openingHoursSpecifications([
      {
        dayOfWeek: 6,
        opens: SPECIMEN_OPENS,
        closes: SPECIMEN_CLOSES,
        closesNextDay: true,
        isClosed: false,
      },
    ])
    expect(saturdayOnly).toHaveLength(2)
    expect(saturdayOnly[0]?.dayOfWeek).toEqual(['Saturday'])
    // `% 7`, not `+ 1`: without the wrap the one segment that spans the week boundary is dropped.
    expect(saturdayOnly[1]?.dayOfWeek).toEqual(['Sunday'])
    expect(facts.hours.weekly).toHaveLength(7)
  })

  it('reads 01:30 as open and 03:00 as closed through the naive interval test', () => {
    // The acceptance criterion, and it is asserted through `isOpenAt` — plain `opens <= t <= closes` string
    // comparison, no next-day flag, no knowledge of the business. If the emitted specs are right, the naive
    // reader is right, which is the whole claim.
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      expect(isOpenAt(specs, day, '01:30'), `01:30 on day ${day}`).toBe(true)
      expect(isOpenAt(specs, day, SPECIMEN_OPENS), `open on day ${day}`).toBe(true)
      expect(isOpenAt(specs, day, '23:59'), `23:59 on day ${day}`).toBe(true)
      // 03:00 is the closing minute and is inside; 03:01 is not. The criterion's "03:00 is not" is about the
      // real 02:00 close, so the specimen's equivalent is one minute past its own close.
      expect(isOpenAt(specs, day, '03:01'), `03:01 on day ${day}`).toBe(false)
      expect(isOpenAt(specs, day, '11:59'), `11:59 on day ${day}`).toBe(false)
    }
  })

  it('reads every minute as closed if the session were emitted as one spec — the control', () => {
    // The deliberately wrong encoding, detected. This is what a naive builder produces and it is why the
    // split exists: not ambiguity, falsity.
    const wrong = [
      {
        '@type': 'OpeningHoursSpecification' as const,
        dayOfWeek: [...SCHEMA_DAY_NAMES],
        opens: SPECIMEN_OPENS,
        closes: SPECIMEN_CLOSES,
      },
    ]
    expect(isOpenAt(wrong, 1, '01:30')).toBe(false)
    expect(isOpenAt(wrong, 1, '13:00')).toBe(false)
  })

  it('omits a closed day entirely rather than emitting a spec with no hours', () => {
    const closed = openingHoursSpecifications([
      { dayOfWeek: 0, opens: '00:00', closes: '00:00', closesNextDay: false, isClosed: true },
      { dayOfWeek: 1, opens: '10:00', closes: '18:00', closesNextDay: false, isClosed: false },
    ])
    expect(closed).toHaveLength(1)
    expect(closed[0]?.dayOfWeek).toEqual(['Monday'])
  })

  it('leaves a window that does not cross midnight as one specification', () => {
    const daytime = openingHoursSpecifications([
      { dayOfWeek: 2, opens: '09:00', closes: '17:00', closesNextDay: false, isClosed: false },
    ])
    expect(daytime).toEqual([
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Tuesday'],
        opens: '09:00',
        closes: '17:00',
      },
    ])
  })

  it('answers false for a day index that is not a day', () => {
    expect(isOpenAt(specs, 7, '01:30')).toBe(false)
    expect(isOpenAt(specs, -1, '01:30')).toBe(false)
  })
})

describe('the telephone, and the number that is deliberately not there', () => {
  it('publishes the landline first and the mobile as a contact point', () => {
    const facts = specimenFacts()
    const node = localBusinessNode(facts, OPTIONS)
    expect(node.telephone).toBe(facts.contact.landline?.e164)
    expect(node.contactPoint?.[0]?.telephone).toBe(facts.contact.mobile?.e164)
  })

  it('never publishes a WhatsApp number, because the payload carries no digits to publish', () => {
    // `contact.whatsapp`'s unanswered branch types the number as `z.null()` (Y1-nap). The node must not
    // resurrect a candidate, and `telephone` and `sameAs` are the two fields that would.
    const facts = specimenFacts()
    const serialised = JSON.stringify([
      localBusinessNode(facts, OPTIONS),
      organizationNode(facts, { origin: SPECIMEN_ORIGIN }),
    ])
    expect(facts.contact.whatsapp.status).toBe('unconfirmed')
    expect(serialised).not.toContain('whatsapp')
    expect(serialised).not.toContain('Y1-nap')
  })

  it('falls back to the mobile when there is no landline', () => {
    const facts = specimenFacts()
    const mobileOnly = specimenFacts({ contact: { ...facts.contact, landline: null } })
    expect(telephoneOf(mobileOnly).primary).toBe(facts.contact.mobile?.e164)
    expect(telephoneOf(mobileOnly).others).toEqual([])
  })

  it('refuses to publish a business with no number at all', () => {
    const facts = specimenFacts()
    const unreachable = specimenFacts({
      contact: { ...facts.contact, landline: null, mobile: null },
    })
    expect(() => telephoneOf(unreachable)).toThrow(/no telephone to publish/)
    // And the reason, stated: the WhatsApp column is not a fallback.
    expect(() => telephoneOf(unreachable)).toThrow(/not a fallback/)
  })

  it('publishes an email only when the row holds one', () => {
    const facts = specimenFacts()
    expect(localBusinessNode(facts, OPTIONS)).not.toHaveProperty('email')
    const withEmail = specimenFacts({ contact: { ...facts.contact, email: 'desk@example.test' } })
    expect(localBusinessNode(withEmail, OPTIONS).email).toBe('desk@example.test')
  })
})

describe('the business node carries nothing the database does not hold', () => {
  const facts = specimenFacts()
  const node = localBusinessNode(facts, OPTIONS)

  it('states the display name and the registered name, which are different facts', () => {
    expect(node.name).toBe(facts.names.display)
    expect(node.legalName).toBe(facts.names.legal)
  })

  it('has no aggregateRating, no review and no priceRange', () => {
    // There are no reviews in the database, and docs/09 §"Schema types" refuses self-serving review markup
    // outright. There is no builder for either, which is the strongest form the decision takes.
    for (const invented of ['aggregateRating', 'review', 'priceRange', 'starRating']) {
      expect(node, invented).not.toHaveProperty(invented)
    }
    // `currenciesAccepted` is the fact that replaces the price band, and it comes from the catalogue.
    expect(node.currenciesAccepted).toBe(facts.catalogue.currency)
  })

  it('reuses the map link the fact sheet already publishes rather than building a second one', () => {
    expect(node.hasMap).toBe(facts.geo.mapUrl)
  })

  it('references the offers by @id instead of repeating them', () => {
    const withOffers = localBusinessNode(facts, {
      ...OPTIONS,
      offerIds: [`${SPECIMEN_ORIGIN}/#service-x-60`],
    })
    expect(withOffers.makesOffer).toEqual([{ '@id': `${SPECIMEN_ORIGIN}/#service-x-60` }])
    // Absent, not empty, when there are none: an empty array is a claim that the business offers nothing.
    expect(localBusinessNode(facts, { ...OPTIONS, offerIds: [] })).not.toHaveProperty('makesOffer')
  })
})

describe('Organization.sameAs binds the entity, and names what it cannot bind', () => {
  const facts = specimenFacts()

  it('always includes the site origin, which is the minimum a disambiguation claim needs', () => {
    expect([...organizationNode(facts, { origin: SPECIMEN_ORIGIN }).sameAs]).toEqual([
      SPECIMEN_ORIGIN,
    ])
  })

  it('adds recorded profiles, de-duplicated and sorted', () => {
    const node = organizationNode(facts, {
      origin: SPECIMEN_ORIGIN,
      profiles: [
        { kind: 'tripadvisor', url: `${SPECIMEN_ORIGIN}/b` },
        { kind: 'instagram', url: `${SPECIMEN_ORIGIN}/a` },
        { kind: 'facebook', url: `${SPECIMEN_ORIGIN}/a` },
      ],
    })
    expect([...node.sameAs]).toEqual([
      SPECIMEN_ORIGIN,
      `${SPECIMEN_ORIGIN}/a`,
      `${SPECIMEN_ORIGIN}/b`,
    ])
  })

  it('refuses a relative or http profile URL rather than publishing a claim nobody reads', () => {
    for (const bad of ['/listing', 'http://example.test/listing', 'example.test']) {
      expect(
        () =>
          organizationNode(facts, {
            origin: SPECIMEN_ORIGIN,
            profiles: [{ kind: 'tripadvisor', url: bad }],
          }),
        bad,
      ).toThrow(/absolute https/)
    }
  })

  it('names every profile it has no URL for, with the open question that holds it', () => {
    // The honest answer to an acceptance criterion this build cannot fully satisfy. A plausible TripAdvisor
    // URL would bind this entity to somebody else's listing, which is the exact collision sameAs prevents.
    const kinds = SAME_AS_UNANSWERED.map((entry) => entry.kind)
    expect(kinds).toContain('google_business_profile')
    expect(kinds).toContain('tripadvisor')
    expect(kinds).toContain('instagram')
    expect(kinds).toContain('facebook')
    // Every kind is either the site (always published) or unanswered. No third category.
    expect([...kinds, 'site'].sort()).toEqual([...SAME_AS_KINDS].sort())
    for (const entry of SAME_AS_UNANSWERED) {
      expect(entry.openQuestionId, entry.kind).toMatch(/^Y\d+[a-z]?-[a-z-]+$/)
      expect(entry.why.length, entry.kind).toBeGreaterThan(30)
      // And no entry smuggles a URL in as prose.
      expect(entry.why, entry.kind).not.toMatch(/https?:\/\//)
    }
  })

  it('carries the same address as the business node, from the same row', () => {
    expect(organizationNode(facts, { origin: SPECIMEN_ORIGIN }).address).toEqual(
      postalAddressNode(facts),
    )
  })
})

import { describe, expect, it } from 'vitest'
import {
  addressLines,
  addressOneLine,
  directionsLinkFor,
  formatUaePhone,
  type MapTarget,
  mapLinkFor,
  telLinkFor,
} from './premises-links.ts'

/**
 * The derivations every consumer of the premises row shares.
 *
 * None of the values here is the real business's: this file is scanned by the NAP grep in
 * `packages/db/src/seed/premises.test.ts` like any other, and a fixture spelling the real street would be a
 * second copy of it. What is under test is the *shape* of each derivation, which is independent of the row.
 */

const FIXTURE: MapTarget = {
  addressLine1: '1 Example Road',
  addressLine2: 'Block Q, Z99',
  floor: 'G-Floor',
  area: 'Example District',
  emirate: 'Example Emirate',
  countryCode: 'AE',
  googlePlaceId: null,
}

describe('the address, as lines and as one line', () => {
  it('orders the parts and leaves the country code to the map query', () => {
    expect([...addressLines(FIXTURE)]).toEqual([
      '1 Example Road',
      'Block Q, Z99',
      'G-Floor',
      'Example District',
      'Example Emirate',
    ])
    // The control: the one-line form is what a geocoder gets, and it DOES carry the country.
    expect(addressOneLine(FIXTURE)).toBe(
      '1 Example Road, Block Q, Z99, G-Floor, Example District, Example Emirate, AE',
    )
  })

  it('drops the parts the row does not hold, without leaving a gap', () => {
    // Four of the premises columns are nullable and three of them are NULL in the seeded row. A join that
    // did not filter would produce `1 Example Road, , , Example District` — an address with holes, which
    // reads to a geocoder as a different place.
    const sparse = { ...FIXTURE, addressLine2: null, floor: null }
    expect([...addressLines(sparse)]).toEqual([
      '1 Example Road',
      'Example District',
      'Example Emirate',
    ])
    expect(addressOneLine(sparse)).not.toContain(', ,')
  })

  it('treats a blank string as absent, because a cleared field is not a line', () => {
    expect([...addressLines({ ...FIXTURE, floor: '   ' })]).not.toContain('   ')
  })
})

describe('the map and directions links', () => {
  it('are two different URLs, each carrying the whole address', () => {
    const map = new URL(mapLinkFor(FIXTURE))
    const directions = new URL(directionsLinkFor(FIXTURE))
    expect(map.pathname).toBe('/maps/search/')
    expect(directions.pathname).toBe('/maps/dir/')
    expect(map.searchParams.get('query')).toBe(addressOneLine(FIXTURE))
    expect(directions.searchParams.get('destination')).toBe(addressOneLine(FIXTURE))
    // The control on "two different URLs": a directions link that was the map link with a label would
    // open the map, and the customer would still be standing on the Corniche.
    expect(map.pathname).not.toBe(directions.pathname)
    expect(directions.searchParams.get('query')).toBeNull()
    expect(map.searchParams.get('destination')).toBeNull()
  })

  it('escapes the address rather than pasting it into a query string', () => {
    // `Tower Block A/B` contains a slash and every address here contains spaces. A hand-built URL is how a
    // map link ends up truncated at the first space, which looks like a wrong pin rather than a bad link.
    const link = mapLinkFor({ ...FIXTURE, addressLine2: 'Block A/B & C' })
    expect(link).not.toContain(' ')
    expect(new URL(link).searchParams.get('query')).toContain('Block A/B & C')
  })

  it('adds the place id only when there is one, to the parameter each URL documents', () => {
    expect(mapLinkFor(FIXTURE)).not.toContain('place_id')
    const identified = { ...FIXTURE, googlePlaceId: 'ChIJexample' }
    expect(new URL(mapLinkFor(identified)).searchParams.get('query_place_id')).toBe('ChIJexample')
    expect(new URL(directionsLinkFor(identified)).searchParams.get('destination_place_id')).toBe(
      'ChIJexample',
    )
    // And the address stays: Google's URL API ignores a place id with no `query` beside it.
    expect(new URL(mapLinkFor(identified)).searchParams.get('query')).toBe(addressOneLine(FIXTURE))
  })
})

describe('a phone number, in the two forms the row implies', () => {
  it('builds a tel: URI from the stored E.164 and nothing else', () => {
    expect(telLinkFor('+9711234567')).toBe('tel:+9711234567')
    // The control: the display form has spaces, and a `tel:` built from it is truncated by some dialers.
    expect(telLinkFor('+9711234567')).not.toContain(' ')
  })

  it('groups a UAE mobile and a UAE landline differently, because they are', () => {
    // A mobile prefix is two digits, an area code one. Grouping both the same way puts the space in the
    // wrong place on one of them, which is the kind of thing a reader notices and nothing tests.
    expect(formatUaePhone('+971501234567')).toBe('+971 50 123 4567')
    expect(formatUaePhone('+97121234567')).toBe('+971 2 123 4567')
  })

  it('returns anything it does not recognise unchanged — the placeholder above all', () => {
    // The one that matters. `WHATSAPP-PENDING-Y1-NAP` must come back as itself: a formatter that found
    // digits in a placeholder and arranged them into something number-shaped would defeat the placeholder,
    // which exists precisely so that nobody dials it.
    for (const value of [
      'WHATSAPP-PENDING-Y1-NAP',
      '+1 555 0100',
      '+97150',
      '',
      '+9715012345678901',
    ]) {
      expect(formatUaePhone(value), value).toBe(value)
    }
  })
})

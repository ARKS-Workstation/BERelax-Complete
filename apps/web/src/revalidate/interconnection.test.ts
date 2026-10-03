import { SETTINGS } from '@berelax/config'
import { describe, expect, it } from 'vitest'
import {
  cacheTagsFor,
  INTERCONNECTION_CHANGES,
  INTERCONNECTION_MAP,
  registryTagsFor,
} from './interconnection.ts'

/**
 * docs/09 §5's interconnection map, one row at a time.
 *
 * The acceptance criterion is *"each row purges exactly its declared cache tags **and no others**"*, so
 * every assertion here compares SETS. Over-purging is the failure nobody reports: a change that purged
 * everything would make every propagation test pass, the cache would empty on a change that touched one
 * page, and nothing would say so.
 */
describe('the interconnection map is a table, row by row', () => {
  it('covers the eight changes docs/09 §5 names, and no more', () => {
    expect([...INTERCONNECTION_CHANGES]).toEqual([
      'address',
      'opening_hours',
      'service_price',
      'publish_therapist',
      'archive_therapist',
      'accent_density_radius',
      'hero_media',
      'package_template',
    ])
    expect(Object.keys(INTERCONNECTION_MAP).sort()).toEqual([...INTERCONNECTION_CHANGES].sort())
  })

  const expected: Readonly<Record<string, readonly string[]>> = {
    address: ['facts', 'premises', 'schema-jsonld'],
    opening_hours: ['availability', 'facts', 'premises', 'schema-jsonld'],
    service_price: ['catalogue', 'schema-jsonld'],
    publish_therapist: ['availability', 'schema-jsonld', 'therapists'],
    archive_therapist: ['availability', 'content', 'schema-jsonld', 'therapists'],
    accent_density_radius: ['theme'],
    hero_media: ['content', 'schema-jsonld'],
    package_template: ['catalogue', 'schema-jsonld'],
  }

  for (const change of INTERCONNECTION_CHANGES) {
    it(`${change} purges exactly its declared tags and no others`, () => {
      expect([...cacheTagsFor(change)].sort()).toEqual(expected[change])
    })
  }

  it('purges availability only for the four changes that can move a slot', () => {
    // The control for "and no others", from the other direction: a map that purged `availability` on
    // every row would satisfy every assertion above about the rows that do, and this is where that shows.
    const touchesAvailability = INTERCONNECTION_CHANGES.filter((change) =>
      cacheTagsFor(change).includes('availability'),
    )
    expect([...touchesAvailability]).toEqual([
      'opening_hours',
      'publish_therapist',
      'archive_therapist',
    ])
  })

  it('never purges every tag on any one row', () => {
    // Eight tags exist. A row purging all of them is "revalidate everything" wearing a tag's clothes, and
    // the whole argument for cache tags is that the cost of a change is proportional to the change.
    for (const change of INTERCONNECTION_CHANGES) {
      expect(cacheTagsFor(change).length, change).toBeLessThan(6)
      expect(cacheTagsFor(change).length, change).toBeGreaterThan(0)
    }
  })

  it('agrees with the settings registry wherever a row IS a setting', () => {
    // The check that holds the two statements of one fact equal. Only one row is settings-backed today,
    // and that is itself asserted: a row that quietly acquired a key would change this count.
    const backed = INTERCONNECTION_CHANGES.filter(
      (change) => INTERCONNECTION_MAP[change].settingKeys.length > 0,
    )
    expect([...backed]).toEqual(['accent_density_radius'])
    for (const change of backed) {
      expect([...registryTagsFor(change)].sort()).toEqual([...cacheTagsFor(change)].sort())
    }
  })

  it('names only settings keys that exist', () => {
    // `registryTagsFor` would throw on a key nothing defines, which is a failure in a job rather than in
    // a test. This is the assertion that fails first, naming the key.
    const known = new Set(SETTINGS.map((setting) => setting.key))
    for (const change of INTERCONNECTION_CHANGES) {
      for (const key of INTERCONNECTION_MAP[change].settingKeys) {
        expect(known.has(key), `${change} names the unknown setting ${key}`).toBe(true)
      }
    }
  })

  it('quotes the document on every row, so the expectation and the specification sit together', () => {
    for (const change of INTERCONNECTION_CHANGES) {
      expect(INTERCONNECTION_MAP[change].cascadesTo.length, change).toBeGreaterThan(40)
    }
  })
})

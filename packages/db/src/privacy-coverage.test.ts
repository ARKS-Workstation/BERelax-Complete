import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COVERAGE_NAME_PROBE_EXCLUDED_SCHEMAS } from './privacy-coverage'

/**
 * The erasure catalogue's one schema exclusion, pinned in both directions.
 *
 * `COVERAGE_NAME_PROBE_EXCLUDED_SCHEMAS` exists because the CMS's own tables made the engine refuse every
 * erasure: `payload.cms_user.email` is a staff login, `payload.pages.body` is published copy, and neither is
 * anybody's contact detail. Excluding a schema from a probe is the shape of change that makes a check pass by
 * examining less, so the constant is not the safeguard — these two cases are.
 *
 * ## What each one is for
 *
 * The closed set says a second schema cannot be added as a config tweak. The whole argument for the first
 * entry is specific to Payload — tables this repository's migrations do not create, holding a staff identity
 * and website copy — and it does not transfer to a schema somebody adds later. A second entry has to be
 * argued, and failing here is how it gets argued.
 *
 * The asymmetry case is the load-bearing one. The exclusion is applied to the three NAME-based probes and
 * deliberately not to the two REFERENCE-based ones, so a CMS collection that gains a `customer_id` is still
 * enumerated, still has no rule, and still makes the erasure refuse until somebody classifies it. That
 * asymmetry IS the justification. Widening the predicate to `base`, to `reference` or to `fk_child` would
 * turn "these column names are not contact details in this schema" into "this schema cannot hold customer
 * data" — a far larger claim, silently, with every existing test still green. So this case reads the query
 * itself and names the five probe CTEs one by one.
 *
 * ## What neither case can check
 *
 * A CMS collection holding a customer's contact detail with NO reference to `customer` escapes all five
 * probes: probe 1 and probe 3 never see it because nothing links it to a subject, and probes 2, 4 and 5 are
 * excluded from the schema. Nothing in the build has such a collection today, and this is written down
 * rather than guarded because a guard that fires on `payload.cms_user.email` — a staff login — is the
 * refusal this exclusion exists to remove.
 */
const SOURCE = readFileSync(join('packages', 'db', 'src', 'privacy-coverage.ts'), 'utf8')

/** The CTE bodies of `erasureCoverage`'s query, keyed by name, sliced by their own `<name> as (` openings. */
function cteBodies(): ReadonlyMap<string, string> {
  // From the START OF THE LINE holding `with base as (`, because the first CTE is opened by the `with` and
  // the rest are not — and a slice beginning mid-line would put `base` before the first line start the
  // pattern below can match, which is how the first version of this case reported that `base` was gone.
  const opener = SOURCE.indexOf('with base as (')
  const query = SOURCE.slice(SOURCE.lastIndexOf('\n', opener) + 1)
  const openings = [...query.matchAll(/^ {4}(?:with )?([a-z_]+) as \(/gm)]
  expect(
    openings.length,
    'the query no longer opens its CTEs as `    <name> as (` at four spaces, so this case is reading nothing',
  ).toBeGreaterThan(5)
  const bodies = new Map<string, string>()
  openings.forEach((opening, index) => {
    const start = opening.index ?? 0
    const next = openings[index + 1]?.index ?? query.length
    bodies.set(opening[1] as string, query.slice(start, next))
  })
  return bodies
}

describe('the erasure catalogue’s schema exclusion', () => {
  it('excludes exactly one schema, so a second has to be argued rather than appended', () => {
    expect([...COVERAGE_NAME_PROBE_EXCLUDED_SCHEMAS]).toEqual(['payload'])
  })

  it('applies to the three name-based probes and to none of the reference-based ones', () => {
    const bodies = cteBodies()
    const NAME_BASED = ['contact', 'credential', 'free_text']
    const NOT_EXCLUDED = ['base', 'reference', 'subject_tables', 'fk_child']
    for (const name of [...NAME_BASED, ...NOT_EXCLUDED]) {
      expect(
        bodies.has(name),
        `the query no longer has a \`${name}\` CTE, so this case is not reading it`,
      ).toBe(true)
    }
    for (const name of NAME_BASED) {
      expect(
        bodies.get(name),
        `probe CTE \`${name}\` is name-based and must carry the schema exclusion, or the CMS's own columns ` +
          'make every erasure refuse again',
      ).toContain('COVERAGE_NAME_PROBE_EXCLUDED_SCHEMAS')
    }
    for (const name of NOT_EXCLUDED) {
      expect(
        bodies.get(name),
        `\`${name}\` must NOT carry the schema exclusion: it is what still enumerates a CMS table that ` +
          'gains a customer reference, and excluding the schema there would turn a claim about column ' +
          'NAMES into a claim that this schema cannot hold customer data',
      ).not.toContain('COVERAGE_NAME_PROBE_EXCLUDED_SCHEMAS')
    }
  })
})

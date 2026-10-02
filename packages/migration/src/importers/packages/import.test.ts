import { describe, expect, it } from 'vitest'
import { IMPORTERS, importerByName, importerNames } from '../../registry.ts'
import { FIXTURE_VALIDATOR_TEMPLATES, MALFORMED_FIXTURES, readFixture } from './fixtures/index.ts'
import { PACKAGES_IMPORTER_NAME, PACKAGES_IMPORTER_TARGETS, packagesImporter } from './import.ts'
import { PACKAGE_REJECTIONS } from './validate.ts'

/**
 * What the registered importer validates, and what it defers — asserted by name, with controls.
 *
 * The registry is a module-level frozen array, so a registered importer cannot have read the database when
 * it was constructed. H-MIG-02's validator wants the template keys and `ImporterDefinition.validate` is
 * synchronous, so the registry entry is built WITHOUT them and the two template reasons move to `apply`,
 * where there is a unit of work to ask with. That is the one place this importer's behaviour depends on how
 * it was constructed, which makes it the one worth a test of its own.
 *
 * The claim has two halves and both need a control. Deferring the two reasons must not defer any OTHER
 * reason — a validator that accepted everything would satisfy "the template reasons are deferred" — and
 * supplying the templates must bring them back, or the deferral is unconditional.
 */

/**
 * Every rejection one fixture produces, driven the way the framework drives an importer: `parse` over the
 * whole file FIRST, then `validate` per row.
 *
 * The order is load-bearing and is not a convenience. Without the template list the validator is built
 * from the keys the file names, which `parse` is what collects — so a helper that called `validate`
 * straight off an unparsed importer would refuse every row as naming an unknown template, and the first
 * version of this helper did exactly that and reported four failures about the wrong thing.
 */
const verdictsFor = (
  file: string,
  templates?: typeof FIXTURE_VALIDATOR_TEMPLATES,
): readonly string[] => {
  const importer = templates === undefined ? packagesImporter() : packagesImporter({ templates })
  const rows = importer.parse(readFixture(file))
  return rows
    .map((row) => importer.validate(row.payload))
    .flatMap((verdict) => (verdict.ok ? [] : [verdict.reason]))
}

/** The two reasons the registry entry cannot answer, because they are questions about the database. */
const DEFERRED = [
  PACKAGE_REJECTIONS.templateUnknown,
  PACKAGE_REJECTIONS.templateWithoutVersion,
] as const

describe('the registered importer', () => {
  it('is in the registry under its own name, with every target it writes declared', () => {
    expect(importerNames()).toContain(PACKAGES_IMPORTER_NAME)
    expect(importerByName(PACKAGES_IMPORTER_NAME).targetTables).toEqual(PACKAGES_IMPORTER_TARGETS)
    // Every declared target must be schema-qualified with a single-column primary key, because the
    // framework's report calls `unprovenanced_row_ids` for each of them and that raises ZY199 otherwise.
    // `journal_line` is keyed on (entry_id, line_no) and is therefore deliberately absent.
    for (const target of PACKAGES_IMPORTER_TARGETS) {
      expect(target).toMatch(/^[a-z_]+\.[a-z_]+$/)
    }
    expect(PACKAGES_IMPORTER_TARGETS).not.toContain('public.journal_line')
  })

  it('declares a version of its own, so an imported figure traces to the code that wrote it', () => {
    const probe = IMPORTERS.find((importer) => importer.name === PACKAGES_IMPORTER_NAME)
    expect(probe?.version).toBeTruthy()
    expect(probe?.version).not.toBe('')
  })
})

describe('the two template reasons, deferred without the template list', () => {
  it('accepts the clean fixture whether or not the templates were supplied', () => {
    expect(verdictsFor('clean.tsv', FIXTURE_VALIDATOR_TEMPLATES)).toEqual([])
    expect(verdictsFor('clean.tsv')).toEqual([])
  })

  it.each(DEFERRED)('defers %s to apply when no template list was supplied', (reason) => {
    const fixture = MALFORMED_FIXTURES.find((entry) => entry.rejection === reason)
    expect(fixture, `no committed fixture produces ${reason}`).toBeDefined()
    const file = fixture?.file ?? ''
    // With the list: the reason is reported at staging, by name, so the report names every bad line.
    expect(verdictsFor(file, FIXTURE_VALIDATOR_TEMPLATES)).toEqual([reason])
    // Without it: the row passes staging and the question is asked at apply time instead.
    expect(verdictsFor(file)).toEqual([])
  })

  it('defers NOTHING else, which is the control the deferral needs', () => {
    const others = MALFORMED_FIXTURES.filter(
      (fixture) => !(DEFERRED as readonly string[]).includes(fixture.rejection),
    )
    // The floor first: an empty list would make the loop below prove nothing (ADR 0002).
    expect(others.length).toBeGreaterThan(10)
    for (const fixture of others) {
      expect(
        verdictsFor(fixture.file),
        `${fixture.file} was accepted by the registry entry: ${fixture.why}`,
      ).toEqual([fixture.rejection])
    }
  })
})

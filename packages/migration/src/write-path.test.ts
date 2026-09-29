import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { PROBE_TARGET, probeImporter } from './conformance/probe-importer.ts'
import { IMPORTERS, importerByName, importerNames } from './registry.ts'

/**
 * The three claims that keep the framework the single write path, as a scan rather than a review note.
 *
 * All three are about the units that do not exist yet. H-MIG-02 through H-MIG-11 each add an importer, and
 * the mistake each of them can make is the same one: doing for itself something the framework does for
 * everybody, which then holds for eight importers and not for the ninth. A scan is what makes the ninth fail
 * in its own commit.
 *
 *   1. **Nothing outside the conformance directory names the probe table.** It is the framework's target and
 *      nothing reads it, so a domain figure written there is a liability recorded where no report looks.
 *   2. **`withUnitOfWork` is called only by the framework.** An importer that opened its own transaction
 *      would put the entity insert in one and the provenance, audit, event and state transition in
 *      another — which is precisely the half-applied row that makes a killed import unresumable.
 *   3. **The provenance insert is written once.** An importer writing its own would be a second statement of
 *      the provenance shape, and the first time the two disagree the ledger stops resolving.
 *
 * Every claim carries a control that must FIND something, because a scan over an empty file list reports
 * every rule as holding (ADR 0002, and the reason `pnpm boundaries` once cruised zero modules).
 *
 * ## Why these read the WHOLE file, comments included
 *
 * This repository's usual lesson is the opposite — `blankSqlComments` and `blankNonCode` both exist because a
 * scanner that read prose as code refused correct sentences. The lesson does not transfer, and the reason is
 * which way the mistake costs something. A comment-aware scanner needs a TypeScript comment stripper, and a
 * stripper that mishandles a regular expression containing `//` blanks real code and reports the rule as
 * holding — a false PASS, which is the outcome ADR 0002 is about. Reading everything can only produce a
 * false FAILURE, and the remedy for one is a reworded sentence: the failure messages below say what to write
 * instead, and `registry.ts` says "the framework's conformance target" for exactly this reason.
 */

const PACKAGE = join('packages', 'migration', 'src')
const FRAMEWORK = join(PACKAGE, 'framework.ts')
const PROVENANCE = join(PACKAGE, 'provenance.ts')
const CONFORMANCE = join(PACKAGE, 'conformance')
/** The Drizzle mirror legitimately names every table in the schema; that is what a mirror is. */
const MIRROR = join('packages', 'db', 'src', 'schema', 'import-staging.ts')

/** Every first-party non-test TypeScript module, repository-relative with the platform's separators. */
function sourceModules(roots = ['packages', 'apps']): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      if (/\.tsx?$/.test(entry) && !/\.(test|itest)\.tsx?$/.test(entry)) out.push(path)
    }
  }
  for (const root of roots) walk(root)
  return out.sort()
}

const naming = (needle: string, modules: readonly string[]): string[] =>
  modules.filter((path) => readFileSync(path, 'utf8').includes(needle))

describe('the framework is the single write path', () => {
  const modules = sourceModules()

  it('scanned a real number of modules, so the claims below are about something', () => {
    // The floor (ADR 0002). A walk that returned nothing would report all three rules as holding.
    expect(modules.length).toBeGreaterThan(200)
    expect(modules).toContain(FRAMEWORK)
    expect(modules).toContain(PROVENANCE)
  })

  it('names the probe table only in the conformance fixture and the schema mirror', () => {
    const offenders = naming('import_probe_entity', modules).filter(
      (path) => !path.startsWith(CONFORMANCE) && path !== MIRROR,
    )
    expect(
      offenders,
      'import_staging.import_probe_entity is the framework’s conformance target and nothing reads it. ' +
        'An importer that writes a domain figure there records a liability where no report looks for it — ' +
        'and the suites that prove H-MIG-01’s five claims all assume the table holds nothing else. Add ' +
        'the table your unit imports into, and its Drizzle mirror, instead. If you only meant to MENTION ' +
        'it in a comment, write "the framework’s conformance target": this scan reads whole files on ' +
        'purpose, and the module comment above says why.',
    ).toEqual([])
    // The control, in the other direction: the fixture DOES name it, so the scan is reading file contents
    // rather than answering the same way for everything.
    expect(naming('import_probe_entity', modules)).toContain(join(CONFORMANCE, 'probe-importer.ts'))
  })

  it('calls withUnitOfWork from the framework and nowhere else in this package', () => {
    const inPackage = modules.filter((path) => path.startsWith(PACKAGE))
    expect(inPackage.length).toBeGreaterThan(4)
    const offenders = naming('withUnitOfWork', inPackage).filter((path) => path !== FRAMEWORK)
    expect(
      offenders,
      'an importer that opens its own transaction puts the entity insert in one transaction and its ' +
        'provenance, audit row, outbox event and state transition in another. A process killed between the ' +
        'two leaves a row that exists with nothing recording that it was imported — which is the state ' +
        'H-MIG-01 exists to make impossible. Take the UnitOfWork the framework passes to apply().',
    ).toEqual([])
    expect(naming('withUnitOfWork', inPackage)).toEqual([FRAMEWORK])
  })

  it('writes the provenance insert in exactly one module', () => {
    const inserting = naming('insert into import_staging.import_provenance', modules)
    expect(
      inserting,
      'the provenance insert is written once, in provenance.ts. A second one is a second statement of the ' +
        'shape (target_schema, target_table, target_id), and the first time the two disagree the ' +
        'entity_provenance view stops resolving for whichever importer wrote the other.',
    ).toEqual([PROVENANCE])
  })
})

describe('the importer registry', () => {
  it('holds importers that can be run, and refuses a name it does not hold', () => {
    expect(IMPORTERS.length).toBeGreaterThan(0)
    expect(new Set(importerNames()).size, 'two importers share a name').toBe(IMPORTERS.length)
    for (const importer of IMPORTERS) {
      expect(importer.version.length, `${importer.name} has no version`).toBeGreaterThan(0)
      expect(importer.targetTables.length, `${importer.name} declares no target`).toBeGreaterThan(0)
      for (const relation of importer.targetTables) {
        // Schema-qualified, because the report's checksums are taken over these names and an unqualified
        // one resolves through `search_path`.
        expect(relation, `${importer.name} names ${relation}`).toMatch(
          /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/,
        )
      }
    }
    expect(importerByName(probeImporter().name).targetTables).toEqual([PROBE_TARGET])
    expect(() => importerByName('not-an-importer')).toThrow(AppError)
  })
})

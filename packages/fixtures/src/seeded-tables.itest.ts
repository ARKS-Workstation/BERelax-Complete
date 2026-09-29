import { createConnection, DECLARED_UNQUALIFIED, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { orderedLoaders } from './load.ts'
import { seedPackageTemplates } from './package-seed.ts'
import {
  deriveSeededTablesByLoader,
  missingSeededRows,
  nestable,
  readSeededRows,
  writeTargets,
} from './seeded-tables.ts'

/**
 * W-SYS-13 — the seeded table set, derived from the seed, and the two claims a static scan cannot make.
 *
 * `packages/db/src/seeded-row-deletes.test.ts` proves that every unqualified `delete`/`truncate` in a test
 * file is either scoped or declared. It cannot prove either of the things that make a declaration TRUE,
 * because both need a database:
 *
 *  - which tables the seed writes at all. Derived here from the loaders themselves, so it is never a
 *    hand-written list — a list of seeded tables drifts the first time a loader is added, and the list and
 *    the loader would then disagree with nothing saying so.
 *  - whether a `restoredBy` loader can actually put the rows back. Proved here by emptying the family and
 *    watching the loader repair it, which is what the manifest's NOTE means by "a loader that cannot repair
 *    what it created is part of this unit".
 *
 * `packages/fixtures` is the only package that may hold this: the declarations live in `@berelax/db` and the
 * loaders in `packages/fixtures`, and `packages/db` may not import `packages/fixtures`.
 *
 * Every probe below runs inside a transaction this file rolls back. Nothing it does survives, which matters
 * more here than anywhere: a file about not damaging the fixture salon that damaged the fixture salon would
 * be its own subject.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql
let derived: string[]
let byLoader: Map<string, string[]>

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  byLoader = await deriveSeededTablesByLoader(sql)
  derived = [...new Set([...byLoader.values()].flat())].sort()
  // 60 seconds, explicitly. `vitest.integration.config.ts` sets 30,000 ms and this hook runs every loader
  // twice over — once for the attribution and once inside `deriveSeededTables` — which is 1.0 s on an idle
  // container and has no ceiling on a loaded one. A correctness hook carrying an implicit performance
  // budget is brief rule 21, and it has cost four files a false failure.
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the seeded table set is derived from the seed', () => {
  it('finds the tables the loaders write to, and enough of them to mean it', () => {
    // The floor, and the control on the whole file: a derivation that returned nothing would make every
    // assertion below pass over an empty set (ADR 0002). Seventeen tables from nine loaders today.
    expect(derived.length).toBeGreaterThan(10)
    // The tables this unit's three recorded defects were about. Named here and nowhere else: this is the
    // control on the derivation, not the definition of the set — the set is whatever the loaders write.
    expect(derived).toContain('customer')
    expect(derived).toContain('premises_hours')
    expect(derived).toContain('business_day')
    expect(derived).toContain('package_template')
  })

  it('leaves no loader writing to nothing, which is how a short-circuit hides', () => {
    // The guard ON the derivation, and the case that found a real defect. `seedPackageTemplates` returned
    // early on `count(*) from package_template > 0` — idempotent per TABLE — so on any database that had
    // ever been seeded it issued no statement at all and its four tables were absent from the set above.
    // A loader that reaches for nothing is either dead or short-circuiting, and neither is visible in the
    // union; per-loader attribution is the only place it shows.
    const silent = [...byLoader.entries()]
      .filter(([, tables]) => tables.length === 0)
      .map(([name]) => name)
    expect(
      silent,
      'every-loader-reaches-for-its-tables: this loader issued no INSERT or UPDATE against a seeded ' +
        'database. Either it is dead, or it short-circuits on a non-empty table — which means the tables ' +
        'it owns are missing from the derived set and the run invariant is not watching them',
    ).toEqual([])
    expect(byLoader.size).toBe(orderedLoaders().length)
  })

  it('reads `update` only at the start of a statement', () => {
    // A control on the parser, not on the database. `on conflict (key) do update set …` ends every
    // idempotent insert the seed issues, and the first version of this matched `update` anywhere — which
    // put a table called `set` in the derived set, where it read like a real table until somebody queried
    // it. Both directions, on strings this case owns.
    expect(
      writeTargets(['insert into app_setting (key) values (?) on conflict do update set x = 1']),
    ).toEqual(['app_setting'])
    expect(
      writeTargets(['update service set published_at = now() where published_at is null']),
    ).toEqual(['service'])
    expect(writeTargets(['select 1 from service where id = ?'])).toEqual([])
  })
})

describe('a declaration that names a seeded table names a loader that repairs it', () => {
  it('requires a restoring loader for every seeded table a suite empties', () => {
    const seeded = new Set(derived)
    const unrestored = DECLARED_UNQUALIFIED.filter(
      (entry) =>
        entry.kind === 'owns' &&
        entry.restoredBy === undefined &&
        entry.tables.some((table) => seeded.has(table)),
    ).map((entry) => `${entry.file} → ${entry.tables.filter((t) => seeded.has(t)).join(', ')}`)
    expect(
      unrestored,
      'a-seeded-table-declaration-names-its-restoring-loader: this suite declares it owns a table the seed ' +
        'writes, and names nothing that puts the rows back. `pnpm db:apply` refuses a populated database, ' +
        'so a row lost here is lost for every later run against it',
    ).toEqual([])
  })

  it('names a loader that is registered, not one that used to be', () => {
    const registered = new Set(orderedLoaders().map((loader) => loader.name))
    const unknown = DECLARED_UNQUALIFIED.filter(
      (entry) => entry.restoredBy !== undefined && !registered.has(entry.restoredBy),
    ).map((entry) => `${entry.file} → ${entry.restoredBy}`)
    expect(
      unknown,
      'a-restoring-loader-is-a-registered-loader: the named loader is not in `orderedLoaders()`. A ' +
        'declaration pointing at a loader that no longer exists is a promise nothing keeps',
    ).toEqual([])
    // And the control on the other direction: an entry that names a restoring loader must name at least one
    // table the seed actually writes, or the claim is about nothing. Asserted as a relationship rather than
    // as a membership list, because a list of seeded tables here is the restatement the acceptance forbids.
    const seeded = new Set(derived)
    const pointless = DECLARED_UNQUALIFIED.filter(
      (entry) =>
        entry.restoredBy !== undefined &&
        !entry.tables.some((table) => seeded.has(table) || table.startsWith('package_template_')),
    ).map((entry) => `${entry.file} → ${entry.restoredBy}`)
    expect(
      pointless,
      'a-restoring-loader-restores-something: this entry names a loader that puts rows back and no table ' +
        'the seed writes, so there is nothing for it to restore',
    ).toEqual([])
  })
})

describe('the seed repairs a table it partly emptied', () => {
  it('puts the package templates, versions and lines back after the family is truncated', async () => {
    const ROLLBACK = new Error('the repair probe rolls back on purpose')
    const observed = await sql
      .begin(async (tx) => {
        const scoped = tx as unknown as Sql
        const count = async (table: string): Promise<number> => {
          const [row] = await scoped<{ n: string }[]>`
            select count(*)::text as n from ${scoped(table)}
          `
          return Number(row?.n ?? '0')
        }
        const shape = async () => ({
          templates: await count('package_template'),
          versions: await count('package_template_version'),
          lines: await count('package_template_line'),
        })
        // The premise, ESTABLISHED and not inherited. Six suites truncate this family in their `afterAll`
        // and nothing puts it back until the run's own teardown re-seeds, so whether the templates are
        // standing when this file runs depends on vitest's file ordering — which is brief rule 12 exactly,
        // and which turned the premise control below red the first time this file ran after them.
        await seedPackageTemplates(nestable(scoped))
        const before = await shape()

        // The six declared owners' own statement, in their own order — PostgreSQL refuses a truncate while
        // a referencing table is missing from it.
        // `cascade`, and the six declared owners do not use it. Their statements name every referencing
        // table by hand because that is what PostgreSQL requires of them, and the set they name is the set
        // THEIR fixtures create. This probe runs against whatever the rest of the run has left behind —
        // commission lines, cash sessions, journal rows — so a hand-written list fails with "cannot truncate
        // a table referenced in a foreign key constraint" the moment another suite grows a reference to the
        // family. It did, on the first run of this file. Inside a transaction this file rolls back,
        // `cascade` reaching further costs nothing and cannot go stale.
        await scoped.unsafe(
          'truncate package_template_line, package_template_version, package_template cascade',
        )
        const emptied = await shape()
        const repaired = await seedPackageTemplates(nestable(scoped))
        const after = await shape()

        // And again, to prove the repair did not become an accumulation: the loader is still idempotent.
        const second = await seedPackageTemplates(nestable(scoped))
        const twice = await shape()
        throw Object.assign(ROLLBACK, {
          observed: { before, emptied, after, twice, repaired, second },
        })
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error
        return (error as { observed: Record<string, Record<string, number>> }).observed
      })

    const { before, emptied, after, twice } = observed as {
      before: { templates: number; versions: number; lines: number }
      emptied: { templates: number; versions: number; lines: number }
      after: { templates: number; versions: number; lines: number }
      twice: { templates: number; versions: number; lines: number }
    }
    // The premise, asserted rather than assumed: the family really was emptied, or the repair below proves
    // nothing. This is the control that stops the case passing on a database where the truncate silently
    // failed.
    expect(before.templates).toBeGreaterThan(0)
    expect(emptied).toEqual({ templates: 0, versions: 0, lines: 0 })
    expect(
      after,
      'the-seed-repairs-what-it-created: the fixture loader did not put the package family back after a ' +
        'declared owner truncated it. Every `restoredBy: "packages"` declaration depends on this, and ' +
        '`pnpm db:apply` refuses a populated database so nothing else can',
    ).toEqual(before)
    expect(twice, 'the repair is not idempotent, so a second `pnpm seed` accumulates').toEqual(
      before,
    )
  }, 60_000)

  it('repairs a family whose templates survived but whose versions did not', async () => {
    // The PARTLY emptied case, which is the one the old guard could not answer: `count(*) from
    // package_template > 0` was true, so the loader reported "nothing to do" for ever and left four
    // templates with no version — a state every reader treats as four templates that do not exist.
    const ROLLBACK = new Error('the partial-repair probe rolls back on purpose')
    const observed = await sql
      .begin(async (tx) => {
        const scoped = tx as unknown as Sql
        const versions = async (): Promise<number> => {
          const [row] = await scoped<{ n: string }[]>`
            select count(*)::text as n from package_template_version
          `
          return Number(row?.n ?? '0')
        }
        // The premise, established for the reason the case above states.
        await seedPackageTemplates(nestable(scoped))
        const before = await versions()
        // The versions and the lines, and NOT the templates — which is the state under test. `cascade` for
        // the reason the case above states.
        await scoped.unsafe('truncate package_template_line, package_template_version cascade')
        const [templates] = await scoped<{ n: string }[]>`
          select count(*)::text as n from package_template
        `
        const emptied = await versions()
        await seedPackageTemplates(nestable(scoped))
        throw Object.assign(ROLLBACK, {
          observed: {
            before,
            emptied,
            templatesStanding: Number(templates?.n ?? '0'),
            after: await versions(),
          },
        })
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error
        return (error as { observed: Record<string, number> }).observed
      })

    expect(observed['templatesStanding']).toBeGreaterThan(0)
    expect(observed['emptied']).toBe(0)
    expect(
      observed['after'],
      'the-seed-repairs-what-it-created: the templates were standing and their versions were gone, and the ' +
        'loader left it that way — which is the state a table-level idempotence guard cannot see',
    ).toBe(observed['before'])
  }, 60_000)
})

describe('the run invariant compares what it says it compares', () => {
  it('reads a row count and a primary key for every seeded table', async () => {
    const rows = await readSeededRows(sql, derived)
    expect(rows.size).toBe(derived.length)
    const customer = rows.get('customer')
    expect(customer?.key).toBe('id')
    expect(customer?.ids.length).toBe(customer?.count)
    // A composite primary key falls back to a count, and says so by having no key rather than by having a
    // wrong one. `employee_skill` is the seed's one such table today.
    const composite = [...rows.values()].filter((row) => row.key === undefined)
    for (const row of composite) expect(row.ids).toEqual([])
  })

  it('fires on a lost row and stays quiet on a restored one', () => {
    // The control on `missingSeededRows`, both directions, on maps this case owns. Without it the invariant
    // wrapped round the whole integration run is a function nobody has seen say yes.
    const before = new Map([
      ['customer', { count: 4, key: 'id', ids: ['a', 'b', 'c', 'd'] }],
      ['premises_hours', { count: 7, key: 'id', ids: ['h1', 'h2'] }],
    ])
    const lost = new Map([
      ['customer', { count: 3, key: 'id', ids: ['a', 'b', 'c'] }],
      ['premises_hours', { count: 7, key: 'id', ids: ['h1', 'h2'] }],
    ])
    expect(missingSeededRows(before, lost, new Set()).map((loss) => loss.table)).toEqual([
      'customer',
    ])

    // Emptied and restored with NEW ids: right for a declared owner whose loader re-inserts — `seedPremises`
    // gives the row a new uuid — and wrong for anything else, which is the whole distinction.
    const churned = new Map([
      ['customer', { count: 4, key: 'id', ids: ['a', 'b', 'c', 'd'] }],
      ['premises_hours', { count: 7, key: 'id', ids: ['h9', 'h8'] }],
    ])
    expect(missingSeededRows(before, churned, new Set(['premises_hours']))).toEqual([])
    expect(missingSeededRows(before, churned, new Set()).map((loss) => loss.table)).toEqual([
      'premises_hours',
    ])

    // A declared owner is judged on being non-empty and NOT on its total, which is the correction a false
    // failure on the real repository forced: `business_day` stood at 401 rows before a run — the fixture's
    // 149 plus 252 an earlier run of `business-days.itest.ts` had left — and nothing is obliged to restore
    // somebody else's leftovers. A smaller table is not a loss here.
    const smaller = new Map([
      ['customer', { count: 4, key: 'id', ids: ['a', 'b', 'c', 'd'] }],
      ['premises_hours', { count: 2, key: 'id', ids: ['h9', 'h8'] }],
    ])
    expect(missingSeededRows(before, smaller, new Set(['premises_hours']))).toEqual([])

    // An EMPTY one is, and that is the shape all three recorded instances of this defect had: a table
    // emptied and left empty.
    const emptied = new Map([
      ['customer', { count: 4, key: 'id', ids: ['a', 'b', 'c', 'd'] }],
      ['premises_hours', { count: 0, key: 'id', ids: [] }],
    ])
    expect(
      missingSeededRows(before, emptied, new Set(['premises_hours'])).map((loss) => loss.table),
    ).toEqual(['premises_hours'])

    // And a composite-key table, where the count is all the read can compare: a shrink is a loss.
    const composite = new Map([['employee_skill', { count: 19, key: undefined, ids: [] }]])
    const shrunk = new Map([['employee_skill', { count: 18, key: undefined, ids: [] }]])
    expect(missingSeededRows(composite, shrunk, new Set()).map((loss) => loss.table)).toEqual([
      'employee_skill',
    ])
    expect(missingSeededRows(composite, composite, new Set())).toEqual([])
  })
})

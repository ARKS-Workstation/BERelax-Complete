import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KPI_IDS } from '@berelax/core'
import { describe, expect, it } from 'vitest'

/**
 * The architecture half of R-REP-03's registry acceptance line (R-REP-03).
 *
 * The line is: "every KPI reachable from a dashboard resolves to a registered pure function with a
 * non-empty formula string, and an arch test fails on ad-hoc SQL inside a page component". The clause
 * about the REGISTRY is asserted in `packages/core/src/reporting/utilisation.test.ts`, over the registry
 * itself. This file holds the two claims that are about `apps/web` and cannot be made in a pure package:
 *
 *   * **a page component holds no database of its own.** It may import TYPES from `@berelax/db` — three
 *     admin screens already do, and a row shape is exactly what a renderer should be typed against — and
 *     it may not import a VALUE from it, because the only values there are connections, transactions and
 *     query helpers. A page that opened one would read whatever it wanted with no registry, no formula
 *     and no drill-down, which is how two screens come to disagree about one number.
 *   * **a KPI named anywhere in the app is a REGISTERED KPI.** Every id quoted at a `resolveKpi(` call
 *     site is checked against {@link KPI_IDS}, so a renamed KPI is a failing test rather than a thrown
 *     `UnknownKpi` somebody meets on a dashboard.
 *
 * ## The second claim has nothing to check yet, and that is why the gate fixture exists
 *
 * There is no dashboard. R-REP-08 builds `apps/web/app/(admin)/reports/**`, and until it lands the
 * `resolveKpi` scan finds no call site — a check over an empty set, which is what ADR 0003 is about. So
 * `scripts/test-gates.mjs` block 146 PLANTS a page component that resolves an unregistered id and
 * requires this file to fail by the rule's name, and plants one holding a `sql` template and requires
 * the same. The rules have therefore been seen to fire before the thing they govern exists, which is the
 * only order in which that can be true.
 *
 * ## What a page component IS, and the file that settled the boundary
 *
 * The admin estate serves documents from `route.ts` and builds them in `render.ts`, with `view.ts`
 * holding the view model — the arrangement five HR screens record in their own headers. So a page
 * component is the RENDERING half, named: `page.tsx`, `render.ts(x)`, `view.ts(x)` under `apps/web/app`.
 * `route.ts` and `handler.ts` are deliberately outside, because loading rows is their job and that is
 * where a connection belongs.
 *
 * `apps/web/src/components` is deliberately NOT in scope, and `google-reauth-source.ts` is why: it lives
 * under `components/admin` and legitimately imports `readSetting` from `@berelax/db`, because it is the
 * SOURCE for a banner rather than the banner. Drawing a line through that directory means classifying
 * every file in it, which is a wider decision than one unit should take on its own — the same argument
 * `scripts/check-core-purity.mjs` makes about widening its own roots. R-REP-07 owns the KPI tile and has
 * its own arch acceptance line for it.
 *
 * ## Why the scan is counted
 *
 * A source scan that matched nothing would pass, so the file count is asserted against a floor measured
 * on the tree as it stands. A renamed route group or a moved directory is then a failing test rather
 * than a check that quietly stopped looking (ADR 0002).
 */

const WEB_ROOT = new URL('..', import.meta.url).pathname

/**
 * Every rule this file can report, asserted BY NAME.
 *
 * A bare non-zero exit is satisfied by a syntax error (ADR 0003), so each failure message carries its
 * rule and the gate block matches on that.
 */
const KPI_ARCH_RULES = [
  'page-component-imports-no-database-value',
  'page-component-holds-no-sql-template',
  'dashboard-kpi-resolves-to-a-registered-kpi',
] as const

/** The rendering half of a route. See the header for why `route.ts` and `handler.ts` are outside. */
const PAGE_COMPONENT_NAMES = new Set([
  'page.tsx',
  'page.ts',
  'render.ts',
  'render.tsx',
  'view.ts',
  'view.tsx',
])

/**
 * The directory's entries, or none.
 *
 * Split out so the entry type is INFERRED. Annotating it as `ReturnType<typeof readdirSync>` resolves to
 * the `Buffer` overload under `apps/web/tsconfig.json` and fails with six errors about
 * `Dirent<NonSharedBuffer>` — which `pnpm test` cannot see, because vitest transpiles and does not
 * typecheck (brief rule 28). It passed the suite and died at step 2 of verify.
 */
const entriesOf = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function* walk(dir: string): Generator<string> {
  for (const entry of entriesOf(dir)) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(path)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      yield path
    }
  }
}

const isTest = (path: string): boolean => path.endsWith('.test.ts') || path.endsWith('.test.tsx')

/** Every `.ts`/`.tsx` file in the app. The `resolveKpi` scan is over all of it, not over pages only. */
const ALL_WEB_SOURCES = ['app', 'src']
  .flatMap((root) => [...walk(join(WEB_ROOT, root))])
  .filter((path) => !isTest(path))
  .sort()

const PAGE_COMPONENTS = ALL_WEB_SOURCES.filter(
  (path) =>
    path.startsWith(join(WEB_ROOT, 'app')) &&
    PAGE_COMPONENT_NAMES.has(path.slice(path.lastIndexOf('/') + 1)),
)

const relative = (path: string): string => `apps/web/${path.slice(WEB_ROOT.length)}`

/**
 * One `import ... from '...'` statement: the clause, then the module.
 *
 * The clause may span lines, so it may not contain `from` or `import` — without that guard the lazy
 * `[\s\S]*?` runs from one statement's `import` to a LATER statement's `from`, and the first version of
 * this scan reported three `import type { Row } from '@berelax/db'` lines as value imports because the
 * `import { safeText } from '@berelax/core'` above each of them matched across the newline.
 */
const IMPORT_STATEMENT = /import\s+((?:(?!\bfrom\b|\bimport\b)[\s\S])*?)\s*from\s*['"]([^'"]+)['"]/g

/** The packages whose values are database I/O. A row type from any of them is fine; a value is not. */
const DATABASE_MODULE = /^(?:@berelax\/db|postgres|drizzle-orm(?:\/.*)?)$/

/**
 * Whether `source` imports a VALUE from a database package.
 *
 * `import type { Row }` and `import { type Row }` are both type-only and both allowed: a row shape is a
 * contract a renderer should be typed against. A default or namespace import is a value by construction.
 */
function importsDatabaseValue(source: string): boolean {
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    const clause = (match[1] ?? '').trim()
    if (!DATABASE_MODULE.test(match[2] ?? '')) continue
    if (/^type\b/.test(clause)) continue
    const braced = /^\{([\s\S]*)\}$/.exec(clause)
    if (braced === null) return true
    const specifiers = (braced[1] ?? '')
      .split(',')
      .map((specifier) => specifier.trim())
      .filter((specifier) => specifier !== '')
    if (specifiers.some((specifier) => !/^type\b/.test(specifier))) return true
  }
  return false
}

/**
 * A `sql` tagged template.
 *
 * The character before `sql` must not be a letter, digit, `_`, `$`, `.` or a backtick, which is what
 * keeps the prose explaining this rule from violating it: a comment naming the helper writes it as
 * `` `sql` ``, and a sentence about reconciling a page against a `psql` session carries the three
 * letters with a `p` in front. Both already occur in this tree, and the first version of this regex
 * reported the second one.
 */
const SQL_TEMPLATE = /(^|[^A-Za-z0-9_$.`])sql`/

/** Every id quoted at a `resolveKpi('...')` call site. */
const RESOLVE_KPI_CALL = /resolveKpi\(\s*['"]([^'"]+)['"]/g

describe('a page component holds no database of its own', () => {
  it('scans the page components the app actually has', () => {
    // Measured on the tree as it stands: 58 route-named rendering modules. A renamed route group or a
    // moved directory must fail here rather than make every assertion below a claim about nothing.
    expect(PAGE_COMPONENTS.length).toBeGreaterThanOrEqual(50)
    expect(ALL_WEB_SOURCES.length).toBeGreaterThan(PAGE_COMPONENTS.length)
  })

  it('imports no value from the database package', () => {
    const offenders = PAGE_COMPONENTS.filter((path) =>
      importsDatabaseValue(readFileSync(path, 'utf8')),
    ).map(relative)
    expect(
      offenders,
      'page-component-imports-no-database-value: a page component may import a row TYPE from ' +
        '@berelax/db and may not import a value from it. Load the rows in route.ts or handler.ts and ' +
        'pass them in, and take a KPI figure from the registry so the screen publishes the formula it ' +
        `computed. Offending file(s): ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('holds no ad-hoc SQL', () => {
    const offenders = PAGE_COMPONENTS.filter((path) =>
      SQL_TEMPLATE.test(readFileSync(path, 'utf8')),
    ).map(relative)
    expect(
      offenders,
      'page-component-holds-no-sql-template: a page component wrote its own query. A figure read ' +
        'straight from the database on a screen has no registered formula and no drill-down, which is ' +
        `how two screens come to disagree about one number. Offending file(s): ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('catches what it is for and not the prose that explains it', () => {
    // The controls for the two scanners, which are the only parts of this file that could silently stop
    // matching. Four of the six cases are real lines from this tree.
    expect(SQL_TEMPLATE.test('const rows = await sql`select 1`')).toBe(true)
    expect(SQL_TEMPLATE.test('await tx.sql`select 1`')).toBe(false)
    expect(SQL_TEMPLATE.test('reconciling this page against a `psql` session needs')).toBe(false)

    expect(importsDatabaseValue("import { createConnection } from '@berelax/db'")).toBe(true)
    expect(importsDatabaseValue("import postgres from 'postgres'")).toBe(true)
    expect(importsDatabaseValue("import { readSetting, type Sql } from '@berelax/db'")).toBe(true)
    expect(importsDatabaseValue("import type { InboxEntry } from '@berelax/db'")).toBe(false)
    expect(importsDatabaseValue('import {\n  type A,\n  type B,\n} from "@berelax/db"')).toBe(false)
    expect(
      importsDatabaseValue(
        "import { safeText } from '@berelax/core'\nimport type { Row } from '@berelax/db'",
      ),
    ).toBe(false)
  })
})

describe('a KPI named on a screen', () => {
  it('resolves to a registered KPI', () => {
    const unregistered: string[] = []
    for (const path of ALL_WEB_SOURCES) {
      for (const match of readFileSync(path, 'utf8').matchAll(RESOLVE_KPI_CALL)) {
        const id = match[1]
        if (id !== undefined && !KPI_IDS.includes(id)) unregistered.push(`${relative(path)}: ${id}`)
      }
    }
    expect(
      unregistered,
      'dashboard-kpi-resolves-to-a-registered-kpi: a screen named a KPI the registry does not hold, ' +
        'so the tile would carry a figure with no formula behind it. Register it in ' +
        `packages/core/src/reporting, or correct the name. Offending site(s): ${unregistered.join(', ')}`,
    ).toEqual([])
  })

  it('has a registry to resolve against, with every id non-empty and distinct', () => {
    // The scan above is over an empty set until R-REP-08 builds a dashboard, so this is what stops the
    // file passing by finding nothing at all. See the header: the gate block plants the known-bad page.
    expect(KPI_IDS.length).toBeGreaterThan(0)
    expect(KPI_IDS.every((id) => id.trim() !== '')).toBe(true)
    expect(new Set(KPI_IDS).size).toBe(KPI_IDS.length)
  })

  it('names every rule this file can report', () => {
    expect(new Set(KPI_ARCH_RULES).size).toBe(KPI_ARCH_RULES.length)
  })
})

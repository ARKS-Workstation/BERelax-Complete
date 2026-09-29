import type { Sql } from '@berelax/db'
import { orderedLoaders } from './load.ts'
import { generateSalon } from './salon.ts'

/**
 * Which tables the SEED writes, derived from the loaders, and whether its rows survived a run.
 *
 * ## Why this is derived and not written down
 *
 * The rule in `packages/db/src/suite-table-ownership.ts` needs to know which tables hold rows a suite did
 * not create. A hand-written list of them is the second statement of a fact, and it drifts the first time a
 * loader is added — which is the defect class this build pays for most. So the set comes from the seed
 * itself: `loadSalon` runs against a real database inside a transaction that is rolled back, with a
 * recording handle in place of the connection, and the tables are the ones its own statements write to.
 *
 * ## Why STATEMENTS and not rows
 *
 * Counting rows before and after a seed sounds stronger and is useless here: every loader is idempotent, so
 * on a database that has already been seeded a second run inserts nothing and the row diff is zero
 * everywhere. Emptying the database first is not available either — `seedCatalogue` reads the `service`
 * rows migration 0017 creates and refuses to invent them, so a fully truncated database cannot be seeded at
 * all. What a loader REACHES FOR is observable in every state, which is what makes this the derivation that
 * works on the database the suites actually run against.
 *
 * It has one consequence worth stating, because it found a real defect rather than merely surviving one: a
 * loader that short-circuits on a non-empty table reaches for nothing, so it is INVISIBLE here.
 * `seedPackageTemplates` was exactly that, and its four templates were missing from the derived set until
 * the guard became per-template-key. A loader that cannot repair what it created cannot be named as a
 * `restoredBy` either, so the two halves of that defect are the same half.
 */

/** A statement the seed issued, as text. */
export type StatementRecorder = (statement: string) => void

/**
 * A handle that records every statement it is asked to run, then runs it.
 *
 * Wraps `begin` as well as the tagged template and `unsafe`, because several loaders write through
 * `withUnitOfWork`, which opens a transaction — and a handle that did not follow them into it would report
 * that the settings loader, the package loader and the catalogue loader write to nothing at all.
 */
export function recordingSql(handle: Sql, record: StatementRecorder): Sql {
  const target = handle as unknown as (...args: unknown[]) => unknown
  return new Proxy(target, {
    apply(inner, thisArg, args) {
      const strings = args[0] as { raw?: readonly string[] } | undefined
      // A tagged template's first argument is the strings array; `raw` is what the author wrote, so the
      // interpolations are absent and the table name is whatever is in the source.
      if (Array.isArray(strings?.raw)) record(strings.raw.join(' ? '))
      return Reflect.apply(inner, thisArg, args)
    },
    get(inner, property) {
      // `begin` on a TRANSACTION handle is `savepoint`. postgres.js puts `begin` on the root connection
      // only, so a loader that opens its own unit of work — `withUnitOfWork` calls `sql.begin` — throws
      // `sql.begin is not a function` the moment it is handed a transaction. Three loaders do that, and the
      // derivation appeared to work without this only because the one that does it most had nothing to
      // write on an already-seeded database.
      const wanted =
        property === 'begin' && typeof Reflect.get(inner, 'begin') !== 'function'
          ? 'savepoint'
          : property
      const value = Reflect.get(inner, wanted) as unknown
      if (typeof value !== 'function') return value
      const method = value as (...args: unknown[]) => unknown
      if (property === 'unsafe') {
        return (text: string, ...rest: unknown[]) => {
          record(text)
          return method.call(inner, text, ...rest)
        }
      }
      if (property === 'begin') {
        return (...args: unknown[]) => {
          const body = args.pop() as (tx: Sql) => unknown
          return method.call(inner, ...args, (tx: Sql) => body(recordingSql(tx, record)))
        }
      }
      return method.bind(inner)
    },
    has(inner, property) {
      return Reflect.has(inner, property)
    },
  }) as unknown as Sql
}

/**
 * A transaction handle a loader can open its own unit of work on.
 *
 * The recorder records nothing: this is `recordingSql` used for its OTHER job, the `begin`/`savepoint`
 * translation above. Reusing that path rather than writing a second proxy means the translation the
 * derivation depends on is the one every caller gets.
 */
export const nestable = (handle: Sql): Sql => recordingSql(handle, () => {})

/** Thrown to abort the derivation's transaction. Identity-compared, never matched on its message. */
const ROLLBACK = new Error('the seeded-table derivation rolls its transaction back on purpose')

/**
 * The tables `pnpm seed` writes, derived by running it and throwing the transaction away.
 *
 * Nothing is left behind: the loaders run inside one transaction and the rollback is unconditional. It is
 * safe against an already-seeded database, which is the state the integration suite runs in.
 */
export async function deriveSeededTables(sql: Sql): Promise<string[]> {
  const byLoader = await deriveSeededTablesByLoader(sql)
  return [...new Set([...byLoader.values()].flat())].sort()
}

/**
 * The same derivation, attributed to the loader that issued each statement.
 *
 * Per loader rather than in one heap because of what it makes checkable: a loader that reaches for NOTHING
 * is either dead or short-circuiting on a non-empty table, and both are invisible in the union. That check
 * is in `seeded-tables.itest.ts` and it is the guard on this whole derivation — without it, a loader that
 * quietly stopped writing would shrink the protected set and every assertion built on it would go on
 * passing (ADR 0002).
 *
 * The loop repeats `loadSalon`'s, which is three lines and the only way to attribute a statement: the
 * ordering comes from `orderedLoaders()` either way, so the two cannot disagree about which loaders exist
 * or in what order they run.
 */
export async function deriveSeededTablesByLoader(sql: Sql): Promise<Map<string, string[]>> {
  const byLoader = new Map<string, string[]>()
  const salon = generateSalon()
  let statements: string[] = []
  try {
    await sql.begin(async (tx) => {
      const recording = recordingSql(tx as unknown as Sql, (statement) => {
        statements.push(statement)
      })
      for (const loader of orderedLoaders()) {
        statements = []
        await loader.load(recording, salon)
        byLoader.set(loader.name, writeTargets(statements))
      }
      throw ROLLBACK
    })
  } catch (error) {
    if (error !== ROLLBACK) throw error
  }
  return byLoader
}

/**
 * The tables a set of statements writes to, sorted.
 *
 * `update` is recognised only at the START of a statement. `on conflict do update set …` ends every
 * idempotent insert in the seed, and a pattern that matched `update` anywhere reported a table called
 * `set` — which is the kind of derived-list defect that reads as a real table until somebody queries it.
 */
export function writeTargets(statements: readonly string[]): string[] {
  const name = '("?[a-z_][a-z_0-9]*"?(?:\\.[a-z_][a-z_0-9]*)?)'
  const inserts = new RegExp(`\\binsert\\s+into\\s+${name}`, 'gi')
  const updates = new RegExp(`^(?:with\\s.*?)?update\\s+${name}`, 'i')
  const tables = new Set<string>()
  const add = (raw: string | undefined): void => {
    if (raw !== undefined) tables.add(raw.toLowerCase().split('"').join(''))
  }
  for (const statement of statements) {
    const collapsed = statement.replace(/\s+/g, ' ').trim()
    for (const match of collapsed.matchAll(inserts)) add(match[1])
    add(updates.exec(collapsed)?.[1])
  }
  return [...tables].sort()
}

/** What a table held before a run, so the same read after it can be compared. */
export interface SeededRows {
  readonly count: number
  /** The single-column primary key, when the table has one. */
  readonly key: string | undefined
  /** Its values, when `key` is set. Empty otherwise: a count is all a composite key allows cheaply. */
  readonly ids: readonly string[]
}

/**
 * Refuses a name this reader cannot address.
 *
 * `sql(identifier)` quotes what it is given as ONE identifier, so `clinical.intake_submission` would become
 * the quoted name `"clinical.intake_submission"` and the read would fail on a relation that does not exist.
 * Every table the seed writes is in `public`; a dotted one arriving here means the seed has grown a schema
 * this reader has not been taught, and saying so is better than a confusing relation error.
 */
function assertReadable(table: string): void {
  if (!/^[a-z_][a-z_0-9]*$/.test(table)) {
    throw new Error(
      `The seeded-row reader can only address an unqualified table in \`public\`, and the seed now writes ` +
        `to ${table}. Teach readSeededRows the schema rather than dropping the table from the invariant.`,
    )
  }
}

/**
 * Reads each table's row count and, where it has a single-column primary key, its keys.
 *
 * The keys are the point. A COUNT alone cannot tell "the seeded row is gone" from "the seeded row is gone
 * and a suite added one of its own", and suites add rows to seeded tables all the time — so a count-only
 * invariant would be satisfied by exactly the substitution it exists to catch.
 */
export async function readSeededRows(
  sql: Sql,
  tables: readonly string[],
): Promise<Map<string, SeededRows>> {
  for (const table of tables) assertReadable(table)
  const keyed = await sql<{ table_name: string; column_name: string }[]>`
    select c.relname as table_name, min(a.attname) as column_name
      from pg_index i
      join pg_class c on c.oid = i.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
     where i.indisprimary
       and n.nspname not in ('pg_catalog', 'information_schema')
     group by c.relname, i.indexrelid
    having count(*) = 1
  `
  const keyByTable = new Map(keyed.map((row) => [row.table_name, row.column_name]))

  const out = new Map<string, SeededRows>()
  for (const table of tables) {
    const key = keyByTable.get(table)
    if (key === undefined) {
      // A composite primary key, or none. `sql(name)` interpolates a QUOTED IDENTIFIER rather than a string
      // literal, which is what makes a dynamic table name safe here at all.
      const [row] = await sql<{ n: string }[]>`select count(*)::text as n from ${sql(table)}`
      out.set(table, { count: Number(row?.n ?? '0'), key: undefined, ids: [] })
      continue
    }
    const rows = await sql<{ id: string }[]>`select ${sql(key)}::text as id from ${sql(table)}`
    out.set(table, { count: rows.length, key, ids: rows.map((row) => row.id) })
  }
  return out
}

/** One table's verdict after a run. */
export interface SeededRowLoss {
  readonly table: string
  readonly reason: string
}

/**
 * Seeded rows that did not survive the run, per table.
 *
 * Two standards, and the difference is the declaration.
 *
 * A table **no suite declared** must hold every row it held before, by primary key. Nothing was supposed to
 * touch it, so exact survival is the right bar and the cheapest to read. Where the primary key is composite
 * the count stands in for it, which is weaker and is the best a cheap read can do.
 *
 * A table a suite **declared as one it owns**, naming the loader that restores it, must be NON-EMPTY once the
 * loaders have been re-run. Not "no smaller than before", and that distinction cost a false failure on the
 * real repository: `business-days.itest.ts` empties `business_day` and generates its own window, so the 401
 * rows standing before a run were the fixture's 149 plus 252 that earlier runs of that file had left, and
 * nothing is obliged to restore somebody else's leftovers. Comparing totals over a table a suite legitimately
 * rewrites is brief rule 9's "assert a delta, never a total" in a new place.
 *
 * Non-empty is weaker than exact and it is what the declaration actually promises. It still catches every
 * recorded instance of this defect, because all three were a table emptied and LEFT empty: the four seeded
 * customers, the four package templates, the seven rows of trading hours. What it does not catch is a
 * declared owner that restores fewer rows than it removed, and the repair property in
 * `seeded-tables.itest.ts` is where that is measured instead — on the family, exactly, before and after.
 */
export function missingSeededRows(
  before: ReadonlyMap<string, SeededRows>,
  after: ReadonlyMap<string, SeededRows>,
  restorable: ReadonlySet<string>,
): SeededRowLoss[] {
  const out: SeededRowLoss[] = []
  for (const [table, was] of before) {
    const now = after.get(table)
    if (now === undefined) {
      out.push({ table, reason: 'the table could not be read after the run' })
      continue
    }
    if (restorable.has(table)) {
      if (was.count > 0 && now.count === 0) {
        out.push({
          table,
          reason: `held ${was.count} row(s) before the run and is EMPTY after, even though a suite declared it owns this table and named the loader that restores it`,
        })
      }
      continue
    }
    if (was.key === undefined) {
      if (now.count < was.count) {
        out.push({
          table,
          reason: `held ${was.count} row(s) before the run and ${now.count} after; its primary key is composite, so the count is all this read can compare`,
        })
      }
      continue
    }
    const present = new Set(now.ids)
    const gone = was.ids.filter((id) => !present.has(id))
    if (gone.length > 0) {
      out.push({
        table,
        reason: `${gone.length} row(s) present before the run are gone, by ${was.key}: ${gone.slice(0, 5).join(', ')}`,
      })
    }
  }
  return out
}

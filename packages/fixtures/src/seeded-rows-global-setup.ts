import { createConnection, restorableTables, type Sql } from '@berelax/db'
import { loadSalon } from './load.ts'
import { generateSalon } from './salon.ts'
import {
  deriveSeededTables,
  missingSeededRows,
  readSeededRows,
  type SeededRows,
} from './seeded-tables.ts'

/**
 * The integration run's own invariant: the seeded rows are there before it and there after it.
 *
 * ## Why this is a `globalSetup` and not a test
 *
 * The defect it catches is not in any one file. A suite that empties a table empties it for every suite
 * that runs afterwards and for every later run against the same database, and the symptom appears in a file
 * that did nothing wrong — `sell-package.itest.ts` skipping all 21 of its cases with "the seed creates
 * customers", M-TILL-13 measuring 140 tables where 153 were expected, a salon answering about a rota it no
 * longer had. A test inside the run cannot see that: whichever file it sits in, it runs at one point in an
 * order no file controls. Only something wrapped round the whole run can, which is what this is.
 *
 * So the run that removed a seeded row is the run that fails, rather than the next one.
 *
 * ## What it does
 *
 * Before: derives the seeded tables from the loaders themselves (`./seeded-tables.ts` explains why the
 * derivation watches statements rather than counting rows) and reads each one's rows.
 *
 * After: **re-runs the fixture loaders** — which is exactly `pnpm seed` — and then compares. Re-running
 * first is what makes the two standards in `missingSeededRows` fair: a suite that declares it owns a table
 * and names the loader that restores it has had its chance, and a `restoredBy` that is not true fails here.
 * It is also the repair a developer would run, so a run that passes leaves a database the next run can use.
 *
 * What it does NOT do is compare totals over a table a declared owner rewrites. `business_day` stood at 401
 * rows before a run — the fixture's 149 plus 252 an earlier run of `business-days.itest.ts` had left — and a
 * loader is not obliged to restore another suite's leftovers. Comparing totals there is brief rule 9's
 * "assert a delta, never a total" in a new place, and it cost this invariant a false failure before the bar
 * became the one the declaration actually promises.
 *
 * ## The cost, measured
 *
 * The derivation is one rolled-back transaction, 508 ms on this container. The reads are 17 tables and
 * about 370 rows. The repair is `pnpm seed`, about 8 s. Against an integration suite that takes tens of
 * minutes, that is not a budget question — but it is why the reads are counts and primary keys rather than
 * whole rows.
 */

const REQUIRED_URL =
  'TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip, and neither does the ' +
  'invariant that watches them.'

function connect(): Sql {
  const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
  if (!url) throw new Error(REQUIRED_URL)
  return createConnection({ url, max: 2 })
}

export default async function setup(): Promise<() => Promise<void>> {
  const sql = connect()
  let tables: string[]
  let before: Map<string, SeededRows>
  try {
    tables = await deriveSeededTables(sql)
    before = await readSeededRows(sql, tables)
  } finally {
    await sql.end({ timeout: 5 })
  }
  // The floor (ADR 0002). A derivation that returned nothing would make every comparison below pass over an
  // empty set, and "no seeded row was lost" over zero tables is the shape of vacuous check this whole unit
  // exists to stop. The number is not a guess: the seed has nine loaders and writes to seventeen tables, so
  // a derivation that has fallen to single figures has broken rather than shrunk.
  if (tables.length < 10) {
    throw new Error(
      `seeded-rows-survive-the-integration-run: the seeded-table derivation found only ${tables.length} ` +
        'table(s), so the invariant would be watching almost nothing. Fix the derivation in ' +
        'packages/fixtures/src/seeded-tables.ts rather than lowering this floor.',
    )
  }

  return async function teardown(): Promise<void> {
    const after = connect()
    let repairError: unknown
    try {
      // The repair, before the comparison. A loader that throws is reported WITH whatever was lost, because
      // "the seed can no longer run against this database" and "a seeded row is gone" are usually the same
      // event seen from two sides, and a teardown that reported only the throw would hide the table.
      try {
        await loadSalon(after, generateSalon())
      } catch (error) {
        repairError = error
      }
      const losses = missingSeededRows(
        before,
        await readSeededRows(after, tables),
        restorableTables(),
      )
      if (losses.length === 0 && repairError === undefined) return
      const detail = losses.map((loss) => `  - ${loss.table}: ${loss.reason}`).join('\n')
      throw new Error(
        'seeded-rows-survive-the-integration-run: rows that were in the database before this run started ' +
          'are not there now, and re-running the fixture loaders either could not replace them or replaced ' +
          'them with DIFFERENT rows — which is the same defect for anything holding an id.\n' +
          `${detail}\n` +
          (repairError === undefined
            ? ''
            : `  - the fixture loaders themselves then failed: ${String(repairError)}\n`) +
          'A suite may remove rows it created. Anything wider is declared in ' +
          'packages/db/src/suite-table-declarations.ts, and a declaration that names a table the seed ' +
          'writes has to name the loader that puts it back (ADR 0050).',
      )
    } finally {
      await after.end({ timeout: 5 })
    }
  }
}

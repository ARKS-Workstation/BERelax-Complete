#!/usr/bin/env node
/**
 * Seeds the fixture salon into DATABASE_URL.
 *
 * Idempotent: running it twice from clean produces the same rows, which is asserted by
 * `packages/fixtures/src/load.itest.ts`. Safe to run again when you are not sure whether the first
 * one worked, which is the situation it is usually run in.
 */
import { createConnection } from '../packages/db/src/connection.ts'
import { loadSalon } from '../packages/fixtures/src/load.ts'
import { generateSalon } from '../packages/fixtures/src/salon.ts'

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}

const sql = createConnection({ url, max: 2 })
try {
  const salon = generateSalon()
  const results = await loadSalon(sql, salon)
  for (const result of results) console.log(`  ${result.loader}: ${result.rows} row(s)`)
  /*
   * What was WRITTEN, counted from the loaders, and never from the generated salon.
   *
   * This line used to read "Seeded the fixture salon: 12 services, 8 therapists, 250 appointments, 188
   * invoices", and every figure in it came from `salon.<collection>.length` — the objects the GENERATOR
   * produced, not the rows any loader wrote. `loadSalon` has ten loaders and none of them writes an
   * appointment, an invoice or a customer: `generateSalon()`'s diary and ledger exist for the in-memory
   * demo book (`salon.test.ts`, `packages/harness`'s screenshot specimens), which is correct and is not
   * what this script does.
   *
   * So the old message reported 250 appointments and 188 invoices into a database holding zero of each,
   * and reported them as success. That is ADR 0002's shape — a step that examined nothing while saying it
   * had — pointed at seeding, and it is the reason this took a session to notice: the summary agreed with
   * what somebody expected, so nobody queried the tables.
   *
   * The per-loader lines above are the real answer. This one totals them and then says, in one sentence,
   * which parts of the fixture salon a database does NOT receive — because a reader who has just been
   * told about 12 services will otherwise assume the diary came too.
   */
  const rows = results.reduce((total, result) => total + result.rows, 0)
  // "written this run", because every loader is idempotent: a second `pnpm seed` writes almost nothing
  // and reports almost nothing, which is the seed working rather than the seed failing. A total with no
  // such qualifier would read as a broken run to the next person who does what this script exists to
  // make safe — running it again when they are not sure the first one worked.
  console.log(
    `Seeded ${rows} row(s) written this run across ${results.length} loader(s): the premises, the ` +
      'catalogue, the settings, the trading calendar, the therapist headcount, the message templates ' +
      'and the consent, suppression, package and stock records. A re-run writes 0 and that is correct.',
  )
  console.log(
    'NOT seeded, by design: appointments, invoices, payments and the rota. The generated diary and ' +
      'ledger are for the in-memory demo book, and the roster deliberately carries no gender, no ' +
      'credentials and no wages — see packages/db/src/seed/therapists.ts for why each is left NULL. ' +
      'Until a human enters those and publishes a rota, availability correctly offers nobody.',
  )
} finally {
  await sql.end({ timeout: 5 })
}

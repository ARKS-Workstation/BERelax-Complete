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
  console.log(
    `Seeded the fixture salon: ${salon.services.length} services, ${salon.therapists.length} ` +
      `therapists, ${salon.appointments.length} appointments, ${salon.invoices.length} invoices.`,
  )
} finally {
  await sql.end({ timeout: 5 })
}

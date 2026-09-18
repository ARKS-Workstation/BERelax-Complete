#!/usr/bin/env node
/**
 * Enforces schema conventions that a type system cannot.
 *
 * 1. **Every timestamp is timestamptz.** A naive `timestamp` column silently stores whatever the
 *    session timezone was, so the same appointment reads back differently depending on who connects.
 *    With trading hours crossing midnight, that is not a cosmetic bug — it moves bookings between
 *    business days and therefore between cash-up totals.
 * 2. **Money columns are integer.** `numeric`, `real` or `double precision` on an amount column is
 *    the float-money mistake in a different costume.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const problems = []

// --- Drizzle definitions ------------------------------------------------------------------------
// Both mirror directories. The clinical schema's mirrors live in @berelax/clinical, and leaving
// them out would exempt the most sensitive schema from the convention.
const SCHEMA_DIRS = ['packages/db/src/schema', 'packages/clinical/src/schema']
for (const dir of SCHEMA_DIRS) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const path = join(dir, file)
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/\btimestamp\s*\(/.test(line) && !/withTimezone:\s*true/.test(line)) {
          problems.push(`${path}:${i + 1}  timestamp() without { withTimezone: true }`)
        }
        if (/\b(?:real|doublePrecision)\s*\(/.test(line)) {
          problems.push(
            `${path}:${i + 1}  floating-point column — money and counts must be integer`,
          )
        }
      })
  }
}

// --- SQL migrations -----------------------------------------------------------------------------
const MIGRATIONS_DIR = 'packages/db/migrations'
for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
  const path = join(MIGRATIONS_DIR, file)
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      // `--` comments and single-quoted strings are blanked before the scan. SQL `comment on`
      // statements are prose about the schema, and prose about a schema says the word "timestamp" —
      // which the first version of this gate reported as a naive timestamp column.
      const code = line.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/, '')
      // `timestamp` not followed by `tz` or `with time zone`.
      if (/\btimestamp\b(?!tz)(?!\s+with\s+time\s+zone)/i.test(code)) {
        problems.push(`${path}:${i + 1}  naive timestamp — use timestamptz`)
      }
      if (/\b(real|double\s+precision|money)\b/i.test(code)) {
        problems.push(
          `${path}:${i + 1}  ${/money/i.test(code) ? 'the money type' : 'a floating-point type'} — ` +
            'amounts are integer fils (see the `fils` domain in 0002_conventions.sql)',
        )
      }
    })
}

if (problems.length > 0) {
  console.error(`Schema convention violations — ${problems.length}:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('Schema conventions hold: all timestamps are timestamptz, no floating-point amounts.')

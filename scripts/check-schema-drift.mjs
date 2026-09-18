#!/usr/bin/env node
/**
 * Compares the Drizzle schema definitions against the live database.
 *
 * Migrations are SQL-first (ADR 0006), so the Drizzle definitions are a hand-written mirror. A
 * mirror drifts. When it does, queries compile against a shape the database does not have and the
 * failure surfaces at runtime on whichever code path nobody exercised.
 *
 * This checks table and column presence and nullability in BOTH directions:
 *   - a column in Drizzle that the database lacks  -> the query would fail at runtime
 *   - a column in the database that Drizzle lacks  -> usually a migration whose mirror was forgotten
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('TEST_DATABASE_URL or DATABASE_URL is required for the drift check.')
  process.exit(1)
}

const SCHEMA_DIR = 'packages/db/src/schema'
const IGNORED_TABLES = new Set(['regulatory_profile_current']) // a view, intentionally not mirrored

// --- what Drizzle declares -------------------------------------------------------------------
// Parsed from source rather than imported, so the check does not depend on the ORM's runtime
// internals and keeps working across Drizzle versions.
/**
 * Extracts the column-definition object of each pgTable call by counting braces rather than
 * pattern-matching a closing line. An earlier version required a newline before the closing brace,
 * which made a single-line table definition invisible to this gate — caught by the known-bad
 * fixture in scripts/test-gates.mjs, which is exactly what that fixture is for.
 */
const TABLE_OPEN_RE = /pgTable\(\s*'([a-z0-9_]+)'\s*,\s*\{/g
const COLUMN_RE =
  /(?:^|[,{]|\n)\s*(?:'[^']+'|[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*\(\s*'([a-z0-9_]+)'/g

function extractTables(src) {
  const out = new Map()
  for (const match of src.matchAll(TABLE_OPEN_RE)) {
    const table = match[1]
    const bodyStart = match.index + match[0].length
    let depth = 1
    let i = bodyStart
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    const body = src.slice(bodyStart, i - 1)
    const cols = new Set()
    for (const col of body.matchAll(COLUMN_RE)) cols.add(col[1])
    out.set(table, cols)
  }
  return out
}

const declared = new Map() // table -> Set(column)
for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
  const src = readFileSync(join(SCHEMA_DIR, file), 'utf8')
  for (const [table, cols] of extractTables(src)) declared.set(table, cols)
}

if (declared.size === 0) {
  console.error(`No pgTable definitions found in ${SCHEMA_DIR}. Refusing to report success.`)
  process.exit(1)
}

// --- what the database has -------------------------------------------------------------------
const psql = (sqlText) =>
  execFileSync(
    'psql',
    ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-At', '-F', '\t', url, '-c', sqlText],
    {
      encoding: 'utf8',
    },
  )

const rows = psql(`
  select c.table_name, c.column_name
  from information_schema.columns c
  join information_schema.tables t
    on t.table_name = c.table_name and t.table_schema = c.table_schema
  where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  order by c.table_name, c.ordinal_position
`)
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => l.split('\t'))

const actual = new Map()
for (const [table, column] of rows) {
  if (!actual.has(table)) actual.set(table, new Set())
  actual.get(table).add(column)
}

// --- compare ----------------------------------------------------------------------------------
const problems = []

for (const [table, cols] of declared) {
  if (!actual.has(table)) {
    problems.push(`Drizzle declares table "${table}" but the database has no such table`)
    continue
  }
  const dbCols = actual.get(table)
  for (const col of cols) {
    if (!dbCols.has(col))
      problems.push(`${table}.${col}: declared in Drizzle, missing in the database`)
  }
  for (const col of dbCols) {
    if (!cols.has(col))
      problems.push(`${table}.${col}: present in the database, missing from Drizzle`)
  }
}

// Partitions of audit_event appear as base tables; they are not separately mirrored.
const ignorable = (t) => IGNORED_TABLES.has(t) || /^audit_event_\d{4}_\d{2}$/.test(t)
for (const table of actual.keys()) {
  if (!declared.has(table) && !ignorable(table)) {
    problems.push(`Database has table "${table}" with no Drizzle mirror`)
  }
}

if (problems.length > 0) {
  console.error(`Schema drift — ${problems.length} problem(s):`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

console.log(
  `No drift: ${declared.size} table(s) mirrored, ` +
    `${[...declared.values()].reduce((n, s) => n + s.size, 0)} columns verified.`,
)

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

/**
 * Every directory holding Drizzle mirrors.
 *
 * The `clinical` schema's mirrors live in @berelax/clinical, not @berelax/db, because the package
 * that owns the boundary owns its own shape. Leaving it out of this gate would have left an entire
 * schema — the most sensitive one — undrift-checked.
 *
 * A DIRECTORY and not a directory-per-schema, which it used to be. That pairing was wrong as soon as one
 * directory held two schemas: A-FIRST-01's `analytics` mirrors live beside the `public` ones in
 * `packages/db/src/schema`, and under the old mapping every one of them would have been attributed to
 * `public` — nine tables reported as declared-but-missing and nine more as present-but-unmirrored, on a
 * schema that matched the migration exactly. The schema now comes from the `pgSchema(...)` call each table
 * is built on, which is where the database gets it from too.
 */
const MIRROR_DIRS = ['packages/db/src/schema', 'packages/clinical/src/schema']

/**
 * The schemas this build owns, and therefore the ones a mirror is required for.
 *
 * `payload` is the CMS's own storage, created and migrated by Payload rather than by
 * `packages/db/migrations` (ADR 0019), and `pgboss` belongs to the queue library — neither is this
 * repository's to mirror. Stated as the schemas that ARE checked rather than as the ones that are not, so
 * a schema added by a migration and never mirrored is a failure here rather than an omission nobody sees.
 */
// Read by NAME from `apps/web/src/payload.itest.ts` and `apps/worker/src/worker.itest.ts`, which assert
// that `payload` and `pgboss` are not in it. Rename this constant and both of them fail by name; they
// used to match a shape instead and went quietly red for eleven migrations when the shape changed.
const OWNED_SCHEMAS = ['public', 'clinical', 'analytics']
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
// Matches both `pgTable('x', {` and `someSchema.table('x', {`, capturing the qualifier so the schema can
// be resolved from the `pgSchema(...)` the qualifier was bound to.
const TABLE_OPEN_RE = /(?:pgTable|([A-Za-z_$][\w$]*)\.table)\(\s*'([a-z0-9_]+)'\s*,\s*\{/g
const COLUMN_RE =
  /(?:^|[,{]|\n)\s*(?:'[^']+'|[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*\(\s*'([a-z0-9_]+)'/g
/** `export const clinicalSchema = pgSchema('clinical')` — the binding a `.table(...)` is qualified by. */
const SCHEMA_BINDING_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*pgSchema\(\s*'([a-z0-9_]+)'/g

/**
 * Which Postgres schema each `pgSchema(...)` binding in this file stands for.
 *
 * Read from the source rather than assumed from the file's directory, for the reason MIRROR_DIRS gives.
 * A `.table(...)` whose qualifier is not a binding in the same file is left unresolved and reported below,
 * which is deliberate: silently defaulting it to `public` is exactly the mistake this replaced.
 */
function schemaBindings(src) {
  const out = new Map()
  for (const match of src.matchAll(SCHEMA_BINDING_RE)) out.set(match[1], match[2])
  return out
}

function extractTables(src) {
  const bindings = schemaBindings(src)
  const out = new Map()
  for (const match of src.matchAll(TABLE_OPEN_RE)) {
    const qualifier = match[1]
    const table = match[2]
    // `pgTable(...)` has no qualifier and is the `public` schema, which is what Drizzle does with it.
    const schema = qualifier === undefined ? 'public' : bindings.get(qualifier)
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
    out.set(table, { schema, cols })
  }
  return out
}

const declared = new Map() // "schema.table" -> Set(column)
const unresolved = []
for (const dir of MIRROR_DIRS) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8')
    for (const [table, { schema, cols }] of extractTables(src)) {
      if (schema === undefined) {
        unresolved.push(
          `${join(dir, file)}: table "${table}" is qualified by a name that is not a ` +
            'pgSchema(...) binding in the same file, so this gate cannot tell which Postgres schema ' +
            'it belongs to',
        )
        continue
      }
      declared.set(`${schema}.${table}`, cols)
    }
  }
}

if (unresolved.length > 0) {
  console.error(`Schema drift — ${unresolved.length} mirror(s) whose schema could not be resolved:`)
  for (const problem of unresolved) console.error(`  ${problem}`)
  process.exit(1)
}

if (declared.size === 0) {
  console.error('No table definitions found in any mirror directory. Refusing to report success.')
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

/*
 * pg_catalog rather than information_schema, for two reasons and both of them were live.
 *
 * **A partition is a table.** `relispartition` is the only honest way to say "not one of those", and
 * information_schema does not expose it. This used to be a NAME pattern — `audit_event_\d{4}_\d{2}$` —
 * which worked for the one partitioned table that existed and would have needed a second line per new one:
 * A-FIRST-01 adds `analytics.event` and `analytics.funnel_step`, whose partitions are created monthly by a
 * cron, so the name list would have gone stale on the first of a month rather than at a commit. A partition
 * is never separately mirrored; its parent is enumerated in its own right and the mirror applies to both.
 *
 * **And information_schema is filtered to what the CURRENT ROLE holds a privilege on**, which is the trap
 * `privacy-coverage.ts` records paying for: a schema the connecting role cannot see reads as a schema with
 * no tables, and every mirror for it would be reported as declared-but-missing — or, worse, its absence
 * from the database would go unreported. pg_catalog is not privilege-filtered.
 */
const rows = psql(`
  select n.nspname || '.' || c.relname as qualified, a.attname as column_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  where n.nspname in (${OWNED_SCHEMAS.map((s) => `'${s}'`).join(', ')})
    and c.relkind in ('r', 'p')
    and not c.relispartition
  order by n.nspname, c.relname, a.attnum
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

/*
 * Partitions are excluded by the query above (`not c.relispartition`) rather than by name, so nothing here
 * has to know that `audit_event`, `analytics.event` and `analytics.funnel_step` are partitioned or that a
 * cron adds a partition to the last two every month.
 *
 * `IGNORED_TABLES` is kept and is belt-and-braces rather than load-bearing: `relkind in ('r', 'p')` already
 * excludes the view it names, and it is retained so that widening the query to include one does not
 * silently start demanding a mirror for it.
 */
const ignorable = (qualified) => IGNORED_TABLES.has(qualified.replace(/^[a-z_]+\./, ''))
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

#!/usr/bin/env node
/**
 * Applies every migration, in order, to the database the integration suite is about to use.
 *
 * ## Why this exists
 *
 * CI created `berelax_test` from the PostgreSQL service container and then ran the integration suite
 * against it **without ever applying a migration**. The only migration step, `pnpm db:migrate:dry`, runs
 * afterwards and into a throwaway database it drops, so it proves the migrations apply somewhere and
 * says nothing about the database the tests use. Every integration file would have failed in CI on an
 * empty schema — and nobody had seen it, because every local run and every agent worktree applies the
 * migrations by hand first, exactly as `docs/CONTRIBUTING-AGENT-BRIEF.md` instructs.
 *
 * ## Why it refuses a database that is not empty, rather than trying to be idempotent
 *
 * The migrations are deliberately not idempotent — `migrate-dry-run.mjs` says so: "a non-idempotent
 * migration must be numbered and applied once, which the runner enforces rather than the file." There is
 * no applied-migrations table to consult, so a re-run cannot know where to resume. The first version of
 * this script tried to tolerate a second run by treating "already exists" as "already applied", and the
 * second run failed on `0011` with `column "open_time" of relation "premises_closure" does not exist` —
 * a half-applied migration reported as a skip, which is the worst of the three outcomes.
 *
 * So the contract is narrow and checkable: an empty `public` schema in, the current schema out. CI creates
 * the database fresh in a service container, which is exactly that case. A second run fails immediately
 * with a message saying what to do instead, rather than part-way through with a confusing one.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = 'packages/db/migrations'
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

if (!url) {
  console.error('TEST_DATABASE_URL or DATABASE_URL is required to apply migrations.')
  process.exit(1)
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

if (migrations.length === 0) {
  // An empty directory is not "nothing to do": it means the glob is wrong, and reporting success would
  // hand the suite an empty schema with a green step above it. ADR 0002's failure mode.
  console.error(`No migrations found in ${MIGRATIONS_DIR} — refusing to report success.`)
  process.exit(1)
}

const psql = (args) =>
  execFileSync('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', url, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const target = new URL(url).pathname.replace(/^\//, '')

const [{ n: existing } = { n: '0' }] = JSON.parse(
  psql([
    '-t',
    '-A',
    '-c',
    'select json_agg(row_to_json(t)) from (select count(*)::text as n from information_schema.tables ' +
      "where table_schema = 'public' and table_type = 'BASE TABLE') t",
  ]).trim() || '[{"n":"0"}]',
)

if (existing !== '0') {
  console.error(
    `${target} already holds ${existing} table(s) in the public schema. This script applies every ` +
      'migration from nothing and cannot resume part-way — there is no applied-migrations table to ' +
      'consult. Drop and recreate the database, or leave it alone if it is already current.',
  )
  process.exit(1)
}

console.log(`Applying ${migrations.length} migration(s) to ${target}`)
for (const file of migrations) {
  try {
    psql(['-f', join(MIGRATIONS_DIR, file)])
  } catch (err) {
    console.error(`\n${file} failed:\n${err.stdout ?? ''}${err.stderr ?? ''}`)
    process.exit(1)
  }
}
console.log(`Schema is current: ${migrations.length} migration(s) applied to ${target}`)

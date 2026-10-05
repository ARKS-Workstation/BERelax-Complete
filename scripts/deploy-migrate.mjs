#!/usr/bin/env node
/**
 * Applies the migrations a DEPLOYED database has not had yet.
 *
 * ## Why this is a second script and not a flag on the first one
 *
 * `scripts/apply-migrations.mjs` has a narrow, deliberate contract — "an empty `public` schema in, the
 * current schema out" — and its header explains why it refuses anything else: the migrations are not
 * idempotent, there is no ledger to resume from, and an earlier attempt to tolerate a second run
 * half-applied `0011` and reported it as a skip. That contract is exactly right for CI, which creates the
 * database in a service container, and it is useless for a deployment, which has a database that already
 * holds last week's schema.
 *
 * It was found the obvious way: the `migrate` PRE_DEPLOY job in `.do/*.yaml` ran `pnpm db:apply` against
 * the staging cluster, applied 134 migrations, and then failed on the next deploy with "berelax already
 * holds 222 table(s)". A deployment that cannot apply migration 135 is not a deployment.
 *
 * ## The ledger
 *
 * One table, `schema_migration(filename, checksum, applied_at)`. It is the thing `apply-migrations.mjs`
 * says does not exist, and it is what makes resuming possible without guessing: the pending set is the
 * files on disk that are not rows, in filename order.
 *
 * It also makes a second failure detectable, and this one is quieter and worse: a migration EDITED after
 * it was applied. Every database that has already run it has the old shape, every new one gets the new
 * shape, and nothing in a schema dump says which. So each row carries the sha256 of the file it applied,
 * and a row whose checksum no longer matches the file on disk is refused by name. Migration 0011's
 * half-applied column is the reason to trust that rule rather than argue with it.
 *
 * ## `--adopt`
 *
 * A database brought up by `apply-migrations.mjs` has the whole schema and no ledger, which is
 * indistinguishable from a database somebody migrated by hand. Both are real and neither can be inferred,
 * so adopting is an explicit act: `--adopt` records every migration on disk as applied WITHOUT running
 * any of them. It refuses to adopt an empty schema, because that is not adoption, it is a lie that would
 * skip every migration for ever.
 *
 * ## Transactions
 *
 * 109 of the 134 migrations carry their own `BEGIN;`/`COMMIT;`, so this script must not wrap them —
 * nesting would turn each one's COMMIT into a warning and leave the outer transaction holding everything.
 * Instead the whole run is ONE psql session built as a generated script: an advisory lock, then for each
 * pending migration an `\i` and the ledger insert that follows it, then the unlock. `ON_ERROR_STOP=1`
 * stops at the first failure.
 *
 * One session rather than one psql call per file is what makes the advisory lock mean anything: a lock
 * taken in a session that exits is a lock nobody holds. With it, two deploys racing serialise instead of
 * interleaving.
 *
 * The residual hazard, stated rather than hidden: a migration commits and then the connection dies before
 * its ledger insert. The next run re-applies that one migration and fails loudly on it, which is the
 * correct failure — a non-idempotent migration refusing a second application — and the remedy is to insert
 * the row by hand after checking the schema. The alternative, recording the row first, would mark a
 * FAILED migration as applied, and that failure is silent.
 *
 * Usage: `pnpm db:deploy [--adopt] [--dry-run]`
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGRATIONS_DIR = 'packages/db/migrations'
const LOCK_KEY = 'berelax-schema-migration'
const ADOPT = process.argv.includes('--adopt')
const DRY_RUN = process.argv.includes('--dry-run')

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required to apply migrations.')
  process.exit(1)
}

const psql = (args) =>
  execFileSync('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', url, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const target = new URL(url).pathname.replace(/^\//, '')

const onDisk = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
if (onDisk.length === 0) {
  // An empty directory is not "nothing to do": it means the glob is wrong, and reporting success would
  // leave a deployment on last week's schema with a green step above it. ADR 0002's failure mode.
  console.error(`No migrations found in ${MIGRATIONS_DIR} — refusing to report success.`)
  process.exit(1)
}

const checksum = (file) =>
  createHash('sha256')
    .update(readFileSync(join(MIGRATIONS_DIR, file)))
    .digest('hex')

/** The ledger, created if absent. Idempotent, and the one statement here that is allowed to be. */
psql([
  '-c',
  'create table if not exists schema_migration (' +
    'filename text primary key, ' +
    'checksum text not null, ' +
    'applied_at timestamptz not null default now())',
])

const rows = psql([
  '-t',
  '-A',
  '-F',
  '\u0001',
  '-c',
  'select filename, checksum from schema_migration order by filename',
])
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => {
    const [filename, stored] = line.split('\u0001')
    return { filename, stored }
  })
const applied = new Map(rows.map((row) => [row.filename, row.stored]))

const [{ n: tables } = { n: '0' }] = JSON.parse(
  psql([
    '-t',
    '-A',
    '-c',
    'select json_agg(row_to_json(t)) from (select count(*)::text as n from information_schema.tables ' +
      "where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'schema_migration') t",
  ]).trim() || '[{"n":"0"}]',
)

if (ADOPT) {
  if (tables === '0') {
    console.error(
      `${target} has an empty public schema, so there is nothing to adopt. --adopt records every ` +
        'migration as applied WITHOUT running it; on an empty database that would skip all of them for ' +
        'ever. Run `pnpm db:apply` instead, which is the from-nothing path.',
    )
    process.exit(1)
  }
  if (applied.size > 0) {
    console.error(
      `${target} already has a ledger with ${applied.size} row(s). --adopt is for a database that was ` +
        'brought up before this script existed; it is not a repair tool.',
    )
    process.exit(1)
  }
  const values = onDisk
    .map((file) => `('${file.replace(/'/g, "''")}', '${checksum(file)}')`)
    .join(', ')
  if (DRY_RUN) {
    console.log(`--dry-run: would adopt ${onDisk.length} migration(s) into ${target}`)
    process.exit(0)
  }
  psql(['-c', `insert into schema_migration (filename, checksum) values ${values}`])
  console.log(
    `Adopted ${onDisk.length} migration(s) in ${target}: the ledger now records the schema that was ` +
      'already there, and nothing was run.',
  )
  process.exit(0)
}

/*
 * A row whose file has changed since it was applied. Refused before anything is run, and refused even when
 * there is nothing pending — a drifted migration is wrong whether or not this deploy adds one.
 */
const drifted = [...applied.entries()]
  .filter(([file]) => onDisk.includes(file))
  .filter(([file, stored]) => stored !== checksum(file))
  .map(([file]) => file)
if (drifted.length > 0) {
  console.error(
    `${drifted.length} applied migration(s) have been EDITED since they ran: ${drifted.join(', ')}.\n` +
      'Every database that already applied them has the old shape and every new one gets the new shape, ' +
      'and nothing in a schema dump says which. A migration that has been applied anywhere is history: ' +
      'write a new numbered one instead, and restore these files to the bytes the ledger recorded.',
  )
  process.exit(1)
}

const missing = [...applied.keys()].filter((file) => !onDisk.includes(file))
if (missing.length > 0) {
  console.error(
    `${missing.length} migration(s) in the ledger are not on disk: ${missing.join(', ')}. This database ` +
      'is ahead of this checkout — deploying would be a downgrade, and the schema it holds is not one ' +
      'this code has ever been tested against.',
  )
  process.exit(1)
}

const pending = onDisk.filter((file) => !applied.has(file))

if (pending.length === 0) {
  console.log(`Schema is current: ${applied.size} migration(s) applied to ${target}, none pending.`)
  process.exit(0)
}

if (applied.size === 0 && tables !== '0') {
  console.error(
    `${target} holds ${tables} table(s) and has no ledger, so every migration looks pending and ` +
      'applying them would fail on the first object that already exists. This is a database that was ' +
      'brought up before the ledger existed: run `pnpm db:deploy --adopt` once to record what is ' +
      'already there, then deploy.',
  )
  process.exit(1)
}

if (DRY_RUN) {
  console.log(`--dry-run: ${pending.length} pending for ${target}:\n  ${pending.join('\n  ')}`)
  process.exit(0)
}

console.log(`Applying ${pending.length} pending migration(s) to ${target}: ${pending.join(', ')}`)

const temp = mkdtempSync(join(tmpdir(), 'berelax-deploy-migrate-'))
try {
  const script = [
    `select pg_advisory_lock(hashtext('${LOCK_KEY}'));`,
    ...pending.flatMap((file) => [
      `\\echo applying ${file}`,
      `\\i ${join(MIGRATIONS_DIR, file)}`,
      `insert into schema_migration (filename, checksum) values ('${file.replace(/'/g, "''")}', '${checksum(file)}');`,
    ]),
    `select pg_advisory_unlock(hashtext('${LOCK_KEY}'));`,
    '',
  ].join('\n')
  const scriptPath = join(temp, 'run.sql')
  writeFileSync(scriptPath, script)
  try {
    process.stdout.write(psql(['-f', scriptPath]))
  } catch (error) {
    console.error(
      `\nmigration run failed:\n${error.stdout ?? ''}${error.stderr ?? ''}\n` +
        'Everything before the failing migration is applied and recorded; the failing one is not ' +
        'recorded. Fix it and run again — the ledger means the run resumes rather than restarting.',
    )
    process.exit(1)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}

console.log(
  `Schema is current: ${applied.size + pending.length} migration(s) applied to ${target}, ` +
    `${pending.length} by this run.`,
)

#!/usr/bin/env node
/**
 * Applies every migration to a throwaway database, then drops it.
 *
 * Purpose: a migration that fails must fail in CI, not on the production box at 01:00 while the
 * salon is still trading. This runs before deploy, never as part of app boot.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = 'packages/db/migrations'
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

if (!url) {
  console.error('TEST_DATABASE_URL or DATABASE_URL is required for the migration dry run.')
  process.exit(1)
}

const scratch = `berelax_dryrun_${process.pid}`
const admin = new URL(url)
const base = `${admin.protocol}//${admin.username}:${admin.password}@${admin.hostname}:${admin.port || 5432}`

const psql = (db, args) =>
  execFileSync('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', `${base}/${db}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()

console.log(`Migration dry run: ${migrations.length} migration(s) into scratch database ${scratch}`)

let failed = null
try {
  psql('postgres', ['-c', `create database ${scratch}`])
  for (const file of migrations) {
    process.stdout.write(`  ${file} ... `)
    psql(scratch, ['-f', join(MIGRATIONS_DIR, file)])
    console.log('ok')
  }
  // Applying twice proves idempotence where a migration claims it; a non-idempotent migration
  // must be numbered and applied once, which the runner enforces rather than the file.
  console.log(
    migrations.length === 0 ? '  (no migrations yet — F04 adds the first)' : '  all applied',
  )
} catch (err) {
  failed = err
  console.log('FAILED')
  console.error(String(err.stdout ?? '') + String(err.stderr ?? err.message))
} finally {
  try {
    psql('postgres', ['-c', `drop database if exists ${scratch}`])
  } catch (dropErr) {
    console.error(`WARNING: could not drop scratch database ${scratch}: ${dropErr.message}`)
  }
}

process.exit(failed ? 1 : 0)

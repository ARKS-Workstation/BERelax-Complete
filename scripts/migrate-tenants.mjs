#!/usr/bin/env node
/**
 * Runs `pnpm deploy:migrate` once per tenant, and reports the whole estate.
 *
 * ADR 0129 makes each tenant an isolated instance with its own database. The consequence it names is that
 * "every release runs `pnpm deploy:migrate` once per tenant", and that the failure worth designing for is
 * **a migration that succeeds on tenant 1 and fails on tenant 7** — a split estate, where half the
 * instances are on schema 135 and half on 134. That is a worse state than one failed deploy, because
 * nothing about either half looks wrong from inside it.
 *
 * ## Why the filesystem is the tenant directory
 *
 * A tenant is a directory under `/srv/berelax/<slug>/` holding a `.env`. There is no registry file, and
 * that is the decision: a registry is a second statement of which tenants exist, and the day it disagrees
 * with the filesystem is the day a tenant is skipped silently. A directory with no `.env` is not a
 * tenant, is reported as such, and does not count towards the floor below.
 *
 * It is also what keeps ADR 0129's third rule true — *the CRM never learns that other tenants exist*.
 * This directory is operator-side. No application code reads it, and nothing here is reachable from a
 * request.
 *
 * ## It does NOT stop at the first failure
 *
 * The obvious shape — exit on the first non-zero — tells you tenant 7 broke and nothing about tenants 8
 * to 20. After a release you need the shape of the whole estate, because the decision you are about to
 * take is "roll forward or roll back", and that depends on how many instances are on which schema. So
 * every tenant is attempted, every result is printed, and the exit code is non-zero if any failed.
 *
 * `--stop-on-failure` is available for the case where you are deliberately rolling out to one tenant
 * first, and it is not the default for the reason above.
 *
 * ## It refuses to report success over an empty estate
 *
 * ADR 0002's subject. "0 tenants, 0 failures" reads exactly like a clean run, and it is the output of a
 * wrong `--root`, a typo, or a directory that was never populated. A run that found no tenant exits
 * non-zero and says which path it looked in.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = (() => {
  const flag = process.argv.findIndex((a) => a === '--root')
  if (flag !== -1 && process.argv[flag + 1] !== undefined) return process.argv[flag + 1]
  return process.env['BERELAX_TENANT_ROOT'] ?? '/srv/berelax'
})()

const ONLY = (() => {
  const flag = process.argv.findIndex((a) => a === '--only')
  return flag !== -1 ? (process.argv[flag + 1] ?? null) : null
})()

const DRY_RUN = process.argv.includes('--dry-run')
const STOP_ON_FAILURE = process.argv.includes('--stop-on-failure')

/**
 * One tenant's `.env`, as a map, with no shell semantics.
 *
 * Deliberately NOT sourced through a shell: a `.env` is read as data here, so a value containing `$(` or
 * a backtick is a string rather than a command. The file is written by `provision-tenant.mjs` and edited
 * by hand on a server, which is exactly the combination that eventually contains something surprising.
 */
function readEnvFile(path) {
  const env = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

function discover() {
  if (!existsSync(ROOT)) {
    console.error(`No tenant root at ${ROOT} — refusing to report success over nothing.`)
    console.error('Pass --root <path>, or set BERELAX_TENANT_ROOT.')
    process.exit(1)
  }
  const tenants = []
  const skipped = []
  for (const name of readdirSync(ROOT).sort()) {
    const dir = join(ROOT, name)
    if (!statSync(dir).isDirectory()) continue
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) {
      skipped.push({ slug: name, why: 'no .env' })
      continue
    }
    const env = readEnvFile(envPath)
    if (env['DATABASE_URL'] === undefined || env['DATABASE_URL'] === '') {
      skipped.push({ slug: name, why: '.env has no DATABASE_URL' })
      continue
    }
    tenants.push({ slug: name, dir, env })
  }
  return { tenants, skipped }
}

const { tenants, skipped } = discover()

for (const row of skipped) {
  // Printed, never silent. A directory that looks like a tenant and is not is the thing most likely to
  // mean somebody's provisioning half-finished.
  console.warn(`  SKIP     ${row.slug} — ${row.why}`)
}

const selected = ONLY === null ? tenants : tenants.filter((t) => t.slug === ONLY)

if (ONLY !== null && selected.length === 0) {
  console.error(`--only ${ONLY}: no tenant with that slug under ${ROOT}.`)
  process.exit(1)
}

if (selected.length === 0) {
  console.error(
    `No tenant found under ${ROOT} — refusing to report success. "0 tenants, 0 failures" reads ` +
      'exactly like a clean run, and it is what a wrong --root produces.',
  )
  process.exit(1)
}

console.log(`Migrating ${selected.length} tenant(s) from ${ROOT}`)

const results = []
for (const tenant of selected) {
  if (DRY_RUN) {
    console.log(`  WOULD RUN ${tenant.slug}`)
    results.push({ slug: tenant.slug, status: 'would-run' })
    continue
  }
  const started = Date.now()
  try {
    /*
     * The tenant's env, and the AMBIENT environment deliberately not inherited wholesale.
     *
     * An operator who exported DATABASE_URL in their shell to look at one tenant would otherwise migrate
     * every tenant into that one database, and the ledger would make most of them look like no-ops
     * afterwards. So the child gets PATH and HOME — pnpm and node need them — plus this tenant's own
     * file, and nothing else.
     */
    execFileSync('pnpm', ['deploy:migrate'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        ...tenant.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`  OK       ${tenant.slug} (${seconds}s)`)
    results.push({ slug: tenant.slug, status: 'ok' })
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
    console.error(`  FAILED   ${tenant.slug}`)
    for (const line of output.split('\n').slice(-12)) console.error(`             ${line}`)
    results.push({ slug: tenant.slug, status: 'failed' })
    if (STOP_ON_FAILURE) {
      console.error('--stop-on-failure: not attempting the remaining tenants.')
      break
    }
  }
}

const failed = results.filter((r) => r.status === 'failed')
const ok = results.filter((r) => r.status === 'ok')

if (failed.length === 0) {
  console.log(`All ${results.length} tenant(s) migrated.`)
  process.exit(0)
}

/*
 * The split, named as such.
 *
 * This is the sentence the whole script exists to be able to print. "3 of 20 failed" is the state that
 * decides whether to roll forward or back, and an operator reading a wall of per-tenant output at 2am
 * should not have to count.
 */
console.error(
  `\nSPLIT ESTATE: ${ok.length} tenant(s) migrated, ${failed.length} did not — ` +
    `${failed.map((r) => r.slug).join(', ')}.`,
)
console.error(
  'Those instances are on the previous schema and the rest are not. Migrations apply forward only ' +
    '(`db:deploy` refuses a database ahead of the checkout), so the way out is forward: fix the cause ' +
    'and re-run — it is a no-op on the tenants that already succeeded.',
)
process.exit(1)

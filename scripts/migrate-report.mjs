#!/usr/bin/env node
/**
 * Prints the migration reconciliation report, and exits non-zero on an unexplained variance.
 *
 * ```
 * tsx scripts/migrate-report.mjs                                   # the human-readable form
 * tsx scripts/migrate-report.mjs --json                            # the machine-readable form
 * tsx scripts/migrate-report.mjs --out artifacts/migration/run-1.json
 * ```
 *
 * ## It changes nothing, and that is checkable rather than claimed
 *
 * The command opens a connection, reads, prints and exits. There is no `withUnitOfWork` anywhere in it
 * and no importer is constructed, so there is no path through this file that can write — which is what
 * makes the first acceptance line a claim about the DATA: two runs produce byte-identical reports because
 * the first run cannot have changed what the second one reads.
 *
 * ## Exit codes
 *
 *   0  every variance is tied to a named cause.
 *   1  at least one variance is not. There is no tolerance and no rounding allowance: money is integer
 *      fils (ADR 0007) and an unattributable figure is a refusal rather than a zero (ADR 0070).
 *   2  the command could not run: no database, or a bad argument.
 */
import { writeFileSync } from 'node:fs'
import { createConnection } from '../packages/db/src/connection.ts'
import {
  generateReconciliationReport,
  reconciliationExitStatus,
  recordReconciliationRun,
} from '../packages/migration/src/report/generate.ts'
import { renderReconciliationRun } from '../packages/migration/src/report/render.ts'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}
const has = (name) => argv.includes(`--${name}`)

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error('TEST_DATABASE_URL or DATABASE_URL is required to read the reconciliation.')
  process.exit(2)
}

const sql = createConnection({ url, max: 4 })
let status = 2
try {
  const report = await generateReconciliationReport(sql)
  // The instant is taken HERE, outside the report, and is the only non-deterministic value in the
  // artefact. Taking it inside `generateReconciliationReport` is the mistake this whole arrangement is
  // against: the report would then be uncomparable across runs on the one field whose difference proves
  // nothing.
  const run = recordReconciliationRun(report, new Date())

  const out = flag('out')
  if (out) {
    writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`)
    console.log(`Reconciliation run written to ${out}`)
  }
  if (has('json') || !out) {
    console.log(has('json') ? JSON.stringify(run, null, 2) : renderReconciliationRun(run))
  }
  status = reconciliationExitStatus(report)
} finally {
  await sql.end({ timeout: 5 })
}

process.exit(status)

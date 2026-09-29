#!/usr/bin/env node
/**
 * Runs one registered importer over one source file, or rehearses it.
 *
 * ```
 * tsx scripts/migrate-import.mjs --list
 * tsx scripts/migrate-import.mjs --importer probe --file path/to/file.tsv --dry-run
 * tsx scripts/migrate-import.mjs --importer probe --file path/to/file.tsv --actor "front desk" \
 *   --report artifacts/migration/probe.json
 * ```
 *
 * ## What this script is and is not
 *
 * It is a thin door onto {@link runImport}. Every property H-MIG-01 is about — resumability, idempotence,
 * provenance, the rehearsal that changes nothing — is in the framework and is proved by
 * `packages/migration/src/framework.itest.ts` against a real database. Putting any of it here would put it
 * outside every test that matters, and would also mean the importers a later unit drives from a job or a
 * screen did not get it.
 *
 * **There is no `--resume`.** Resuming is what this does: an open live run for the same importer and the same
 * file is continued rather than replaced. A flag would be a way to get it wrong — an import that has to be
 * told to resume is an import somebody re-runs instead, and ZY191 then refuses it at the least helpful
 * moment. There is no `--force` either, for the same reason: the remedy for an open run is to finish it.
 *
 * **`--actor` is required for a live run** and is whatever the person running it types. It is recorded on the
 * run and on every audit row, so "who imported this figure" has an answer. It is deliberately not defaulted
 * to a plausible-looking name: a provisional value that reads like a configured one is worse than a missing
 * one (brief rule 15), and refusing is what makes somebody type the true answer.
 *
 * **The exit code is the verdict.** Non-zero when any row was rejected, because a run that refused a row
 * imported nothing and the next thing to happen is a correction to the spreadsheet — and a zero exit there
 * would be read by a person, or a script, as "imported".
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from '../packages/db/src/connection.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import { importerByName, importerNames } from '../packages/migration/src/registry.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const present = (name) => process.argv.includes(`--${name}`)

if (present('list')) {
  console.log(`Registered importers: ${importerNames().join(', ')}`)
  process.exit(0)
}

const name = flag('importer')
const file = flag('file')
const mode = present('dry-run') ? 'dry-run' : 'live'
const actor = flag('actor')

if (!name || !file) {
  console.error(
    'Usage: tsx scripts/migrate-import.mjs --importer <name> --file <path> [--dry-run] ' +
      '[--actor <label>] [--report <path>]\n' +
      `Registered importers: ${importerNames().join(', ')}`,
  )
  process.exit(2)
}
if (mode === 'live' && !actor) {
  console.error(
    '--actor is required for a live import. It is recorded on the run and on every audit row, so that ' +
      '"who imported this figure" has an answer — and it is not defaulted, because a plausible-looking ' +
      'value is indistinguishable from a true one.',
  )
  process.exit(2)
}

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required.')
  process.exit(2)
}

// The BYTES, hashed as they are. The text is decoded separately for the parser: the file's identity is what
// arrived, not what a decoder made of it.
const bytes = readFileSync(file)
const sql = createConnection({ url, max: 2 })
let report
try {
  report = await runImport({
    sql,
    importer: importerByName(name),
    sourceFile: file,
    sourceText: bytes.toString('utf8'),
    sourceBytes: bytes,
    mode,
    actor: { kind: 'system', label: actor ?? 'dry-run rehearsal' },
  })
} finally {
  await sql.end({ timeout: 5 })
}

const reportPath = flag('report')
if (reportPath) {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Report written to ${reportPath}`)
} else {
  console.log(JSON.stringify(report, null, 2))
}

console.log(
  `${report.mode} ${report.state}: ${report.applied} applied, ${report.skipped} skipped, ` +
    `${report.rejected} rejected, ${report.pending} pending — run ${report.runId}` +
    `${report.committed ? '' : ' (rolled back: nothing was changed)'}`,
)
for (const rejection of report.rejections) {
  console.log(`  rejected  ${report.sourceFile}:${rejection.lineNumber}  ${rejection.reason}`)
}

process.exit(report.rejected > 0 || report.state === 'failed' ? 1 : 0)

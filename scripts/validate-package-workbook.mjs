#!/usr/bin/env node
/**
 * Validates a filled outstanding-package reconstruction workbook. The exit code is the verdict.
 *
 * ```
 * tsx scripts/validate-package-workbook.mjs --file artifacts/migration/packages.tsv
 * tsx scripts/validate-package-workbook.mjs --file packages.tsv --report artifacts/migration/packages.json
 * ```
 *
 * ## Why this is not `scripts/migrate-import.mjs --dry-run`
 *
 * It will be, and that is H-MIG-03's. A dry run needs an `ImporterDefinition`, an importer needs an `apply`,
 * and `apply` for this importer writes `package_sale`, `package_balance` and the opening deferred-revenue
 * liability — which is H-MIG-03's whole unit and its acceptance. Registering an importer here whose `apply`
 * threw would put an unrunnable entry in `IMPORTERS`, and the registry exists so that a person can enumerate
 * what can be run.
 *
 * What CAN be done before that exists is the half that has to happen first anyway: the file is judged, every
 * bad line is named, and nothing is written. `packages/migration/src/importers/packages/validate.ts` is the
 * one implementation, so when H-MIG-03 composes it into an importer the rules do not move and this command
 * keeps agreeing with the import.
 *
 * ## Exit codes
 *
 *   0  every row validates. Nothing has been written — this command reads.
 *   1  at least one row was rejected, or the file itself was refused. The report names every rejected line
 *      as `<file>:<line>  <reason>`, because the next thing to happen is a correcting pass over the
 *      spreadsheet and a zero exit there would be read as "imported".
 *   2  the command could not run: no file, no database.
 *
 * A rejected row makes this exit non-zero even though nothing was attempted, and the reason is the one
 * H-MIG-02's acceptance states: the artefacts are liabilities, so the file is all-or-nothing. A partially
 * valid workbook is not a partial import, it is a workbook to correct.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createConnection } from '../packages/db/src/connection.ts'
import { readPackageTemplateKeys } from '../packages/db/src/settings/package-templates.ts'
import {
  formatWorkbookRejections,
  validatePackageWorkbook,
} from '../packages/migration/src/importers/packages/validate.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

const file = flag('file')
if (!file) {
  console.error(
    'Usage: tsx scripts/validate-package-workbook.mjs --file <path> [--report <path>]\n' +
      'Generate a blank workbook with tsx scripts/gen-package-workbook.mjs.',
  )
  process.exit(2)
}

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error(
    'DATABASE_URL is required: a row may only name a package_template the database holds, and the ' +
      'validator refuses to guess which those are.',
  )
  process.exit(2)
}

// The BYTES, decoded for the parser exactly as `migrate-import.mjs` does it. The file's identity is what
// arrived; what a decoder made of it is a separate thing and is not what a sign-off attests to.
const bytes = readFileSync(file)
const sql = createConnection({ url, max: 2 })
let templates
try {
  templates = await readPackageTemplateKeys(sql)
} finally {
  await sql.end({ timeout: 5 })
}

let report
try {
  report = validatePackageWorkbook({
    sourceFile: file,
    sourceText: bytes.toString('utf8'),
    templates,
  })
} catch (error) {
  // A refusal of the FILE rather than of a row: a header nobody may edit, or a workbook with no rows at all.
  // Reported here and not as a rejection, because neither can be attributed to a line a person typed.
  console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const reportPath = flag('report')
if (reportPath) {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Report written to ${reportPath}`)
}

for (const line of formatWorkbookRejections(report)) console.log(`  rejected  ${line}`)

console.log(
  `${report.ok ? 'clean' : 'REFUSED'}: ${report.rows} row(s), ${report.accepted} accepted, ` +
    `${report.rejections.length} rejected. ${report.totalPricePaidFils} fils paid across ` +
    `${report.totalSessionsRemaining} remaining session(s); ${report.attested} row(s) rest on the owner's ` +
    'attestation alone.',
)
if (!report.ok) {
  console.log(
    'Nothing would be imported. A package liability that half-imported is a deferred-revenue figure ' +
      'nobody can reconcile, so the whole file is refused and every bad line is named above.',
  )
}
process.exit(report.ok ? 0 : 1)

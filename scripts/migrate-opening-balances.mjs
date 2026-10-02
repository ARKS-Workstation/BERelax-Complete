/**
 * The door a person imports an opening trial balance through (H-MIG-07).
 *
 *   tsx scripts/migrate-opening-balances.mjs --template > opening.tsv
 *   tsx scripts/migrate-opening-balances.mjs --file opening.tsv --plan
 *   tsx scripts/migrate-opening-balances.mjs --file opening.tsv --dry-run
 *   tsx scripts/migrate-opening-balances.mjs --file opening.tsv --actor "owner" --report opening.json
 *
 * ## Why this is a script and not a `registry.ts` entry
 *
 * `IMPORTERS` is a module-level frozen array, so a registered importer cannot have read anything when it
 * is constructed. This one needs `openingRemainder` from `@berelax/core`, which `packages/migration` may
 * not import, and there is no default for it on purpose: an identity remainder would post the stated
 * figure on top of H-MIG-03's reconstructed package liability — both post on
 * `journal_entry.source = 'opening_balance'` — and the books would still balance afterwards, which 0027
 * names as the failure nobody detects.
 *
 * ## This is the one import that cannot be corrected by re-running it
 *
 * Once it has run, `opening_balance_import` is unique on (legal_entity_id, opening_date), the attestation
 * is append-only (ZY384), and nothing may ever be dated behind the boundary (ZY381, ZY383, ZL004). A
 * correction is a dated reversal plus a fresh import at a NEW boundary. So `--dry-run` is not a nicety
 * here: it stages, validates, applies and rolls back with the deferred constraints FORCED, which is the
 * only rehearsal of this import that exists.
 *
 * ## `--plan` touches nothing and `--provisional` is explicit
 *
 * `--plan` reads the file, adds the two columns up and prints the imbalance if there is one. It opens no
 * connection. `--provisional <open-question-id>` marks the attestation as the build's assumption rather
 * than the owner's answer, which is what the Unconfirmed Assumptions panel reads — 0027 refuses a
 * provisional row that names no question, so the flag takes the id rather than being a bare switch.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { openingRemainder } from '../packages/core/src/ledger/period-lock.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import {
  buildOpeningWorkbook,
  openingBalancesImporter,
  parseOpeningWorkbook,
} from '../packages/migration/src/importers/ledger/index.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const present = (name) => process.argv.includes(`--${name}`)

if (present('template')) {
  // To stdout, so `> opening.tsv` is the whole of it. The file is the same bytes every time, because the
  // identity of a source file in this build is the sha-256 of its bytes (H-MIG-01).
  process.stdout.write(buildOpeningWorkbook())
  process.exit(0)
}

const file = flag('file')
if (!file) {
  console.error(
    'Usage: tsx scripts/migrate-opening-balances.mjs --template\n' +
      '       tsx scripts/migrate-opening-balances.mjs --file <path> [--plan]\n' +
      '       tsx scripts/migrate-opening-balances.mjs --file <path> [--dry-run] [--actor <label>] ' +
      '[--provisional <open-question-id>] [--report <path>]',
  )
  process.exit(2)
}

const mode = present('dry-run') ? 'dry-run' : 'live'
const actor = flag('actor')
if (mode === 'live' && !actor) {
  console.error(
    '--actor is required for a live import. It is recorded on the attestation, on the run and on every ' +
      'audit row, so "who signed this opening position off" has an answer — and it is deliberately not ' +
      'defaulted to a plausible-looking label (brief rule 15).',
  )
  process.exit(2)
}

// The BYTES, hashed as they are. The text is decoded separately for the parser.
const bytes = readFileSync(file)
const sourceText = bytes.toString('utf8')

const provisionalQuestion = flag('provisional')
const options = {
  remainder: openingRemainder,
  importedBy: actor ?? 'dry-run rehearsal',
  ...(provisionalQuestion === undefined
    ? {}
    : {
        provisional: {
          openQuestionId: provisionalQuestion,
          note:
            'Imported from the reconstructed trial balance while the figures are the build’s ' +
            'assumption rather than the owner’s answer.',
        },
      }),
}

const cells = parseOpeningWorkbook(sourceText)
const debit = cells.reduce((sum, cell) => sum + cell.debitFils, 0)
const credit = cells.reduce((sum, cell) => sum + cell.creditFils, 0)
const planLines = [
  `${file}: ${cells.length} account(s)`,
  `  opening date(s): ${[...new Set(cells.map((cell) => cell.openingDate))].join(', ')}`,
  `  debits ${debit} fils, credits ${credit} fils` +
    (debit === credit ? ' — balanced' : `, OUT BY ${debit - credit} fils on the debit side`),
  '  what is already posted at the boundary is subtracted at import; the figures above are the',
  '  statement, which is what you check against the books you are copying from',
]
for (const line of planLines) console.log(line)

if (present('plan')) process.exit(debit === credit ? 0 : 1)

const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is required.')
  process.exit(2)
}

const sql = createConnection({ url, max: 2 })
let report
try {
  report = await runImport({
    sql,
    importer: openingBalancesImporter(options),
    sourceFile: file,
    sourceText,
    sourceBytes: bytes,
    mode,
    actor: { kind: 'system', label: actor ?? 'dry-run rehearsal' },
  })
} finally {
  await sql.end({ timeout: 5 })
}

const reportPath = flag('report')
if (reportPath) {
  writeFileSync(reportPath, `${JSON.stringify({ ...report, plan: planLines }, null, 2)}\n`)
  console.log(`Report written to ${reportPath}`)
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

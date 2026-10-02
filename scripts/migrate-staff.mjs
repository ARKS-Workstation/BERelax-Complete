/**
 * The door a person imports a reconstructed staff file through (H-MIG-06).
 *
 *   tsx scripts/migrate-staff.mjs --template > staff.tsv
 *   tsx scripts/migrate-staff.mjs --file staff.tsv --plan
 *   tsx scripts/migrate-staff.mjs --file staff.tsv --dry-run
 *   tsx scripts/migrate-staff.mjs --file staff.tsv --actor "owner" --report staff.json
 *
 * ## Why this is a script and not a `registry.ts` entry
 *
 * `IMPORTERS` is a module-level frozen array, so a registered importer cannot have read anything when it
 * is constructed. This one needs `leaveYearStart` from `@berelax/core`, which `packages/migration` may
 * not import, and there is no default for it on purpose: anchoring every imported balance to 1 January
 * would be a leave year the policy does not use for anybody not engaged on that date, and the symptom
 * would be a carry-over forfeited on the wrong day, months later, in a job nobody is watching.
 *
 * ## What this command cannot do
 *
 * There is no flag that fills in a gender, converts a leave balance or supplies a wage. A line with no
 * gender cell is quarantined, a balance stated in calendar days is quarantined, and there is no wage, no
 * bank and no identity column in the file at all — see `importers/staff/workbook.ts` for what each
 * absence is protecting against.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { leaveYearStart } from '../packages/core/src/hr/leave-accrual.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import {
  buildStaffWorkbook,
  planStaffFile,
  staffImporter,
} from '../packages/migration/src/importers/staff/index.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const present = (name) => process.argv.includes(`--${name}`)

if (present('template')) {
  // To stdout, so `> staff.tsv` is the whole of it. The file is the same bytes every time, because the
  // identity of a source file in this build is the sha-256 of its bytes (H-MIG-01).
  process.stdout.write(buildStaffWorkbook())
  process.exit(0)
}

const file = flag('file')
if (!file) {
  console.error(
    'Usage: tsx scripts/migrate-staff.mjs --template\n' +
      '       tsx scripts/migrate-staff.mjs --file <path> [--plan]\n' +
      '       tsx scripts/migrate-staff.mjs --file <path> [--dry-run] [--actor <label>] ' +
      '[--report <path>]',
  )
  process.exit(2)
}

const mode = present('dry-run') ? 'dry-run' : 'live'
const actor = flag('actor')
if (mode === 'live' && !actor) {
  console.error(
    '--actor is required for a live import. It is recorded on the run, on every audit row and on every ' +
      'leave movement, so "who imported this balance" has an answer — and it is deliberately not ' +
      'defaulted to a plausible-looking label (brief rule 15).',
  )
  process.exit(2)
}

/**
 * The leave-year anchor, injected: the one implementation of that policy is `@berelax/core`'s.
 *
 * It takes the policy's own `leaveYearStartsOnAnniversary` from the rule row the importer read inside
 * the transaction, so this wiring supplies the FUNCTION and never the policy.
 */
const anchor = ({ startsOnAnniversary, employedFrom, on }) =>
  leaveYearStart(
    {
      effectiveFrom: '1900-01-01',
      annualEntitlementDays: 30,
      monthlyAccrualHundredths: 250,
      probationMonths: 6,
      accruesDuringProbation: true,
      carryOverCapHundredths: 3000,
      carryOverExpiresAfterOneLeaveYear: false,
      leaveYearStartsOnAnniversary: startsOnAnniversary,
      unpaidLeaveReducesAccrual: true,
      absentDayReducesAccrual: true,
      sickLeave: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
    },
    employedFrom,
    on,
  )

// The BYTES, hashed as they are. The text is decoded separately for the parser.
const bytes = readFileSync(file)
const sourceText = bytes.toString('utf8')

const options = { leaveYearStart: anchor, importedBy: actor ?? 'dry-run rehearsal' }
const plan = planStaffFile(options, sourceText)
const planLines = [
  `${file}: ${plan.rows.length} line(s)`,
  `  ${plan.repeatedReferences.length} staff reference(s) named by more than one line: ` +
    `${plan.repeatedReferences.join(', ') || 'none'}`,
  `  ${plan.rejections.length} line(s) refused by the file's own rules: ` +
    `${plan.rejections.map((r) => `${r.lineNumber}=${r.reason}`).join(', ') || 'none'}`,
  '  the quarantines cannot be forecast here: every one of them is a question about the database',
]
for (const line of planLines) console.log(line)

if (present('plan')) process.exit(0)

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
    importer: staffImporter(options),
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

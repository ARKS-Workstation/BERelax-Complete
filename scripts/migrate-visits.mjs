/**
 * The door a person imports a reconstructed visit history through (H-MIG-05).
 *
 *   tsx scripts/migrate-visits.mjs --template > visits.tsv
 *   tsx scripts/migrate-visits.mjs --file visits.tsv --plan
 *   tsx scripts/migrate-visits.mjs --file visits.tsv --dry-run
 *   tsx scripts/migrate-visits.mjs --file visits.tsv --actor "front desk" --report visits.json
 *
 * ## Why this is a script and not a `registry.ts` entry
 *
 * `IMPORTERS` is a module-level frozen array, so a registered importer cannot have read anything when it
 * is constructed — H-MIG-03's registry note says so. This importer needs two things that cannot be in a
 * frozen array, and they are the SAME two H-MIG-04's does: the suppression PEPPER, which is a secret and
 * reaches the application through `packages/config` (a package `packages/migration` may not import), and
 * the phone normaliser from `@berelax/core` (which it may not import either).
 *
 * The digests have to be the ones H-MIG-04 already wrote, or `imported_appointment.contact_hmac` and
 * `imported_contact.contact_hmac` stop joining and every line quarantines as a customer this database has
 * never heard of. An entry built without the pepper would therefore either stage the plaintext number —
 * the one thing `0121_customer_import.sql` exists to prevent — or throw, and H-MIG-02 recorded why an
 * entry that cannot run is worse than no entry in a list a person is supposed to be able to enumerate and
 * run. So this file is where the two are wired, and it is the only place they are.
 *
 * ## `--plan` touches nothing
 *
 * It stages nothing and opens no connection. It reads the file, keys every cell and prints how many
 * visits it is about, how many lines name a number nothing can read, and which lines put one therapist in
 * two places at once. That is the output somebody wants before deciding to import at all.
 *
 * ## What this command cannot do
 *
 * There is no flag that posts anything. An imported visit writes no invoice, no payment and no journal
 * entry, so it changes no revenue figure, no VAT return and no balance: the period before this system
 * started is accounted for by H-MIG-07's opening balances, and counting these visits as well would count
 * it twice. There is also no flag that fills in a therapist or a room: a line that names one this
 * database does not hold is quarantined with the reason (ADR 0061, and 0130's own header).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { e164IdentityResult } from '../packages/core/src/identity/e164.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import { loadSuppressionPeppers } from '../packages/db/src/repositories/suppression.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import {
  buildVisitWorkbook,
  planVisitHistory,
  visitsImporter,
} from '../packages/migration/src/importers/appointments/index.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const present = (name) => process.argv.includes(`--${name}`)

if (present('template')) {
  // To stdout, so `> visits.tsv` is the whole of it. The file is the same bytes every time, because the
  // identity of a source file in this build is the sha-256 of its bytes and a stamped one could not be
  // attested to (H-MIG-01).
  process.stdout.write(buildVisitWorkbook())
  process.exit(0)
}

const file = flag('file')
if (!file) {
  console.error(
    'Usage: tsx scripts/migrate-visits.mjs --template\n' +
      '       tsx scripts/migrate-visits.mjs --file <path> [--plan]\n' +
      '       tsx scripts/migrate-visits.mjs --file <path> [--dry-run] [--actor <label>] ' +
      '[--report <path>]',
  )
  process.exit(2)
}

/** The normaliser, injected: the importer may not import `@berelax/core`. One wiring, in one place. */
const normalise = (raw) => {
  const result = e164IdentityResult(raw)
  return result.ok
    ? { ok: true, e164: result.e164, messageable: result.messageable }
    : { ok: false, reason: result.reason }
}

// The BYTES, hashed as they are. The text is decoded separately for the parser: the file's identity is
// what arrived, not what a decoder made of it.
const bytes = readFileSync(file)
const sourceText = bytes.toString('utf8')

/**
 * The pepper, from the environment, refused loudly when it is absent.
 *
 * Not defaulted and not generated — and here there is a second reason beyond H-MIG-04's: the digest has
 * to be the one the contact import already wrote, so a pepper this run invented would resolve no customer
 * at all and the whole file would quarantine while looking like a clean refusal.
 */
let peppers
try {
  peppers = loadSuppressionPeppers(process.env)
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(2)
}

const options = { pepper: peppers.current, normalise }
const plan = planVisitHistory(options, sourceText)
const planLines = [
  `${file}: ${plan.rows.length} line(s)`,
  `  ${plan.unreadableNumbers} line(s) name a number that could not be read — each quarantines`,
  `  ${plan.rejections.length} line(s) refused by the file's own rules: ` +
    `${plan.rejections.map((r) => `${r.lineNumber}=${r.reason}`).join(', ') || 'none'}`,
]
for (const line of planLines) console.log(line)

if (present('plan')) process.exit(0)

const mode = present('dry-run') ? 'dry-run' : 'live'
const actor = flag('actor')
if (mode === 'live' && !actor) {
  console.error(
    '--actor is required for a live import. It is recorded on the run and on every audit row, so ' +
      '"who imported this history" has an answer — and it is deliberately not defaulted to a ' +
      'plausible-looking label (brief rule 15).',
  )
  process.exit(2)
}

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
    importer: visitsImporter(options),
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

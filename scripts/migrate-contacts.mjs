#!/usr/bin/env node
/**
 * Imports a reconstructed customer contact list, rehearses one, or prints the blank file.
 *
 * ```
 * tsx scripts/migrate-contacts.mjs --template > contacts.tsv
 * tsx scripts/migrate-contacts.mjs --file contacts.tsv --plan
 * tsx scripts/migrate-contacts.mjs --file contacts.tsv --dry-run
 * tsx scripts/migrate-contacts.mjs --file contacts.tsv --actor "front desk" \
 *   --report artifacts/migration/contacts.json
 * ```
 *
 * ## Why this exists beside `scripts/migrate-import.mjs`
 *
 * That script is the generic door and runs any importer in `IMPORTERS`. The customers importer is
 * deliberately NOT in that registry, and `packages/migration/src/registry.ts` carries the reason: the
 * registry is a module-level frozen array, so a registered importer cannot have read anything when it is
 * constructed — and this one needs two things no frozen array can hold. The suppression PEPPER is a secret
 * that reaches the application through `packages/config`, which `packages/migration` may not import, and
 * the phone normaliser is in `@berelax/core`, which it may not import either. Built without them the
 * importer would have to stage the plaintext number, which is the one thing
 * `0121_customer_import.sql` exists to prevent.
 *
 * So this file is where the two are wired, and it is the only place they are. It reads the pepper exactly
 * as the send path does — `loadSuppressionPeppers(process.env)`, which refuses by name when the secret is
 * absent or too short — rather than defaulting one, because an unpeppered digest of a UAE mobile is a
 * phone number with extra steps (0064, and the mobile space is small enough to enumerate exhaustively).
 *
 * ## Everything else is the framework's
 *
 * Resumability, idempotence, provenance and the rehearsal that changes nothing are all `runImport`'s and
 * are proved against a real database by `packages/migration/src/framework.itest.ts`. There is no
 * `--resume`, for the reason `migrate-import.mjs` gives: resuming is what an import DOES, and a flag would
 * be a way to get it wrong.
 *
 * ## `--plan` and why it comes before `--dry-run` in the usage
 *
 * A dry run stages, validates and applies everything inside a transaction it rolls back, which needs a
 * database and the whole import to be runnable. `--plan` needs neither: it reads the file, normalises
 * every cell and prints how many people the list is about, how many lines repeat one of them, how many
 * cells could not be read and why, how many of the numbers nothing can send to, and how many lines claim a
 * marketing consent that is going to be discarded. That is the output somebody wants before deciding to
 * import at all, and it touches nothing.
 *
 * ## What this command cannot do
 *
 * There is no flag that grants a consent, and there is nothing to add one to: every contact arrives with
 * no marketing consent at all, `ZY271` refuses a granted send-gating consent captured by an import, and
 * the claim a source file makes is recorded as discarded. See `0121_customer_import.sql`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { e164IdentityResult } from '../packages/core/src/identity/e164.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import { loadSuppressionPeppers } from '../packages/db/src/repositories/suppression.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import {
  buildContactWorkbook,
  customersImporter,
  planContactList,
} from '../packages/migration/src/importers/customers/index.ts'

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}
const present = (name) => process.argv.includes(`--${name}`)

if (present('template')) {
  // To stdout, so `> contacts.tsv` is the whole of it. The file is the same bytes every time, because the
  // identity of a source file in this build is the sha-256 of its bytes and a stamped one could not be
  // attested to (H-MIG-01).
  process.stdout.write(buildContactWorkbook())
  process.exit(0)
}

const file = flag('file')
if (!file) {
  console.error(
    'Usage: tsx scripts/migrate-contacts.mjs --template\n' +
      '       tsx scripts/migrate-contacts.mjs --file <path> [--plan]\n' +
      '       tsx scripts/migrate-contacts.mjs --file <path> [--dry-run] [--actor <label>] ' +
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
 * Not defaulted and not generated. The digest staged in the ledger is the only identity a staged contact
 * row has, and one keyed under a pepper nobody retained can never be recomputed — so a missing pepper is a
 * configuration fault to fix before importing, not something to work around.
 */
let peppers
try {
  peppers = loadSuppressionPeppers(process.env)
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error))
  process.exit(2)
}

const plan = planContactList({ pepper: peppers.current, normalise }, sourceText)
const planLines = [
  `${file}: ${plan.lines} line(s)`,
  `  ${plan.distinct} distinct number(s) — the customers a fresh import creates`,
  `  ${plan.repeated} line(s) repeating a number an earlier line names`,
  `  ${plan.quarantined} line(s) whose number could not be read: ` +
    `${
      Object.entries(plan.quarantinedByReason)
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ') || 'none'
    }`,
  `  ${plan.unmessageable} of the numbers cannot be sent to (a landline or a toll-free line)`,
  `  ${plan.consentClaims} line(s) claim a marketing consent, and every one of them is DISCARDED`,
]
for (const line of planLines) console.log(line)

if (present('plan')) process.exit(0)

const mode = present('dry-run') ? 'dry-run' : 'live'
const actor = flag('actor')
if (mode === 'live' && !actor) {
  console.error(
    '--actor is required for a live import. It is recorded on the run and on every audit row, so ' +
      '"who imported this list" has an answer — and it is deliberately not defaulted to a ' +
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
    importer: customersImporter({ pepper: peppers.current, normalise }),
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

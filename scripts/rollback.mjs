#!/usr/bin/env node
/**
 * The rollback: hand the business back to paper, and prove nothing in the ledger moved.
 *
 * ```
 * node scripts/rollback.mjs --out /some/path/outside/this/repository
 * ```
 *
 * H-MIG-11. [docs/runbooks/cutover-rollback.md](../docs/runbooks/cutover-rollback.md) is the document;
 * this is the part of its section 2 a script can perform, and section 3 is the part nothing can.
 *
 * ## What "reverting booking operation to the paper process" means here, concretely
 *
 * It is not a switch. There is no "online booking off" flag in this build and this script does not
 * invent one: a plausible kill switch would be a mechanism nobody has asked for, sitting on the one path
 * a customer reaches. What the previous arrangement actually was is a **paper day sheet**, and what the
 * front desk needs in order to keep working off one is the three things the rollback runbook already
 * names, in the order it names them:
 *
 *   1. **Future appointments** — commitments to customers who will turn up.
 *   2. **Outstanding package balances** — sessions customers have paid for and not taken.
 *   3. **Unpaid invoices** — money owed.
 *
 * So this script exports exactly those three, as CSV a desk can print, and it does nothing else.
 * Stopping the worker and taking the public site down are an operator's acts and are section 2 of the
 * runbook; `/day-sheet/print` is the page the desk prints each morning afterwards.
 *
 * ## Why it is READ-ONLY and how that is proved rather than asserted
 *
 * "Without touching the ledger" is the acceptance line, and a stronger claim is both easier to make and
 * easier to check: this script touches **no table at all**. Every ordinary permanent table in `public`
 * and `import_staging` is checksummed before and after, by the one checksum implementation this
 * repository has (`packages/migration/src/checksum.ts`), and a table whose checksum moved is named and
 * the run refuses. That covers `journal_entry` and `journal_line` without a list of money tables
 * somebody has to keep current — and the table a list would stop covering is whichever one a migration
 * added last.
 *
 * It is also the direction that matters. A rollback is run by somebody who has just decided the system
 * is wrong; the last thing that should happen then is a write.
 *
 * ## Why `--out` is required and may not be inside this repository
 *
 * The exports carry customer names, phone numbers and amounts. A default path would eventually be a
 * default path inside a git worktree, and `pnpm pii` exists because a committed Emirates ID cannot be
 * rotated. So there is no default, and a destination inside this repository is refused by name.
 *
 * ## It reads section 3 of the runbook and refuses if it no longer says what it says
 *
 * The four irreversible subjects are a claim this script prints to whoever is about to roll back, and
 * the document is where they are stated. Rather than restating them here — the second statement that
 * drifts — the script reads the runbook and refuses to run if any of the four has gone from it. The
 * same four are asserted from the other side by `packages/migration/src/cutover-runbook.test.ts`.
 *
 * ## Exit codes
 *
 *   0  the three exports were written and no table changed.
 *   1  a rule broken: a table moved, or the runbook no longer declares the irreversible set. Every
 *      failure names the rule (ADR 0003).
 *   2  the command could not run: no database, no `--out`, an `--out` inside this repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import postgres from 'postgres'
import {
  IRREVERSIBLE_SUBJECTS,
  ROLLBACK_RULES,
  rollbackRunbookProblems,
} from '../packages/core/src/release/rollback.ts'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}

const RUNBOOK = flag('runbook', 'docs/runbooks/cutover-rollback.md')
const out = flag('out')

if (out === null) {
  console.error(
    '--out <directory> is required, and it must be outside this repository. The exports carry customer ' +
      'names, phone numbers and amounts; a default would eventually be a default inside a git worktree.',
  )
  process.exit(2)
}
const outDir = resolve(out)
if (outDir === process.cwd() || outDir.startsWith(`${process.cwd()}/`)) {
  console.error(
    `--out ${outDir} is inside ${process.cwd()}. An export of customer data must not land in a git ` +
      'tree: a committed phone number cannot be rotated, which is why `pnpm pii` exists.',
  )
  process.exit(2)
}

// The runbook's section 3, read rather than restated. See the module note.
if (!existsSync(RUNBOOK)) {
  console.error(`[${ROLLBACK_RULES.runbookMissing}] ${RUNBOOK} does not exist.`)
  process.exit(1)
}
const runbookProblems = rollbackRunbookProblems(readFileSync(RUNBOOK, 'utf8'), RUNBOOK)
if (runbookProblems.length > 0) {
  for (const problem of runbookProblems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(
    `\n${runbookProblems.length} problem(s). The four things a rollback cannot undo are stated in the ` +
      'runbook and printed from it; a runbook that has stopped saying so is a rollback nobody was warned ' +
      'about.',
  )
  process.exit(1)
}

const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL']
if (url === undefined || url === '') {
  console.error('DATABASE_URL or TEST_DATABASE_URL is required.')
  process.exit(2)
}

const sql = postgres(url, { max: 2 })

/** Every ordinary permanent table, with its checksum. The cutover script's walk, same reasons. */
async function tableChecksums() {
  const tables = await sql`
    select n.nspname as schema, c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and c.relpersistence = 'p'
       and n.nspname in ('public', 'import_staging')
     order by 1, 2
  `
  const checksums = new Map()
  for (const table of tables) {
    const relation = `${table['schema']}.${table['name']}`
    const [row] = await sql`
      select import_staging.content_checksum(${relation}::regclass) as checksum
    `
    checksums.set(relation, row?.['checksum'] ?? '')
  }
  return checksums
}

/** CSV, with every value quoted. A phone number is not a number and a note may hold a comma. */
function csv(rows) {
  if (rows.length === 0) return ''
  const columns = Object.keys(rows[0])
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(',')),
  ].join('\n')
}

/**
 * The three exports, in the runbook's order.
 *
 * Every one of them is a SELECT. The therapist is identified by `staff_reference` and never by a
 * display name: `employee.display_name` is null until an admin sets one (ADR 0020, `Y12-names`), and
 * the reference is what this build honestly holds.
 */
const EXPORTS = [
  {
    id: 'future-appointments',
    why: 'commitments to customers who will turn up whatever the business is reading',
    population: () => sql`select count(*)::int as n from appointment`,
    query: () => sql`
      select a.id                                  as appointment_id,
             lower(a.period)                       as starts_at,
             upper(a.period)                       as ends_at,
             a.trading_date,
             a.status,
             s.public_display_name                 as service,
             sv.duration_minutes,
             r.code                                as room,
             e.staff_reference                     as therapist,
             c.display_name                        as customer,
             c.phone_e164                          as customer_phone,
             a.gross_price_fils
        from appointment a
        join service_variant sv on sv.id = a.service_variant_id
        join service s          on s.id  = sv.service_id
        join rooms r            on r.id  = a.room_id
        join employee e         on e.id  = a.therapist_id
        join booking b          on b.id  = a.booking_id
        join customer c         on c.id  = b.customer_id
       where lower(a.period) >= now() and a.holds_resources
       order by lower(a.period)
    `,
  },
  {
    id: 'outstanding-package-balances',
    why: 'sessions customers have already paid for and not taken',
    population: () => sql`select count(*)::int as n from package_balance`,
    query: () => sql`
      select pb.id                                 as balance_id,
             ps.id                                 as package_sale_id,
             c.display_name                        as customer,
             c.phone_e164                          as customer_phone,
             pt.template_key                       as package,
             pb.sessions_total,
             pb.sessions_redeemed,
             pb.value_fils,
             pb.released_fils,
             pb.value_fils - pb.released_fils      as outstanding_fils
        from package_balance pb
        join package_sale ps on ps.id = pb.package_sale_id
        join customer c      on c.id  = ps.customer_id
        join package_template_version ptv on ptv.id = ps.template_version_id
        join package_template pt on pt.id = ptv.template_id
       where pb.value_fils - pb.released_fils > 0
       order by c.display_name, pb.line_no
    `,
  },
  {
    id: 'unpaid-invoices',
    why: 'money owed, and the one of the three that is also a tax document',
    population: () =>
      sql`select count(*)::int as n from invoice where document_kind = 'tax_invoice'`,
    query: () => sql`
      select i.id                                  as invoice_id,
             i.display_number,
             i.issue_date,
             i.customer_name_snapshot              as customer,
             i.customer_phone,
             i.gross_total,
             coalesce(sum(p.applied_fils), 0)      as applied_fils,
             i.gross_total - coalesce(sum(p.applied_fils), 0) as outstanding_fils
        from invoice i
        left join payment p on p.invoice_id = i.id
       where i.document_kind = 'tax_invoice'
       group by i.id
      having i.gross_total - coalesce(sum(p.applied_fils), 0) > 0
       order by i.issue_date, i.number
    `,
  },
]

let before
let after
const written = []
let failure = null
try {
  before = await tableChecksums()
  mkdirSync(outDir, { recursive: true })
  for (const entry of EXPORTS) {
    const rows = await entry.query()
    const [total] = await entry.population()
    const path = join(outDir, `${entry.id}.csv`)
    writeFileSync(path, `${csv(rows.map((row) => ({ ...row })))}\n`)
    written.push({
      id: entry.id,
      rows: rows.length,
      population: total?.['n'] ?? 0,
      path,
      why: entry.why,
    })
  }
  after = await tableChecksums()
} catch (error) {
  failure = error
} finally {
  await sql.end({ timeout: 5 })
}

if (failure !== null) {
  console.error(`The rollback export failed: ${failure.message}`)
  process.exit(2)
}

const moved = []
for (const relation of new Set([...before.keys(), ...after.keys()])) {
  if (before.get(relation) !== after.get(relation)) {
    moved.push(
      `${relation} (${before.get(relation) ?? 'absent'} -> ${after.get(relation) ?? 'absent'})`,
    )
  }
}

console.log('ROLLBACK — hand the business back to paper\n')
for (const entry of written) {
  console.log(
    `  ${String(entry.rows).padStart(6)} of ${String(entry.population).padEnd(6)} row(s)  ` +
      `${entry.id} — ${entry.why}`,
  )
  console.log(`  ${' '.repeat(22)}${entry.path}`)
}
console.log('')
// The population is printed beside each count for one reason: three empty exports are what a business
// with nothing outstanding looks like AND what three wrong WHERE clauses look like, and the difference
// is whether the tables they read were empty too. Said out loud rather than refused, because a salon on
// its first day genuinely has none of the three.
if (written.every((entry) => entry.rows === 0)) {
  console.log(
    'EVERY EXPORT IS EMPTY. That is either a business with nothing outstanding or three filters that ' +
      'matched nothing — read the populations above: if they are zero too, the tables are empty; if ' +
      'they are not, the filters are wrong and the desk has been handed blank paper.',
  )
  console.log('')
}
console.log(`tables checksummed before and after: ${before.size}; changed: ${moved.length}`)
console.log('')
console.log('What a rollback CANNOT undo, from the runbook rather than from this script:')
for (const subject of IRREVERSIBLE_SUBJECTS) console.log(`  - ${subject.label}: ${subject.why}`)
console.log('')
console.log(
  'Next, and none of it is this script’s: stop the worker, take the public site down, and print the ' +
    'day sheet (/day-sheet/print). See docs/runbooks/cutover-rollback.md section 2.',
)

if (moved.length > 0) {
  console.error(
    `\n[${ROLLBACK_RULES.tableChanged}] ${moved.length} table(s) changed during a rollback export, ` +
      `which issues nothing but SELECTs: ${moved.join(', ')}. A rollback is run by somebody who has ` +
      'just decided this system is wrong, and the last thing that should happen then is a write.',
  )
  process.exit(1)
}
process.exit(0)

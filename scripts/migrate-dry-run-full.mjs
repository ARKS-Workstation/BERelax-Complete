#!/usr/bin/env node
/**
 * One full migration dry run: a database created from nothing, every corpus importer run against it, a
 * numbered reconciliation report recorded, the invariant census run over the result, and the database
 * dropped.
 *
 * ```
 * tsx scripts/migrate-dry-run-full.mjs --run 1 --out artifacts/migration/run-1.json
 * ```
 *
 * ## Why a FRESH database every time, and why there is no resume path
 *
 * `scripts/apply-migrations.mjs` applies every migration from nothing and refuses a database that is not
 * empty, and its header says why: the migrations are deliberately not idempotent, there is no
 * applied-migrations table to consult, and the one attempt at tolerating a second run reported a
 * half-applied migration as a skip. A dry run therefore MEANS a fresh database. This script creates one,
 * uses it and drops it, and deliberately adds no resume path — a resumable dry run would be a dry run
 * that starts from somebody else's state, which is the one thing it exists not to do.
 *
 * ## What it imports, and what it refuses to pretend to import
 *
 * The corpus is SYNTHETIC and generated, in full, from `packages/fixtures` — `syntheticPerson` and
 * `buildContactList`, whose own module note explains why a fixture number is not a claim about anybody.
 * It is generated rather than committed so there is no second statement of it, and it is byte-stable
 * across runs so that two runs can be compared at all.
 *
 * Three importers are NOT run and the recorded run SAYS SO, with the open question that blocks each. That
 * is not a gap quietly left: a dry run that imported nothing for `packages` and reported no variance
 * would read exactly like a dry run that imported the owner's real workbook cleanly, and the figures
 * those three need are human acts nobody has performed — an owner's sign-off with four values that may
 * not be defaulted (Y8-packages, and ADR 0069's `import_sign_off`), the previous arrangement's visit
 * history (Y8-visits), and the staff file with its leave-year anchor (Y8-staff). Inventing any of them
 * here would put a figure in a committed artefact that is indistinguishable from a measured one
 * (brief rule 15). `scripts/check-dry-runs.mjs` asserts the list is stated.
 *
 * ## Exit codes
 *
 *   0  the dry run completed and its report holds no unexplained variance.
 *   1  the dry run completed and its report holds one, or a post-import check failed. The recorded run is
 *      still written: a failing run is the evidence, and the gate is what refuses it.
 *   2  the command could not run: no database, a migration that would not apply, a bad argument.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection } from '../packages/db/src/connection.ts'
import {
  buildContactList,
  contactNormaliser,
  unreadableCells,
} from '../packages/fixtures/src/customer-import.ts'
import { fixtureSuppressionPeppers } from '../packages/fixtures/src/suppression.ts'
import {
  PROBE_KEY_PREFIX,
  probeImporter,
} from '../packages/migration/src/conformance/probe-importer.ts'
import { runImport } from '../packages/migration/src/framework.ts'
import { customersImporter } from '../packages/migration/src/importers/customers/index.ts'
import {
  generateReconciliationReport,
  reconciliationExitStatus,
  recordReconciliationRun,
} from '../packages/migration/src/report/generate.ts'
import { renderReconciliationReport } from '../packages/migration/src/report/render.ts'

const MIGRATIONS_DIR = 'packages/db/migrations'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}

const runNumber = Number(flag('run') ?? '0')
if (!Number.isInteger(runNumber) || runNumber < 1) {
  console.error('--run <n> is required and is the number this dry run is recorded under.')
  process.exit(2)
}

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
if (!url) {
  console.error(
    'TEST_DATABASE_URL or DATABASE_URL is required: this script creates a database beside it.',
  )
  process.exit(2)
}

const admin = new URL(url)
const base = `${admin.protocol}//${admin.username}:${admin.password}@${admin.hostname}:${admin.port || 5432}`
const scratch = `berelax_dryrun_full_${process.pid}_${runNumber}`
const scratchUrl = `${base}/${scratch}`

const psql = (db, args) =>
  execFileSync('psql', ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', `${base}/${db}`, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })

/**
 * The corpus, generated and byte-stable.
 *
 * Every nonce here is a CONSTANT and not a clock reading, which is the opposite of what the integration
 * suites do and for the opposite reason: they run against a shared database where a fixed fixture would
 * collide with the last execution's rows, and this runs against a database that did not exist a second
 * ago. A clock reading here would change the source file's bytes between runs, after which run N+1 could
 * not be compared with run N at all — which is the third acceptance line.
 */
const CONTACT_BASE_INDEX = 9_100_000
const CONTACT_NONCE = 20_261_003

const probeFile = (rows, malformedAt) => {
  const lines = ['probe_key\tlabel\tamount_fils']
  for (let at = 0; at < rows; at += 1) {
    lines.push(
      [
        `${PROBE_KEY_PREFIX}h-mig-09-${malformedAt === undefined ? 'clean' : 'rejecting'}-${at}`,
        `dry-run corpus row ${at}`,
        malformedAt === at ? 'not-a-number' : String(1_000 + at),
      ].join('\t'),
    )
  }
  return `${lines.join('\n')}\n`
}

const contactList = buildContactList({
  baseIndex: CONTACT_BASE_INDEX,
  distinct: 6,
  duplicates: 2,
  claimEvery: 3,
  unreadable: unreadableCells(CONTACT_NONCE),
})

/**
 * What the driver cannot run, and the open question that blocks each.
 *
 * Stated as data rather than as a comment, because it is written into every recorded run and
 * `check-dry-runs.mjs` asserts it is there. A dry run that silently covered two importers out of five
 * would report "no unexplained variance" about a migration nobody has rehearsed.
 */
const IMPORTERS_NOT_RUN = [
  {
    importer: 'packages',
    reason:
      "the reconstruction workbook and the owner's sign-off are a human act with four values that may " +
      'not be defaulted — who signed, the cash actually received, the opening date and the statement ' +
      'accepted — and `import_sign_off_reconciles_to_the_cash_received` refuses a signature whose ' +
      'figures do not tie. A synthetic sign-off would put an attested cash figure in a committed ' +
      'artefact (ADR 0069, brief rule 15)',
    openQuestionId: 'Y8-packages',
  },
  {
    importer: 'appointments',
    reason:
      "the previous arrangement's visit history does not exist, and every line of it has to resolve to " +
      'a therapist, a room and a service in THIS catalogue or be quarantined by name (ADR 0082). A ' +
      'generated history would be a reconstruction of visits nobody made',
    openQuestionId: 'Y8-visits',
  },
  {
    importer: 'staff',
    reason:
      'the staff file carries real staff references, genders and leave opening balances, and the leave ' +
      'year anchor has no default on purpose (ADR 0083). A generated file would decide which leave year ' +
      "nineteen people's carry-over forfeits in",
    openQuestionId: 'Y8-staff',
  },
  {
    importer: 'opening-balances',
    reason:
      'the opening trial balance is the statement somebody checks against the books being copied from, ' +
      'and attesting it LOCKS the database behind its boundary for ever (ADR 0084). A generated one ' +
      'would attest totals nobody has signed',
    openQuestionId: 'Y8-opening-balances',
  },
]

const ACTOR = { kind: 'system', label: `H-MIG-09 dry run ${runNumber}` }

let exitCode = 2
let sql
try {
  psql('postgres', ['-c', `drop database if exists ${scratch}`])
  psql('postgres', ['-c', `create database ${scratch} owner berelax`])
  console.log(`Dry run ${runNumber}: created ${scratch}`)

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  if (migrations.length === 0) {
    // An empty glob is not "nothing to do": it would hand the import an empty schema under a green tick.
    throw new Error(`No migrations found in ${MIGRATIONS_DIR} — refusing to report a dry run.`)
  }
  for (const file of migrations) psql(scratch, ['-f', join(MIGRATIONS_DIR, file)])
  console.log(`  ${migrations.length} migration(s) applied from nothing`)

  const childEnv = {
    ...process.env,
    DATABASE_URL: scratchUrl,
    TEST_DATABASE_URL: scratchUrl,
    APP_ENV: 'test',
  }
  execFileSync('pnpm', ['seed'], {
    env: childEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  console.log('  seeded')

  sql = createConnection({ url: scratchUrl, max: 4 })
  const pepper = fixtureSuppressionPeppers(process.env).current
  const importersRun = []
  const imports = [
    {
      importer: probeImporter(),
      sourceFile: 'corpus/h-mig-09/probe-clean.tsv',
      sourceText: probeFile(3, undefined),
    },
    {
      importer: probeImporter(),
      sourceFile: 'corpus/h-mig-09/probe-rejecting.tsv',
      sourceText: probeFile(4, 2),
    },
    {
      importer: customersImporter({ pepper, normalise: contactNormaliser }),
      sourceFile: 'corpus/h-mig-09/contacts.tsv',
      sourceText: contactList.sourceText,
    },
  ]
  for (const entry of imports) {
    const report = await runImport({ sql, mode: 'live', actor: ACTOR, ...entry })
    importersRun.push({ importer: entry.importer.name, sourceFile: entry.sourceFile })
    console.log(
      `  ${entry.importer.name} ${entry.sourceFile}: ${report.state} — ${report.applied} applied, ` +
        `${report.skipped} skipped, ${report.rejected} rejected, ${report.pending} pending`,
    )
  }

  const report = await generateReconciliationReport(sql)
  // Taken here, outside the report, and the only non-deterministic value in the artefact.
  const run = recordReconciliationRun(report, new Date())

  /*
    The post-import checks, run against the database the import just wrote.

    `pnpm money-invariants` is M-VAT-13's census: it re-adds every money identity over every row the
    database holds rather than over one unit's fixture, which is exactly the question a migration
    rehearsal has to answer — the import reconciled, and are the books still right. Recorded with its
    verdict on the WRAPPER rather than inside the report, because a suite's verdict is a fact about this
    execution and two runs are compared on the report.
  */
  const postImportChecks = []
  for (const check of [
    { name: 'money invariant census', command: 'pnpm money-invariants' },
    /*
      H-HARD-04's restore-drill suite, against the post-import database. This unit's fourth acceptance
      line asks for it and its NOTE deferred it to that unit for want of a suite to run; there is one
      now, so it runs here. It is the half a reconciliation report cannot make: the report counts rows,
      and this asserts that the schema's ENFORCEMENT is intact — the append-only trigger on `invoice`
      still raises ZI003, the audit rules still swallow an UPDATE, `btree_gist` is present, and the
      constraint and trigger counts are above their floors. An import that reconciled perfectly into a
      database whose triggers had been disabled would pass the report and fail here.
    */
    {
      name: 'restore drill suite',
      command:
        'pnpm exec vitest run -c vitest.integration.config.ts packages/fixtures/src/restore-drill.itest.ts',
    },
  ]) {
    let ok = true
    try {
      execFileSync('pnpm', check.command.split(' ').slice(1), {
        env: childEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch {
      ok = false
    }
    postImportChecks.push({ ...check, ok })
    console.log(`  ${check.name}: ${ok ? 'passed' : 'FAILED'}`)
  }

  const recorded = {
    $comment: [
      `Recorded dry run ${runNumber}. H-MIG-09. Written by`,
      `\`tsx scripts/migrate-dry-run-full.mjs --run ${runNumber} --out <this file>\` against a database`,
      'created from nothing, seeded, imported into and then dropped.',
      '',
      'EVERY FIGURE BELOW IS MEASURED. The corpus is synthetic and generated from packages/fixtures —',
      'syntheticPerson and buildContactList — so no figure here is a claim about this business, and',
      '`importersNotRun` names the three importers whose inputs are human acts nobody has performed,',
      'with the open question that blocks each. A dry run that silently covered two importers out of',
      'five would report "no unexplained variance" about a migration nobody has rehearsed.',
      '',
      "`generatedAt` is OUTSIDE `report` and `contentDigest` is the sha-256 of `report`'s canonical",
      'form, so run N and run N+1 can be compared at all: the only fields a fresh database necessarily',
      'remints are `runId` and `recordId`, and every other difference is material. Editing a figure in',
      'this file without re-running the driver makes `pnpm dry-runs` fail on the digest.',
    ],
    runNumber,
    ...run,
    importersRun,
    importersNotRun: IMPORTERS_NOT_RUN,
    postImportChecks,
  }

  const out = flag('out')
  if (out) {
    writeFileSync(out, `${JSON.stringify(recorded, null, 2)}\n`)
    console.log(`  recorded to ${out}`)
  } else {
    console.log(renderReconciliationReport(report))
  }

  exitCode =
    reconciliationExitStatus(report) === 0 && postImportChecks.every((check) => check.ok) ? 0 : 1
  console.log(
    exitCode === 0
      ? `Dry run ${runNumber}: every variance is tied to a named cause.`
      : `Dry run ${runNumber}: FAILED — see the recorded run.`,
  )
} catch (error) {
  console.error(
    `Dry run ${runNumber} could not complete: ${String(error.stdout ?? '')}${String(error.stderr ?? error.message)}`,
  )
  exitCode = 2
} finally {
  await sql?.end({ timeout: 5 })
  try {
    psql('postgres', ['-c', `drop database if exists ${scratch}`])
  } catch (dropError) {
    console.error(`WARNING: could not drop ${scratch}: ${dropError.message}`)
  }
}

process.exit(exitCode)

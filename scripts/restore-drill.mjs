#!/usr/bin/env node
/**
 * The restore drill: back the database up, restore it into a database created from nothing, and prove
 * the restored copy is usable by reading rows out of it and running a suite against it.
 *
 * `pnpm drill`. H-HARD-04.
 *
 * ## What it proves, and what it does not
 *
 * There is **one PostgreSQL server here, no cloud backup, no WAL archive, no PITR target and no staging
 * host.** So the drill is built against what exists: `pg_dump --format=custom` to a file, a database
 * created and dropped in the same run, `pg_restore` into it, a row-count reconciliation over every table
 * in both directions, named rows read back, and the drill's own integration suite plus the money
 * invariants run against the restored database. Every report carries a `notProved` list naming what is
 * outside that — different hardware, off-site media, a chosen instant, and any figure for how much data
 * a real failure would lose — and `docs/runbooks/restore.md` repeats it where somebody doing a restore
 * at 2am will see it.
 *
 * The judgements are in `packages/core/src/ops/restore-drill.ts` with a test per rule, for
 * `go-live-payments.mjs`'s reason: a judgement that lives in a script is a judgement no test reaches.
 * What is here is the processes, the timing and the two queries.
 *
 * ## Why a fresh database every time, and why that is not a limitation to work around
 *
 * `scripts/apply-migrations.mjs` refuses a database that already holds tables, because the migrations
 * are not idempotent and there is no applied-migrations table to resume from. A restore target has the
 * same shape for a better reason: a `pg_restore` into a database that already holds rows is a restore
 * whose row counts are a comparison against somebody else's data, and
 * {@link reconcileRowCounts}'s second direction exists to catch exactly that. So the target is created
 * here, dropped in a `finally`, and never reused.
 *
 * ## Flags
 *
 *   --source <url>        the database to back up. Default `DATABASE_URL`/`TEST_DATABASE_URL`.
 *   --backup <path>       restore an EXISTING dump file instead of taking one. The known-bad fixture
 *                         path: a truncated file is refused by name before any database is created.
 *   --emit                write `artifacts/drills/restore-report.json`. Without it the report is
 *                         printed and nothing is written, so a drill can be run without touching the
 *                         committed evidence.
 *   --out <path>          where to write it instead.
 *   --suite <on|off>      run `packages/fixtures/src/restore-drill.itest.ts` against the restored
 *                         database. Default on.
 *   --invariants <on|off> run `pnpm money-invariants` against it. Default on.
 *   --measured-on <kind>  `agent_container` (default) or `chosen_machine`. A duration recorded as
 *                         `chosen_machine` is a figure somebody stood behind; see brief rule 23.
 *   --keep                do not drop the restored database, for looking at it afterwards.
 *
 * Exit codes: 0 the drill proved what it claims; 1 any rule broken, named on stderr (ADR 0003).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { cpus, loadavg, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  canonicalDrillReport,
  DRILL_REPORT_VERSION,
  drillRunProblems,
  RESTORE_DRILL_RULES,
  reconcileRowCounts,
} from '../packages/core/src/ops/restore-drill.ts'

const MIGRATIONS_DIR = 'packages/db/migrations'
const DEFAULT_OUT = 'artifacts/drills/restore-report.json'
const DRILL_SUITE = 'packages/fixtures/src/restore-drill.itest.ts'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const present = (name) => argv.includes(`--${name}`)

const sourceUrl =
  flag('source') ?? process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'] ?? null
const existingBackup = flag('backup')
const runSuite = flag('suite', 'on') === 'on'
const runInvariants = flag('invariants', 'on') === 'on'
const measuredOn = flag('measured-on', 'agent_container')
const outPath = flag('out', DEFAULT_OUT)

if (measuredOn !== 'agent_container' && measuredOn !== 'chosen_machine') {
  console.error(`--measured-on takes agent_container or chosen_machine, not ${measuredOn}.`)
  process.exit(1)
}
if (sourceUrl === null) {
  console.error(
    '--source, DATABASE_URL or TEST_DATABASE_URL is required: there is nothing to back up.',
  )
  process.exit(1)
}

const problems = []
const fail = (rule, detail) => problems.push({ rule, detail })

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** The migration set the drill is about, as the staleness rule reads it. */
function migrationPrefix() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    console.error(`No migrations in ${MIGRATIONS_DIR} — refusing to report a drill over no schema.`)
    process.exit(1)
  }
  const digest = sha256(
    files.map((name) => `${name}:${sha256(readFileSync(join(MIGRATIONS_DIR, name)))}`).join('\n'),
  )
  return { count: files.length, digest }
}

const psql = (url, statement) =>
  execFileSync(
    'psql',
    ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', url, '-c', statement],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    },
  )

/**
 * Every ordinary table and every partition in every non-system schema, with its row count, as ONE
 * statement.
 *
 * `count(*)` per relation and not `pg_class.reltuples`: the estimate is what `ANALYZE` last saw, a
 * freshly restored database has never been analysed, and a reconciliation over two estimates is a
 * comparison of two guesses that would agree on an empty restore.
 *
 * ## Materialised views are EXCLUDED from the reconciliation, and that is a finding rather than a tidy-up
 *
 * The first run of this drill reported four mismatches — `reporting.dim_customer` 0 rows in the source
 * and 4 in the restored copy, and three like it. Nothing was lost: `pg_dump` emits a
 * `REFRESH MATERIALIZED VIEW` for a populated view rather than copying its rows, so `pg_restore`
 * RECOMPUTES the seven `reporting.*` views from the restored base tables. The restored copy's reporting
 * views are therefore as at the RESTORE and not as at the dump, which is exactly the kind of difference
 * an operator needs told (`docs/runbooks/restore.md` says so) and exactly the kind a row-count
 * reconciliation would otherwise report as data loss for ever.
 *
 * So they are counted, recorded, and reconciled separately — never silently dropped, because a view
 * that came back EMPTY is a real failure and the distinction between "refreshed" and "absent" is the
 * one this split has to keep.
 *
 * ## Why a partitioned parent and its partitions are both compared
 *
 * `count(*)` on the parent covers every partition, so comparing the parent alone would catch a lost
 * partition's rows. It would not catch a partition that came back EMPTY while another came back with
 * its rows — the total matches and one month of analytics is gone. Comparing both is one query either
 * way, and only the non-partition rows are summed into `rowsCompared` so the total is not doubled.
 */
function relationCounts(url) {
  const sql =
    "select coalesce(json_agg(json_build_object('table', t, 'rows', n, 'kind', k) order by t), " +
    "  '[]'::json) from (" +
    "  select format('%I.%I', n.nspname, c.relname) as t," +
    "         case when c.relkind = 'm' then 'matview'" +
    "              when c.relispartition then 'partition'" +
    "              else 'table' end as k," +
    '         (xpath(' +
    "           '/row/c/text()'," +
    "           query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname)," +
    "             false, true, '')" +
    '         ))[1]::text::bigint as n' +
    '    from pg_class c join pg_namespace n on n.oid = c.relnamespace' +
    "   where c.relkind in ('r', 'p', 'm')" +
    "     and n.nspname not in ('pg_catalog', 'information_schema')" +
    ') counted'
  const rows = JSON.parse(psql(url, sql).trim() || '[]').map((row) => ({
    table: row.table,
    rows: Number(row.rows),
    kind: row.kind,
  }))
  return {
    tables: rows
      .filter((row) => row.kind !== 'matview')
      .map(({ table, rows: n }) => ({ table, rows: n })),
    matviews: rows
      .filter((row) => row.kind === 'matview')
      .map(({ table, rows: n }) => ({ table, rows: n })),
    rows: rows.filter((row) => row.kind === 'table').reduce((total, row) => total + row.rows, 0),
  }
}

const databaseName = (url) => new URL(url).pathname.replace(/^\//, '')
const adminUrl = (url) => {
  const parsed = new URL(url)
  parsed.pathname = '/postgres'
  return parsed.toString()
}
const targetUrl = (url, name) => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

const workDir = mkdtempSync(join(tmpdir(), 'berelax-drill-'))
const target = `berelax_drill_${Math.random().toString(36).slice(2, 10)}`
let created = false

try {
  const migrations = migrationPrefix()

  // ---- the backup -----------------------------------------------------------------------------
  const dumpPath = existingBackup ?? join(workDir, 'source.dump')
  const backupStarted = new Date()
  if (existingBackup === null) {
    const dump = spawnSync(
      'pg_dump',
      /*
        Owners and privileges are KEPT, and that is a defect this drill found in its own first run.
        With `--no-owner --no-privileges` the restore produced a database in which `berelax_app` held
        no permissions at all, and the money invariants failed eight ways against it —
        `permission denied for table journal_entry`, and `information_schema` showing the application
        role with no grants where migration 0067 gives it INSERT and withholds UPDATE. Every row was
        there. The least-privilege controls were not, and nothing about the data said so. A restore that
        strips the ACLs is a restore the application cannot run against.
      */
      ['--format=custom', '--file', dumpPath, sourceUrl],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (dump.status !== 0) {
      console.error(
        `[${RESTORE_DRILL_RULES.backupUnusable}] pg_dump exited ${dump.status}:\n${dump.stderr ?? ''}`,
      )
      process.exit(1)
    }
  }
  const backupFinished = new Date()

  /*
    The dump is READ before a database is created, and that order is the known-bad fixture's whole
    mechanism. `pg_restore --list` parses the archive's table of contents and opens no connection, so a
    truncated or mis-formatted file is refused here — by name, in milliseconds, with no server involved —
    rather than part-way through a restore that has already created half a schema. ADR 0003 asks for a
    fixture that can be seen to fail; this is the one that can be written without a database.
  */
  const toc = spawnSync('pg_restore', ['--list', dumpPath], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (toc.status !== 0) {
    console.error(
      `[${RESTORE_DRILL_RULES.backupUnusable}] pg_restore could not read ${dumpPath}. A backup whose ` +
        'table of contents cannot be parsed is not a backup, and this is what a truncated dump looks ' +
        `like:\n${toc.stderr ?? ''}`,
    )
    process.exit(1)
  }
  const tocEntries = (toc.stdout ?? '')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith(';')).length
  const byteLength = statSync(dumpPath).size

  /*
    The server is asked about itself only AFTER the backup has been read, and the order is load-bearing
    for the known-bad fixture: a gate case pointing `--backup` at a deliberately truncated file must get
    the named refusal with no database involved at all. With the `show` queries above this point the
    fixture would have needed a reachable PostgreSQL to prove a rule about a file.
  */
  const serverVersion = psql(sourceUrl, 'show server_version').trim()
  const walLevel = psql(sourceUrl, 'show wal_level').trim()
  const archiveMode = psql(sourceUrl, 'show archive_mode').trim()

  // ---- the restore ----------------------------------------------------------------------------
  const source =
    existingBackup === null ? relationCounts(sourceUrl) : { tables: [], matviews: [], rows: 0 }
  execFileSync(
    'psql',
    [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      adminUrl(sourceUrl),
      '-c',
      `create database ${target}`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  created = true
  const restoredUrl = targetUrl(sourceUrl, target)

  const restoreStarted = new Date()
  const restore = spawnSync(
    'pg_restore',
    ['--dbname', restoredUrl, '--exit-on-error', '--single-transaction', dumpPath],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const restoreFinished = new Date()
  if (restore.status !== 0) {
    fail(
      RESTORE_DRILL_RULES.backupUnusable,
      `pg_restore exited ${restore.status}: ${(restore.stderr ?? '').slice(0, 2000)}`,
    )
  }

  // ---- verification ---------------------------------------------------------------------------
  const restored =
    restore.status === 0 && existingBackup === null
      ? relationCounts(restoredUrl)
      : { tables: [], matviews: [], rows: 0 }
  const mismatches = reconcileRowCounts(source.tables, restored.tables)
  /*
    A materialised view that came back EMPTY where the source had rows is a real failure and is
    reported as one; a view whose count MOVED is the refresh described above and is recorded, not
    refused. The two cases are separated here rather than in the shared reconciler because only this
    script knows which relations are views.
  */
  const emptiedViews = source.matviews.filter(
    (entry) =>
      entry.rows > 0 &&
      (restored.matviews.find((other) => other.table === entry.table)?.rows ?? 0) === 0,
  )
  for (const view of emptiedViews) {
    fail(
      RESTORE_DRILL_RULES.rowCountMismatch,
      `${view.table} is a materialised view with ${view.rows} row(s) in the source and none after the ` +
        'restore: the refresh the restore performs produced nothing, so the view is not usable',
    )
  }
  const rowsCompared = source.rows

  /*
    The read-backs. Each one is a SELECT against the restored database compared with the same SELECT
    against the source, in this run — not against a figure written into this repository, which would be
    a second statement of the data and would go stale on the first seed change.

    Four claims rather than one, chosen so that a restore which brought back an empty schema, a schema
    with no data, a schema whose money rows were lost, or a schema whose settings were lost would each
    fail a different one.
  */
  const READ_BACKS = [
    {
      claim: 'the legal entity singleton is readable and holds its registered name',
      statement: "select coalesce(max(legal_name), '(none)') from legal_entity",
    },
    {
      claim: 'the published catalogue is readable and the same size',
      statement: 'select count(*)::text from service',
    },
    {
      claim: 'the money estate is readable: issued invoices and their lines',
      statement:
        "select count(*)::text || '/' || (select count(*)::text from invoice_line) from invoice",
    },
    {
      claim: 'the settings store is readable, which is what a restore silently reverts',
      statement: 'select count(*)::text from app_setting',
    },
  ]
  const readBacks = []
  if (restore.status === 0 && existingBackup === null) {
    for (const entry of READ_BACKS) {
      const read = (url) => {
        try {
          return psql(url, entry.statement).trim()
        } catch {
          return null
        }
      }
      readBacks.push({ claim: entry.claim, expected: read(sourceUrl), actual: read(restoredUrl) })
    }
  }

  const runAgainstRestored = (name, cmd, args) => {
    if (!runSuite && name === DRILL_SUITE) {
      return { name, ran: false, exitCode: null, skippedReason: '--suite off' }
    }
    const child = spawnSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TEST_DATABASE_URL: restoredUrl, DATABASE_URL: restoredUrl },
      // An explicit ceiling, because this is the one step that can hang: a suite waiting on a
      // connection the restored database refuses would otherwise hold the drill open for ever, and the
      // drill is a thing somebody runs during an incident (brief rules 21/23).
      timeout: 20 * 60 * 1000,
    })
    if (child.signal) {
      return { name, ran: true, exitCode: null, skippedReason: `killed by ${child.signal}` }
    }
    process.stderr.write(
      `\n--- ${name} against ${target} ---\n${child.stdout ?? ''}${child.stderr ?? ''}\n`,
    )
    return { name, ran: true, exitCode: child.status, skippedReason: null }
  }

  const suite =
    restore.status === 0 && runSuite
      ? runAgainstRestored(DRILL_SUITE, 'pnpm', [
          'exec',
          'vitest',
          'run',
          '-c',
          'vitest.integration.config.ts',
          DRILL_SUITE,
        ])
      : {
          name: DRILL_SUITE,
          ran: false,
          exitCode: null,
          skippedReason: '--suite off or restore failed',
        }

  const invariants =
    restore.status === 0 && runInvariants
      ? runAgainstRestored('money-invariants', 'pnpm', ['money-invariants'])
      : {
          name: 'money-invariants',
          ran: false,
          exitCode: null,
          skippedReason: '--invariants off or restore failed',
        }

  const verifiedAt = new Date()

  const report = {
    reportVersion: DRILL_REPORT_VERSION,
    runAtIso: backupStarted.toISOString(),
    machine: {
      platform: process.platform,
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
      loadAverage1m: Number((loadavg()[0] ?? 0).toFixed(2)),
      postgresVersion: serverVersion,
      measuredOn,
    },
    source: {
      database: databaseName(sourceUrl),
      migrationCount: migrations.count,
      migrationPrefixDigest: migrations.digest,
    },
    backup: {
      tool: 'pg_dump',
      format: 'custom',
      byteLength,
      tocEntries,
      startedAtIso: backupStarted.toISOString(),
      finishedAtIso: backupFinished.toISOString(),
      durationMs: backupFinished.getTime() - backupStarted.getTime(),
    },
    restore: {
      tool: 'pg_restore',
      startedAtIso: restoreStarted.toISOString(),
      finishedAtIso: restoreFinished.toISOString(),
      durationMs: restoreFinished.getTime() - restoreStarted.getTime(),
      exitCode: restore.status ?? 1,
    },
    pitr: {
      configured: archiveMode === 'on' && walLevel !== 'minimal',
      walLevel,
      archiveMode,
      reason:
        archiveMode === 'on'
          ? 'the server archives WAL, so a point-in-time target exists'
          : 'archive_mode is off on this server and no WAL archive, base-backup store or recovery ' +
            'target exists, so there is nothing to recover to a chosen instant from. Recorded as a ' +
            'reading off the server rather than as prose, so the day one is configured this field ' +
            'changes by itself',
    },
    verification: {
      tablesCompared: source.tables.length,
      rowsCompared,
      mismatches,
      derivedViews: source.matviews.map((entry) => ({
        table: entry.table,
        sourceRows: entry.rows,
        restoredRows: restored.matviews.find((other) => other.table === entry.table)?.rows ?? 0,
      })),
      readBacks,
      suite,
      invariants,
    },
    /*
      The measured window in which a write would have been lost: from the dump finishing to the restored
      copy being verified. It is a figure about THIS run and it is not an RPO — an RPO is a function of
      how often a backup is taken, and nothing here takes one on a schedule (`Y13-rpo-rto`).
    */
    dataLossWindowMs: verifiedAt.getTime() - backupFinished.getTime(),
    objectives: {
      rpoSeconds: null,
      rtoSeconds: null,
      backupRetentionDays: null,
      drillMaxAgeDays: null,
      openQuestionId: 'Y13-rpo-rto',
    },
    notProved: [
      'No restore onto different hardware or a different PostgreSQL build. One server, one version, ' +
        'and the dump never left the machine that wrote it.',
      'No off-site or immutable copy. The dump is written to a temporary directory and deleted with ' +
        'this run; nothing retains a backup, so there is no retention period to state.',
      'No point-in-time recovery. archive_mode and wal_level are recorded above as read off the ' +
        'server; with no WAL archive there is no instant to recover to other than the dump.',
      'No recovery objective. The restore duration below is a measurement of this machine under ' +
        'whatever else was running on it, which brief rule 23 is about; it is not an RTO, and the ' +
        'data-loss window is this run’s and not an RPO.',
      'No staging host, so "restore and then serve the application from it" is untested; what is ' +
        'tested is that the schema and the data come back and that a suite can read them.',
    ],
    digest: '',
  }
  report.digest = sha256(canonicalDrillReport(report))

  problems.push(...drillRunProblems(report))

  if (present('emit')) {
    mkdirSync(join(outPath, '..'), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Wrote ${outPath}`)
  }

  console.log(
    `Restore drill: ${report.source.migrationCount} migration(s) of schema, ` +
      `${report.backup.byteLength} byte dump in ${report.backup.durationMs} ms, restored into ` +
      `${target} in ${report.restore.durationMs} ms, ${report.verification.tablesCompared} table(s) ` +
      `and ${report.verification.rowsCompared} row(s) reconciled, ${report.verification.readBacks.length} ` +
      `row(s) read back. Measured on ${report.machine.measuredOn} with ${report.machine.cpus} core(s) ` +
      `at load ${report.machine.loadAverage1m}; PITR configured: ${report.pitr.configured}.`,
  )
  for (const line of report.notProved) console.log(`  not proved: ${line}`)
} finally {
  if (created) {
    if (present('keep')) {
      console.log(`--keep: ${target} left in place. Drop it with: drop database ${target}`)
    } else {
      try {
        execFileSync(
          'psql',
          ['--no-psqlrc', '-q', adminUrl(sourceUrl), '-c', `drop database if exists ${target}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        )
      } catch (err) {
        console.error(`Could not drop ${target}: ${err.message ?? err}`)
      }
    }
  }
  rmSync(workDir, { recursive: true, force: true })
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(`\n${problems.length} problem(s). The drill did not prove a usable restore.`)
  process.exit(1)
}

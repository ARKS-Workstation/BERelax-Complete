#!/usr/bin/env node
/**
 * The load and concurrency soak. `pnpm soak`.
 *
 * H-HARD-11. It performs three runs against a probe salon it builds and removes, runs the money
 * invariants against the database afterwards, and writes `artifacts/soak/report.json`.
 *
 * ## What the applied load does and does not establish
 *
 * It is a four-core container shared with other agents. So the three claims this unit is actually about
 * are COUNTS OF ROWS, which are the same here as anywhere:
 *
 *   * 200 attempts in flight for ONE place: exactly one commits, the other 199 are refused BY NAME, no
 *     rejection carries a raw 23xxx or 40P01, and no room ends over capacity.
 *   * a 10,000-event backlog drained by several workers at once: exactly one `outbox_delivery` row per
 *     (event, handler), counted from the table and compared with the number of distinct pairs.
 *   * the money invariants still true against the post-soak database.
 *
 * The LATENCY reading is not a claim about the product and the report says so in a field rather than a
 * comment: `machine.measuredOn` is `agent_container` unless somebody passes `--measured-on
 * chosen_machine`, and `packages/core/src/ops/soak.ts` enforces the committed budget only for the
 * latter. `availability-perf.itest.ts` measured this container six times and wrote the numbers down —
 * 192 to 231 ms alone, 315 to 417 ms inside a full run — so a p95 taken here separates the container's
 * mood, not two versions of the query.
 *
 * ## Flags
 *
 *   --attempts N         contenders for the last place. Default 200, the acceptance figure.
 *   --events N           backlog size. Default 10,000, the acceptance figure.
 *   --concurrency N      availability queries in flight. Default 50, the concurrency B-AVAIL-07's
 *                        budget was committed at, which is the only one with a figure behind it.
 *   --batches N          repeats of the availability load. Default 3.
 *   --drainers N         concurrent outbox drainers. Default 2 — one makes exactly-once trivial.
 *   --batch-size N       events claimed per drain. Default 200.
 *   --pool N             connections. Default 24.
 *   --invariants on|off  run `pnpm money-invariants` afterwards. Default on.
 *   --measured-on        `agent_container` (default) or `chosen_machine`.
 *   --emit               write the report. Without it the report is printed and nothing is written.
 *   --out <path>         write it somewhere else.
 *
 * Exit codes: 0 every claim held; 1 any rule broken, named on stderr (ADR 0003).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  AVAILABILITY_BUDGET_CONCURRENCY,
  AVAILABILITY_P95_BUDGET_MS,
  budgetVerdict,
  SOAK_BACKLOG_EVENTS,
  SOAK_CONTENTION_ATTEMPTS,
  SOAK_REPORT_VERSION,
  soakPercentileMs,
  soakProblems,
} from '../packages/core/src/ops/soak.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import {
  buildSoakSalon,
  runAvailabilityLoad,
  runLastSlotContention,
  runOutboxBacklog,
  teardownSoakSalon,
} from '../packages/fixtures/src/soak.ts'

const DEFAULT_OUT = 'artifacts/soak/report.json'
const OPEN_QUESTION_ID = 'Y13-perf-budget'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const number = (name, fallback) => {
  const value = Number(flag(name, String(fallback)))
  if (!Number.isInteger(value) || value < 0) {
    console.error(`--${name} must be a non-negative integer.`)
    process.exit(2)
  }
  return value
}

const attempts = number('attempts', SOAK_CONTENTION_ATTEMPTS)
const events = number('events', SOAK_BACKLOG_EVENTS)
const concurrency = number('concurrency', AVAILABILITY_BUDGET_CONCURRENCY)
const batches = number('batches', 3)
const drainers = number('drainers', 2)
const batchSize = number('batch-size', 200)
const pool = number('pool', 24)
const runInvariants = flag('invariants', 'on') === 'on'
const measuredOn = flag('measured-on', 'agent_container')
const outPath = flag('out', DEFAULT_OUT)

if (measuredOn !== 'agent_container' && measuredOn !== 'chosen_machine') {
  console.error(`--measured-on takes agent_container or chosen_machine, not ${measuredOn}.`)
  process.exit(2)
}

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (url === undefined) {
  console.error(
    'TEST_DATABASE_URL or DATABASE_URL is required: the soak runs against a real database.',
  )
  process.exit(2)
}

const sql = createConnection({ url, max: pool })
let salon
try {
  const [version] = await sql`show server_version`
  console.log(`Building the probe salon in ${new URL(url).pathname.replace(/^\//, '')}…`)
  salon = await buildSoakSalon(sql)

  console.log(`Contention: ${attempts} attempt(s) in flight for one place…`)
  const contention = await runLastSlotContention(sql, salon, attempts)
  console.log(
    `  ${contention.successes} committed, ${Object.entries(contention.refusalsByName)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ')}, ${contention.untypedFailures} untyped, in ${contention.elapsedMs} ms`,
  )

  console.log(`Availability: ${concurrency} in flight, ${batches} batch(es), cache off…`)
  const availability = await runAvailabilityLoad(sql, salon, concurrency, batches)
  const p95Ms = soakPercentileMs(availability.samples, 95)
  const medianMs = soakPercentileMs(availability.samples, 50)
  console.log(
    `  p95 ${String(p95Ms)} ms, median ${String(medianMs)} ms over ${availability.samples.length} sample(s)`,
  )

  console.log(`Backlog: ${events} event(s), ${drainers} drainer(s), batches of ${batchSize}…`)
  const backlog = await runOutboxBacklog(sql, { events, drainers, batchSize })
  console.log(
    `  ${backlog.deliveries} delivery row(s) over ${backlog.distinctPairs} distinct pair(s) in ` +
      `${backlog.drainMs} ms; handler calls ${JSON.stringify(backlog.handlerCalls)}, calls for ` +
      `events this run did not publish ${JSON.stringify(backlog.foreignHandlerCalls)}`,
  )

  const invariants = runInvariants
    ? (() => {
        // An explicit ceiling, because this is the step that can hang and the soak is long already
        // (brief rules 21/23).
        const child = spawnSync('pnpm', ['money-invariants'], {
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: 20 * 60 * 1000,
        })
        process.stderr.write(
          `\n--- money-invariants ---\n${child.stdout ?? ''}${child.stderr ?? ''}\n`,
        )
        return {
          name: 'money-invariants',
          ran: true,
          exitCode: child.signal ? null : child.status,
          skippedReason: child.signal ? `killed by ${child.signal}` : null,
        }
      })()
    : { name: 'money-invariants', ran: false, exitCode: null, skippedReason: '--invariants off' }

  const report = {
    reportVersion: SOAK_REPORT_VERSION,
    runAtIso: new Date().toISOString(),
    machine: {
      platform: process.platform,
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
      loadAverage1m: Number((loadavg()[0] ?? 0).toFixed(2)),
      postgresVersion: String(version?.['server_version'] ?? 'unknown'),
      measuredOn,
    },
    contention: {
      attempts: contention.attempts,
      successes: contention.successes,
      refusalsByName: contention.refusalsByName,
      untypedFailures: contention.untypedFailures,
      rawSqlstateFailures: contention.rawSqlstateFailures,
      overCapacityRooms: contention.overCapacityRooms,
    },
    availability: {
      concurrency: availability.concurrency,
      batches: availability.batches,
      samples: availability.samples,
      p95Ms,
      medianMs,
      /*
        The budget is stated only at the concurrency it was committed at. B-AVAIL-07's acceptance line
        names 300 ms for 50 concurrent queries on the CI Postgres; nobody has committed a figure at any
        other concurrency and nobody has observed a peak, so a budget here for 200 would be invented
        (brief rule 15, `Y13-perf-budget`).
      */
      budgetMs: concurrency === AVAILABILITY_BUDGET_CONCURRENCY ? AVAILABILITY_P95_BUDGET_MS : null,
    },
    backlog: {
      events: backlog.events,
      handlers: backlog.handlers,
      drainers: backlog.drainers,
      batchSize: backlog.batchSize,
      deliveries: backlog.deliveries,
      distinctPairs: backlog.distinctPairs,
      unpublishedAfter: backlog.unpublishedAfter,
      drainMs: backlog.drainMs,
      handlerCalls: backlog.handlerCalls,
      foreignHandlerCalls: backlog.foreignHandlerCalls,
    },
    invariants,
    notProved: [
      'No production traffic, no production data volume and no production hardware. The salon is a ' +
        'probe mirroring what B-CAT-06 seeds — five rooms and eight therapists — not the live one.',
      'The latency figures are a measurement of THIS machine. availability-perf.itest.ts measured the ' +
        'same container six times: 192-231 ms alone and 315-417 ms inside a full run, against a 300 ms ' +
        'budget committed for the CI Postgres. A p95 from here separates the container’s mood and ' +
        'not two versions of the query (brief rule 23).',
      'No peak has been observed, so the declared concurrency is a load somebody chose and not a ' +
        'forecast. There is no committed figure at any concurrency but 50 (' +
        OPEN_QUESTION_ID +
        ').',
      'Nothing here exercises the HTTP layer, the browser or the worker process. The contention is ' +
        'measured at the service boundary, so "zero unhandled constraint-violation 5xx" is proved as ' +
        '"every rejection carried a refusal name and no raw SQLSTATE reached a caller".',
      'The backlog is drained by several drainOutbox calls in ONE process, which exercises ' +
        '`for update skip locked` and does not exercise two deployed workers on two hosts.',
    ],
    openQuestionId: OPEN_QUESTION_ID,
  }

  const problems = soakProblems(report)
  const verdict = budgetVerdict(report)

  if (argv.includes('--emit')) {
    mkdirSync(join(outPath, '..'), { recursive: true })
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`Wrote ${outPath}`)
  }

  console.log(
    `\nSoak: ${report.contention.attempts} contender(s) for one place with ` +
      `${report.contention.successes} success; ${report.backlog.deliveries} delivery row(s) over ` +
      `${report.backlog.events} event(s) and ${report.backlog.handlers} handler(s); availability p95 ` +
      `${String(report.availability.p95Ms)} ms at concurrency ${report.availability.concurrency}, ` +
      `verdict ${verdict.kind}.`,
  )
  if (verdict.kind === 'not_judged') console.log(`  budget not judged: ${verdict.reason}`)
  for (const line of report.notProved) console.log(`  not proved: ${line}`)

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
    console.error(`\n${problems.length} problem(s). The soak did not prove what it claims.`)
    process.exitCode = 1
  }
} finally {
  if (salon !== undefined) await teardownSoakSalon(sql, salon)
  await sql.end({ timeout: 10 })
}

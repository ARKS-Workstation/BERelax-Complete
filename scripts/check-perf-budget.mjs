#!/usr/bin/env node
/**
 * The committed soak report must say what it measured, and its figures must be its own.
 *
 * `pnpm perf-budget`. H-HARD-11. It reads `artifacts/soak/report.json` and needs no database: the point
 * of recording a soak is that the evidence outlives the rows it was measured over.
 *
 * ## What it enforces, and the one thing it deliberately does not
 *
 * Every rule is re-judged from the figures by `soakProblems` — the same function the soak itself
 * applies, so the gate and the run cannot come to disagree about what "passed" means. That covers the
 * claims about the code (exactly one success out of 200, exactly one delivery per (event, handler), no
 * room over capacity, the invariants still true) and the report's own arithmetic (the p95 recomputed
 * from the samples, so a hand-edited figure fails).
 *
 * What it does NOT do is fail the build because the p95 taken on an agent container is above 300 ms.
 * Brief rule 23: that figure is a measurement of the container, and
 * `availability-perf.itest.ts` has the six readings that make it a fact rather than an opinion. The
 * committed budget is enforced for a reading whose `machine.measuredOn` is `chosen_machine`, and a gate
 * case supplies exactly that to prove the rule fires.
 *
 * Usage: `node scripts/check-perf-budget.mjs [--report <path>]`
 */
import { existsSync, readFileSync } from 'node:fs'
import { budgetVerdict, SOAK_RULES, soakProblems } from '../packages/core/src/ops/soak.ts'

const DEFAULT_REPORT = 'artifacts/soak/report.json'
const argv = process.argv.slice(2)
const at = argv.indexOf('--report')
const reportPath = at === -1 ? DEFAULT_REPORT : (argv[at + 1] ?? DEFAULT_REPORT)

if (!existsSync(reportPath)) {
  console.error(
    `[${SOAK_RULES.malformed}] ${reportPath} does not exist, so no soak has been recorded. A ` +
      'concurrency design nobody has put under contention is a design, not a result.',
  )
  process.exit(1)
}

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (error) {
  console.error(`[${SOAK_RULES.malformed}] ${reportPath} is not readable JSON: ${error.message}`)
  process.exit(1)
}

const problems = soakProblems(report)
if (problems.length > 0) {
  for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(
    `\n${problems.length} problem(s) with ${reportPath}. Re-run the soak (\`pnpm soak --emit\`) rather ` +
      'than editing the artefact.',
  )
  process.exit(1)
}

const verdict = budgetVerdict(report)
console.log(
  `Soak recorded ${report.runAtIso} on ${report.machine.measuredOn} ` +
    `(${report.machine.cpus} core(s), load ${report.machine.loadAverage1m}, PostgreSQL ` +
    `${report.machine.postgresVersion}).`,
)
console.log(
  `Contention: ${report.contention.attempts} attempt(s) for one place, ${report.contention.successes} ` +
    `success, ${Object.entries(report.contention.refusalsByName)
      .map(([name, count]) => `${count} ${name}`)
      .join(', ')}, ${report.contention.untypedFailures} untyped, ` +
    `${report.contention.overCapacityRooms} room(s) over capacity.`,
)
console.log(
  `Backlog: ${report.backlog.deliveries} delivery row(s) over ${report.backlog.events} event(s) and ` +
    `${report.backlog.handlers} handler(s) — ${report.backlog.distinctPairs} distinct pair(s), ` +
    `${report.backlog.unpublishedAfter} unpublished, drained by ${report.backlog.drainers} drainer(s) ` +
    `in ${report.backlog.drainMs} ms.`,
)
console.log(
  `Availability: p95 ${String(report.availability.p95Ms)} ms, median ` +
    `${String(report.availability.medianMs)} ms over ${report.availability.samples.length} sample(s) at ` +
    `concurrency ${report.availability.concurrency}. Budget verdict: ${verdict.kind}.`,
)
if (verdict.kind === 'not_judged') console.log(`  not judged: ${verdict.reason}`)
for (const line of report.notProved) console.log(`  not proved: ${line}`)

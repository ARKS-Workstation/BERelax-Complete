#!/usr/bin/env node
/**
 * The committed restore drill must be evidence, and must still be evidence about THIS schema.
 *
 * `pnpm drill-age`. H-HARD-04. It reads `artifacts/drills/restore-report.json` and the migration
 * directory, and needs no database — the whole point of recording a drill is that the evidence outlives
 * the throwaway database it was measured in (`check-dry-runs.mjs`'s argument, one subject over).
 *
 * ## The five rules, and the one that is NOT a calendar
 *
 *   * `drill-report-missing` — no drill has been recorded at all. A backup nobody has restored is a
 *     backup whose format, completeness and readability are all assumptions.
 *   * `drill-report-digest-mismatch` — a figure was edited by hand. Recomputing the digest means
 *     running the drill, which means performing the restore, so "the artefact says it passed" and "it
 *     passed" are the same claim.
 *   * `drill-report-stale-schema` — a migration the drill RESTORED has been changed since. This is the
 *     staleness rule, and it is a PREFIX rule rather than a calendar one: appending migration 0159 does
 *     not make yesterday's restore untrue, so a unit that adds a migration is not forced to re-run the
 *     drill to get a green build. Editing one the drill restored makes the evidence describe a schema
 *     that is not here any more, and that is what fails.
 *   * `drill-report-too-old` — the calendar bound, enforced ONLY when a maximum age has been
 *     configured, by `--max-age-days` or by `objectives.drillMaxAgeDays` in the artefact. There is no
 *     default, because a default would be a figure this build invented: how often a restore must be
 *     rehearsed is part of the same unanswered question as the RPO, the RTO and the backup retention
 *     period (`Y13-rpo-rto`). The figure is PRINTED by name on every run so the absence is visible
 *     rather than quiet.
 *   * `drill-report-did-not-verify` / `drill-report-examined-nothing` — the artefact records a run that
 *     restored something and then compared nothing, or ran nothing against it. ADR 0002's shape applied
 *     to the evidence rather than to the check.
 *
 * Every rule is re-judged from the figures rather than from a stored verdict, by the same functions the
 * drill itself applies (`packages/core/src/ops/restore-drill.ts`), so the gate and the drill cannot come
 * to disagree about what "passed" means.
 *
 * Usage: `node scripts/check-drill-age.mjs [--report <path>] [--max-age-days <n>] [--now <iso>]`
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalDrillReport,
  DRILL_REPORT_RULES,
  drillReportProblems,
} from '../packages/core/src/ops/restore-drill.ts'

const MIGRATIONS_DIR = 'packages/db/migrations'
const DEFAULT_REPORT = 'artifacts/drills/restore-report.json'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}

const reportPath = flag('report', DEFAULT_REPORT)
const maxAgeFlag = flag('max-age-days')
const maxAgeDays = maxAgeFlag === null ? null : Number(maxAgeFlag)
const nowIso = flag('now', new Date().toISOString())

if (maxAgeDays !== null && !Number.isFinite(maxAgeDays)) {
  console.error(`--max-age-days must be a number, not ${maxAgeFlag}.`)
  process.exit(1)
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** The digest over the first `count` migrations on disk, in order. `null` when there are fewer. */
function prefixDigest(count) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    // The floor (ADR 0002). An empty directory makes every comparison below vacuous, and the prefix
    // rule would report that the evidence is current — about no schema at all.
    console.error(
      `No migrations in ${MIGRATIONS_DIR}, so "the drill's schema is still a prefix of this tree" ` +
        'would be a claim about nothing. The directory walk is wrong.',
    )
    process.exit(1)
  }
  if (count > files.length) return { digest: null, onDisk: files.length }
  const prefix = files.slice(0, count)
  return {
    digest: sha256(
      prefix
        .map((name) => `${name}:${sha256(readFileSync(join(MIGRATIONS_DIR, name)))}`)
        .join('\n'),
    ),
    onDisk: files.length,
  }
}

let report = null
let recomputedDigest = null
let parseError = null

if (existsSync(reportPath)) {
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
    recomputedDigest = sha256(canonicalDrillReport(report))
  } catch (error) {
    parseError = String(error.message ?? error)
  }
}

if (parseError !== null) {
  console.error(
    `[${DRILL_REPORT_RULES.malformed}] ${reportPath} is not readable JSON: ${parseError}`,
  )
  process.exit(1)
}

const { digest, onDisk } =
  report === null ? { digest: null, onDisk: 0 } : prefixDigest(report.source?.migrationCount ?? 0)

const problems = drillReportProblems({
  report,
  recomputedDigest,
  migrationsOnDisk: onDisk,
  prefixDigestOnDisk: digest,
  nowIso,
  maxAgeDays,
})

if (problems.length > 0) {
  for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(
    `\n${problems.length} problem(s) with ${reportPath}. Re-run the drill (\`pnpm drill --emit\`) ` +
      'rather than editing the artefact.',
  )
  process.exit(1)
}

const objectives = report.objectives
const unanswered = Object.entries(objectives)
  .filter(([key, value]) => key !== 'openQuestionId' && value === null)
  .map(([key]) => key)

console.log(
  `Restore drill recorded ${report.runAtIso}: ${report.source.migrationCount} migration(s) restored, ` +
    `still a prefix of the ${onDisk} on disk; ${report.verification.tablesCompared} table(s) and ` +
    `${report.verification.rowsCompared} row(s) reconciled with no mismatch, ` +
    `${report.verification.readBacks.length} row(s) read back, digest holds.`,
)
console.log(
  `Measured on ${report.machine.measuredOn}: restore ${report.restore.durationMs} ms, data-loss window ` +
    `${report.dataLossWindowMs} ms for that run. PITR configured: ${report.pitr.configured} ` +
    `(wal_level ${report.pitr.walLevel}, archive_mode ${report.pitr.archiveMode}).`,
)
console.log(
  unanswered.length === 0
    ? 'Every recovery objective is configured.'
    : `NOT COMMITTED and therefore NOT ENFORCED: ${unanswered.join(', ')} — all null against ` +
        `${objectives.openQuestionId}. No figure here was invented to fill one in.`,
)

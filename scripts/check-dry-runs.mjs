#!/usr/bin/env node
/**
 * The migration may not be performed until three dry runs have been recorded and the latest of them
 * holds no unexplained variance.
 *
 * `pnpm dry-runs`. It reads `artifacts/migration/run-*.json`, which
 * `scripts/migrate-dry-run-full.mjs` writes, and needs no database: the whole point of recording a run is
 * that the evidence outlives the throwaway database it was measured in.
 *
 * ## Why three, and why the newest is judged more strictly than the others
 *
 * One run proves the importers execute. Two prove the result is reproducible. The third is what
 * distinguishes "reproducible" from "two runs happened to agree" — the same reason ADR 0003 asks for a
 * known-bad fixture rather than a passing check.
 *
 * Every recorded run has to hold no unexplained variance, not only the newest, and that is deliberately
 * stricter than the acceptance line's wording. A set in which run 1 failed and runs 2 and 3 passed is a
 * set in which something changed between them, and the report diff would then be comparing two different
 * states while reporting on one migration. If a run failed, it is evidence and belongs in the history of
 * the thing that was corrected — not in the three the gate reads.
 *
 * ## Why the stored digest is checked against the stored report
 *
 * A recorded run is a FILE in the repository, so every figure in it can be edited by hand — and the edit
 * nobody would notice is `unexplainedVariances` from 1 to 0, which is the figure this whole gate turns
 * on. The digest is a sha-256 over the report's canonical form, so changing a figure without recomputing
 * it fails here, and recomputing it means running the driver, which means running the import.
 *
 * ## Exit codes
 *
 *   0  three or more recorded runs, every one clean, consecutive runs agreeing outside a reminted key.
 *   1  any rule broken. Every failure names the rule, so a gate case can assert the rule rather than a
 *      non-zero exit (ADR 0003).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkRecordedRuns,
  DRY_RUN_RULES,
  MINIMUM_RECORDED_DRY_RUNS,
  parseRecordedDryRun,
} from '../packages/migration/src/report/diff.ts'

/**
 * Where the recorded runs live. `--dir` exists so a gate case can point this at a directory holding a
 * deliberately short or deliberately broken set, which is the only way the "fewer than three" rule can
 * be seen to fire without deleting a committed artefact out of the working tree (ADR 0003).
 */
const argv = process.argv.slice(2)
const dirFlag = argv.indexOf('--dir')
const RUNS_DIR =
  dirFlag === -1 ? 'artifacts/migration' : (argv[dirFlag + 1] ?? 'artifacts/migration')
const RUN_FILE = /^run-(\d+)\.json$/

if (!existsSync(RUNS_DIR)) {
  console.error(
    `${RUNS_DIR} does not exist, so no dry run has been recorded. ` +
      `[${DRY_RUN_RULES.threeRunsRecorded}]`,
  )
  process.exit(1)
}

const files = readdirSync(RUNS_DIR)
  .filter((file) => RUN_FILE.test(file))
  .sort()

const runs = []
const problems = []
for (const file of files) {
  const where = join(RUNS_DIR, file)
  try {
    const run = parseRecordedDryRun(readFileSync(where, 'utf8'), where)
    const declared = Number(RUN_FILE.exec(file)?.[1] ?? '0')
    if (run.runNumber !== declared) {
      // The file name and the recorded number are two statements of one fact, so they are held equal
      // here: a run recorded as 2 in a file called run-3.json would be diffed against the wrong
      // neighbour and the comparison would report on a pair that never followed each other.
      problems.push({
        rule: DRY_RUN_RULES.consecutiveRunsAgree,
        detail: `${where} records runNumber ${run.runNumber}, and its name says ${declared}.`,
      })
    }
    runs.push(run)
  } catch (error) {
    problems.push({ rule: DRY_RUN_RULES.threeRunsRecorded, detail: String(error.message ?? error) })
  }
}

problems.push(...checkRecordedRuns(runs))

if (problems.length > 0) {
  for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(
    `\n${problems.length} problem(s) in ${runs.length} recorded dry run(s). A variance is tied to a ` +
      'named cause or it is unexplained, and an unexplained one is not a smaller version of a failed ' +
      'migration (ADR 0070).',
  )
  process.exit(1)
}

const latest = [...runs].sort((left, right) => right.runNumber - left.runNumber)[0]
const notRun = latest?.importersNotRun ?? []
console.log(
  `${runs.length} recorded dry run(s), minimum ${MINIMUM_RECORDED_DRY_RUNS}: every one holds no ` +
    'unexplained variance, every post-import check passed, and consecutive runs differ only in a ' +
    'reminted key.',
)
console.log(
  `Latest run ${latest?.runNumber}: ${latest?.importersRun.length} importer(s) run, ` +
    `${notRun.length} not run — ${notRun.map((entry) => `${entry.importer} (${entry.openQuestionId})`).join(', ') || 'none'}.`,
)

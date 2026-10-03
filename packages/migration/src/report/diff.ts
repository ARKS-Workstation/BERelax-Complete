import { AppError } from '@berelax/shared'
import type { ReconciliationReport, ReconciliationRun } from './generate.ts'
import { reportContentDigest } from './generate.ts'
import { reportFigures } from './render.ts'

/**
 * The diff between two recorded reconciliation runs, and what a difference is allowed to be.
 *
 * H-MIG-09's third acceptance line: "run N+1 starting from a clean restore differs from run N only in
 * explained variance, asserted by a report diff". This is that diff, and the whole difficulty is the
 * word ONLY — a diff that classified too generously would pass over exactly the change it exists to
 * catch.
 *
 * ## Why there is a list of REMINTED fields and why it is two names long
 *
 * A dry run applies every migration to an empty database, so every surrogate key in it is new:
 * `uuid_generate_v7()` embeds the millisecond it ran in. Two runs over identical source files therefore
 * differ in every id and in nothing else, and a diff that reported those as differences would report
 * every run as different from every other — after which the only way to use it is to stop reading it.
 *
 * So exactly two field names are declared as reminted, by NAME and not by shape: `runId`, which the
 * staging ledger mints per run, and `recordId`, which a quarantine record row carries. Both are
 * surrogate keys with no content in them.
 *
 * **It is a name list and not a "looks like a uuid" test**, which is the version that suggests itself and
 * is wrong in the direction that matters: `sourceFileHash` and `contentHash` are also opaque hex, and
 * they are the two values whose CHANGING is the most important thing this diff can report — a source
 * file that is not the file the last run imported, or a row whose content moved. A shape test would
 * quietly excuse both.
 *
 * Everything else is MATERIAL. A changed count, a changed total, a changed variance, a changed cause, a
 * figure that appeared or disappeared: every one is a difference somebody has to account for, and the
 * diff names the path rather than reporting a boolean.
 */

/**
 * Field names a fresh database necessarily remints, so a difference in one is not a difference in data.
 *
 * Matched on the LAST segment of a figure's path, so `sources.3.runId` and `quarantine.0.recordId`
 * resolve without the list needing to know how deep the report nests.
 */
export const REMINTED_FIELDS: readonly string[] = Object.freeze(['runId', 'recordId'])

export interface ReportDifference {
  readonly path: string
  /** The figure in the earlier run, or `null` when the path is only in the later one. */
  readonly left: string | null
  readonly right: string | null
}

export interface RunDiff {
  /** Differences in a declared surrogate key. Expected, and counted so "none at all" is visible. */
  readonly reminted: readonly ReportDifference[]
  /** Everything else. Must be empty for two runs over one corpus from a clean database. */
  readonly material: readonly ReportDifference[]
}

const lastSegment = (path: string): string => path.slice(path.lastIndexOf('.') + 1)

/** Two reports, compared figure by figure over the generic walk both forms are rendered from. */
export function diffReconciliationReports(
  left: ReconciliationReport,
  right: ReconciliationReport,
): RunDiff {
  // The same walk `render.ts` renders from, deliberately: a diff with a traversal of its own would be a
  // second statement of the report's shape, and the first field it failed to reach would be a field no
  // diff could ever report a change in.
  const leftFigures = new Map(reportFigures(left).map((figure) => [figure.path, figure.value]))
  const rightFigures = new Map(reportFigures(right).map((figure) => [figure.path, figure.value]))

  const paths = [...new Set([...leftFigures.keys(), ...rightFigures.keys()])].sort()
  const reminted: ReportDifference[] = []
  const material: ReportDifference[] = []
  for (const path of paths) {
    const before = leftFigures.get(path) ?? null
    const after = rightFigures.get(path) ?? null
    if (before === after) continue
    const difference = { path, left: before, right: after }
    // A path present in one report and not the other is MATERIAL even when its name is reminted: a
    // quarantine row that appeared, or a source file that vanished, is not a reminted key.
    if (before !== null && after !== null && REMINTED_FIELDS.includes(lastSegment(path))) {
      reminted.push(difference)
      continue
    }
    material.push(difference)
  }
  return { reminted: Object.freeze(reminted), material: Object.freeze(material) }
}

export interface RecordedRunProblem {
  readonly rule: string
  readonly detail: string
}

/**
 * Every rule a recorded run has to satisfy on its own, named so a gate can assert by the rule.
 *
 * The digest check is the one worth reading. A recorded run is a FILE in the repository, so the figures
 * in it can be edited by hand — and the one edit nobody would notice is `unexplainedVariances` from 1 to
 * 0, which is the figure the whole gate turns on. Holding the stored digest against the stored report is
 * what makes that edit a failing build: the digest is a sha-256 over the report's canonical form, so
 * changing a figure without recomputing it is caught, and recomputing it means running the driver.
 */
export const DRY_RUN_RULES = {
  digestMatchesReport: 'recorded-run-digest-must-match-its-report',
  noUnexplainedVariance: 'recorded-run-must-have-no-unexplained-variance',
  statesAnImporter: 'recorded-run-must-state-at-least-one-importer-that-ran',
  consecutiveRunsAgree: 'consecutive-runs-must-differ-only-in-a-reminted-key',
  postImportChecksPassed: 'recorded-run-must-record-every-post-import-check-passing',
  threeRunsRecorded: 'at-least-three-dry-runs-must-be-recorded',
} as const

export const MINIMUM_RECORDED_DRY_RUNS = 3

/** The shape a recorded run adds on top of a {@link ReconciliationRun}: what the driver did. */
export interface RecordedDryRun extends ReconciliationRun {
  readonly runNumber: number
  /** Importers the driver actually ran, with the source file each one read. */
  readonly importersRun: readonly { readonly importer: string; readonly sourceFile: string }[]
  /** Importers it did NOT run, each with the open question that blocks it. Never silently absent. */
  readonly importersNotRun: readonly {
    readonly importer: string
    readonly reason: string
    readonly openQuestionId: string
  }[]
  /**
   * The suites the driver ran against the POST-IMPORT database, with the verdict of each.
   *
   * On the wrapper and not inside `report`, for the reason the instant is: a suite's verdict is a fact
   * about this execution rather than about the data, and two runs are compared on `report`. The rule that
   * every one of them passed is checked separately ({@link DRY_RUN_RULES.postImportChecksPassed}), so a
   * recorded run whose invariant census failed cannot satisfy the gate by having a clean report.
   */
  readonly postImportChecks: readonly {
    readonly name: string
    readonly command: string
    readonly ok: boolean
  }[]
}

/** What is wrong with one recorded run, considered alone. */
export function checkRecordedRun(run: RecordedDryRun): readonly RecordedRunProblem[] {
  const problems: RecordedRunProblem[] = []
  const recomputed = reportContentDigest(run.report)
  if (recomputed !== run.contentDigest) {
    problems.push({
      rule: DRY_RUN_RULES.digestMatchesReport,
      detail:
        `run ${run.runNumber} stores digest ${run.contentDigest} and its report hashes to ` +
        `${recomputed}. A recorded run is a file in the repository, so a figure in it can be edited by ` +
        'hand — and the edit nobody would notice is unexplainedVariances from 1 to 0, which is what ' +
        'this whole gate turns on. Re-record the run with the driver.',
    })
  }
  if (run.report.unexplainedVariances !== 0) {
    problems.push({
      rule: DRY_RUN_RULES.noUnexplainedVariance,
      detail:
        `run ${run.runNumber} holds ${run.report.unexplainedVariances} variance(s) that no named cause ` +
        'accounts for: ' +
        run.report.variances
          .filter((variance) => variance.unexplained !== 0)
          .map((variance) => `${variance.subject} by ${variance.unexplained} ${variance.measure}`)
          .join('; '),
    })
  }
  if (!Array.isArray(run.postImportChecks) || run.postImportChecks.length === 0) {
    problems.push({
      rule: DRY_RUN_RULES.postImportChecksPassed,
      detail:
        `run ${run.runNumber} records no post-import check at all. The fourth acceptance line is that ` +
        'the invariant suite passes against the POST-IMPORT database, and a run that recorded no ' +
        'verdict satisfies that line by saying nothing.',
    })
  } else {
    for (const check of run.postImportChecks) {
      if (check.ok) continue
      problems.push({
        rule: DRY_RUN_RULES.postImportChecksPassed,
        detail: `run ${run.runNumber}: ${check.name} (${check.command}) did not pass.`,
      })
    }
  }
  if (run.importersRun.length === 0) {
    problems.push({
      rule: DRY_RUN_RULES.statesAnImporter,
      detail:
        `run ${run.runNumber} ran no importer at all. A dry run of nothing has no variance and would ` +
        'satisfy every check above it, which is ADR 0002 exactly: a passing check that examined nothing ' +
        'is worse than a failing one.',
    })
  }
  return problems
}

/** What is wrong with a SET of recorded runs: the count, and each consecutive pair. */
export function checkRecordedRuns(runs: readonly RecordedDryRun[]): readonly RecordedRunProblem[] {
  const problems: RecordedRunProblem[] = []
  if (runs.length < MINIMUM_RECORDED_DRY_RUNS) {
    problems.push({
      rule: DRY_RUN_RULES.threeRunsRecorded,
      detail:
        `${runs.length} recorded dry run(s). The requirement is ${MINIMUM_RECORDED_DRY_RUNS}: one run ` +
        'proves the importers execute, two prove the result is reproducible, and the third is what ' +
        'distinguishes "reproducible" from "two runs happened to agree".',
    })
  }
  const ordered = [...runs].sort((left, right) => left.runNumber - right.runNumber)
  for (const [at, run] of ordered.entries()) {
    problems.push(...checkRecordedRun(run))
    const previous = ordered[at - 1]
    if (previous === undefined) continue
    const diff = diffReconciliationReports(previous.report, run.report)
    if (diff.material.length > 0) {
      problems.push({
        rule: DRY_RUN_RULES.consecutiveRunsAgree,
        detail:
          `run ${previous.runNumber} and run ${run.runNumber} started from the same clean database and ` +
          `the same corpus and disagree on ${diff.material.length} figure(s): ` +
          diff.material
            .slice(0, 8)
            .map(
              (entry) =>
                `${entry.path} ${entry.left ?? '(absent)'} -> ${entry.right ?? '(absent)'}`,
            )
            .join('; '),
      })
    }
  }
  return problems
}

/** Parses a recorded run, refusing a file that is not one rather than reading fields off it loosely. */
export function parseRecordedDryRun(source: string, where: string): RecordedDryRun {
  const parsed: unknown = JSON.parse(source)
  const bad = (what: string): never => {
    throw new AppError(
      'validation',
      `${where} is not a recorded dry run: ${what}. Refused rather than read loosely, because every ` +
        'field this gate reads would otherwise be `undefined` and every check over it would pass.',
      { details: { where } },
    )
  }
  if (typeof parsed !== 'object' || parsed === null) return bad('it is not an object')
  const run = parsed as Partial<RecordedDryRun>
  if (typeof run.runNumber !== 'number') return bad('runNumber is not a number')
  if (typeof run.generatedAt !== 'string') return bad('generatedAt is not a string')
  if (typeof run.contentDigest !== 'string') return bad('contentDigest is not a string')
  if (typeof run.report !== 'object' || run.report === null) return bad('report is not an object')
  if (typeof run.report.unexplainedVariances !== 'number') {
    return bad('report.unexplainedVariances is not a number')
  }
  if (!Array.isArray(run.importersRun)) return bad('importersRun is not an array')
  if (!Array.isArray(run.importersNotRun)) return bad('importersNotRun is not an array')
  if (!Array.isArray(run.postImportChecks)) return bad('postImportChecks is not an array')
  return run as RecordedDryRun
}

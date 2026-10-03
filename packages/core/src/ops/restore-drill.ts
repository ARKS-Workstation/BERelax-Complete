/**
 * The restore drill's judgements: what makes a restore PROVED, and what makes recorded evidence stale.
 *
 * H-HARD-04. Pure, and separate from `scripts/restore-drill.mjs`, for the reason `go-live-payments.mjs`
 * states about its own list: a judgement that lives in a script is a judgement no test reaches. The
 * script dumps, restores, counts and times; every rule it applies to what came back is here, with a
 * test per rule.
 *
 * ## What this build can and cannot prove about a restore, stated first because the gap is the point
 *
 * There is **no cloud backup service, no WAL archive, no PITR target and no staging host** in this
 * deployment. There is one PostgreSQL 16 server. So the drill proves exactly one thing, end to end:
 * that a `pg_dump` of the live schema and data can be restored into a database created from nothing,
 * that every table comes back with the same number of rows, and that named rows can be READ OUT of
 * the restored database afterwards. ADR 0002's rule applied to disaster recovery: a drill that reports
 * success without reading a row back has proved that two commands exited zero.
 *
 * What it does NOT prove is written into every report as {@link DrillReport.notProved} and repeated in
 * `docs/runbooks/restore.md`: no restore onto different hardware, no restore from off-site media, no
 * point-in-time recovery to a chosen instant, and no figure for how much data a real failure would
 * lose — because that is the backup INTERVAL, and nothing schedules a backup here
 * (`Y13-rpo-rto`). A measured restore duration on this machine is not an RTO and this module will not
 * let a report call it one: {@link DrillObjectives} types all three commitments as `number | null`
 * and the gate prints them by name while they are null.
 *
 * ## Why staleness is a PREFIX rule and not a calendar
 *
 * The obvious rule — "fail when the newest report is older than N days" — needs an N, and nobody has
 * chosen one. The rule that needs no figure is stronger anyway: a recorded drill is evidence about the
 * migration set it restored, so it stays evidence for as long as that set is an unchanged PREFIX of the
 * set on disk. Appending migration 0159 does not make yesterday's restore untrue; EDITING migration
 * 0042, which the drill restored, makes the evidence describe a schema that no longer exists.
 *
 * A prefix rule also does not fail on correct work, which a calendar rule does: every unit that adds a
 * migration would have to re-run the drill to get a green build, and a gate that fails on correct work
 * is a gate people delete. The calendar bound is implemented all the same
 * ({@link DrillStalenessInput.maxAgeDays}, `--max-age-days`) so that the rule exists and can be seen to
 * fire; it is enforced when somebody configures a figure and never from a default this module invented.
 */

/**
 * One rule name per way the drill or its evidence can be wrong.
 *
 * Named rather than numbered, and printed by the scripts verbatim, because ADR 0003 asks a gate case to
 * assert the RULE and not a non-zero exit — a bare non-zero exit is satisfied by a syntax error.
 */
export const RESTORE_DRILL_RULES = {
  /** `pg_restore --list` could not read the backup: truncated, mis-formatted, or not a dump at all. */
  backupUnusable: 'restore-backup-unusable',
  /** The backup's table of contents is empty, so restoring it would succeed and restore nothing. */
  backupEmpty: 'restore-backup-empty',
  /** A table came back with a different number of rows, or did not come back. */
  rowCountMismatch: 'restore-row-count-mismatch',
  /** A named row could not be read out of the restored database, or came back different. */
  readBackFailed: 'restore-read-back-failed',
  /** The suite the drill runs against the restored database did not pass. */
  suiteFailed: 'restore-suite-failed',
  /** The drill compared nothing: no tables, or no read-backs. ADR 0002's shape. */
  examinedNothing: 'restore-examined-nothing',
} as const

/** One rule name per way the COMMITTED evidence can be wrong, read by `scripts/check-drill-age.mjs`. */
export const DRILL_REPORT_RULES = {
  missing: 'drill-report-missing',
  malformed: 'drill-report-malformed',
  /** A figure was edited by hand without re-running the drill. */
  digestMismatch: 'drill-report-digest-mismatch',
  /** A migration the drill restored has since been changed, so the evidence is about another schema. */
  staleSchema: 'drill-report-stale-schema',
  /** Only when a maximum age has been configured. There is no default. */
  tooOld: 'drill-report-too-old',
  /** The report records a run that did not verify what it restored. */
  didNotVerify: 'drill-report-did-not-verify',
  /** The report records a run that compared nothing. */
  examinedNothing: 'drill-report-examined-nothing',
} as const

/** A problem, as both scripts print it: the rule, then what is wrong. */
export interface DrillProblem {
  readonly rule: string
  readonly detail: string
}

// ------------------------------------------------------------------------------------------------
// Row counts
// ------------------------------------------------------------------------------------------------

/** One table's row count, as both databases are asked for it. */
export interface TableRowCount {
  readonly table: string
  readonly rows: number
}

/** A table the two databases disagree about. `null` means the table was not there at all. */
export interface RowCountMismatch {
  readonly table: string
  readonly source: number | null
  readonly restored: number | null
}

/**
 * Every table the source and the restored database disagree about, in BOTH directions.
 *
 * Both directions because a partial restore and an over-restore fail differently and only one of them
 * is obvious. A table missing from the restore is the one everybody expects; a table present in the
 * restore and absent from the source means the target was not created from nothing, which makes every
 * count in the report a comparison against somebody else's rows.
 *
 * Counts are compared exactly. There is no tolerance, for ADR 0070's reason in another subject: a few
 * rows of difference is either a restore that lost data or a source that was being written to while it
 * was dumped, and those need different answers rather than an allowance that absorbs both.
 */
export function reconcileRowCounts(
  source: readonly TableRowCount[],
  restored: readonly TableRowCount[],
): readonly RowCountMismatch[] {
  const restoredByTable = new Map(restored.map((entry) => [entry.table, entry.rows]))
  const sourceByTable = new Map(source.map((entry) => [entry.table, entry.rows]))
  const mismatches: RowCountMismatch[] = []
  for (const entry of source) {
    const after = restoredByTable.get(entry.table)
    if (after === undefined) {
      mismatches.push({ table: entry.table, source: entry.rows, restored: null })
    } else if (after !== entry.rows) {
      mismatches.push({ table: entry.table, source: entry.rows, restored: after })
    }
  }
  for (const entry of restored) {
    if (!sourceByTable.has(entry.table)) {
      mismatches.push({ table: entry.table, source: null, restored: entry.rows })
    }
  }
  return mismatches
}

// ------------------------------------------------------------------------------------------------
// Read-back
// ------------------------------------------------------------------------------------------------

/**
 * One row read out of the restored database and compared with what the source holds.
 *
 * `expected` is read from the SOURCE in the same run rather than written into this repository, because
 * a committed expectation is a second statement of the data and goes stale on the first seed change —
 * and a read-back whose expectation nobody maintains is the check that silently stops comparing.
 */
export interface ReadBack {
  /** What this read-back proves, in the words the report prints. */
  readonly claim: string
  readonly expected: string | null
  readonly actual: string | null
}

/** The read-backs that did not come back equal. A `null` on either side is a failure, not a skip. */
export function readBackFailures(readBacks: readonly ReadBack[]): readonly ReadBack[] {
  return readBacks.filter(
    (entry) => entry.expected === null || entry.actual === null || entry.expected !== entry.actual,
  )
}

// ------------------------------------------------------------------------------------------------
// The report
// ------------------------------------------------------------------------------------------------

/** The report format. Bumped when a field changes meaning, so an old artefact fails rather than reads. */
export const DRILL_REPORT_VERSION = 1

/**
 * The floor on what a drill must have compared before its report counts as evidence.
 *
 * Structural rather than chosen: one table and one read-back is the smallest set that could be called a
 * comparison, and a report of zero of either is the green tick over nothing. The real figure a run
 * records is whatever the schema has — 130-odd tables — and the assertion is against this floor so that
 * a probe which stopped matching fails here instead of passing with an empty list.
 */
export const MINIMUM_TABLES_COMPARED = 1
export const MINIMUM_READ_BACKS = 1

/**
 * The three commitments nobody in this build has made, carried as `null` and printed by name.
 *
 * `number | null` and not `number`, so the figure can be filled in by whoever decides it; and never
 * defaulted, because a default here is an invented recovery objective and a report carrying one is
 * indistinguishable from a report of a configured system (brief rule 15).
 */
export interface DrillObjectives {
  /** How much data a failure may lose. The backup INTERVAL; nothing schedules a backup here. */
  readonly rpoSeconds: number | null
  /** How long a restore may take. A measured duration on one machine is not this. */
  readonly rtoSeconds: number | null
  /** How long a backup is kept. There is no backup store, so there is nothing retaining anything. */
  readonly backupRetentionDays: number | null
  /** How stale a recorded drill may be, in days. Enforced only when set. See the module header. */
  readonly drillMaxAgeDays: number | null
  /** Where the four unanswered figures are recorded. */
  readonly openQuestionId: string
}

/** What `pg_dump` produced, and when. */
export interface DrillBackup {
  readonly tool: string
  readonly format: string
  readonly byteLength: number
  readonly tocEntries: number
  readonly startedAtIso: string
  readonly finishedAtIso: string
  readonly durationMs: number
}

/** What `pg_restore` did with it. */
export interface DrillRestore {
  readonly tool: string
  readonly startedAtIso: string
  readonly finishedAtIso: string
  readonly durationMs: number
  readonly exitCode: number
}

/** The machine the figures were taken on, so no duration can be read as a production figure. */
export interface DrillMachine {
  readonly platform: string
  readonly cpus: number
  readonly totalMemoryBytes: number
  readonly loadAverage1m: number
  readonly postgresVersion: string
  /**
   * Whether the figures were taken on a machine somebody chose for measuring.
   *
   * `agent_container` means several agents share four cores, which is brief rule 23's case: the figure
   * is about the container. Nothing in this repository may read an `agent_container` duration as a
   * recovery time.
   */
  readonly measuredOn: 'agent_container' | 'chosen_machine'
}

/** What PITR would need, read off the server rather than asserted. */
export interface DrillPitr {
  readonly configured: boolean
  readonly walLevel: string
  readonly archiveMode: string
  readonly reason: string
}

/**
 * A materialised view's row count on each side.
 *
 * Recorded and NOT reconciled: `pg_dump` emits a `REFRESH MATERIALIZED VIEW` rather than the rows, so a
 * restored view is computed from the restored base tables and is as at the RESTORE, not as at the dump.
 * The first run of the drill reported four of these as data loss. A view that came back EMPTY where the
 * source had rows is still a failure, and the script raises it — the distinction between "refreshed" and
 * "absent" is the whole reason this is a separate field rather than an exclusion.
 */
export interface DerivedViewCount {
  readonly table: string
  readonly sourceRows: number
  readonly restoredRows: number
}

/** What the drill checked after the restore. */
export interface DrillVerification {
  readonly tablesCompared: number
  readonly rowsCompared: number
  readonly mismatches: readonly RowCountMismatch[]
  readonly derivedViews: readonly DerivedViewCount[]
  readonly readBacks: readonly ReadBack[]
  readonly suite: {
    readonly name: string
    readonly ran: boolean
    readonly exitCode: number | null
    readonly skippedReason: string | null
  }
  readonly invariants: {
    readonly name: string
    readonly ran: boolean
    readonly exitCode: number | null
    readonly skippedReason: string | null
  }
}

/** A recorded drill. `artifacts/drills/restore-report.json`. */
export interface DrillReport {
  readonly reportVersion: number
  readonly runAtIso: string
  readonly machine: DrillMachine
  readonly source: {
    readonly database: string
    readonly migrationCount: number
    /** sha-256 over the ordered `name:sha256(bytes)` of every migration the drill restored. */
    readonly migrationPrefixDigest: string
  }
  readonly backup: DrillBackup
  readonly restore: DrillRestore
  readonly pitr: DrillPitr
  readonly verification: DrillVerification
  /**
   * The measured window in which a write would have been lost, for THIS run.
   *
   * It is the interval from the dump finishing to the restored database being verified: every write to
   * the source in that interval is absent from the restored copy. It is a measurement of this drill and
   * not an RPO — an RPO is a function of how often a backup is taken, and nothing takes one here.
   */
  readonly dataLossWindowMs: number
  readonly objectives: DrillObjectives
  /** What this drill did not prove. Prose, printed by the gate, never empty. */
  readonly notProved: readonly string[]
  /** sha-256 over {@link canonicalDrillReport}. */
  readonly digest: string
}

/**
 * The report's bytes with the digest removed and the keys ordered, which is what the digest is over.
 *
 * Key order is normalised because `JSON.stringify` preserves insertion order, so a report
 * re-serialised by a different code path would digest differently while holding identical figures —
 * and the failure would look exactly like the hand edit this digest exists to catch.
 */
export function canonicalDrillReport(report: DrillReport): string {
  const order = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(order)
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'digest')
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      return Object.fromEntries(entries.map(([key, inner]) => [key, order(inner)]))
    }
    return value
  }
  return JSON.stringify(order(report))
}

/**
 * Every way a drill's own run was not a proof, from the figures it recorded.
 *
 * Used by the script immediately after the restore, so a failed drill exits non-zero naming the rule,
 * and by the gate against the committed artefact, so the two cannot disagree about what "passed" means.
 */
export function drillRunProblems(report: DrillReport): readonly DrillProblem[] {
  const problems: DrillProblem[] = []
  const { verification } = report
  if (report.backup.tocEntries <= 0) {
    problems.push({
      rule: RESTORE_DRILL_RULES.backupEmpty,
      detail:
        `the backup's table of contents lists ${report.backup.tocEntries} entr(ies), so restoring it ` +
        'would succeed and restore nothing',
    })
  }
  if (verification.tablesCompared < MINIMUM_TABLES_COMPARED) {
    problems.push({
      rule: RESTORE_DRILL_RULES.examinedNothing,
      detail:
        `${verification.tablesCompared} table(s) were compared, below the floor of ` +
        `${MINIMUM_TABLES_COMPARED}: the row-count probe matched nothing, so "every table came back" ` +
        'would be a claim about no tables',
    })
  }
  if (verification.readBacks.length < MINIMUM_READ_BACKS) {
    problems.push({
      rule: RESTORE_DRILL_RULES.examinedNothing,
      detail:
        `${verification.readBacks.length} row(s) were read back out of the restored database, below the ` +
        `floor of ${MINIMUM_READ_BACKS}. Two commands exiting zero is not a restore (ADR 0002)`,
    })
  }
  if (verification.mismatches.length > 0) {
    problems.push({
      rule: RESTORE_DRILL_RULES.rowCountMismatch,
      detail: verification.mismatches
        .map(
          (entry) =>
            `${entry.table}: source ${entry.source ?? 'absent'}, restored ${entry.restored ?? 'absent'}`,
        )
        .join('; '),
    })
  }
  const failed = readBackFailures(verification.readBacks)
  if (failed.length > 0) {
    problems.push({
      rule: RESTORE_DRILL_RULES.readBackFailed,
      detail: failed
        .map(
          (entry) =>
            `${entry.claim}: expected ${entry.expected ?? 'a row'}, read ${entry.actual ?? 'nothing'}`,
        )
        .join('; '),
    })
  }
  if (report.restore.exitCode !== 0) {
    problems.push({
      rule: RESTORE_DRILL_RULES.backupUnusable,
      detail: `pg_restore exited ${report.restore.exitCode}`,
    })
  }
  for (const step of [verification.suite, verification.invariants]) {
    if (step.ran && step.exitCode !== 0) {
      problems.push({
        rule: RESTORE_DRILL_RULES.suiteFailed,
        detail: `${step.name} exited ${step.exitCode ?? 'with no status'} against the restored database`,
      })
    }
  }
  return problems
}

/** What the gate is given about the committed artefact and the tree it sits in. */
export interface DrillStalenessInput {
  /** The parsed report, or `null` when there is no artefact at all. */
  readonly report: DrillReport | null
  /** The digest recomputed from the artefact's own bytes. */
  readonly recomputedDigest: string | null
  /** The number of migration files on disk now. */
  readonly migrationsOnDisk: number
  /**
   * The digest recomputed over the FIRST `report.source.migrationCount` migrations on disk, in order.
   * `null` when there are fewer on disk than the report restored, which is itself the stale case.
   */
  readonly prefixDigestOnDisk: string | null
  readonly nowIso: string
  /** Enforced only when a number. See the module header: there is no default. */
  readonly maxAgeDays: number | null
}

const MS_PER_DAY = 86_400_000

/**
 * Every way the committed evidence fails to be evidence.
 *
 * The order matters: a missing or malformed artefact short-circuits, because every rule below reads a
 * figure out of it and reporting six problems about a file that is not there names the wrong defect.
 */
export function drillReportProblems(input: DrillStalenessInput): readonly DrillProblem[] {
  const { report } = input
  if (report === null) {
    return [
      {
        rule: DRILL_REPORT_RULES.missing,
        detail:
          'no restore drill has been recorded. A backup nobody has restored is a backup whose format, ' +
          'completeness and readability are all assumptions',
      },
    ]
  }
  const problems: DrillProblem[] = []
  if (report.reportVersion !== DRILL_REPORT_VERSION) {
    problems.push({
      rule: DRILL_REPORT_RULES.malformed,
      detail:
        `the artefact is version ${report.reportVersion} and this build reads version ` +
        `${DRILL_REPORT_VERSION}. Re-run the drill rather than editing the field`,
    })
    return problems
  }
  if (input.recomputedDigest !== null && input.recomputedDigest !== report.digest) {
    problems.push({
      rule: DRILL_REPORT_RULES.digestMismatch,
      detail:
        `the artefact records digest ${report.digest} and its own content digests to ` +
        `${input.recomputedDigest}. Every figure in a committed report can be edited by hand, and the ` +
        'edit nobody would notice is a mismatch list from one entry to none',
    })
  }
  if (report.notProved.length === 0) {
    problems.push({
      rule: DRILL_REPORT_RULES.malformed,
      detail:
        'the report lists nothing it did not prove. This drill restores one database on one machine ' +
        'from one local dump; a report claiming no limitations is wrong about itself',
    })
  }
  problems.push(...drillRunProblems(report).map((problem) => ({ ...problem })))
  if (input.prefixDigestOnDisk === null) {
    problems.push({
      rule: DRILL_REPORT_RULES.staleSchema,
      detail:
        `the report restored ${report.source.migrationCount} migration(s) and ${input.migrationsOnDisk} ` +
        'are on disk, so the set it describes is not a prefix of the current one',
    })
  } else if (input.prefixDigestOnDisk !== report.source.migrationPrefixDigest) {
    problems.push({
      rule: DRILL_REPORT_RULES.staleSchema,
      detail:
        `the first ${report.source.migrationCount} migration(s) on disk digest to ` +
        `${input.prefixDigestOnDisk} and the report restored ${report.source.migrationPrefixDigest}. A ` +
        'migration the drill restored has been changed since, so the evidence is about a schema that is ' +
        'no longer here. Appending a migration does NOT trip this',
    })
  }
  const maxAgeDays = input.maxAgeDays ?? report.objectives.drillMaxAgeDays
  if (maxAgeDays !== null) {
    const ageMs = Date.parse(input.nowIso) - Date.parse(report.runAtIso)
    if (Number.isFinite(ageMs) && ageMs > maxAgeDays * MS_PER_DAY) {
      problems.push({
        rule: DRILL_REPORT_RULES.tooOld,
        detail:
          `the newest recorded drill ran at ${report.runAtIso}, which is ` +
          `${(ageMs / MS_PER_DAY).toFixed(1)} day(s) ago, past the configured maximum of ${maxAgeDays}`,
      })
    }
  }
  if (!report.verification.suite.ran && !report.verification.invariants.ran) {
    problems.push({
      rule: DRILL_REPORT_RULES.didNotVerify,
      detail:
        'the report records neither the restore-drill suite nor the domain invariants as having run ' +
        'against the restored database, so nothing exercised the restored schema',
    })
  }
  return problems
}

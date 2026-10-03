/**
 * The cutover: one declared sequence, a dry-run mode that must leave every table checksum unchanged,
 * and a recorded window that is re-judged rather than read.
 *
 * H-MIG-11. Pure, and the judgement is here rather than in `scripts/cutover.mjs` for
 * `go-live-payments.mjs`'s stated reason: a judgement that lives in a script is a judgement no test
 * reaches.
 *
 * ## What a dry run of a cutover can and cannot prove
 *
 * It can prove the sequence is complete, that each read-only step passes against the real database, and
 * that nothing the run did changed a single table. It **cannot** prove how long the real cutover takes,
 * because the steps that take the time are the ones it did not perform. So the recorded window is
 * labelled for what it is: a floor measured over the steps that ran, with every skipped step recorded
 * as `null` beside the reason it was skipped. A total presented as an estimate of the real window would
 * be a figure this build invented about an event nobody has scheduled (brief rule 15), and
 * {@link cutoverRunProblems} refuses a record that claims otherwise.
 *
 * ## Why the checksums are the dry run's proof and not a log line
 *
 * "The dry run is read-only" is a claim about every statement the sequence issues, including the ones
 * inside the gates it calls. The cheap way to make that claim is to read the code and believe it; the
 * honest way is to checksum every table before and after and compare. The comparison names the table
 * that moved, because a bare "something changed" is satisfied by a clock column and by a real write
 * equally, and only one of those is a defect in this sequence.
 *
 * `import_staging.content_checksum` is the one implementation of a table checksum in this repository
 * (`packages/migration/src/checksum.ts`), so there is no second answer to *did this table change*.
 *
 * ## The floor
 *
 * A comparison over an empty table list passes. A dry run that checksummed nothing would therefore
 * report that nothing changed — about no tables at all — which is ADR 0002's shape pointed at the one
 * claim this mode exists to make. {@link CUTOVER_RULES.examinedNothing} refuses it.
 */

/** Rule names, printed verbatim by the script so a gate case can assert the rule (ADR 0003). */
export const CUTOVER_RULES = {
  malformed: 'cutover-run-malformed',
  /** A figure was edited by hand. Recomputing the digest means running the sequence again. */
  digestMismatch: 'cutover-run-digest-mismatch',
  /** A declared step with no record: the sequence was cut short and the record is shorter too. */
  stepNotRecorded: 'cutover-step-not-recorded',
  /** A recorded step the sequence does not declare. */
  stepNotDeclared: 'cutover-step-not-declared',
  /** The dry run's whole claim: a table whose checksum moved. */
  tableChanged: 'cutover-dry-run-changed-a-table',
  /** A step that writes, performed in a mode that may not write. */
  writingStepPerformed: 'cutover-dry-run-performed-a-writing-step',
  /** A step that failed. */
  stepFailed: 'cutover-step-failed',
  /** No window at all, or one that ends before it starts. */
  windowNotRecorded: 'cutover-window-not-recorded',
  /** The floor: nothing was checksummed, so "no table changed" is a claim about nothing. */
  examinedNothing: 'cutover-examined-no-tables',
} as const

/** Who performs a step. A script cannot stop a process or take a decision. */
export const CUTOVER_AGENTS = ['script', 'operator'] as const
export type CutoverAgent = (typeof CUTOVER_AGENTS)[number]

export interface CutoverStep {
  readonly id: string
  readonly label: string
  /** Why it is in the sequence, and why here. A sentence a reader can disagree with. */
  readonly why: string
  readonly agent: CutoverAgent
  /**
   * Whether performing it writes to the database.
   *
   * The dry run performs exactly the steps for which this is false. It is declared per step rather than
   * inferred from what the step does, because a step that acquired a write later would otherwise join
   * the dry run's set in silence — and the checksum comparison would then be the only thing that
   * noticed, on the day of a rehearsal rather than when the step changed.
   */
  readonly writes: boolean
  /** The commands the step runs, exactly as a reader would type them. Empty for an operator step. */
  readonly commands: readonly string[]
}

/**
 * The cutover sequence. Eleven steps, in order, and three of them are an operator's.
 *
 * It is short because this build's cutover is short: there is no blue/green deployment, no feature
 * flags to flip and no traffic to drain. What makes it a cutover rather than a deploy is the migration
 * of the previous arrangement's data and the moment the business starts reading this system instead of
 * paper — and the second of those is not something a script can do.
 */
export const CUTOVER_STEPS: readonly CutoverStep[] = Object.freeze([
  Object.freeze({
    id: 'preflight-go-no-go',
    label: 'The go/no-go check passes',
    why:
      'Six requirements, every one unmet until a fact clears it. First, because every later step costs ' +
      'something that cannot be given back and this one costs a file read.',
    agent: 'script' as CutoverAgent,
    writes: false,
    commands: Object.freeze(['node scripts/go-no-go.mjs']),
  }),
  Object.freeze({
    id: 'preflight-freeze',
    label: 'The tree is frozen, by somebody, for a reason',
    why:
      'A cutover from a tree that is still accepting changes is a cutover of a build nobody has ' +
      'finished testing. The freeze is a claim a human makes and this step reads it rather than ' +
      'deciding it.',
    agent: 'script' as CutoverAgent,
    writes: false,
    commands: Object.freeze(['node scripts/freeze.mjs --register-only']),
  }),
  Object.freeze({
    id: 'preflight-schema-is-newest',
    label: 'The database is at the newest migration on disk',
    why:
      'There is no applied-migrations table and no down-migration in this build ' +
      '(scripts/apply-migrations.mjs), so a schema behind the tree is a schema the code reads wrongly ' +
      'and a cutover is the worst moment to find out.',
    agent: 'script' as CutoverAgent,
    writes: false,
    commands: Object.freeze(['node scripts/check-schema-drift.mjs']),
  }),
  Object.freeze({
    id: 'stop-the-worker',
    label: 'Stop the worker',
    why:
      'The worker sends messages about appointments. Importing the previous arrangement’s history ' +
      'while it is running would send reminders for appointments that already happened, and a sent ' +
      'message cannot be recalled.',
    agent: 'operator' as CutoverAgent,
    writes: true,
    commands: Object.freeze([]),
  }),
  Object.freeze({
    id: 'backup-before-anything',
    label: 'Take a backup, and read it back',
    why:
      'Everything after this point writes. pg_dump --format=custom per the restore runbook, and ADR ' +
      '0123 is why a backup nobody has restored is not evidence: the drill reads rows back, and so ' +
      'must this. An operator\u2019s step because no backup destination is on file (Y13-rpo-rto), and a ' +
      'script that chose one would be choosing where the only copy of this business goes.',
    agent: 'operator' as CutoverAgent,
    writes: false,
    commands: Object.freeze([]),
  }),
  Object.freeze({
    id: 'final-import',
    label: 'Run the importers against the real workbooks',
    why:
      'The migration itself. Three importers cannot run at all while their inputs are unanswered, and ' +
      'the recorded run says which and why rather than importing nothing and reporting no variance.',
    agent: 'script' as CutoverAgent,
    writes: true,
    commands: Object.freeze(['tsx scripts/migrate-import.mjs']),
  }),
  Object.freeze({
    id: 'post-import-reconciliation',
    label: 'Reconcile the import and record the report',
    why:
      'The counted comparison between what the previous arrangement held and what this system now ' +
      'holds. An unexplained variance here is not a smaller version of a failed migration (ADR 0070).',
    agent: 'script' as CutoverAgent,
    writes: true,
    commands: Object.freeze(['tsx scripts/migrate-report.mjs']),
  }),
  Object.freeze({
    id: 'post-import-invariants',
    label: 'The invariant gates against the migrated database',
    why:
      'The gates re-derive every identity over every row the database now holds, rather than over the ' +
      'rows one fixture wrote. They are the only thing that reads the imported estate as a whole. ' +
      'Marked as WRITING even though it asserts rather than migrates, because the named sets are ' +
      'registries of EXISTING TESTS and those tests insert their own fixtures: a dry run that ran them ' +
      'would change the tables it is supposed to prove it left alone, and the checksum comparison ' +
      'would then be refusing this step rather than catching a real write.',
    agent: 'script' as CutoverAgent,
    writes: true,
    commands: Object.freeze(['pnpm money-invariants']),
  }),
  Object.freeze({
    id: 'record-the-decision',
    label: 'Record the cutover decision',
    why:
      'parallel_run_decision (H-MIG-10, ADR 0107) is a free column over two values that a named person ' +
      'fills in with their own rationale. Nothing in this build decides it, and ZY744 refuses one no ' +
      'named person is behind.',
    agent: 'operator' as CutoverAgent,
    writes: true,
    commands: Object.freeze([]),
  }),
  Object.freeze({
    id: 'start-the-worker',
    label: 'Start the worker',
    why:
      'After the import and not before: the scheduled reminders the import creates are rebuilt from ' +
      'the imported appointments, and a worker running during the import would act on a half-built set.',
    agent: 'operator' as CutoverAgent,
    writes: true,
    commands: Object.freeze([]),
  }),
  Object.freeze({
    id: 'open-for-business',
    label: 'The business starts reading this system',
    why:
      'The act that makes it a cutover. Nothing in this repository can perform it, and the rollback ' +
      'runbook is what says which parts of it cannot be undone.',
    agent: 'operator' as CutoverAgent,
    writes: true,
    commands: Object.freeze([]),
  }),
])

export const CUTOVER_MODES = ['dry_run', 'execute'] as const
export type CutoverMode = (typeof CUTOVER_MODES)[number]

/**
 * Where the window was measured. Closed, and recorded on every run.
 *
 * ADR 0126's rule, applied to the one figure this artefact carries: a duration measured on a shared
 * four-core agent container is a figure about that container, and in a committed artefact it is
 * indistinguishable from a figure about a deployment. `agent_container` says so on the face of the
 * record; `chosen_machine` is the claim somebody makes when the machine is one they picked.
 */
export const CUTOVER_MEASURED_ON = ['agent_container', 'chosen_machine'] as const
export type CutoverMeasuredOn = (typeof CUTOVER_MEASURED_ON)[number]

export const CUTOVER_RUN_VERSION = 1

/** One table's checksum, before and after the run. */
export interface TableChecksum {
  readonly table: string
  readonly before: string
  readonly after: string
}

/** What one step did, or did not do. */
export interface CutoverStepRecord {
  readonly id: string
  readonly performed: boolean
  /** Milliseconds, or null when the step was not performed. A skipped step has no duration. */
  readonly durationMs: number | null
  /** Why it was not performed. Required when `performed` is false. */
  readonly skippedReason: string | null
  /** The exit code of the last command, when one ran. */
  readonly exitCode: number | null
}

export interface CutoverRun {
  readonly runVersion: number
  readonly mode: CutoverMode
  readonly startedAtIso: string
  readonly finishedAtIso: string
  /**
   * The measured window, and what it is a window over.
   *
   * `measuredOverMs` is the wall clock from start to finish. `coversEveryStep` says whether every
   * declared step was performed — false for a dry run by construction, which is what stops the figure
   * being read as the real cutover's duration.
   */
  readonly measuredOverMs: number
  readonly coversEveryStep: boolean
  /** Where the window was measured. See {@link CUTOVER_MEASURED_ON}. */
  readonly measuredOn: CutoverMeasuredOn
  readonly steps: readonly CutoverStepRecord[]
  readonly tableChecksums: readonly TableChecksum[]
  /** sha-256 over {@link canonicalCutoverRun}. */
  readonly digest: string
}

export interface CutoverProblem {
  readonly rule: string
  readonly detail: string
}

/**
 * The record's bytes with the digest removed and the keys ordered, which is what the digest is over.
 *
 * `canonicalDrillReport`'s shape and its reason: `JSON.stringify` preserves insertion order, so a
 * record re-serialised by a different code path would digest differently while holding identical
 * figures — and that failure looks exactly like the hand edit the digest exists to catch.
 */
export function canonicalCutoverRun(run: CutoverRun): string {
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
  return JSON.stringify(order(run))
}

/**
 * Every way a recorded cutover run was not what it claims, judged from the figures it recorded.
 *
 * Applied by the script immediately after the sequence, so a bad rehearsal exits non-zero naming the
 * rule, and again by the gate against a recorded artefact, so the two cannot come to disagree about
 * what a clean dry run means — `check-drill-age.mjs`'s arrangement one subject over.
 *
 * The digest is checked by the caller, which is the only party that holds the bytes.
 */
export function cutoverRunProblems(
  run: CutoverRun,
  steps: readonly CutoverStep[] = CUTOVER_STEPS,
): readonly CutoverProblem[] {
  const problems: CutoverProblem[] = []
  const bad = (rule: string, detail: string) => problems.push({ rule, detail })

  // The floors. Both comparisons below are walks over a list, and a walk over an empty list objects to
  // nothing — which for the checksum claim is the whole mode reporting success about no tables.
  if (run.tableChecksums.length === 0) {
    bad(
      CUTOVER_RULES.examinedNothing,
      'no table was checksummed, so "the dry run left every table unchanged" is a claim about ' +
        'nothing. A table walk that returned nothing is what a wrong schema filter looks like from ' +
        'the inside',
    )
  }
  if (steps.length === 0) {
    bad(
      CUTOVER_RULES.examinedNothing,
      'the sequence declares no step, so "every step is accounted for" would be vacuous',
    )
  }

  if (!CUTOVER_MEASURED_ON.includes(run.measuredOn)) {
    bad(
      CUTOVER_RULES.malformed,
      `the record says it was measured on ${JSON.stringify(run.measuredOn)}; the set is ` +
        `${CUTOVER_MEASURED_ON.join(', ')} and there is no default. A duration with no machine behind ` +
        'it is a figure somebody quotes (ADR 0126)',
    )
  }

  const started = Date.parse(run.startedAtIso)
  const finished = Date.parse(run.finishedAtIso)
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    bad(
      CUTOVER_RULES.windowNotRecorded,
      `the window reads ${run.startedAtIso} to ${run.finishedAtIso}, which is not a window. The ` +
        'measured window is the one figure a rehearsal exists to produce',
    )
  } else if (run.measuredOverMs !== finished - started) {
    bad(
      CUTOVER_RULES.windowNotRecorded,
      `the record says ${run.measuredOverMs} ms and its own two instants are ${finished - started} ms ` +
        'apart. Two statements of one fact, and this is the check that holds them equal',
    )
  }

  const declared = new Map(steps.map((step) => [step.id, step]))
  const recorded = new Map<string, CutoverStepRecord>()
  for (const record of run.steps) {
    const step = declared.get(record.id)
    if (step === undefined) {
      bad(
        CUTOVER_RULES.stepNotDeclared,
        `${record.id} is recorded and the sequence does not declare it, so nothing says who performs ` +
          'it or whether it writes',
      )
      continue
    }
    recorded.set(record.id, record)
    if (record.performed) {
      if (run.mode === 'dry_run' && step.writes) {
        bad(
          CUTOVER_RULES.writingStepPerformed,
          `${record.id} writes and was performed in a dry run. The checksum comparison is the ` +
            'evidence that this mode changed nothing, and a performed writing step is the claim it ' +
            'contradicts',
        )
      }
      if (record.durationMs === null) {
        bad(
          CUTOVER_RULES.malformed,
          `${record.id} was performed and recorded no duration, so the window is a sum with a hole in it`,
        )
      }
      if (record.exitCode !== null && record.exitCode !== 0) {
        bad(
          CUTOVER_RULES.stepFailed,
          `${record.id} exited ${record.exitCode}. ${step.label} did not pass, and every step after ` +
            'it in the sequence depends on it',
        )
      }
    } else {
      if (record.skippedReason === null || record.skippedReason.trim() === '') {
        bad(
          CUTOVER_RULES.malformed,
          `${record.id} was not performed and gives no reason. A step skipped silently is a step ` +
            'nobody will notice is missing on the day',
        )
      }
      if (record.durationMs !== null) {
        bad(
          CUTOVER_RULES.malformed,
          `${record.id} was not performed and carries a duration of ${record.durationMs} ms, which ` +
            'would be counted into a window it contributed nothing to',
        )
      }
    }
  }
  for (const step of steps) {
    if (!recorded.has(step.id)) {
      bad(
        CUTOVER_RULES.stepNotRecorded,
        `${step.id} (${step.label}) is declared and not recorded. A sequence that stopped early ` +
          'produces a shorter record, which reads exactly like a shorter sequence',
      )
    }
  }

  for (const checksum of run.tableChecksums) {
    if (checksum.before !== checksum.after) {
      bad(
        CUTOVER_RULES.tableChanged,
        `${checksum.table} changed during a ${run.mode}: ${checksum.before} before, ` +
          `${checksum.after} after`,
      )
    }
  }

  const performedEvery = steps.every((step) => recorded.get(step.id)?.performed === true)
  if (run.coversEveryStep !== performedEvery) {
    bad(
      CUTOVER_RULES.malformed,
      `the record claims coversEveryStep ${run.coversEveryStep} and ` +
        `${performedEvery ? 'every' : 'not every'} declared step was performed. That field is what ` +
        'stops the measured window being read as the real cutover’s duration, so it is derived ' +
        'here rather than trusted',
    )
  }

  return problems
}

/**
 * The run, rendered. Deterministic, so a snapshot test is a real test.
 *
 * The window is printed with what it is a window OVER, every time, because a duration on its own is
 * the figure somebody quotes.
 */
export function renderCutoverRun(
  run: CutoverRun,
  problems: readonly CutoverProblem[] = cutoverRunProblems(run),
): string {
  const lines: string[] = [`CUTOVER — ${run.mode}`, '']
  for (const step of CUTOVER_STEPS) {
    const record = run.steps.find((entry) => entry.id === step.id)
    if (record === undefined) {
      lines.push(`  NOT RECORDED  ${step.id} (${step.label})`)
      continue
    }
    lines.push(
      record.performed
        ? `  ${String(record.durationMs ?? 0).padStart(8)} ms  ${step.id} (${step.label})`
        : `  ${'skipped'.padStart(11)}  ${step.id} — ${record.skippedReason ?? ''}`,
    )
  }
  lines.push('')
  const performed = run.steps.filter((step) => step.performed).length
  lines.push(
    `window: ${run.measuredOverMs} ms over ${performed} of ${CUTOVER_STEPS.length} declared step(s), ` +
      `${run.startedAtIso} to ${run.finishedAtIso}, measured on ${run.measuredOn}`,
  )
  if (run.measuredOn === 'agent_container') {
    lines.push(
      'measured on a shared agent container, so the duration is a figure about that container and not ' +
        'about any deployment (ADR 0126)',
    )
  }
  if (!run.coversEveryStep) {
    lines.push(
      'this is a FLOOR and not an estimate of the real cutover: the steps that take the time are the ' +
        'ones a dry run does not perform, and a total presented as the window would be a figure about ' +
        'an event nobody has scheduled',
    )
  }
  lines.push(`tables checksummed: ${run.tableChecksums.length}`)
  lines.push('')
  if (problems.length === 0) {
    lines.push('VERDICT: clean')
    return lines.join('\n')
  }
  lines.push(`VERDICT: refused, ${problems.length} problem(s)`)
  for (const problem of problems) lines.push(`  [${problem.rule}] ${problem.detail}`)
  return lines.join('\n')
}

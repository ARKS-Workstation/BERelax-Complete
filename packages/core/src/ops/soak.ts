import { percentileMs } from '../pilot/walk-in-speed.ts'

/**
 * The soak's judgements: what the measured numbers have to say for the run to have proved anything.
 *
 * H-HARD-11. Pure, and separate from `scripts/soak.mjs` and `packages/fixtures/src/soak.ts`, for the
 * reason this build gives every time: a judgement that lives in a script is a judgement no test reaches.
 *
 * ## The two halves of this unit are judged differently, and that is the whole design
 *
 * **The claims about the CODE are asserted unconditionally.** Exactly one success out of 200 contenders
 * for one place, exactly one delivery per `(event, handler)` over a drained backlog, no room over
 * capacity, the money invariants still true afterwards. None of those is a wall-clock figure: they are
 * counts of rows, and a count is the same on a loaded four-core container as on a production database.
 *
 * **The claim about LATENCY is not, and cannot be.** Brief rule 23: a wall-clock assertion measures the
 * machine. `packages/fixtures/src/availability-perf.itest.ts` measured this container six times and
 * wrote the numbers down — alone it reaches 192 to 231 ms of B-AVAIL-07's 300 ms budget, and inside a
 * full run with sibling worktrees it reaches 315 to 417. So a p95 taken here is a figure about the
 * container, and in a committed report it would be indistinguishable from a figure about a deployment.
 *
 * So {@link SoakMachine.measuredOn} is a FIELD, and {@link soakProblems} enforces the committed budget
 * only for a reading taken on a machine somebody chose. An `agent_container` reading is recorded,
 * printed, and never compared to the budget. What IS enforced about it on every run is the arithmetic:
 * the percentile is recomputed from the samples, so a hand-edited p95 fails.
 *
 * ## Why there is no budget at the soak's own concurrency
 *
 * B-AVAIL-07 committed p95 under 300 ms for FIFTY concurrent availability queries on the CI Postgres.
 * Nobody has committed a figure at any other concurrency, and nobody has observed a peak — so the soak
 * measures at its declared concurrency, records it, and carries `budgetMs: null` for any reading that is
 * not at the committed concurrency (`Y13-perf-budget`). Inventing a budget for 200 concurrent queries
 * would be exactly the figure brief rule 15 is about.
 */

/** Rule names, printed verbatim by the scripts so a gate case can assert the rule (ADR 0003). */
export const SOAK_RULES = {
  contentionNotExactlyOne: 'soak-contention-not-exactly-one-success',
  refusalUntyped: 'soak-refusal-not-typed',
  overCapacity: 'soak-room-over-capacity',
  backlogNotExactlyOnce: 'soak-backlog-not-exactly-one-delivery-per-handler',
  invariantsFailed: 'soak-domain-invariants-failed',
  arithmeticInconsistent: 'soak-report-arithmetic-inconsistent',
  budgetBreached: 'soak-availability-budget-breached',
  examinedNothing: 'soak-examined-nothing',
  machineNotStated: 'soak-machine-not-stated',
  malformed: 'soak-report-malformed',
} as const

/**
 * B-AVAIL-07's committed figures, which are the ONLY latency commitment in this build.
 *
 * Restated here because the soak needs them and they live as literals in
 * `packages/fixtures/src/availability-perf.itest.ts`. A second statement of a fact drifts, so a gate
 * case holds these two equal to that file's own constants — the brief's rule applied in the same commit
 * rather than a comment hoping somebody notices.
 */
export const AVAILABILITY_P95_BUDGET_MS = 300
export const AVAILABILITY_BUDGET_CONCURRENCY = 50

/** The acceptance figures this unit's own lines name. Floors, so a smaller run cannot report success. */
export const SOAK_CONTENTION_ATTEMPTS = 200
export const SOAK_BACKLOG_EVENTS = 10_000

/** A problem, as the scripts print it. */
export interface SoakProblem {
  readonly rule: string
  readonly detail: string
}

/** Where the figures were taken. A field and not a comment; see the module header. */
export interface SoakMachine {
  readonly platform: string
  readonly cpus: number
  readonly totalMemoryBytes: number
  readonly loadAverage1m: number
  readonly postgresVersion: string
  readonly measuredOn: 'agent_container' | 'chosen_machine'
}

/** 200 attempts on one place. Every figure is a count of rows. */
export interface ContentionResult {
  readonly attempts: number
  readonly successes: number
  /** Refusal name to count. Every refusal must be named: an unnamed one is the untyped case. */
  readonly refusalsByName: Readonly<Record<string, number>>
  /** Rejections that carried no refusal name — a raw constraint violation reaching a caller. */
  readonly untypedFailures: number
  /** Rejections carrying a SQLSTATE in the 23 (integrity) or 40 (serialisation) classes. */
  readonly rawSqlstateFailures: readonly string[]
  /** Rooms whose peak client places exceeded their capacity. */
  readonly overCapacityRooms: number
}

/** The availability load. `samples` is every observed duration, so the percentile is recomputable. */
export interface AvailabilityLoadResult {
  readonly concurrency: number
  readonly batches: number
  readonly samples: readonly number[]
  readonly p95Ms: number | null
  readonly medianMs: number | null
  /** The budget this reading is judged against, or null when nobody has committed one for it. */
  readonly budgetMs: number | null
}

/** The backlog drain. `deliveries` and `distinctPairs` are the exactly-once claim as two numbers. */
export interface BacklogResult {
  readonly events: number
  readonly handlers: number
  readonly drainers: number
  readonly batchSize: number
  readonly deliveries: number
  readonly distinctPairs: number
  readonly unpublishedAfter: number
  readonly drainMs: number
}

export interface SoakReport {
  readonly reportVersion: number
  readonly runAtIso: string
  readonly machine: SoakMachine
  readonly contention: ContentionResult
  readonly availability: AvailabilityLoadResult
  readonly backlog: BacklogResult
  readonly invariants: {
    readonly name: string
    readonly ran: boolean
    readonly exitCode: number | null
    readonly skippedReason: string | null
  }
  /** What the applied load does and does not establish. Prose, printed, never empty. */
  readonly notProved: readonly string[]
  readonly openQuestionId: string
}

export const SOAK_REPORT_VERSION = 1

/** Nearest-rank, from `walk-in-speed.ts` rather than a second implementation. */
export const soakPercentileMs = percentileMs

/**
 * Every way the soak's figures fail to prove what the unit claims.
 *
 * Applied by `scripts/soak.mjs` to the run it just performed and by `scripts/check-perf-budget.mjs` to
 * the committed artefact, so the two cannot come to disagree about what "passed" means.
 */
export function soakProblems(report: SoakReport): readonly SoakProblem[] {
  const problems: SoakProblem[] = []
  const add = (rule: string, detail: string) => problems.push({ rule, detail })

  if (report.reportVersion !== SOAK_REPORT_VERSION) {
    add(
      SOAK_RULES.malformed,
      `the artefact is version ${report.reportVersion} and this build reads version ` +
        `${SOAK_REPORT_VERSION}. Re-run the soak rather than editing the field`,
    )
    return problems
  }
  if (
    report.machine.measuredOn !== 'agent_container' &&
    report.machine.measuredOn !== 'chosen_machine'
  ) {
    add(
      SOAK_RULES.machineNotStated,
      `machine.measuredOn is ${JSON.stringify(report.machine.measuredOn)}. A duration with no machine ` +
        'beside it is a figure that reads as a production figure (brief rule 23)',
    )
  }
  if (report.notProved.length === 0) {
    add(
      SOAK_RULES.malformed,
      'the report lists nothing the applied load does not establish. A soak on a four-core container ' +
        'shared with other agents has limits, and a report claiming none is wrong about itself',
    )
  }

  // --- the claims about the code, asserted unconditionally -------------------------------------
  const { contention } = report
  if (contention.attempts < SOAK_CONTENTION_ATTEMPTS) {
    add(
      SOAK_RULES.examinedNothing,
      `${contention.attempts} attempt(s) on the last place, below the ${SOAK_CONTENTION_ATTEMPTS} the ` +
        'acceptance line names. A smaller race is a smaller claim',
    )
  }
  if (contention.successes !== 1) {
    add(
      SOAK_RULES.contentionNotExactlyOne,
      `${contention.successes} of ${contention.attempts} attempts committed. Two is the double booking; ` +
        'zero is a lock that refuses everybody, which is availability that never works',
    )
  }
  const named = Object.values(contention.refusalsByName).reduce((total, count) => total + count, 0)
  if (named + contention.successes !== contention.attempts || contention.untypedFailures > 0) {
    add(
      SOAK_RULES.refusalUntyped,
      `${contention.successes} success(es) and ${named} named refusal(s) do not account for ` +
        `${contention.attempts} attempt(s); ${contention.untypedFailures} rejection(s) carried no ` +
        'refusal name. An unnamed rejection is a raw constraint violation reaching a caller, which is ' +
        'the 5xx this line is about',
    )
  }
  if (contention.rawSqlstateFailures.length > 0) {
    add(
      SOAK_RULES.refusalUntyped,
      `rejections carried raw SQLSTATEs: ${[...new Set(contention.rawSqlstateFailures)].join(', ')}. A ` +
        '23xxx reaching a caller is an unhandled constraint violation and a 40P01 is a deadlock',
    )
  }
  if (contention.overCapacityRooms > 0) {
    add(
      SOAK_RULES.overCapacity,
      `${contention.overCapacityRooms} room(s) held more client places than their capacity`,
    )
  }

  const { backlog } = report
  if (backlog.events < SOAK_BACKLOG_EVENTS) {
    add(
      SOAK_RULES.examinedNothing,
      `${backlog.events} event(s) in the backlog, below the ${SOAK_BACKLOG_EVENTS} the acceptance line ` +
        'names',
    )
  }
  const expected = backlog.events * backlog.handlers
  if (backlog.deliveries !== expected || backlog.distinctPairs !== backlog.deliveries) {
    add(
      SOAK_RULES.backlogNotExactlyOnce,
      `${backlog.deliveries} delivery row(s) over ${backlog.events} event(s) and ${backlog.handlers} ` +
        `handler(s), where exactly one per pair is ${expected}; ${backlog.distinctPairs} pair(s) are ` +
        'distinct. More rows than pairs is a second delivery; fewer is an event a handler never saw',
    )
  }
  if (backlog.unpublishedAfter !== 0) {
    add(
      SOAK_RULES.backlogNotExactlyOnce,
      `${backlog.unpublishedAfter} event(s) were still unpublished when the drain stopped claiming, so ` +
        'the backlog did not drain',
    )
  }

  if (!report.invariants.ran || report.invariants.exitCode !== 0) {
    add(
      SOAK_RULES.invariantsFailed,
      `${report.invariants.name}: ${
        report.invariants.ran
          ? `exited ${String(report.invariants.exitCode)}`
          : `not run (${report.invariants.skippedReason ?? 'no reason given'})`
      } against the post-soak database`,
    )
  }

  // --- the latency reading, judged by its own arithmetic and by its machine --------------------
  const { availability } = report
  if (availability.samples.length < availability.concurrency) {
    add(
      SOAK_RULES.examinedNothing,
      `${availability.samples.length} availability sample(s) at concurrency ` +
        `${availability.concurrency}: fewer samples than queries means the load did not run`,
    )
  } else {
    const recomputed = soakPercentileMs(availability.samples, 95)
    if (recomputed !== availability.p95Ms) {
      add(
        SOAK_RULES.arithmeticInconsistent,
        `the report states p95 ${String(availability.p95Ms)} ms and its own ` +
          `${availability.samples.length} sample(s) give ${String(recomputed)} ms. Every figure in a ` +
          'committed report can be edited by hand, and this is the one a reader would quote',
      )
    }
  }
  if (availability.budgetMs !== null) {
    if (availability.p95Ms === null) {
      add(
        SOAK_RULES.arithmeticInconsistent,
        'a budget is stated and no p95 was measured, so nothing was judged against it',
      )
    } else if (
      availability.p95Ms > availability.budgetMs &&
      report.machine.measuredOn === 'chosen_machine'
    ) {
      add(
        SOAK_RULES.budgetBreached,
        `p95 ${availability.p95Ms} ms at concurrency ${availability.concurrency} breaches the committed ` +
          `${availability.budgetMs} ms`,
      )
    }
  }
  return problems
}

/**
 * Whether the committed budget was actually judged, as a value a report can print.
 *
 * Three states and not two: judged and held, judged and breached, and NOT JUDGED because the figures
 * came off a machine nobody chose. The third is the honest answer here and it has to be distinguishable
 * from the first, which is ADR 0070's rule applied to a latency.
 */
export type BudgetVerdict =
  | { readonly kind: 'within_budget'; readonly p95Ms: number; readonly budgetMs: number }
  | { readonly kind: 'over_budget'; readonly p95Ms: number; readonly budgetMs: number }
  | { readonly kind: 'not_judged'; readonly p95Ms: number | null; readonly reason: string }

export function budgetVerdict(report: SoakReport): BudgetVerdict {
  const { availability, machine } = report
  if (availability.budgetMs === null) {
    return {
      kind: 'not_judged',
      p95Ms: availability.p95Ms,
      reason:
        `no figure has been committed at concurrency ${availability.concurrency}; the only latency ` +
        `commitment in this build is ${AVAILABILITY_P95_BUDGET_MS} ms at ` +
        `${AVAILABILITY_BUDGET_CONCURRENCY} concurrent queries on the CI Postgres (${report.openQuestionId})`,
    }
  }
  if (availability.p95Ms === null) {
    return { kind: 'not_judged', p95Ms: null, reason: 'no sample was taken' }
  }
  if (machine.measuredOn !== 'chosen_machine') {
    return {
      kind: 'not_judged',
      p95Ms: availability.p95Ms,
      reason:
        'the figures were taken on an agent container shared with other agents on four cores, which is ' +
        'a measurement of the container (brief rule 23). The budget is enforced for a reading taken on ' +
        'a machine somebody chose',
    }
  }
  return availability.p95Ms <= availability.budgetMs
    ? { kind: 'within_budget', p95Ms: availability.p95Ms, budgetMs: availability.budgetMs }
    : { kind: 'over_budget', p95Ms: availability.p95Ms, budgetMs: availability.budgetMs }
}

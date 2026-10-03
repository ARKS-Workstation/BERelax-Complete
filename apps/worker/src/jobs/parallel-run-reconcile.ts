import {
  countSystemTreatments,
  type ParallelRunVarianceRow,
  type ParallelRunWindow,
  readParallelRunWindow,
  recordReconciliation,
  type Sql,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The daily parallel-run reconciliation (H-MIG-10).
 *
 * ## What it compares, and why one side cannot be computed
 *
 * One side is the paper day sheet. NOTHING in this build can see it: somebody reads it and types a
 * number, which is why `parallel_run_paper_count` carries the counter's name and why ZY742 refuses a
 * count no named person is behind. The other side is what this system holds for that trading date, and
 * this pass is the only thing that counts it.
 *
 * That asymmetry decides the pass's whole behaviour. It cannot reconcile a day nobody has counted, and —
 * this is the acceptance line — it must not report one either: a row with `paper_count = 0` is
 * indistinguishable from "the paper and the system agreed that nothing happened", and the days where
 * they disagree are the entire point of a parallel run (ADR 0070). So the schema makes it impossible
 * (`parallel_run_reconciliation` has a foreign key to the paper count) and the pass reports the day as
 * AWAITING rather than skipping it silently.
 *
 * ## Why a day outside the window is a refusal and not an empty result
 *
 * Before the window starts the system was not recording; after it ends the paper sheet was not. In both
 * cases "the paper and the system agree" is a statement about which of the two was switched off, so the
 * figure a row would carry is a misleading zero. ZY741 refuses such a row at the database and this pass
 * refuses to attempt one — and with the window UNSET it refuses to run at all rather than reconciling
 * zero days, because "0 days, no variance" reads exactly like a parallel run in which everything agreed.
 *
 * ## It recommends nothing
 *
 * There is no threshold here, no alert decision and no cutover verdict. The pass writes variance rows and
 * says how many are non-zero. Whether the business goes live or back to paper is a person's decision
 * recorded as a claim (`parallel_run_decision`, ZY744), and a rule in this file that decided it would be
 * this build deciding a cutover from a figure it computed itself.
 */

export const PARALLEL_RUN_RECONCILE_JOB = 'migration.parallel-run-reconcile'

/** The `agent_definition` 0153 inserts. A cron with no agent is a cron nobody is watching. */
export const PARALLEL_RUN_RECONCILE_AGENT = 'parallel_run_reconciliation'

/**
 * Runs `fn` in a transaction of its own, or in a shared one the caller already has.
 *
 * Injected for the reason `packages/migration/src/framework.ts` gives for the identical type: a
 * `postgres.js` transaction handle has no `begin`, only `savepoint`, so a pass that always called
 * `withUnitOfWork` could not be driven inside a transaction a suite rolls back — and this pass's
 * refusals are DEFERRED constraint triggers, so a suite that could not reach a COMMIT could not see them
 * fire at all. The alternative is a suite that commits its rows into the shared integration database:
 * `parallel_run_paper_count` is keyed on the trading date and append-only (ZY743), so the second
 * execution of such a suite would fail on its own first execution's rows.
 */
export type ParallelRunTransactionally = <T>(fn: (uow: UnitOfWork) => Promise<T>) => Promise<T>

export interface ParallelRunPassResult {
  readonly window: ParallelRunWindow
  /** Days reconciled on this pass, in trading-date order. */
  readonly reconciled: readonly ParallelRunVarianceRow[]
  /** Closed days inside the window that no paper count exists for. Reported, never reconciled. */
  readonly awaitingPaperCount: readonly string[]
  /** Days whose paper and system counts disagree. The figure the whole unit is about. */
  readonly flagged: readonly ParallelRunVarianceRow[]
}

/**
 * Reconciles every closed day of the window that has a paper count, and names the ones that do not.
 *
 * Takes the `Sql` and the instant, and derives the days from the CALENDAR rather than from arithmetic on
 * the clock: `business_day` runs 11:00–02:00 so 01:30 belongs to the previous trading date, and
 * subtracting a day from the clock is a day out at every boundary (0138's recorded reason, and the one
 * place this pass and that one agree exactly).
 */
export async function runParallelRunReconciliationPass(
  sql: Sql,
  options: {
    readonly nowIso: string
    readonly countedBySystem?: typeof countSystemTreatments
    readonly transactionally?: ParallelRunTransactionally
  },
): Promise<ParallelRunPassResult> {
  const window = await readParallelRunWindow(sql)
  const count = options.countedBySystem ?? countSystemTreatments
  const transactionally: ParallelRunTransactionally =
    options.transactionally ??
    ((fn) => withUnitOfWork(sql, { kind: 'system', label: PARALLEL_RUN_RECONCILE_JOB }, fn))

  const closed = await sql<{ tradingDate: string; hasPaperCount: boolean }[]>`
    select d.trading_date::text                                      as "tradingDate",
           (p.business_day is not null)                              as "hasPaperCount"
      from business_day d
      left join parallel_run_paper_count p on p.business_day = d.trading_date
     where d.trading_date between ${window.start}::date and ${window.end}::date
       and d.closes_at <= ${options.nowIso}::timestamptz
     order by d.trading_date
  `

  const reconciled: ParallelRunVarianceRow[] = []
  const awaiting: string[] = []
  for (const day of closed) {
    if (!day.hasPaperCount) {
      // Reported and not skipped. A day the pass passed over in silence is a day nobody knows is
      // missing, and the cutover decision's evidence would be short by it.
      awaiting.push(day.tradingDate)
      continue
    }
    const systemCount = await count(sql, day.tradingDate)
    const written = await transactionally((uow) =>
      recordReconciliation(
        uow,
        { businessDay: day.tradingDate, systemCount, ranAt: new Date(options.nowIso) },
        window,
      ),
    )
    reconciled.push({
      businessDay: written.businessDay,
      paperCount: written.paperCount,
      countedBy: '',
      systemCount: written.systemCount,
      difference: written.difference,
      state: written.state,
    })
  }

  return {
    window,
    reconciled: Object.freeze(reconciled),
    awaitingPaperCount: Object.freeze(awaiting),
    // Derived from the rows rather than counted alongside them, so the figure and the rows cannot
    // disagree — which is what `state` being a view expression rather than a column is for.
    flagged: Object.freeze(reconciled.filter((row) => row.state === 'unreconciled')),
  }
}

/** One line for the log, stating the awaiting days rather than letting them be an absence. */
export function describeParallelRunPass(result: ParallelRunPassResult): string {
  const flagged =
    result.flagged.length === 0
      ? 'no day disagrees'
      : `${result.flagged.length} day(s) disagree: ${result.flagged
          .map((row) => `${row.businessDay} paper ${row.paperCount} system ${row.systemCount}`)
          .join('; ')}`
  const awaiting =
    result.awaitingPaperCount.length === 0
      ? ''
      : `; ${result.awaitingPaperCount.length} closed day(s) have no paper count and were NOT ` +
        `reconciled: ${result.awaitingPaperCount.join(', ')}`
  return `window ${result.window.start}..${result.window.end}: ${result.reconciled.length} day(s) reconciled, ${flagged}${awaiting}`
}

let configured: Sql | undefined

export function setParallelRunReconcileSql(sql: Sql): void {
  configured = sql
}

async function parallelRunReconcileHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${PARALLEL_RUN_RECONCILE_JOB} ran before setParallelRunReconcileSql() supplied a connection. ` +
        'run.ts calls it before startWorkers().',
    )
  }
  const result = await runParallelRunReconciliationPass(configured, { nowIso: context.now() })
  console.log(`${PARALLEL_RUN_RECONCILE_JOB} ${context.now()}: ${describeParallelRunPass(result)}`)
}

/**
 * The pass's definition.
 *
 * At 04:41, after trading closes at 02:00, so the last day is complete. A CRON and not a queue, for
 * 0138's reason in the sharpest form this build has: what is being watched is the ABSENCE of an answer.
 * A parallel-run reconciliation nobody ran looks exactly like a parallel run in which the paper and the
 * system agreed every day — and that is the figure a cutover decision rests on.
 */
export const PARALLEL_RUN_RECONCILE_JOB_DEFINITION: JobDefinition<never> = {
  name: PARALLEL_RUN_RECONCILE_JOB,
  purpose:
    'Compares each closed trading day of the parallel-run window against the paper day-sheet count a ' +
    'named person recorded for it, writing one variance row per day and flagging any non-zero ' +
    'difference. It emits NOTHING for a day nobody has counted — a zero paper figure is ' +
    'indistinguishable from agreement — and refuses to run at all while the window settings are unset, ' +
    'because "0 days, no variance" reads exactly like a parallel run in which everything agreed. It ' +
    "recommends no cutover: that decision is a named person's claim (H-MIG-10, ADR 0107).",
  cron: '41 4 * * *',
  agent: PARALLEL_RUN_RECONCILE_AGENT,
  retryLimit: 2,
  retryDelaySeconds: 600,
  retryBackoff: true,
  expireInSeconds: 600,
  handler: parallelRunReconcileHandler,
}

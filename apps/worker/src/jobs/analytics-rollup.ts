import {
  APPOINTMENT_STATUS_FUNNEL,
  COLLECTED_EVENT_FUNNEL,
  createRunBudget,
  type FunnelCountRow,
  type FunnelCounts,
  funnelCountsFrom,
} from '@berelax/core'
import {
  type CollectedStageMapping,
  funnelCountRows,
  materialiseFunnelSteps,
  purgeExpiredRefCodes,
  rollUpTradingDate,
  type Sql,
  type StatusStageMapping,
  withAgentRun,
} from '@berelax/db'
import { AppError, FUNNEL_TERMINAL_STAGE, isFunnelStage } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The nightly rollup pass (A-FIRST-09): materialise the funnel, recompute the three rollups, and purge
 * the ref codes nobody claimed.
 *
 * ## Why one pass and not three
 *
 * Because they are one answer about one day, and the order between them is load-bearing: the rollups read
 * `analytics.funnel_step`, so a rollup that ran before the materialisation would publish last night's
 * funnel under tonight's date. Three crons would make that order a property of three schedules nobody
 * reads together, and the first symptom would be a chart that is right most nights.
 *
 * The ref-code purge joins them because A-FIRST-07 handed it here by name — *"that is a nightly pass and a
 * cron needs an agent row, so it is handed to A-FIRST-09 with the rollups"* — and because a second cron
 * would need a second `agent_definition`, which is a migration and a watchdog row for a `delete` that
 * takes milliseconds. It is the LAST step, so a failure in it cannot cost the night's figures.
 *
 * ## Why 02:35
 *
 * Trading closes at 02:00, and ZY702 refuses a rollup for a day that has not closed — so the pass cannot
 * run earlier, and the figure it would have written is half a day's trade presented as a day's total.
 * It runs BEFORE A-MEAS-05's 03:17 upload and A-MEAS-07's 04:23 reconciliation, which is the ordering
 * ADR 0093 states: the reconciliation compares its internal side against what was pushed, and the
 * internal side is this pass's output.
 *
 * ## Why the mappings are passed down rather than written in SQL
 *
 * `COLLECTED_EVENT_FUNNEL` and `APPOINTMENT_STATUS_FUNNEL` are `@berelax/core`'s, total over their own
 * vocabularies by compilation, and `packages/db` may never import core (ADR 0001). This module is the one
 * place both are reachable, so it reads them and hands the repository a values list. A copy in SQL would
 * be a second statement of the funnel, and the drift would be an event collected and never counted.
 *
 * ## What this pass does NOT decide
 *
 * Which trading date an instant belongs to. Two statements of that rule exist and both are enforced —
 * `analytics.session.trading_date` by ZY222 and `appointment.trading_date` by a foreign key into
 * `business_day` — and the repository reads them. A third here would disagree with both on exactly the
 * dates somebody overrode the hours for.
 */

export const ANALYTICS_ROLLUP_JOB = 'analytics.rollup'

/** The `agent_definition` row migration 0021 seeded for this pass, before any job existed to fill it. */
export const ANALYTICS_ROLLUP_AGENT = 'nightly_rollups'

/**
 * The collected-event half of the mapping, derived from `COLLECTED_EVENT_FUNNEL`.
 *
 * An event whose rule has `stage: null` contributes NOTHING and is dropped here rather than passed down
 * as a null: `whatsapp_ref_shown` is the denominator of the ref-capture rate and not a funnel stage, and
 * a ninth bucket for it would insert a step between the click and the booking that no customer performs.
 */
export const COLLECTED_STAGE_MAPPINGS: readonly CollectedStageMapping[] = Object.freeze(
  Object.entries(COLLECTED_EVENT_FUNNEL).flatMap(([eventName, rule]) =>
    rule.stage === null
      ? []
      : [{ eventName, stage: rule.stage, entryOnly: rule.entryPageViewOnly }],
  ),
)

/**
 * The appointment-status half, derived from `APPOINTMENT_STATUS_FUNNEL`.
 *
 * A `no_step` status is dropped for `COLLECTED_STAGE_MAPPINGS`' reason — each of those is a decision about
 * what the funnel measures, and `checked_in` contributing `attended` would count an attendance that did
 * not happen. An `excluded` status carries its reason and no stage: it ends a journey rather than
 * advancing one.
 */
export const STATUS_STAGE_MAPPINGS: readonly StatusStageMapping[] = Object.freeze(
  Object.entries(APPOINTMENT_STATUS_FUNNEL).flatMap<StatusStageMapping>(([status, outcome]) => {
    if (outcome.kind === 'no_step') return []
    return outcome.kind === 'stage'
      ? [{ status, stage: outcome.stage, excludedReason: null }]
      : [{ status, stage: null, excludedReason: outcome.reason }]
  }),
)

/** The stage a booking's creation contributes. Named by the taxonomy, not by this file. */
const BOOKING_CREATED_STAGE = 'booking_created'
/** The stage a no-show is excluded FROM. The booking was confirmed and then was not kept. */
const CONFIRMED_STAGE = 'confirmed'

/**
 * How the pass wraps each of its steps.
 *
 * An injected seam and not `sql.begin` inline, for one reason the integration suite forced: a suite that
 * must leave the database as it found it runs its whole fixture inside ONE transaction it rolls back, and
 * postgres.js' `begin` opens a transaction on the POOL and cannot nest inside it. So the default is the
 * production answer — one transaction per step — and the suite passes a pass-through that runs the step
 * on the transaction it already holds.
 *
 * One transaction per STEP rather than one around the pass, and that is the production decision: the
 * materialisation and the three rollups are each independently convergent, so a pass that died between
 * them leaves a day half rolled up that the next pass fixes. One transaction would leave the whole night
 * to be re-run, with the heartbeat saying nothing happened at all.
 */
export type Transact = <T>(body: (tx: Sql) => Promise<T>) => Promise<T>

/** The terminal stage, narrowed once rather than at each read. `funnel-counts.ts`' reason. */
const TERMINAL_STAGE = ((stage: string | undefined): string => {
  if (stage === undefined) {
    throw new Error(
      'FUNNEL_STAGES holds no terminal stage, so this pass has no step to materialise a settled ' +
        'invoice as and the funnel would end at `attended`.',
    )
  }
  return stage
})(FUNNEL_TERMINAL_STAGE)

export interface RollupPassResult {
  readonly tradingDate: string
  readonly funnelStepsDeleted: number
  readonly funnelStepsWritten: number
  readonly trafficRows: number
  readonly funnelRows: number
  readonly revenueRows: number
  readonly refCodesPurged: number
  /** The counts, bots excluded, so the log line carries the figure and not just the row count. */
  readonly counts: FunnelCounts
}

/**
 * One pass over one trading date. Takes its instant as an argument, so the suite drives it frozen.
 *
 * Each step is its own transaction rather than one around the whole pass, and that is deliberate: the
 * materialisation and the three rollups are each independently convergent — delete then recompute — so a
 * pass that died between them leaves a day half rolled up that the next pass fixes, where one transaction
 * would leave the WHOLE night to be re-run and the heartbeat saying nothing happened at all.
 */
export async function runAnalyticsRollupPass(
  sql: Sql,
  input: { readonly tradingDate: string; readonly nowIso: string },
  transact: Transact = (body) =>
    sql.begin(async (tx) => body(tx as unknown as Sql)) as Promise<never>,
): Promise<RollupPassResult> {
  const materialised = await transact((tx) =>
    materialiseFunnelSteps(tx, {
      tradingDate: input.tradingDate,
      collectedStages: COLLECTED_STAGE_MAPPINGS,
      statusStages: STATUS_STAGE_MAPPINGS,
      bookingCreatedStage: BOOKING_CREATED_STAGE,
      paidStage: TERMINAL_STAGE,
      confirmedStage: CONFIRMED_STAGE,
    }),
  )
  const rolled = await transact((tx) =>
    rollUpTradingDate(tx, {
      tradingDate: input.tradingDate,
      computedAtIso: input.nowIso,
    }),
  )
  const rows = await funnelCountRows(sql, { tradingDate: input.tradingDate })
  const purged = await purgeExpiredRefCodes(sql, { asOfIso: input.nowIso })

  return {
    tradingDate: input.tradingDate,
    funnelStepsDeleted: materialised.deleted,
    funnelStepsWritten: materialised.collected + materialised.domain,
    trafficRows: rolled.traffic,
    funnelRows: rolled.funnel,
    revenueRows: rolled.revenue,
    refCodesPurged: purged,
    counts: funnelCountsFrom(
      // `isFunnelStage` rather than a cast: the column is an enum PostgreSQL holds and the taxonomy is a
      // union TypeScript holds, and the one place they could disagree is a label added to the enum by a
      // migration. A cast would carry that label into a `Record` that has no bucket for it.
      rows.flatMap<FunnelCountRow>((row) =>
        isFunnelStage(row.stage)
          ? [
              {
                stage: row.stage,
                entered: row.entered,
                excluded: row.excluded,
                gapEntered: row.gapEntered,
              },
            ]
          : [],
      ),
    ),
  }
}

/**
 * A log line on every pass, including one that rolled up a day with nothing on it.
 *
 * A pass that logged only what changed would be indistinguishable from a pass that had stopped —
 * `reporting-refresh.ts`' argument, and the reason `agent_heartbeat` exists one level up.
 */
export function describeRollupPass(result: RollupPassResult): string {
  const landing = result.counts['landing']
  const paid = result.counts[FUNNEL_TERMINAL_STAGE ?? 'paid']
  return (
    `${result.tradingDate}: ${result.funnelStepsWritten} funnel step(s) (replacing ` +
    `${result.funnelStepsDeleted}), ${result.trafficRows} traffic + ${result.funnelRows} funnel + ` +
    `${result.revenueRows} revenue row(s), landing ${landing?.entered ?? 0} -> paid ` +
    `${paid?.entered ?? 0}, ${result.refCodesPurged} expired ref code(s) purged`
  )
}

/** The connection, set by `run.ts` before `startWorkers`. `setCashForecastSql`'s reason. */
let configured: Sql | undefined

export function setAnalyticsRollupSql(sql: Sql): void {
  configured = sql
}

async function analyticsRollupHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${ANALYTICS_ROLLUP_JOB} ran before setAnalyticsRollupSql() supplied a connection. run.ts calls ` +
        'it before startWorkers().',
    )
  }
  const sql = configured
  const nowIso = context.now()
  /*
   * The day that has just CLOSED, read out of the calendar.
   *
   * ZY702 refuses a rollup for a day that had not closed, so the pass asks the calendar for the latest
   * day whose close is already behind us — `dispatch-reconciliation.ts`' query and its reason. Deriving
   * it by subtracting a day from the clock would be a day out at every weekly boundary, and a day out is
   * a published figure attributed to the wrong night.
   */
  const [day] = await sql<{ trading_date: string }[]>`
    select trading_date::text as trading_date
      from business_day
     where closes_at <= ${nowIso}::timestamptz
     order by closes_at desc
     limit 1
  `
  if (day === undefined) {
    throw new AppError(
      'invariant_violated',
      `The trading calendar holds no day that had closed by ${nowIso}, so there is no completed day to ` +
        'roll up. A date derived by subtracting a day instead would be refused by ZY702 on the days it ' +
        'got wrong and silently accepted on the rest.',
      { details: { nowIso } },
    )
  }

  const run = await withAgentRun(
    sql,
    {
      agentKey: ANALYTICS_ROLLUP_AGENT,
      startedAtIso: nowIso,
      tradingDate: day.trading_date,
      ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
    },
    async () => {
      const result = await runAnalyticsRollupPass(sql, {
        tradingDate: day.trading_date,
        nowIso,
      })
      console.log(`${ANALYTICS_ROLLUP_JOB} ${nowIso} ${describeRollupPass(result)}`)
    },
    createRunBudget,
  )
  if (run.outcome === 'failed' || run.outcome === 'budget_exceeded') {
    // Re-thrown so pg-boss retries with backoff. The heartbeat and the run row are already written,
    // which is the point: a failed rollup is visible whether or not anybody reads `pgboss.job`.
    throw new AppError(
      'invariant_violated',
      `${ANALYTICS_ROLLUP_JOB} failed for ${day.trading_date}: ${run.error ?? 'no error recorded'}`,
      { details: { runId: run.runId, tradingDate: day.trading_date } },
    )
  }
}

/**
 * The pass's definition.
 *
 * 02:35, which is after trading closes at 02:00 — ZY702 refuses the alternative — and before A-MEAS-05's
 * 03:17 upload and A-MEAS-07's 04:23 reconciliation, whose internal side this pass produces.
 *
 * A CRON and not a queue the last event of the night announces, for 0137's reason: what has to be watched
 * is the ABSENCE of a rollup, and a day nobody rolled up looks exactly like a day with no traffic. The
 * `agent_heartbeat` row 0021 seeded for `nightly_rollups` is the one thing that tells them apart.
 */
export const ANALYTICS_ROLLUP_JOB_DEFINITION: JobDefinition<never> = {
  name: ANALYTICS_ROLLUP_JOB,
  purpose:
    'Materialises analytics.funnel_step for the trading day that has just closed, recomputes all three ' +
    'rollups from the raw tables, and purges the expired WhatsApp ref codes nothing claimed (A-FIRST-07 ' +
    'handed that here). Recompute and not accumulate: every row is a group-by over the raw tables, so ' +
    'two runs produce byte-identical rows and a corrected derivation converges — a drifted rollup is a ' +
    'figure nobody can audit, because there is no second place to check it against.',
  cron: '35 2 * * *',
  agent: ANALYTICS_ROLLUP_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 900,
  retryBackoff: true,
  // A day's worth of events and one group-by per rollup. Ten minutes is generous; a pass still running
  // after that is blocked on a lock, and reclaiming it is right because every step is convergent.
  expireInSeconds: 600,
  handler: analyticsRollupHandler,
}

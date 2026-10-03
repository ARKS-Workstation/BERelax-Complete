import {
  AppError,
  PARALLEL_RUN_WINDOW_END_SETTING_KEY,
  PARALLEL_RUN_WINDOW_OPEN_QUESTION_ID,
  PARALLEL_RUN_WINDOW_START_SETTING_KEY,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The writes and reads H-MIG-10 owns: the paper day-sheet count, the daily reconciliation, and the
 * cutover decision.
 *
 * Migration 0153 is the schema and its header carries the argument. What belongs here rather than there:
 *
 *   - **the audit action strings**, because ZY742 and ZY744 match on them. A deferred constraint trigger
 *     looking for `action = 'migration.parallel_run.paper_count_recorded'` and a writer emitting
 *     `'parallel_run.paper_count'` would refuse every COMMIT, so the two are one constant and the
 *     migration names it in its own message. `parallel-run.itest.ts` drives the writer and lets the
 *     database judge, which is the only way that agreement can be checked at all.
 *   - **the window**, which is read from the settings in ONE place ({@link readParallelRunWindow}) and
 *     recorded on every reconciliation row. A second reader would be a second answer to "which days is
 *     this comparison about".
 *   - **the system count**, which is one query and is the measurement the whole unit turns on.
 *
 * ## Why the window being unset is a REFUSAL and not an empty result
 *
 * `migration.parallel_run_window_start` and `migration.parallel_run_window_end` have no default: a
 * plausible cutover date in this build would be indistinguishable from a configured one (brief rule 15),
 * and the window decides which days the comparison is about. So with the window unset the job refuses by
 * name rather than reconciling zero days — a pass that reported "0 days, no variance" would be
 * indistinguishable from a parallel run in which everything agreed.
 */

export const PARALLEL_RUN_SQLSTATE = {
  /** A reconciliation dated outside the window the row names. */
  dayOutsideWindow: 'ZY741',
  /** A paper count with no staff-attributed audit row in the same transaction. */
  paperCountNotAttributed: 'ZY742',
  /** A paper count was changed or deleted. */
  paperCountImmutable: 'ZY743',
  /** A cutover decision with no staff-attributed audit row in the same transaction. */
  decisionNotAttributed: 'ZY744',
  /** A cutover decision was changed or deleted. */
  decisionImmutable: 'ZY745',
  /** A decision's unreconciled-day count disagrees with the variance rows it summarises. */
  decisionEvidenceDisagrees: 'ZY746',
} as const

/**
 * The audit actions ZY742 and ZY744 look for, spelled once.
 *
 * The triggers name these strings in SQL and this module emits them, which is two statements of one fact
 * — so the check that holds them equal is the database itself: a writer emitting anything else cannot
 * COMMIT, and `parallel-run.itest.ts` drives the real writer rather than asserting the constant.
 */
export const PARALLEL_RUN_AUDIT_ACTIONS = {
  paperCountRecorded: 'migration.parallel_run.paper_count_recorded',
  decisionRecorded: 'migration.parallel_run.decision_recorded',
} as const

/**
 * Re-exported from `@berelax/shared` rather than spelled again here.
 *
 * `@berelax/config` declares the settings and this module reads them, and neither package may import the
 * other — so the keys live in `shared`, which both may see. A second spelling here would be a reader
 * that silently falls back to the declared default, and for a date that fallback is invisible.
 */
export {
  PARALLEL_RUN_WINDOW_END_SETTING_KEY,
  PARALLEL_RUN_WINDOW_OPEN_QUESTION_ID,
  PARALLEL_RUN_WINDOW_START_SETTING_KEY,
}

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from 0153 into an `AppError`, or `null` for anything else.
 *
 * The KINDS are chosen by what the caller has to go and do:
 *
 *   - `validation` for ZY741 — the caller asked about a day the parallel run is not about.
 *   - `invariant_violated` for ZY742 and ZY744 — the WRITER failed to record the claim's author. A
 *     validation failure would send whoever reads it looking at the figure instead of at the code.
 *   - `forbidden` for ZY743 and ZY745 — the statement will never be permitted, for any caller, with any
 *     data. A correction is a new row.
 *   - `invariant_violated` for ZY746 — the evidence on the decision disagrees with the rows, which is a
 *     writer that counted one thing and recorded another.
 */
export function parallelRunError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case PARALLEL_RUN_SQLSTATE.dayOutsideWindow:
      return new AppError('validation', message, { details })
    case PARALLEL_RUN_SQLSTATE.paperCountNotAttributed:
    case PARALLEL_RUN_SQLSTATE.decisionNotAttributed:
    case PARALLEL_RUN_SQLSTATE.decisionEvidenceDisagrees:
      return new AppError('invariant_violated', message, { details })
    case PARALLEL_RUN_SQLSTATE.paperCountImmutable:
    case PARALLEL_RUN_SQLSTATE.decisionImmutable:
      return new AppError('forbidden', message, { details })
    default:
      return null
  }
}

export interface ParallelRunWindow {
  readonly start: string
  readonly end: string
}

/**
 * The parallel-run window, or a refusal naming the two settings and the open question.
 *
 * One reader, so there is one answer to which days the comparison is about. It reads `app_setting`
 * directly rather than taking the values as arguments, because the job and the reconciliation writer
 * must not be able to be handed different windows — which is the one way a day could be reconciled
 * against a window it was not in and ZY741 still pass.
 */
export async function readParallelRunWindow(sql: Sql): Promise<ParallelRunWindow> {
  const rows = await sql<{ key: string; value: unknown }[]>`
    select key, value
      from app_setting
     where key in (${PARALLEL_RUN_WINDOW_START_SETTING_KEY}, ${PARALLEL_RUN_WINDOW_END_SETTING_KEY})
  `
  const read = (key: string): string | null => {
    const value = rows.find((row) => row.key === key)?.value
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  }
  const start = read(PARALLEL_RUN_WINDOW_START_SETTING_KEY)
  const end = read(PARALLEL_RUN_WINDOW_END_SETTING_KEY)
  if (start === null || end === null) {
    throw new AppError(
      'validation',
      'The parallel-run window is not set, so there is no day this reconciliation is about. ' +
        `${PARALLEL_RUN_WINDOW_START_SETTING_KEY} and ${PARALLEL_RUN_WINDOW_END_SETTING_KEY} have no ` +
        `default on purpose (${PARALLEL_RUN_WINDOW_OPEN_QUESTION_ID}): a plausible cutover date in this ` +
        'build would be indistinguishable from a configured one. Refused rather than reconciling zero ' +
        'days, because "0 days, no variance" reads exactly like a parallel run in which everything ' +
        'agreed.',
      { details: { start, end } },
    )
  }
  if (start > end) {
    throw new AppError(
      'validation',
      `The parallel-run window starts on ${start} and ends on ${end}, which is no days at all.`,
      { details: { start, end } },
    )
  }
  return { start, end }
}

export interface PaperCountInput {
  readonly businessDay: string
  readonly sheetCount: number
  /** As the counter identifies themselves. Never defaulted and never a label. */
  readonly countedBy: string
  readonly note?: string
}

/**
 * Records what a named person says the paper day sheet held for one trading date.
 *
 * Takes a {@link UnitOfWork} and not a pool, deliberately: ZY742 refuses the COMMIT unless the audit row
 * naming the staff actor is in the SAME transaction, so a writer handed a pool could not satisfy it and
 * the compiling-but-wrong call is the one worth making impossible.
 */
export async function recordPaperCount(uow: UnitOfWork, input: PaperCountInput): Promise<void> {
  if (!Number.isInteger(input.sheetCount) || input.sheetCount < 0) {
    throw new AppError(
      'validation',
      `A paper day-sheet count of ${String(input.sheetCount)} is not a whole number of treatments.`,
    )
  }
  await uow.sql`
    insert into parallel_run_paper_count (business_day, sheet_count, counted_by, note)
    values (${input.businessDay}::date, ${input.sheetCount}, ${input.countedBy},
            ${input.note ?? null})
  `
  await uow.audit.record({
    action: PARALLEL_RUN_AUDIT_ACTIONS.paperCountRecorded,
    entityType: 'parallel_run_paper_count',
    entityId: input.businessDay,
    operation: 'create',
    after: { sheetCount: input.sheetCount, countedBy: input.countedBy },
  })
}

/** How many treatments the SYSTEM holds for one trading date. The measurement half. */
export async function countSystemTreatments(sql: Sql, businessDay: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n
      from appointment
     where trading_date = ${businessDay}::date
       and status <> 'cancelled'
  `
  return Number(rows[0]?.n ?? '0')
}

export interface ReconciliationWritten {
  readonly businessDay: string
  readonly systemCount: number
  readonly paperCount: number
  readonly difference: number
  readonly state: 'reconciled' | 'unreconciled'
}

/**
 * Records the system count for one day of the parallel run, upserting.
 *
 * Upsert and not append-only, which is 0138's recorded reasoning: a reconciliation is the current answer
 * to a question about a day, asked again whenever the answer might have changed, and a table of every
 * answer ever given makes "is this day reconciled" a query with an ordering in it. The DECISION is the
 * append-only record, because that is the thing somebody is answerable for.
 */
export async function recordReconciliation(
  uow: UnitOfWork,
  input: { readonly businessDay: string; readonly systemCount: number; readonly ranAt: Date },
  window: ParallelRunWindow,
): Promise<ReconciliationWritten> {
  await uow.sql`
    insert into parallel_run_reconciliation
      (business_day, system_count, window_start, window_end, ran_at)
    values (${input.businessDay}::date, ${input.systemCount}, ${window.start}::date,
            ${window.end}::date, ${input.ranAt})
    on conflict (business_day) do update
       set system_count = excluded.system_count,
           window_start = excluded.window_start,
           window_end   = excluded.window_end,
           ran_at       = excluded.ran_at
  `
  const rows = await uow.sql<
    { paperCount: number; systemCount: number; difference: number; state: string }[]
  >`
    select paper_count as "paperCount", system_count as "systemCount",
           difference as "difference", state as "state"
      from parallel_run_variance
     where business_day = ${input.businessDay}::date
  `
  const row = rows[0]
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      `No variance row for ${input.businessDay} after recording its system count. The view joins the ` +
        'paper count to the reconciliation, and the reconciliation has a foreign key to the paper ' +
        'count, so this cannot happen for a row that committed.',
    )
  }
  return {
    businessDay: input.businessDay,
    systemCount: row.systemCount,
    paperCount: row.paperCount,
    difference: row.difference,
    state: row.state === 'unreconciled' ? 'unreconciled' : 'reconciled',
  }
}

export interface ParallelRunVarianceRow {
  readonly businessDay: string
  readonly paperCount: number
  readonly countedBy: string
  readonly systemCount: number
  readonly difference: number
  readonly state: 'reconciled' | 'unreconciled'
}

/** Every variance row of the parallel run, in trading-date order. */
export async function readParallelRunVariance(
  sql: Sql,
  window: ParallelRunWindow,
): Promise<readonly ParallelRunVarianceRow[]> {
  return sql<ParallelRunVarianceRow[]>`
    select business_day::text as "businessDay", paper_count as "paperCount",
           counted_by as "countedBy", system_count as "systemCount",
           difference as "difference", state as "state"
      from parallel_run_variance
     where business_day between ${window.start}::date and ${window.end}::date
     order by business_day
  `
}

/** How many days up to and including `businessDay` are unreconciled. The decision's evidence. */
export async function countUnreconciledDaysTo(sql: Sql, businessDay: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n
      from parallel_run_variance
     where state = 'unreconciled' and business_day <= ${businessDay}::date
  `
  return Number(rows[0]?.n ?? '0')
}

export interface ParallelRunDecisionInput {
  readonly decision: 'proceed' | 'roll_back'
  readonly decidedAt: Date
  /** As the decider identifies themselves. Never defaulted and never a label. */
  readonly decidedBy: string
  readonly rationale: string
  readonly asOfBusinessDay: string
  /** Counted by the caller from {@link countUnreconciledDaysTo}, and held to the rows by ZY746. */
  readonly unreconciledDays: number
}

/**
 * Records the cutover-or-roll-back decision as a named person's claim.
 *
 * It takes the decision as an ARGUMENT and computes nothing. There is no `decideCutover`, no threshold
 * and no recommendation anywhere in this module, and the absence is the point: whether a business goes
 * live on this system or back to paper is not a function of a variance count, and a mechanism here would
 * be this build deciding it from a rule nobody wrote down. What the code does is make the decision
 * attributable (ZY744), permanent (ZY745) and checkable against its own evidence (ZY746).
 */
export async function recordParallelRunDecision(
  uow: UnitOfWork,
  input: ParallelRunDecisionInput,
): Promise<string> {
  const rows = await uow.sql<{ id: string }[]>`
    insert into parallel_run_decision
      (decision, decided_at, decided_by, rationale, as_of_business_day, unreconciled_days)
    values (${input.decision}, ${input.decidedAt}, ${input.decidedBy}, ${input.rationale},
            ${input.asOfBusinessDay}::date, ${input.unreconciledDays})
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    throw new AppError('invariant_violated', 'The cutover decision insert returned no row.')
  }
  await uow.audit.record({
    action: PARALLEL_RUN_AUDIT_ACTIONS.decisionRecorded,
    entityType: 'parallel_run_decision',
    entityId: id,
    operation: 'create',
    after: {
      decision: input.decision,
      decidedBy: input.decidedBy,
      asOfBusinessDay: input.asOfBusinessDay,
      unreconciledDays: input.unreconciledDays,
    },
  })
  return id
}

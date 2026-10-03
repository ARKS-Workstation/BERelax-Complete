import { DISPATCH_DESTINATIONS } from '@berelax/analytics'
import {
  DISPATCH_STATES,
  type DispatchReconciliation,
  type DispatchState,
  type InternalConversion,
  isUnreconciled,
  type PushedDispatch,
  reconcileDispatches,
} from '@berelax/core'
import {
  type DispatchReconciliationItemInput,
  pushedDispatchesForDay,
  type Sql,
  writeDispatchReconciliation,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The daily dispatch reconciliation (A-MEAS-07).
 *
 * ## What it compares and why both sides have to come from different places
 *
 * One side is what this business says it took. The other is what each destination was actually told, read
 * off `analytics_dispatch` — the stored payload's own figure, never re-derived from our own tables,
 * because a comparison whose two sides are both computed from the same records is a comparison of this
 * build with itself.
 *
 * ## The answer is a discriminated union and the pass stores the STATE
 *
 * `reconcileDispatches` in `@berelax/core` answers `reconciled` or `unreconciled`, and the unreconciled
 * variant carries no revenue figure at all. The pass stores that state, and 0138's CHECK holds it to the
 * figures — so a panel branches on a column rather than comparing a difference to zero itself, which is
 * the comparison a reader eventually forgets to make (ADR 0073's shape, ADR 0002's rule).
 *
 * ## Internal truth is INJECTED, and the shipped resolver refuses
 *
 * "Internal paid conversions from the rollups" is A-FIRST-09's materialisation and it is not built. So the
 * internal side comes from {@link InternalTruthResolver}, and the resolver this build ships answers
 * "nothing on file" — the pass then writes NO reconciliation for that day rather than one claiming every
 * dispatch is a push with no internal truth behind it, which is what an empty internal side would make it
 * say. A reconciliation that reported every conversion as unexplained would be worse than none: it is a
 * screen saying the money does not add up, every morning, about a question nobody asked yet.
 *
 * The seam is also what lets the whole pass — the classification, the write, ZY471, ZY472 and the
 * idempotence — be proved against a real PostgreSQL today, which is `dispatch-reconciliation.itest.ts`.
 */

export const DISPATCH_RECONCILIATION_JOB = 'analytics.dispatch-reconciliation'

/** The `agent_definition` row migration 0138 inserts. Spelled here once and read by the registry. */
export const DISPATCH_RECONCILIATION_AGENT = 'dispatch_reconciliation'

/**
 * What this business says it took on a trading day, or null when nothing can say.
 *
 * `null` and not an empty array, and the distinction is the unit's own subject: an empty array is a day
 * with no conversions, which reconciles against no dispatches; `null` is *this build cannot answer*, and a
 * reconciliation written from it would report every dispatch as a push with nothing behind it.
 */
export type InternalTruthResolver = (
  businessDay: string,
) => Promise<readonly InternalConversion[] | null> | readonly InternalConversion[] | null

/**
 * The resolver this build ships, which answers "nothing on file" for every day.
 *
 * A-FIRST-09 owns the funnel materialisation and the nightly rollups. Until then the pass runs, finds no
 * internal side, writes nothing and SAYS so in its log line — because "no reconciliation today" has to
 * read as *the rollups are missing* rather than as *everything agreed* (ADR 0002).
 */
export const NO_INTERNAL_TRUTH_ON_FILE: InternalTruthResolver = () => null

export interface ReconciliationPassResult {
  readonly businessDay: string
  readonly destinations: number
  readonly reconciled: number
  readonly unreconciled: number
  /** Destinations skipped because this build has no internal truth for the day. A-FIRST-09's. */
  readonly withoutInternalTruth: number
}

/** A dispatch state read off a row, parsed rather than trusted. */
function dispatchStateOf(stored: string): DispatchState {
  if ((DISPATCH_STATES as readonly string[]).includes(stored)) return stored as DispatchState
  throw new AppError(
    'invariant_violated',
    `analytics_dispatch holds state ${JSON.stringify(stored)}, which is not one of ` +
      `${DISPATCH_STATES.join(' | ')}. A sixth state means the enum was extended without this ` +
      'comparison being told what it counts as — and the default a parser-less read would fall through ' +
      'to is "not pushed", which reports every one of those conversions as missing.',
    { details: { state: stored } },
  )
}

/** The items a reconciliation's differences become, which is the one mapping between the two shapes. */
export function reconciliationItems(
  result: DispatchReconciliation,
): readonly DispatchReconciliationItemInput[] {
  const differences = isUnreconciled(result) ? result.differences : result.intentionallyNotPushed
  return differences.map((difference) => {
    if (difference.kind === 'missing') {
      return {
        eventId: difference.eventId,
        classification: 'missing' as const,
        dispatchId: null,
        otherDispatchId: null,
        valueFils: difference.valueFils,
      }
    }
    if (difference.kind === 'duplicate') {
      return {
        eventId: difference.eventId,
        classification: 'duplicate' as const,
        dispatchId: difference.dispatchId,
        otherDispatchId: difference.otherDispatchId,
        valueFils: difference.valueFils,
      }
    }
    return {
      eventId: difference.eventId,
      classification: 'intentionally_not_pushed' as const,
      dispatchId: difference.dispatchId,
      otherDispatchId: null,
      // A suppression accounts for no money on either side — see `reconcileDispatches`' own note.
      valueFils: 0,
    }
  })
}

/**
 * One pass over one trading day. Takes its instant, so a suite drives it frozen.
 *
 * Each destination is reconciled and stored INDIVIDUALLY: one destination having no adapter, or one write
 * being refused by ZY472, must not leave the other destination's answer unwritten. A pass that stored them
 * together would make a single refusal look like a pass that did not run.
 */
export async function runDispatchReconciliationPass(
  sql: Sql,
  input: {
    readonly businessDay: string
    readonly nowIso: string
    readonly destinations: readonly string[]
    readonly resolveInternalTruth: InternalTruthResolver
  },
): Promise<ReconciliationPassResult> {
  if (input.destinations.length === 0) {
    throw new AppError(
      'invariant_violated',
      'A reconciliation pass was asked to compare no destinations at all, which would write nothing and ' +
        "report a clean day — ADR 0002's failure exactly. The destinations are the registry's " +
        '`DISPATCH_DESTINATIONS`.',
    )
  }
  let reconciled = 0
  let unreconciled = 0
  let withoutInternalTruth = 0

  for (const destination of input.destinations) {
    const internal = await input.resolveInternalTruth(input.businessDay)
    if (internal === null) {
      withoutInternalTruth += 1
      console.warn(
        `${DISPATCH_RECONCILIATION_JOB} has no internal truth for ${input.businessDay}, so ${destination} ` +
          'is NOT reconciled. A-FIRST-09 owns the rollups; a reconciliation written from an empty ' +
          'internal side would report every dispatch as a push with nothing behind it.',
      )
      continue
    }
    const rows = await pushedDispatchesForDay(sql, { businessDay: input.businessDay, destination })
    const pushed: readonly PushedDispatch[] = rows.map((row) => ({
      eventId: row.eventId,
      dispatchId: row.dispatchId,
      state: dispatchStateOf(row.state),
      valueFils: row.valueFils,
    }))
    const result = reconcileDispatches({ destination, internal, pushed })
    const counts = isUnreconciled(result) ? result.counts : result
    await writeDispatchReconciliation(sql, {
      summary: {
        businessDay: input.businessDay,
        destination,
        internalCount: counts.internalCount,
        pushedCount: counts.pushedCount,
        missingCount: counts.missingCount,
        duplicateCount: counts.duplicateCount,
        intentionallyNotPushedCount: counts.intentionallyNotPushedCount,
        differenceFils: isUnreconciled(result) ? result.differenceFils : 0,
        state: result.kind,
        ranAtIso: input.nowIso,
      },
      items: reconciliationItems(result),
    })
    if (isUnreconciled(result)) unreconciled += 1
    else reconciled += 1
  }

  return {
    businessDay: input.businessDay,
    destinations: input.destinations.length,
    reconciled,
    unreconciled,
    withoutInternalTruth,
  }
}

/** A log line on every pass, including one that wrote nothing — see the handler's note. */
export function describeReconciliationPass(result: ReconciliationPassResult): string {
  return (
    `${result.businessDay}: ${result.reconciled} reconciled, ${result.unreconciled} UNRECONCILED of ` +
    `${result.destinations} destination(s); NOT compared: ${result.withoutInternalTruth} with no ` +
    'internal truth on file (A-FIRST-09)'
  )
}

let configured: Sql | undefined

export function setDispatchReconciliationSql(sql: Sql): void {
  configured = sql
}

async function dispatchReconciliationHandler(_data: never, context: JobContext): Promise<void> {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${DISPATCH_RECONCILIATION_JOB} ran before setDispatchReconciliationSql() supplied a connection. ` +
        'run.ts calls it before startWorkers().',
    )
  }
  const nowIso = context.now()
  /*
   * The day that has just CLOSED, read out of the calendar.
   *
   * ZY472 refuses a reconciliation for a day that had not closed at the instant the pass claims to have
   * run, so this query asks the calendar for the latest day whose close is already behind us. Deriving it
   * by subtracting a day from the clock would be a day out at every boundary, and a day out is a screen
   * saying the conversions did not go out.
   */
  const [day] = await configured<{ trading_date: string }[]>`
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
        'reconcile. A date derived by subtracting a day instead would be refused by ZY472 on the days it ' +
        'got wrong and silently accepted on the rest.',
      { details: { nowIso } },
    )
  }
  const result = await runDispatchReconciliationPass(configured, {
    businessDay: day.trading_date,
    nowIso,
    destinations: DISPATCH_DESTINATIONS,
    resolveInternalTruth: NO_INTERNAL_TRUTH_ON_FILE,
  })
  console.log(`${DISPATCH_RECONCILIATION_JOB} ${nowIso}: ${describeReconciliationPass(result)}`)
}

/**
 * The pass's definition.
 *
 * At 04:23, after trading closes at 02:00 and after A-MEAS-05's upload at 03:17 — so the day is complete,
 * its offline conversions have been enqueued, and the five-minute consumer has had time to drain them. A
 * reconciliation that ran before the upload would report every offline conversion as missing, which is the
 * failure ZY472 refuses for a day that is still open and which ordering is what prevents for one that has
 * just closed.
 *
 * A CRON and not a queue, because what is being watched is the ABSENCE of an answer: a reconciliation
 * nobody ran looks exactly like one that found nothing, and the `agent_heartbeat` row 0138 writes is the
 * one thing that can tell them apart.
 */
export const DISPATCH_RECONCILIATION_JOB_DEFINITION: JobDefinition<never> = {
  name: DISPATCH_RECONCILIATION_JOB,
  purpose:
    "Compares each closed trading day's internal paid conversions against what each destination was " +
    'actually told, classifying every difference as missing, duplicate or intentionally not pushed by ' +
    'consent, and storing a STATE a downstream panel must honour rather than a figure it has to compare ' +
    "to zero itself. The internal side is A-FIRST-09's rollups and is not built, so the shipped resolver " +
    'answers "nothing on file" and the pass writes nothing and says so — a reconciliation from an empty ' +
    'internal side would report every dispatch as a push with nothing behind it (A-MEAS-07, ADR 0093).',
  cron: '23 4 * * *',
  agent: DISPATCH_RECONCILIATION_AGENT,
  retryLimit: 2,
  retryDelaySeconds: 600,
  retryBackoff: true,
  expireInSeconds: 600,
  handler: dispatchReconciliationHandler,
}

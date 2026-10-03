import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The reconciliation's two reads and its one write (A-MEAS-07), over migration 0138.
 *
 * ## No classification here
 *
 * Which difference is `missing`, which is `duplicate` and which is a consent suppression is decided by
 * `reconcileDispatches` in `@berelax/core`, and this module stores what it answered. `packages/db` may
 * never import `packages/core` (ADR 0001), and a second classification written in SQL is exactly the
 * second statement A-MEAS-07 exists to find: both sides would be internally consistent and the panel would
 * render whichever one the query happened to produce.
 *
 * ## The write is a REPLACE and that is the acceptance line
 *
 * *"the job is idempotent per business_day: two runs produce identical rows"*. The summary's key is
 * `(business_day, destination)` and the items' is `(business_day, destination, event_id, classification)`,
 * so {@link writeDispatchReconciliation} deletes that pair's items, upserts the summary and inserts the
 * items again — in ONE transaction, because ZY471 holds the summary's counts equal to its items at COMMIT
 * and a half-written pair would be refused rather than stored.
 */

/** The two SQLSTATEs 0138 raises, so a caller can branch on the rule rather than on prose (ADR 0043). */
export const DISPATCH_RECONCILIATION_SQLSTATE = {
  summaryDisagreesWithItems: 'ZY471',
  dayHasNotClosed: 'ZY472',
} as const

export const DISPATCH_RECONCILIATION_REFUSALS = [
  'summary_disagrees_with_items',
  'day_has_not_closed',
] as const
export type DispatchReconciliationRefusal = (typeof DISPATCH_RECONCILIATION_REFUSALS)[number]

/** The named refusal carried on an error this module raised, or null. */
export function dispatchReconciliationRefusalOf(
  err: unknown,
): DispatchReconciliationRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (DISPATCH_RECONCILIATION_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as DispatchReconciliationRefusal)
    : null
}

const sqlstateOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** One dispatch row as the comparison needs it: the id, the state and the figure that travelled. */
export interface PushedDispatchRow {
  readonly eventId: string
  readonly dispatchId: string
  readonly state: string
  readonly valueFils: number
}

/**
 * Every dispatch for one destination whose conversion was decided on a trading day.
 *
 * Keyed on `decided_at` inside the day's own window rather than on `occurred_at`, and the difference is the
 * whole of A-MEAS-05: an offline conversion's `occurred_at` is days earlier, so a window over it would
 * compare a day's dispatches against a different day's conversions. What a reconciliation asks is *what
 * did this pass decide about on this day*, and that is the decision instant.
 *
 * The figure comes off the STORED payload (`payload->>'valueFils'`) and is never rebuilt from another
 * table: the whole point is comparing internal truth against what was pushed, and a figure re-derived from
 * our own records would make the comparison a comparison of this build with itself.
 */
export async function pushedDispatchesForDay(
  sql: Sql,
  query: { readonly businessDay: string; readonly destination: string },
): Promise<readonly PushedDispatchRow[]> {
  assertBusinessDay(query.businessDay)
  const rows = await sql<
    { event_id: string; dispatch_id: string; state: string; value_fils: string | null }[]
  >`
    select d.event_id,
           d.dispatch_id,
           d.state::text              as state,
           d.payload->>'valueFils'    as value_fils
      from analytics_dispatch d
      join public.business_day b on b.trading_date = ${query.businessDay}::date
     where d.destination = ${query.destination}
       and d.decided_at >= b.opens_at
       and d.decided_at <  b.closes_at
     order by d.event_id, d.dispatch_id
  `
  return rows.map((row) => ({
    eventId: row.event_id,
    dispatchId: row.dispatch_id,
    state: row.state,
    /*
     * A payload with no `valueFils` is a non-terminal event, which the egress guard drops the figure from
     * on purpose. Zero and not null: the comparison is arithmetic, and a null here would make every sum
     * involving it null — a difference of NULL reads as "no disagreement" to anything that tests `<> 0`.
     */
    valueFils: row.value_fils === null ? 0 : Number(row.value_fils),
  }))
}

const assertBusinessDay = (businessDay: string): void => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(businessDay)) return
  throw new AppError(
    'validation',
    `A reconciliation was asked for business day ${JSON.stringify(businessDay)}, which is not a ` +
      'YYYY-MM-DD date. Trading runs 11:00-02:00 and the window is read out of the calendar, so an ' +
      "instant here would compare one day against another day's conversions.",
    { details: { businessDay } },
  )
}

/** What the writer stores, which is exactly what `reconcileDispatches` answered. */
export interface DispatchReconciliationSummaryInput {
  readonly businessDay: string
  readonly destination: string
  readonly internalCount: number
  readonly pushedCount: number
  readonly missingCount: number
  readonly duplicateCount: number
  readonly intentionallyNotPushedCount: number
  readonly differenceFils: number
  readonly state: 'reconciled' | 'unreconciled'
  readonly ranAtIso: string
}

export interface DispatchReconciliationItemInput {
  readonly eventId: string
  readonly classification: 'missing' | 'duplicate' | 'intentionally_not_pushed'
  readonly dispatchId: string | null
  readonly otherDispatchId: string | null
  readonly valueFils: number
}

/**
 * Stores one destination's reconciliation for one day, replacing whatever was there.
 *
 * One transaction, because ZY471 compares the summary against its items at COMMIT: writing the summary and
 * the items separately would be refused half way, and the half that landed would be a summary nobody could
 * check. The items are deleted first rather than upserted, because a re-run after a dispatch finally
 * landed has FEWER items than the run before it — an upsert would leave the earlier `missing` row behind
 * and ZY471 would then refuse the whole write, which is the gate doing its job about a bug in this
 * function.
 */
export async function writeDispatchReconciliation(
  sql: Sql,
  input: {
    readonly summary: DispatchReconciliationSummaryInput
    readonly items: readonly DispatchReconciliationItemInput[]
  },
): Promise<void> {
  const { summary } = input
  assertBusinessDay(summary.businessDay)
  try {
    await sql.begin(async (tx) => {
      await tx`
        delete from analytics_dispatch_reconciliation_item
         where business_day = ${summary.businessDay}::date
           and destination = ${summary.destination}
      `
      await tx`
        insert into analytics_dispatch_reconciliation (
          business_day, destination, internal_count, pushed_count, missing_count, duplicate_count,
          intentionally_not_pushed_count, difference_fils, state, ran_at
        ) values (
          ${summary.businessDay}::date, ${summary.destination}, ${summary.internalCount},
          ${summary.pushedCount}, ${summary.missingCount}, ${summary.duplicateCount},
          ${summary.intentionallyNotPushedCount}, ${summary.differenceFils}, ${summary.state},
          ${summary.ranAtIso}::timestamptz
        )
        on conflict (business_day, destination) do update
           set internal_count = excluded.internal_count,
               pushed_count = excluded.pushed_count,
               missing_count = excluded.missing_count,
               duplicate_count = excluded.duplicate_count,
               intentionally_not_pushed_count = excluded.intentionally_not_pushed_count,
               difference_fils = excluded.difference_fils,
               state = excluded.state,
               ran_at = excluded.ran_at
      `
      for (const item of input.items) {
        await tx`
          insert into analytics_dispatch_reconciliation_item (
            business_day, destination, event_id, classification, dispatch_id, other_dispatch_id,
            value_fils, created_at
          ) values (
            ${summary.businessDay}::date, ${summary.destination}, ${item.eventId},
            ${item.classification}::analytics_dispatch_difference_kind,
            ${item.dispatchId}::uuid, ${item.otherDispatchId}::uuid, ${item.valueFils},
            ${summary.ranAtIso}::timestamptz
          )
        `
      }
    })
  } catch (error) {
    const code = sqlstateOf(error)
    if (code === DISPATCH_RECONCILIATION_SQLSTATE.summaryDisagreesWithItems) {
      throw new AppError(
        'conflict',
        'The reconciliation summary this pass wrote does not agree with the items it wrote beside it. ' +
          'The panel renders the counts, so a summary that disagrees with the rows underneath it is a ' +
          'screen showing a number those rows contradict — which is why the database refuses it at ' +
          'COMMIT rather than storing it.',
        { details: { refusal: 'summary_disagrees_with_items', ...summaryIdentity(summary) } },
      )
    }
    if (code === DISPATCH_RECONCILIATION_SQLSTATE.dayHasNotClosed) {
      throw new AppError(
        'conflict',
        'A reconciliation was written for a trading day that had not closed at the instant the pass ' +
          'claims to have run. A run while the day is still open compares internal figures against ' +
          'dispatches the consumer has not attempted yet and reports every one of them as missing.',
        { details: { refusal: 'day_has_not_closed', ...summaryIdentity(summary) } },
      )
    }
    throw error
  }
}

const summaryIdentity = (summary: DispatchReconciliationSummaryInput) => ({
  businessDay: summary.businessDay,
  destination: summary.destination,
})

/** One destination's stored reconciliation for one day, for the panel and the API. */
export interface StoredDispatchReconciliation {
  readonly businessDay: string
  readonly destination: string
  readonly internalCount: number
  readonly pushedCount: number
  readonly missingCount: number
  readonly duplicateCount: number
  readonly intentionallyNotPushedCount: number
  readonly differenceFils: number
  readonly state: string
  readonly ranAtIso: string
  readonly items: readonly (DispatchReconciliationItemInput & { readonly classification: string })[]
}

/**
 * Reads back one day's reconciliations, every destination, with their items.
 *
 * What a panel renders. It returns the STATE and never a figure the caller must decide how to interpret,
 * because the acceptance line is that a non-zero difference makes the API answer `Unreconciled` rather
 * than a number — and a reader that had to compare `difference_fils` to zero itself is a reader that will
 * eventually forget to.
 */
export async function dispatchReconciliationsForDay(
  sql: Sql,
  query: { readonly businessDay: string },
): Promise<readonly StoredDispatchReconciliation[]> {
  assertBusinessDay(query.businessDay)
  const summaries = await sql<
    {
      business_day: string
      destination: string
      internal_count: number
      pushed_count: number
      missing_count: number
      duplicate_count: number
      intentionally_not_pushed_count: number
      difference_fils: string
      state: string
      ran_at: Date
    }[]
  >`
    select business_day::text as business_day, destination, internal_count, pushed_count, missing_count,
           duplicate_count, intentionally_not_pushed_count, difference_fils::text as difference_fils,
           state, ran_at
      from analytics_dispatch_reconciliation
     where business_day = ${query.businessDay}::date
     order by destination
  `
  const items = await sql<
    {
      destination: string
      event_id: string
      classification: string
      dispatch_id: string | null
      other_dispatch_id: string | null
      value_fils: string
    }[]
  >`
    select destination, event_id, classification::text as classification, dispatch_id,
           other_dispatch_id, value_fils::text as value_fils
      from analytics_dispatch_reconciliation_item
     where business_day = ${query.businessDay}::date
     order by destination, classification, event_id
  `
  return summaries.map((summary) => ({
    businessDay: summary.business_day,
    destination: summary.destination,
    internalCount: summary.internal_count,
    pushedCount: summary.pushed_count,
    missingCount: summary.missing_count,
    duplicateCount: summary.duplicate_count,
    intentionallyNotPushedCount: summary.intentionally_not_pushed_count,
    differenceFils: Number(summary.difference_fils),
    state: summary.state,
    ranAtIso: summary.ran_at.toISOString(),
    items: items
      .filter((item) => item.destination === summary.destination)
      .map((item) => ({
        eventId: item.event_id,
        classification: item.classification as DispatchReconciliationItemInput['classification'],
        dispatchId: item.dispatch_id,
        otherDispatchId: item.other_dispatch_id,
        valueFils: Number(item.value_fils),
      })),
  }))
}

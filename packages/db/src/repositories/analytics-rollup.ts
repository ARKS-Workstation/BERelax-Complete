import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The funnel materialisation, the three nightly rollups and the expired-ref purge (A-FIRST-09), over
 * migrations 0096 and 0150.
 *
 * ## Which trading date a figure is filed under, and why nothing here resolves one
 *
 * Nothing in this module turns an instant into a trading date. Two statements of that rule already exist
 * and both are enforced by the database — `analytics.session.trading_date` by ZY222 against
 * `business_day`'s own `[opens_at, closes_at)` window (0116), and `appointment.trading_date` by a foreign
 * key into `business_day` (0024) — so a third, consulted only by the rollups, would disagree with the
 * first two on exactly the dates somebody overrode the hours for. Traffic and the funnel group on the
 * session's stored date; revenue groups on the appointment's. A 01:30 paid invoice rolls into the previous
 * business day because the appointment's own materialised date says so, which is what "resolved through
 * the business_day table rather than date(occurred_at)" means.
 *
 * The gap cohort is COUNTED rather than re-resolved: `trading_date_basis <> 'trading'` is a session filed
 * under the next date the calendar opens because its instant fell in the 02:00-11:00 gap (ADR 0066), and
 * `daily_traffic.gap_sessions` and `daily_funnel.gap_entered` carry that count so `Y5-funnel-gap-bucket`
 * stays re-bucketable instead of being read as daytime trade.
 *
 * ## Why the two mappings arrive as ARGUMENTS
 *
 * `COLLECTED_EVENT_FUNNEL` and `APPOINTMENT_STATUS_FUNNEL` live in `@berelax/core`, which `packages/db`
 * may never import (ADR 0001). A copy of either in SQL would be a second statement of the funnel — the
 * thing A-FIRST-02's `Record<AnalyticsEventName, …>` exists to make impossible — so the caller, which is
 * `apps/worker` and may import both, passes the mapping in and these statements join against it as a
 * values list. A renamed event or a ninth status is then a compile error in core rather than a funnel that
 * silently stops at `cta_click`.
 *
 * ## Why a bot's steps are MATERIALISED and excluded at the COUNT
 *
 * ADR 0062's rule is that the classifier's verdict is stored and never acted on, and A-FIRST-04 deferred
 * the funnel's exclusion to this unit by name. A step a crawler reached still happened, so the row is
 * written; {@link funnelCountRows} excludes bot sessions unless asked, and the two answers differ by
 * exactly the bot count. Filtering at the materialisation instead would make the flag unrecoverable: a
 * re-classified crawler could never be counted back in without re-reading the raw events, which retention
 * removes at ninety days.
 *
 * ## Why the terminal stage is read from the LEDGER
 *
 * `paid` is an invoice settled in full — `invoice_settlement.outstanding_fils <= 0`, the same quantity
 * ZT001 refuses to let go negative — and never a booking status, an event or a sum of money computed here.
 * A funnel that counted its own idea of paid would disagree with the invoice the moment a refund landed,
 * and the disagreement would be between two numbers neither of which was wrong when it was computed.
 */

export const ROLLUP_SQLSTATE = {
  oneStepPerSession: 'ZY701',
  dayHasNotClosed: 'ZY702',
} as const

export const ROLLUP_REFUSALS = ['one_step_per_session', 'day_has_not_closed'] as const
export type RollupRefusal = (typeof ROLLUP_REFUSALS)[number]

/** The refusal a thrown error carries, or `null` when it is not one of this schema's. */
export function rollupRefusalOf(error: unknown): RollupRefusal | null {
  const code = (error as { code?: unknown } | null)?.code
  if (code === ROLLUP_SQLSTATE.oneStepPerSession) return 'one_step_per_session'
  if (code === ROLLUP_SQLSTATE.dayHasNotClosed) return 'day_has_not_closed'
  return null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertTradingDate(tradingDate: string): void {
  if (ISO_DATE.test(tradingDate)) return
  throw new AppError(
    'validation',
    `A rollup was asked for trading date ${JSON.stringify(tradingDate)}, which is not a YYYY-MM-DD ` +
      'date. Trading runs 11:00-02:00, so an instant cast to a date here moves every late sale and every ' +
      'session after midnight onto the wrong day.',
    { details: { tradingDate } },
  )
}

/**
 * One collected event's contribution, as `COLLECTED_EVENT_FUNNEL` holds it.
 *
 * `entryOnly` is `page_view`'s alone: the landing stage is the session ENTRY, so one session contributes
 * exactly one landing and the funnel's first bucket is a count of sessions. The flag the statement reads
 * is the one A-FIRST-05's ingest OVERWROTE server-side on the session's first page view — a browser has
 * never been told which session it is in, and a client claiming entry on its fourth page view would give
 * one session four landings.
 */
export interface CollectedStageMapping {
  readonly eventName: string
  readonly stage: string
  readonly entryOnly: boolean
}

/**
 * One appointment status's contribution, as `APPOINTMENT_STATUS_FUNNEL` holds it.
 *
 * `excludedReason` is set instead of `stage` for a status that ENDS a journey — a no-show, a cancellation,
 * a reschedule. The row then counts in `entered` and in `excluded`, which is what makes the show-adjusted
 * rate's subtraction exact rather than approximate.
 */
export interface StatusStageMapping {
  readonly status: string
  readonly stage: string | null
  readonly excludedReason: string | null
}

export interface MaterialiseFunnelInput {
  readonly tradingDate: string
  /** From `COLLECTED_EVENT_FUNNEL` in `@berelax/core`. Empty is refused, not treated as "no stages". */
  readonly collectedStages: readonly CollectedStageMapping[]
  /** From `APPOINTMENT_STATUS_FUNNEL` in `@berelax/core`. */
  readonly statusStages: readonly StatusStageMapping[]
  /**
   * The stage a booking's creation contributes, and the stage a settled invoice contributes.
   *
   * Passed rather than written here for the mappings' reason: `FUNNEL_NON_LIFECYCLE_EVENT_TYPES` and
   * `FUNNEL_TERMINAL_STAGE` are the taxonomy's, and a literal `'paid'` in this file would be a ninth
   * place the funnel's vocabulary is stated.
   */
  readonly bookingCreatedStage: string
  readonly paidStage: string
  /** The stage whose exclusion a no-show carries. `confirmed`: the booking was confirmed and then was not. */
  readonly confirmedStage: string
}

export interface MaterialisedFunnel {
  readonly deleted: number
  readonly collected: number
  readonly domain: number
}

/**
 * Re-materialises every funnel step of every session filed under one trading date.
 *
 * DELETE then INSERT, and the delete is what makes a second run converge rather than double every figure.
 * 0096 made `funnel_step` deliberately not append-only for exactly this — *"a funnel step is DERIVED and a
 * corrected derivation has to be able to replace it"* — and 0150 grants the application role DELETE on
 * that one table so the replacement is expressible at all.
 *
 * Scoped by the SESSION's trading date rather than by each step's own instant. A session is at most a few
 * hours of inactivity-bounded activity, so its steps belong together; scoping by the step's instant
 * instead would split one journey across two passes and let ZY701 refuse the second half of it.
 */
export async function materialiseFunnelSteps(
  sql: Sql,
  input: MaterialiseFunnelInput,
): Promise<MaterialisedFunnel> {
  assertTradingDate(input.tradingDate)
  if (input.collectedStages.length === 0 || input.statusStages.length === 0) {
    throw new AppError(
      'invariant_violated',
      'The funnel materialisation was called with an empty stage mapping, so it would write no step and ' +
        'report a clean pass — ADR 0002\'s failure, a pass over nothing answering "all done". The ' +
        'mappings are `COLLECTED_EVENT_FUNNEL` and `APPOINTMENT_STATUS_FUNNEL` in @berelax/core and are ' +
        'total over their own vocabularies by compilation.',
      {
        details: {
          collected: input.collectedStages.length,
          statuses: input.statusStages.length,
        },
      },
    )
  }

  const deleted = await sql`
    delete from analytics.funnel_step f
     where f.session_id in (
             select s.session_id from analytics.session s where s.trading_date = ${input.tradingDate}::date
           )
  `
  const collectedRows = input.collectedStages.map((mapping) => [
    mapping.eventName,
    mapping.stage,
    mapping.entryOnly,
  ])

  /*
   * The collected half: the EARLIEST occurrence of each stage per session.
   *
   * `min(occurred_at)` and not every occurrence, because a funnel step is "this session reached this
   * stage" and a session that read three service pages has not reached `service_viewed` three times.
   * ZY701 refuses the alternative whichever call site writes it.
   */
  const collected = await sql`
    insert into analytics.funnel_step (session_id, step, occurred_at, excluded_reason)
    select e.session_id,
           m.stage::analytics.funnel_step_name,
           min(e.occurred_at),
           null
      from analytics.event e
      join analytics.session s on s.session_id = e.session_id
      join (select * from unnest(${sql.array(
        collectedRows.map((row) => row[0] as string),
      )}::text[], ${sql.array(collectedRows.map((row) => row[1] as string))}::text[], ${sql.array(
        collectedRows.map((row) => row[2] as boolean),
      )}::boolean[]) as t(event_name, stage, entry_only)) m
        on m.event_name = e.event_name
     where s.trading_date = ${input.tradingDate}::date
       -- The entry flag, as the SERVER wrote it. See CollectedStageMapping: the client's own claim is
       -- overwritten on the session's first page view, so this reads a decision rather than a boast.
       and (not m.entry_only or (e.properties ->> 'entry') = 'true')
     group by e.session_id, m.stage
  `

  /*
   * The domain half: the steps a BOOKING contributes, joined to its session through
   * `booking_attribution.session_reference` — A-FIRST-08's column, which is the only link in this schema
   * from a booking to the analytics session that produced it.
   *
   * A booking with no attributed session contributes NO funnel step, and that is the shape rather than a
   * gap: the funnel measures web journeys, and a walk-in has none. Its revenue is still attributed,
   * because `daily_source_revenue` reads `booking_attribution` directly and an offline booking carries
   * `source = 'offline'`.
   */
  const statusRows = input.statusStages.filter((mapping) => mapping.stage !== null)
  const excludedRows = input.statusStages.filter((mapping) => mapping.excludedReason !== null)

  const domain = await sql`
    with attributed as (
      select ba.session_reference as session_id, b.id as booking_id, b.created_at
        from booking_attribution ba
        join booking b on b.id = ba.booking_id
        join analytics.session s on s.session_id = ba.session_reference
       where ba.session_reference is not null
         and s.trading_date = ${input.tradingDate}::date
    ),
    -- booking_created: the booking's own instant, one row per session however many bookings it produced.
    created as (
      select session_id, ${input.bookingCreatedStage} as step, min(created_at) as occurred_at,
             null::text as excluded_reason
        from attributed
       group by session_id
    ),
    -- The lifecycle steps, from the appointment status HISTORY rather than the current status: a no-show
    -- was confirmed first, and the current status alone cannot say so. The history is append-only
    -- (ADR 0008), so the earliest transition INTO a status is the fact.
    reached as (
      select a.session_id,
             m.stage as step,
             min(h.occurred_at) as occurred_at,
             null::text as excluded_reason
        from attributed a
        join appointment ap on ap.booking_id = a.booking_id
        join appointment_status_history h on h.appointment_id = ap.id
        join (select * from unnest(${sql.array(
          statusRows.map((row) => row.status),
        )}::text[], ${sql.array(
          statusRows.map((row) => row.stage as string),
        )}::text[]) as t(status, stage)) m
          on m.status = h.to_status::text
       group by a.session_id, m.stage
    ),
    /*
     * The exclusion. A no-show carries one on confirmed (A-FIRST-02): the booking was confirmed and
     * was neither attended nor paid, and the show-adjusted rate excludes it from BOTH sides. The
     * exclusion is written on the confirmed step rather than as a step of its own, because no_show is
     * not one of the eight stages and a ninth member would be a bucket no funnel draws.
     */
    excluded as (
      select a.session_id, ${input.confirmedStage} as step, m.reason
        from attributed a
        join appointment ap on ap.booking_id = a.booking_id
        join (select * from unnest(${sql.array(
          excludedRows.map((row) => row.status),
        )}::text[], ${sql.array(
          excludedRows.map((row) => row.excludedReason as string),
        )}::text[]) as t(status, reason)) m
          on m.status = ap.status::text
       group by a.session_id, m.reason
    ),
    -- paid: the LEDGER's fact. outstanding_fils <= 0 is the same quantity ZT001 refuses to let go
    -- negative, so this read and the till cannot disagree about whether a document is settled.
    paid as (
      select a.session_id, ${input.paidStage} as step, max(p.received_at) as occurred_at,
             null::text as excluded_reason
        from attributed a
        join appointment ap on ap.booking_id = a.booking_id
        join invoice_appointment ia on ia.appointment_id = ap.id
        join invoice i on i.id = ia.invoice_id
        join invoice_settlement st on st.invoice_id = i.id
        join payment p on p.invoice_id = i.id
       where st.outstanding_fils <= 0
       group by a.session_id
    ),
    steps as (
      select session_id, step, occurred_at, excluded_reason from created
      union all
      select session_id, step, occurred_at, excluded_reason from reached
      union all
      select session_id, step, occurred_at, excluded_reason from paid
    )
    insert into analytics.funnel_step (session_id, step, occurred_at, excluded_reason)
    select st.session_id,
           st.step::analytics.funnel_step_name,
           min(st.occurred_at),
           -- The exclusion is attached here rather than in a second UPDATE, so a step and its reason
           -- arrive in one row: a row written and then edited is two states a reader can catch between.
           max(ex.reason)
      from steps st
      left join excluded ex on ex.session_id = st.session_id and ex.step = st.step
     group by st.session_id, st.step
  `

  return {
    deleted: deleted.count ?? 0,
    collected: collected.count ?? 0,
    domain: domain.count ?? 0,
  }
}

/** One (stage, origination) group of the funnel, as the counting query returns it. */
export interface FunnelCountGroup {
  readonly stage: string
  readonly source: string
  readonly medium: string
  readonly campaign: string
  readonly entered: number
  readonly excluded: number
  readonly gapEntered: number
}

/**
 * The funnel's counts for one trading date, grouped by stage and origination.
 *
 * `includeBots` defaults to FALSE and the parameter is explicit, which is A-FIRST-04's deferral
 * discharged: *"excluding bot-flagged sessions from the funnel is deferred to A-FIRST-09"*. The two
 * answers differ by exactly the bot count, because the rows are the same rows and only the predicate
 * moves — which is the only arrangement in which that difference is a measurement rather than a claim.
 *
 * An origination a session has no `analytics.attribution` row for reads `unknown`/`unknown` rather than
 * being dropped. Dropping it would shrink every bucket by the sessions nobody resolved, and the funnel
 * would look cleaner as the attribution got worse.
 */
export async function funnelCountRows(
  sql: Sql,
  query: { readonly tradingDate: string; readonly includeBots?: boolean },
): Promise<readonly FunnelCountGroup[]> {
  assertTradingDate(query.tradingDate)
  const includeBots = query.includeBots === true
  const rows = await sql<
    {
      step: string
      source: string
      medium: string
      campaign: string
      entered: string
      excluded: string
      gap_entered: string
    }[]
  >`
    select f.step::text                                    as step,
           coalesce(a.source, 'unknown')                   as source,
           coalesce(a.medium, 'unknown')                   as medium,
           coalesce(a.campaign, '')                        as campaign,
           count(*)::text                                  as entered,
           count(f.excluded_reason)::text                  as excluded,
           count(*) filter (where s.trading_date_basis <> 'trading')::text as gap_entered
      from analytics.funnel_step f
      join analytics.session s on s.session_id = f.session_id
      left join analytics.attribution a on a.session_id = f.session_id
     where s.trading_date = ${query.tradingDate}::date
       and (${includeBots}::boolean or s.bot = false)
     group by f.step, a.source, a.medium, a.campaign
     order by f.step, a.source, a.medium, a.campaign
  `
  return rows.map((row) => ({
    stage: row.step,
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    entered: Number(row.entered),
    excluded: Number(row.excluded),
    gapEntered: Number(row.gap_entered),
  }))
}

export interface RollupInput {
  readonly tradingDate: string
  /** The pass's instant, injected. Written to `computed_at`, which is what makes a re-run byte-identical. */
  readonly computedAtIso: string
}

export interface RollupCounts {
  readonly traffic: number
  readonly funnel: number
  readonly revenue: number
}

/**
 * Recomputes all three rollups for one trading date.
 *
 * RECOMPUTE and not accumulate, in one transaction the caller owns: every row is derived from the raw
 * tables by a `group by` and upserted on its own primary key, so two runs produce byte-identical rows and
 * a corrected derivation converges. An accumulating rollup drifts, and a drifted rollup is a figure
 * nobody can audit — there is no second place to check it against.
 *
 * `delete` before `insert … on conflict` for the rows a recompute no longer produces: an origination tuple
 * that existed last night and does not tonight — a campaign renamed, a session re-attributed — would
 * otherwise sit in the table for ever at its old count, and nothing would ever contradict it.
 */
export async function rollUpTradingDate(sql: Sql, input: RollupInput): Promise<RollupCounts> {
  assertTradingDate(input.tradingDate)

  await sql`delete from analytics.daily_traffic where trading_date = ${input.tradingDate}::date`
  const traffic = await sql`
    insert into analytics.daily_traffic
      (trading_date, source, medium, campaign, device_kind, sessions, visitors, bot_sessions, events,
       gap_sessions, computed_at)
    select s.trading_date,
           coalesce(a.source, 'unknown'),
           coalesce(a.medium, 'unknown'),
           coalesce(a.campaign, ''),
           s.device_kind,
           count(distinct s.session_id),
           count(distinct s.visitor_id),
           count(distinct s.session_id) filter (where s.bot),
           coalesce(sum(e.events), 0),
           -- The gap cohort, read off the basis 0116 stored and ZY222 holds honest. Not re-resolved here:
           -- a third statement of "which trading date does this instant belong to" would disagree with
           -- the two the database already enforces.
           count(distinct s.session_id) filter (where s.trading_date_basis <> 'trading'),
           ${input.computedAtIso}::timestamptz
      from analytics.session s
      left join analytics.attribution a on a.session_id = s.session_id
      left join (
        select session_id, count(*) as events from analytics.event group by session_id
      ) e on e.session_id = s.session_id
     where s.trading_date = ${input.tradingDate}::date
     group by s.trading_date, a.source, a.medium, a.campaign, s.device_kind
  `

  await sql`delete from analytics.daily_funnel where trading_date = ${input.tradingDate}::date`
  const funnel = await sql`
    insert into analytics.daily_funnel
      (trading_date, step, source, medium, campaign, entered, excluded, gap_entered, computed_at)
    select s.trading_date,
           f.step,
           coalesce(a.source, 'unknown'),
           coalesce(a.medium, 'unknown'),
           coalesce(a.campaign, ''),
           count(*),
           count(f.excluded_reason),
           count(*) filter (where s.trading_date_basis <> 'trading'),
           ${input.computedAtIso}::timestamptz
      from analytics.funnel_step f
      join analytics.session s on s.session_id = f.session_id
      left join analytics.attribution a on a.session_id = f.session_id
     where s.trading_date = ${input.tradingDate}::date
       -- Bots excluded, which is what makes excluded <= entered hold: the bot count lives in
       -- daily_traffic.bot_sessions, 0096's own column for it, rather than being restated per step.
       and s.bot = false
     group by s.trading_date, f.step, a.source, a.medium, a.campaign
  `

  await sql`delete from analytics.daily_source_revenue where trading_date = ${input.tradingDate}::date`
  const revenue = await sql`
    insert into analytics.daily_source_revenue
      (trading_date, source, medium, campaign, paid_invoices, gross_fils, vat_fils, net_fils, computed_at)
    select d.trading_date,
           d.source,
           d.medium,
           d.campaign,
           count(*),
           sum(d.gross_total),
           sum(d.vat_total),
           sum(d.net_total),
           ${input.computedAtIso}::timestamptz
      from (
        /*
         * One row per PAID invoice, attributed through the booking its appointments belong to.
         *
         * The subquery exists so each invoice is counted ONCE whatever number of appointments it covers:
         * summing over the join would multiply a two-treatment document's takings by two, and the figure
         * would still satisfy every CHECK on the table.
         *
         * a.trading_date is the APPOINTMENT's materialised trading date, which carries a real foreign
         * key into business_day (0024) — so a 01:30 treatment is filed on the previous trading day and
         * no truncation of an instant gets that wrong.
         */
        select a.trading_date,
               i.id,
               coalesce(ba.source, 'unknown') as source,
               coalesce(ba.medium, 'unknown') as medium,
               coalesce(ba.campaign, '')      as campaign,
               i.gross_total,
               i.vat_total,
               i.net_total
          from invoice i
          join invoice_settlement st  on st.invoice_id = i.id
          join invoice_appointment ia on ia.invoice_id = i.id
          join appointment a          on a.id = ia.appointment_id
          left join booking_attribution ba on ba.booking_id = a.booking_id
         where a.trading_date = ${input.tradingDate}::date
           and st.outstanding_fils <= 0
         group by a.trading_date, i.id, ba.source, ba.medium, ba.campaign,
                  i.gross_total, i.vat_total, i.net_total
      ) d
     group by d.trading_date, d.source, d.medium, d.campaign
  `

  return {
    traffic: traffic.count ?? 0,
    funnel: funnel.count ?? 0,
    revenue: revenue.count ?? 0,
  }
}

/**
 * Deletes expired WhatsApp ref codes that nothing claimed — the purge A-FIRST-07 handed this unit.
 *
 * The predicate is the expiry alone, and "nothing references it" is NOT a second clause: 0079's
 * `booking_whatsapp_ref_capture.ref_code` is `ON DELETE RESTRICT`, so a code a booking claimed cannot be
 * deleted whatever this statement asks for. A `not exists` subquery beside it would be a second statement
 * of a rule the schema already holds, and the one that drifts.
 *
 * Rows the foreign key protects are therefore SKIPPED rather than refused, by deleting only the
 * unreferenced ones — the count returned is what actually went, which is what the log line needs to mean
 * something.
 */
export async function purgeExpiredRefCodes(
  sql: Sql,
  input: { readonly asOfIso: string },
): Promise<number> {
  const deleted = await sql`
    delete from whatsapp_ref r
     where r.expires_at < ${input.asOfIso}::timestamptz
       -- The one place the RESTRICT is anticipated rather than hit: a referenced code is left where it
       -- is, so one claimed code cannot abort the whole night's purge. The foreign key remains the
       -- authority — this clause only keeps the pass from asking it a question it would refuse.
       and not exists (
         select 1 from booking_whatsapp_ref_capture c where c.ref_code = r.ref_code
       )
  `
  return deleted.count ?? 0
}

/**
 * The PAID conversions this business recorded on one trading date — the internal side A-MEAS-07's
 * reconciliation was given as an injected resolver.
 *
 * ADR 0093: *"Internal paid conversions from the rollups is A-FIRST-09's materialisation and it is not
 * built, so the pass runs, finds no internal side, writes NOTHING and says so in its log line."* This is
 * that materialisation, read at the grain the comparison needs — one row per settled document, with the
 * aggregate kind and id the event id is derived from and the gross the platform was told.
 *
 * The event id is NOT derived here. It is a digest over the aggregate kind, the aggregate id and the
 * funnel stage computed by `analyticsEventId` in `@berelax/analytics`, which `packages/db` may not import;
 * the worker maps these rows through it, exactly as the enqueuer does, so the two sides of the
 * reconciliation cannot be two different digests.
 */
export interface InternalPaidConversion {
  readonly aggregate: 'invoice'
  readonly aggregateId: string
  readonly grossFils: number
}

export async function internalPaidConversions(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<readonly InternalPaidConversion[]> {
  assertTradingDate(query.tradingDate)
  const rows = await sql<{ invoice_id: string; gross_total: string }[]>`
    select i.id::text as invoice_id, i.gross_total::text as gross_total
      from invoice i
      join invoice_settlement st  on st.invoice_id = i.id
      join invoice_appointment ia on ia.invoice_id = i.id
      join appointment a          on a.id = ia.appointment_id
     where a.trading_date = ${query.tradingDate}::date
       and st.outstanding_fils <= 0
     group by i.id, i.gross_total
     order by i.id
  `
  return rows.map((row) => ({
    aggregate: 'invoice' as const,
    aggregateId: row.invoice_id,
    grossFils: Number(row.gross_total),
  }))
}

/**
 * The rollup rows for one trading date, as three byte-comparable digests.
 *
 * `md5(row::text)` over the WHOLE row, aggregated in row order, which is what "two runs produce
 * byte-identical rows" is asserted on. Comparing counts instead would pass for a recompute that changed
 * every figure and kept the shape, which is the defect an idempotence claim is about.
 */
export async function rollupDigest(
  sql: Sql,
  query: { readonly tradingDate: string },
): Promise<Readonly<Record<'traffic' | 'funnel' | 'revenue', string>>> {
  assertTradingDate(query.tradingDate)
  const digest = async (relation: 'daily_traffic' | 'daily_funnel' | 'daily_source_revenue') => {
    // `sql.unsafe` with a relation name this function chose from a closed union, never from a caller:
    // the three names are literals in this file's own type and a dynamic relation cannot be passed in.
    const [row] = (await sql.unsafe(
      `select coalesce(md5(string_agg(r.line, '|' order by r.line)), '') as d
         from (select ${relation}::text as line from analytics.${relation}
                where trading_date = $1::date) r`,
      [query.tradingDate],
    )) as unknown as { d: string }[]
    return row?.d ?? ''
  }
  return {
    traffic: await digest('daily_traffic'),
    funnel: await digest('daily_funnel'),
    revenue: await digest('daily_source_revenue'),
  }
}

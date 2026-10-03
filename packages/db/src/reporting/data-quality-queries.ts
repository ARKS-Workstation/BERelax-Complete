import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The readings R-REP-07's data-quality gate judges, and the drill-downs behind them.
 *
 * Every check is TWO figures and a predicate. This module produces the figures and the row counts;
 * `packages/core/src/reporting/data-quality.ts` decides what they mean. The split is ADR 0001's — `db`
 * may not import `core` — and it is also the only arrangement in which the judgement is testable without
 * a database: the gate is handed readings, so a test can hand it readings that disagree.
 *
 * ## Why `observed: null` is a state and not an error
 *
 * Three of the seven checks are STORED: their evidence is a row written by a pass. A window no pass has
 * covered therefore has nothing to compare, and the honest answer is "nothing has run" rather than
 * "the two sides agreed". That is the acceptance line about a check reading `unknown` and never `pass`,
 * and it is `null` here rather than `{ left: 0, right: 0 }` because those two are the same pair of
 * numbers and different claims — the distinction ADR 0070 is about, one subject along.
 *
 * The other four are LIVE: they are a query over rows that exist whether or not anything has run, so
 * they always have a reading, and the reading is as of the instant the caller passes in.
 *
 * ## The ids are a second statement of `core`'s and arrive with the check that holds them equal
 *
 * {@link DATA_QUALITY_CHECK_IDS} is spelled here as well as in `core`, because this package may not
 * import that one. `packages/fixtures/src/data-quality.itest.ts` asserts the two arrays are equal as
 * SEQUENCES and annotates this module's answer with `core`'s type, so an id renamed on either side is a
 * failing test and a `pnpm typecheck` failure rather than a reading nothing judges.
 *
 * ## Windows are business days, never instants
 *
 * Every figure here is bounded on a trading date — `fact_sale.business_day`, `appointment.trading_date`,
 * `journal_entry.entry_date`, `analytics.session.trading_date`. Trading runs 11:00–02:00, so a window
 * taken on an instant would move a 01:30 sale into the next day on one side of a comparison and not the
 * other, and the resulting variance would be a reconciliation failure the business did not have.
 */

/** The checks this module produces readings for, in `core`'s declaration order. */
export const DATA_QUALITY_CHECK_IDS = [
  'ledger_vs_facts',
  'rollup_vs_raw',
  'attribution_coverage',
  'ref_capture',
  'bot_share',
  'dispatch_reconciliation',
  'view_freshness',
] as const

export type DataQualityCheckId = (typeof DATA_QUALITY_CHECK_IDS)[number]

/** One side of one check: what it is, and the integer figure it came to. */
export interface DataQualitySideRow {
  readonly label: string
  readonly value: bigint
}

/** One check's reading. `observed` is `null` for a check whose evidence no pass has produced. */
export interface DataQualityReadingRow {
  readonly checkId: DataQualityCheckId
  readonly lastRanAtIso: string | null
  readonly observed: {
    readonly left: DataQualitySideRow
    readonly right: DataQualitySideRow
    readonly offendingRows: number
  } | null
}

export type DataQualityReadingSet = Readonly<Record<DataQualityCheckId, DataQualityReadingRow>>

/** A window of trading dates, inclusive at both ends. */
export interface DataQualityWindow {
  readonly fromInclusive: string
  readonly toInclusive: string
}

export interface DataQualityArgs {
  readonly window: DataQualityWindow
  /** The instant staleness and expiry are measured against. Never a clock read in here. */
  readonly asOfIso: string
  /**
   * The staleness window, in minutes, from `core`'s `STALE_VIEW_AFTER_MINUTES`.
   *
   * An argument and not a constant: the figure belongs to R-REP-07's acceptance line and this build
   * states it once, in `core`, where the gate that reads it lives. A copy here would be a second answer
   * to "when is a view stale", and the symptom of that is a screen whose amber row disagrees with the
   * tile beside it.
   */
  readonly staleAfterMinutes: number
  /**
   * The revenue account codes, from `STANDARD_SPA_CHART`.
   *
   * Passed in because the chart lives in `core` (ADR 0001). An EMPTY list is refused rather than
   * matching nothing: an empty `= any(...)` agrees with any figure at all, which is exactly how a
   * reconciliation check comes to pass for ever.
   */
  readonly revenueAccountCodes: readonly string[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertArgs(args: DataQualityArgs): void {
  if (!ISO_DATE.test(args.window.fromInclusive) || !ISO_DATE.test(args.window.toInclusive)) {
    throw new AppError(
      'validation',
      `A data-quality window is two trading dates as YYYY-MM-DD; got "${args.window.fromInclusive}" ` +
        `to "${args.window.toInclusive}".`,
    )
  }
  if (args.window.toInclusive < args.window.fromInclusive) {
    throw new AppError(
      'validation',
      `The data-quality window ends (${args.window.toInclusive}) before it starts ` +
        `(${args.window.fromInclusive}), so every count over it would be zero and every check would ` +
        'hold.',
    )
  }
  if (Number.isNaN(Date.parse(args.asOfIso))) {
    throw new AppError('validation', `asOfIso "${args.asOfIso}" is not an instant.`)
  }
  if (!Number.isInteger(args.staleAfterMinutes) || args.staleAfterMinutes <= 0) {
    throw new AppError(
      'validation',
      `staleAfterMinutes must be a positive whole number of minutes; got ${args.staleAfterMinutes}. ` +
        'A zero window calls every view stale and a negative one calls none of them stale.',
    )
  }
  if (args.revenueAccountCodes.length === 0) {
    throw new AppError(
      'validation',
      'The ledger-versus-facts check needs at least one revenue account code. An empty set matches no ' +
        'account, so the journal side would be zero and the check would agree with any facts at all.',
    )
  }
}

const side = (label: string, value: string | number | null): DataQualitySideRow => ({
  label,
  value: BigInt(value ?? 0),
})

/**
 * Every reading, in one round of queries.
 *
 * Seven statements and not one, because each check compares two different relations and a single query
 * would be a seven-way join whose zero rows nobody could attribute. They are issued together so the
 * readings are as close to one instant as the database can make them.
 */
export async function dataQualityReadings(
  sql: Sql,
  args: DataQualityArgs,
): Promise<DataQualityReadingSet> {
  assertArgs(args)
  const { fromInclusive: from, toInclusive: to } = args.window

  const [ledger] = await sql<
    {
      factsNetFils: string
      journalNetFils: string
      offendingDays: string
      lastRanAt: string | null
    }[]
  >`
    with facts as (
      select coalesce(sum(net_fils), 0)::text as net
        from reporting.fact_sale
       where business_day between ${from}::date and ${to}::date
    ),
    journal as (
      -- credit less debit on the revenue accounts: revenue is a credit, and a magnitude would make a
      -- discount posted to 4095 indistinguishable from more revenue.
      select coalesce(sum(l.credit_fils - l.debit_fils), 0)::text as net
        from journal_line l
        join journal_entry e on e.entry_id = l.entry_id
       where e.entry_date between ${from}::date and ${to}::date
         and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
    ),
    per_day as (
      select d.business_day,
             coalesce(f.net, 0) as facts_net,
             coalesce(j.net, 0) as journal_net
        from (
          select business_day from reporting.fact_sale
           where business_day between ${from}::date and ${to}::date
          union
          select e.entry_date from journal_entry e
            join journal_line l on l.entry_id = e.entry_id
           where e.entry_date between ${from}::date and ${to}::date
             and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
        ) d (business_day)
        left join (
          select business_day, sum(net_fils) as net
            from reporting.fact_sale
           where business_day between ${from}::date and ${to}::date
           group by business_day
        ) f on f.business_day = d.business_day
        left join (
          select e.entry_date, sum(l.credit_fils - l.debit_fils) as net
            from journal_line l
            join journal_entry e on e.entry_id = l.entry_id
           where e.entry_date between ${from}::date and ${to}::date
             and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
           group by e.entry_date
        ) j on j.entry_date = d.business_day
    ),
    freshness as (
      select max(finished_at) as finished_at
        from reporting.refresh_run
       where view_name = 'fact_sale'
    )
    select (select net from facts)                                        as "factsNetFils",
           (select net from journal)                                     as "journalNetFils",
           (select count(*)::text from per_day
             where facts_net <> journal_net)                              as "offendingDays",
           (select to_char(finished_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from freshness) as "lastRanAt"
  `

  const [rollup] = await sql<
    { factRows: string; sourceRows: string; offendingViews: string; lastRanAt: string | null }[]
  >`
    with fact_counts as (
      select
        (select count(*) from reporting.fact_appointment
          where business_day between ${from}::date and ${to}::date) as appointments,
        (select count(*) from reporting.fact_sale
          where business_day between ${from}::date and ${to}::date) as sales,
        (select count(*) from reporting.fact_shift
          where business_day between ${from}::date and ${to}::date) as shifts
    ),
    source_counts as (
      select
        (select count(*) from appointment
          where trading_date between ${from}::date and ${to}::date) as appointments,
        (select count(*) from (
           select tax_point_date from invoice
            where tax_point_date between ${from}::date and ${to}::date
           union all
           select tax_point_date from credit_note
            where tax_point_date between ${from}::date and ${to}::date
         ) d) as sales,
        (select count(*) from shift_assignment sa
           join shift sh on sh.id = sa.shift_id
          where sh.trading_date between ${from}::date and ${to}::date) as shifts
    ),
    freshness as (
      select min(last_finished) as finished_at, count(*) filter (where last_finished is null) as never
        from (
          select m.view_name, max(r.finished_at) as last_finished
            from reporting.materialised_view m
            left join reporting.refresh_run r on r.view_name = m.view_name
           where m.kind = 'fact'
           group by m.view_name
        ) v
    )
    select (select (appointments + sales + shifts)::text from fact_counts)     as "factRows",
           (select (appointments + sales + shifts)::text from source_counts)   as "sourceRows",
           (select (
              (case when f.appointments <> s.appointments then 1 else 0 end) +
              (case when f.sales        <> s.sales        then 1 else 0 end) +
              (case when f.shifts       <> s.shifts       then 1 else 0 end)
            )::text from fact_counts f, source_counts s)                       as "offendingViews",
           (select case when never > 0 then null
                        else to_char(finished_at at time zone 'UTC',
                                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
              from freshness)                                                  as "lastRanAt"
  `

  const [attribution] = await sql<{ unattributed: string; bookings: string }[]>`
    with scoped as (
      select distinct a.booking_id
        from appointment a
       where a.trading_date between ${from}::date and ${to}::date
    )
    select (select count(*)::text from scoped s
             where not exists (select 1 from booking_attribution b
                                where b.booking_id = s.booking_id))  as "unattributed",
           (select count(*)::text from scoped)                       as bookings
  `

  const [refs] = await sql<{ unresolved: string; issued: string }[]>`
    with scoped as (
      select r.ref_code, r.expires_at
        from whatsapp_ref r
       where (r.issued_at at time zone 'Asia/Dubai')::date
               between ${from}::date and ${to}::date
    )
    select (select count(*)::text from scoped s
             where s.expires_at > ${args.asOfIso}::timestamptz
               and not exists (select 1 from booking_whatsapp_ref_capture c
                                where c.ref_code = s.ref_code))      as unresolved,
           (select count(*)::text from scoped)                       as issued
  `

  const [bots] = await sql<{ unexplained: string; sessions: string }[]>`
    select count(*) filter (where bot and bot_kind is null)::text as unexplained,
           count(*)::text                                          as sessions
      from analytics.session
     where trading_date between ${from}::date and ${to}::date
  `

  const [dispatch] = await sql<
    { unreconciled: string; passes: string; lastRanAt: string | null }[]
  >`
    select count(*) filter (where state = 'unreconciled')::text        as unreconciled,
           count(*)::text                                              as passes,
           to_char(max(ran_at) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')                    as "lastRanAt"
      from analytics_dispatch_reconciliation
     where business_day between ${from}::date and ${to}::date
  `

  const [views] = await sql<
    { oldestMinutes: string; staleViews: string; lastRanAt: string | null }[]
  >`
    with ages as (
      select m.view_name,
             -- A view that has never been refreshed is aged from the instant it was REGISTERED, which is
             -- a real instant in the database rather than a figure this module invented. "Registered 40
             -- days ago and never refreshed" is the finding; a null would have been a blank row.
             greatest(
               0,
               (extract(epoch from (${args.asOfIso}::timestamptz
                                    - coalesce(max(r.finished_at), m.created_at))) / 60)::bigint
             ) as age_minutes
        from reporting.materialised_view m
        left join reporting.refresh_run r on r.view_name = m.view_name
       group by m.view_name, m.created_at
    )
    select coalesce(max(age_minutes), 0)::text                                    as "oldestMinutes",
           count(*) filter (where age_minutes > ${args.staleAfterMinutes})::text   as "staleViews",
           (select to_char(max(finished_at) at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              from reporting.refresh_run)                                          as "lastRanAt"
      from ages
  `

  if (
    ledger === undefined ||
    rollup === undefined ||
    attribution === undefined ||
    refs === undefined ||
    bots === undefined ||
    dispatch === undefined ||
    views === undefined
  ) {
    throw new AppError(
      'invariant_violated',
      'A data-quality reading query returned no row. Every one of them is an aggregate over a window, ' +
        'so each returns exactly one row or the database answered something this module cannot read — ' +
        'and an absent reading must not be mistaken for a check that passed.',
    )
  }

  return Object.freeze({
    ledger_vs_facts: {
      checkId: 'ledger_vs_facts',
      lastRanAtIso: ledger.lastRanAt,
      // Stored: the facts are a materialised view, so a window the refresh has never covered has
      // nothing to compare. `reporting.refresh_run` is the evidence and it is append-only (ZY184).
      observed:
        ledger.lastRanAt === null
          ? null
          : {
              left: side('the sale facts’ net revenue', ledger.factsNetFils),
              right: side('the journal’s revenue movement', ledger.journalNetFils),
              offendingRows: Number(ledger.offendingDays),
            },
    },
    rollup_vs_raw: {
      checkId: 'rollup_vs_raw',
      lastRanAtIso: rollup.lastRanAt,
      observed:
        rollup.lastRanAt === null
          ? null
          : {
              left: side('rows in the three facts', rollup.factRows),
              right: side('rows their definitions select', rollup.sourceRows),
              offendingRows: Number(rollup.offendingViews),
            },
    },
    attribution_coverage: {
      checkId: 'attribution_coverage',
      // Live: `booking_attribution` is written when the booking is taken, so there is always a reading.
      lastRanAtIso: args.asOfIso,
      observed: {
        left: side('bookings carrying no attribution row', attribution.unattributed),
        right: side('the census this must equal', 0),
        offendingRows: Number(attribution.unattributed),
      },
    },
    ref_capture: {
      checkId: 'ref_capture',
      lastRanAtIso: args.asOfIso,
      observed: {
        left: side('live refs neither captured nor expired', refs.unresolved),
        right: side('the census this must equal', 0),
        offendingRows: Number(refs.unresolved),
      },
    },
    bot_share: {
      checkId: 'bot_share',
      lastRanAtIso: args.asOfIso,
      observed: {
        left: side('sessions marked as a bot with no kind', bots.unexplained),
        right: side('the census this must equal', 0),
        offendingRows: Number(bots.unexplained),
      },
    },
    dispatch_reconciliation: {
      checkId: 'dispatch_reconciliation',
      lastRanAtIso: dispatch.lastRanAt,
      // Stored: the reconciliation is a nightly pass and its answer is a row. A window it has never
      // covered reads unknown, which is the whole of "never run is not pass".
      observed:
        dispatch.lastRanAt === null
          ? null
          : {
              left: side('destination-days the pass called unreconciled', dispatch.unreconciled),
              right: side('the census this must equal', 0),
              offendingRows: Number(dispatch.unreconciled),
            },
    },
    view_freshness: {
      checkId: 'view_freshness',
      lastRanAtIso: views.lastRanAt,
      // Live, and deliberately so: the age of the oldest view is a figure the database always has, and
      // a view that has never been refreshed is STALE rather than unknown — "nobody refreshed it" is a
      // finding about the view, not an absence of evidence about it.
      observed: {
        left: side('the oldest view’s age in minutes', views.oldestMinutes),
        right: side('the staleness window', args.staleAfterMinutes),
        offendingRows: Number(views.staleViews),
      },
    },
  })
}

// --- the drill-downs ------------------------------------------------------------------------------

/** One offending row, flattened to the three things a screen prints. */
export interface DataQualityDrillDownRow {
  /** What the row IS: a date, a view name, a booking id, a ref code, a destination. */
  readonly subject: string
  /** The figure that makes it offending, as a decimal string in the check's own measure. */
  readonly figure: string
  /** Why it is listed, in a clause. */
  readonly detail: string
}

/**
 * The rows behind one failing check.
 *
 * The rows, not a total, for `statementDrillDown`'s reason: a drill-down that returned a sum would be a
 * third aggregate to reconcile. `order by` is fully determined in every branch, so two runs return the
 * same rows in the same order and a rendered drill-down has stable bytes.
 *
 * `limit` is a page and not a cap on the claim: the check's own `offendingRows` is the count, taken in
 * SQL, and a reader who sees "12 of 400" has been told the truth. Counting the rows this function
 * returns would be the capped-reader defect the brief records about `settingHistory`.
 */
export async function dataQualityDrillDown(
  sql: Sql,
  args: DataQualityArgs & { readonly checkId: DataQualityCheckId; readonly limit?: number },
): Promise<readonly DataQualityDrillDownRow[]> {
  assertArgs(args)
  const limit = args.limit ?? 50
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new AppError('validation', `A drill-down page must be a positive integer; got ${limit}.`)
  }
  const { fromInclusive: from, toInclusive: to } = args.window

  switch (args.checkId) {
    case 'ledger_vs_facts':
      return sql<DataQualityDrillDownRow[]>`
        with per_day as (
          select d.business_day,
                 coalesce(f.net, 0) as facts_net,
                 coalesce(j.net, 0) as journal_net
            from (
              select business_day from reporting.fact_sale
               where business_day between ${from}::date and ${to}::date
              union
              select e.entry_date from journal_entry e
                join journal_line l on l.entry_id = e.entry_id
               where e.entry_date between ${from}::date and ${to}::date
                 and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
            ) d (business_day)
            left join (
              select business_day, sum(net_fils) as net from reporting.fact_sale
               where business_day between ${from}::date and ${to}::date group by business_day
            ) f on f.business_day = d.business_day
            left join (
              select e.entry_date, sum(l.credit_fils - l.debit_fils) as net
                from journal_line l join journal_entry e on e.entry_id = l.entry_id
               where e.entry_date between ${from}::date and ${to}::date
                 and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
               group by e.entry_date
            ) j on j.entry_date = d.business_day
        )
        select business_day::text                           as subject,
               (facts_net - journal_net)::text              as figure,
               'facts ' || facts_net::text || ' fils against journal ' || journal_net::text ||
                 ' fils'                                     as detail
          from per_day
         where facts_net <> journal_net
         order by business_day
         limit ${limit}
      `
    case 'rollup_vs_raw':
      return sql<DataQualityDrillDownRow[]>`
        with counted as (
          select 'fact_appointment' as view_name,
                 (select count(*) from reporting.fact_appointment
                   where business_day between ${from}::date and ${to}::date) as fact_rows,
                 (select count(*) from appointment
                   where trading_date between ${from}::date and ${to}::date) as source_rows
          union all
          select 'fact_sale',
                 (select count(*) from reporting.fact_sale
                   where business_day between ${from}::date and ${to}::date),
                 (select count(*) from (
                    select tax_point_date from invoice
                     where tax_point_date between ${from}::date and ${to}::date
                    union all
                    select tax_point_date from credit_note
                     where tax_point_date between ${from}::date and ${to}::date
                  ) d)
          union all
          select 'fact_shift',
                 (select count(*) from reporting.fact_shift
                   where business_day between ${from}::date and ${to}::date),
                 (select count(*) from shift_assignment sa
                    join shift sh on sh.id = sa.shift_id
                   where sh.trading_date between ${from}::date and ${to}::date)
        )
        select view_name                                    as subject,
               (fact_rows - source_rows)::text              as figure,
               'the view holds ' || fact_rows::text || ' row(s) and its definition selects ' ||
                 source_rows::text                           as detail
          from counted
         where fact_rows <> source_rows
         order by view_name
         limit ${limit}
      `
    case 'attribution_coverage':
      return sql<DataQualityDrillDownRow[]>`
        select distinct on (a.booking_id)
               a.booking_id::text                           as subject,
               '1'                                           as figure,
               'booked for ' || a.trading_date::text || ' with no booking_attribution row' as detail
          from appointment a
         where a.trading_date between ${from}::date and ${to}::date
           and not exists (select 1 from booking_attribution b where b.booking_id = a.booking_id)
         order by a.booking_id
         limit ${limit}
      `
    case 'ref_capture':
      return sql<DataQualityDrillDownRow[]>`
        select r.ref_code                                    as subject,
               '1'                                           as figure,
               'issued ' || r.issued_at::text || ', live until ' || r.expires_at::text ||
                 ', never captured against a booking'         as detail
          from whatsapp_ref r
         where (r.issued_at at time zone 'Asia/Dubai')::date between ${from}::date and ${to}::date
           and r.expires_at > ${args.asOfIso}::timestamptz
           and not exists (select 1 from booking_whatsapp_ref_capture c where c.ref_code = r.ref_code)
         order by r.ref_code
         limit ${limit}
      `
    case 'bot_share':
      return sql<DataQualityDrillDownRow[]>`
        select s.session_id::text                            as subject,
               '1'                                           as figure,
               'marked as a bot on ' || s.trading_date::text || ' with no bot_kind' as detail
          from analytics.session s
         where s.trading_date between ${from}::date and ${to}::date
           and s.bot and s.bot_kind is null
         order by s.session_id
         limit ${limit}
      `
    case 'dispatch_reconciliation':
      return sql<DataQualityDrillDownRow[]>`
        select r.business_day::text || ' ' || r.destination   as subject,
               r.difference_fils::text                       as figure,
               'missing ' || r.missing_count::text || ', duplicate ' || r.duplicate_count::text ||
                 ', intentionally not pushed ' || r.intentionally_not_pushed_count::text as detail
          from analytics_dispatch_reconciliation r
         where r.business_day between ${from}::date and ${to}::date
           and r.state = 'unreconciled'
         order by r.business_day, r.destination
         limit ${limit}
      `
    case 'view_freshness':
      return sql<DataQualityDrillDownRow[]>`
        select m.view_name                                   as subject,
               greatest(
                 0,
                 (extract(epoch from (${args.asOfIso}::timestamptz
                                      - coalesce(max(r.finished_at), m.created_at))) / 60)::bigint
               )::text                                       as figure,
               coalesce(
                 'last refreshed ' || max(r.finished_at)::text,
                 'never refreshed; registered ' || m.created_at::text
               )                                             as detail
          from reporting.materialised_view m
          left join reporting.refresh_run r on r.view_name = m.view_name
         group by m.view_name, m.created_at
        having greatest(
                 0,
                 (extract(epoch from (${args.asOfIso}::timestamptz
                                      - coalesce(max(r.finished_at), m.created_at))) / 60)::bigint
               ) > ${args.staleAfterMinutes}
         order by m.view_name
         limit ${limit}
      `
  }
}

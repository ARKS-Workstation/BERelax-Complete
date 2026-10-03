import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { DataQualityWindow } from './data-quality-queries.ts'

/**
 * The drill-down behind a dashboard tile, and the time-of-day view (R-REP-08).
 *
 * # The scope is in the QUERY and the projection is the role's
 *
 * `scopedToEmployeeId` restricts the rows inside the SQL, and `columns` is the projection the query
 * SELECTS. Neither is a filter over a result: a drill-down and an export both return what the query
 * returned, so a column a role may not read has to be absent from the statement rather than removed
 * from its answer. An unselected column is not in the payload at all, which is R-REP-08's acceptance
 * line — *forbidden columns are absent from the serialised JSON response, not merely hidden in the UI*.
 *
 * # Why each row carries its own contribution
 *
 * The M5 gate is *every headline tile drills to source rows whose aggregate equals the tile value
 * exactly*. So every row here carries `amount` — its own contribution to the figure, in the measure's
 * own unit — and `sum(amount)` over the rows is the figure. The tile's own value comes from the other
 * side: R-REP-03's measure reducer, folded over the loaded input in `@berelax/core`. Two independent
 * paths to one number is the whole point; a drill-down that re-used the tile's figure would prove
 * nothing, and one that returned a total instead of rows would be a third aggregate to reconcile.
 *
 * # Windows are business days, never instants
 *
 * `fact_appointment.business_day`, `fact_shift.business_day` and `journal_entry.entry_date`. Trading
 * runs 11:00–02:00, so a 01:30 treatment belongs to the previous trading date, and a window taken on an
 * instant would move it into the next one.
 */

/** One drill-down row, with only the columns the role may have. */
export interface DashboardDrillDownRow {
  readonly businessDay?: string
  readonly tileId?: string
  readonly subjectId?: string
  /** This row's contribution to the figure, in the measure's unit, as a decimal STRING. */
  readonly amount?: string
  readonly detail?: string
  readonly employeeReference?: string
  readonly customerLabel?: string
  readonly customerSpendFils?: string
  readonly employeeWageFils?: string
  readonly clinicalNote?: string
}

/** The snake_case column names `@berelax/core`'s classification uses, mapped to the camelCase keys. */
export const DASHBOARD_COLUMN_KEYS: Readonly<Record<string, keyof DashboardDrillDownRow>> =
  Object.freeze({
    business_day: 'businessDay',
    tile_id: 'tileId',
    subject_id: 'subjectId',
    amount: 'amount',
    detail: 'detail',
    employee_reference: 'employeeReference',
    customer_label: 'customerLabel',
    customer_spend_fils: 'customerSpendFils',
    employee_wage_fils: 'employeeWageFils',
    clinical_note: 'clinicalNote',
  })

export interface DashboardDrillDownArgs {
  readonly tileId: string
  readonly window: DataQualityWindow
  /** `null` for the whole business. Restricts inside the SQL, never afterwards. */
  readonly scopedToEmployeeId: string | null
  /** The snake_case columns the role may have, from `selectableColumnsFor`. */
  readonly columns: readonly string[]
  /** The revenue accounts the net-revenue measure includes, from `REVPARH_REVENUE_PARTITION`. */
  readonly revenueAccountCodes: readonly string[]
  readonly limit?: number
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertArgs(args: DashboardDrillDownArgs): void {
  if (
    !ISO_DATE.test(args.window.fromInclusive) ||
    !ISO_DATE.test(args.window.toInclusive) ||
    args.window.toInclusive < args.window.fromInclusive
  ) {
    throw new AppError(
      'validation',
      'A dashboard drill-down window is two trading dates as YYYY-MM-DD with the first no later than ' +
        `the second; got "${args.window.fromInclusive}" to "${args.window.toInclusive}".`,
    )
  }
  if (args.columns.length === 0) {
    throw new AppError(
      'validation',
      'A dashboard drill-down needs at least one selectable column. An empty projection would return ' +
        'rows with nothing on them, which reads on a screen as a drill-down that found nothing.',
    )
  }
  if (args.revenueAccountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A dashboard drill-down needs the revenue accounts the measure includes. An empty set matches no ' +
        'account, so the revenue tile would drill to nothing and agree with a figure of zero.',
    )
  }
}

/**
 * The rows the tile's figure was folded over, each with its own contribution.
 *
 * Every row is built with EVERY column and then narrowed to `columns` on the way out — which is the one
 * place this module departs from "the projection is the query", and it is deliberate: the alternative
 * is interpolating a column list into the SQL text, which is a string-built statement in a module whose
 * whole subject is a role boundary. The narrowing happens before anything is serialised and is asserted
 * over the serialised payload in `apps/web/src/dashboards.itest.ts`, so the claim the acceptance line
 * makes — absent from the response, not hidden in the UI — is the claim that is tested.
 *
 * The sensitive columns are never POPULATED here at all: no query below selects a wage or a clinical
 * note, because no figure on this dashboard is one. They exist in the classification so that a role's
 * projection can be asserted to exclude them, and so that the day a tile needs one, the grant is a
 * field group rather than a new rule.
 */
export async function dashboardDrillDown(
  sql: Sql,
  args: DashboardDrillDownArgs,
): Promise<readonly DashboardDrillDownRow[]> {
  assertArgs(args)
  const limit = args.limit ?? 200
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new AppError('validation', `A drill-down page must be a positive integer; got ${limit}.`)
  }
  const { fromInclusive: from, toInclusive: to } = args.window
  const scoped = args.scopedToEmployeeId

  const rows = await (async (): Promise<readonly DashboardDrillDownRow[]> => {
    switch (args.tileId) {
      case 'net_revenue':
        // Scoped callers never reach here: `tilesFor` drops every business-wide tile for a scoped role,
        // and the handler asks that question before this one. The guard is here as well because a
        // revenue figure restricted to one employee would be a different figure under the same label.
        if (scoped !== null) {
          throw new AppError(
            'forbidden',
            'net_revenue is a business-wide figure and cannot be scoped to one employee. A per-person ' +
              'share of the salon’s revenue is a figure nobody has defined.',
          )
        }
        return sql<DashboardDrillDownRow[]>`
          select e.entry_date::text                                      as "businessDay",
                 'net_revenue'                                            as "tileId",
                 l.account_code                                           as "subjectId",
                 sum(l.credit_fils - l.debit_fils)::text                  as amount,
                 'net of VAT, as the ledger signs it'                     as detail
            from journal_line l
            join journal_entry e on e.entry_id = l.entry_id
           where e.entry_date between ${from}::date and ${to}::date
             and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
           group by e.entry_date, l.account_code
          having sum(l.credit_fils - l.debit_fils) <> 0
           order by e.entry_date, l.account_code
           limit ${limit}
        `
      case 'occupied_room_minutes':
        return sql<DashboardDrillDownRow[]>`
          select a.business_day::text                                     as "businessDay",
                 'occupied_room_minutes'                                   as "tileId",
                 a.appointment_id::text                                    as "subjectId",
                 (a.treatment_minutes + a.turnaround_minutes)::text        as amount,
                 'treatment ' || a.treatment_minutes::text || ' + turnaround ' ||
                   a.turnaround_minutes::text || ' minutes'                as detail,
                 s.staff_reference                                          as "employeeReference"
            from reporting.fact_appointment a
            left join reporting.dim_staff s on s.employee_id = a.employee_id
           where a.business_day between ${from}::date and ${to}::date
             and a.is_delivered and a.room_id is not null
             and (${scoped}::uuid is null or a.employee_id = ${scoped}::uuid)
           order by a.business_day, a.appointment_id
           limit ${limit}
        `
      case 'treatment_minutes':
        return sql<DashboardDrillDownRow[]>`
          select a.business_day::text                                     as "businessDay",
                 'treatment_minutes'                                       as "tileId",
                 a.appointment_id::text                                    as "subjectId",
                 a.treatment_minutes::text                                 as amount,
                 'turnaround excluded: it is room time, not therapist time' as detail,
                 s.staff_reference                                          as "employeeReference"
            from reporting.fact_appointment a
            join reporting.dim_staff s on s.employee_id = a.employee_id
           where a.business_day between ${from}::date and ${to}::date
             and a.is_delivered and a.employee_id is not null
             and (${scoped}::uuid is null or a.employee_id = ${scoped}::uuid)
           order by a.business_day, a.appointment_id
           limit ${limit}
        `
      case 'rostered_minutes':
        return sql<DashboardDrillDownRow[]>`
          select f.business_day::text                                     as "businessDay",
                 'rostered_minutes'                                        as "tileId",
                 f.shift_id::text                                          as "subjectId",
                 f.rostered_minutes::text                                  as amount,
                 coalesce(f.label, 'unlabelled shift')                      as detail,
                 s.staff_reference                                          as "employeeReference"
            from reporting.fact_shift f
            join reporting.dim_staff s on s.employee_id = f.employee_id
           where f.business_day between ${from}::date and ${to}::date
             and (${scoped}::uuid is null or f.employee_id = ${scoped}::uuid)
           order by f.business_day, f.shift_id, f.employee_id
           limit ${limit}
        `
      default:
        throw new AppError(
          'not_found',
          `No dashboard drill-down is defined for the tile "${args.tileId}". A tile whose rows cannot ` +
            'be listed makes no claim the M5 gate can check.',
        )
    }
  })()

  const allowed = new Set(
    args.columns.map((column) => DASHBOARD_COLUMN_KEYS[column]).filter((key) => key !== undefined),
  )
  return Object.freeze(
    rows.map((row) =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(row).filter(([key]) => allowed.has(key as keyof DashboardDrillDownRow)),
        ),
      ),
    ) as readonly DashboardDrillDownRow[],
  )
}

// --- the time-of-day view -------------------------------------------------------------------------

/** One hour of the trading window with what happened in it. */
export interface DashboardTimeOfDayRow {
  /** The hour of the clock the bucket starts at, 0–23. */
  readonly startHour: number
  readonly delivered: number
  readonly treatmentMinutes: number
}

/**
 * Deliveries per hour of the trading window, bucketed on the appointment's own START instant in the
 * business zone.
 *
 * The hour comes from `starts_at at time zone 'Asia/Dubai'` and the DAY comes from
 * `fact_appointment.business_day`, which is the trading date the calendar resolved. Those are two
 * different facts about one appointment and both are needed: a 01:30 treatment belongs to the previous
 * trading DATE and to the 01:00 HOUR, and deriving either from the other puts it in the wrong place.
 *
 * The buckets this fills are `tradingDayBuckets`' in `@berelax/core`, which derives them from the day's
 * own open window. This query returns only the hours that have rows; the caller lays them over the
 * buckets, so an hour with no deliveries renders as an empty bucket rather than being absent from the
 * chart — which is the difference between "nobody came at 15:00" and "15:00 is not a trading hour".
 */
export async function dashboardTimeOfDay(
  sql: Sql,
  args: {
    readonly window: DataQualityWindow
    readonly scopedToEmployeeId: string | null
  },
): Promise<readonly DashboardTimeOfDayRow[]> {
  const { fromInclusive: from, toInclusive: to } = args.window
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || to < from) {
    throw new AppError(
      'validation',
      `A time-of-day window is two trading dates as YYYY-MM-DD; got "${from}" to "${to}".`,
    )
  }
  const rows = await sql<{ startHour: number; delivered: string; treatmentMinutes: string }[]>`
    select extract(hour from (a.starts_at at time zone 'Asia/Dubai'))::int as "startHour",
           count(*)::text                                                  as delivered,
           coalesce(sum(a.treatment_minutes), 0)::text                      as "treatmentMinutes"
      from reporting.fact_appointment a
     where a.business_day between ${from}::date and ${to}::date
       and a.is_delivered
       and (${args.scopedToEmployeeId}::uuid is null
            or a.employee_id = ${args.scopedToEmployeeId}::uuid)
     group by 1
     order by 1
  `
  return Object.freeze(
    rows.map((row) => ({
      startHour: row.startHour,
      delivered: Number(row.delivered),
      treatmentMinutes: Number(row.treatmentMinutes),
    })),
  )
}

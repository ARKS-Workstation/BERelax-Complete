import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { DataQualityWindow } from './data-quality-queries.ts'

/**
 * The six datasets R-REP-03's KPI registry computes its utilisation and revenue figures from, loaded
 * out of the reporting schema (R-REP-07).
 *
 * # Why a loader exists at all, and why it covers SIX datasets and not eleven
 *
 * R-REP-03 made the arithmetic; nothing loaded its input. A dashboard needs one, and the dangerous way
 * to write it is to return every field of `KpiInput` with the ones nobody loaded left empty — because
 * an empty dataset is not an absent one. `room_closure_minutes` over no closures is zero, so
 * `available_room_minutes` becomes the whole open day and every room reads as available for all of it.
 * The figure is wrong and the arithmetic does not say so, which is ADR 0070's subject exactly.
 *
 * So this module loads six datasets and says which six. {@link KPI_INPUT_LOADED_DATASETS} is that
 * statement, and `kpisComputableFrom` in `@berelax/core` is what a caller uses to pick the KPIs it may
 * offer: a KPI reading a dataset this loader does not supply is not rendered as `no_data`, it is not
 * offered. R-REP-05's five cohort datasets are the ones absent, and the reason is that they are a
 * different grain — a cohort month rather than a trading day — so a window of trading dates is not the
 * argument they take.
 *
 * # `rooms.is_bookable` is current state, and that is recorded rather than hidden
 *
 * `roomDays` is the cross of the rooms that are bookable NOW with the trading days in the window.
 * `kpi-expression.ts`'s own comment says why that cannot be better: *"`rooms.is_bookable` (0012) is
 * current state with no history, so 'which rooms were in service in March' is not a question the schema
 * can answer"*. A room taken out of service today therefore disappears from a denominator for a month
 * it was in service for. That is a property of the data and it is reported, in
 * {@link KpiInputProvenance}, so a screen can print the caveat instead of implying there is none.
 */

/** A trading day with its open minutes, from `reporting.dim_date`. */
export interface KpiBusinessDayRow {
  readonly businessDay: string
  readonly openMinutes: number
}

export interface KpiRoomDayRow {
  readonly businessDay: string
  readonly roomId: string
}

export interface KpiRoomClosureRow {
  readonly businessDay: string
  readonly roomId: string
  readonly fromMinuteAfterOpen: number
  readonly toMinuteAfterOpen: number
}

export interface KpiAppointmentRow {
  readonly businessDay: string
  readonly roomId: string | null
  readonly employeeId: string | null
  readonly isDelivered: boolean
  readonly treatmentMinutes: number
  readonly turnaroundMinutes: number
}

export interface KpiRosteredShiftRow {
  readonly businessDay: string
  readonly employeeId: string
  readonly rosteredMinutes: number
}

export interface KpiRevenueLineRow {
  readonly businessDay: string
  readonly accountCode: string
  readonly netFils: bigint
}

/**
 * What a caller must be told about the rows it was handed.
 *
 * A loader that returned only rows would let a screen imply the figures are complete. These three are
 * the facts a reader needs in order to use them, and each is a MEASUREMENT rather than a caveat: the
 * number of days the window asked for against the number `dim_date` holds says whether the window ran
 * past the trading calendar, and `roomsAreCurrentState` is the limitation stated above.
 */
export interface KpiInputProvenance {
  readonly daysRequested: number
  readonly daysFound: number
  readonly roomsCounted: number
  readonly roomsAreCurrentState: true
}

export interface KpiInputRows {
  readonly businessDays: readonly KpiBusinessDayRow[]
  readonly roomDays: readonly KpiRoomDayRow[]
  readonly roomClosures: readonly KpiRoomClosureRow[]
  readonly appointments: readonly KpiAppointmentRow[]
  readonly rosteredShifts: readonly KpiRosteredShiftRow[]
  readonly revenueLines: readonly KpiRevenueLineRow[]
  readonly provenance: KpiInputProvenance
}

/**
 * The datasets this loader supplies, as a list a caller can hand to `kpisComputableFrom`.
 *
 * A second spelling of the keys above, and it arrives with the check that holds the two equal:
 * `packages/fixtures/src/data-quality.itest.ts` asserts this list is exactly the non-provenance keys of
 * what the loader returned, in both directions. Without that, a dataset added here and left out of the
 * list would make its KPIs quietly unavailable, and one removed here and left in the list would make
 * them quietly wrong.
 */
export const KPI_INPUT_LOADED_DATASETS = [
  'businessDays',
  'roomDays',
  'roomClosures',
  'appointments',
  'rosteredShifts',
  'revenueLines',
] as const

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The six datasets for one window of trading dates.
 *
 * Every row is bounded on a trading date and never on an instant: trading runs 11:00–02:00, so a
 * 01:30 appointment belongs to the previous trading date, and a window taken on an instant would move
 * it. The closure offsets are computed against `dim_date.opens_at` IN THE DATABASE, for the same
 * reason — a subtraction in JavaScript would need the opening instant marshalled out and back, and the
 * one place that already holds both is the row.
 */
export async function kpiInputRows(
  sql: Sql,
  args: {
    readonly window: DataQualityWindow
    /** The revenue account codes, from `STANDARD_SPA_CHART`. The chart lives in `core` (ADR 0001). */
    readonly revenueAccountCodes: readonly string[]
  },
): Promise<KpiInputRows> {
  const { fromInclusive: from, toInclusive: to } = args.window
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || to < from) {
    throw new AppError(
      'validation',
      `A KPI input window is two trading dates as YYYY-MM-DD with the first no later than the second; ` +
        `got "${from}" to "${to}".`,
    )
  }
  if (args.revenueAccountCodes.length === 0) {
    throw new AppError(
      'validation',
      'A KPI input needs at least one revenue account code. An empty set matches no account, so every ' +
        'revenue figure would be zero and would read as a period with no takings.',
    )
  }

  const businessDays = await sql<KpiBusinessDayRow[]>`
    select business_day::text as "businessDay", open_minutes as "openMinutes"
      from reporting.dim_date
     where business_day between ${from}::date and ${to}::date
     order by business_day
  `
  const rooms = await sql<{ id: string }[]>`
    select id::text as id from rooms where is_bookable order by display_order, code
  `
  const roomDays: KpiRoomDayRow[] = []
  for (const day of businessDays) {
    for (const room of rooms) roomDays.push({ businessDay: day.businessDay, roomId: room.id })
  }

  const roomClosures = await sql<KpiRoomClosureRow[]>`
    select d.business_day::text                                                        as "businessDay",
           b.room_id::text                                                             as "roomId",
           floor(extract(epoch from (lower(b.period) - d.opens_at)) / 60)::int         as "fromMinuteAfterOpen",
           ceil(extract(epoch from (upper(b.period) - d.opens_at)) / 60)::int          as "toMinuteAfterOpen"
      from resource_block b
      join reporting.dim_date d
        on d.business_day between ${from}::date and ${to}::date
       and b.period && tstzrange(d.opens_at, d.closes_at, '[)')
      join rooms r on r.id = b.room_id and r.is_bookable
     order by d.business_day, b.room_id, lower(b.period)
  `

  const appointments = await sql<KpiAppointmentRow[]>`
    select business_day::text          as "businessDay",
           room_id::text               as "roomId",
           employee_id::text           as "employeeId",
           is_delivered                as "isDelivered",
           treatment_minutes           as "treatmentMinutes",
           turnaround_minutes          as "turnaroundMinutes"
      from reporting.fact_appointment
     where business_day between ${from}::date and ${to}::date
     order by business_day, appointment_id
  `

  const rosteredShifts = await sql<KpiRosteredShiftRow[]>`
    select business_day::text  as "businessDay",
           employee_id::text   as "employeeId",
           rostered_minutes    as "rosteredMinutes"
      from reporting.fact_shift
     where business_day between ${from}::date and ${to}::date
     order by business_day, shift_id, employee_id
  `

  // `fact_sale` carries a document's net and not a per-account split, so the account code is attached
  // from the journal lines the document's own entry wrote. Grouped, because a document may credit more
  // than one revenue account — a treatment and a retail item on one invoice.
  const revenueLines = await sql<{ businessDay: string; accountCode: string; netFils: string }[]>`
    select e.entry_date::text                                as "businessDay",
           l.account_code                                    as "accountCode",
           sum(l.credit_fils - l.debit_fils)::text           as "netFils"
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where e.entry_date between ${from}::date and ${to}::date
       and l.account_code = any(${[...args.revenueAccountCodes]}::text[])
     group by e.entry_date, l.account_code
     having sum(l.credit_fils - l.debit_fils) <> 0
     order by e.entry_date, l.account_code
  `

  const [span] = await sql<{ days: string }[]>`
    select (${to}::date - ${from}::date + 1)::text as days
  `

  return {
    businessDays,
    roomDays,
    roomClosures,
    appointments,
    rosteredShifts,
    revenueLines: revenueLines.map((row) => ({
      businessDay: row.businessDay,
      accountCode: row.accountCode,
      netFils: BigInt(row.netFils),
    })),
    provenance: {
      daysRequested: Number(span?.days ?? '0'),
      daysFound: businessDays.length,
      roomsCounted: rooms.length,
      roomsAreCurrentState: true,
    },
  }
}

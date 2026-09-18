/**
 * Enumerating the trading calendar over a horizon.
 *
 * Pure, and in `core` rather than in `db`, because it is arithmetic: given a weekly pattern, some
 * dated overrides and some closed dates, which dates trade and between which instants. The database
 * package writes the answer; it does not work it out. That direction is enforced by `pnpm boundaries`
 * — `db` must never import `core` — and the rule earned its place here, catching the first draft of
 * this module sitting on the wrong side of it.
 *
 * A closed date produces **no row**. It is not a row with a flag: a report that forgot an `is_open`
 * predicate would then show a shut day as a trading day with no takings, which is a different and
 * much worse claim than "we were closed".
 */
import type { Instant, LocalDate, TimeZone } from '../time.ts'
import { ASIA_DUBAI } from '../time.ts'
import { type HoursForDate, nextDate, tradingBounds } from './resolve.ts'

/** One trading date, ready to be written to `business_day`. */
export interface BusinessDayRow {
  readonly tradingDate: LocalDate
  readonly opensAt: Instant
  readonly closesAt: Instant
  /** Whether the hours came from the weekly pattern or from a dated override. */
  readonly source: 'weekly' | 'override'
}

export interface HorizonOptions {
  /** First trading date to consider. */
  readonly from: LocalDate
  /** How many calendar dates forward, inclusive of `from`. */
  readonly days: number
  readonly hoursFor: HoursForDate
  /** Which dates take their hours from an override, for the `source` column. */
  readonly isOverride?: (date: LocalDate) => boolean
  readonly zone?: TimeZone
}

/** Every calendar date in the horizon, in order. Includes the ones that do not trade. */
export function horizonDates(from: LocalDate, days: number): LocalDate[] {
  const dates: LocalDate[] = []
  let date = from
  for (let index = 0; index < days; index += 1) {
    dates.push(date)
    date = nextDate(date)
  }
  return dates
}

/** The trading dates in the horizon, with their instants. Closed dates are omitted. */
export function horizonRows(options: HorizonOptions): BusinessDayRow[] {
  const { hoursFor, isOverride, zone = ASIA_DUBAI } = options
  const rows: BusinessDayRow[] = []
  for (const date of horizonDates(options.from, options.days)) {
    const hours = hoursFor(date)
    if (hours === undefined) continue
    const { opensAt, closesAt } = tradingBounds(date, hours, zone)
    rows.push({
      tradingDate: date,
      opensAt,
      closesAt,
      source: isOverride?.(date) === true ? 'override' : 'weekly',
    })
  }
  return rows
}

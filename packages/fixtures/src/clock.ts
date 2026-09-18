/**
 * The frozen clock, and the trading calendar the fixture salon lives in.
 *
 * "Today" has to be a constant or nothing downstream is reproducible: a report cut on "this week"
 * would cover a different week tomorrow, and every screenshot of it would diff. So the fixture world
 * has one `now`, and every date in it is derived from that instant rather than from the machine's.
 *
 * The date is chosen, not arbitrary. **Friday 18 September 2026, 14:00 Gulf Standard Time** — a
 * weekday afternoon in the middle of a month, with a fully closed month behind it (August) and a
 * partly booked month ahead. Friday is the busiest trading day here, so the day view is worth
 * looking at rather than empty.
 */
import { ASIA_DUBAI, type Instant, instantFromIso, type LocalDate, localDate } from '@berelax/core'

/** 2026-09-18T14:00:00+04:00. Everything in the fixture salon is relative to this. */
export const FIXTURE_NOW_ISO = '2026-09-18T10:00:00.000Z'
export const FIXTURE_NOW: Instant = instantFromIso(FIXTURE_NOW_ISO)

/** The business day the fixture "now" falls in. */
export const FIXTURE_TODAY: LocalDate = localDate('2026-09-18')

/** The fixture salon trades in Abu Dhabi, so its timezone is the business one. */
export const FIXTURE_TIMEZONE = ASIA_DUBAI

/**
 * Trading hours: 11:00 to 02:00, every day.
 *
 * The close is past midnight, which is the reason `business_day` is a first-class concept rather
 * than a calendar date (ADR 0007). A fixture that traded 09:00 to 17:00 would never exercise it, and
 * every report built against such a fixture would be wrong on the first real night.
 */
export const FIXTURE_OPEN = '11:00'
export const FIXTURE_CLOSE = '02:00'

/**
 * The last closed accounting month.
 *
 * August 2026. Closed means locked: no entry may be added to it, and the VAT figures for it are
 * final. Having one in the fixture is what makes the period-locking path demoable — and what catches
 * a report that quietly writes into a closed period.
 */
export const FIXTURE_CLOSED_MONTH = { year: 2026, month: 8 } as const

/** How far back the fixture's history runs. */
export const FIXTURE_HISTORY_DAYS = 120
/** How far forward its bookings run. */
export const FIXTURE_FORWARD_DAYS = 28

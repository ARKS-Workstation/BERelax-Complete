import {
  ASIA_DUBAI,
  complianceAsOfDate,
  type HoursForDate,
  type Instant,
  localTime,
} from '@berelax/core'
import { readTradingHoursAround, type Sql } from '@berelax/db'

/**
 * The date the compliance calendar is judged against, for an instant.
 *
 * Composed here and not inside either package, because the composition needs both and neither may import
 * the other: the `business_day` rows come from `readTradingHoursAround` in `@berelax/db`, and the rule
 * that decides which of them contains the instant is `resolveTradingDate` in `@berelax/core`.
 * `apps/web/src/collections/journal-posts.ts` does the same six lines for the publish guard, and
 * `apps/worker/src/jobs/obligation-reminders.ts` for the daily pass — three callers rather than one shared
 * helper, because the only package allowed to hold both halves is `packages/fixtures`, and that is
 * test-only.
 *
 * The distinction matters more here than anywhere else in this unit. A trading session runs past midnight,
 * so in the small hours the business is still working the previous trading date: an obligation due that
 * date is NOT yet overdue, and a dashboard that used the calendar date would report a breach every night
 * and withdraw it at closing. One false alarm a night is enough to make somebody stop reading the screen.
 *
 * The hours themselves are deliberately not written down here. They are a `premises_hours` row the owner
 * can change, and `nap-hours-literal-outside-the-seed` refuses the literal anywhere under `apps/web`.
 */
export async function complianceAsOf(sql: Sql, atMs: number): Promise<string> {
  const hours = await readTradingHoursAround(sql, atMs)
  const hoursFor: HoursForDate = (date) => {
    const row = hours.find((entry) => entry.tradingDate === date)
    return row === undefined
      ? undefined
      : { open: localTime(row.open), close: localTime(row.close) }
  }
  return complianceAsOfDate(atMs as Instant, hoursFor, ASIA_DUBAI)
}

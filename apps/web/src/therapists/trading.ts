import { readOpenTradingDays, type Sql } from '@berelax/db'

/**
 * The trading date the availability preview is about: the next one that is still open.
 *
 * Read from `business_day` and never computed from the clock, which is brief rule 7 and ADR 0007. The
 * trading day crosses midnight, so a calendar date is wrong twice: in the small hours the business is
 * still working the PREVIOUS trading date, and between close and open there is no trading date at all — a
 * reader standing outside in the morning wants the day that is about to open, not an empty grid for a day
 * that has ended. `closes_at > now` is the predicate that answers both, and it is the same one the booking
 * flow's day strip is cut from, so the two surfaces cannot name different days. The hours themselves are
 * `premises_hours`' and are never a literal on a rendered surface or in a comment beside one.
 *
 * Null when the horizon holds no open day at all, which the page renders as a sentence. The alternative —
 * falling back to a calendar date — would preview availability for a date `business_day` does not have,
 * and the solver would answer "closed" for a reason that is not the business's.
 */
export async function nextTradingDate(sql: Sql, now: number): Promise<string | null> {
  const [day] = await readOpenTradingDays(sql, { now, limit: 1 })
  return day?.tradingDate ?? null
}

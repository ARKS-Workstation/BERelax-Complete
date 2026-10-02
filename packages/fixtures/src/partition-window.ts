/**
 * A date a suite may pin an instant on: one the seeded calendar holds AND a partition covers.
 *
 * ## The defect this exists to stop, which has now happened twice
 *
 * `analytics.event`, `analytics.session` and `audit_event` are monthly partitioned with NO default
 * partition, deliberately: 0096 and 0005 both say so, and 0096 goes further and raises ZY061 naming the
 * month and the remedy rather than letting PostgreSQL answer `23514`. `ensure_partitions` creates the
 * CURRENT month and three ahead, so the set of months a row may land in is a window that MOVES.
 *
 * A suite that pins an absolute instant is therefore a suite with an expiry date. `collect.itest.ts`
 * pinned `2026-09-29T17:00:00Z` — "21:00 Asia/Dubai on a date the seed's calendar holds", true when it was
 * written — and on 2026-10-02, against a database migrated that morning, seventeen of its cases failed
 * with ZY061. `google-reauth-notice.itest.ts` pinned `2026-09-25` and failed the same way through the
 * audit trigger, which carries the business instant rather than `now()`. Neither was a defect in the
 * code either suite was about.
 *
 * The seeded calendar moves the same way and for the same reason: `pnpm seed` writes a contiguous span
 * around the clock (46 days at the time of writing) plus the far-future span R-REP-05 reserved, so a
 * pinned date eventually leaves the calendar too and `session_trading_date_fk` refuses it.
 *
 * ## Why TODAY rather than a date in the recent past
 *
 * Today's UTC date is the only date guaranteed to be in both windows at once: the current month's
 * partition exists because `ensure_partitions` created it, and the seeded calendar is centred on the
 * clock. `daysAgo` is available for a suite that needs an instant that has already passed — an incident
 * "opened earlier", say — and is CLAMPED to the first of the current UTC month, because a suite running
 * on the 2nd must not reach back into a month whose partition was never created.
 *
 * It is a date and not an instant: the time of day is the suite's own business, and a suite that wants
 * 21:00 Asia/Dubai (17:00 UTC) says so where a reader can see it.
 */

/** Options for {@link partitionWindowDate}. */
export interface PartitionWindowOptions {
  /**
   * How many days before today to go back, clamped to the first of the current UTC month.
   *
   * A fractional or negative value is a mistake rather than an intention — a future date is outside the
   * seeded calendar as often as not — so both are refused rather than rounded.
   */
  readonly daysAgo?: number
}

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * A `YYYY-MM-DD` date inside the current month's partition window and the seeded trading calendar.
 *
 * `now` is injectable so the clamp itself can be tested on a month boundary, which is the one day of the
 * month this function behaves differently.
 */
export function partitionWindowDate(
  options: PartitionWindowOptions = {},
  now: Date = new Date(),
): string {
  const daysAgo = options.daysAgo ?? 0
  if (!Number.isInteger(daysAgo) || daysAgo < 0) {
    throw new Error(
      `partitionWindowDate: daysAgo is ${daysAgo}, which is not a whole number of days in the past. ` +
        'A future date is outside the seeded calendar as often as not, and a fractional day is a ' +
        'mistake about what this returns, which is a date and never an instant.',
    )
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const wanted = Math.max(today - daysAgo * MILLISECONDS_PER_DAY, monthStart)
  return new Date(wanted).toISOString().slice(0, 10)
}

/**
 * The same date with a UTC time of day on it, as an ISO instant.
 *
 * `timeUtc` is `HH:MM` or `HH:MM:SS`, so `17:00` reads as 21:00 Asia/Dubai at the call site rather than
 * as an offset a reader has to apply.
 */
export function partitionWindowIso(
  timeUtc: string,
  options: PartitionWindowOptions = {},
  now: Date = new Date(),
): string {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(timeUtc)
  if (match === null) {
    throw new Error(
      `partitionWindowIso: '${timeUtc}' is not HH:MM or HH:MM:SS. The time of day is spelled out so a ` +
        'reader can see which trading hour the instant falls in.',
    )
  }
  const [hours, minutes, seconds] = [match[1] ?? '', match[2] ?? '', match[3] ?? '00']
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) {
    throw new Error(`partitionWindowIso: '${timeUtc}' is not a time of day.`)
  }
  return `${partitionWindowDate(options, now)}T${hours}:${minutes}:${seconds}.000Z`
}

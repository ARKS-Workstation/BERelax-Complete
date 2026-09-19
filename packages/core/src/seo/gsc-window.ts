import { AppError } from '@berelax/shared'
import { type Instant, type LocalDate, localDate } from '../time.ts'

/**
 * The window the nightly Search Console pass may ask for, and why it is not "yesterday".
 *
 * ## The 2–3 day lag is a property of the data, not a delay in our pipeline
 *
 * Search Console's own documentation and docs/10 §7 both say it: the report has a **2–3 day lag**. What
 * that means concretely is not "the data arrives late" but "the most recent days are incomplete and keep
 * changing". A pass that asked for yesterday would get a fraction of yesterday's clicks, store them, and
 * the warehouse would then hold a permanent record of a traffic collapse that never happened — followed,
 * on tomorrow's pass, by nothing at all, because a row already written for yesterday is not re-fetched
 * unless the window reaches back over it.
 *
 * So the window **ends at `today - 3`** and reaches back over the days before it, which makes the pass
 * self-healing: the same day is fetched on several consecutive nights and the last fetch wins. That is
 * why `seo_gsc_daily` is upserted on its dimension key rather than appended to.
 *
 * ## Calendar UTC days, deliberately NOT `business_day`
 *
 * This is the one place in the system where a date is not resolved on the trading day, and the choice is
 * load-bearing rather than a convenience. Trading here runs 11:00–02:00, so 01:30 belongs to the previous
 * trading date (ADR 0007), and every takings, rota and VAT figure uses that rule.
 *
 * A Search Console date is **Google's**: the calendar day in UTC that Google attributed the impression
 * to. It is the value the API accepts in `startDate`/`endDate`, the value it returns in the `date`
 * dimension, and the value the owner sees in the Search Console UI they will compare our report against.
 * Resolving it on `business_day` instead would move up to three hours of clicks into the previous day and
 * our totals would disagree with Search Console's by an amount nobody could explain or reconcile — and a
 * warehouse whose totals do not match the source it mirrors is worse than no warehouse. The test in
 * `gsc-window.test.ts` pins an instant where the two answers differ and asserts this one wins.
 *
 * Nothing here reads the clock: the instant is injected, which is what lets the frozen-clock test stand
 * on either side of UTC midnight without waiting for one.
 */

/**
 * How many days back from "now" the window may end.
 *
 * Three, not two. docs/10 §7 gives the lag as a range, and the far end of a range is the only safe end
 * to design against: at `today - 2` the newest day in the window is sometimes complete and sometimes
 * half a day short, which produces a warehouse that is wrong in a way that varies by the hour the cron
 * happened to fire.
 */
export const GSC_DATA_LAG_DAYS = 3

/**
 * How many days the nightly window covers, ending at `today - GSC_DATA_LAG_DAYS`.
 *
 * Seven, so each day is fetched on seven consecutive nights. Google keeps refining a day's figures for
 * a while after it closes, and a pass that fetched each day exactly once would store the first version
 * of every number for ever. The cost is one extra page of rows a night; the benefit is that a day
 * missed entirely — a failed cron, a re-auth, an exhausted quota — is repaired by the next six passes
 * with nobody having to notice.
 */
export const GSC_SNAPSHOT_WINDOW_DAYS = 7

export interface GscWindow {
  readonly startDate: LocalDate
  readonly endDate: LocalDate
}

/** The calendar date an instant falls on **in UTC** — Google's day, not the trading day. */
export function gscCalendarDate(instant: Instant): LocalDate {
  // `toISOString()` is UTC by definition, so this needs no timezone database and cannot be affected by
  // the process timezone — which is what `TZ=Pacific/Kiritimati pnpm test` exists to catch elsewhere.
  return localDate(new Date(instant).toISOString().slice(0, 10))
}

/** Adds (or subtracts) whole days to a calendar UTC date. */
export function addUtcDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) {
    throw new AppError('validation', `addUtcDays needs a whole number of days, received ${days}`)
  }
  const shifted = new Date(`${date}T00:00:00.000Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return localDate(shifted.toISOString().slice(0, 10))
}

/**
 * The window the pass may request at `now`.
 *
 * `days` is the window length; the default is the nightly one. A caller asking for a longer window is
 * backfilling, which is a legitimate thing to do and still must not reach past the lag.
 */
export function gscRequestWindow(now: Instant, days: number = GSC_SNAPSHOT_WINDOW_DAYS): GscWindow {
  if (!Number.isInteger(days) || days < 1) {
    throw new AppError(
      'validation',
      `A Search Console window is at least one whole day, received ${days}.`,
    )
  }
  const endDate = addUtcDays(gscCalendarDate(now), -GSC_DATA_LAG_DAYS)
  return { startDate: addUtcDays(endDate, -(days - 1)), endDate }
}

/**
 * True when a window is safe to request at `now`: it ends at or before `today - GSC_DATA_LAG_DAYS`.
 *
 * Exported because the assertion belongs to whoever is about to make the call, not only to the function
 * that computed the window. A backfill assembled by hand, or a window read back from a stored snapshot
 * row and re-requested, goes through the same predicate — and the adapter refuses a window that fails
 * it, so there is no path to the API that can ask for today.
 */
export function windowRespectsGscLag(window: GscWindow, now: Instant): boolean {
  const latest = addUtcDays(gscCalendarDate(now), -GSC_DATA_LAG_DAYS)
  return window.startDate <= window.endDate && window.endDate <= latest
}

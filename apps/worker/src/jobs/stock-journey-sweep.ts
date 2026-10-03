import {
  ASIA_DUBAI,
  type HoursForDate,
  type Instant,
  type LocalDate,
  localDate,
  PROVISIONAL_WINBACK_DAYS,
  resolveTradingDate,
  toLocal,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { runBirthdayTrigger } from '../automation/triggers/birthday.ts'
import { runReviewSolicitationTrigger } from '../automation/triggers/review-solicitation.ts'
import type { TriggerOutcome } from '../automation/triggers/shared.ts'
import { hoursFromPremises, runWinbackTrigger } from '../automation/triggers/winback.ts'

/**
 * The daily pass that enters the three stock journeys (C-AUTO-11).
 *
 * ## Why a sweep and not an event dispatcher
 *
 * Nothing in this build consumes `outbox_event` into an enrolment: there is a queue, there are domain
 * events, and there is no module that joins the two. So a review request triggered "on
 * appointment.completed" would be triggered by nothing at all. A sweep is also the only honest shape for
 * two of the three — a contact becoming lapsed and a birthday arriving are facts about dates rather than
 * things that happen — and it is idempotent by construction: `enrolOnLiveVersion` answers
 * `already_enrolled` for a contact already running, so a pass delivered twice enrols nobody twice.
 *
 * ## Why it resolves TODAY once
 *
 * Every contact in one pass is judged against one business day. A pass that resolved the date per
 * contact would judge its first and its last contact against different days at 02:00, which is the
 * boundary this build has most of — trading runs 11:00 to 02:00. `resolveTradingDate` is the one reading
 * of it, and an instant in no session is a refusal here too: a sweep run at 05:00 has no trading day to
 * sweep for and says so rather than guessing at one.
 *
 * ## Nothing here sends
 *
 * Three enrolments, and every message a journey reaches goes through the interpreter and then the
 * messaging choke point. That is why the agent's `budget_fils_per_run` is 0 in migration 0155: this pass
 * performs no outbound call of any kind.
 */

export interface StockJourneySweepResult {
  readonly tradingDate: LocalDate
  readonly review: TriggerOutcome
  readonly winback: TriggerOutcome & { readonly notMeasurable: number }
  readonly birthday: TriggerOutcome
}

/** How far back the review pass looks. Two trading days, so a missed night is covered by the next. */
export const REVIEW_LOOKBACK_DAYS = 2

export interface StockJourneySweepDeps {
  /** Trading hours per date, from `premises_hours`. Injected: `packages/core` reads no database. */
  readonly hoursFor: HoursForDate
  /** The win-back interval in days, from `app_setting`. Provisional (90). Never read in here. */
  readonly winbackIntervalDays?: number
}

/**
 * Run all three triggers for the business day containing `at`.
 *
 * Three passes rather than one query, deliberately: the three journeys are entered on different facts
 * and a single query joining all three would make a change to one of them a change to all three. They
 * run in a fixed order — review, win-back, birthday — so a log line reads the same way every night.
 */
export async function runStockJourneySweep(
  sql: Sql,
  deps: StockJourneySweepDeps,
  at: Instant,
): Promise<StockJourneySweepResult> {
  const resolved = resolveTradingDate(at, deps.hoursFor, ASIA_DUBAI)
  if (resolved.kind !== 'trading') {
    throw new Error(
      `The stock journey sweep ran at an instant in no trading session (${resolved.reason}, calendar ` +
        `date ${resolved.calendarDate}), so there is no business day to sweep for. Refusing rather ` +
        'than falling back to the calendar date: the review pass is dated on trading days, and a ' +
        'substituted date would scan a day the salon was not open.',
    )
  }

  const today = resolved.date
  const since = sinceTradingDate(today, REVIEW_LOOKBACK_DAYS)
  const asDate = new Date(at)
  const local = toLocal(at, ASIA_DUBAI)

  const review = await runReviewSolicitationTrigger(sql, {
    sinceTradingDate: since,
    untilTradingDate: today,
    at: asDate,
  })
  const winback = await runWinbackTrigger(sql, {
    today,
    hoursFor: deps.hoursFor,
    intervalDays: deps.winbackIntervalDays ?? PROVISIONAL_WINBACK_DAYS,
    at: asDate,
  })
  // The month and the day of the LOCAL date, which is the only reading of "today" a birthday has: a
  // contact whose birthday is the 1st has it on the 1st in Dubai, and a UTC month would greet them at
  // 04:00 on the 2nd for four hours of the year.
  const birthday = await runBirthdayTrigger(sql, {
    month: Number(local.date.slice(5, 7)),
    day: Number(local.date.slice(8, 10)),
    at: asDate,
  })

  return { tradingDate: today, review, winback, birthday }
}

/** `days` trading days before `date`, as a `LocalDate`. Calendar arithmetic over the ISO string. */
function sinceTradingDate(date: LocalDate, days: number): LocalDate {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return localDate(value.toISOString().slice(0, 10))
}

/** `premises_hours`, as the sweep needs them. One read, at the top of the pass. */
export async function readPremisesHours(sql: Sql): Promise<HoursForDate> {
  const rows = await sql<{ dayOfWeek: number; open: string; close: string; isClosed: boolean }[]>`
    select day_of_week as "dayOfWeek", open_time::text as open, close_time::text as close,
           is_closed as "isClosed"
      from premises_hours
     order by day_of_week
  `
  return hoursFromPremises(
    rows
      .filter((row) => !row.isClosed)
      .map((row) => ({
        dayOfWeek: row.dayOfWeek,
        // `time` renders as `HH:MM:SS`; `localTime` wants `HH:MM`.
        open: row.open.slice(0, 5),
        close: row.close.slice(0, 5),
      })),
  )
}

/**
 * The two pure rules a reschedule needs, and the boundary adapter that carries them into the write path
 * (B-LIFE-03).
 *
 * A second file beside `cancellation-policy.ts` because these two are about the SUCCESSOR — the row a
 * reschedule creates — where that file is about a judgement passed on a row that already exists. Neither
 * belongs to the other, and one file called "cancellation policy" holding "which trading date does the new
 * slot belong to" is the kind of drawer nobody finds anything in.
 *
 * ## The trading date is re-resolved, never arithmetic on a calendar date
 *
 * Trading runs 11:00–02:00, so 01:30 belongs to the PREVIOUS trading date (ADR 0007, brief rule 7). The
 * consequence for a reschedule is the whole of this file's first half:
 *
 *   - 23:50 → **00:30** keeps the trading date. Both instants are inside the same 11:00–02:00 session.
 *   - 23:50 → **11:30 the next morning** moves to the next trading date. The clock advanced eleven hours
 *     and forty minutes; the calendar date advanced by one; and the TRADING date advanced by one too, but
 *     for a different reason, and only {@link resolveTradingDate} knows which.
 *
 * Truncating the new start to its LOCAL calendar date gets the first case wrong and the second right, which
 * is the worst possible failure shape: it works all afternoon and puts the late-night reschedules on
 * tomorrow's rota, tomorrow's cash-up and tomorrow's commission.
 *
 * Truncating to the UTC date is worse, because today it is RIGHT. Trading runs 11:00–02:00 Dubai, which is
 * 07:00–22:00 UTC, so every instant of a trading day currently shares its UTC date with its trading date and
 * `toISOString().slice(0, 10)` happens to agree with this function for every case. It agrees by coincidence
 * of the configured hours: an override closing at 04:00 local (00:00 UTC) breaks it, silently, on the rows
 * written that night. A rule that is accidentally correct is the hardest kind to find when it stops being
 * correct, which is why the date is resolved through the existing helper — from the `business_day` rows the
 * caller read — and never truncated at all. Gate 56l mutates to the LOCAL form for that reason: it is the
 * one a test can catch.
 *
 * A resolution of `outside_trading` is a named refusal rather than a nearest guess.
 *
 * ## The successor is born in a status, and it is not always the predecessor's
 *
 * A reschedule does not confirm anything and does not un-confirm anything. A `requested` appointment moved
 * by the salon is still a request the salon has not accepted, and a `confirmed` one moved by the front desk
 * is still a promise. But `checked_in` cannot carry over: the client is standing in the salon for a slot
 * that no longer exists, and a successor born `checked_in` would claim they had arrived for a treatment
 * three hours in the future — which then makes `checked_in -> no_show` reachable against a client who is
 * present and waiting.
 */
import { AppError } from '@berelax/shared'
import {
  type HoursForDate,
  resolveTradingDate,
  type TradingDateResolution,
} from '../business-day/resolve.ts'
import type { Instant, LocalDate, LocalTime } from '../time.ts'
import { instantFromEpochMs } from './cancellation-policy.ts'

/**
 * One `business_day` row, as the write path read it.
 *
 * `open` and `close` are the local `HH:MM` strings, which is how `business_day` already crosses this
 * boundary for the availability query (`AvailabilityHoursInput`): the row stores instants, the resolver
 * needs wall-clock times in the business zone, and the conversion is `at time zone 'Asia/Dubai'` in the
 * SQL rather than a second timezone calculation on this side.
 *
 * Keyed by the trading date, which IS the calendar date the session opens on — so the same value serves as
 * the calendar key {@link HoursForDate} is asked about and as the trading date it may answer.
 */
export interface TradingDayHoursRow {
  readonly tradingDate: string
  readonly open: string
  readonly close: string
}

/** `HoursForDate` over rows the caller read. Absent means the premises does not open that date (0011). */
export function hoursFromDayRows(rows: readonly TradingDayHoursRow[]): HoursForDate {
  const byDate = new Map(rows.map((row) => [row.tradingDate, row]))
  return (date: LocalDate) => {
    const row = byDate.get(date)
    if (row === undefined) return undefined
    return { open: row.open as LocalTime, close: row.close as LocalTime }
  }
}

/**
 * The resolution, with the trading date as a plain string so `packages/db` can store it.
 *
 * A discriminated union and not a nullable date, for the reason `resolveTradingDate`'s own header gives: a
 * resolver that answers the nearest date anyway is worse than one that fails, because the wrong answer is
 * indistinguishable from a right one and it lands in a report.
 */
export type RescheduleTradingDate =
  | { readonly kind: 'trading'; readonly tradingDate: string }
  | { readonly kind: 'outside_trading'; readonly reason: string; readonly calendarDate: string }

export interface RescheduleTradingDateRequest {
  /** The instant the new treatment STARTS, in epoch milliseconds. */
  readonly startsAtMs: number
  /** Every `business_day` row that could possibly contain it — a superset is correct here. */
  readonly days: readonly TradingDayHoursRow[]
}

/**
 * The trading date the new slot belongs to, resolved through {@link resolveTradingDate}.
 *
 * The injected seam: `packages/db` reads the candidate `business_day` rows inside the transaction and
 * passes them here, because it may not import this package and must not own this rule. Over-supplying rows
 * is harmless — the resolver consults the instant's own calendar date and the one before it, and ignores
 * the rest — which is why the caller brackets by calendar date rather than trying to pick the right row.
 */
export function rescheduleTradingDate(
  request: RescheduleTradingDateRequest,
): RescheduleTradingDate {
  const startsAt: Instant = instantFromEpochMs(request.startsAtMs, 'the new treatment start')
  const resolution: TradingDateResolution = resolveTradingDate(
    startsAt,
    hoursFromDayRows(request.days),
  )
  return resolution.kind === 'trading'
    ? { kind: 'trading', tradingDate: resolution.date }
    : {
        kind: 'outside_trading',
        reason: resolution.reason,
        calendarDate: resolution.calendarDate,
      }
}

/** The statuses a reschedule may create a successor in. `appointment.status`'s bookable labels. */
export const SUCCESSOR_STATUSES = ['requested', 'confirmed'] as const
export type SuccessorStatus = (typeof SUCCESSOR_STATUSES)[number]

/**
 * The status the successor is born in, given the status the predecessor was moved out of.
 *
 * Three cases and no default-allow: `requested` stays a request, `confirmed` stays a promise, and
 * `checked_in` becomes `confirmed` because an arrival cannot be carried to a slot that has not happened
 * yet. Anything else throws rather than guessing — the only statuses `LEGAL_APPOINTMENT_TRANSITIONS`
 * permits `-> rescheduled` from are exactly those three, so a fourth reaching here means the table and this
 * function have drifted, and `reschedule-policy.test.ts` asserts the two agree by enumerating the table.
 */
export function successorStatusFor(predecessorStatus: string): SuccessorStatus {
  switch (predecessorStatus) {
    case 'requested':
      return 'requested'
    case 'confirmed':
      return 'confirmed'
    case 'checked_in':
      return 'confirmed'
    default:
      throw new AppError(
        'invariant_violated',
        `A reschedule cannot be made from "${predecessorStatus}": the lifecycle table permits ` +
          '`-> rescheduled` only from requested, confirmed and checked_in, so there is no status to ' +
          'create the successor in. Guessing one would write a row nobody may have asked for.',
        { details: { predecessorStatus, permitted: [...SUCCESSOR_STATUSES, 'checked_in'] } },
      )
  }
}

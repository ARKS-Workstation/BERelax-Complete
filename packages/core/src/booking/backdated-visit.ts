import type { Instant, LocalDate } from '../time.ts'

/**
 * A visit that happened and was never entered.
 *
 * ## The gap this closes
 *
 * There is no way to record a treatment after the fact. `/quick-book` books through
 * `queryAvailability`, which filters every slot against `minLeadMinutes` from *now*, so a past date
 * returns nothing to choose; and `handleCalendarWrite` only MOVES an appointment, it does not create one.
 * A walk-in served at 19:00 yesterday and not typed in is, today, unrecordable: it is missing from the
 * diary, from the therapist's utilisation, from commission, and its money is missing from the books.
 *
 * ## Why this is not "booking in the past"
 *
 * A booking is a promise about the future and every rule around it — lead time, the advance horizon,
 * gender matching, the availability solver — is about whether that promise can be kept. None of that
 * applies to a treatment that already happened: asking whether a therapist *was available* at 19:00
 * yesterday is answered by what they actually did, not by a solver. So this path does not consult
 * availability at all, and that is deliberate rather than a shortcut.
 *
 * What it does NOT relax is the one rule that is about reality rather than policy: the `btree_gist`
 * exclusion on `(therapist_id, period)`. Two overlapping treatments for one therapist cannot have
 * happened, so a backdated entry that collides is refused by the database exactly as a live one is. The
 * caller does not pre-check it; the constraint is the check.
 *
 * ## Why the status is decided here
 *
 * A past visit is never `confirmed` — that is a state about an appointment still to come. It is
 * `completed` or it is `no_show`, and the caller says which. The row is still walked through the
 * transition machine rather than inserted at its final status, so the history rows and the outbox events
 * are the same ones a live visit produces. An entry nobody can tell from a live one, in a table whose
 * history is the audit trail, is the thing worth avoiding.
 */

export const BACKDATED_OUTCOMES = ['completed', 'no_show'] as const
export type BackdatedOutcome = (typeof BACKDATED_OUTCOMES)[number]

export const BACKDATED_REFUSALS = [
  /** The instant is not in the past. A visit that has not happened is a booking; use the booking path. */
  'not_in_the_past',
  /** Further back than `horizonDays`. See the note on the horizon below. */
  'beyond_the_horizon',
  /** `endsAt` is not after `startsAt`, so the period is empty or inverted. */
  'period_not_positive',
  /** The treatment had not finished at the instant this is being entered. */
  'still_running',
  /** The instant falls outside any trading session, so no trading date owns it. */
  'outside_a_trading_session',
] as const
export type BackdatedRefusal = (typeof BACKDATED_REFUSALS)[number]

export interface BackdatedVisitInput {
  readonly startsAt: Instant
  readonly endsAt: Instant
  readonly outcome: BackdatedOutcome
  /** The instant the entry is being made at — the clock, not the visit. */
  readonly now: Instant
  /**
   * How far back an entry may reach, in days.
   *
   * A horizon and not an open door, because the two failures point in opposite directions. Too short and
   * a Friday visit cannot be entered on Monday, which is the ordinary case this exists for. Too long and
   * a mistyped year silently writes a treatment into a month whose figures have been reported — and the
   * period lock catches that only once the money is attached, not when the diary row is written.
   *
   * It is an argument rather than a constant here because it is a judgement about how this salon works,
   * which belongs in `app_setting` beside the other provisional figures and not in a pure function.
   */
  readonly horizonDays: number
}

export type BackdatedVisitVerdict =
  | {
      readonly kind: 'recordable'
      readonly tradingDate: LocalDate
      readonly outcome: BackdatedOutcome
    }
  | { readonly kind: 'refused'; readonly refusal: BackdatedRefusal }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether a past visit may be recorded, and which trading date owns it.
 *
 * Pure: the caller supplies the clock and the trading-date resolution. `resolveTradingDate` is the one
 * that knows a 01:30 treatment belongs to the previous day's session, and this must not reinvent that —
 * a backdated entry landing on the wrong trading date would put the money in the wrong day's takings,
 * which is the one thing a correction must never do.
 */
export function backdatedVisitVerdict(
  input: BackdatedVisitInput,
  tradingDateFor: (instant: Instant) => LocalDate | null,
): BackdatedVisitVerdict {
  // `Instant` is epoch milliseconds, so these are the numbers themselves rather than a parse.
  const startMs: number = input.startsAt
  const endMs: number = input.endsAt
  const nowMs: number = input.now

  if (!(endMs > startMs)) return { kind: 'refused', refusal: 'period_not_positive' }
  if (startMs >= nowMs) return { kind: 'refused', refusal: 'not_in_the_past' }
  /*
   * The whole treatment must be over, not merely started. A visit still in the chair is a live
   * appointment somebody should be entering the ordinary way, and recording it as `completed` would
   * mark a treatment finished while the client is on the table.
   */
  if (endMs > nowMs) return { kind: 'refused', refusal: 'still_running' }
  if (nowMs - startMs > input.horizonDays * DAY_MS) {
    return { kind: 'refused', refusal: 'beyond_the_horizon' }
  }

  const tradingDate = tradingDateFor(input.startsAt)
  if (tradingDate === null) return { kind: 'refused', refusal: 'outside_a_trading_session' }

  return { kind: 'recordable', tradingDate, outcome: input.outcome }
}

/**
 * The two occupancy intervals, and the interval arithmetic the solver is built from.
 *
 * ## Turnaround occupies the ROOM; the buffer occupies the THERAPIST
 *
 * One appointment produces **two different intervals**, because it consumes two different resources
 * for two different lengths of time:
 *
 *   - `roomOccupancy`      = `[start, end + turnaround)`      — linen, cleaning, airing
 *   - `therapistOccupancy` = `[start - buffer, end + buffer)` — the therapist's own rest, both sides
 *
 * They are never added together and never derived from one another. `service.turnaround_minutes` and
 * `service_resource_shape.therapist_buffer_minutes` are separate columns with no derivation between
 * them for exactly this reason (0017_catalogue.sql, docs/06 B1): the wet room needs 30 minutes of
 * cleaning while the therapist needs 10 minutes of rest, and a model that derived one from the other
 * cannot express that.
 *
 * The failure mode this shape prevents is specific, and it passes almost every test: add both figures
 * to one interval — `[start, end + turnaround + buffer)` — and the arithmetic still looks right, the
 * day still fills, the last slot is still late enough. What breaks is *which resource* reports the
 * conflict, so the front desk is told the room is busy when it is the therapist who is not free, and
 * moving the booking to another room does not help. `solve.worked.test.ts` pins that by swapping the
 * two configured values and asserting the conflicting resource changes with them; a conflated
 * implementation answers identically both ways round.
 *
 * ## Half-open, and one wall-clock grid per day
 *
 * Every period here is `[startsAt, endsAt)` — the convention of `business-day/windows.ts`,
 * `room-predicates.ts` and the `tstzrange` columns (ADR 0015). A treatment may therefore *end*
 * exactly at close; nothing may start there.
 *
 * Pure: instants in, instants out. No clock — "now" reaches the solver as an argument.
 */
import { AppError } from '@berelax/shared'
import { latestStartIn, type TradingWindow } from '../business-day/windows.ts'
import {
  ASIA_DUBAI,
  addMinutes,
  type Instant,
  minutesSinceMidnight,
  type TimeZone,
  toLocal,
} from '../time.ts'
import { type Period, periodsOverlap } from './room-predicates.ts'

function assertPositiveMinutes(label: string, minutes: number): void {
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new AppError(
      'validation',
      `${label} must be a positive whole number of minutes, got ${minutes}`,
    )
  }
}

function assertNonNegativeMinutes(label: string, minutes: number): void {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new AppError(
      'validation',
      `${label} must be a whole number of minutes and not negative, got ${minutes}`,
    )
  }
}

/**
 * The treatment itself: `[start, start + duration)`.
 *
 * A zero or negative duration is refused rather than returned as an empty period. An empty period
 * overlaps nothing (`room-predicates.isEmptyPeriod`), so a zero-minute treatment would be bookable
 * into a fully occupied room — which is how "any positive-duration treatment starting 01:55 is never
 * offered" stops being true.
 */
export function treatmentPeriod(startsAt: Instant, durationMinutes: number): Period {
  assertPositiveMinutes('A treatment duration', durationMinutes)
  return { startsAt, endsAt: addMinutes(startsAt, durationMinutes) }
}

/** Minutes the ROOM is held: the treatment plus its turnaround. Never the therapist buffer. */
export function roomOccupancy(args: {
  readonly startsAt: Instant
  readonly durationMinutes: number
  readonly turnaroundMinutes: number
}): Period {
  const treatment = treatmentPeriod(args.startsAt, args.durationMinutes)
  assertNonNegativeMinutes('A room turnaround', args.turnaroundMinutes)
  return {
    startsAt: treatment.startsAt,
    endsAt: addMinutes(treatment.endsAt, args.turnaroundMinutes),
  }
}

/**
 * Minutes the THERAPIST is held: the treatment plus the buffer on **both** sides.
 *
 * The leading side is the half that gets forgotten, and forgetting it books a therapist into a
 * treatment that starts while they are still finishing their break from the last one.
 */
export function therapistOccupancy(args: {
  readonly startsAt: Instant
  readonly durationMinutes: number
  readonly bufferMinutes: number
}): Period {
  const treatment = treatmentPeriod(args.startsAt, args.durationMinutes)
  assertNonNegativeMinutes('A therapist buffer', args.bufferMinutes)
  return {
    startsAt: addMinutes(treatment.startsAt, -args.bufferMinutes),
    endsAt: addMinutes(treatment.endsAt, args.bufferMinutes),
  }
}

/** True when `outer` contains every instant of `inner`. Half-open, so touching ends are contained. */
export function coversPeriod(outer: Period, inner: Period): boolean {
  return inner.startsAt >= outer.startsAt && inner.endsAt <= outer.endsAt
}

/** True when `period` shares an instant with any of `others`. */
export function overlapsAny(period: Period, others: readonly Period[]): boolean {
  return others.some((other) => periodsOverlap(period, other))
}

/**
 * The periods merged into ascending, disjoint ones. Abutting periods merge.
 *
 * Abutting matters: a therapist rostered 11:00–18:00 and 18:00–02:00 holds two shift rows and one
 * continuous presence, and a treatment crossing 18:00 must not be refused because the roster was
 * written in two halves. That is the difference between merging on `>` and merging on `>=`, and only
 * the second one is the business's answer.
 */
export function mergePeriods(periods: readonly Period[]): Period[] {
  const ordered = [...periods]
    .filter((period) => period.endsAt > period.startsAt)
    .sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt)
  const merged: Period[] = []
  for (const period of ordered) {
    const last = merged.at(-1)
    if (last !== undefined && period.startsAt <= last.endsAt) {
      if (period.endsAt > last.endsAt)
        merged[merged.length - 1] = { ...last, endsAt: period.endsAt }
      continue
    }
    merged.push(period)
  }
  return merged
}

/**
 * True when the union of `cover` contains `period` with no gap inside it.
 *
 * This is the shift test. "Does any shift overlap the treatment" is the wrong question and the easy
 * one to ask: a shift ending at 22:00 overlaps a 90-minute treatment starting at 21:00, and the
 * therapist would be sent home halfway through it.
 */
export function coveredWithoutGap(period: Period, cover: readonly Period[]): boolean {
  return mergePeriods(cover).some((merged) => coversPeriod(merged, period))
}

/**
 * Rounds an instant up to the next `stepMinutes` boundary of the local wall clock.
 *
 * Wall clock rather than epoch arithmetic because the grid a customer sees is a wall-clock fact —
 * 11:00, 11:15, 11:30 — and only a whole-hour UTC offset makes the two agree. Asia/Dubai is +04:00
 * today; a zone with a 30- or 45-minute offset would put every slot of the day off the quarter hour.
 */
export function alignToStep(
  instant: Instant,
  stepMinutes: number,
  zone: TimeZone = ASIA_DUBAI,
): Instant {
  assertPositiveMinutes('A slot step', stepMinutes)
  // Up to the whole minute first. A closure ending at 14:07:30 leaves a window starting mid-minute,
  // and a start carrying seconds renders as 14:07 while colliding as 14:07:30. Rounding *up* rather
  // than down, because rounding down would put the first candidate before the window opens.
  const intoMinute = instant % 60_000
  const whole = (intoMinute === 0 ? instant : instant + (60_000 - intoMinute)) as Instant
  const past = minutesSinceMidnight(toLocal(whole, zone).time) % stepMinutes
  return past === 0 ? whole : addMinutes(whole, stepMinutes - past)
}

/**
 * Every start on the grid at which the treatment **and its room turnaround** fit inside the window.
 *
 * The grid is aligned to the window's own wall clock, not to the window's start, so that an unrelated
 * maintenance block ending at 14:07 does not move the whole evening's slots off the quarter hour.
 * Two queries of the same day with different closures otherwise return grids that cannot be compared,
 * and the admin calendar and the public booking page stop agreeing about what a slot is.
 *
 * `latestStartIn` from `business-day/windows.ts` is what decides the last one: the 23:40 figure for a
 * 120-minute treatment with a 20-minute turnaround on an 11:00–02:00 day comes from there, and is
 * only ever *offered* when the grid divides it.
 */
export function candidateStarts(args: {
  readonly window: TradingWindow
  readonly durationMinutes: number
  readonly turnaroundMinutes: number
  readonly stepMinutes: number
  readonly zone?: TimeZone
}): Instant[] {
  const { window, durationMinutes, turnaroundMinutes, stepMinutes, zone = ASIA_DUBAI } = args
  assertPositiveMinutes('A treatment duration', durationMinutes)
  assertNonNegativeMinutes('A room turnaround', turnaroundMinutes)
  const latest = latestStartIn(window, durationMinutes, turnaroundMinutes)
  if (latest === undefined) return []
  const starts: Instant[] = []
  for (
    let start = alignToStep(window.startsAt, stepMinutes, zone);
    start <= latest;
    start = addMinutes(start, stepMinutes)
  ) {
    starts.push(start)
  }
  return starts
}

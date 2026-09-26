/**
 * The quiet-hours rule, asserted to the instant and to the calendar day.
 *
 * Every case that says "held" is paired with one that says "open", because "blocked" is the assertion that
 * passes by accident: a rule that held everything would satisfy half this file on its own.
 */

import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  ASIA_DUBAI,
  instantFromIso,
  instantToIso,
  type LocalDate,
  localDate,
  toLocal,
} from '../time.ts'
import {
  type DatedPromotionalOverride,
  decidePromotionalWindow,
  effectivePromotionalHours,
  intersectPromotionalHours,
  MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS,
  nextLocalDate,
  nextPromotionalOpen,
  PROMOTIONAL_OPENING_HORIZON_DAYS,
  type PromotionalHours,
  promotionalHoursAreEmpty,
  RAMADAN_PROMOTIONAL_HOURS,
  withinPromotionalHours,
} from './promotional-window.ts'

/** The registry's default, passed in rather than imported: `packages/core` may not read the registry. */
const CEILING: PromotionalHours = { startHour: 7, endHour: 21 }

/** Asia/Dubai is UTC+4 with no DST, so every local hour below is the Z hour minus four. */
const at = (iso: string) => instantFromIso(iso)
const local = (iso: string) => toLocal(at(iso), ASIA_DUBAI)

const decide = (iso: string, extra: Record<string, unknown> = {}) =>
  decidePromotionalWindow({
    messageClass: 'promotional',
    at: at(iso),
    local: local(iso),
    zone: ASIA_DUBAI,
    ceiling: CEILING,
    ...extra,
  })

describe('the window is open inside the hours and held outside them', () => {
  it('opens a promotional send at 14:00 Asia/Dubai', () => {
    expect(decide('2026-09-18T10:00:00.000Z')).toMatchObject({ kind: 'open' })
  })

  it('opens at exactly 07:00 and holds one millisecond earlier', () => {
    // The inclusive end of the window, asserted to the millisecond rather than to the hour. A rule using
    // `>` instead of `>=` would hold every message posted exactly at the opening, every day, for ever.
    expect(decide('2026-09-18T03:00:00.000Z')).toMatchObject({ kind: 'open' })
    expect(decide('2026-09-18T02:59:59.999Z')).toMatchObject({
      kind: 'queue',
      reason: 'queued_for_window',
    })
  })

  it('holds at exactly 21:00 and opens one millisecond earlier', () => {
    // The exclusive end. 21:00 means "nothing at or after 21:00", so 20:59:59.999 is the last instant.
    expect(decide('2026-09-18T16:59:59.999Z')).toMatchObject({ kind: 'open' })
    expect(decide('2026-09-18T17:00:00.000Z')).toMatchObject({ kind: 'queue' })
  })

  it('releases a 23:30 attempt at the next 07:00 Asia/Dubai, not at midnight and not immediately', () => {
    const decision = decide('2026-09-18T19:30:00.000Z')
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('unreachable')
    // 23:30 on the 18th Dubai time, so the next opening is 07:00 on the 19th = 03:00Z.
    expect(instantToIso(decision.releaseAt)).toBe('2026-09-19T03:00:00.000Z')
  })

  it('releases a 01:30 attempt at 07:00 the SAME calendar day', () => {
    // Trading runs 11:00-02:00, so 01:30 is inside trading hours and outside the promotional window, and
    // the next opening is that morning. A rule that always answered "tomorrow" would hold it 24 hours.
    const decision = decide('2026-09-18T21:30:00.000Z') // 01:30 on the 19th, Dubai
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('unreachable')
    expect(instantToIso(decision.releaseAt)).toBe('2026-09-19T03:00:00.000Z')
  })
})

describe('transactional traffic never enters the rule', () => {
  it('answers not_applicable at 01:30, where a promotional message is held', () => {
    // The 02:00 collision, as a pair against one instant: the same moment, two classes, two answers.
    const instant = '2026-09-18T21:30:00.000Z'
    expect(
      decidePromotionalWindow({
        messageClass: 'transactional',
        at: at(instant),
        local: local(instant),
        zone: ASIA_DUBAI,
        ceiling: CEILING,
      }),
    ).toEqual({ kind: 'not_applicable', reason: 'transactional' })
    expect(decide(instant).kind).toBe('queue')
  })

  it('answers not_applicable even when the overrides would refuse a promotional send outright', () => {
    // A path nobody exercises must not be able to turn an OTP into a held message. The gate returns
    // `allow` before ever reaching here, and this is the second layer of that.
    const instant = '2026-09-18T21:30:00.000Z'
    expect(
      decidePromotionalWindow({
        messageClass: 'transactional',
        at: at(instant),
        local: local(instant),
        zone: ASIA_DUBAI,
        ceiling: CEILING,
        overrides: [widening()],
      }),
    ).toEqual({ kind: 'not_applicable', reason: 'transactional' })
  })
})

// --- dated overrides ----------------------------------------------------------------------------

const ramadan = (from: string, to: string): DatedPromotionalOverride => ({
  fromDate: localDate(from),
  toDate: localDate(to),
  hours: RAMADAN_PROMOTIONAL_HOURS,
  reason: 'Ramadan hours (provisional)',
  openQuestionId: 'Y9-ramadan-window',
})

const widening = (): DatedPromotionalOverride => ({
  fromDate: localDate('2026-09-01'),
  toDate: localDate('2026-09-30'),
  hours: { startHour: 0, endHour: 24 },
  reason: 'September push',
})

describe('a dated override narrows and can never widen', () => {
  it('holds an 08:00 send on a narrowed day and releases it at 10:00 the same day', () => {
    const overrides = [ramadan('2026-09-18', '2026-09-20')]
    // 08:00 Dubai is inside the 07:00-21:00 ceiling and outside the 10:00-16:00 narrowing.
    const decision = decide('2026-09-18T04:00:00.000Z', { overrides })
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('unreachable')
    expect(instantToIso(decision.releaseAt)).toBe('2026-09-18T06:00:00.000Z')
    expect(decision.hours).toEqual(RAMADAN_PROMOTIONAL_HOURS)
  })

  it('opens the same 08:00 send on a day the override does not cover, so the case above is not vacuous', () => {
    const overrides = [ramadan('2026-09-19', '2026-09-20')]
    expect(decide('2026-09-18T04:00:00.000Z', { overrides })).toMatchObject({ kind: 'open' })
  })

  it('releases a 23:30 attempt at 10:00 when the NEXT day is narrowed, not at 07:00', () => {
    // The case that makes the override handling load-bearing rather than decorative: answering 07:00 here
    // would release the message three hours inside the narrowing it exists to respect.
    const decision = decide('2026-09-18T19:30:00.000Z', {
      overrides: [ramadan('2026-09-19', '2026-09-19')],
    })
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('unreachable')
    expect(instantToIso(decision.releaseAt)).toBe('2026-09-19T06:00:00.000Z')
  })

  it('refuses a widening override by name rather than clamping it silently', () => {
    expect(() =>
      effectivePromotionalHours({
        date: localDate('2026-09-18'),
        ceiling: CEILING,
        overrides: [widening()],
      }),
    ).toThrow(AppError)
    expect(() =>
      effectivePromotionalHours({
        date: localDate('2026-09-18'),
        ceiling: CEILING,
        overrides: [widening()],
      }),
    ).toThrow(/may only ever NARROW/)
  })

  it('accepts the narrowing beside it, so the refusal is about widening and not about overrides', () => {
    expect(
      effectivePromotionalHours({
        date: localDate('2026-09-18'),
        ceiling: CEILING,
        overrides: [ramadan('2026-09-18', '2026-09-18')],
      }),
    ).toEqual(RAMADAN_PROMOTIONAL_HOURS)
  })

  it('CONTROL: the intersection alone cannot widen, so the refusal is not the only thing holding', () => {
    // The second layer, driven directly with the refusal out of the path. This is what still holds if
    // somebody deletes the throw above, and it is why the throw is safe to have as a readable message
    // rather than as the mechanism.
    expect(intersectPromotionalHours(CEILING, { startHour: 0, endHour: 24 })).toEqual(CEILING)
    expect(intersectPromotionalHours(CEILING, { startHour: 9, endHour: 30 })).toEqual({
      startHour: 9,
      endHour: 21,
    })
  })

  it('takes the strictest of two overrides covering one day, in either order', () => {
    // Two rows covering one day is legitimate, and the answer must not depend on the order a query
    // returned them in.
    const a = ramadan('2026-09-18', '2026-09-18')
    const b: DatedPromotionalOverride = {
      fromDate: localDate('2026-09-18'),
      toDate: localDate('2026-09-18'),
      hours: { startHour: 12, endHour: 15 },
      reason: 'maintenance',
    }
    const strictest = { startHour: 12, endHour: 15 }
    for (const overrides of [
      [a, b],
      [b, a],
    ]) {
      expect(
        effectivePromotionalHours({ date: localDate('2026-09-18'), ceiling: CEILING, overrides }),
      ).toEqual(strictest)
    }
  })

  it('holds a message through a day whose narrowings leave no minute, and opens on the next real one', () => {
    const disjoint: DatedPromotionalOverride[] = [
      {
        fromDate: localDate('2026-09-19'),
        toDate: localDate('2026-09-19'),
        hours: { startHour: 7, endHour: 10 },
        reason: 'morning only',
      },
      {
        fromDate: localDate('2026-09-19'),
        toDate: localDate('2026-09-19'),
        hours: { startHour: 15, endHour: 21 },
        reason: 'afternoon only',
      },
    ]
    expect(
      promotionalHoursAreEmpty(
        effectivePromotionalHours({
          date: localDate('2026-09-19'),
          ceiling: CEILING,
          overrides: disjoint,
        }),
      ),
    ).toBe(true)

    // 23:30 on the 18th. The 19th permits nothing, so the release is 07:00 on the 20th.
    const decision = decide('2026-09-18T19:30:00.000Z', { overrides: disjoint })
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('unreachable')
    expect(instantToIso(decision.releaseAt)).toBe('2026-09-20T03:00:00.000Z')
  })

  it('refuses to answer when no window opens inside the horizon, rather than searching for ever', () => {
    // Quiet hours switched off by starvation: every message held, for ever, with nothing saying why. The
    // one failure of this module that would look like nothing happening.
    const shut: DatedPromotionalOverride[] = [
      {
        fromDate: localDate('2026-09-01'),
        toDate: localDate('2026-12-31'),
        hours: { startHour: 21, endHour: 21 },
        reason: 'closed',
      },
    ]
    expect(() =>
      nextPromotionalOpen({
        local: local('2026-09-18T19:30:00.000Z'),
        ceiling: CEILING,
        overrides: shut,
        zone: ASIA_DUBAI,
      }),
    ).toThrow(
      new RegExp(`No promotional window opens in the ${PROMOTIONAL_OPENING_HORIZON_DAYS} days`),
    )
  })

  it('finds an opening on the last day of the horizon, so the refusal is not merely a short search', () => {
    const shutUntil: DatedPromotionalOverride[] = [
      {
        fromDate: localDate('2026-09-19'),
        toDate: localDate('2026-09-24'),
        hours: { startHour: 21, endHour: 21 },
        reason: 'closed for six days',
      },
    ]
    // 23:30 on the 18th; the 19th to the 24th permit nothing; the 25th opens at 07:00.
    const decision = decide('2026-09-18T19:30:00.000Z', { overrides: shutUntil })
    expect(decision.kind).toBe('queue')
    if (decision.kind !== 'queue') throw new Error('unreachable')
    expect(instantToIso(decision.releaseAt)).toBe('2026-09-25T03:00:00.000Z')
  })
})

// --- staleness ----------------------------------------------------------------------------------

describe('a message held too long expires unsent', () => {
  const queuedAt = '2026-09-18T19:00:00.000Z' // 23:00 Dubai on the 18th

  it('holds a message that has waited less than the ceiling', () => {
    // Eleven hours and fifty-nine minutes. The 23:00 attempt reaching the 07:00 opening is eight hours,
    // so the ordinary case is comfortably inside.
    const decision = decide('2026-09-19T06:59:00.000Z', { queuedSince: at(queuedAt) })
    expect(decision.kind).toBe('open')
  })

  it('expires it at exactly the ceiling, with the reason and the figures', () => {
    const decision = decide('2026-09-19T07:00:00.000Z', { queuedSince: at(queuedAt) })
    expect(decision).toMatchObject({
      kind: 'expire',
      reason: 'stale_outside_window',
      ageSeconds: MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS,
      maxStalenessSeconds: MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS,
    })
    if (decision.kind !== 'expire') throw new Error('unreachable')
    expect(decision.detail).toContain('Y9-queued-staleness')
    expect(instantToIso(decision.queuedSince)).toBe(queuedAt)
  })

  it('expires a stale message that is INSIDE the window, which is the order that matters', () => {
    // 11:00 Dubai the next day: inside 07:00-21:00, and twelve hours after it was held. A window-first
    // reading would send it — twelve hours late, advertising yesterday, having spent the recipient's
    // frequency allowance to do it.
    const decision = decide('2026-09-19T07:30:00.000Z', { queuedSince: at(queuedAt) })
    expect(decision.kind).toBe('expire')
    // And the same instant with no hold behind it is simply open, so the case above is about staleness.
    expect(decide('2026-09-19T07:30:00.000Z').kind).toBe('open')
  })

  it('never expires a first attempt, however far outside the window it is', () => {
    // `queuedSince` absent means "never held", which cannot go stale. Defaulting it to `at` would have
    // made every first attempt zero seconds old and the distinction unobservable.
    expect(decide('2026-09-18T19:30:00.000Z').kind).toBe('queue')
  })
})

// --- the calendar step --------------------------------------------------------------------------

describe('nextLocalDate', () => {
  const step = (from: string): string => nextLocalDate(localDate(from))

  it('steps an ordinary day, a month end and a year end', () => {
    expect(step('2026-09-18')).toBe('2026-09-19')
    expect(step('2026-09-30')).toBe('2026-10-01')
    expect(step('2026-12-31')).toBe('2027-01-01')
  })

  it('applies the full Gregorian leap rule, including the century cases', () => {
    // 2024 is a leap year, 2026 is not, 2100 is not (divisible by 100) and 2000 is (divisible by 400). A
    // four-year approximation gets the last two wrong, and this build is meant to outlive a fixture.
    expect(step('2024-02-28')).toBe('2024-02-29')
    expect(step('2024-02-29')).toBe('2024-03-01')
    expect(step('2026-02-28')).toBe('2026-03-01')
    expect(step('2100-02-28')).toBe('2100-03-01')
    expect(step('2000-02-28')).toBe('2000-02-29')
  })

  it('steps every day of a whole year without repeating or skipping one', () => {
    // The exhaustive control. A day-length table with one wrong entry passes the spot checks above and
    // fails here, and 2028 is chosen because it is a leap year.
    const seen = new Set<string>()
    let date: LocalDate = localDate('2028-01-01')
    for (let i = 0; i < 366; i += 1) {
      expect(seen.has(date)).toBe(false)
      seen.add(date)
      date = nextLocalDate(date)
    }
    expect(seen.size).toBe(366)
    expect(date).toBe('2029-01-01')
  })
})

describe('withinPromotionalHours reads the wall clock and not the instant', () => {
  it('is true at 07:00 and false at 06:59 in the business zone', () => {
    expect(withinPromotionalHours(local('2026-09-18T03:00:00.000Z'), CEILING)).toBe(true)
    expect(withinPromotionalHours(local('2026-09-18T02:59:00.000Z'), CEILING)).toBe(false)
  })

  it('is false for every hour of a day whose hours are empty', () => {
    const shut: PromotionalHours = { startHour: 21, endHour: 21 }
    for (let hour = 0; hour < 24; hour += 1) {
      const iso = `2026-09-18T${String((hour + 20) % 24).padStart(2, '0')}:30:00.000Z`
      expect(withinPromotionalHours(local(iso), shut), iso).toBe(false)
    }
  })
})

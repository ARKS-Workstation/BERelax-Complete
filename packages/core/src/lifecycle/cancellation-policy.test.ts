import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  CANCELLATION_WINDOW_OPEN_QUESTION,
  CANCELLATION_WINDOW_SETTING_KEY,
  cancellationCharge,
  cancellationVerdictFor,
  cancellationWindowHours,
  classifyCancellation,
  DEFAULT_CANCELLATION_WINDOW_HOURS,
  instantFromEpochMs,
  NO_SHOW_GUARD_REFUSALS,
  noShowClockVerdict,
  noShowVerdictFor,
} from './cancellation-policy.ts'

/**
 * B-LIFE-03's two clock-taking rules, with the clock frozen because it is an argument.
 *
 * Every case here is a boundary, and each boundary is asserted from BOTH sides — one minute inside and one
 * minute outside. A single-sided assertion about a comparison is satisfied by `<`, `<=`, `>` and `>=`
 * alike, so it cannot tell a rule from its inverse.
 */

/** The appointment every case is about: 19:00 Dubai on a Friday. */
const START: Instant = instantFromIso('2099-11-06T15:00:00.000Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const at = (offsetMs: number): Instant => (START + offsetMs) as Instant

describe('the cancellation window is read from a stored value, and a corrupt one reads as the default', () => {
  it('takes a whole number of hours inside the registry bounds', () => {
    expect(cancellationWindowHours(0)).toBe(0)
    expect(cancellationWindowHours(24)).toBe(24)
    expect(cancellationWindowHours(168)).toBe(168)
  })

  it('falls back to 24 for every shape a corrupted row can hold', () => {
    // The control for the three cases below: each of these coerces to 0 through `Number`, and 0 is a
    // LEGAL window, so a reader that coerced would report "flag nothing" for a row nobody wrote.
    for (const corrupt of [null, undefined, false, true, [], {}, '', '   ', 'soon', Number.NaN]) {
      expect(cancellationWindowHours(corrupt), JSON.stringify(corrupt) ?? 'undefined').toBe(
        DEFAULT_CANCELLATION_WINDOW_HOURS,
      )
    }
    // Out of the registry's bounds in both directions, and a fraction of an hour.
    expect(cancellationWindowHours(-1)).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
    expect(cancellationWindowHours(169)).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
    expect(cancellationWindowHours(10_000)).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
    expect(cancellationWindowHours(24.5)).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
  })

  it('reads a numeric string, because an older build’s wider schema may have stored one', () => {
    expect(cancellationWindowHours('48')).toBe(48)
    // And not a string that merely starts with a number — `Number('48h')` is NaN, which is the default.
    expect(cancellationWindowHours('48h')).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
  })

  it('names the registry key and the open question as values rather than in prose', () => {
    expect(CANCELLATION_WINDOW_SETTING_KEY).toBe('booking.cancellation_window_hours')
    expect(CANCELLATION_WINDOW_OPEN_QUESTION).toBe('Y9-windows')
  })
})

describe('a cancellation inside the window is late, and the boundary belongs to the customer', () => {
  const classify = (offsetMs: number, windowHours = 24) =>
    classifyCancellation({ startsAt: START, at: at(offsetMs), windowHours })

  it('is late one minute inside the window and on time one minute outside it', () => {
    // The two sides of the same comparison. Either one alone passes against the wrong operator.
    expect(classify(-24 * HOUR + MINUTE).late).toBe(true)
    expect(classify(-24 * HOUR - MINUTE).late).toBe(false)
  })

  it('is on time at exactly the window boundary', () => {
    // 24 hours to the minute is compliance, not lateness. A boundary that reads the other way flags the
    // customer who did exactly what was asked of them.
    expect(classify(-24 * HOUR).late).toBe(false)
    expect(classify(-24 * HOUR).noticeMinutes).toBe(24 * 60)
  })

  it('is late when the cancellation arrives after the start, with negative notice', () => {
    const verdict = classify(+MINUTE)
    expect(verdict.late).toBe(true)
    expect(verdict.noticeMinutes).toBe(-1)
  })

  it('carries the window that decided it, so the flag can be accounted for later', () => {
    expect(classify(-30 * HOUR, 48).late).toBe(true)
    expect(classify(-30 * HOUR, 48).windowHours).toBe(48)
    expect(classify(-30 * HOUR, 24).late).toBe(false)
  })

  it('normalises a window it was handed, so a nonsense figure cannot reach a stored flag', () => {
    expect(classify(-30 * HOUR, 10_000).windowHours).toBe(DEFAULT_CANCELLATION_WINDOW_HOURS)
  })

  it('flags nothing when the window is zero, which is a legal setting', () => {
    expect(classify(-MINUTE, 0).late).toBe(false)
    // And a cancellation after the start is still late under a zero window: the notice is negative.
    expect(classify(+MINUTE, 0).late).toBe(true)
  })

  it('charges nothing, whatever the notice and whatever the window', () => {
    // The acceptance criterion "creates zero payment, invoice or fee rows" starts here: there is no
    // input to this rule that produces a non-zero amount, so no caller can be handed one to write.
    for (const offset of [-100 * HOUR, -24 * HOUR, -MINUTE, 0, +MINUTE, +100 * HOUR]) {
      for (const window of [0, 1, 24, 48, 168]) {
        const verdict = classify(offset, window)
        expect(verdict.chargeFils, `${offset}ms at ${window}h`).toBe(0)
        expect(verdict.openQuestionId).toBe('Y9-windows')
      }
    }
    expect(cancellationCharge().fils).toBe(0)
    expect(cancellationCharge().why).toContain('no payment, invoice or fee row')
  })
})

describe('NO_SHOW is refused until the start is in the past', () => {
  it('refuses one minute before the start and accepts one minute after', () => {
    // The acceptance criterion, as a frozen-clock pair. The instant is an argument, so this case reads
    // the same at 03:00 as it does at noon.
    const before = noShowClockVerdict({ startsAt: START, at: at(-MINUTE) })
    expect(before.kind).toBe('refused')
    expect(before.kind === 'refused' && before.refusal).toBe('appointment_not_started')
    expect(before.kind === 'refused' && before.minutesUntilStart).toBe(1)

    const after = noShowClockVerdict({ startsAt: START, at: at(+MINUTE) })
    expect(after.kind).toBe('allowed')
    expect(after.kind === 'allowed' && after.minutesSinceStart).toBe(1)
  })

  it('accepts the instant of the start itself', () => {
    // At the start the client either is or is not in the building, so the fact is knowable exactly then.
    expect(noShowClockVerdict({ startsAt: START, at: START }).kind).toBe('allowed')
  })

  it('refuses a start seconds away without claiming a whole minute', () => {
    const verdict = noShowClockVerdict({ startsAt: START, at: at(-1_000) })
    expect(verdict.kind).toBe('refused')
    expect(verdict.kind === 'refused' && verdict.why).toContain('under a minute')
  })

  it('refuses tomorrow’s appointment, which is the failure the guard exists for', () => {
    const verdict = noShowClockVerdict({ startsAt: START, at: at(-24 * HOUR) })
    expect(verdict.kind === 'refused' && verdict.minutesUntilStart).toBe(24 * 60)
    expect(verdict.kind === 'refused' && verdict.why).toContain('wrong appointment')
  })

  it('declares its refusals as values', () => {
    expect([...NO_SHOW_GUARD_REFUSALS]).toEqual(['appointment_not_started'])
  })
})

describe('the boundary adapters brand the epoch milliseconds packages/db hands over', () => {
  it('answers the same verdicts as the branded rules', () => {
    expect(
      cancellationVerdictFor({
        startsAtMs: START,
        atMs: START - 23 * HOUR,
        windowHours: 24,
      }).late,
    ).toBe(true)
    expect(noShowVerdictFor({ startsAtMs: START, atMs: START - MINUTE }).kind).toBe('refused')
    expect(noShowVerdictFor({ startsAtMs: START, atMs: START + MINUTE }).kind).toBe('allowed')
  })

  it('refuses a non-integer instant rather than comparing NaN against every bound', () => {
    // NaN < x and NaN >= x are both false, so an unparsed timestamp would read as "on time" AND as
    // "not started" at the same time — two wrong answers from one missing check.
    expect(() => instantFromEpochMs(Number.NaN, 'the start')).toThrow(AppError)
    expect(() => instantFromEpochMs(1.5, 'the start')).toThrow(/whole epoch milliseconds/)
    expect(() => noShowVerdictFor({ startsAtMs: Number.NaN, atMs: START })).toThrow(
      /whole epoch milliseconds/,
    )
    expect(() =>
      cancellationVerdictFor({ startsAtMs: START, atMs: Number.NaN, windowHours: 24 }),
    ).toThrow(/whole epoch milliseconds/)
    expect(instantFromEpochMs(START, 'the start')).toBe(START)
  })
})

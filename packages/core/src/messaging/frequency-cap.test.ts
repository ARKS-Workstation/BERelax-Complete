import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  assertFrequencyCapLimit,
  countInWindow,
  decideFrequencyCap,
  FREQUENCY_CAP_OPEN_QUESTION,
  FREQUENCY_CAP_SETTING_KEYS,
  FREQUENCY_CAP_WINDOW_SECONDS,
  type FrequencyCap,
  frequencyCapGateEvaluator,
  frequencyCapsFrom,
  frequencyLedgerHorizonSeconds,
  frequencyWindowStart,
  PROVISIONAL_FREQUENCY_CAPS,
} from './frequency-cap.ts'

/**
 * C-AUTO-03 — the rolling-window cap, its boundary, and the three spellings of "switch it off".
 *
 * The boundary cases here are the reason this module takes its instants as arguments. The acceptance line
 * is "a send at day 0 blocks an attempt at day 6 and permits one at day 7, asserted **to the second**, not
 * to the calendar week", and a module that read its own clock could only ever be tested to the day.
 *
 * Every case has its control beside it: where one asserts a refusal, another asserts the value one second
 * or one message away is permitted — because "the cap refuses" is satisfied by a cap that refuses
 * everything, and that is the shape a mistyped comparison actually takes.
 */

const at = (iso: string): Instant => instantFromIso(iso)

const DAY = 86_400_000
const T0 = at('2099-05-01T10:00:00.000Z')
const WEEK = FREQUENCY_CAP_WINDOW_SECONDS.week
const MONTH = FREQUENCY_CAP_WINDOW_SECONDS.month

/** The provisional caps, which are what every real send is decided against. */
const CAPS = PROVISIONAL_FREQUENCY_CAPS
const weekCap = CAPS.find((cap) => cap.key === 'week') as FrequencyCap
const monthCap = CAPS.find((cap) => cap.key === 'month') as FrequencyCap

/** `countedSince` for a decision at `now` that must see every window: the widest horizon. */
const horizon = (now: Instant): Instant =>
  (now - frequencyLedgerHorizonSeconds(CAPS) * 1000) as Instant

const decide = (
  now: Instant,
  countedAt: readonly Instant[],
  messageClass = 'promotional' as const,
) =>
  decideFrequencyCap({
    messageClass,
    now,
    countedAt,
    caps: CAPS,
    countedSince: horizon(now),
  })

describe('the provisional caps carry Y9-frequency-cap and the figures OPEN-QUESTIONS records', () => {
  it('is 2 per rolling 7 days and 6 per rolling 30, longest window first', () => {
    expect(weekCap.limit, 'Y9-frequency-cap: 2 per week').toBe(2)
    expect(monthCap.limit, 'Y9-frequency-cap: 6 per month').toBe(6)
    expect(weekCap.windowSeconds).toBe(7 * 86_400)
    expect(monthCap.windowSeconds).toBe(30 * 86_400)
    // The ORDER is load-bearing: `bound` is the widest breaching window, and the sort that guarantees it
    // is tested below — this asserts the declared order agrees, so the two cannot drift apart silently.
    expect(CAPS.map((cap) => cap.key)).toEqual(['month', 'week'])
    expect(FREQUENCY_CAP_OPEN_QUESTION).toBe('Y9-frequency-cap')
    expect(CAPS.map((cap) => cap.settingKey)).toEqual([
      FREQUENCY_CAP_SETTING_KEYS.month,
      FREQUENCY_CAP_SETTING_KEYS.week,
    ])
  })

  it('reads its horizon from the widest window, so a third cap cannot leave the read short', () => {
    expect(frequencyLedgerHorizonSeconds(CAPS)).toBe(MONTH)
    // The control: a wider cap moves the horizon. A hard-coded 30 days would pass the line above for
    // ever and under-count the day somebody adds a quarterly cap.
    expect(
      frequencyLedgerHorizonSeconds([
        ...CAPS,
        { key: 'month', settingKey: 'x', limit: 12, windowSeconds: 90 * 86_400 },
      ]),
    ).toBe(90 * 86_400)
  })
})

describe('the rolling window, to the second', () => {
  it('excludes a send at exactly the window start and includes one a millisecond later', () => {
    const start = frequencyWindowStart(T0, weekCap)
    expect(countInWindow([start], T0, weekCap), 'exactly 7 days old has aged out').toBe(0)
    expect(countInWindow([(start + 1) as Instant], T0, weekCap), 'one ms inside still counts').toBe(
      1,
    )
  })

  it('does not count a send in the future, which only a bad backfill can produce', () => {
    // A separate case rather than two more lines above, so the two ends of the window have two names: a
    // gate case that breaks one boundary must fail a test that says WHICH boundary, or it proves only that
    // the window is wrong somewhere.
    //
    // A future instant cannot come from the send path — the ledger is written from the same clock the
    // decision uses — but it can come from a backfill, and counting one would refuse every send for a
    // month on the strength of one bad row.
    expect(countInWindow([T0], T0, weekCap), 'a send at `now` counts').toBe(1)
    expect(
      countInWindow([(T0 + 1) as Instant], T0, weekCap),
      'one a millisecond later does not',
    ).toBe(0)
  })

  it('blocks at day 6 and permits at day 7 with the week cap spent, asserted to the second', () => {
    // TWO sends at day 0, because the cap is 2: one send blocks nothing, and a case built on one would
    // be asserting that a cap of 1 refuses — which is not this cap.
    const spent = [T0, (T0 + 1000) as Instant]
    const dayFive = (T0 + 5 * DAY) as Instant
    const day7 = (T0 + WEEK * 1000) as Instant

    expect(decide(dayFive, spent).kind, 'inside the window, cap spent').toBe('capped')
    // One second before the OLDER of the two ages out. Still two in the window, because the second send
    // was a second later — which is what makes this an assertion about seconds rather than about days.
    expect(decide((day7 - 1) as Instant, spent).kind).toBe('capped')
    // At day 7 exactly the first send has aged out, leaving one in the window and one of the two
    // allowances free.
    const atDay7 = decide(day7, spent)
    expect(atDay7.kind, 'the oldest send has aged out at exactly 7 days').toBe('permitted')
    expect(
      atDay7.kind === 'permitted' && atDay7.headroom.find((h) => h.cap.key === 'week'),
    ).toEqual({
      cap: weekCap,
      countInWindow: 1,
      remaining: 1,
    })
  })

  it('is a rolling window and not a calendar week, which is the defect it exists to refuse', () => {
    // Two sends late on a Sunday, then Monday morning. Under a calendar week the counter has reset and
    // two more may leave; under a rolling window they may not, and four messages in twelve hours is what
    // the difference costs somebody.
    const sundayEvening = at('2099-05-03T18:00:00.000Z')
    const spent = [sundayEvening, at('2099-05-03T18:30:00.000Z')]
    const mondayMorning = at('2099-05-04T05:00:00.000Z')
    expect(decide(mondayMorning, spent).kind).toBe('capped')
    // The control: eight days after the Sunday the window really has rolled past both.
    expect(decide(at('2099-05-11T19:00:00.000Z'), spent).kind).toBe('permitted')
  })
})

describe('which cap is reported as the one that bound the send', () => {
  const sendsInLastDays = (now: Instant, days: readonly number[]): readonly Instant[] =>
    days.map((d) => (now - d * DAY) as Instant)

  it('names the week cap when only the week cap is spent', () => {
    const decision = decide(T0, sendsInLastDays(T0, [1, 2]))
    expect(decision.kind).toBe('capped')
    if (decision.kind !== 'capped') return
    expect(decision.bound.cap.key).toBe('week')
    expect(decision.bound.countInWindow).toBe(2)
    expect(decision.breaches.map((b) => b.cap.key)).toEqual(['week'])
  })

  it('names the month cap when only the month cap is spent', () => {
    // Six sends spread over the month with at most one in the last week: the month cap is spent and the
    // week cap has headroom, which is the arm a naive generator almost never produces.
    const decision = decide(T0, sendsInLastDays(T0, [2, 9, 12, 16, 20, 25]))
    expect(decision.kind).toBe('capped')
    if (decision.kind !== 'capped') return
    expect(decision.breaches.map((b) => b.cap.key)).toEqual(['month'])
    expect(decision.bound.cap.key).toBe('month')
    expect(decision.bound.countInWindow).toBe(6)
  })

  it('names the LONGEST window when both are spent, because that is the answer that cannot under-state', () => {
    const decision = decide(T0, sendsInLastDays(T0, [1, 2, 9, 12, 16, 20]))
    expect(decision.kind).toBe('capped')
    if (decision.kind !== 'capped') return
    // Both refuse. Reporting the WEEK would tell somebody "you can message them again in five days" when
    // the real answer is three weeks — an under-statement, and the direction that produces a second
    // refused attempt and a support ticket.
    expect(decision.breaches.map((b) => b.cap.key).sort()).toEqual(['month', 'week'])
    expect(decision.bound.cap.key).toBe('month')
    expect(decision.bound.cap.windowSeconds).toBe(MONTH)
  })

  it('picks the widest breach whatever order the caps arrive in', () => {
    // The control for the sort. `frequencyCapsFrom` fixes the order, and a `breaches[0]` that depended on
    // it would silently report the week cap the day somebody reordered the array.
    const reversed = [weekCap, monthCap]
    const decision = decideFrequencyCap({
      messageClass: 'promotional',
      now: T0,
      countedAt: sendsInLastDays(T0, [1, 2, 9, 12, 16, 20]),
      caps: reversed,
      countedSince: horizon(T0),
    })
    expect(decision.kind === 'capped' && decision.bound.cap.key).toBe('month')
  })
})

describe('the ledger read horizon', () => {
  it('refuses a read that does not reach as far back as a window, naming the cap', () => {
    // A read that went back only a week. The MONTH cap then counts one week of sends and permits, and
    // nothing about the answer looks wrong — which is why this is a throw rather than a warning.
    const tooShort = (T0 - WEEK * 1000) as Instant
    expect(() =>
      decideFrequencyCap({
        messageClass: 'promotional',
        now: T0,
        countedAt: [],
        caps: CAPS,
        countedSince: tooShort,
      }),
    ).toThrow(/month cap's window/)
    // The control: the widest horizon is accepted, and so is one that reaches further back than needed.
    expect(() => decide(T0, [])).not.toThrow()
    expect(() =>
      decideFrequencyCap({
        messageClass: 'promotional',
        now: T0,
        countedAt: [],
        caps: CAPS,
        countedSince: (T0 - 90 * DAY) as Instant,
      }),
    ).not.toThrow()
  })

  it('refuses an empty cap set rather than reading it as "no cap configured"', () => {
    expect(() =>
      decideFrequencyCap({ messageClass: 'promotional', now: T0, countedAt: [], caps: [] }),
    ).toThrow(/An unread cap is not an allowance/)
    // And a transactional message still passes, because it returns before the caps are consulted at all:
    // an unreadable marketing setting must not be able to stop an OTP.
    expect(
      decideFrequencyCap({ messageClass: 'transactional', now: T0, countedAt: [], caps: [] }).kind,
    ).toBe('not_counted')
  })
})

describe('the cap cannot be switched off', () => {
  const key = FREQUENCY_CAP_SETTING_KEYS.week

  it('refuses 0, null, "unlimited", a fraction and a negative, and accepts a whole number', () => {
    for (const refused of [0, null, 'unlimited', 'off', 2.5, -1, undefined, {}, []]) {
      expect(() => assertFrequencyCapLimit(key, refused), `${JSON.stringify(refused)}`).toThrow()
    }
    // The control, and it is not a formality: a validator that threw on everything would satisfy the
    // loop above and refuse every cap the owner could set.
    expect(assertFrequencyCapLimit(key, 1)).toBe(1)
    expect(assertFrequencyCapLimit(key, 14)).toBe(14)
  })

  it('says where the off switch really is, and names the open question', () => {
    let thrown: unknown
    try {
      assertFrequencyCapLimit(key, 0)
    } catch (error) {
      thrown = error
    }
    const message = (thrown as { message?: string } | undefined)?.message ?? ''
    expect(message, 'the refusal is answerable rather than annoying').toContain(
      'marketing kill switch',
    )
    expect(message).toContain('zero reads as "no limit"')
    expect(
      (thrown as { details?: { openQuestionId?: string } } | undefined)?.details?.openQuestionId,
    ).toBe('Y9-frequency-cap')
  })

  it('builds the cap set from stored values and refuses a stored non-cap', () => {
    const built = frequencyCapsFrom({ week: 3, month: 9 })
    expect(built.map((cap) => [cap.key, cap.limit])).toEqual([
      ['month', 9],
      ['week', 3],
    ])
    // The windows come from this module and not from storage, so a stored value cannot widen a window.
    expect(built.map((cap) => cap.windowSeconds)).toEqual([MONTH, WEEK])
    expect(() => frequencyCapsFrom({ week: 0, month: 6 })).toThrow(/not switchable|not a cap/)
    expect(() => frequencyCapsFrom({ week: 2, month: 'unlimited' })).toThrow()
  })
})

describe('the gate evaluator', () => {
  const RECIPIENT = '+971590000701'
  const evaluator = (countedAt: ReadonlyMap<string, readonly Instant[]>) =>
    frequencyCapGateEvaluator({ countedAt, at: T0, caps: CAPS, countedSince: horizon(T0) })

  it('answers false with headroom and true when a cap is spent', () => {
    const clear = evaluator(new Map([[RECIPIENT, []]]))
    expect(clear({ messageClass: 'promotional', recipient: RECIPIENT })).toBe(false)
    const spent = evaluator(new Map([[RECIPIENT, [T0, (T0 - DAY) as Instant]]]))
    expect(spent({ messageClass: 'promotional', recipient: RECIPIENT })).toBe(true)
  })

  it('throws for a recipient the prefetch missed, because an unread ledger is not an allowance', () => {
    const missing = evaluator(new Map([['+971590000702', []]]))
    expect(() => missing({ messageClass: 'promotional', recipient: RECIPIENT })).toThrow(
      /unread ledger is not an allowance/,
    )
    // The distinction this rests on: read-and-empty is a clearance, not-read is not. Without both halves
    // asserted, a campaign that answered `false` for every recipient its prefetch missed would report a
    // clean run having sent past the cap to the contacts it knew least about.
    expect(
      evaluator(new Map([[RECIPIENT, []]]))({ messageClass: 'promotional', recipient: RECIPIENT }),
    ).toBe(false)
  })

  it('answers false for a transactional message even when the prefetch missed the recipient', () => {
    const missing = evaluator(new Map())
    expect(missing({ messageClass: 'transactional', recipient: RECIPIENT })).toBe(false)
  })
})

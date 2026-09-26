import type { MessageClass } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  countInWindow,
  decideFrequencyCap,
  type FrequencyCap,
  type FrequencyCapDecision,
  frequencyLedgerHorizonSeconds,
  PROVISIONAL_FREQUENCY_CAPS,
} from './frequency-cap.ts'

/**
 * The claim the acceptance line states as a cross product: *"over the full (message_class x cap state)
 * cross product, a transactional send is permitted in every cap state and is never written to the
 * ledger"*.
 *
 * ## Why it has to be a property, and what makes it non-vacuous
 *
 * The dangerous implementation is not one that gets transactional wrong — it is one that gets it right by
 * accident, because every cap state it was tested in had headroom. `decideFrequencyCap` returns before
 * consulting any cap for a transactional message, and a version that consulted them first and checked the
 * class afterwards would pass every case a table file happened to write and refuse an OTP on the one day
 * the marketing had been busy. The only way to make those two distinguishable is to drive BOTH classes
 * through cap states that refuse, and to count how many of the generated states actually did.
 *
 * `classCheckedLast` below is that implementation — the in-process known-bad control ADR 0003 asks for —
 * and `caughtClassLast` counts the cases where it disagrees with the real function. The count is asserted
 * to EQUAL the number of transactional cases in a capped arm, not merely to be positive: equality is what
 * says the control disagrees exactly where it should and nowhere else.
 *
 * ## Why the generator is stratified, and what the floors are for
 *
 * The four arms are `clear` (headroom in both windows), `week_only`, `month_only` and `both`, and
 * `month_only` is the one that cannot be reached by luck: it needs six sends inside thirty days with at
 * most ONE inside the last seven, and any generator dense enough to produce six in a month is also dense
 * enough to put two in the last week. A plain weighted generator was measured first and put **236 of 400
 * cases in `clear`** with `month_only` at 42 — 59% of a run spent on the arm that proves the least, which
 * is the shape brief rule 22 is about.
 *
 * So the SHAPE is drawn from four strata and the instants are drawn at random inside each. That is
 * weighting the generator towards inputs that can disagree rather than hoping, and it is stated plainly
 * because the stratification means the arms are not a property of the domain: a stratum aiming at
 * `week_only` still lands in `both` whenever its rest-of-month draw comes out high, which is why the arm
 * is CLASSIFIED from the generated instants rather than taken from the stratum that produced them.
 *
 * The floors are MEASURED over twelve runs of 400 and set at roughly half of each cell's mean — never
 * just under the observed minimum, which becomes its own flake. Per class, out of 200 cases:
 *
 *     clear       min 48   mean 57.6      floor 28
 *     week_only   min 23   mean 33.0      floor 16
 *     month_only  min 33   mean 41.8      floor 20
 *     both        min 53   mean 67.6      floor 32
 */

const CAPS = PROVISIONAL_FREQUENCY_CAPS
const HORIZON_SECONDS = frequencyLedgerHorizonSeconds(CAPS)
const NOW = instantFromIso('2099-06-15T12:00:00.000Z')
const DAY_MS = 86_400_000

/** A send `minDays..maxDays` ago, jittered by seconds so nothing lands exactly on a window boundary. */
const sendIn = (minDays: number, maxDays: number): fc.Arbitrary<Instant> =>
  fc
    .tuple(fc.integer({ min: minDays, max: maxDays }), fc.integer({ min: 1, max: 86_399 }))
    .map(([days, seconds]) => (NOW - days * DAY_MS - seconds * 1000) as Instant)

/**
 * The four strata: how many sends inside the week, inside the rest of the month, and beyond both.
 *
 * The third bucket is not padding. A send outside every window must be counted by nothing, and a
 * generator that never produced one would not test that — a cap that counted a year-old campaign would
 * refuse a contact for ever, and every arm above would still come out right.
 */
const arbitraryLedger: fc.Arbitrary<readonly Instant[]> = fc
  .constantFrom(
    { week: [0, 1] as const, restOfMonth: [0, 4] as const, agedOut: [0, 3] as const },
    { week: [2, 5] as const, restOfMonth: [0, 3] as const, agedOut: [0, 3] as const },
    { week: [0, 1] as const, restOfMonth: [5, 9] as const, agedOut: [0, 2] as const },
    { week: [2, 4] as const, restOfMonth: [4, 8] as const, agedOut: [0, 2] as const },
  )
  .chain((shape) =>
    fc
      .tuple(
        fc.integer({ min: shape.week[0], max: shape.week[1] }),
        fc.integer({ min: shape.restOfMonth[0], max: shape.restOfMonth[1] }),
        fc.integer({ min: shape.agedOut[0], max: shape.agedOut[1] }),
      )
      .chain(([inWeek, inRestOfMonth, agedOut]) =>
        fc
          .tuple(
            fc.array(sendIn(0, 6), { minLength: inWeek, maxLength: inWeek }),
            fc.array(sendIn(7, 29), { minLength: inRestOfMonth, maxLength: inRestOfMonth }),
            fc.array(sendIn(30, 60), { minLength: agedOut, maxLength: agedOut }),
          )
          .map(([recent, older, aged]) => [...recent, ...older, ...aged]),
      ),
  )

const arbitraryClass: fc.Arbitrary<MessageClass> = fc.constantFrom('transactional', 'promotional')

type Arm = 'clear' | 'week_only' | 'month_only' | 'both'

/**
 * Which arm a ledger actually landed in, from `countInWindow` — the primitive the decision uses.
 *
 * Deliberately not a second implementation of the window arithmetic. What this classifies is what the
 * generator produced; a second copy of the rolling-window rule here would turn a disagreement between two
 * counts into what looks like a failed property. The claim under test is about the DECISION, which this
 * does not reimplement, and it is taken from the instants rather than from the stratum because a stratum
 * aiming at one arm regularly lands in another.
 */
function armOf(ledger: readonly Instant[]): Arm {
  const spent = (key: 'week' | 'month') => {
    const cap = CAPS.find((c) => c.key === key) as FrequencyCap
    return countInWindow(ledger, NOW, cap) >= cap.limit
  }
  const week = spent('week')
  const month = spent('month')
  if (week && month) return 'both'
  if (week) return 'week_only'
  if (month) return 'month_only'
  return 'clear'
}

/** The known-bad implementation: the caps consulted first, the class checked afterwards. */
function classCheckedLast(input: {
  readonly messageClass: MessageClass
  readonly countedAt: readonly Instant[]
}): FrequencyCapDecision {
  const breaches = CAPS.map((cap) => ({
    cap,
    countInWindow: countInWindow(input.countedAt, NOW, cap),
  })).filter((b) => b.countInWindow >= b.cap.limit)
  if (breaches.length > 0) {
    const bound = breaches.reduce((a, b) => (b.cap.windowSeconds > a.cap.windowSeconds ? b : a))
    return { kind: 'capped', breaches, bound }
  }
  if (input.messageClass === 'transactional')
    return { kind: 'not_counted', reason: 'transactional' }
  return { kind: 'permitted', headroom: [] }
}

const decide = (messageClass: MessageClass, countedAt: readonly Instant[]): FrequencyCapDecision =>
  decideFrequencyCap({
    messageClass,
    now: NOW,
    countedAt,
    caps: CAPS,
    countedSince: (NOW - HORIZON_SECONDS * 1000) as Instant,
  })

/**
 * The transactional half: `not_counted` rather than `permitted`, in every arm.
 *
 * The distinction between the two answers is the second half of the acceptance line rather than a naming
 * preference: `permitted` is what a caller writes a ledger row for, and an OTP that spent a marketing
 * allowance would make the cap a function of how often somebody logs in.
 */
function assertTransactional(decision: FrequencyCapDecision, arm: Arm): void {
  expect(decision.kind, `transactional in the ${arm} arm`).toBe('not_counted')
  expect(decision.kind === 'not_counted' && decision.reason).toBe('transactional')
}

/** The promotional half: permitted only in `clear`, and the widest breaching cap named in the rest. */
function assertPromotional(decision: FrequencyCapDecision, arm: Arm): void {
  if (arm === 'clear') {
    expect(decision.kind, 'promotional with headroom in both windows').toBe('permitted')
    return
  }
  expect(decision.kind, `promotional in the ${arm} arm`).toBe('capped')
  if (decision.kind !== 'capped') return
  // The cap reported as having bound the send is the WIDEST that refuses, in every arm — including
  // `both`, which is the arm the rule exists for.
  const widest = decision.breaches.reduce((a, b) =>
    b.cap.windowSeconds > a.cap.windowSeconds ? b : a,
  )
  expect(decision.bound).toEqual(widest)
  expect(decision.bound.countInWindow).toBeGreaterThanOrEqual(decision.bound.cap.limit)
  expect(decision.breaches.map((b) => b.cap.key).sort()).toEqual(
    arm === 'both' ? ['month', 'week'] : arm === 'week_only' ? ['week'] : ['month'],
  )
}

describe('the (message_class x cap state) cross product', () => {
  it('permits a transactional send in every cap state and counts it in none', () => {
    const cells = new Map<string, number>()
    let caughtClassLast = 0

    fc.assert(
      fc.property(arbitraryClass, arbitraryLedger, (messageClass, ledger) => {
        const arm = armOf(ledger)
        const cell = `${messageClass}:${arm}`
        cells.set(cell, (cells.get(cell) ?? 0) + 1)

        const decision = decide(messageClass, ledger)
        if (messageClass === 'transactional') assertTransactional(decision, arm)
        else assertPromotional(decision, arm)

        if (classCheckedLast({ messageClass, countedAt: ledger }).kind !== decision.kind) {
          caughtClassLast += 1
        }
      }),
      { numRuns: 400 },
    )

    // Measured over twelve runs of 400; see the header for the observed minimum and mean behind each.
    const FLOORS: Readonly<Record<Arm, number>> = {
      clear: 28,
      week_only: 16,
      month_only: 20,
      both: 32,
    }
    for (const messageClass of ['transactional', 'promotional'] as const) {
      for (const arm of ['clear', 'week_only', 'month_only', 'both'] as const) {
        expect(
          cells.get(`${messageClass}:${arm}`) ?? 0,
          `generated ${messageClass} cases in the ${arm} arm`,
        ).toBeGreaterThanOrEqual(FLOORS[arm])
      }
    }

    // The control. Every transactional case in a capped arm is one the class-last implementation answers
    // `capped` for, and nothing else can differ — so this equality says the property distinguishes the
    // two implementations exactly where the defect lives.
    const transactionalInCappedArms =
      (cells.get('transactional:week_only') ?? 0) +
      (cells.get('transactional:month_only') ?? 0) +
      (cells.get('transactional:both') ?? 0)
    expect(caughtClassLast).toBe(transactionalInCappedArms)
    expect(
      caughtClassLast,
      'cases where checking the class last would refuse an OTP',
    ).toBeGreaterThan(0)
  }, 30_000) // hundreds of cases against vitest's undeclared 5,000 ms default (brief rule 21).

  it('never counts a send that is outside every window, and reports full headroom', () => {
    let cases = 0
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 30, max: 400 }), { minLength: 1, maxLength: 9 }),
        (daysAgo) => {
          cases += 1
          const ledger = daysAgo.map((d) => (NOW - d * DAY_MS - 1000) as Instant)
          const decision = decide('promotional', ledger)
          // Up to nine sends, every one older than both windows: permitted with FULL headroom. A cap that
          // counted them would refuse a contact for ever on the strength of a year-old campaign.
          expect(decision.kind).toBe('permitted')
          if (decision.kind !== 'permitted') return
          for (const headroom of decision.headroom) {
            expect(headroom.countInWindow).toBe(0)
            expect(headroom.remaining).toBe(headroom.cap.limit)
          }
        },
      ),
      { numRuns: 200 },
    )
    // Not a formality: `fc.assert` with a property that threw before its first assertion would leave this
    // at 0, and the loop above would have proved nothing.
    expect(cases).toBe(200)
  }, 30_000)
})

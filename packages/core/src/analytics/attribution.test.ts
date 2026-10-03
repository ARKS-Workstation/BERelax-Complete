import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_BASES,
  attributionCoverageOf,
  firstTouchOf,
  isAttributedSource,
  lastTouchBeforeOf,
  OFFLINE_MEDIUM,
  OFFLINE_SOURCE,
  offlineTouchFor,
  type TouchCandidate,
  touchFromCandidate,
  UNKNOWN_SOURCE,
} from './attribution.ts'
import { ORIGINATION_BASES } from './origination.ts'

const touch = (
  sessionReference: string,
  occurredAtMs: number,
  source = 'google',
): TouchCandidate => ({
  basis: 'utm',
  source,
  medium: 'cpc',
  campaign: 'spring',
  sessionReference,
  occurredAtMs,
})

/** Every permutation of a three-element list, so "shuffled" is exhaustive rather than sampled. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  )
}

describe('the attribution bases', () => {
  it('are origination’s four plus offline, derived rather than restated', () => {
    expect([...ATTRIBUTION_BASES]).toEqual([...ORIGINATION_BASES, 'offline'])
    // The control: a basis list that had lost its derivation would not contain the web ones. Asserted
    // separately because the equality above passes just as happily on a hand-written copy that happens
    // to agree today, and `db` cannot import this module (ADR 0001) so the copy is the real hazard.
    for (const basis of ORIGINATION_BASES) expect(ATTRIBUTION_BASES).toContain(basis)
    expect(ATTRIBUTION_BASES).toContain('offline')
  })
})

describe('the first touch', () => {
  it('is the earliest session whatever order the sessions arrive in', () => {
    const sessions = [
      touch('00000000-0000-7000-8000-000000000003', 3_000, 'facebook'),
      touch('00000000-0000-7000-8000-000000000001', 1_000, 'google'),
      touch('00000000-0000-7000-8000-000000000002', 2_000, 'bing'),
    ]
    const answers = permutations(sessions).map((order) => firstTouchOf(order)?.source)
    expect(answers).toHaveLength(6)
    expect(new Set(answers)).toEqual(new Set(['google']))
  })

  it('breaks a tie on the session reference, so the answer is total', () => {
    const a = touch('00000000-0000-7000-8000-00000000000a', 1_000, 'a-source')
    const b = touch('00000000-0000-7000-8000-00000000000b', 1_000, 'b-source')
    // The control that makes this case non-vacuous: with the instants equal, a comparator reading the
    // instant ALONE answers whichever row sorted first, so the two orders would disagree.
    expect(firstTouchOf([a, b])?.source).toBe('a-source')
    expect(firstTouchOf([b, a])?.source).toBe('a-source')
  })

  it('is undefined for a customer with no session, rather than an offline touch', () => {
    expect(firstTouchOf([])).toBeUndefined()
  })
})

describe('the last touch', () => {
  const sessions = [
    touch('00000000-0000-7000-8000-000000000001', 1_000, 'google'),
    touch('00000000-0000-7000-8000-000000000002', 2_000, 'bing'),
    touch('00000000-0000-7000-8000-000000000009', 9_000, 'after-the-booking'),
  ]

  it('is the most recent session starting at or before the booking', () => {
    expect(lastTouchBeforeOf(sessions, 5_000)?.source).toBe('bing')
  })

  it('never takes a session that started after the booking', () => {
    // The control: the 9,000 session IS the most recent one in the list, so a resolver with no bound
    // would answer `after-the-booking` for every one of these.
    for (const order of permutations(sessions)) {
      expect(lastTouchBeforeOf(order, 5_000)?.source).toBe('bing')
    }
    expect(lastTouchBeforeOf(sessions, 10_000)?.source).toBe('after-the-booking')
  })

  it('includes a session that began in the same millisecond as the booking', () => {
    expect(lastTouchBeforeOf(sessions, 2_000)?.source).toBe('bing')
    expect(lastTouchBeforeOf(sessions, 1_999)?.source).toBe('google')
  })

  it('is undefined when every session started after the booking', () => {
    expect(lastTouchBeforeOf(sessions, 500)).toBeUndefined()
  })
})

describe('the offline touch', () => {
  it('carries the offline source, the direct medium and no session', () => {
    const offline = offlineTouchFor({ occurredAtMs: 7_000, howHeard: 'Passing on Al Wasl Road' })
    expect(offline.basis).toBe('offline')
    expect(offline.source).toBe(OFFLINE_SOURCE)
    expect(offline.medium).toBe(OFFLINE_MEDIUM)
    expect(offline.sessionReference).toBeNull()
    expect(offline.howHeard).toBe('Passing on Al Wasl Road')
    expect(offline.campaign).toBe('')
  })

  it('reduces a blank how-heard to null rather than storing an answer nobody gave', () => {
    expect(offlineTouchFor({ occurredAtMs: 1, howHeard: '   ' }).howHeard).toBeNull()
    expect(offlineTouchFor({ occurredAtMs: 1 }).howHeard).toBeNull()
    expect(offlineTouchFor({ occurredAtMs: 1, howHeard: null }).howHeard).toBeNull()
  })

  it('carries no how-heard when the touch came through a browser', () => {
    expect(touchFromCandidate(touch('00000000-0000-7000-8000-000000000001', 1)).howHeard).toBeNull()
  })
})

describe('attribution coverage', () => {
  it('counts neither offline nor unknown towards the numerator', () => {
    expect(isAttributedSource('google')).toBe(true)
    expect(isAttributedSource(OFFLINE_SOURCE)).toBe(false)
    expect(isAttributedSource(UNKNOWN_SOURCE)).toBe(false)
  })

  it('is the share of paid bookings with an attributed source, in per mille', () => {
    const coverage = attributionCoverageOf([
      'google',
      'facebook',
      OFFLINE_SOURCE,
      UNKNOWN_SOURCE,
      'direct',
    ])
    expect(coverage.kind).toBe('coverage')
    if (coverage.kind !== 'coverage') throw new Error('unreachable')
    expect(coverage.paidBookings).toBe(5)
    // `direct` IS attributed: it is a web session whose origination could not be resolved, which is a
    // different fact from a booking that never touched a browser. The control for that is the pair of
    // excluded values above — a resolver that treated `direct` as unattributed would answer 400.
    expect(coverage.attributedBookings).toBe(3)
    expect(coverage.coveragePerMille).toBe(600)
  })

  it('has no figure at all for a window with no paid booking', () => {
    const coverage = attributionCoverageOf([])
    expect(coverage.kind).toBe('no_paid_bookings')
    if (coverage.kind !== 'no_paid_bookings') throw new Error('unreachable')
    expect(coverage.why).toContain('no figure')
  })

  it('rounds rather than truncates', () => {
    // 2/3 is 666.67 per mille. A truncation answers 666, which reads as the lower figure for ever.
    const coverage = attributionCoverageOf(['google', 'facebook', OFFLINE_SOURCE])
    if (coverage.kind !== 'coverage') throw new Error('unreachable')
    expect(coverage.coveragePerMille).toBe(667)
  })
})

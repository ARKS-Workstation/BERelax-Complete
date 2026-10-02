import { WHATSAPP_REF_OPEN_QUESTION, WHATSAPP_REF_TTL_OPEN_QUESTION } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Instant } from '../time.ts'
import {
  decideRefCapture,
  EMPTY_REF_CAPTURE_COUNTS,
  formatCapturedBp,
  REF_CAPTURE_OUTCOMES,
  RESOLVED_REF_CAPTURE_OUTCOMES,
  type RefCaptureCounts,
  refCaptureRate,
  refIssueCaptureRate,
} from './ref-capture.ts'

/**
 * The instant every decision below is taken at, and the customer taking the booking.
 *
 * Both are arguments rather than defaults because `@berelax/core` reads no clock and has no session: the
 * expiry comparison and the conflict comparison are made against values the caller supplies, which is what
 * A-FIRST-07 added to this function. The cases that are not ABOUT the lifetime or the conflict use
 * {@link liveMatch}, whose expiry is far enough ahead that it can never be the thing under test.
 */
const AT = Date.parse('2026-03-01T12:00:00Z') as Instant
const CUSTOMER = '11111111-1111-7111-8111-111111111111'
const SESSION = '22222222-2222-7222-8222-222222222222'
const DAY_MS = 24 * 60 * 60 * 1000

/** A code that exists, is alive, and nobody has claimed. The ordinary match. */
const liveMatch = (refCode: string) => ({
  refCode,
  sessionId: SESSION,
  expiresAt: (AT + 7 * DAY_MS) as Instant,
  claimedByCustomerId: null,
})

/**
 * B-UI-04 — the attribution rule, and the property that is the whole of it.
 *
 * The property test is not decoration here. The claim the unit makes to the owner is *"a ref field the
 * front desk will not fill degrades to attribution unknown and never to an invented attribution"*, and
 * that is a statement about every possible input rather than about the four the examples cover. So it is
 * asserted over arbitrary strings AND over the case the generator would otherwise almost never produce —
 * a match — with a count of how many generated cases could actually exercise each branch, because a
 * generator that never produces a match would satisfy "no attribution without a row" vacuously (the brief's
 * rule 22, which cost this repository a run).
 */

describe('decideRefCapture — an attribution is a row that exists, or nothing', () => {
  it('records the match the caller found, and keeps no typed text beside it', () => {
    const decision = decideRefCapture({
      entered: 'ab23',
      matched: liveMatch('AB23'),
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('matched')
    expect(decision.refCode).toBe('AB23')
    // The attribution is the CODE's session and there is nothing else in scope it could be (A-FIRST-07).
    expect(decision.attributedSessionId).toBe(SESSION)
    // Null, not 'AB23' again: the code is one fact and storing it twice is two places it can disagree.
    expect(decision.enteredCode).toBeNull()
    expect(decision.warns).toBe(false)
  })

  it('takes the row over its own opinion of the shape', () => {
    // A row whose code this build's alphabet would refuse is still a row, and its own CHECK constraint
    // proved its shape. Re-deriving the shape here would discard a real match — the worst outcome
    // available — so the lookup wins.
    const decision = decideRefCapture({
      entered: 'ab2o',
      matched: liveMatch('AB2O'),
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('matched')
    expect(decision.refCode).toBe('AB2O')
  })

  it('reports a blank field as nothing claimed, with no warning', () => {
    for (const blank of ['', '   ', '\t\n']) {
      const decision = decideRefCapture({
        entered: blank,
        matched: null,
        at: AT,
        customerId: CUSTOMER,
      })
      expect(decision.outcome, JSON.stringify(blank)).toBe('not_offered')
      expect(decision.refCode).toBeNull()
      expect(decision.enteredCode).toBeNull()
      // The field is optional. A warning for leaving an optional field alone is a screen that cries wolf.
      expect(decision.warns).toBe(false)
    }
  })

  it('keeps what was typed when it matched nothing, and warns', () => {
    const decision = decideRefCapture({
      entered: ' zz99 ',
      matched: null,
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('unknown_code')
    expect(decision.refCode).toBeNull()
    // Normalised, so a code A-FIRST issues LATER joins against it. A lower-case copy would not.
    expect(decision.enteredCode).toBe('ZZ99')
    expect(decision.warns).toBe(true)
  })

  it('keeps an unmatchable value verbatim rather than discarding the evidence', () => {
    // 'AB-23' can never be a code, so there is nothing to normalise it to — and dropping it would lose the
    // one signal that says the desk IS pasting something, which is a different finding from silence.
    const decision = decideRefCapture({
      entered: 'AB-23',
      matched: null,
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('unknown_code')
    expect(decision.enteredCode).toBe('AB-23')
  })

  it('never invents an attribution, over arbitrary input', () => {
    let matched = 0
    let unknown = 0
    let blank = 0
    fc.assert(
      fc.property(
        fc.string({ maxLength: 12 }),
        // A match half the time, so both branches are exercised rather than one being asserted 200 times.
        fc.option(fc.stringMatching(/^[A-HJ-NP-Z2-9]{4}$/), { nil: null, freq: 2 }),
        (entered, matchedRefCode) => {
          const decision = decideRefCapture({
            entered,
            matched: matchedRefCode === null ? null : liveMatch(matchedRefCode),
            at: AT,
            customerId: CUSTOMER,
          })
          expect(REF_CAPTURE_OUTCOMES).toContain(decision.outcome)
          // THE property: a code is recorded exactly when the caller supplied a row, and it is that row.
          expect(decision.refCode).toBe(matchedRefCode)
          expect(decision.refCode !== null).toBe(decision.outcome === 'matched')
          // A warning exactly when something was typed and matched nothing.
          expect(decision.warns).toBe(decision.outcome === 'unknown_code')
          // And the typed text is kept on that branch alone, so no other outcome can carry a value a
          // reader might mistake for an attribution.
          expect(decision.enteredCode !== null).toBe(decision.outcome === 'unknown_code')
          // And the ATTRIBUTION on that branch alone, which is A-FIRST-07's half of the same property:
          // there is no generated input from which a session could be credited without a row.
          expect(decision.attributedSessionId !== null).toBe(decision.outcome === 'matched')
          if (decision.outcome === 'matched') matched += 1
          else if (decision.outcome === 'unknown_code') unknown += 1
          else blank += 1
        },
      ),
      { numRuns: 500 },
    )
    // The non-vacuity count, against floors well under the MEASURED minima (rule 22): a generator that
    // stopped producing matches, or stopped producing blanks, would leave a third of the property untested
    // while the run stayed green. Measured over twelve runs of 500 cases, the minima were matched 234,
    // unknown 211, blank 20 — so these floors sit five to six times under them rather than just under,
    // because a floor set just under an observed minimum becomes its own flake.
    expect(matched, 'generated matches').toBeGreaterThan(40)
    expect(unknown, 'generated unknown codes').toBeGreaterThan(40)
    expect(blank, 'generated blank fields').toBeGreaterThan(3)
  })
})

describe('refCaptureRate — the rate, and what it is entitled to claim', () => {
  // A SPREAD of the empty value and never a cast: an absent count and a count of zero are the same claim
  // here, and a cast would let this helper omit a field the denominator needs.
  const counts = (over: Partial<RefCaptureCounts> = {}): RefCaptureCounts => ({
    ...EMPTY_REF_CAPTURE_COUNTS,
    ...over,
  })

  it('reports no rate at all for an empty set rather than 0%', () => {
    const rate = refCaptureRate(counts())
    expect(rate.total).toBe(0)
    expect(rate.capturedBp).toBeNull()
    expect(rate.claim).toBe('no_bookings')
  })

  it('reports the rate as unconfirmed while nobody has said the desk should paste the code', () => {
    const rate = refCaptureRate(counts({ matched: 1, notOffered: 3 }))
    expect(rate.total).toBe(4)
    expect(rate.capturedBp).toBe(2_500)
    expect(rate.claim).toBe('loop_unconfirmed')
    expect(rate.openQuestionId).toBe(WHATSAPP_REF_OPEN_QUESTION)
  })

  it('reports it as a measurement once the loop is confirmed, and then cites no question', () => {
    const rate = refCaptureRate(counts({ matched: 1, notOffered: 3 }), { expected: true })
    // The same arithmetic and a different claim, which is the whole reason the claim is a field.
    expect(rate.capturedBp).toBe(2_500)
    expect(rate.claim).toBe('measured')
    expect(rate.openQuestionId).toBeNull()
  })

  it('treats an absent option as the provisional value, not as confirmed', () => {
    // Fail-safe by omission: a caller that has never heard of the setting must not be able to turn an
    // unanswered question into a claim about the front desk.
    expect(refCaptureRate(counts({ matched: 1 })).claim).toBe('loop_unconfirmed')
    expect(refCaptureRate(counts({ matched: 1 }), {}).claim).toBe('loop_unconfirmed')
  })

  it('counts an unknown code in the denominator and never in the numerator', () => {
    // The honest reading: a typed code we have no row for is a booking whose attribution is unknown, so
    // it must not improve the capture rate. Putting it in the numerator is the single most tempting way to
    // make this screen look like it works.
    const rate = refCaptureRate(counts({ matched: 1, unknownCode: 1 }))
    expect(rate.total).toBe(2)
    expect(rate.capturedBp).toBe(5_000)
  })

  it('rounds to the nearest basis point and carries the counts so nobody has to trust it', () => {
    const rate = refCaptureRate(counts({ matched: 1, notOffered: 2 }))
    expect(rate.capturedBp).toBe(3_333)
    expect(rate.counts).toEqual(counts({ matched: 1, notOffered: 2 }))
  })
})

describe('decideRefCapture — a code that resolved and still produced no attribution', () => {
  it('records an expired code as expired, keeps the code, and claims no session', () => {
    const decision = decideRefCapture({
      entered: '7k2q',
      matched: {
        refCode: '7K2Q',
        sessionId: SESSION,
        // One millisecond before the capture instant. The boundary is tested below; this is the plain case.
        expiresAt: (AT - 1) as Instant,
        claimedByCustomerId: null,
      },
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('ref_expired')
    // The code is KEPT, because "the desk pasted a code we issued three weeks ago" is a finding about the
    // TTL and the code is the evidence for it. The attribution is not.
    expect(decision.refCode).toBe('7K2Q')
    expect(decision.attributedSessionId).toBeNull()
    expect(decision.enteredCode).toBeNull()
    expect(decision.warns).toBe(true)
  })

  it('treats the expiry instant itself as expired, which is the database’s own boundary', () => {
    // `<=` here and `v_expires <= new.recorded_at` in 0127's trigger. The two comparisons are one claim in
    // two languages, and a strict-versus-inclusive difference between them would surface as a ZY331 on
    // exactly one booking a week — a code claimed in the millisecond it died.
    const atExpiry = decideRefCapture({
      entered: '7K2Q',
      matched: { refCode: '7K2Q', sessionId: SESSION, expiresAt: AT, claimedByCustomerId: null },
      at: AT,
      customerId: CUSTOMER,
    })
    expect(atExpiry.outcome).toBe('ref_expired')
    // And one millisecond earlier it is still alive, so the boundary is a boundary and not a blanket.
    const justAlive = decideRefCapture({
      entered: '7K2Q',
      matched: {
        refCode: '7K2Q',
        sessionId: SESSION,
        expiresAt: (AT + 1) as Instant,
        claimedByCustomerId: null,
      },
      at: AT,
      customerId: CUSTOMER,
    })
    expect(justAlive.outcome).toBe('matched')
  })

  it('records a code another customer has claimed as a conflict, and does not reassign it', () => {
    const decision = decideRefCapture({
      entered: '7K2Q',
      matched: {
        refCode: '7K2Q',
        sessionId: SESSION,
        expiresAt: (AT + 7 * DAY_MS) as Instant,
        claimedByCustomerId: '99999999-9999-7999-8999-999999999999',
      },
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('ref_conflict')
    expect(decision.refCode).toBe('7K2Q')
    // The whole of "surfaces it rather than reassigning silently": no attribution is produced, so the
    // earlier claim keeps the conversation and this booking says why it has none.
    expect(decision.attributedSessionId).toBeNull()
    expect(decision.warns).toBe(true)
  })

  it('is not a conflict when the same customer books twice out of one conversation', () => {
    // The code identifies a CONVERSATION, so both of that person's bookings came from it. Keying the
    // conflict on the booking rather than on the customer would have made a returning customer a stranger.
    const decision = decideRefCapture({
      entered: '7K2Q',
      matched: {
        refCode: '7K2Q',
        sessionId: SESSION,
        expiresAt: (AT + 7 * DAY_MS) as Instant,
        claimedByCustomerId: CUSTOMER,
      },
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('matched')
    expect(decision.attributedSessionId).toBe(SESSION)
  })

  it('reports an expired code that is also claimed as EXPIRED, which is the useful answer', () => {
    // The order of the two tests is the rule. The expiry is a fact about our own issuing and the conflict
    // is a fact about two customers; telling the desk "another customer has this code" about a code that
    // was dead anyway sends them to ask the wrong question.
    const decision = decideRefCapture({
      entered: '7K2Q',
      matched: {
        refCode: '7K2Q',
        sessionId: SESSION,
        expiresAt: (AT - DAY_MS) as Instant,
        claimedByCustomerId: '99999999-9999-7999-8999-999999999999',
      },
      at: AT,
      customerId: CUSTOMER,
    })
    expect(decision.outcome).toBe('ref_expired')
  })

  it('carries a code for exactly the outcomes 0127’s CHECK says may carry one', () => {
    // The TypeScript half of `booking_whatsapp_ref_capture_resolved_names_its_ref`, asserted over the list
    // rather than over examples: a sixth outcome added to REF_CAPTURE_OUTCOMES and not classified in
    // RESOLVED_REF_CAPTURE_OUTCOMES is a failure here rather than a row the database refuses at a counter.
    const live = {
      refCode: '7K2Q',
      sessionId: SESSION,
      expiresAt: (AT + 7 * DAY_MS) as Instant,
      claimedByCustomerId: null,
    }
    const decisions = [
      decideRefCapture({ entered: '7K2Q', matched: live, at: AT, customerId: CUSTOMER }),
      decideRefCapture({
        entered: '7K2Q',
        matched: { ...live, expiresAt: (AT - 1) as Instant },
        at: AT,
        customerId: CUSTOMER,
      }),
      decideRefCapture({
        entered: '7K2Q',
        matched: { ...live, claimedByCustomerId: 'somebody-else' },
        at: AT,
        customerId: CUSTOMER,
      }),
      decideRefCapture({ entered: 'ZZ99', matched: null, at: AT, customerId: CUSTOMER }),
      decideRefCapture({ entered: '  ', matched: null, at: AT, customerId: CUSTOMER }),
    ]
    // Every outcome is produced, so the implication below is asserted over the whole union rather than
    // over whichever three a shorter list happened to reach.
    expect([...new Set(decisions.map((decision) => decision.outcome))].sort()).toEqual(
      [...REF_CAPTURE_OUTCOMES].sort(),
    )
    for (const decision of decisions) {
      expect(
        decision.refCode !== null,
        `${decision.outcome} carries ${String(decision.refCode)}`,
      ).toBe(RESOLVED_REF_CAPTURE_OUTCOMES.includes(decision.outcome))
      expect(decision.attributedSessionId !== null).toBe(decision.outcome === 'matched')
    }
  })
})

describe('refIssueCaptureRate — claimed codes over issued codes', () => {
  it('yields exactly 40.0% for ten issued and four claimed, which is the acceptance figure', () => {
    const rate = refIssueCaptureRate({ issued: 10, claimed: 4 })
    // Basis points, so the figure is exact rather than nearly: 4 / 10 is one of the ratios a float gets
    // right and 1 / 3 is not, and a report that was exact for some denominators is worse than one that is
    // exact for all of them.
    expect(rate.claimedBp).toBe(4_000)
    expect(formatCapturedBp(rate.claimedBp)).toBe('40.0%')
  })

  it('reports no rate at all for a day that issued nothing, rather than 0%', () => {
    const rate = refIssueCaptureRate({ issued: 0, claimed: 0 })
    expect(rate.claimedBp).toBeNull()
    expect(rate.claim).toBe('no_codes_issued')
    // The word and not `0.0%`: this is the state the build is in, because the issue path refuses while
    // `premises.phone_whatsapp` holds the Y1-nap placeholder, and 0% would read as a front-desk failure.
    expect(formatCapturedBp(rate.claimedBp)).toBe('no rate')
  })

  it('reports the rate as unconfirmed until somebody says the desk should paste the code', () => {
    const rate = refIssueCaptureRate({ issued: 10, claimed: 4 })
    expect(rate.claim).toBe('loop_unconfirmed')
    expect([...rate.openQuestionIds]).toEqual([
      WHATSAPP_REF_OPEN_QUESTION,
      WHATSAPP_REF_TTL_OPEN_QUESTION,
    ])
  })

  it('still carries the TTL question once the loop is confirmed', () => {
    const rate = refIssueCaptureRate({ issued: 10, claimed: 4 }, { expected: true })
    expect(rate.claim).toBe('measured')
    // The loop being confirmed does not answer how long a code should live, and a denominator computed
    // against a window nobody chose is still provisional. A report that stopped saying so would read as
    // settled.
    expect([...rate.openQuestionIds]).toEqual([WHATSAPP_REF_TTL_OPEN_QUESTION])
  })

  it('treats an absent `expected` as the provisional value and never as true', () => {
    // Fail-safe by OMISSION: a caller that has never heard of the setting must not be able to turn an
    // unanswered question into a claim about the front desk.
    expect(refIssueCaptureRate({ issued: 1, claimed: 0 }).claim).toBe('loop_unconfirmed')
    expect(refIssueCaptureRate({ issued: 1, claimed: 0 }, {}).claim).toBe('loop_unconfirmed')
  })

  it('rounds to the nearest basis point and prints one decimal place', () => {
    // 1 / 3 is the case a float would make 33.33333333333333% and a percentage-as-integer would make 33%.
    expect(refIssueCaptureRate({ issued: 3, claimed: 1 }).claimedBp).toBe(3_333)
    expect(formatCapturedBp(3_333)).toBe('33.3%')
    expect(formatCapturedBp(10_000)).toBe('100.0%')
    expect(formatCapturedBp(0)).toBe('0.0%')
  })
})

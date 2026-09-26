import { WHATSAPP_REF_OPEN_QUESTION } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  decideRefCapture,
  REF_CAPTURE_OUTCOMES,
  type RefCaptureCounts,
  refCaptureRate,
} from './ref-capture.ts'

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
    const decision = decideRefCapture({ entered: 'ab23', matchedRefCode: 'AB23' })
    expect(decision.outcome).toBe('matched')
    expect(decision.refCode).toBe('AB23')
    // Null, not 'AB23' again: the code is one fact and storing it twice is two places it can disagree.
    expect(decision.enteredCode).toBeNull()
    expect(decision.warns).toBe(false)
  })

  it('takes the row over its own opinion of the shape', () => {
    // A row whose code this build's alphabet would refuse is still a row, and its own CHECK constraint
    // proved its shape. Re-deriving the shape here would discard a real match — the worst outcome
    // available — so the lookup wins.
    const decision = decideRefCapture({ entered: 'ab2o', matchedRefCode: 'AB2O' })
    expect(decision.outcome).toBe('matched')
    expect(decision.refCode).toBe('AB2O')
  })

  it('reports a blank field as nothing claimed, with no warning', () => {
    for (const blank of ['', '   ', '\t\n']) {
      const decision = decideRefCapture({ entered: blank, matchedRefCode: null })
      expect(decision.outcome, JSON.stringify(blank)).toBe('not_offered')
      expect(decision.refCode).toBeNull()
      expect(decision.enteredCode).toBeNull()
      // The field is optional. A warning for leaving an optional field alone is a screen that cries wolf.
      expect(decision.warns).toBe(false)
    }
  })

  it('keeps what was typed when it matched nothing, and warns', () => {
    const decision = decideRefCapture({ entered: ' zz99 ', matchedRefCode: null })
    expect(decision.outcome).toBe('unknown_code')
    expect(decision.refCode).toBeNull()
    // Normalised, so a code A-FIRST issues LATER joins against it. A lower-case copy would not.
    expect(decision.enteredCode).toBe('ZZ99')
    expect(decision.warns).toBe(true)
  })

  it('keeps an unmatchable value verbatim rather than discarding the evidence', () => {
    // 'AB-23' can never be a code, so there is nothing to normalise it to — and dropping it would lose the
    // one signal that says the desk IS pasting something, which is a different finding from silence.
    const decision = decideRefCapture({ entered: 'AB-23', matchedRefCode: null })
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
          const decision = decideRefCapture({ entered, matchedRefCode })
          expect(REF_CAPTURE_OUTCOMES).toContain(decision.outcome)
          // THE property: a code is recorded exactly when the caller supplied a row, and it is that row.
          expect(decision.refCode).toBe(matchedRefCode)
          expect(decision.refCode !== null).toBe(decision.outcome === 'matched')
          // A warning exactly when something was typed and matched nothing.
          expect(decision.warns).toBe(decision.outcome === 'unknown_code')
          // And the typed text is kept on that branch alone, so no other outcome can carry a value a
          // reader might mistake for an attribution.
          expect(decision.enteredCode !== null).toBe(decision.outcome === 'unknown_code')
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
  const counts = (over: Partial<RefCaptureCounts> = {}): RefCaptureCounts => ({
    matched: 0,
    unknownCode: 0,
    notOffered: 0,
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

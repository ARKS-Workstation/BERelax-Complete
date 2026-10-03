import { describe, expect, it } from 'vitest'
import {
  PAPER_FALLBACK_STEPS,
  TILL_FAILURE_SENTENCES,
  TILL_FAILURE_STATES,
  TILL_FORBIDDEN_FAILURE_PHRASES,
  tillAttemptKeyFrom,
  tillAttemptReference,
  tillFailureSentenceProblems,
} from './honest-failure.ts'

/**
 * H-HARD-08 — the till says what it could not do, and never that it succeeded.
 *
 * The shipped sentences are checked rather than a fixture, which is the whole point of the file: this is
 * not "the function can detect a bad sentence", it is "the sentences this build ships say only what the
 * terminal can know". The control is the other direction — a planted sentence containing each forbidden
 * phrase MUST be reported, so an empty answer for the real table means the rule works rather than that it
 * matches nothing.
 */

describe('the three states', () => {
  it('are three, and each has a sentence', () => {
    // Three and not two, which is the design decision rather than a count: a design with "it worked" and
    // "it did not" collapses `unknown_whether_it_completed` into the second, and an operator told "it did
    // not work" takes payment again.
    expect([...TILL_FAILURE_STATES]).toEqual([
      'did_not_leave_this_terminal',
      'unknown_whether_it_completed',
      'refused_before_the_money_moved',
    ])
    for (const state of TILL_FAILURE_STATES) {
      expect(TILL_FAILURE_SENTENCES[state].length, state).toBeGreaterThan(80)
    }
  })

  it('distinguishes "did not leave" from "do not know", in the words', () => {
    // The two sentences must not be paraphrases of each other, because the ACTION they call for is
    // opposite: try again, versus do not take payment again until you have looked it up.
    expect(TILL_FAILURE_SENTENCES.did_not_leave_this_terminal).toContain('never left')
    expect(TILL_FAILURE_SENTENCES.did_not_leave_this_terminal).toContain('try again')
    expect(TILL_FAILURE_SENTENCES.unknown_whether_it_completed).toContain('NOT')
    expect(TILL_FAILURE_SENTENCES.unknown_whether_it_completed).toContain(
      'do not take payment again',
    )
    // And the unknown state must not tell the operator it failed, which is the lie that double-charges.
    expect(TILL_FAILURE_SENTENCES.unknown_whether_it_completed).toContain(
      'Do not tell the customer',
    )
  })

  it('says nothing was held or is waiting', () => {
    expect(TILL_FAILURE_SENTENCES.did_not_leave_this_terminal).toContain('nothing is waiting')
  })
})

describe('the forbidden vocabulary', () => {
  it('reports nothing against the shipped sentences', () => {
    expect(tillFailureSentenceProblems()).toEqual([])
  })

  it('reports EVERY forbidden phrase when one is planted, which is the control', () => {
    // Each phrase individually, because a rule that matched only the first entry of the list would pass a
    // test that planted one sentence containing all of them.
    for (const phrase of TILL_FORBIDDEN_FAILURE_PHRASES) {
      const problems = tillFailureSentenceProblems({
        planted: `The payment was taken and ${phrase} for later.`,
      })
      // Exactly one report per phrase, which is also an assertion about the LIST: two entries that
      // overlap — `queue` and `queued` — make one offending sentence produce two reports, and a count
      // that can be two means nothing. The overlapping entry was removed because this case caught it.
      expect(problems, `"${phrase}" was not reported exactly once`).toHaveLength(1)
      expect(problems[0]).toContain(phrase)
      expect(problems[0]).toContain('planted')
    }
    expect(TILL_FORBIDDEN_FAILURE_PHRASES.length).toBeGreaterThanOrEqual(10)
  })

  it('is case-insensitive, because a sentence starts with a capital', () => {
    expect(tillFailureSentenceProblems({ planted: 'Queued for later.' })).toHaveLength(1)
  })

  it('reports nothing for an honest sentence, which is the non-vacuity control', () => {
    // Without this, "reports every planted phrase" is satisfied by a function that reports everything.
    expect(
      tillFailureSentenceProblems({
        honest: 'The system answered and refused this payment, so no money moved.',
      }),
    ).toEqual([])
  })
})

describe('the attempt reference', () => {
  it('is twelve characters of the key, grouped in fours and upper-cased', () => {
    const reference = tillAttemptReference('0b4d1f2e-9a3c-7b1d-8e4f-5a6b7c8d9e0f')
    expect(reference).toBe('0B4D-1F2E-9A3C')
    expect(reference).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){2}$/)
  })

  it('round-trips through the key, so the grouping is presentational only', () => {
    const key = 'checkout-attempt-7c1e9a4b2d6f'
    const reference = tillAttemptReference(key)
    expect(tillAttemptKeyFrom(reference)).toBe(
      key
        .replace(/[^0-9a-zA-Z]/g, '')
        .toUpperCase()
        .slice(0, 12),
    )
    // And a reference somebody typed back in without the dashes resolves to the same key.
    expect(tillAttemptKeyFrom(reference.replace(/-/g, ''))).toBe(tillAttemptKeyFrom(reference))
    expect(tillAttemptKeyFrom(reference.toLowerCase())).toBe(tillAttemptKeyFrom(reference))
  })

  it('handles a key shorter than twelve characters without padding it', () => {
    // Padding would invent characters a person would then read out, and the lookup would fail on a value
    // nothing holds. A short reference is honest.
    expect(tillAttemptReference('ab12')).toBe('AB12')
    expect(tillAttemptReference('ab12cd')).toBe('AB12-CD')
    expect(tillAttemptReference('')).toBe('')
  })

  it('is derived from the key and is not a second identifier', () => {
    // The thing written on paper and the thing that makes a repeat safe are the same value. Two
    // identifiers is the version where somebody reads out the wrong one.
    const key = 'f1e2d3c4b5a6'
    expect(tillAttemptKeyFrom(tillAttemptReference(key))).toBe(key.toUpperCase())
  })
})

describe('the paper fallback', () => {
  it('ends with RECORDING what happened, as a claim', () => {
    expect(PAPER_FALLBACK_STEPS.length).toBeGreaterThanOrEqual(4)
    const last = PAPER_FALLBACK_STEPS.at(-1) ?? ''
    // The step that makes the rest safe, and the one a design with an offline queue does not have.
    expect(last).toContain('look the reference up')
    expect(last).toContain('your name on it')
    expect(last).toContain('Nothing in this system will have recorded it for you')
  })

  it('tells the operator to write the reference down FIRST', () => {
    expect(PAPER_FALLBACK_STEPS[0]).toContain('Write down the reference')
  })

  it('names the printed day sheet as the fallback for the rest of the shift', () => {
    expect(PAPER_FALLBACK_STEPS.join(' ')).toContain('printed day sheet')
    expect(PAPER_FALLBACK_STEPS.join(' ')).toContain('after midnight')
  })

  it('contains no forbidden phrase either', () => {
    // The steps are read under pressure and are the place a promise would be most believed.
    expect(
      tillFailureSentenceProblems(
        Object.fromEntries(PAPER_FALLBACK_STEPS.map((step, index) => [`step-${index}`, step])),
      ),
    ).toEqual([])
  })
})

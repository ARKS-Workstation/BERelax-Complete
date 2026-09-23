import { describe, expect, it } from 'vitest'
import golden from '../../test/fixtures/duplicate-pairs.json' with { type: 'json' }
import {
  AGREEMENT_SCORES,
  DUPLICATE_AUTO_MERGE_THRESHOLD,
  DUPLICATE_REVIEW_THRESHOLD,
  duplicateVerdict,
  LABEL_AGREEMENTS,
  type LabelAgreement,
  labelSimilarityPerMille,
  PHONE_AGREEMENTS,
  type PhoneAgreement,
  scoreDuplicatePair,
} from './duplicate-score.ts'

/**
 * C-CRM-02's golden-file acceptance line.
 *
 * "A committed fixture of 60 labelled pairs (30 duplicate, 30 distinct) scores with zero false
 * positives above the auto-merge threshold and recall >= 0.9 at the review threshold; any change to a
 * committed score fails the test."
 *
 * ## What the fixture is, and how it was built
 *
 * `packages/core/test/fixtures/duplicate-pairs.json` holds sixty pairs, each with the truth an operator
 * would assign it, a sentence saying which real situation it is, and the score this scorer gives it.
 * The scores are committed, so a change to the table, to either similarity boundary or to the trigram
 * extraction fails this file — which is the whole point of a golden file and the reason there is no
 * `--emit` flag anywhere near it. Changing a score is allowed and sometimes right; changing one without
 * noticing is not.
 *
 * Each pair's phone and label class was **predicted by hand before it was computed**, and nine
 * predictions were wrong on the first pass — every one of them a pair whose numbers I had meant to be
 * unrelated and which in fact differed by a single digit. Two of the sixty were mislabelled as
 * `distinct` while being, under phone-first identity (ADR 0014), pairs this system cannot tell apart
 * from one person: the same handset with one row unnamed, and the same handset with a serial mistyped.
 * They were re-authored rather than accommodated, because a fixture that asserts a property the design
 * deliberately does not have is a fixture that will be "fixed" by weakening the design.
 *
 * ## Why `label` and not `name`
 *
 * No name in this repository is invented (ADR 0020, brief rule 10). A customer with no display name is
 * `Customer 0042`, and that is what most rows of `customer.display_name` hold. So the label variations
 * in the fixture are the variations that really occur on a record label — word order, case, a mistyped
 * word, an extra zero in the serial, the same label in Arabic — and the two Arabic pairs exist because
 * `unaccent` cannot fold Arabic orthography at all and `normaliseNameForMatching` can.
 */

interface GoldenPair {
  readonly id: string
  readonly truth: 'duplicate' | 'distinct'
  readonly why: string
  readonly a: { readonly phone: string | null; readonly label: string | null }
  readonly b: { readonly phone: string | null; readonly label: string | null }
  readonly phone: string
  readonly label: string
  readonly labelSimilarityPerMille: number
  readonly scorePerMille: number
  readonly score: number
  readonly verdict: string
}

const pairs = golden.pairs as readonly GoldenPair[]
const duplicates = pairs.filter((pair) => pair.truth === 'duplicate')
const distinct = pairs.filter((pair) => pair.truth === 'distinct')

describe('the committed fixture', () => {
  it('is 60 pairs, 30 duplicate and 30 distinct, with no repeated id', () => {
    expect(pairs).toHaveLength(60)
    expect(duplicates).toHaveLength(30)
    expect(distinct).toHaveLength(30)
    expect(new Set(pairs.map((pair) => pair.id)).size).toBe(60)
  })

  it('says why each pair is what it is, in a sentence rather than a word', () => {
    // A fixture row nobody can read is a fixture row nobody maintains, and the `why` is what a reviewer
    // uses to decide whether a changed score is a correction or a regression.
    for (const pair of pairs) {
      expect(pair.why.length, pair.id).toBeGreaterThan(30)
      expect((PHONE_AGREEMENTS as readonly string[]).includes(pair.phone), pair.id).toBe(true)
      expect((LABEL_AGREEMENTS as readonly string[]).includes(pair.label), pair.id).toBe(true)
    }
  })

  it('was authored against the thresholds this module ships', () => {
    // The file carries its own copy of the two thresholds. If somebody moves either constant, every
    // committed verdict in the fixture becomes an assertion about a policy that no longer exists — and
    // this is the assertion that says so rather than letting 60 rows disagree one at a time.
    expect(golden.thresholds.autoMerge).toBe(DUPLICATE_AUTO_MERGE_THRESHOLD)
    expect(golden.thresholds.review).toBe(DUPLICATE_REVIEW_THRESHOLD)
  })
})

describe('every committed score is still the score', () => {
  it.each(pairs.map((pair) => [pair.id, pair] as const))('%s', (_id, pair) => {
    const scored = scoreDuplicatePair(pair.a, pair.b)
    expect(scored.phone, `${pair.id} phone class`).toBe(pair.phone)
    expect(scored.label, `${pair.id} label class`).toBe(pair.label)
    expect(scored.scorePerMille, `${pair.id} score`).toBe(pair.scorePerMille)
    expect(scored.score, `${pair.id} score`).toBe(pair.score)
    expect(scored.verdict, `${pair.id} verdict`).toBe(pair.verdict)
    // Committed the other way round too: the fixture's order must not matter, and a pair whose score
    // depended on it would be a queue that changed with the planner.
    expect(scoreDuplicatePair(pair.b, pair.a)).toEqual(scored)
  })

  it('agrees with the table and with the recorded label similarity', () => {
    // Three values that must agree, committed separately so a change to any one of them is visible:
    // the cell, the score, and the measured similarity the label class was derived from.
    for (const pair of pairs) {
      expect(
        AGREEMENT_SCORES[pair.phone as PhoneAgreement][pair.label as LabelAgreement],
        pair.id,
      ).toBe(pair.scorePerMille)
      expect(labelSimilarityPerMille(pair.a.label ?? '', pair.b.label ?? ''), pair.id).toBe(
        pair.labelSimilarityPerMille,
      )
      expect(duplicateVerdict(pair.score), pair.id).toBe(pair.verdict)
    }
  })
})

/**
 * The two figures, measured by SCORING the fixture rather than by reading the scores in it.
 *
 * The distinction matters and it was found by the gate. Case 71e of `scripts/test-gates.mjs` lowers the
 * label `near` boundary below the 750 that two different record serials measure, which turns one distinct
 * pair into an automatic merge — and the first version of these two tests went on passing, because they
 * compared the fixture's *committed* `score` against the thresholds. That is a claim about a JSON file.
 * Scoring live makes them a claim about the scorer, which is what the acceptance line is about; the
 * committed scores are pinned by the block above, so both properties are held and neither stands in for
 * the other.
 */
const live = pairs.map((pair) => ({ ...pair, scored: scoreDuplicatePair(pair.a, pair.b) }))
const liveDuplicates = live.filter((pair) => pair.truth === 'duplicate')
const liveDistinct = live.filter((pair) => pair.truth === 'distinct')

describe('the two acceptance figures', () => {
  it('has zero false positives above the auto-merge threshold', () => {
    const falsePositives = liveDistinct.filter(
      (pair) => pair.scored.score >= DUPLICATE_AUTO_MERGE_THRESHOLD,
    )
    expect(
      falsePositives.map((pair) => `${pair.id} (${pair.scored.score}) — ${pair.why}`),
      'a distinct pair in the auto-merge band would merge two people with nobody looking',
    ).toEqual([])
    // The control. Zero false positives is trivially true of a scorer that never reaches the band, so
    // the band has to be reached — by the duplicates, which is what makes it worth having.
    expect(
      liveDuplicates.filter((pair) => pair.scored.verdict === 'auto_merge').length,
    ).toBeGreaterThan(10)
  })

  it('recalls at least 0.9 of the duplicates at the review threshold', () => {
    const recalled = liveDuplicates.filter(
      (pair) => pair.scored.score >= DUPLICATE_REVIEW_THRESHOLD,
    )
    const missed = liveDuplicates.filter((pair) => pair.scored.score < DUPLICATE_REVIEW_THRESHOLD)
    const recall = recalled.length / liveDuplicates.length
    /**
     * The figure travels in the assertion message rather than through `console.log`, and that is the
     * purity gate rather than a preference: `scripts/check-core-purity.mjs` scans every `.ts` file under
     * `packages/core/src` — tests included — and forbids `console`, on the grounds that core returns
     * results and lets its caller decide what to print. So the headroom is stated where a failure will
     * show it, which is what the print was for. (Case 71a is the fixture that proves that gate fires on
     * this directory.)
     */
    const measured =
      `recall ${recall.toFixed(3)} (${recalled.length}/${liveDuplicates.length}); missed ` +
      `${missed.map((pair) => `${pair.id}=${pair.scored.score}`).join(', ')}`
    expect(recall, measured).toBeGreaterThanOrEqual(0.9)
    // The control, and the reason this is `>= 0.9` and not `=== 1`: the fixture deliberately contains
    // two duplicates this scorer does NOT surface — a mistyped number with a mistyped label, and a row
    // whose only number is a landline. A corpus with no misses in it cannot tell a recall of 0.93 from
    // a recall of 1, and the first change that lost a real duplicate would look like a pass.
    expect(missed.length, measured).toBe(2)
  })

  it('keeps the highest-scoring distinct pair in the review band, not the auto band', () => {
    const highest = Math.max(...liveDistinct.map((pair) => pair.scored.score))
    expect(highest).toBeLessThan(DUPLICATE_AUTO_MERGE_THRESHOLD)
    // And above the review threshold, because that pair — two consecutive serials on one handset — is
    // exactly what a human should be shown. A design that scored it 0 would hide a real question.
    expect(highest).toBeGreaterThanOrEqual(DUPLICATE_REVIEW_THRESHOLD)
  })
})

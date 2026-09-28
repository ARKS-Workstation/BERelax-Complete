import { describe, expect, it } from 'vitest'
import {
  criticalPathBytes,
  formatPublicationWeightRefusals,
  PUBLICATION_WEIGHT_RULES,
  type PublicationWeightSubject,
  publicationWeightRefusals,
} from './weight.ts'

/**
 * The publish-time weight judgement, with an oversized fixture.
 *
 * The number this is judged against is docs/08 §8's and is stated once, in
 * `apps/web/src/home/budget.ts`. It is NOT imported here — `packages/core` may not depend on the
 * application — so the figure below is a fixture and the real wiring is asserted where the real limit
 * lives: `apps/web/src/publication/publish-gate.test.ts` proves the gate takes it from
 * `homeBudgetLimit('critical-above-fold')` and not from a constant of its own.
 */

/** 250KB, docs/08 §8's mobile critical above-fold figure, on the KiB basis every budget here uses. */
const BUDGET = 250 * 1024

const PAGE: PublicationWeightSubject = {
  surface: 'pages/about',
  documentBytes: 18_000,
  criticalAssetBytes: 64_000,
  criticalImageBytes: 92_000,
}

describe('the measurement', () => {
  it('is the sum of the document and everything the document puts in front of its paint', () => {
    expect(criticalPathBytes(PAGE)).toBe(18_000 + 64_000 + 92_000)
    // The control on the arithmetic being a SUM: raising one part raises the answer by exactly that much,
    // which a maximum would not. `home.itest.ts` measures the browser's figure the same way.
    expect(criticalPathBytes({ ...PAGE, criticalImageBytes: 93_000 })).toBe(
      criticalPathBytes(PAGE) + 1000,
    )
  })
})

describe('acceptance — an oversized page is refused, with the measured number', () => {
  it('passes a page inside the budget', () => {
    // The control that matters most: a gate refusing everything would satisfy every case below.
    expect(publicationWeightRefusals(PAGE, BUDGET)).toEqual([])
    expect(formatPublicationWeightRefusals(publicationWeightRefusals(PAGE, BUDGET))).toBe('')
  })

  it('refuses the oversized fixture and prints both numbers and the overage', () => {
    // An editor's photograph, which is the failure docs/08 §8's third layer exists for: the same page with
    // a 210KB hero instead of a 92KB one.
    const heavy: PublicationWeightSubject = { ...PAGE, criticalImageBytes: 210_000 }
    const measured = criticalPathBytes(heavy)
    const refusals = publicationWeightRefusals(heavy, BUDGET)
    expect(refusals.map((refusal) => refusal.rule)).toEqual([
      'publication-over-critical-path-budget',
    ])
    expect(refusals[0]?.measuredBytes).toBe(measured)
    expect(refusals[0]?.budgetBytes).toBe(BUDGET)
    // The sentence, which is what reaches the editor and the API's JSON body. Both figures and the
    // difference, because "the first question anybody asks of a breached budget is by how much".
    const message = refusals[0]?.message ?? ''
    expect(message).toContain(String(measured))
    expect(message).toContain(String(BUDGET))
    expect(message).toContain(String(measured - BUDGET))
    expect(message).toContain('pages/about')
    // And each component, so the cut order in docs/08 §8 can be applied to the right half.
    expect(message).toContain('210000')
    expect(message).toContain('64000')
  })

  it('treats a page exactly at the budget as inside it', () => {
    // docs/08 §8 writes "≤". One byte either side, so the boundary is asserted rather than assumed.
    const exact: PublicationWeightSubject = {
      surface: 'pages/about',
      documentBytes: BUDGET - 2,
      criticalAssetBytes: 1,
      criticalImageBytes: 1,
    }
    expect(criticalPathBytes(exact)).toBe(BUDGET)
    expect(publicationWeightRefusals(exact, BUDGET)).toEqual([])
    expect(
      publicationWeightRefusals({ ...exact, criticalImageBytes: 2 }, BUDGET).map((r) => r.rule),
    ).toEqual(['publication-over-critical-path-budget'])
  })
})

describe('a page that measured nothing is refused, not passed', () => {
  it('refuses a zero measurement by its own rule', () => {
    // The failure mode this rule exists for, and it is the one ADR 0002 is about: if the measurement
    // silently stops working, every page weighs nothing and every page is inside every budget. So zero is
    // the loudest answer here rather than the quietest.
    const nothing: PublicationWeightSubject = {
      surface: 'pages/about',
      documentBytes: 0,
      criticalAssetBytes: 0,
      criticalImageBytes: 0,
    }
    const refusals = publicationWeightRefusals(nothing, BUDGET)
    expect(refusals.map((refusal) => refusal.rule)).toEqual([
      'publication-critical-path-not-measured',
    ])
    expect(refusals[0]?.measuredBytes).toBeNull()
    // The message names all three components, so whoever reads it can see which one came back empty.
    expect(refusals[0]?.message).toContain('0 bytes')
  })

  it('accepts a page whose image is genuinely absent but whose document is not', () => {
    // The control on the rule above: it must not refuse a page that legitimately has no critical image —
    // a text-only journal post is one — because that would make the rule a second byte budget nobody
    // declared.
    const textOnly: PublicationWeightSubject = {
      surface: 'journal_posts/what-to-expect',
      documentBytes: 12_000,
      criticalAssetBytes: 64_000,
      criticalImageBytes: 0,
    }
    expect(publicationWeightRefusals(textOnly, BUDGET)).toEqual([])
  })
})

describe('every declared rule is reachable', () => {
  it('and the list has no member nothing produces', () => {
    const reached = new Set(
      [
        ...publicationWeightRefusals({ ...PAGE, criticalImageBytes: 400_000 }, BUDGET),
        ...publicationWeightRefusals(
          { surface: 'x/y', documentBytes: 0, criticalAssetBytes: 0, criticalImageBytes: 0 },
          BUDGET,
        ),
      ].map((refusal) => refusal.rule),
    )
    expect([...reached].sort()).toEqual([...PUBLICATION_WEIGHT_RULES].sort())
  })
})

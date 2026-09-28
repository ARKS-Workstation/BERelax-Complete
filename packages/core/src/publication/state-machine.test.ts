import { describe, expect, it } from 'vitest'
import {
  assertPublicationTransition,
  decidePublicationTransition,
  PUBLICATION_STATES,
  PUBLICATION_TRANSITION_REFUSALS,
  PUBLICATION_TRANSITIONS,
  type PublicationEvidence,
  type PublicationOrigin,
  type PublicationState,
  PublicationTransitionRefused,
  publicationTransitionRefusalOf,
  UNRECORDED,
} from './state-machine.ts'

/**
 * The pure half of W-SITE-10's state machine.
 *
 * What this file can prove is that the table and the decision agree, that every refusal is reachable, and
 * that the arrows are the ones the unit's acceptance names. What it cannot prove is that the DATABASE
 * agrees, because the database is the authority here and a pure test of a mirror is a test of the mirror.
 * That half is `packages/fixtures/src/publication-control-plane.itest.ts`, which drives every pair below
 * through a real INSERT.
 */

const COMPLETE: PublicationEvidence = {
  lintPassId: 'lint-1',
  approvalId: 'approval-1',
  measuredCriticalPathBytes: 180_000,
  supersedesId: null,
}
const NONE: PublicationEvidence = {
  lintPassId: null,
  approvalId: null,
  measuredCriticalPathBytes: null,
  supersedesId: null,
}

const at = (state: PublicationOrigin, id: string | null = 'record-1') => ({
  state,
  currentRecordId: state === UNRECORDED ? null : id,
})

/** Every (from, to) pair, so no case below can be satisfied by a pair nobody tried. */
const ORIGINS: readonly PublicationOrigin[] = [UNRECORDED, ...PUBLICATION_STATES]
const PAIRS = ORIGINS.flatMap((from) => PUBLICATION_STATES.map((to) => ({ from, to })))

describe('the transition table', () => {
  it('declares an entry for every origin, and only real states in it', () => {
    // A `Record` cannot be partial, so this is about the VALUES: an entry naming a state that does not
    // exist would typecheck against a widened union and be unreachable for ever.
    expect(Object.keys(PUBLICATION_TRANSITIONS).sort()).toEqual(
      [...ORIGINS].sort() as unknown as string[],
    )
    for (const [, permitted] of Object.entries(PUBLICATION_TRANSITIONS)) {
      for (const state of permitted) expect(PUBLICATION_STATES).toContain(state)
    }
  })

  it('is the sequence the acceptance criterion names, one step at a time', () => {
    expect(PUBLICATION_TRANSITIONS[UNRECORDED]).toEqual(['draft'])
    expect(PUBLICATION_TRANSITIONS.draft).toContain('lint_passed')
    expect(PUBLICATION_TRANSITIONS.lint_passed).toContain('approved')
    expect(PUBLICATION_TRANSITIONS.approved).toContain('published')
    // And the steps it must NOT allow: nothing skips the lint, and nothing skips the approval.
    expect(PUBLICATION_TRANSITIONS.draft).not.toContain('approved')
    expect(PUBLICATION_TRANSITIONS.draft).not.toContain('published')
    expect(PUBLICATION_TRANSITIONS.lint_passed).not.toContain('published')
    expect(PUBLICATION_TRANSITIONS[UNRECORDED]).not.toContain('published')
  })

  it('lets every state return to draft, because editing invalidates the approved hash', () => {
    for (const origin of PUBLICATION_STATES) {
      expect(PUBLICATION_TRANSITIONS[origin], origin).toContain('draft')
    }
  })
})

describe('the decision agrees with the table on every pair', () => {
  it.each(PAIRS)('$from -> $to', ({ from, to }) => {
    // Complete evidence, so the only thing that can refuse is the ordering. A `published` target from
    // `published` also needs a supersession, which is supplied here and asserted on its own below.
    const evidence: PublicationEvidence =
      from === 'published' && to === 'published'
        ? { ...COMPLETE, supersedesId: 'record-1' }
        : COMPLETE
    const decision = decidePublicationTransition(at(from), to, evidence)
    const permitted = PUBLICATION_TRANSITIONS[from].includes(to)
    expect(decision.kind).toBe(permitted ? 'allowed' : 'refused')
    if (decision.kind === 'refused') {
      expect(decision.refusal).toBe('transition_not_permitted')
      // The refusal offers what could have been written instead, which is what makes it actionable.
      expect(decision.permitted).toEqual(PUBLICATION_TRANSITIONS[from])
    }
  })

  it('counts the pairs, so a table that emptied would not pass this file', () => {
    // ADR 0002: `it.each([])` runs no cases and reports success. Floors rather than exact numbers.
    expect(PAIRS.length).toBe(ORIGINS.length * PUBLICATION_STATES.length)
    expect(PAIRS.filter(({ from, to }) => PUBLICATION_TRANSITIONS[from].includes(to)).length).toBe(
      9,
    )
  })
})

describe('the evidence rules', () => {
  it('refuses published without a lint pass, without an approval and without a measurement', () => {
    // One at a time, from the one state that may publish, so each refusal is reached on its own merits
    // rather than by whichever check happens to run first.
    expect(
      decidePublicationTransition(at('approved'), 'published', { ...COMPLETE, lintPassId: null }),
    ).toMatchObject({ refusal: 'published_without_lint_pass' })
    expect(
      decidePublicationTransition(at('approved'), 'published', { ...COMPLETE, approvalId: null }),
    ).toMatchObject({ refusal: 'published_without_approval' })
    expect(
      decidePublicationTransition(at('approved'), 'published', {
        ...COMPLETE,
        measuredCriticalPathBytes: null,
      }),
    ).toMatchObject({ refusal: 'published_without_weight_measurement' })
    // And the control: with all three present the same move is allowed, so the three cases above are
    // about the evidence and not about the arrow.
    expect(decidePublicationTransition(at('approved'), 'published', COMPLETE)).toEqual({
      kind: 'allowed',
    })
  })

  it('refuses approved without a lint pass', () => {
    expect(decidePublicationTransition(at('lint_passed'), 'approved', { ...NONE })).toMatchObject({
      refusal: 'approved_without_lint_pass',
    })
    expect(
      decidePublicationTransition(at('lint_passed'), 'approved', { ...NONE, lintPassId: 'lint-1' }),
    ).toEqual({ kind: 'allowed' })
  })

  it('needs no evidence for a draft, which is the state a page starts and returns to', () => {
    expect(decidePublicationTransition(at(UNRECORDED), 'draft', NONE)).toEqual({ kind: 'allowed' })
    expect(decidePublicationTransition(at('published'), 'draft', NONE)).toEqual({ kind: 'allowed' })
  })
})

describe('a correction or a revert', () => {
  it('must name the record it supersedes', () => {
    expect(
      decidePublicationTransition(at('published', 'live-1'), 'published', COMPLETE),
    ).toMatchObject({ refusal: 'correction_must_supersede' })
  })

  it('must name the record that is actually live', () => {
    expect(
      decidePublicationTransition(at('published', 'live-1'), 'published', {
        ...COMPLETE,
        supersedesId: 'live-0',
      }),
    ).toMatchObject({ refusal: 'correction_supersedes_the_wrong_record' })
    expect(
      decidePublicationTransition(at('published', 'live-1'), 'published', {
        ...COMPLETE,
        supersedesId: 'live-1',
      }),
    ).toEqual({ kind: 'allowed' })
  })

  it('is the only place a supersession may appear', () => {
    for (const [from, to] of [
      [UNRECORDED, 'draft'],
      ['draft', 'lint_passed'],
      ['lint_passed', 'approved'],
      ['approved', 'published'],
      ['published', 'draft'],
    ] as const) {
      expect(
        decidePublicationTransition(at(from), to, { ...COMPLETE, supersedesId: 'live-1' }),
        `${from} -> ${to}`,
      ).toMatchObject({ refusal: 'supersedes_outside_a_correction' })
    }
  })
})

describe('every declared refusal is reachable', () => {
  it('and the list has no member nothing produces', () => {
    // A refusal name nothing can raise is a rule a reader believes exists. Collected from the cases the
    // file actually drives, so adding a name to the union without a path to it fails here.
    const reached = new Set(
      [
        decidePublicationTransition(at('draft'), 'published', COMPLETE),
        decidePublicationTransition(at('lint_passed'), 'approved', NONE),
        decidePublicationTransition(at('approved'), 'published', { ...COMPLETE, lintPassId: null }),
        decidePublicationTransition(at('approved'), 'published', { ...COMPLETE, approvalId: null }),
        decidePublicationTransition(at('approved'), 'published', {
          ...COMPLETE,
          measuredCriticalPathBytes: null,
        }),
        decidePublicationTransition(at('published', 'live-1'), 'published', COMPLETE),
        decidePublicationTransition(at('published', 'live-1'), 'published', {
          ...COMPLETE,
          supersedesId: 'live-0',
        }),
        decidePublicationTransition(at('draft'), 'lint_passed', {
          ...COMPLETE,
          supersedesId: 'live-1',
        }),
      ]
        .filter((decision) => decision.kind === 'refused')
        .map((decision) => (decision as { refusal: string }).refusal),
    )
    expect([...reached].sort()).toEqual([...PUBLICATION_TRANSITION_REFUSALS].sort())
  })
})

describe('the throwing wrapper', () => {
  it('raises with the refusal on it, and does not raise for a permitted move', () => {
    try {
      assertPublicationTransition(
        'pages/about',
        at('draft'),
        'published' as PublicationState,
        COMPLETE,
      )
      expect.unreachable('draft cannot become published')
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationTransitionRefused)
      expect(publicationTransitionRefusalOf(error)).toBe('transition_not_permitted')
      // The message offers the legal next step, so an editor is not left guessing.
      expect(String(error)).toContain('lint_passed')
      expect(String(error)).toContain('pages/about')
    }
    expect(() =>
      assertPublicationTransition('pages/about', at('approved'), 'published', COMPLETE),
    ).not.toThrow()
    expect(publicationTransitionRefusalOf(new Error('unrelated'))).toBeNull()
  })
})

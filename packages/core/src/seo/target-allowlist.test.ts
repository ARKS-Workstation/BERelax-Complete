import { describe, expect, it } from 'vitest'
import {
  assertAllowedSuggestionTarget,
  DENIED_SUGGESTION_TARGET_KINDS,
  DENIED_TARGET_REF_MARKERS,
  deniedTargetRefMarker,
  isAllowedSuggestionTarget,
  isAllowedSuggestionTargetKind,
  SUGGESTION_TARGET_KINDS,
  SuggestionTargetRefused,
  suggestionTargetRefusal,
  TARGET_REF_SPECIMENS,
} from './target-allowlist.ts'

/**
 * The code half of the target allowlist. The database half is migration 0057, and
 * `packages/google/src/seo/seo-agent-cage.itest.ts` holds the two to each other over
 * {@link TARGET_REF_SPECIMENS}.
 */

describe('the allowlist refuses the four targets the criterion names', () => {
  it('refuses all four by kind, with the rule named', () => {
    for (const kind of DENIED_SUGGESTION_TARGET_KINDS) {
      expect(isAllowedSuggestionTargetKind(kind)).toBe(false)
      expect(suggestionTargetRefusal({ kind, ref: '/spa' })?.rule).toBe(
        'target_kind_not_allowlisted',
      )
    }
    // Four, counted. A list quietly reduced to three fails here rather than passing three cases.
    expect(DENIED_SUGGESTION_TARGET_KINDS).toHaveLength(4)
  })

  it('refuses the same four surfaces wearing an allowed kind, which is the interesting case', () => {
    // `target_kind: 'body_copy'` with `target_ref: '/robots.txt'` is the honest-looking label on the
    // forbidden edit, and the kind allowlist alone cannot see it.
    const disguised = [
      { kind: 'body_copy', ref: '/robots.txt', marker: 'robots.txt' },
      { kind: 'page_title', ref: 'link[rel=canonical]', marker: 'canonical' },
      { kind: 'heading', ref: 'redirect_map:/old-price-list', marker: 'redirect' },
      { kind: 'meta_description', ref: 'meta[name=robots][content=noindex]', marker: 'noindex' },
    ] as const
    for (const target of disguised) {
      expect(isAllowedSuggestionTargetKind(target.kind)).toBe(true)
      const refusal = suggestionTargetRefusal(target)
      expect(refusal?.rule, target.ref).toBe('target_ref_is_a_machine_directive')
      expect(refusal?.detail, target.ref).toBe(target.marker)
    }
  })

  it('the control: every allowlisted kind with an ordinary locator is ACCEPTED', () => {
    // Without this the two cases above are satisfied by a rule that refuses everything, which is a broken
    // agent that passes a security test.
    for (const kind of SUGGESTION_TARGET_KINDS) {
      expect(
        isAllowedSuggestionTarget({ kind, ref: '/treatments/hot-oil-massage#title' }),
        kind,
      ).toBe(true)
      expect(() =>
        assertAllowedSuggestionTarget({ kind, ref: '/treatments/hot-oil-massage#title' }),
      ).not.toThrow()
    }
    expect(SUGGESTION_TARGET_KINDS.length).toBeGreaterThan(0)
  })

  it('does not allowlist a JSON-LD field, because @id and url are canonical identity', () => {
    expect(isAllowedSuggestionTargetKind('json_ld_field')).toBe(false)
  })

  it('throws a refusal carrying the rule, not a sentence a test has to match', () => {
    try {
      assertAllowedSuggestionTarget({ kind: 'robots_txt', ref: '/robots.txt' })
      expect.unreachable('a denied target must not be allowed')
    } catch (error) {
      expect(error).toBeInstanceOf(SuggestionTargetRefused)
      expect((error as SuggestionTargetRefused).rule).toBe('target_kind_not_allowlisted')
      expect((error as SuggestionTargetRefused).details['code']).toBe('suggestion_target_refused')
    }
  })
})

describe('the specimen corpus the database is held to', () => {
  it('every specimen gets the marker it declares, case-folded', () => {
    for (const specimen of TARGET_REF_SPECIMENS) {
      expect(deniedTargetRefMarker(specimen.ref), specimen.ref).toBe(specimen.marker)
    }
  })

  it('carries both outcomes, so the agreement check cannot be satisfied by refusing everything', () => {
    const denied = TARGET_REF_SPECIMENS.filter((specimen) => specimen.marker !== null)
    const allowed = TARGET_REF_SPECIMENS.filter((specimen) => specimen.marker === null)
    expect(denied.length).toBeGreaterThanOrEqual(6)
    expect(allowed.length).toBeGreaterThanOrEqual(6)
    // And every marker is exercised by at least one specimen: a marker no specimen reaches is a marker the
    // SQL mirror could be missing without the agreement check noticing.
    for (const marker of DENIED_TARGET_REF_MARKERS) {
      expect(
        denied.some((specimen) => specimen.marker === marker),
        `no specimen exercises ${marker}`,
      ).toBe(true)
    }
  })
})

import { describe, expect, it } from 'vitest'
import type { CompliancePolicy } from '../compliance/lexicon.ts'
import {
  bannedTermIn,
  CANDIDATE_DROP_RULES,
  redactedClaimTerm,
  type SuggestionCandidateProposal,
  screenSuggestionCandidates,
} from './candidate-screen.ts'

/**
 * The ingest screen. The database half — that a dropped term cannot be written by some other path either —
 * is `packages/google/src/seo/seo-agent-cage.itest.ts`.
 */

/** The profile the migration seeds: the stricter default, medical claims NOT permitted (0004). */
const STRICTER: CompliancePolicy = {
  bannedClaimTerms: ['therapeutic', 'treatment', 'pain relief', 'cure', 'heal', 'medical'],
  permittedPublicTitles: ['Therapist', 'Senior Therapist'],
  medicalClaimsPermitted: false,
}

const proposal = (
  over: Partial<SuggestionCandidateProposal> = {},
): SuggestionCandidateProposal => ({
  findingKind: 'ctr_outlier',
  targetKind: 'page_title',
  targetRef: '/treatments/hot-oil-massage#title',
  query: 'hot oil massage abu dhabi',
  ...over,
})

describe('the banned-term filter at the ingest boundary', () => {
  it('drops a candidate whose query asserts a banned claim, and keeps the rest of the batch', () => {
    const screened = screenSuggestionCandidates(
      [
        proposal({ query: 'massage abu dhabi' }),
        proposal({ query: 'therapeutic massage for back pain relief', targetRef: '/spa#title' }),
        proposal({ query: 'four hands massage price' }),
      ],
      STRICTER,
    )
    expect(screened.kept).toHaveLength(2)
    expect(screened.dropped).toHaveLength(1)
    expect(screened.dropped[0]?.rule).toBe('banned_claim_term')
    // The kept rows carry no banned term at all, which is the criterion stated over the output.
    for (const kept of screened.kept) {
      expect(bannedTermIn(kept.query ?? '', STRICTER)).toBeNull()
    }
  })

  it('the drop carries the term REDACTED and does not carry the query at all', () => {
    const screened = screenSuggestionCandidates(
      [proposal({ query: 'can massage cure sciatica' })],
      STRICTER,
    )
    const drop = screened.dropped[0]
    expect(drop?.redacted).toBe('c•••')
    // The whole point: neither the term nor the query survives into the record of the drop.
    const serialised = JSON.stringify(screened.dropped)
    expect(serialised).not.toContain('cure')
    expect(serialised).not.toContain('sciatica')
    // And the locator DOES survive, because an operator has to know which page lost a candidate.
    expect(serialised).toContain('/treatments/hot-oil-massage#title')
  })

  it('does not scan the target REFERENCE, because /treatments contains a banned token', () => {
    // The trap this decision avoids: `lexiconTokens` splits on every non-alphanumeric character, so the most
    // valuable locators on this site tokenise to `treatments` — and `treatment` is on the list. A screen that
    // scanned the locator would drop every candidate for every treatment page.
    expect(bannedTermIn('/treatments/hot-oil-massage#title', STRICTER)).toBe('treatment')
    const screened = screenSuggestionCandidates(
      [proposal({ targetRef: '/treatments/hot-oil-massage#title', query: 'hot oil massage' })],
      STRICTER,
    )
    expect(screened.dropped).toHaveLength(0)
    expect(screened.kept).toHaveLength(1)
  })

  it('the control: under a licence that permits medical claims the same query is KEPT', () => {
    // Without this, "the term never appears" is satisfied by a screen that drops everything, and the
    // regulatory_profile switch that ADR 0020 exists for would be decorative.
    const permissive: CompliancePolicy = { ...STRICTER, medicalClaimsPermitted: true }
    const query = 'therapeutic massage for back pain relief'
    expect(bannedTermIn(query, STRICTER)).not.toBeNull()
    expect(bannedTermIn(query, permissive)).toBeNull()
    expect(screenSuggestionCandidates([proposal({ query })], permissive).kept).toHaveLength(1)
  })

  it('a finding with no query is kept, because there is nothing to screen', () => {
    const screened = screenSuggestionCandidates(
      [proposal({ findingKind: 'cannibalisation', query: null })],
      STRICTER,
    )
    expect(screened.kept).toHaveLength(1)
    expect(screened.dropped).toHaveLength(0)
  })
})

describe('the target allowlist is applied at the same boundary, and reported separately', () => {
  it('drops a denied target kind and names the target rule, not the claim rule', () => {
    const screened = screenSuggestionCandidates(
      [proposal({ targetKind: 'robots_txt', targetRef: '/robots.txt' })],
      STRICTER,
    )
    expect(screened.dropped[0]?.rule).toBe('target_not_allowlisted')
    expect(screened.dropped[0]?.targetRule).toBe('target_kind_not_allowlisted')
    expect(screened.kept).toHaveLength(0)
  })

  it('the target check runs FIRST, so a denied target with a banned query reports the target', () => {
    // Order is declared rather than incidental: reporting a robots.txt suggestion as a banned term would
    // name the wrong problem, and the operator would go and look at the profile's word list.
    const screened = screenSuggestionCandidates(
      [proposal({ targetKind: 'body_copy', targetRef: '/robots.txt', query: 'massage cure' })],
      STRICTER,
    )
    expect(screened.dropped[0]?.rule).toBe('target_not_allowlisted')
    expect(screened.dropped[0]?.redacted).toBe('robots.txt')
  })

  it('both drop rules are reachable, so neither is a label nothing produces', () => {
    const screened = screenSuggestionCandidates(
      [
        proposal({ targetKind: 'canonical', targetRef: 'link[rel=canonical]' }),
        proposal({ query: 'medical massage abu dhabi' }),
        proposal(),
      ],
      STRICTER,
    )
    expect([...new Set(screened.dropped.map((drop) => drop.rule))].sort()).toEqual(
      [...CANDIDATE_DROP_RULES].sort(),
    )
    expect(screened.kept).toHaveLength(1)
  })
})

describe('redactedClaimTerm', () => {
  it('keeps the first character and the length, and nothing else', () => {
    expect(redactedClaimTerm('treatment')).toBe('t••••••••')
    expect(redactedClaimTerm('heal')).toBe('h•••')
    expect(redactedClaimTerm('pain relief')).toBe('p••••••••••')
    // A one-character term is still redacted to something, and a blank one does not produce an empty string
    // that reads as "no term".
    expect(redactedClaimTerm('x')).toBe('x')
    expect(redactedClaimTerm('   ')).toBe('•')
  })

  it('is not the term, for every term the stricter default profile carries', () => {
    for (const term of STRICTER.bannedClaimTerms) {
      const redacted = redactedClaimTerm(term)
      if (term.length > 1) expect(redacted).not.toBe(term)
      expect(redacted).toHaveLength(term.length)
    }
  })
})

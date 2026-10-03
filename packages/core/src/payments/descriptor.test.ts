import { describe, expect, it } from 'vitest'
import {
  DESCRIPTOR_BLOCKED_TERMS,
  DESCRIPTOR_OPEN_QUESTION,
  DESCRIPTOR_PRIVACY_CLAIM,
  isPlaceholderDescriptor,
  lintStatementDescriptor,
  MCC_OPEN_QUESTION,
  mayUseRealPaymentProvider,
  realProviderRefusalDetail,
} from './descriptor.ts'

/**
 * Y-PAY-10's descriptor lint and the real-provider gate.
 *
 * Every case is paired with a control, because an assertion about a refusal is worth nothing on its own:
 * "the blocked term is refused" passes against a lint that refuses everything, and "a good descriptor
 * passes" passes against one that refuses nothing.
 *
 * No descriptor this business might actually use appears here. The accepted fixtures are deliberately
 * not candidates — `BR AUH 01`, `ZZ TRADING` — because a test fixture is read as an example, and the one
 * place an example would be copied to is a line on a customer's bank statement (`Y7-descriptor`).
 */

const rulesOf = (verdict: ReturnType<typeof lintStatementDescriptor>): readonly string[] =>
  verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)

describe('lintStatementDescriptor', () => {
  it('accepts a descriptor that names neither a treatment nor a style', () => {
    // The control for every refusal below. Not a candidate descriptor: see the file note.
    const verdict = lintStatementDescriptor({ descriptor: 'BR AUH 01', limit: 22 })
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.descriptor).toBe('BR AUH 01')
    expect(verdict.limit).toBe(22)
  })

  it('refuses a descriptor longer than the configured limit, with a readable message', () => {
    const verdict = lintStatementDescriptor({ descriptor: 'A'.repeat(23), limit: 22 })
    expect(rulesOf(verdict)).toContain('descriptor-exceeds-provider-limit')
    if (verdict.ok) return
    const refusal = verdict.refusals[0]
    // READABLE is the acceptance line's own word, and what makes it readable is that it says what
    // happens: a processor truncates rather than refusing, and what goes is the end.
    expect(refusal?.detail).toContain('23 characters')
    expect(refusal?.detail).toContain('TRUNCATED')
    expect(refusal?.detail).toContain('22')
  })

  it('accepts a descriptor exactly at the limit, so the boundary is not off by one', () => {
    expect(lintStatementDescriptor({ descriptor: 'A'.repeat(22), limit: 22 }).ok).toBe(true)
  })

  it('blocks the words this unit is ABOUT, named one by one', () => {
    // Named rather than only iterated, which is the difference between a test and a tautology: the loop
    // below walks `DESCRIPTOR_BLOCKED_TERMS`, so a word removed from the lexicon is a word the loop
    // stops testing and the suite stays green. Gate case 188b found exactly that by deleting
    // `massage` — the one word a discreet descriptor exists not to say — and watching nothing fail.
    for (const term of [
      'massage',
      'spa',
      'treatment',
      'thai',
      'deep tissue',
      'relaxation',
      'wellness',
    ]) {
      // The LINT first and the membership second, so a failure prints the rule name rather than only
      // this test's own sentence: gate case 188b reads the rule, and ADR 0003 asks for rejection by name.
      expect(
        rulesOf(lintStatementDescriptor({ descriptor: `ZZ ${term.toUpperCase()}`, limit: 64 })),
        `"${term}" must be refused`,
      ).toContain('descriptor-contains-a-blocked-term')
      expect(DESCRIPTOR_BLOCKED_TERMS, `the lexicon must block "${term}"`).toContain(term)
    }
  })

  it('refuses every term in the blocking lexicon, and names which were found', () => {
    for (const term of DESCRIPTOR_BLOCKED_TERMS) {
      const verdict = lintStatementDescriptor({
        descriptor: `BR ${term.toUpperCase()}`,
        limit: 64,
      })
      expect(rulesOf(verdict), term).toContain('descriptor-contains-a-blocked-term')
      if (verdict.ok) continue
      const refusal = verdict.refusals.find(
        (candidate) => candidate.rule === 'descriptor-contains-a-blocked-term',
      )
      expect(refusal?.terms, term).toContain(term)
    }
  })

  it('refuses the descriptor Y-PAY-10’s manifest entry proposed', () => {
    // `BR SPA AUH` is the value the unit's own `provisional` field suggested, and it contains `SPA`.
    // That is the whole reason it was refused under brief rule 15 rather than written into a default,
    // and this case is where the reason is recorded as a fact rather than as an argument.
    const verdict = lintStatementDescriptor({ descriptor: 'BR SPA AUH', limit: 22 })
    expect(rulesOf(verdict)).toContain('descriptor-contains-a-blocked-term')
  })

  it('matches on whole words, so a legitimate descriptor is not condemned by a substring', () => {
    // `SPA` is a substring of `SPAIN`, `THAI` of `THAILAND`. A substring rule refuses legitimate
    // descriptors, and the way a rule that refuses legitimate values dies is by being switched off.
    expect(lintStatementDescriptor({ descriptor: 'ZZ SPAIN LTD', limit: 22 }).ok).toBe(true)
    expect(lintStatementDescriptor({ descriptor: 'ZZ THAILAND', limit: 22 }).ok).toBe(true)
    // And the control: the punctuation a card network permits is treated as a separator, so a term
    // cannot be hidden behind an asterisk or a hyphen.
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'BR*SPA', limit: 22 }))).toContain(
      'descriptor-contains-a-blocked-term',
    )
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'SPA-AUH', limit: 22 }))).toContain(
      'descriptor-contains-a-blocked-term',
    )
  })

  it('refuses a euphemism as well as the plain word', () => {
    // The euphemisms are blocked for a sharper reason than the service words: a statement line reading
    // RELAXATION is read as concealment, and a descriptor that invites a question has failed.
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'ZZ RELAXATION', limit: 22 }))).toContain(
      'descriptor-contains-a-blocked-term',
    )
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'ZZ WELLNESS', limit: 22 }))).toContain(
      'descriptor-contains-a-blocked-term',
    )
  })

  it('refuses characters a card network will not carry', () => {
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'بي ريلاكس', limit: 22 }))).toContain(
      'descriptor-has-unsupported-characters',
    )
  })

  it('answers "not configured" for an absent descriptor AND for a stored marker', () => {
    // Two shapes, one answer: `app_setting.value` is NOT NULL, so "nobody has chosen" is stored as a
    // marker the schema refuses rather than as a null, and a caller must not have to know which.
    expect(rulesOf(lintStatementDescriptor({ descriptor: null, limit: 22 }))).toContain(
      'descriptor-not-configured',
    )
    expect(
      rulesOf(
        lintStatementDescriptor({ descriptor: 'DESCRIPTOR-PENDING-Y7-DESCRIPTOR', limit: 22 }),
      ),
    ).toContain('descriptor-not-configured')
  })

  it('refuses a missing limit rather than assuming one', () => {
    // A default limit is the dangerous one: a descriptor silently cut to somebody else's length is a
    // valid statement line, and what was cut is the part that made it recognisable.
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'BR AUH 01', limit: null }))).toContain(
      'descriptor-limit-not-configured',
    )
    expect(rulesOf(lintStatementDescriptor({ descriptor: 'BR AUH 01', limit: 0 }))).toContain(
      'descriptor-limit-not-configured',
    )
  })

  it('names the open question in the refusal, so a reader knows what to go and ask', () => {
    const verdict = lintStatementDescriptor({ descriptor: null, limit: null })
    if (verdict.ok) throw new Error('an unset descriptor is refused')
    expect(verdict.refusals.map((refusal) => refusal.detail).join(' ')).toContain(
      DESCRIPTOR_OPEN_QUESTION,
    )
  })
})

describe('the privacy claim is narrow, and says what it does NOT conceal', () => {
  it('names what it conceals and the three things it does not', () => {
    // A reassurance wider than the mechanism is worse than no reassurance: a customer who believed
    // their visit was concealed and found a recognisable business name on a shared statement was
    // misled by this system rather than by the bank.
    expect(DESCRIPTOR_PRIVACY_CLAIM).toContain('not the treatment')
    expect(DESCRIPTOR_PRIVACY_CLAIM).toContain('does not hide that a payment was made')
    expect(DESCRIPTOR_PRIVACY_CLAIM).toContain('amount')
    expect(DESCRIPTOR_PRIVACY_CLAIM).toContain('does not hide the business')
    // And the control: it does not claim to hide the visit, which is the sentence somebody would write.
    expect(DESCRIPTOR_PRIVACY_CLAIM.toLowerCase()).not.toContain('private')
    expect(DESCRIPTOR_PRIVACY_CLAIM.toLowerCase()).not.toContain('confidential')
  })
})

describe('isPlaceholderDescriptor', () => {
  it('agrees with the markers the schema refuses, and not with a real descriptor', () => {
    expect(isPlaceholderDescriptor('DESCRIPTOR-PENDING-Y7-DESCRIPTOR')).toBe(true)
    expect(isPlaceholderDescriptor('  ')).toBe(true)
    expect(isPlaceholderDescriptor('TBC')).toBe(true)
    // The control.
    expect(isPlaceholderDescriptor('BR AUH 01')).toBe(false)
  })
})

describe('mayUseRealPaymentProvider', () => {
  const CONFIRMED = {
    isProduction: true,
    mcc: '0000',
    mccConfirmedAtIso: '2026-10-03T00:00:00.000Z',
    mccConfirmedBy: 'Fixture: no acquirer has issued an MCC',
  }

  it('permits a real provider only in production with all three MCC columns', () => {
    // The control for the four refusals below.
    expect(mayUseRealPaymentProvider(CONFIRMED).ok).toBe(true)
  })

  it('refuses outside production, naming it', () => {
    const verdict = mayUseRealPaymentProvider({ ...CONFIRMED, isProduction: false })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.reasons).toContain('not-production')
  })

  it('refuses each missing MCC column separately, because an operator needs to know which', () => {
    // The reasons read out of the verdict WITHOUT a throw in between, so a failure prints the rule names
    // rather than a sentence of this test's own: a gate case asserting rejection BY NAME (ADR 0003) has
    // to be able to find the name in the output it is given, and a thrown Error carries none.
    const reasonsOf = (verdict: ReturnType<typeof mayUseRealPaymentProvider>): readonly string[] =>
      verdict.ok ? ['(permitted)'] : verdict.reasons
    expect(reasonsOf(mayUseRealPaymentProvider({ ...CONFIRMED, mccConfirmedAtIso: null }))).toEqual(
      ['mcc-not-confirmed'],
    )
    expect(reasonsOf(mayUseRealPaymentProvider({ ...CONFIRMED, mcc: null }))).toEqual([
      'mcc-not-recorded',
    ])
    expect(reasonsOf(mayUseRealPaymentProvider({ ...CONFIRMED, mccConfirmedBy: null }))).toEqual([
      'mcc-confirmation-has-no-recorder',
    ])
  })

  it('accumulates every reason rather than stopping at the first', () => {
    const verdict = mayUseRealPaymentProvider({
      isProduction: false,
      mcc: null,
      mccConfirmedAtIso: null,
      mccConfirmedBy: null,
    })
    // The whole list, as values: a length assertion prints a number and names no rule.
    expect(verdict.ok ? ['(permitted)'] : [...verdict.reasons].sort()).toEqual(
      [
        'mcc-confirmation-has-no-recorder',
        'mcc-not-confirmed',
        'mcc-not-recorded',
        'not-production',
      ].sort(),
    )
    if (verdict.ok) throw new Error('nothing here permits a real provider')
    expect(realProviderRefusalDetail(verdict.reasons)).toContain(MCC_OPEN_QUESTION)
    // And the sentence says what remains available, so the answer is not only "no".
    expect(realProviderRefusalDetail(verdict.reasons)).toContain('manual adapter')
  })
})

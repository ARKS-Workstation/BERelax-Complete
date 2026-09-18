import { describe, expect, it } from 'vitest'
import {
  assertPublicDisplayNameCompliant,
  COMPLIANCE_LEXICON,
  type CompliancePolicy,
  lexiconTokens,
  lintPublicDisplayName,
  lintServiceName,
  PUBLIC_NAME_RULES,
  PublicDisplayNameRefused,
  type PublicNameRule,
  refusedRulesOf,
} from './lexicon.ts'

/**
 * B-CAT-05 — the public display-name lint.
 *
 * Two things are being asserted throughout, and the second is the one that keeps the first honest:
 * that the names which must be refused are refused **by the rule written for them**, and that the names
 * which must be accepted are accepted. A lint with no control is a lint that refuses everything, and the
 * first person to meet it switches it off.
 *
 * The eight seeded public names from 0017 are the most important control in the file. They are what the
 * business actually sells; a lint that refuses one of them cannot ship.
 */

/**
 * The seeded profile (migration 0004), which defaults to the **stricter** combination: wellness
 * vocabulary, no medical claims permitted, three permitted staff titles.
 *
 * Restated here rather than read, because `packages/core` may not touch a database. That the real row
 * still says this is asserted against PostgreSQL in
 * `packages/fixtures/src/catalogue-compliance.itest.ts` — the pair, not the copy, is the guarantee.
 */
const SEEDED: CompliancePolicy = {
  bannedClaimTerms: [
    'therapeutic',
    'therapy',
    'treatment',
    'pain relief',
    'rehabilitation',
    'cure',
    'heal',
    'medical',
    'clinical',
    'diagnosis',
    'prescribe',
    'physiotherapy',
    'lymphatic drainage',
    'prenatal',
  ],
  permittedPublicTitles: ['Therapist', 'Senior Therapist', 'Spa Therapist'],
  medicalClaimsPermitted: false,
}

/** The same profile after a lawyer confirms a healthcare licence: claims become descriptions. */
const HEALTHCARE: CompliancePolicy = { ...SEEDED, medicalClaimsPermitted: true }

const rulesFor = (name: string, policy: CompliancePolicy = SEEDED): readonly PublicNameRule[] =>
  lintPublicDisplayName(name, policy).map((finding) => finding.rule)

const termsFor = (name: string, policy: CompliancePolicy = SEEDED): readonly string[] =>
  lintPublicDisplayName(name, policy).map((finding) => finding.term)

describe('acceptance — Therapeutic Deep Tissue Treatment', () => {
  const NAME = 'Therapeutic Deep Tissue Treatment'

  it('is refused as a public display name, with the offending term named', () => {
    const findings = lintPublicDisplayName(NAME, SEEDED)
    expect(findings.map((f) => f.rule)).toContain('banned_claim_term')
    // Named, not merely counted: the owner has to know which word to change, and a test that asserted
    // only "one finding" would pass for a lint that fired on the wrong word.
    expect(findings.map((f) => f.term)).toEqual(['therapeutic', 'treatment'])
    for (const finding of findings) expect(finding.why).not.toBe('')
  })

  it('is accepted as the internal name — the same string, the other column', () => {
    expect(lintServiceName(NAME, 'internal', SEEDED)).toEqual([])
    // And the public scope of the same call still refuses it, so the scope is doing the work rather
    // than the lint having quietly stopped matching.
    expect(lintServiceName(NAME, 'public', SEEDED).length).toBeGreaterThan(0)
  })

  it('throws a named, user-facing refusal that carries every rule', () => {
    expect(() => assertPublicDisplayNameCompliant(NAME, SEEDED)).toThrow(PublicDisplayNameRefused)
    try {
      assertPublicDisplayNameCompliant(NAME, SEEDED)
      expect.unreachable('the name is not publishable')
    } catch (error) {
      expect(error).toBeInstanceOf(PublicDisplayNameRefused)
      const refused = error as PublicDisplayNameRefused
      expect(refused.kind).toBe('validation')
      expect(refused.userFacing).toBe(true)
      expect(refused.code).toBe('public_display_name_refused')
      expect(refused.details['rules']).toEqual(['banned_claim_term', 'banned_claim_term'])
      expect(refused.message).toContain('therapeutic')
      expect(refusedRulesOf(error)).toEqual(['banned_claim_term', 'banned_claim_term'])
    }
  })

  it('is accepted once the profile says medical claims are permitted', () => {
    // The flip that makes the term list DATA rather than code: under a healthcare licence
    // "therapeutic" describes what is delivered instead of overstating it (ADR 0020).
    expect(lintPublicDisplayName(NAME, HEALTHCARE)).toEqual([])
  })
})

describe('the eight names the business actually sells', () => {
  // Verbatim from the INSERT in 0017_catalogue.sql. If the lint refuses one of these it is wrong.
  const SEEDED_PUBLIC_NAMES = [
    'Normal Massage (Asian)',
    'Hot Oil / Balm Massage (Asian)',
    'Morocco Bath or Jacuzzi (Asian)',
    'Massage with Shaving (Asian)',
    'Normal Massage (Arabic)',
    'Hot Oil / Balm Massage (Arabic)',
    'Morocco Bath or Jacuzzi (Arabic)',
    'Massage with Shaving (Arabic)',
  ] as const

  for (const name of SEEDED_PUBLIC_NAMES) {
    it(`accepts ${name}`, () => {
      expect(lintPublicDisplayName(name, SEEDED)).toEqual([])
    })
  }

  it('accepts the style in brackets and refuses it in front of a person', () => {
    // The whole of ADR 0021 in one pair. "(Asian)" is a treatment style; "Asian therapist" is a claim
    // about who is on the premises.
    expect(rulesFor('Normal Massage (Asian)')).toEqual([])
    expect(rulesFor('Normal Massage by an Asian Therapist')).toEqual([
      'style_as_therapist_attribute',
    ])
  })
})

describe('the profile half — banned claim terms', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['Lymphatic Drainage Massage', 'lymphatic drainage'],
    ['Pain Relief Back Massage', 'pain relief'],
    ['Pain-Relief Back Massage', 'pain relief'],
    ['Prenatal Massage', 'prenatal'],
    ['Clinical Sports Massage', 'clinical'],
    ['Physiotherapy Massage', 'physiotherapy'],
    ['Massage Therapies', 'therapy'],
    ['Deep Tissue Treatments', 'treatment'],
    ['Healing Hands Massage', 'heal'],
    ['Curing Oil Massage', 'cure'],
  ]

  for (const [name, term] of cases) {
    it(`refuses "${name}" by the term "${term}"`, () => {
      const findings = lintPublicDisplayName(name, SEEDED)
      expect(findings.map((f) => f.rule)).toContain('banned_claim_term')
      expect(findings.map((f) => f.term)).toContain(term)
    })
  }

  it('matches whatever the case and the accents are', () => {
    expect(termsFor('THERAPEUTIC MASSAGE')).toEqual(['therapeutic'])
    expect(termsFor('Thérapeutic Massage')).toEqual(['therapeutic'])
  })

  it('does not mistake a permitted title for a banned claim', () => {
    // "therapist" is not "therapy". A substring match here would refuse the one job title the profile
    // explicitly permits, which is how a lint that nobody can satisfy arrives.
    expect(lintPublicDisplayName('Massage with a Senior Therapist', SEEDED)).toEqual([])
  })

  it('reads the list from the policy rather than from a copy of it', () => {
    const narrow: CompliancePolicy = { ...SEEDED, bannedClaimTerms: ['bamboo'] }
    expect(rulesFor('Therapeutic Massage', narrow)).toEqual([])
    expect(termsFor('Bamboo Massage', narrow)).toEqual(['bamboo'])
  })

  it('ignores an empty term rather than matching every name', () => {
    // An empty string in the array is a data defect; treated as a phrase it would match everything and
    // the lint would refuse the entire catalogue.
    const withBlank: CompliancePolicy = { ...SEEDED, bannedClaimTerms: ['', '   '] }
    expect(lintPublicDisplayName('Normal Massage (Asian)', withBlank)).toEqual([])
  })
})

describe('the code half — activities the licence does not cover', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['Hijama Session', 'hijama'],
    ['Cupping Massage', 'cupping'],
    ['Acupuncture and Oil Massage', 'acupuncture'],
    ['Laser Hair Removal', 'laser'],
    ['Botox Facial', 'botox'],
    ['IV Drip and Massage', 'iv drip'],
    ['Detox Wrap', 'detox'],
    ['Slimming Massage', 'slimming'],
    ['Outcall Massage', 'outcall'],
    ['Home Service Massage', 'home service'],
    ['24 Hours Massage', '24 hours'],
    ['24/7 Massage', '24 7'],
  ]

  for (const [name, term] of cases) {
    it(`refuses "${name}" by the term "${term}"`, () => {
      const findings = lintPublicDisplayName(name, SEEDED)
      expect(findings.map((f) => f.rule)).toContain('service_outside_the_licence')
      expect(findings.map((f) => f.term)).toContain(term)
    })
  }

  it('stays refused under a healthcare licence', () => {
    // `medicalClaimsPermitted` relaxes the profile's VOCABULARY, not what the premises may deliver. A
    // facility that genuinely performed cupping would be a code change reviewed by a human, which is
    // the right amount of ceremony for "we now advertise a medical procedure".
    expect(rulesFor('Hijama Session', HEALTHCARE)).toEqual(['service_outside_the_licence'])
  })
})

describe('the code half — names that read as a solicitation', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['Happy Ending Massage', 'happy ending'],
    ['Full Service Massage', 'full service'],
    ['Extra Service Massage', 'extra service'],
    ['Body to Body Massage', 'body to body'],
    ['Nuru Massage', 'nuru'],
    ['Sensual Oil Massage', 'sensual'],
    ['Erotic Massage', 'erotic'],
    ['Tantric Massage', 'tantric'],
    ['Escort Massage', 'escort'],
    ['No Rush Massage', 'no rush'],
  ]

  for (const [name, term] of cases) {
    it(`refuses "${name}" by the term "${term}"`, () => {
      const findings = lintPublicDisplayName(name, SEEDED)
      expect(findings.map((f) => f.rule)).toContain('reads_as_solicitation')
      expect(findings.map((f) => f.term)).toContain(term)
    })
  }

  it('is refused under every licence class, because no licence makes it lawful', () => {
    expect(rulesFor('Happy Ending Massage', HEALTHCARE)).toEqual(['reads_as_solicitation'])
    expect(
      rulesFor('Happy Ending Massage', {
        bannedClaimTerms: [],
        permittedPublicTitles: [],
        medicalClaimsPermitted: true,
      }),
    ).toEqual(['reads_as_solicitation'])
  })
})

describe('staff titles come from the profile', () => {
  it('refuses a title the profile does not permit, and names it', () => {
    const findings = lintPublicDisplayName('Massage by our Masseuse', SEEDED)
    expect(findings.map((f) => f.rule)).toEqual(['unpermitted_staff_title'])
    expect(findings[0]?.term).toBe('masseuse')
    // The message tells the owner what they MAY write, which is the difference between a refusal they
    // can act on and one they work around.
    expect(findings[0]?.why).toContain('Senior Therapist')
  })

  it('accepts the titles it does permit', () => {
    expect(lintPublicDisplayName('Massage with a Spa Therapist', SEEDED)).toEqual([])
  })

  it('follows the profile when the permitted list changes', () => {
    const strict: CompliancePolicy = { ...SEEDED, permittedPublicTitles: [] }
    expect(rulesFor('Massage with a Senior Therapist', strict)).toEqual(['unpermitted_staff_title'])
  })

  const titles: readonly string[] = [
    'Physio Massage',
    'Doctor Massage',
    'Dr Massage',
    'Nurse Massage',
    'Practitioner Massage',
    'Healer Massage',
    'Specialist Massage',
    'Technician Massage',
    'Massagist Massage',
    'Masseur Massage',
  ]
  for (const name of titles) {
    it(`refuses "${name}"`, () => {
      expect(rulesFor(name)).toContain('unpermitted_staff_title')
    })
  }
})

describe('a style is never an attribute of a therapist', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['Asian Masseuse Massage', 'asian masseuse'],
    ['Arabic Ladies Massage', 'arabic ladies'],
    ['Filipina Girls Massage', 'filipina girls'],
    ['Thai Lady Massage', 'thai lady'],
    ['Chinese Female Massage', 'chinese female'],
    ['Russian Staff Massage', 'russian staff'],
    ['Arabic Young Lady Massage', 'arabic lady'],
  ]

  for (const [name, term] of cases) {
    it(`refuses "${name}"`, () => {
      const findings = lintPublicDisplayName(name, SEEDED)
      expect(findings.map((f) => f.rule)).toContain('style_as_therapist_attribute')
      expect(findings.map((f) => f.term)).toContain(term)
    })
  }

  it('refuses it under every licence class', () => {
    expect(rulesFor('Asian Ladies Massage', HEALTHCARE)).toEqual(['style_as_therapist_attribute'])
  })

  it('does not refuse a women-only session, which is a legitimate thing to offer', () => {
    // The distinction the rule holds: a gendered word describing who the treatment is FOR is fine;
    // a style word attached to a person is not. Collapsing the two would delete the ability to name
    // the ladies-only session this market expects.
    expect(lintPublicDisplayName('Ladies Only Massage', SEEDED)).toEqual([])
    expect(lintPublicDisplayName('Gentlemen Only Jacuzzi', SEEDED)).toEqual([])
  })

  it('does not fire on a place name that is part of the treatment', () => {
    // "Morocco Bath" is a treatment, and "moroccan" is a style word. Neither is followed by a person.
    expect(lintPublicDisplayName('Moroccan Bath and Scrub', SEEDED)).toEqual([])
  })

  it('stops looking after two words, which is the documented edge of the rule', () => {
    expect(rulesFor('Asian Hot Oil and Honey Lady')).toEqual([])
  })

  it('reports both rules when a name breaks both', () => {
    expect(rulesFor('Asian Masseuse Massage')).toEqual([
      'unpermitted_staff_title',
      'style_as_therapist_attribute',
    ])
  })
})

describe('the lexicon itself', () => {
  it('gives every entry a rule this module declares and a reason a human wrote', () => {
    for (const entry of COMPLIANCE_LEXICON) {
      expect(PUBLIC_NAME_RULES).toContain(entry.rule)
      expect(entry.term.trim()).not.toBe('')
      // The reason is the point. A bare list of banned words invites the first reader who disagrees
      // with one entry to delete it; a sentence saying which regulator cares does not.
      expect(entry.why.length).toBeGreaterThan(20)
    }
  })

  it('spells every term in the normalised form it is matched in', () => {
    // A term with a capital or a stray accent would never match, and the gate would report a lint that
    // silently permits that word.
    for (const entry of COMPLIANCE_LEXICON) {
      expect(lexiconTokens(entry.term).join(' ')).toBe(entry.term)
    }
  })

  it('has no duplicate terms', () => {
    const terms = COMPLIANCE_LEXICON.map((entry) => entry.term)
    expect(new Set(terms).size).toBe(terms.length)
  })
})

describe('tokenisation', () => {
  it('splits on everything that is not a letter or a digit', () => {
    expect(lexiconTokens('Hot Oil / Balm Massage (Asian)')).toEqual([
      'hot',
      'oil',
      'balm',
      'massage',
      'asian',
    ])
  })

  it('keeps digits, which is how 24/7 is matched at all', () => {
    expect(lexiconTokens('24/7')).toEqual(['24', '7'])
  })

  it('produces nothing for a name in Arabic script, and the lint then finds nothing', () => {
    // A deliberate boundary, stated as a test rather than only in a comment: the Arabic public copy is
    // CMS content and is linted where it is rendered (W-SITE-05/W-SITE-10), not here.
    expect(lexiconTokens('مساج عربي')).toEqual([])
    expect(lintPublicDisplayName('مساج عربي', SEEDED)).toEqual([])
  })

  it('finds nothing in an empty name', () => {
    // The database refuses an empty public name (`service_names_nonempty`, 0017); this asserts the lint
    // does not throw on one, because the two guards run in the same request.
    expect(lintPublicDisplayName('   ', SEEDED)).toEqual([])
  })
})

describe('refusedRulesOf', () => {
  it('returns null for anything that is not this refusal', () => {
    expect(refusedRulesOf(new Error('something else'))).toBeNull()
    expect(refusedRulesOf(null)).toBeNull()
  })
})

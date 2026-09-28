import { describe, expect, it } from 'vitest'
import {
  assertPublicationCopyCompliant,
  bannedClaimVocabulary,
  PublicationCopyRefused,
  type PublishedCopyRegion,
  publicationCopyFindings,
  publicationCopyRefusalRulesOf,
} from './banned-claims.ts'
import { COMPLIANCE_LEXICON, type CompliancePolicy } from './lexicon.ts'

/**
 * W-SITE-10's acceptance corpus: ≥30 banned strings and ≥30 permitted strings, zero false positives and
 * zero false negatives.
 *
 * ## The two corpora are the assertion, and the permitted one is the harder half
 *
 * A lint that refused everything satisfies "zero false negatives" perfectly. So the permitted corpus is
 * not a courtesy: it is the control, and every string in it is prose a real page on this site would carry
 * — a spa describing what a massage feels like, in the vocabulary a wellness licence permits. Several of
 * them sit deliberately close to the line ("eases tension", "unwinds tight shoulders", "a ladies-only
 * session", "Normal Massage (Asian)") because a lint that caught those would be switched off inside a
 * week, which is the failure `lexicon.ts` says it is guarding against in its own header.
 *
 * ## Why the policy here is read from a literal and the profile is asserted elsewhere
 *
 * `packages/core` may not read a database, so a unit test cannot hold the real row. What it CAN do is make
 * the derivation falsifiable in both directions, and two cases below do that: the vocabulary count moves
 * with the policy, and a term added to the policy makes a previously permitted string fail. The row itself
 * — that `clinic` and `cure` really are on `regulatory_profile.banned_claim_terms` in force — is asserted
 * against the real table in `packages/fixtures/src/publication-control-plane.itest.ts`, which is the only
 * place that claim can be made honestly.
 */

/** The seeded profile after migration 0093: 0004's fourteen terms plus `clinic`. */
const POLICY: CompliancePolicy = {
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
    'clinic',
  ],
  permittedPublicTitles: ['Therapist', 'Senior Therapist', 'Spa Therapist'],
  medicalClaimsPermitted: false,
}

/**
 * Every string a page may not publish. The four the acceptance criterion names are the first four.
 *
 * Each is a phrase a real editor would type, not a bare keyword: the lint compares consecutive words, so a
 * corpus of single words would never exercise the phrase matching that `pain relief` and `lymphatic
 * drainage` need.
 */
const BANNED: readonly string[] = [
  // The acceptance criterion's own six.
  'How massage cures sciatica',
  'A medical treatment for lower back pain',
  'We start with a diagnosis of your posture',
  'Ask our doctor which oil suits you',
  'Our clinic is open seven days a week',
  'Deep tissue heals torn muscle fibre',
  // The rest of the profile's claim list, in the spellings that actually arrive.
  'A therapeutic hour for tired shoulders',
  'Aromatherapy therapy for stress',
  'Book a treatment this week',
  'Guaranteed pain relief in one session',
  'Post-injury rehabilitation for runners',
  'Curing insomnia with warm stones',
  'Healing hands, every day',
  'Backed by medical evidence',
  'A clinical approach to tension',
  'Our therapists prescribe a weekly rhythm',
  'Physiotherapy-grade pressure work',
  'Lymphatic drainage for puffiness',
  'A prenatal session in your third trimester',
  'Visit the clinics on Saadiyat',
  // Activities the licence does not cover, from the code half of the lexicon.
  'Cupping available on request',
  'Hijama by appointment',
  'Acupuncture and massage together',
  'Dry needling for knots',
  'Chiropractic adjustment included',
  'Osteopathy for the lower spine',
  'Laser hair removal downstairs',
  'Botox on Thursdays',
  'IV drip after your massage',
  'Detox wrap, ninety minutes',
  'Slimming programme, six weeks',
  'Outcall service across the island',
  'Home service available tonight',
  'Open 24 hours',
  // Names that read as a solicitation. No licence class permits any of these.
  'Full service massage',
  'Body to body, sixty minutes',
  'A sensual hour for two',
  'No rush, ever',
  // A person the profile does not permit naming in public copy.
  'Our masseuse will meet you at the door',
  'Ask the practitioner about pressure',
  // A treatment style attached to a person rather than to the treatment.
  'Our Filipina therapists are the best in Abu Dhabi',
  'Thai ladies on shift tonight',
]

/**
 * Every string a page may publish. The control, and the reason the corpus above proves anything.
 *
 * Written as the site's own voice, and several of them one word away from a finding on purpose.
 */
const PERMITTED: readonly string[] = [
  'What to expect on a first visit',
  'The desk takes your booking and shows you to the room',
  'Warm oil, low light, and ninety minutes to yourself',
  'Eases the tension a desk leaves in your shoulders',
  'Unwinds tight shoulders after a long week',
  'A ladies-only session every Sunday morning',
  'Normal Massage (Asian)',
  'Hot Oil / Balm Massage',
  'Arabic style, sixty or ninety minutes',
  'Our Senior Therapist has been with us since we opened',
  'A Spa Therapist will talk you through the pressure first',
  'Choose your pressure: light, medium or firm',
  'Rooms for two, if you would rather come together',
  'Trading hours are eleven in the morning until two at night',
  'Parking is free for the first two hours',
  'We are on the first floor, above the pharmacy',
  'Bring nothing; everything is provided',
  'Showers, robes and slippers are ready when you arrive',
  'Green tea afterwards, in the quiet room',
  'Prices include VAT',
  'Pay at the desk by card or cash',
  'Packages of five or ten sessions, valid a year',
  'Cancel up to four hours before with no charge',
  'Tell us at booking if you would prefer a female therapist',
  'Same-gender matching is the default and you never have to ask',
  'Rooms are cleaned between every session',
  'Linen is changed for each guest',
  'A quiet room with no music, if you prefer',
  'The gallery shows the rooms as they actually are',
  'Read what other guests have said',
  'See the full menu',
  'Our therapists speak Arabic, English and Tagalog',
  'Late sessions are the ones that fill first',
  'We are closed for one hour on Friday afternoon',
  'Gift vouchers are available at the desk',
]

const regions = (text: string): readonly PublishedCopyRegion[] => [{ region: 'body', text }]

const rulesFor = (text: string): readonly string[] =>
  publicationCopyFindings(regions(text), POLICY).map((finding) => finding.rule)

describe('acceptance — the corpus is big enough for the result to mean something', () => {
  it('holds at least thirty of each', () => {
    // ADR 0002 in the corpus itself: two short lists would make "zero false positives and zero false
    // negatives" a claim about six strings. Floors, not exact counts, so adding a case is not a test edit.
    expect(BANNED.length).toBeGreaterThanOrEqual(30)
    expect(PERMITTED.length).toBeGreaterThanOrEqual(30)
    // And no string is in both, which a copy-paste between the two lists would otherwise hide.
    expect(BANNED.filter((text) => PERMITTED.includes(text))).toEqual([])
  })
})

describe('acceptance — zero false negatives', () => {
  it.each(BANNED)('refuses %s', (text) => {
    const findings = publicationCopyFindings(regions(text), POLICY)
    expect(findings.length, `"${text}" was not refused`).toBeGreaterThan(0)
    // By rule name, and the rule has to be one the lexicon declares — a finding with an empty rule would
    // satisfy a bare length assertion.
    for (const finding of findings) {
      expect(finding.rule.length).toBeGreaterThan(3)
      expect(finding.term.length).toBeGreaterThan(1)
      expect(finding.region).toBe('body')
    }
  })
})

describe('acceptance — zero false positives', () => {
  it.each(PERMITTED)('permits %s', (text) => {
    expect(publicationCopyFindings(regions(text), POLICY), `"${text}" was refused`).toEqual([])
  })
})

describe('the acceptance criterion’s six named strings, each by the rule that catches it', () => {
  it('names banned_claim_term for cures, medical treatment, diagnosis, clinic and heals', () => {
    // Five of the six come from the PROFILE's list, which is what "derived from regulatory_profile" has to
    // mean. The rule name is asserted rather than the count, so a fixture caught by a different rule
    // cannot stand in for this one (ADR 0003 applied to a lint's own test).
    expect(rulesFor('How massage cures sciatica')).toContain('banned_claim_term')
    expect(rulesFor('A medical treatment for lower back pain')).toContain('banned_claim_term')
    expect(rulesFor('We start with a diagnosis of your posture')).toContain('banned_claim_term')
    expect(rulesFor('Our clinic is open seven days a week')).toContain('banned_claim_term')
    expect(rulesFor('Deep tissue heals torn muscle fibre')).toContain('banned_claim_term')
    // And the terms, so the inflection handling is what is being credited: `cures` for `cure`, `heals`
    // for `heal`, `clinic` for `clinic` and not for `clinical`.
    const terms = (text: string): readonly string[] =>
      publicationCopyFindings(regions(text), POLICY).map((finding) => finding.term)
    expect(terms('How massage cures sciatica')).toContain('cure')
    expect(terms('Deep tissue heals torn muscle fibre')).toContain('heal')
    expect(terms('Our clinic is open seven days a week')).toContain('clinic')
    expect(terms('Our clinic is open seven days a week')).not.toContain('clinical')
  })

  it('names unpermitted_staff_title for doctor, which no profile term covers', () => {
    // The sixth. `doctor` is not on the claim list and does not need to be: it is a PROVIDER_TITLE the
    // profile's permitted titles do not include, and adding it to the claim list would be a second
    // statement of the same refusal.
    expect(rulesFor('Ask our doctor which oil suits you')).toEqual(['unpermitted_staff_title'])
    expect(POLICY.bannedClaimTerms).not.toContain('doctor')
  })
})

describe('the vocabulary is DERIVED from the policy, not declared here', () => {
  it('counts the profile’s terms, the code half and the unpermitted titles', () => {
    const vocabulary = bannedClaimVocabulary(POLICY)
    // Every one of the profile's terms is in it, which is the half a hard-coded list would have lost.
    for (const term of POLICY.bannedClaimTerms) expect(vocabulary).toContain(term)
    // And the code half, which no licence class relaxes.
    for (const entry of COMPLIANCE_LEXICON) expect(vocabulary).toContain(entry.term)
    // `therapist` is permitted by this profile and so is absent; `masseuse` is not and so is present.
    expect(vocabulary).not.toContain('therapist')
    expect(vocabulary).toContain('masseuse')
    // The number the schema stores. > 0 is a CHECK in migration 0093, so this is the figure that makes a
    // recorded pass mean something.
    expect(vocabulary.length).toBeGreaterThan(POLICY.bannedClaimTerms.length)
  })

  it('shrinks by exactly the profile’s claim list under a healthcare licence', () => {
    // The flip, and the control on the derivation: under `medical_claims_permitted` the lint skips the
    // claim list wholesale (`lintPublicDisplayName` step 1), so a count that still included it would be
    // reporting terms the pass did not compare against.
    const healthcare: CompliancePolicy = { ...POLICY, medicalClaimsPermitted: true }
    expect(bannedClaimVocabulary(healthcare).length).toBe(
      bannedClaimVocabulary(POLICY).length - POLICY.bannedClaimTerms.length,
    )
    // And the behaviour that count describes: the same string is refused under one profile and permitted
    // under the other, which is the whole reason the list is data.
    expect(rulesFor('A therapeutic hour for tired shoulders')).toContain('banned_claim_term')
    expect(
      publicationCopyFindings(regions('A therapeutic hour for tired shoulders'), healthcare),
    ).toEqual([])
    // What does NOT relax: a solicitation is refused under every licence class.
    expect(
      publicationCopyFindings(regions('Full service massage'), healthcare).map((f) => f.rule),
    ).toEqual(['reads_as_solicitation'])
  })

  it('refuses a string the profile bans and permits it when the profile does not', () => {
    // The other direction of the same claim, and the one that would catch a list pasted into this file: a
    // word nobody has banned yet becomes a finding the moment the POLICY carries it, with no code change.
    const text = 'Our sauna is the warmest in the city'
    expect(publicationCopyFindings(regions(text), POLICY)).toEqual([])
    const stricter: CompliancePolicy = {
      ...POLICY,
      bannedClaimTerms: [...POLICY.bannedClaimTerms, 'sauna'],
    }
    expect(publicationCopyFindings(regions(text), stricter).map((f) => f.term)).toEqual(['sauna'])
  })
})

describe('the refusal an editor is shown', () => {
  it('names every region that carried a claim, in document order', () => {
    const findings = publicationCopyFindings(
      [
        { region: 'title', text: 'How massage cures sciatica' },
        { region: 'meta_description', text: 'What to expect on a first visit' },
        { region: 'body', text: 'Our clinic is open seven days a week' },
        { region: 'image_alt[hero]', text: 'A therapist warming oil between her palms' },
      ],
      POLICY,
    )
    expect(findings.map((finding) => finding.region)).toEqual(['title', 'body'])
    // The control: the two clean regions really were linted rather than skipped, which a findings list
    // alone cannot show. `therapist` is a permitted title, so the alt text is clean on the merits.
    expect(
      publicationCopyFindings([{ region: 'x', text: 'A therapist warming oil' }], POLICY),
    ).toEqual([])
  })

  it('throws rather than returning findings a caller may ignore, and carries the rules', () => {
    try {
      assertPublicationCopyCompliant(
        'journal_posts/how-massage-cures-sciatica',
        regions('How massage cures sciatica in our clinic'),
        POLICY,
      )
      expect.unreachable('a banned claim must refuse publication')
    } catch (error) {
      expect(error).toBeInstanceOf(PublicationCopyRefused)
      expect(publicationCopyRefusalRulesOf(error)).toEqual(['banned_claim_term'])
      // Deduplicated: two terms from one rule is one rule, because `details.rules` is what a caller
      // branches on and a repeated name would make a set assertion read as two problems.
      expect((error as PublicationCopyRefused).findings.map((f) => f.term)).toEqual([
        'cure',
        'clinic',
      ])
      expect(String(error)).toContain('journal_posts/how-massage-cures-sciatica')
    }
  })

  it('does not throw for compliant copy, and reports no rules for an unrelated error', () => {
    expect(() =>
      assertPublicationCopyCompliant('pages/about', regions(PERMITTED[0] as string), POLICY),
    ).not.toThrow()
    expect(publicationCopyRefusalRulesOf(new Error('something else'))).toBeNull()
    expect(publicationCopyRefusalRulesOf(null)).toBeNull()
  })
})

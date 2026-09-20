import type { CompliancePolicy } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { JOURNAL_POSTS } from './collections/journal-posts.ts'
import {
  assertCmsCopyCompliant,
  assertJournalPostPublishable,
  CmsCopyRefused,
  healthAdjacencyOf,
  type JournalPostForPublication,
  journalPostFindings,
  journalPostProse,
  journalRefusalRulesOf,
  lintCmsCopy,
  PUBLICATION_RULES,
  type PublicationContext,
  withoutLocators,
} from './publication.ts'

/**
 * W-SITE-07 — the publication lint.
 *
 * Every rule is asserted by name on a post that breaks it and on one that does not, which is the pairing
 * ADR 0003 asks for. The satisfying post is the control that matters most here: four rules that all refuse
 * would be indistinguishable from a guard that refuses everything, and "no post can be published" is in
 * fact the state of this site — so the positive case is the only thing that proves the guard is a guard.
 *
 * ## Why the bylines in this file are not names
 *
 * `Author 01` and `Reviewer 01` are labels, in the same shape as `Therapist 07` in
 * `packages/fixtures/src/synthetic.ts`: an internal reference that could not be mistaken for a person. The
 * fixture convention there is explicit about why — "a plausible name is a liability even when it is fake" —
 * and a test fixture that invented a plausible byline would be the first place such a name appeared in this
 * repository.
 */

/** The seeded profile: `licence_class = unconfirmed`, so medical claims are refused (0004). */
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
  ],
  permittedPublicTitles: ['Therapist', 'Senior Therapist', 'Spa Therapist'],
  medicalClaimsPermitted: false,
}

/** A post that satisfies every rule. Every case below starts here and removes one thing. */
const PUBLISHABLE: JournalPostForPublication = {
  slug: 'what-to-expect-on-a-first-visit',
  title: 'What to expect on a first visit',
  standfirst: 'How a session is booked, and what happens when you arrive.',
  bodyText:
    'The desk takes your booking, shows you to the room, and the session begins on the hour.',
  byline: 'Author 01',
  reviewedBy: 'Reviewer 01',
  publishedOn: '2026-09-19',
  healthTopicDeclared: false,
}

const DISCLAIMER: PublicationContext = {
  disclaimer: 'The wording the owner writes in Compliance notices.',
}
/** The state of the global today: created by Payload with every required field empty. */
const NO_DISCLAIMER: PublicationContext = { disclaimer: null }

const rulesOf = (
  post: JournalPostForPublication,
  context: PublicationContext = DISCLAIMER,
): readonly string[] => journalPostFindings(post, context).map((finding) => finding.rule)

describe('acceptance — a post without an author, a reviewer or a date fails publication by rule name', () => {
  it('publishes the post that carries all three', () => {
    // The control. Without it every assertion below is satisfied by a guard that refuses everything.
    expect(journalPostFindings(PUBLISHABLE, DISCLAIMER)).toEqual([])
    expect(() => assertJournalPostPublishable(PUBLISHABLE, DISCLAIMER)).not.toThrow()
  })

  it('refuses a post with no author byline', () => {
    expect(rulesOf({ ...PUBLISHABLE, byline: null })).toEqual([
      'journal_post_without_author_byline',
    ])
    // Blank is the same as absent: Payload stores an empty text field as `''`, and a post whose byline is a
    // space would otherwise publish with a byline nobody can read.
    expect(rulesOf({ ...PUBLISHABLE, byline: '   ' })).toEqual([
      'journal_post_without_author_byline',
    ])
  })

  it('refuses a post with no reviewer byline', () => {
    expect(rulesOf({ ...PUBLISHABLE, reviewedBy: null })).toEqual([
      'journal_post_without_reviewer_byline',
    ])
  })

  it('refuses a post with no date', () => {
    expect(rulesOf({ ...PUBLISHABLE, publishedOn: null })).toEqual(['journal_post_without_date'])
  })

  it('reports every missing field at once, in rule order', () => {
    const post = { ...PUBLISHABLE, byline: null, reviewedBy: '', publishedOn: null }
    expect(rulesOf(post)).toEqual([
      'journal_post_without_author_byline',
      'journal_post_without_reviewer_byline',
      'journal_post_without_date',
    ])
  })

  it('throws a refusal whose rules a caller can read without matching the message', () => {
    try {
      assertJournalPostPublishable({ ...PUBLISHABLE, byline: null }, DISCLAIMER)
      expect.unreachable('a post with no byline must not publish')
    } catch (err) {
      expect(journalRefusalRulesOf(err)).toEqual(['journal_post_without_author_byline'])
      expect(String(err)).toContain('journal_post_without_author_byline')
    }
    // The control on the reader: an unrelated error carries no rules rather than an empty list.
    expect(journalRefusalRulesOf(new Error('unrelated'))).toBeNull()
  })

  it('names a rule for every entry of PUBLICATION_RULES, so none is unreachable', () => {
    // A rule nobody can make fire is a rule that does not exist. Each is produced by one case above or the
    // disclaimer cases below; this asserts the set is exactly the four, so a fifth added without a test
    // fails here.
    const fired = new Set([
      ...rulesOf({ ...PUBLISHABLE, byline: null, reviewedBy: null, publishedOn: null }),
      ...rulesOf({ ...PUBLISHABLE, healthTopicDeclared: true }, NO_DISCLAIMER),
    ])
    expect([...fired].sort()).toEqual([...PUBLICATION_RULES].sort())
  })
})

describe('acceptance — health-adjacent copy needs the disclaimer, and the disclaimer is the owner’s', () => {
  it('detects health adjacency from the copy, not only from the checkbox', () => {
    const detected = healthAdjacencyOf(
      'A note on lower back pain and what we cannot do about it',
      false,
    )
    expect(detected.adjacent).toBe(true)
    expect(detected.declared).toBe(false)
    expect([...detected.detected]).toContain('pain')
    // The control: ordinary copy about the premises is not health-adjacent, or the rule would require the
    // disclaimer on every post and say nothing.
    const plain = healthAdjacencyOf('Where to park, and which floor the desk is on', false)
    expect(plain.adjacent).toBe(false)
    expect([...plain.detected]).toEqual([])
  })

  it('takes the editor’s declaration as sufficient on its own', () => {
    const declared = healthAdjacencyOf('Nothing in this sentence is a health word', true)
    expect(declared.adjacent).toBe(true)
    expect(declared.declared).toBe(true)
    expect([...declared.detected]).toEqual([])
  })

  it('refuses health-adjacent copy while the disclaimer global is empty', () => {
    expect(rulesOf({ ...PUBLISHABLE, healthTopicDeclared: true }, NO_DISCLAIMER)).toEqual([
      'journal_post_health_adjacent_without_disclaimer',
    ])
    expect(
      rulesOf(
        { ...PUBLISHABLE, bodyText: 'What to tell us about an injury before a session.' },
        NO_DISCLAIMER,
      ),
    ).toEqual(['journal_post_health_adjacent_without_disclaimer'])
    // And the why says which of the two inputs made it health-adjacent, because the editor who did not tick
    // the box has to be told what in their copy did.
    const finding = journalPostFindings(
      { ...PUBLISHABLE, bodyText: 'What to tell us about an injury before a session.' },
      NO_DISCLAIMER,
    )[0]
    expect(finding?.why).toContain('injury')
  })

  it('publishes health-adjacent copy once the disclaimer exists', () => {
    // The control for the rule, and the reason it is a *requirement* rather than a ban: health-adjacent copy
    // is publishable, with the disclaimer beside it.
    expect(journalPostFindings({ ...PUBLISHABLE, healthTopicDeclared: true }, DISCLAIMER)).toEqual(
      [],
    )
    // A blank global is the same as an absent one: `compliance_notices` is created by Payload with empty
    // required fields until the owner writes them.
    expect(rulesOf({ ...PUBLISHABLE, healthTopicDeclared: true }, { disclaimer: '  ' })).toEqual([
      'journal_post_health_adjacent_without_disclaimer',
    ])
  })

  it('reads the title and the standfirst as well as the body', () => {
    // A claim in a headline is the claim most likely to be quoted, so the prose the lint sees is all three.
    const prose = journalPostProse({ ...PUBLISHABLE, title: 'On pain' })
    expect(prose).toContain('On pain')
    expect(prose).toContain(PUBLISHABLE.standfirst ?? '')
    expect(prose).toContain(PUBLISHABLE.bodyText)
    expect(healthAdjacencyOf(prose, false).adjacent).toBe(true)
    // A null standfirst contributes nothing rather than the string "null".
    expect(journalPostProse({ ...PUBLISHABLE, standfirst: null })).not.toContain('null')
  })
})

describe('acceptance — published CMS copy passes the banned-claims lint, and a claim fails by rule name', () => {
  it('refuses a post containing "cures sciatica", naming banned_claim_term', () => {
    // The acceptance criterion's own fixture. `cure` is on `regulatory_profile.banned_claim_terms` under the
    // seeded profile and `tokenMatches` handles the inflection, so "cures" is the same claim as "cure".
    const findings = lintCmsCopy(
      [{ where: 'journal_posts/how-massage-cures-sciatica', text: 'How massage cures sciatica' }],
      POLICY,
    )
    expect(findings.map((finding) => finding.rule)).toEqual(['banned_claim_term'])
    expect(findings[0]?.term).toBe('cure')
    expect(findings[0]?.where).toBe('journal_posts/how-massage-cures-sciatica')
  })

  it('throws, rather than returning findings a caller may ignore', () => {
    try {
      assertCmsCopyCompliant([{ where: 'faq_entries/1', text: 'We cure sciatica' }], POLICY)
      expect.unreachable('a banned claim must refuse publication')
    } catch (err) {
      expect(err).toBeInstanceOf(CmsCopyRefused)
      expect(String(err)).toContain('banned_claim_term')
      expect((err as CmsCopyRefused).findings.map((finding) => finding.term)).toEqual(['cure'])
    }
  })

  it('passes copy that makes no claim', () => {
    // The control. Without it the lint could refuse everything and every assertion above would hold.
    expect(lintCmsCopy([{ where: 'pages/about', text: PUBLISHABLE.bodyText }], POLICY)).toEqual([])
    expect(() =>
      assertCmsCopyCompliant([{ where: 'pages/about', text: PUBLISHABLE.bodyText }], POLICY),
    ).not.toThrow()
  })

  it('does not read a URL as a claim, and does read the prose around it', () => {
    // The `/llms.txt` decision, applied here: `lexiconTokens` splits on every non-alphanumeric character, so
    // a link to the catalogue index contributes the token `treatments` — and `treatment` is a banned claim
    // term. A lint that refused a page for linking to the most valuable pages on the site is one somebody
    // switches off.
    //
    // The LINT is asserted before the mechanism, and the order is deliberate: this is the assertion whose
    // failure prints the finding, and therefore the rule name, which is what gate 60e reads to prove itself
    // (ADR 0003). With `withoutLocators` asserted first, neutering it failed this test with "expected '…' not
    // to contain 'treatments'" — a real failure that named no rule, so the gate reported PASS over a test it
    // had broken. It fired on exactly that.
    expect(
      lintCmsCopy([{ where: 'pages/about', text: 'See https://x.test/treatments' }], POLICY),
    ).toEqual([])
    expect(
      lintCmsCopy([{ where: 'pages/about', text: '[the menu](/treatments)' }], POLICY),
    ).toEqual([])
    expect(withoutLocators('See https://x.test/treatments for the menu')).not.toContain(
      'treatments',
    )
    // The control, and the half that must not be excluded with it: the same word in prose is still a claim.
    expect(
      lintCmsCopy([{ where: 'pages/about', text: 'Our treatment cures backs' }], POLICY).map(
        (finding) => finding.term,
      ),
    ).toEqual(['treatment', 'cure'])
  })

  it('still refuses the disclaimer’s own words when they appear in a POST', () => {
    // The other half of the one exemption `apps/web/src/cms/page-data.ts` argues for. The compliance-locked
    // global's wording — W-SYS-08's fixture is "Massage is not a medical treatment." — is rendered verbatim and
    // never linted, because the medical-disclaimer pattern works by NEGATING a claim and a lexicon built to
    // stop the business asserting `medical` and `treatment` will always refuse the sentence that denies them.
    // That exemption is only defensible while the lexicon still bites everywhere else, which is this
    // assertion: the identical words in editor content are refused, by name, with both terms reported.
    const findings = lintCmsCopy(
      [{ where: 'journal_posts/a-post', text: 'Massage is not a medical treatment.' }],
      POLICY,
    )
    expect(findings.map((finding) => finding.rule)).toEqual([
      'banned_claim_term',
      'banned_claim_term',
    ])
    expect(findings.map((finding) => finding.term).sort()).toEqual(['medical', 'treatment'])
  })

  it('reports the document a finding came from, for every entry', () => {
    const findings = lintCmsCopy(
      [
        { where: 'faq_entries/a', text: 'A clinical diagnosis' },
        { where: 'journal_posts/b', text: 'Nothing wrong here' },
      ],
      POLICY,
    )
    expect(findings.map((finding) => finding.where)).toEqual(['faq_entries/a', 'faq_entries/a'])
  })
})

describe('the collection carries the fields the lint reads', () => {
  it('declares byline, reviewed_by, published_on and health_topic', () => {
    // The lint reads four fields off a document, and a field renamed in the model without a change here is a
    // lint that silently reads `undefined` and passes every post. W-SITE-03 pinned the FAQ builder to
    // `FAQ_ENTRIES.fields` for the same reason.
    const names = JOURNAL_POSTS.fields.map((field) => field.name)
    for (const field of ['byline', 'reviewed_by', 'published_on', 'health_topic']) {
      expect(names, field).toContain(field)
    }
  })

  it('leaves all four optional on the collection, so a draft can be saved without them', () => {
    // `required: true` is enforced on every save, including a draft — and the field exists precisely because
    // nobody has a name to put in it yet. A draft may be incomplete; `assertJournalPostPublishable` is what
    // makes a *published* post complete.
    for (const name of ['byline', 'reviewed_by', 'published_on', 'health_topic']) {
      const field = JOURNAL_POSTS.fields.find((candidate) => candidate.name === name)
      expect(field, name).toBeDefined()
      expect((field as { required?: boolean }).required, name).toBeUndefined()
    }
    // The control: the fields that ARE required stayed required.
    const body = JOURNAL_POSTS.fields.find((field) => field.name === 'body')
    expect(body?.required).toBe(true)
  })
})

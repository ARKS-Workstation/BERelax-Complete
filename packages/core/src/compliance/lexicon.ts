import { AppError } from '@berelax/shared'

/**
 * The public display-name compliance lint (B-CAT-05, ADR 0020).
 *
 * The business is a licensed massage and spa in **Abu Dhabi**: a commercial activity licensed by ADDED,
 * with the Department of Health regulating anything that counts as a health service. Not Dubai, and not
 * a clinic. Two consequences drive every rule below.
 *
 *   1. **A name that implies a medical treatment, a therapeutic benefit, or any activity the licence
 *      does not cover is a regulatory problem, not a wording preference.** It is advertising an activity
 *      the premises is not licensed for, which is what an inspection acts on, and it is the same
 *      exposure whether the word was chosen by a marketer or typed into an admin field at 23:00.
 *   2. **A name that reads as a solicitation is worse.** For a massage business in this market that is
 *      the accusation that closes premises, and no licence class makes it acceptable.
 *
 * So this is a guard rail, not a euphemism filter. It does not try to outwit a determined evader — a
 * deliberate evasion is a staffing problem, and a filter that chases spellings starts refusing
 * legitimate names. It refuses the spellings that actually arrive: the word a WordPress theme suggested,
 * the phrase copied off a competitor's site, the nationality that crept out of the treatment style and
 * onto the person delivering it.
 *
 * ## Why it applies to the public name only
 *
 * `service.public_display_name` reaches a customer; `service.internal_name` is what the front desk
 * calls the treatment on the rota. Linting the internal label would be a rule nobody can satisfy with a
 * customer waiting, and it would delete the only place the plain word can be written down. 0017 split
 * the column for exactly this, and `lintServiceName` takes the scope so the asymmetry is in one place
 * rather than in every caller's `if`.
 *
 * ## Why the list is half data and half code
 *
 * The **claim** terms and the **permitted staff titles** come from `regulatory_profile` (0004): they
 * depend on the licence class, which is an open question (Y1-licence) whose answer a lawyer will
 * eventually give, and a versioned data row is what lets the answer reach this lint without a deploy.
 * `medicalClaimsPermitted` is that switch: under a healthcare licence "therapeutic" is a description
 * rather than a claim.
 *
 * The rest is **code**, because no licence class makes it permissible. A spa licence does not become a
 * DoH facility licence, and nothing makes a solicitation legal. Each of those terms carries the reason
 * it is refused as a comment, which is the only form in which the reason survives: a bare list invites
 * the first reader who disagrees with one entry to delete it.
 *
 * ## Purity, and why the profile is an argument
 *
 * `packages/core` may not read a database, so the caller passes the policy in. That is also what makes
 * the flip testable: the same string is refused under the seeded profile and accepted under a
 * healthcare one, asserted in `packages/fixtures/src/catalogue-compliance.itest.ts` against a real
 * `regulatory_profile` row rather than a hand-made object.
 *
 * Scope: Latin-script names. The Arabic public copy is CMS content (`service-narrative`) and is linted
 * where it is rendered (W-SITE-05, W-SITE-10); a name written only in Arabic script produces no
 * findings here, which is a deliberate boundary and not a hole in the rule.
 */

/** The rules, by name. A finding names one of these, so a reworded message is not a reworded rule. */
export const PUBLIC_NAME_RULES = [
  'banned_claim_term',
  'service_outside_the_licence',
  'reads_as_solicitation',
  'unpermitted_staff_title',
  'style_as_therapist_attribute',
] as const
export type PublicNameRule = (typeof PUBLIC_NAME_RULES)[number]

/** One entry of the code half of the lexicon. */
export interface LexiconEntry {
  /** The phrase, in the spelling a human would write. Matched case-, accent- and punctuation-blind. */
  readonly term: string
  readonly rule: PublicNameRule
  /** Why this is refused, in a sentence, for the message the admin screen shows. */
  readonly why: string
}

/**
 * Terms no licence class permits on a public name.
 *
 * Two groups, and the reason each term is here is written next to it rather than implied by the group.
 */
export const COMPLIANCE_LEXICON: readonly LexiconEntry[] = Object.freeze([
  // --- Activities a spa licence does not cover -------------------------------------------------
  // Each of these is a health service in Abu Dhabi: performing it needs a DoH-licensed facility and a
  // licensed practitioner. Advertising it on a massage licence advertises an activity the premises may
  // not deliver, which is actionable whether or not anybody ever delivers it.
  {
    term: 'cupping',
    rule: 'service_outside_the_licence',
    why: 'cupping is a health service requiring a Department of Health facility licence, which a massage and spa licence is not',
  },
  {
    term: 'hijama',
    rule: 'service_outside_the_licence',
    why: 'hijama (wet cupping) draws blood and is a licensed health service, not a spa treatment',
  },
  {
    term: 'acupuncture',
    rule: 'service_outside_the_licence',
    why: 'acupuncture is regulated as a health service and needs a licensed practitioner',
  },
  {
    term: 'dry needling',
    rule: 'service_outside_the_licence',
    why: 'dry needling is a clinical intervention performed by licensed health professionals',
  },
  {
    term: 'chiropractic',
    rule: 'service_outside_the_licence',
    why: 'chiropractic is a Department of Health regulated profession with its own facility licence',
  },
  {
    term: 'osteopathy',
    rule: 'service_outside_the_licence',
    why: 'osteopathy is a Department of Health regulated profession with its own facility licence',
  },
  {
    term: 'laser',
    rule: 'service_outside_the_licence',
    why: 'laser work is a medical or cosmetic-device activity needing its own licence and trained operator',
  },
  {
    term: 'botox',
    rule: 'service_outside_the_licence',
    why: 'injectables are a medical activity; naming one on a spa menu advertises unlicensed medicine',
  },
  {
    term: 'filler',
    rule: 'service_outside_the_licence',
    why: 'injectables are a medical activity; naming one on a spa menu advertises unlicensed medicine',
  },
  {
    term: 'injection',
    rule: 'service_outside_the_licence',
    why: 'anything injected is a medical act and cannot be delivered under this licence',
  },
  {
    term: 'iv drip',
    rule: 'service_outside_the_licence',
    why: 'intravenous therapy is a medical act requiring a health facility licence',
  },
  {
    term: 'detox',
    rule: 'service_outside_the_licence',
    why: 'a detox claim asserts a physiological effect on the body, which is a health claim this licence does not carry',
  },
  {
    term: 'slimming',
    rule: 'service_outside_the_licence',
    why: 'weight-reduction claims are health claims; the DoH regulates who may make them',
  },
  {
    term: 'weight loss',
    rule: 'service_outside_the_licence',
    why: 'weight-reduction claims are health claims; the DoH regulates who may make them',
  },
  // The premises is licensed, and so are its hours: trading runs 11:00–02:00 (docs/13). A name that
  // offers the treatment somewhere else, or at any hour, advertises outside the licence.
  {
    term: 'outcall',
    rule: 'service_outside_the_licence',
    why: 'the licence covers this premises; an off-site service is a different activity and, in this trade, the one an inspector reads as solicitation',
  },
  {
    term: 'home service',
    rule: 'service_outside_the_licence',
    why: 'the licence covers this premises; a home visit is a different activity and, in this trade, the one an inspector reads as solicitation',
  },
  {
    term: 'home visit',
    rule: 'service_outside_the_licence',
    why: 'the licence covers this premises; a home visit is a different activity and, in this trade, the one an inspector reads as solicitation',
  },
  {
    term: 'hotel visit',
    rule: 'service_outside_the_licence',
    why: 'the licence covers this premises; a hotel visit is a different activity and, in this trade, the one an inspector reads as solicitation',
  },
  {
    term: '24 hours',
    rule: 'service_outside_the_licence',
    why: 'trading hours are part of the licence (11:00–02:00); advertising round-the-clock service advertises hours the premises does not hold',
  },
  {
    term: '24 7',
    rule: 'service_outside_the_licence',
    why: 'trading hours are part of the licence (11:00–02:00); advertising round-the-clock service advertises hours the premises does not hold',
  },

  // --- Names that read as a solicitation -------------------------------------------------------
  // These are the accusation that closes a massage premises, and they are refused under every licence
  // class, medical_claims_permitted or not. The public name is the single most-indexed sentence this
  // business publishes, so it is the one place the wording has to be beyond argument.
  {
    term: 'happy ending',
    rule: 'reads_as_solicitation',
    why: 'an established euphemism for a sexual service; on a public menu it is an advertisement for one',
  },
  {
    term: 'full service',
    rule: 'reads_as_solicitation',
    why: 'in this trade "full service" reads as a sexual service, whatever it was meant to describe — say what the treatment includes instead',
  },
  {
    term: 'extra service',
    rule: 'reads_as_solicitation',
    why: 'an unnamed extra beyond the menu is exactly the implication an inspection treats as solicitation',
  },
  {
    term: 'special service',
    rule: 'reads_as_solicitation',
    why: 'an unnamed special beyond the menu is exactly the implication an inspection treats as solicitation',
  },
  {
    term: 'body to body',
    rule: 'reads_as_solicitation',
    why: 'describes contact no licensed massage protocol includes, and is a recognised solicitation signal',
  },
  {
    term: 'nuru',
    rule: 'reads_as_solicitation',
    why: 'names a sexual service; there is no reading of it that a licence covers',
  },
  {
    term: 'sensual',
    rule: 'reads_as_solicitation',
    why: 'sexualises the treatment; a spa treatment is described by what it does for the muscles, not by desire',
  },
  {
    term: 'erotic',
    rule: 'reads_as_solicitation',
    why: 'names a sexual service; there is no reading of it that a licence covers',
  },
  {
    term: 'tantric',
    rule: 'reads_as_solicitation',
    why: 'marketed elsewhere as a sexual service, and read that way here — the treatment style is named by the catalogue, not by this word',
  },
  {
    term: 'escort',
    rule: 'reads_as_solicitation',
    why: 'names a criminal offence in the UAE and has no place on any menu',
  },
  {
    term: 'call girl',
    rule: 'reads_as_solicitation',
    why: 'names a criminal offence in the UAE and has no place on any menu',
  },
  {
    term: 'no rush',
    rule: 'reads_as_solicitation',
    why: 'a stock phrase of solicitation advertising; the duration is on the menu, so this adds nothing a customer needs',
  },
])

/**
 * Words naming the person who delivers the treatment.
 *
 * A public service name has no business naming one at all — the menu sells a treatment, the rota
 * assigns a person — so any of these that is not a title the profile permits is refused. `therapist`
 * is in the list on purpose: it is refused or permitted by `permittedPublicTitles`, which is data, and
 * hard-coding it as acceptable here would put the decision in two places.
 *
 * Exported for the review router, whose `names_an_individual` rule asks the opposite question of the
 * same words: a review that says "the therapist Mina" identifies a person, and confirming publicly
 * that a named individual was on shift — or was a client — is the confidentiality breach docs/07 §4
 * names first. One list, two readings, rather than two lists that drift.
 */
export const PROVIDER_TITLES: readonly string[] = Object.freeze([
  'therapist',
  'masseuse',
  'masseur',
  'massagist',
  'physiotherapist',
  'physio',
  'doctor',
  'dr',
  'nurse',
  'practitioner',
  'healer',
  'specialist',
  'technician',
])

/**
 * Words that denote a person, used only by `style_as_therapist_attribute`.
 *
 * Wider than `PROVIDER_TITLES` because the failure this rule catches is usually gendered rather than
 * professional: "Asian ladies", "Filipina girls". Gendered words are **not** refused on their own — a
 * ladies-only session is a legitimate and, in this market, important thing to be able to name. What is
 * refused is a treatment style attached to a person.
 */
const PERSON_WORDS: readonly string[] = Object.freeze([
  ...PROVIDER_TITLES,
  'girl',
  'lady',
  'woman',
  'female',
  'boy',
  'man',
  'male',
  'guy',
  'staff',
  'team',
])

/**
 * Treatment styles and the nationalities they get confused with.
 *
 * `asian` and `arabic` are the two styles in the catalogue (ADR 0021) and both are perfectly good words
 * — `Normal Massage (Asian)` is the seeded public name. The rest are here because they arrive in the
 * same sentence position: a style is a way of working, and the moment it qualifies a person it has
 * become a claim about who is on the premises. That is the line this rule holds.
 */
const STYLE_WORDS: readonly string[] = Object.freeze([
  'asian',
  'arabic',
  'arabian',
  'thai',
  'filipina',
  'filipino',
  'chinese',
  'japanese',
  'korean',
  'indonesian',
  'balinese',
  'indian',
  'moroccan',
  'russian',
  'european',
  'african',
  'ethiopian',
])

/** How far apart a style word and a person word may be and still be one phrase. */
const STYLE_ATTRIBUTION_WINDOW = 2

export interface CompliancePolicy {
  /** `regulatory_profile.banned_claim_terms`. Claims, not vocabulary: a licence-class question. */
  readonly bannedClaimTerms: readonly string[]
  /** `regulatory_profile.permitted_public_titles`, verbatim — 'Therapist', 'Senior Therapist'. */
  readonly permittedPublicTitles: readonly string[]
  /** `regulatory_profile.medical_claims_permitted`. False under the stricter default (0004). */
  readonly medicalClaimsPermitted: boolean
}

export interface PublicNameFinding {
  readonly rule: PublicNameRule
  /** The offending phrase as the lexicon spells it, so a message can name it. */
  readonly term: string
  readonly why: string
}

/** Which of the two name columns is being linted. `internal` is exempt; see the module header. */
export type NameScope = 'public' | 'internal'

/**
 * A name reduced to comparable words.
 *
 * Case and accents are removed, because "Therapeutic", "THERAPEUTIC" and "Thérapeutic" are the same
 * claim to a regulator and the same word to a customer. Splitting on everything that is not a letter or
 * a digit makes the hyphen, the slash in "Hot Oil / Balm Massage" and the brackets in "(Asian)"
 * separators rather than parts of a word — which is how "pain-relief massage" is caught by the banned
 * phrase "pain relief" without the list having to carry both spellings.
 *
 * Exported because the DB-side chokepoint and the tests both need to show what the lint actually
 * compared; a lint whose input cannot be inspected is one nobody can argue with.
 */
export function lexiconTokens(value: string): readonly string[] {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

/**
 * One token against one wanted word, tolerating the inflections that carry the same claim.
 *
 * "Treatments" is the same claim as "treatment", "ladies" the same word as "lady", and — the one that
 * matters most here — "healing" the same claim as "heal", which the profile bans. A name is refused for
 * what it asserts, and an -ing is an assertion in the present tense.
 *
 * Stemming stops there deliberately. A real stemmer starts matching words nobody banned, and a lint
 * that refuses a legitimate name is a lint somebody switches off.
 */
function tokenMatches(token: string, want: string): boolean {
  if (token === want) return true
  if (token === `${want}s` || token === `${want}es`) return true
  if (token === `${want}ing`) return true
  // cure -> curing, prescribe -> prescribing: the silent -e is dropped before -ing.
  if (want.endsWith('e') && token === `${want.slice(0, -1)}ing`) return true
  // lady -> ladies. The -s and -es forms above cover everything else.
  return want.endsWith('y') && token === `${want.slice(0, -1)}ies`
}

/**
 * Whether a phrase — one word or several — appears in the tokens, as consecutive words.
 *
 * Exported for the review router (G-REV-03), which reuses {@link COMPLIANCE_LEXICON} against review
 * text rather than keeping a second list of the same terms. It must compare the same way this lint
 * does, or a phrase this module refuses on a menu would be missed in a review that alleges we
 * delivered it. The tokens are the caller's, because review text is not Latin-only — see
 * `packages/core/src/reviews/escalation-lexicon.ts`.
 */
export function containsPhrase(tokens: readonly string[], phrase: string): boolean {
  const want = lexiconTokens(phrase)
  if (want.length === 0) return false
  for (let start = 0; start + want.length <= tokens.length; start += 1) {
    if (want.every((word, offset) => tokenMatches(tokens[start + offset] as string, word))) {
      return true
    }
  }
  return false
}

/** True when the token is one of the titles the profile permits to appear publicly. */
function isPermittedTitle(token: string, policy: CompliancePolicy): boolean {
  return policy.permittedPublicTitles.some((title) =>
    lexiconTokens(title).some((word) => tokenMatches(token, word)),
  )
}

/**
 * Every reason this name may not be shown to a customer, in rule order.
 *
 * All of them, not the first: an owner who is told about one word fixes that word and submits the same
 * name again. The four findings for "Therapeutic massage by our Filipina masseuse" are four edits, and
 * they are worth making in one pass.
 */
export function lintPublicDisplayName(
  name: string,
  policy: CompliancePolicy,
): readonly PublicNameFinding[] {
  const tokens = lexiconTokens(name)
  const findings: PublicNameFinding[] = []

  // 1. The profile's claim list. Skipped wholesale when the licence permits medical claims: under a
  //    healthcare licence "therapeutic" describes what is delivered rather than overstating it, which
  //    is the whole reason regulatory_profile carries the switch (ADR 0020).
  if (!policy.medicalClaimsPermitted) {
    for (const term of policy.bannedClaimTerms) {
      if (containsPhrase(tokens, term)) {
        findings.push({
          rule: 'banned_claim_term',
          term,
          why:
            `"${term}" claims a medical or therapeutic effect. The licence is a massage and spa ` +
            'activity, so the claim describes something the premises may not deliver',
        })
      }
    }
  }

  // 2. The code half: activities no licence class covers, and names that read as a solicitation.
  for (const entry of COMPLIANCE_LEXICON) {
    if (containsPhrase(tokens, entry.term)) {
      findings.push({ rule: entry.rule, term: entry.term, why: entry.why })
    }
  }

  // 3. A person the profile does not permit naming. The menu sells a treatment; who delivers it is the
  //    rota's answer and changes after the customer has booked.
  for (const token of tokens) {
    if (!PROVIDER_TITLES.includes(token)) continue
    if (isPermittedTitle(token, policy)) continue
    findings.push({
      rule: 'unpermitted_staff_title',
      term: token,
      why:
        `"${token}" is not one of the staff titles the regulatory profile permits in public copy ` +
        `(${policy.permittedPublicTitles.join(', ')})`,
    })
  }

  // 4. A treatment style attached to a person. Style is how the treatment is delivered (ADR 0021) —
  //    it decides the required skill and nothing about who is on the premises. Written as an attribute
  //    of the therapist it becomes an advertisement about people, which is both a compliance exposure
  //    and the thing this catalogue is shaped to make impossible.
  tokens.forEach((token, index) => {
    if (!STYLE_WORDS.includes(token)) return
    const window = tokens.slice(index + 1, index + 1 + STYLE_ATTRIBUTION_WINDOW)
    const person = window.find((candidate) =>
      PERSON_WORDS.some((word) => tokenMatches(candidate, word)),
    )
    if (person === undefined) return
    findings.push({
      rule: 'style_as_therapist_attribute',
      term: `${token} ${person}`,
      why:
        `"${token}" is a treatment style, not an attribute of whoever delivers it. Name the style ` +
        'against the treatment — "Normal Massage (Asian)" — and never against a person',
    })
  })

  return Object.freeze(findings)
}

/**
 * The lint, scoped.
 *
 * `internal` returns nothing, and that is the whole asymmetry of 0017's two name columns: the front
 * desk's own words for a treatment are not published, and a lint on them would be a rule nobody can
 * satisfy at 23:00 with a customer at the desk.
 */
export function lintServiceName(
  name: string,
  scope: NameScope,
  policy: CompliancePolicy,
): readonly PublicNameFinding[] {
  return scope === 'public' ? lintPublicDisplayName(name, policy) : Object.freeze([])
}

/**
 * Raised when a public display name may not be published.
 *
 * `userFacing`, because the person who typed the name is the person who has to change it, and a
 * refusal they cannot read becomes a support call and then a workaround. `findings` carries every
 * reason, and `details.rules` the rule names, so a test asserts the rule rather than the sentence.
 */
export class PublicDisplayNameRefused extends AppError {
  readonly code = 'public_display_name_refused' as const
  readonly findings: readonly PublicNameFinding[]
  constructor(name: string, findings: readonly PublicNameFinding[]) {
    super(
      'validation',
      `"${name}" cannot be a public display name: ` +
        findings.map((finding) => `${finding.rule} — ${finding.term}: ${finding.why}`).join('; '),
      {
        userFacing: true,
        details: {
          code: 'public_display_name_refused',
          publicDisplayName: name,
          rules: findings.map((finding) => finding.rule),
          terms: findings.map((finding) => finding.term),
          findings,
        },
      },
    )
    this.name = 'PublicDisplayNameRefused'
    this.findings = Object.freeze([...findings])
  }
}

/** Throws unless the name may be published. The internal name is never passed here. */
export function assertPublicDisplayNameCompliant(name: string, policy: CompliancePolicy): void {
  const findings = lintPublicDisplayName(name, policy)
  if (findings.length > 0) throw new PublicDisplayNameRefused(name, findings)
}

/** The rule a refusal carries, or null — so a caller can branch without matching on the message. */
export function refusedRulesOf(error: unknown): readonly PublicNameRule[] | null {
  return error instanceof PublicDisplayNameRefused
    ? error.findings.map((finding) => finding.rule)
    : null
}

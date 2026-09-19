import { COMPLIANCE_LEXICON, containsPhrase, type PublicNameRule } from '../compliance/lexicon.ts'

/**
 * The escalation lexicon: the seven categories docs/07 §4 says are never auto-answered, in the forms
 * they actually arrive in.
 *
 * ## What this is for, and why it is not the display-name lint
 *
 * `compliance/lexicon.ts` decides whether **we** may publish a word. This decides whether a
 * **customer's** words may be answered by a machine. The two share terms and nothing else:
 *
 *   - the display-name lint refuses; a false positive there blocks a legitimate service name, so it is
 *     deliberately narrow and "does not try to outwit a determined evader";
 *   - this one escalates to a human; a false positive here costs a person ninety seconds of reading,
 *     and a false **negative** publishes a reply, in the business's name, to a review alleging injury,
 *     harassment or a licensing breach. So this one is deliberately generous, and every asymmetry
 *     below is in that direction.
 *
 * ## What is reused, and what the review side needed that the display-name side did not
 *
 * Reused verbatim: {@link COMPLIANCE_LEXICON} and its {@link containsPhrase} matcher. A review claiming
 * we performed cupping, hijama, laser or an injection asserts a **health service** the licence does not
 * cover (ADDED licences the activity, the Department of Health licences health services), and a review
 * using the solicitation vocabulary is the allegation that closes a massage premises in this market.
 * Both are already enumerated, each with the regulatory reason next to it, and a second list of the same
 * terms would be a second list to forget. `service_outside_the_licence` lands in `illness` and
 * `reads_as_solicitation` in `staff_conduct`; {@link COMPLIANCE_RULE_CATEGORY} is that mapping, made
 * exhaustive by type so a sixth named rule in B-CAT-05's list cannot be added without deciding where a
 * review carrying it goes.
 *
 * Three things the review side needed and the display-name side does not have:
 *
 *   1. **A tokeniser that keeps Arabic.** `lexiconTokens` splits on `/[^a-z0-9]+/`, which erases Arabic
 *      script entirely — correct there, because that lint's scope is "Latin-script names" and the
 *      Arabic public copy is linted where it is rendered. A review is written by a customer, and in Abu
 *      Dhabi a large share of them are in Arabic. {@link reviewTokens} keeps Arabic letters, strips
 *      combining marks so a diacritised spelling and a bare one are one token, folds the alef, yeh and
 *      teh-marbuta variants, and removes tatweel.
 *   2. **Clitic tolerance.** Arabic writes the conjunction and the article onto the word: "and clean"
 *      is one token `ونظيف`, and a term list matching whole tokens would miss every one of them. So an
 *      Arabic-script term also matches a token carrying one of {@link ARABIC_CLITIC_PREFIXES}. Prefix
 *      *stripping* rather than a substring test, because substring matching on Arabic is catastrophic
 *      in the quiet direction: `الم` (pain) is a substring of `المساج` (the massage) and of `المكان`
 *      (the place), so every positive Arabic review would escalate, the rule would be indistinguishable
 *      from "escalate everything", and its fixtures would pass while proving nothing.
 *   3. **Terms for things nobody would ever put on a menu.** `bruise`, `refund`, `police`, `lawyer`,
 *      `cockroach`: the display-name lexicon has no reason to carry them and this one cannot work
 *      without them.
 *
 * ## Why the list is not morphological, and what that costs
 *
 * Each category lists surface forms — English, Arabic, and the Latin-letter transliteration Gulf
 * customers actually type — rather than deriving them. A real Arabic stemmer would match words nobody
 * listed, which in the display-name lint is the failure that gets a rule switched off; here it would be
 * tolerable, but a dependency this package may not have. The cost is a known one: an unlisted
 * inflection is missed. It is bounded by the other nine rows of the routing table, four of which
 * escalate a review carrying **any** free text at all — this lexicon changes the *reason* an operator
 * is shown far more often than it changes the outcome, and that is the honest description of it.
 *
 * ## Versioning
 *
 * {@link REVIEW_ESCALATION_LEXICON_VERSION} is persisted onto every routed review, and
 * {@link reviewEscalationLexiconFor} resolves a stored version back to the lexicon that produced the
 * verdict. Without that, "why was this escalated" is answerable only against today's terms, and an
 * audit of a decision taken before a term was added would reach the wrong conclusion about it.
 *
 * Pure: text and a lexicon in, matches out. No clock, no I/O, no locale lookup.
 */

/**
 * The seven categories of docs/07 §4, and the regulatory reason each one is never auto-answered.
 *
 * Exactly the seven the table names, in the order it names them. Not a superset: the list is quoted in
 * a requirements document the owner signed off, and a category invented here would be a policy nobody
 * agreed to. Terms that do not fit one of the seven are placed in whichever of them the *regulator*
 * would read them as, which is what {@link COMPLIANCE_RULE_CATEGORY} records.
 */
export const REVIEW_ESCALATION_CATEGORIES = [
  'injury',
  'illness',
  'pain',
  'staff_conduct',
  'refund',
  'hygiene',
  'legal_threat',
] as const
export type ReviewEscalationCategory = (typeof REVIEW_ESCALATION_CATEGORIES)[number]

/** Which script a term is written in. Decides whether clitic stripping applies to a token. */
export type TermScript = 'latin' | 'arabic'

/** One term of the lexicon, with the script it is written in so the matcher knows how to compare it. */
export interface ReviewEscalationTerm {
  readonly term: string
  readonly script: TermScript
}

/** A category, its regulatory reason, and its terms. */
export interface ReviewEscalationRule {
  readonly category: ReviewEscalationCategory
  /** Why a review mentioning this may not be answered by a machine. Shown to the operator verbatim. */
  readonly why: string
  readonly terms: readonly ReviewEscalationTerm[]
}

/** One hit: the category, the term as the lexicon spells it, and the token that matched. */
export interface ReviewEscalationMatch {
  readonly category: ReviewEscalationCategory
  readonly term: string
  /**
   * Which list the term came from: this lexicon's own, or the reused display-name one and its rule.
   * An audit answering "why" needs to be able to reach the regulatory reason, and the two lists keep
   * theirs in different places.
   */
  readonly source: 'review_escalation' | PublicNameRule
}

/** A versioned lexicon, so a verdict taken last month can be explained with last month's terms. */
export interface ReviewEscalationLexicon {
  readonly version: string
  readonly rules: Readonly<Record<ReviewEscalationCategory, ReviewEscalationRule>>
}

/**
 * The prefixes Arabic attaches to a word: the conjunction, the article, and the preposition-plus-article
 * forms.
 *
 * Longest first, because stripping is attempted in order and `وال` must be tried before `و`. Each entry
 * is stripped at most once — a single clitic is the overwhelming case, and stacking strips is how a
 * three-letter root starts matching an unrelated word.
 */
const ARABIC_CLITIC_PREFIXES: readonly string[] = Object.freeze([
  'وال', // wa-al: "and the"
  'فال', // fa-al: "so the"
  'بال', // bi-al: "with the"
  'كال', // ka-al: "like the"
  'لل', // li-l: "for the"
  'ال', // al: "the"
  'و', // wa: "and"
  'ف', // fa: "so"
  'ب', // bi: "with"
  'ك', // ka: "like"
  'ل', // li: "for"
])

/** Arabic letters, plus the Arabic-Indic digits a review can carry. */
const ARABIC_LETTER = /[\u0621-\u063a\u0641-\u064a\u0660-\u0669\u066e-\u066f\u0671-\u06d3]/

/**
 * Review text reduced to comparable tokens, Arabic included.
 *
 * NFD then `\p{M}` removal, so `أَلَم` and `ألم` are one token — the difference between them is a
 * teaching aid, not a different word, and a lexicon that saw two would match whichever spelling the
 * fixtures happened to use. Then the letter folds every Arabic normaliser applies: alef with any hamza
 * or madda to bare alef, alef maksura to yeh, teh marbuta to heh, hamza on waw/yeh to the bare letter,
 * and tatweel — a decorative stretch with no phonetic value — removed.
 *
 * Splitting keeps Latin letters, digits and Arabic letters and treats everything else as a separator,
 * so punctuation, the Arabic comma `،` and emoji are boundaries rather than parts of a word.
 */
export function reviewTokens(value: string): readonly string[] {
  const folded = value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\u0640/g, '')
    .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064a')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064a')
    .toLowerCase()
  const tokens: string[] = []
  let current = ''
  for (const character of folded) {
    if (/[a-z0-9]/.test(character) || ARABIC_LETTER.test(character)) current += character
    else if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }
  if (current.length > 0) tokens.push(current)
  return tokens
}

/** The same folding applied to a lexicon term, so both sides of every comparison are normalised. */
function termTokens(term: string): readonly string[] {
  return reviewTokens(term)
}

/**
 * One token against one Arabic word, tolerating a single leading clitic.
 *
 * The token is compared as written first: a term that already carries its article (`دائرة الصحة`) must
 * still match. Only then is one prefix removed, so `ونظيف` reaches `نظيف` and `المكان` does not reach
 * `الم`.
 */
function arabicTokenMatches(token: string, want: string): boolean {
  if (token === want) return true
  for (const prefix of ARABIC_CLITIC_PREFIXES) {
    if (token.length > prefix.length && token.startsWith(prefix)) {
      return token.slice(prefix.length) === want
    }
  }
  return false
}

/**
 * Whether an Arabic phrase appears in the tokens as consecutive, clitic-tolerant words.
 *
 * Exported for G-REV-04's response screen, which asks the same question of a model's answer. One clitic
 * list, two callers: a screen with its own copy would be blind to `\u0628\u0627\u0633\u062a\u0631\u062f\u0627\u062f` the day somebody added the
 * preposition to this one and not to that one.
 */
export function containsArabicPhrase(tokens: readonly string[], phrase: string): boolean {
  const want = termTokens(phrase)
  if (want.length === 0) return false
  for (let start = 0; start + want.length <= tokens.length; start += 1) {
    if (want.every((word, offset) => arabicTokenMatches(tokens[start + offset] as string, word))) {
      return true
    }
  }
  return false
}

/** Whether a term of either script appears in the tokens. Latin reuses the display-name matcher. */
function termMatches(tokens: readonly string[], entry: ReviewEscalationTerm): boolean {
  return entry.script === 'arabic'
    ? containsArabicPhrase(tokens, entry.term)
    : containsPhrase(tokens, entry.term)
}

/** Shorthand so a rule reads as a list of words rather than a list of objects. */
const latin = (...terms: readonly string[]): readonly ReviewEscalationTerm[] =>
  terms.map((term) => ({ term, script: 'latin' as const }))
const arabic = (...terms: readonly string[]): readonly ReviewEscalationTerm[] =>
  terms.map((term) => ({ term, script: 'arabic' as const }))

/**
 * The rules, by category.
 *
 * Every category carries three families of term: the English words a review is written in, the Arabic
 * spellings, and the Latin-letter transliteration a Gulf customer types on an English keyboard —
 * `mustashfa`, `taharrush`, `istirdad`. The transliterations are `latin` script because they are
 * written in Latin letters and must be compared as such; they are not a second Arabic list.
 *
 * `Record<ReviewEscalationCategory, …>` and not an array: a category added to
 * {@link REVIEW_ESCALATION_CATEGORIES} with no rule here fails to compile, which is the only form of
 * "the list is complete" that survives somebody in a hurry.
 */
const RULES: Readonly<Record<ReviewEscalationCategory, ReviewEscalationRule>> = Object.freeze({
  injury: {
    category: 'injury',
    // Physical harm during a treatment is a reportable incident, not a service complaint. A public
    // reply is an admission or a denial — docs/07 §4 forbids both — and it is the document an
    // insurer and, if it reaches one, the Department of Health read first.
    why:
      'the review alleges physical harm during a treatment. A public reply either admits or denies it, ' +
      'and both are statements about a reportable incident that only the owner may make',
    terms: Object.freeze([
      ...latin(
        'injury',
        'injured',
        'injure',
        'hurt me',
        'hurt my',
        'bruise',
        'bruised',
        'sprain',
        'sprained',
        'dislocated',
        'fracture',
        'fractured',
        'burn',
        'burned',
        'burnt',
        'scalded',
        'torn muscle',
        'pulled muscle',
        'bleeding',
        'blood',
        'swollen',
        'swelling',
        // Transliteration.
        'isaba',
        'isabah',
        'kadma',
        'kadmah',
        'harq',
        'nazif',
      ),
      ...arabic('إصابة', 'أصابني', 'أذى', 'كدمة', 'كدمات', 'حرق', 'نزيف', 'تمزق', 'ورم'),
    ]),
  },
  illness: {
    category: 'illness',
    // Two things in one category, because docs/07 §4 names one. A review reporting an infection, a
    // reaction or a hospital visit is a health matter; a review asserting we performed cupping, a
    // laser treatment or an injection asserts a DoH-licensed health service delivered on a massage and
    // spa licence. Replying to either is a medical claim, which the licence does not carry.
    why:
      'the review reports an illness, a reaction, or a treatment that would be a Department of Health ' +
      'licensed health service. Any reply is a medical claim, which a massage and spa licence does not carry',
    terms: Object.freeze([
      ...latin(
        'infection',
        'infected',
        'rash',
        'allergic',
        'allergy',
        'skin reaction',
        'fever',
        'vomit',
        'vomited',
        'nausea',
        'hospital',
        'doctor',
        'clinic',
        'diagnosed',
        'diagnosis',
        'prescribed',
        'pregnant',
        'pregnancy',
        'blood pressure',
        'diabetes',
        'dermatologist',
        // Transliteration.
        'mustashfa',
        'tabib',
        'adwa',
        'iltihab',
        'hasasiya',
        'hasasiyah',
        'marad',
        'hamel',
      ),
      ...arabic(
        'عدوى',
        'التهاب',
        'حساسية',
        'مرض',
        'مريض',
        'مستشفى',
        'طبيب',
        'دكتور',
        'عيادة',
        'حامل',
        'حمى',
        'تحسس',
      ),
    ]),
  },
  pain: {
    category: 'pain',
    // Pain reported after a treatment is the first sentence of an injury claim, and the difference
    // between the two is a clinical judgement nobody in this system is licensed to make.
    why:
      'the review reports pain from a treatment, which is how an injury claim begins. Distinguishing ' +
      'ordinary soreness from harm is a clinical judgement, so a human reads it',
    terms: Object.freeze([
      ...latin(
        'pain',
        'painful',
        'hurts',
        'hurt',
        'sore',
        'soreness',
        'ache',
        'aching',
        'agony',
        'too hard',
        'too rough',
        'too much pressure',
        'could not walk',
        // Transliteration.
        'alam',
        'mualim',
        'moalim',
        'waja',
        'wajaa',
      ),
      ...arabic('ألم', 'آلام', 'مؤلم', 'وجع', 'يوجعني', 'أوجعني', 'موجع'),
    ]),
  },
  staff_conduct: {
    category: 'staff_conduct',
    // The gravest category in this business. An allegation about conduct names, or lets a reader
    // identify, a member of staff; a public reply confirming a shift, a name or a version of events is
    // the confidentiality breach docs/07 §4 lists first, and an allegation that reads as solicitation
    // is the one an inspection acts on.
    why:
      'the review makes an allegation about a member of staff. A public reply would confirm who was on ' +
      'shift or take a side in it, and in this trade a conduct allegation is what an inspection acts on',
    terms: Object.freeze([
      ...latin(
        'rude',
        'rudely',
        'unprofessional',
        'harass',
        'harassed',
        'harassment',
        'inappropriate',
        'inappropriately',
        'touched me',
        'touching',
        'groped',
        'creepy',
        'shouted',
        'shouting',
        'yelled',
        'argued',
        'refused to stop',
        'made me uncomfortable',
        'racist',
        'discriminated',
        // Transliteration.
        'taharrush',
        'taharush',
        'mudayaqa',
        'ghair mohtaram',
        'ghair laeq',
        'waqeh',
      ),
      ...arabic(
        'تحرش',
        'مضايقة',
        'وقح',
        'وقاحة',
        'غير محترم',
        'غير لائق',
        'صرخ',
        'عنصري',
        'أساء',
        'إساءة',
      ),
    ]),
  },
  refund: {
    category: 'refund',
    // docs/07 §4's hard rules forbid the generator from offering a refund or any compensation. A
    // review asking for one cannot be answered without either offering it or publicly refusing, and
    // the second is a statement about a payment dispute the owner has to make.
    why:
      'the review is about money already taken. The generator may never offer a refund or compensation, ' +
      'and publicly refusing one is a statement about a payment dispute only the owner may make',
    terms: Object.freeze([
      ...latin(
        'refund',
        'refunded',
        'money back',
        'charged twice',
        'double charged',
        'overcharged',
        'overcharging',
        'compensation',
        'compensate',
        'chargeback',
        'dispute',
        'did not pay',
        'stole',
        'scam',
        // Transliteration.
        'istirdad',
        'istirja',
        'taawid',
        'nasb',
      ),
      ...arabic('استرداد', 'استرجاع', 'تعويض', 'نصب', 'سرقة', 'سرقوا', 'خصموا', 'دفعت مرتين'),
    ]),
  },
  hygiene: {
    category: 'hygiene',
    // A hygiene allegation against a licensed premises is a municipal inspection trigger. A reply is a
    // statement about the condition of the premises, and only the owner knows what was found and put
    // right.
    why:
      'the review alleges a hygiene failure at a licensed premises, which is an inspection trigger. Only ' +
      'the owner can say what was found and what was done about it',
    terms: Object.freeze([
      ...latin(
        'dirty',
        'unclean',
        'not clean',
        'filthy',
        'unhygienic',
        'smelled',
        'smelly',
        'stank',
        'stained',
        'mould',
        'mold',
        'cockroach',
        'cockroaches',
        'insect',
        'bed bug',
        'used towel',
        'hair everywhere',
        // Transliteration.
        'wasekh',
        'wasikh',
        'qazer',
        'mish nadif',
        'ghair nadif',
        'riha kariha',
      ),
      ...arabic('وسخ', 'وسخة', 'قذر', 'غير نظيف', 'رائحة كريهة', 'حشرات', 'عفن', 'ملطخ'),
    ]),
  },
  legal_threat: {
    category: 'legal_threat',
    // Once a reviewer has named a lawyer, a court or a regulator, every public sentence is evidence.
    // The addressee is no longer the reviewer, and the reply is the owner's and their advisers' to
    // write — ADDED licences the activity and the Department of Health the health services, so a
    // complaint routed to either is a licensing matter rather than a customer-service one.
    why:
      'the review names a lawyer, a court or a regulator. From that point every public sentence is ' +
      "evidence, and the reply is the owner's and their advisers' to write",
    terms: Object.freeze([
      ...latin(
        'lawyer',
        'legal action',
        'sue',
        'suing',
        'court',
        'police',
        'authorities',
        'municipality',
        'department of health',
        'consumer protection',
        'ministry',
        'prosecutor',
        'report you',
        'reporting you',
        'file a complaint',
        'filed a complaint',
        // Transliteration.
        'mahkama',
        'mahkamah',
        'shurta',
        'muhami',
        'mohami',
        'shakwa',
        'baladiya',
      ),
      ...arabic(
        'محكمة',
        'محامي',
        'شرطة',
        'شكوى',
        'بلدية',
        'دائرة الصحة',
        'النيابة',
        'قضية',
        'حماية المستهلك',
      ),
    ]),
  },
})

/**
 * Where a reused display-name rule sends a review that carries one of its terms.
 *
 * Exhaustive over `PublicNameRule` by type, so B-CAT-05 adding a sixth named rule cannot compile until
 * somebody decides what a review containing it means. `null` for the three rules whose terms say
 * nothing about a review:
 *
 *   - `banned_claim_term` is the *profile's* list of claims **we** may not make. A customer writing
 *     "very therapeutic" is paying a compliment, and escalating it would escalate a large share of the
 *     five-star reviews while teaching an operator that this queue is noise.
 *   - `unpermitted_staff_title` and `style_as_therapist_attribute` are about naming a person, which the
 *     routing table's `names_an_individual` rule handles directly off {@link PROVIDER_TITLES} — the
 *     same words, asked the other question.
 */
export const COMPLIANCE_RULE_CATEGORY: Readonly<
  Record<PublicNameRule, ReviewEscalationCategory | null>
> = Object.freeze({
  service_outside_the_licence: 'illness',
  reads_as_solicitation: 'staff_conduct',
  banned_claim_term: null,
  unpermitted_staff_title: null,
  style_as_therapist_attribute: null,
})

/**
 * The version stamped onto every routed review.
 *
 * Dated rather than counted, because the question it answers is "what did the lexicon say when this
 * decision was taken" and a date is the form in which that question is asked. Changing any term below
 * requires a new version and an entry in {@link REVIEW_ESCALATION_LEXICONS}; editing the terms under
 * the existing version would make every stored verdict unreproducible, which is the one thing the
 * column exists to prevent.
 */
export const REVIEW_ESCALATION_LEXICON_VERSION = '2026-09-19'

/** The lexicon in force. */
export const REVIEW_ESCALATION_LEXICON: ReviewEscalationLexicon = Object.freeze({
  version: REVIEW_ESCALATION_LEXICON_VERSION,
  rules: RULES,
})

/**
 * Every lexicon version this build can explain a verdict with.
 *
 * One entry today. It is a map rather than a constant because the alternative is discovering, the first
 * time a term changes, that no historical verdict can be reproduced — and by then the rows exist.
 */
export const REVIEW_ESCALATION_LEXICONS: Readonly<Record<string, ReviewEscalationLexicon>> =
  Object.freeze({
    [REVIEW_ESCALATION_LEXICON_VERSION]: REVIEW_ESCALATION_LEXICON,
  })

/**
 * The lexicon a stored version names, or `null`.
 *
 * Total over `unknown`, and `null` rather than a fall-back to the current lexicon. Substituting today's
 * terms for a version this build does not have would answer "why was this escalated" with a confident
 * sentence about the wrong list, which is worse than refusing: the router turns the `null` into an
 * escalation with `routing_policy_unavailable`, and an operator sees that the decision cannot be
 * reproduced.
 */
export function reviewEscalationLexiconFor(version: unknown): ReviewEscalationLexicon | null {
  if (typeof version !== 'string') return null
  return REVIEW_ESCALATION_LEXICONS[version] ?? null
}

/**
 * Every escalation term in the text, from this lexicon and from the reused display-name one.
 *
 * All of them, not the first, and in category order: an operator reading "this review mentions an
 * injury" acts differently from one reading "an injury, a refund demand and a lawyer", and the audit
 * row has to carry the whole reason rather than the cheapest one to compute.
 *
 * `text` may be `null` — a star-only review, the majority case (docs/10 §7) — and yields no matches,
 * which is the one honest answer: there is nothing to read.
 */
export function matchReviewEscalations(
  text: string | null | undefined,
  lexicon: ReviewEscalationLexicon = REVIEW_ESCALATION_LEXICON,
): readonly ReviewEscalationMatch[] {
  if (text === null || text === undefined || text.trim().length === 0) return Object.freeze([])
  const tokens = reviewTokens(text)
  const matches: ReviewEscalationMatch[] = []

  for (const category of REVIEW_ESCALATION_CATEGORIES) {
    const rule = lexicon.rules[category]
    // A lexicon read back from a stored version could be missing a category this build knows about.
    // Skipping is right for the *match* list; the router's own totality rules decide what a policy it
    // cannot fully read means for the verdict.
    if (rule === undefined) continue
    for (const entry of rule.terms) {
      if (termMatches(tokens, entry)) {
        matches.push({ category, term: entry.term, source: 'review_escalation' })
      }
    }
  }

  // The reused list, second, so its hits are attributable to the rule that already carries the
  // regulatory reason for the term rather than being restated here.
  for (const entry of COMPLIANCE_LEXICON) {
    const category = COMPLIANCE_RULE_CATEGORY[entry.rule]
    if (category === null) continue
    if (containsPhrase(tokens, entry.term)) {
      matches.push({ category, term: entry.term, source: entry.rule })
    }
  }

  return Object.freeze(matches)
}

/** The categories the text matched, deduplicated, in declared order. For a message and an audit row. */
export function matchedEscalationCategories(
  matches: readonly ReviewEscalationMatch[],
): readonly ReviewEscalationCategory[] {
  const hit = new Set(matches.map((match) => match.category))
  return Object.freeze(REVIEW_ESCALATION_CATEGORIES.filter((category) => hit.has(category)))
}

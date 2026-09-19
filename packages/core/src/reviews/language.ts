import { DETECTABLE_REVIEW_LANGUAGES, type DetectableReviewLanguage } from '@berelax/shared'
import { reviewTokens } from './escalation-lexicon.ts'

/**
 * Which language a review is in — and, far more importantly, when that cannot be answered.
 *
 * docs/07 §4's fourth row is *"language outside the configured set → always escalated"*, and the only
 * way to implement it safely is to treat identification as a **claim that needs evidence**. So this
 * module is deliberately shaped the opposite way round from a language detector: it does not pick the
 * most likely language, it declines unless one of the languages the business can actually reply in is
 * positively evidenced.
 *
 * ## Why script alone is not enough, and what the Tagalog case shows
 *
 * Arabic script is decisive: nothing else this business receives is written in it, so strong RTL
 * characters mean `'ar'`. Latin script decides nothing. English, Tagalog, Bahasa, Russian
 * transliteration, French and Arabizi all arrive in Latin letters, and Abu Dhabi's actual review mix
 * contains several of them. A detector that answered `'en'` for "any Latin text" would route a
 * five-star Tagalog review — *"Napakaganda ng lugar at ang masahe ay sobrang nakakarelax"* — as
 * English, and the reply would be published in a language the reviewer did not write in, under the
 * business's name, with a compliment that reads as a machine's.
 *
 * So English is recognised by its **function words**: the closed class of articles, pronouns,
 * prepositions, conjunctions and auxiliaries that any real English sentence contains several of and
 * that another Latin-script language does not. {@link ENGLISH_FUNCTION_WORDS} is that list, and
 * {@link ENGLISH_FUNCTION_WORDS_REQUIRED} is how many must appear. Two rather than one, because a
 * single shared token is exactly how a false positive arrives: Tagalog "sa" is a preposition, Bahasa
 * "is" appears in loanwords, and "a" is a word in several languages.
 *
 * ## What the threshold costs, and why that is the right trade
 *
 * A genuinely short English review — *"Great!"*, *"Best massage ever"* — carries no function words and
 * is answered `'unknown'`, which escalates it. That is the honest answer: there is no evidence in three
 * words, and the alternative shape of this function guesses. The cost is bounded and it is paid by a
 * human reading a three-word compliment, whereas the cost of the other error is a published reply in
 * the wrong language. The routing table's `free_text_present` row escalates any review with text in it
 * anyway, so in practice this rule changes the *reason* an operator is shown rather than the outcome —
 * the one case where it changes the outcome is a five-star review with text, which is precisely the
 * case docs/07 §4 row 1 already refuses for having free text.
 *
 * ## Mixed script
 *
 * An Arabic review that quotes an English service name is Arabic; an English review that quotes one
 * Arabic word is English. So Arabic wins only when Arabic tokens are the majority of the tokens, and
 * `'unknown'` is returned when neither side has a majority — a review written half in each is one
 * nothing can reply to in a single language.
 *
 * Pure: a string in, a label out. No `Intl`, no locale lookup, no clock.
 */

/** What identification can conclude. `'unknown'` is a verdict, not a failure. */
export type DetectedReviewLanguage = DetectableReviewLanguage | 'unknown'

/**
 * English function words: the closed class that carries no content and cannot be avoided.
 *
 * Chosen for being *absent* from the other Latin-script languages reviews arrive in rather than for
 * being frequent in English. `the`, `and`, `was`, `were`, `is`, `very`, `they`, `their`, `my`, `me`,
 * `but`, `with`, `for`, `have`, `had`, `would`, `will`, `this`, `that`, `there`, `here`, `not`, `from`,
 * `been`, `did`, `does`, `after`, `again`, `because`, `about`, `when`, `what`, `which`. Deliberately not
 * `a`, `i`, `in`, `at`, `to`, `on`, `so`, `no`, `ok`, `sa`, `ng`, `ay`: each is a word or a frequent
 * token in at least one other language reviews arrive in, and a shared token is a false positive rather
 * than evidence.
 */
export const ENGLISH_FUNCTION_WORDS: readonly string[] = Object.freeze([
  'the',
  'and',
  'was',
  'were',
  'is',
  'are',
  'very',
  'they',
  'their',
  'them',
  'my',
  'me',
  'but',
  'with',
  'for',
  'have',
  'has',
  'had',
  'would',
  'will',
  'this',
  'that',
  'there',
  'here',
  'not',
  'from',
  'been',
  'did',
  'does',
  'after',
  'again',
  'because',
  'about',
  'when',
  'what',
  'which',
  'could',
])

/**
 * How many distinct function words make English an evidenced claim rather than a guess.
 *
 * Two. One is how a false positive arrives — a single shared token in another language — and three
 * would decline a correctly-identifiable short sentence. It is exported so the test asserts the
 * threshold rather than a sentence that happens to sit on one side of it.
 */
export const ENGLISH_FUNCTION_WORDS_REQUIRED = 2

/**
 * Strong right-to-left characters, which for this business means Arabic.
 *
 * The same ranges `packages/core/src/text/bidi.ts` uses for `hasStrongRtl`, restricted to the Arabic
 * blocks: this decides which of two *configured* languages a review is in, and Hebrew or Syriac is not
 * one of them — it is `'unknown'`, which escalates, and that is the right answer rather than "Arabic
 * because it is right-to-left".
 */
const ARABIC_SCRIPT = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufefc]/

/** Latin letters, so a token can be classified without asking what it is not. */
const LATIN_SCRIPT = /[a-z]/

/**
 * The language of a review's text, or `'unknown'`.
 *
 * `null`, `undefined` and blank text are `'unknown'` too, and that is not a defensive default: a
 * star-only review has no language, and the router must not be able to read "no text" as "a language in
 * the configured set". Each caller decides what no text means — for the routing table it means the
 * language row does not apply and the star-only path continues — but it is never a language.
 */
export function detectReviewLanguage(text: string | null | undefined): DetectedReviewLanguage {
  if (text === null || text === undefined || text.trim().length === 0) return 'unknown'
  const tokens = reviewTokens(text)
  if (tokens.length === 0) return 'unknown'

  let arabic = 0
  let latin = 0
  for (const token of tokens) {
    if (ARABIC_SCRIPT.test(token)) arabic += 1
    else if (LATIN_SCRIPT.test(token)) latin += 1
  }

  // A majority, not a presence. An English review quoting `مساج` is English, and an Arabic review
  // quoting "BE RELAX" is Arabic; a review that is half of each is answered by neither.
  if (arabic > latin) return 'ar'
  // Equal counts — including a review of nothing but digits and emoji, where both are zero — is the
  // half-and-half case above: neither script has a majority, so nothing can be replied in one language.
  if (latin === arabic) return 'unknown'

  const evidence = new Set(tokens.filter((token) => ENGLISH_FUNCTION_WORDS.includes(token)))
  return evidence.size >= ENGLISH_FUNCTION_WORDS_REQUIRED ? 'en' : 'unknown'
}

/**
 * Whether a detected language is one the business may reply in.
 *
 * Total, and `false` for `'unknown'` by construction: `'unknown'` is not a member of
 * {@link DETECTABLE_REVIEW_LANGUAGES}, so it cannot be in any configured set however the setting is
 * written. That is the property that makes the configured-language setting incapable of relaxing this
 * rule — see `configuredReviewLanguages` in `@berelax/shared`.
 */
export function languageIsConfigured(
  detected: DetectedReviewLanguage,
  configured: readonly DetectableReviewLanguage[],
): boolean {
  return DETECTABLE_REVIEW_LANGUAGES.some(
    (language) => language === detected && configured.includes(language),
  )
}

import { configuredReviewLanguages, DETECTABLE_REVIEW_LANGUAGES } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  detectReviewLanguage,
  ENGLISH_FUNCTION_WORDS,
  ENGLISH_FUNCTION_WORDS_REQUIRED,
  languageIsConfigured,
} from './language.ts'

/**
 * G-REV-03 — identification as a claim that needs evidence.
 *
 * The acceptance criterion this file exists for is the Tagalog one: a five-star Tagalog review must not be
 * read as English. So the assertions come in pairs throughout — the language that *is* identified next to
 * the one that must not be, because a detector that answered `'unknown'` for everything would satisfy
 * every safety assertion here and make the whole autoresponder unreachable.
 */

/** Real review shapes. No invented names: nobody is named in any of them. */
const ENGLISH = 'Best massage in Abu Dhabi. Very professional and the place is spotless.'
const ARABIC = 'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.'
const TAGALOG = 'Napakaganda ng lugar at ang masahe ay sobrang nakakarelax. Salamat!'
const BAHASA = 'Tempatnya sangat bersih dan pelayanannya ramah sekali.'
const RUSSIAN_TRANSLIT = 'Ochen horosho, massazh byl prekrasnyy i personal vezhlivyy.'
const FRENCH = 'Un massage vraiment agreable, le personnel est tres accueillant.'

describe('acceptance — English is identified, and only on evidence', () => {
  it('identifies an ordinary English review', () => {
    expect(detectReviewLanguage(ENGLISH)).toBe('en')
    expect(detectReviewLanguage('The therapist was very good and the room was clean.')).toBe('en')
  })

  it('declines a short English review rather than guessing', () => {
    // The honest answer, and the cost of the threshold: there is no evidence in two words. It escalates,
    // which is the direction that cannot publish a reply in the wrong language.
    expect(detectReviewLanguage('Great!')).toBe('unknown')
    expect(detectReviewLanguage('Best massage ever')).toBe('unknown')
  })

  it('needs more than one function word, which is what keeps a shared token from deciding', () => {
    expect(ENGLISH_FUNCTION_WORDS_REQUIRED).toBe(2)
    // One function word: declined. Two: identified. The pair is the threshold, asserted as a boundary
    // rather than as one sentence that happens to fall on one side of it.
    expect(detectReviewLanguage('massage was good')).toBe('unknown')
    expect(detectReviewLanguage('massage was very good')).toBe('en')
  })

  it('has no duplicate in its function-word list', () => {
    // A duplicate is harmless to the result and is the sign of a list edited twice; it also makes the
    // count in a future threshold change mean something other than it says.
    expect(new Set(ENGLISH_FUNCTION_WORDS).size).toBe(ENGLISH_FUNCTION_WORDS.length)
  })
})

describe('acceptance — another Latin-script language is never read as English', () => {
  it('declines Tagalog, Bahasa, transliterated Russian and French', () => {
    for (const text of [TAGALOG, BAHASA, RUSSIAN_TRANSLIT, FRENCH]) {
      expect(detectReviewLanguage(text), text).toBe('unknown')
    }
  })

  it('declines Arabizi, which is Arabic written in Latin letters', () => {
    // Not `'ar'` either: a reply written in Arabic script to somebody who typed Latin letters is its own
    // mistake, and nothing here can tell which they would rather read.
    expect(detectReviewLanguage('el makan ktir helo w el service mumtaz')).toBe('unknown')
  })
})

describe('acceptance — Arabic is identified by script, and mixed script by neither', () => {
  it('identifies an ordinary Arabic review', () => {
    expect(detectReviewLanguage(ARABIC)).toBe('ar')
  })

  it('lets one quoted word go the way of the majority', () => {
    expect(detectReviewLanguage('The مساج was very good and the room was clean.')).toBe('en')
    expect(detectReviewLanguage('مكان ممتاز ونظيف والخدمة رائعة BE RELAX')).toBe('ar')
  })

  it('declines a review that is half of each', () => {
    expect(detectReviewLanguage('ممتاز جدا very good')).toBe('unknown')
  })

  it('declines a script it does not serve rather than calling it Arabic for being right-to-left', () => {
    expect(detectReviewLanguage('מקום נהדר ונקי מאוד')).toBe('unknown')
  })
})

describe('acceptance — no text is not a language', () => {
  it('answers unknown for null, undefined, whitespace and punctuation only', () => {
    expect(detectReviewLanguage(null)).toBe('unknown')
    expect(detectReviewLanguage(undefined)).toBe('unknown')
    expect(detectReviewLanguage('   ')).toBe('unknown')
    expect(detectReviewLanguage('!!! ??? ...')).toBe('unknown')
  })
})

describe('acceptance — the configured set cannot admit what cannot be identified', () => {
  it('accepts a detected language the setting names', () => {
    expect(languageIsConfigured('en', ['en', 'ar'])).toBe(true)
    expect(languageIsConfigured('ar', ['en', 'ar'])).toBe(true)
  })

  it('refuses a detected language the setting does not name', () => {
    expect(languageIsConfigured('ar', ['en'])).toBe(false)
    expect(languageIsConfigured('en', [])).toBe(false)
  })

  it('refuses unknown under every set, including one that tried to name it', () => {
    expect(languageIsConfigured('unknown', ['en', 'ar'])).toBe(false)
    // The floor: storing a language nothing can identify does not put it in the set, so there is no
    // spelling of the setting that makes an unidentifiable review replyable.
    expect(languageIsConfigured('unknown', configuredReviewLanguages(['en', 'ar', 'tl']))).toBe(
      false,
    )
    expect(configuredReviewLanguages(['tl'])).toEqual([])
  })

  it('agrees with the detectable set, so the two lists cannot drift', () => {
    for (const language of DETECTABLE_REVIEW_LANGUAGES) {
      expect(languageIsConfigured(language, [...DETECTABLE_REVIEW_LANGUAGES]), language).toBe(true)
    }
  })
})

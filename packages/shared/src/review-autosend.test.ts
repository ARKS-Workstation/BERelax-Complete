import { describe, expect, it } from 'vitest'
import {
  BUSINESS_PROFILE_ACCESS_SETTING_KEY,
  configuredReviewLanguages,
  DETECTABLE_REVIEW_LANGUAGES,
  MINIMUM_REVIEW_COOLING_OFF_HOURS,
  REVIEW_AUTOSEND_DISABLED,
  REVIEW_AUTOSEND_SETTING_KEY,
  REVIEW_AUTOSEND_SETTING_KEYS,
  REVIEW_COOLING_OFF_SETTING_KEY,
  REVIEW_REPLY_LANGUAGES_SETTING_KEY,
  reviewAutosendEnabled,
  reviewCoolingOffHours,
  reviewCoolingOffHoursSchema,
  reviewReplyLanguagesSchema,
  reviewReplyMode,
} from './review-autosend.ts'

/**
 * G-REV-03 — the four settings floors, each asserted to be total over `unknown` and biased to refusal.
 *
 * The values below are not invented awkward cases. They are what a real read hands back:
 *
 *   - `undefined` — the key has never been seeded, which is every fresh database;
 *   - `null` — a `jsonb` null, which is what an admin form posting an empty field stores;
 *   - `'true'`, `'1'`, `1` — a value that skipped validation, from a form post or a seed script;
 *   - `{}`, `[]` — a shape left behind by a half-finished migration;
 *   - `0`, `-1`, `2` — a cooling-off somebody shortened, which is the only way to make an auto-send
 *     happen sooner and therefore the change this floor exists to refuse.
 *
 * Every one of them must be answered with the refusing value, and the pair for each is a control showing
 * the permissive value **is** reachable — otherwise a function that returned the strict answer
 * unconditionally would pass every assertion here.
 */
const UNREADABLE_VALUES: readonly unknown[] = [
  undefined,
  null,
  'true',
  'TRUE',
  '1',
  1,
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  {},
  [],
  'advisory',
  'yes',
  'on',
]

describe('acceptance — reviewAutosendEnabled is total and only the boolean true enables anything', () => {
  it('answers false for every value that is not exactly true', () => {
    for (const value of UNREADABLE_VALUES) {
      expect(reviewAutosendEnabled(value), `${String(value)}`).toBe(false)
    }
    // ...and the strings that are truthy in JavaScript and mean "off" to a human, which is the pair the
    // `Boolean(value)` implementation of this function gets wrong in the direction that publishes a reply.
    expect(reviewAutosendEnabled('false')).toBe(false)
    expect(reviewAutosendEnabled('0')).toBe(false)
  })

  it('answers true for the boolean true, so the assertion above is not vacuous', () => {
    expect(reviewAutosendEnabled(true)).toBe(true)
  })

  it('defaults to disabled, and the default is a named constant rather than a literal', () => {
    expect(REVIEW_AUTOSEND_DISABLED).toBe(false)
    expect(reviewAutosendEnabled(REVIEW_AUTOSEND_DISABLED)).toBe(false)
  })
})

describe('acceptance — reviewReplyMode: draft is the launch mode and needs no argument', () => {
  it('answers draft for every value that is not exactly true', () => {
    for (const value of UNREADABLE_VALUES) {
      expect(reviewReplyMode(value), `${String(value)}`).toBe('draft')
    }
    expect(reviewReplyMode('api')).toBe('draft')
  })

  it('answers api for the boolean true', () => {
    expect(reviewReplyMode(true)).toBe('api')
  })
})

describe('acceptance — reviewCoolingOffHours never returns less than the floor', () => {
  it('answers the floor for every unreadable or too-short value', () => {
    for (const value of UNREADABLE_VALUES) {
      expect(reviewCoolingOffHours(value), `${String(value)}`).toBe(
        MINIMUM_REVIEW_COOLING_OFF_HOURS,
      )
    }
    // The three that matter most: a deliberately shortened delay stays at the floor.
    expect(reviewCoolingOffHours(0)).toBe(MINIMUM_REVIEW_COOLING_OFF_HOURS)
    expect(reviewCoolingOffHours(1)).toBe(MINIMUM_REVIEW_COOLING_OFF_HOURS)
    expect(reviewCoolingOffHours(23)).toBe(MINIMUM_REVIEW_COOLING_OFF_HOURS)
    // A fraction is not a value the schema can produce and is not honoured either: 23.9 would otherwise
    // be a 0.1-hour relaxation expressed in a way the integer schema was written to prevent.
    expect(reviewCoolingOffHours(23.9)).toBe(MINIMUM_REVIEW_COOLING_OFF_HOURS)
  })

  it('honours a longer delay, because longer is the conservative direction', () => {
    expect(reviewCoolingOffHours(48)).toBe(48)
    expect(reviewCoolingOffHours(MINIMUM_REVIEW_COOLING_OFF_HOURS)).toBe(
      MINIMUM_REVIEW_COOLING_OFF_HOURS,
    )
  })

  it('refuses a shorter delay at the write schema too, so the screen explains itself', () => {
    expect(reviewCoolingOffHoursSchema.safeParse(23).success).toBe(false)
    expect(reviewCoolingOffHoursSchema.safeParse(0).success).toBe(false)
    expect(reviewCoolingOffHoursSchema.safeParse(24).success).toBe(true)
    expect(reviewCoolingOffHoursSchema.safeParse(48).success).toBe(true)
  })
})

describe('acceptance — configuredReviewLanguages cannot be widened past what can be identified', () => {
  it('returns the empty set for every unreadable value', () => {
    for (const value of UNREADABLE_VALUES) {
      // `[]` is in the list and is itself the empty set, so this assertion covers it either way.
      expect(configuredReviewLanguages(value), `${String(value)}`).toEqual([])
    }
  })

  it('drops a language this build cannot identify, however it is stored', () => {
    // The floor that makes this setting safe to leave at `operational`: adding Tagalog does not make a
    // Tagalog review auto-sendable, because nothing can recognise one.
    expect(configuredReviewLanguages(['en', 'tl', 'fr', 'ru'])).toEqual(['en'])
    expect(configuredReviewLanguages(['tl'])).toEqual([])
    expect(configuredReviewLanguages(['*'])).toEqual([])
    expect(configuredReviewLanguages(['all'])).toEqual([])
  })

  it('keeps the two it can, deduplicated and in declared order', () => {
    expect(configuredReviewLanguages(['ar', 'en', 'ar'])).toEqual(['en', 'ar'])
    expect(configuredReviewLanguages([' en ', 'ar'])).toEqual(['en', 'ar'])
    expect(configuredReviewLanguages([...DETECTABLE_REVIEW_LANGUAGES])).toEqual([
      ...DETECTABLE_REVIEW_LANGUAGES,
    ])
  })

  it('refuses an unknown code and an empty list at the write schema', () => {
    expect(reviewReplyLanguagesSchema.safeParse(['tl']).success).toBe(false)
    expect(reviewReplyLanguagesSchema.safeParse([]).success).toBe(false)
    expect(reviewReplyLanguagesSchema.safeParse(['en']).success).toBe(true)
  })
})

describe('acceptance — the autosend-related settings are one list, not four spellings', () => {
  it('names every key exactly once', () => {
    expect([...REVIEW_AUTOSEND_SETTING_KEYS]).toEqual([
      REVIEW_AUTOSEND_SETTING_KEY,
      REVIEW_COOLING_OFF_SETTING_KEY,
      REVIEW_REPLY_LANGUAGES_SETTING_KEY,
      BUSINESS_PROFILE_ACCESS_SETTING_KEY,
    ])
    expect(new Set(REVIEW_AUTOSEND_SETTING_KEYS).size).toBe(REVIEW_AUTOSEND_SETTING_KEYS.length)
  })

  it('spells each key the way the registry does', () => {
    // A key that drifts is a setting the combination test never varies and the reader never finds. The
    // registry's own test asserts the other direction — that each of these is a declared setting.
    expect(REVIEW_AUTOSEND_SETTING_KEY).toBe('agents.review_autosend_enabled')
    expect(REVIEW_COOLING_OFF_SETTING_KEY).toBe('agents.review_autosend_cooling_off_hours')
    expect(REVIEW_REPLY_LANGUAGES_SETTING_KEY).toBe('agents.review_reply_languages')
    expect(BUSINESS_PROFILE_ACCESS_SETTING_KEY).toBe('google.business_profile_access_granted')
  })
})

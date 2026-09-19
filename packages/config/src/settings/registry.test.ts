import {
  type AppError,
  DETECTABLE_REVIEW_LANGUAGES,
  MINIMUM_REVIEW_COOLING_OFF_HOURS,
  REVIEW_AUTOSEND_SETTING_KEYS,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  assertRoleMayEdit,
  defaultsForSeeding,
  getDefinition,
  invalidationsFor,
  provisionalSettings,
  SETTINGS,
  validateSetting,
} from './registry.ts'

describe('registry integrity — properties over the whole registry, not examples', () => {
  it('every setting declares a type, constraint, label, help, editors and invalidations', () => {
    for (const s of SETTINGS) {
      expect(s.key, 'key').toMatch(/^[a-z_]+\.[a-z_]+$/)
      expect(s.label.length, `${s.key} label`).toBeGreaterThan(3)
      expect(s.help.length, `${s.key} help`).toBeGreaterThan(20)
      expect(s.editableBy.length, `${s.key} editableBy`).toBeGreaterThan(0)
      expect(Array.isArray(s.invalidates), `${s.key} invalidates`).toBe(true)
      expect(
        s.schema.safeParse(s.defaultValue).success,
        `${s.key} default must satisfy its own schema`,
      ).toBe(true)
    }
  })

  it('no two settings share a key', () => {
    const keys = SETTINGS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every non-content setting is audited', () => {
    for (const s of SETTINGS) {
      if (s.tier !== 'content') expect(s.audited, `${s.key}`).toBe(true)
    }
  })

  it('every compliance-locked setting is owner-only', () => {
    for (const s of SETTINGS) {
      if (s.tier === 'compliance_locked') expect([...s.editableBy]).toEqual(['owner'])
    }
  })

  it('every provisional setting names an OPEN-QUESTIONS id', () => {
    for (const s of SETTINGS) {
      if (s.provisional) {
        expect(s.provisional.openQuestionId, `${s.key}`).toMatch(/^Y\d+[a-z]?-[a-z-]+$/)
        expect(s.provisional.note.length).toBeGreaterThan(10)
      }
    }
  })

  it('the safety-critical settings are compliance-locked, not merely operational', () => {
    for (const key of [
      'booking.same_gender_matching',
      'messaging.promotional_window',
      'agents.review_autosend_enabled',
      // G-REV-03: shortening the cooling-off is the only way to make an auto-send happen SOONER, so the
      // delay is locked for the same reason the switch is.
      'agents.review_autosend_cooling_off_hours',
    ]) {
      expect(getDefinition(key).tier, key).toBe('compliance_locked')
    }
  })

  it('every autosend-related setting is declared, so the routing combination test varies a real set', () => {
    // The hole this closes: `REVIEW_AUTOSEND_SETTING_KEYS` is what
    // `packages/core/src/reviews/routing.test.ts` iterates. A key spelled differently there than here
    // would be a setting that test never varies and this one never notices.
    for (const key of REVIEW_AUTOSEND_SETTING_KEYS) {
      expect(getDefinition(key).key, key).toBe(key)
    }
    expect(REVIEW_AUTOSEND_SETTING_KEYS).toHaveLength(4)
  })

  it('the review-reply language set can only ever name a language the router can identify', () => {
    // Why this setting is `operational` and still cannot relax the rule: the schema is an enum of the
    // detectable languages, so there is no value an admin can write that widens what auto-sends.
    const definition = getDefinition('agents.review_reply_languages')
    expect(definition.tier).toBe('operational')
    expect(definition.schema.safeParse(['tl']).success).toBe(false)
    expect(definition.schema.safeParse(['en', 'ar']).success).toBe(true)
    // ...and the empty set is refused too: an owner who wants nothing answered has asked for the
    // autoresponder to be switched off, which is a different setting.
    expect(definition.schema.safeParse([]).success).toBe(false)
  })

  it('refuses a cooling-off delay below the floor, and accepts one above it', () => {
    const definition = getDefinition('agents.review_autosend_cooling_off_hours')
    expect(definition.defaultValue).toBe(MINIMUM_REVIEW_COOLING_OFF_HOURS)
    expect(definition.schema.safeParse(MINIMUM_REVIEW_COOLING_OFF_HOURS - 1).success).toBe(false)
    expect(definition.schema.safeParse(0).success).toBe(false)
    expect(definition.schema.safeParse(MINIMUM_REVIEW_COOLING_OFF_HOURS).success).toBe(true)
    expect(definition.schema.safeParse(168).success).toBe(true)
  })

  it('provisional defaults are the strict option, so an uncorrected assumption stays conservative', () => {
    expect(getDefinition('booking.same_gender_matching').defaultValue).toBe('strict')
    expect(getDefinition('agents.review_autosend_enabled').defaultValue).toBe(false)
    expect(getDefinition('agents.llm_provider').defaultValue).toBe('fake')
    // G-REV-03's two: the shortest delay this build will apply, and the two languages it can identify.
    expect(getDefinition('agents.review_autosend_cooling_off_hours').defaultValue).toBe(
      MINIMUM_REVIEW_COOLING_OFF_HOURS,
    )
    expect(getDefinition('agents.review_reply_languages').defaultValue).toEqual([
      ...DETECTABLE_REVIEW_LANGUAGES,
    ])
    // The one that matters most, asserted against the registry rather than against a comment: API-mode
    // access is assumed NOT granted, so nothing can auto-send in a fresh database whatever else is set.
    expect(getDefinition('google.business_profile_access_granted').defaultValue).toBe(false)
  })
})

describe('validateSetting', () => {
  it('rejects an out-of-range value with a message naming the setting in plain language', () => {
    try {
      validateSetting('booking.turnaround_minutes_standard', 999)
      expect.unreachable('should have thrown')
    } catch (e) {
      const err = e as AppError
      expect(err.kind).toBe('validation')
      expect(err.userFacing).toBe(true)
      expect(err.message).toContain('Room turnaround')
    }
  })

  it('rejects a non-integer where an integer is declared', () => {
    expect(() => validateSetting('booking.therapist_buffer_minutes', 10.5)).toThrow(
      /Therapist buffer/,
    )
  })

  it('rejects a value outside a declared enum', () => {
    expect(() => validateSetting('theme.accent', 'hotpink')).toThrow(/Accent colour/)
    expect(() => validateSetting('booking.same_gender_matching', 'maybe')).toThrow()
  })

  it('refuses switching same-gender matching OFF, which is not a decision anybody took', () => {
    // B-AVAIL-05 narrowed this schema from three values to two. ADR 0020 and docs/01 decision 19 permit
    // relaxing the constraint to advisory and nothing further, so `'off'` was a stored value the
    // database could hold and no document supported — and a compliance constraint that can be switched
    // off entirely is a different decision from one that can be relaxed to a warning.
    expect(() => validateSetting('booking.same_gender_matching', 'off')).toThrow(
      /Same-gender therapist matching/,
    )
    // The control: the two modes that ARE decisions still validate, so the refusal above is about
    // `'off'` and not about a schema that has stopped accepting anything.
    expect(validateSetting('booking.same_gender_matching', 'strict')).toBe('strict')
    expect(validateSetting('booking.same_gender_matching', 'advisory')).toBe('advisory')
  })

  it('accepts a valid value and returns it parsed', () => {
    expect(validateSetting('booking.turnaround_minutes_standard', 25)).toBe(25)
    expect(validateSetting('messaging.promotional_window', { startHour: 9, endHour: 20 })).toEqual({
      startHour: 9,
      endHour: 20,
    })
  })

  it('refuses an undeclared key rather than storing it', () => {
    expect(() => validateSetting('made.up', 1)).toThrow(/Unknown setting/)
  })
})

describe('assertRoleMayEdit', () => {
  it('refuses a receptionist on an operational setting', () => {
    expect(() => assertRoleMayEdit('booking.turnaround_minutes_standard', 'receptionist')).toThrow(
      /may not change/,
    )
  })

  it('refuses even a manager on a compliance-locked setting', () => {
    expect(() => assertRoleMayEdit('booking.same_gender_matching', 'manager')).toThrow(
      /compliance_locked/,
    )
  })

  it('allows the owner on a compliance-locked setting', () => {
    expect(() => assertRoleMayEdit('booking.same_gender_matching', 'owner')).not.toThrow()
  })

  it('allows a manager on an operational setting', () => {
    expect(() => assertRoleMayEdit('booking.turnaround_minutes_standard', 'manager')).not.toThrow()
  })
})

describe('invalidationsFor', () => {
  it('a turnaround change invalidates availability, because slots are computed from it', () => {
    expect(invalidationsFor('booking.turnaround_minutes_standard').cacheTags).toContain(
      'availability',
    )
  })

  it('a theme change invalidates the theme only, not availability', () => {
    const tags = invalidationsFor('theme.accent').cacheTags
    expect(tags).toContain('theme')
    expect(tags).not.toContain('availability')
  })

  it('every setting that affects slot computation invalidates availability', () => {
    for (const key of [
      'booking.turnaround_minutes_standard',
      'booking.turnaround_minutes_wet',
      'booking.therapist_buffer_minutes',
      'booking.min_lead_minutes',
      'booking.max_advance_days',
      'booking.same_gender_matching',
    ]) {
      expect(invalidationsFor(key).cacheTags, key).toContain('availability')
    }
  })
})

describe('the Unconfirmed Assumptions panel', () => {
  it('lists every provisional value with its question id', () => {
    const list = provisionalSettings()
    expect(list.length).toBeGreaterThan(5)
    for (const item of list) {
      expect(item.openQuestionId).toBeTruthy()
      expect(item.note).toBeTruthy()
    }
  })

  it('does not list a setting that was a deliberate decision', () => {
    const keys = provisionalSettings().map((p) => p.key)
    expect(keys).not.toContain('messaging.promotional_window')
    expect(keys).not.toContain('theme.accent')
  })
})

describe('defaultsForSeeding', () => {
  it('produces one row per setting, carrying tier and provisional metadata', () => {
    const rows = defaultsForSeeding()
    expect(rows).toHaveLength(SETTINGS.length)
    const turnaround = rows.find((r) => r.key === 'booking.turnaround_minutes_standard')
    expect(turnaround?.isProvisional).toBe(true)
    expect(turnaround?.openQuestionId).toBe('Y9-turnaround')
    const accent = rows.find((r) => r.key === 'theme.accent')
    expect(accent?.isProvisional).toBe(false)
    expect(accent?.openQuestionId).toBeNull()
  })
})

import type { AppError } from '@berelax/shared'
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
    ]) {
      expect(getDefinition(key).tier, key).toBe('compliance_locked')
    }
  })

  it('provisional defaults are the strict option, so an uncorrected assumption stays conservative', () => {
    expect(getDefinition('booking.same_gender_matching').defaultValue).toBe('strict')
    expect(getDefinition('agents.review_autosend_enabled').defaultValue).toBe(false)
    expect(getDefinition('agents.llm_provider').defaultValue).toBe('fake')
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

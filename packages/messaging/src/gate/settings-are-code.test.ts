/**
 * Consent, the window and suppression are CODE. The settings registry is searched to prove nobody can
 * switch any of the three off, and the window's bounds are proven to permit only a narrowing.
 *
 * ## Why the check is a search over the whole registry and not three named keys
 *
 * The failure is not "somebody edits `messaging.consent_required` to false" — there is no such key, and a
 * test naming it would be asserting about nothing. The failure is that a key like it gets ADDED, by
 * somebody solving a real problem ("the imported campaign has no consent rows yet"), and a test over three
 * names would not see it. So the registry is searched for the SHAPE of such a key: anything whose name
 * joins one of the three subjects to an enable/disable/skip/bypass word.
 *
 * The three subjects are searched for by several spellings each, and the matcher is asserted against
 * strings it must catch, because a search that matches nothing reports the same clean result as a registry
 * with nothing to find (ADR 0002's green tick on zero modules).
 *
 * ## Why the window IS a setting when the other two are not
 *
 * It has to be: an owner may legitimately want promotional traffic confined to 09:00-20:00, which is
 * stricter than TDRA. What is configurable is therefore BOUNDED, and that is the second half of this file —
 * the schema accepts a narrowing, refuses a widening, refuses a window that never opens, and refuses the
 * three spellings of "off". Three layers hold it, and each one is the only layer in some path: this schema
 * for the admin panel, `assertPromotionalWindowChange` for the role and the reason, and
 * `promotional_window_is_a_narrowing()` in migration 0087 for a `psql` session and a restore.
 */
import { getDefinition, provisionalSettings, SETTINGS, validateSetting } from '@berelax/config'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { assertPromotionalWindowChange, PROMOTIONAL_WINDOW_SETTING_KEY } from './index.ts'

/** The three compliance checks that are code. Several spellings each, because a name is not a contract. */
const SUBJECTS = [
  'consent',
  'opt_in',
  'optin',
  'suppression',
  'suppress',
  'blocklist',
  'unsubscribe',
  'quiet',
  'window',
  'promotional_hours',
  'frequency_cap',
]

/** The words a switch is spelled with. `required` is included inverted-sense: `consent_required: false`. */
const SWITCH_WORDS = [
  'enabled',
  'disabled',
  'disable',
  'enforce',
  'enforced',
  'required',
  'skip',
  'bypass',
  'ignore',
  'off',
  'override',
  'check',
]

const looksLikeASwitch = (key: string): boolean => {
  const name = key.toLowerCase()
  return (
    SUBJECTS.some((subject) => name.includes(subject)) &&
    SWITCH_WORDS.some((word) => name.includes(word))
  )
}

describe('no setting can switch off consent, suppression or the window', () => {
  it('finds no such key in the registry', () => {
    const switches = SETTINGS.map((s) => s.key).filter(looksLikeASwitch)
    expect(switches).toEqual([])
  })

  it('CONTROL: the matcher catches the keys somebody would actually add', () => {
    // Without this the assertion above is "an empty list is empty". Each of these is a key a person
    // solving a real problem would propose, and each must be refused by the search rather than by review.
    for (const key of [
      'messaging.consent_required',
      'messaging.consent_check_enabled',
      'messaging.skip_suppression',
      'messaging.suppression_enforced',
      'messaging.quiet_hours_enabled',
      'messaging.promotional_window_override',
      'messaging.frequency_cap_enabled',
      'campaigns.bypass_consent',
    ]) {
      expect(looksLikeASwitch(key), key).toBe(true)
    }
    // And it does not condemn the keys that legitimately exist, or the search would be turned off.
    for (const key of SETTINGS.map((s) => s.key)) expect(looksLikeASwitch(key), key).toBe(false)
  })

  it('the only messaging compliance settings are the window and the two cap figures', () => {
    // A positive statement beside the negative one: this is what IS configurable about a promotional send,
    // and it is three numbers and a pair of hours. Anything else arriving in this namespace is a diff
    // somebody has to justify against this list.
    const messagingKeys = SETTINGS.map((s) => s.key)
      .filter((key) => key.startsWith('messaging.'))
      .sort()
    expect(messagingKeys).toEqual([
      'messaging.frequency_cap_per_month',
      'messaging.frequency_cap_per_week',
      'messaging.promotional_window',
    ])
  })

  it('the window is compliance-locked and owner-only, and is not a provisional value', () => {
    const definition = getDefinition(PROMOTIONAL_WINDOW_SETTING_KEY)
    expect(definition.tier).toBe('compliance_locked')
    expect(definition.editableBy).toEqual(['owner'])
    expect(definition.audited).toBe(true)
    // 07:00-21:00 is TDRA's restriction, not a guess, so it must NOT appear in the Unconfirmed Assumptions
    // panel — asking the owner to confirm a regulator's figure would invite them to change it. What IS
    // provisional is the Ramadan narrowing (Y9-ramadan-window) and the staleness ceiling
    // (Y9-queued-staleness), and neither is an app_setting row.
    expect(provisionalSettings().map((p) => p.key)).not.toContain(PROMOTIONAL_WINDOW_SETTING_KEY)
    expect(definition.provisional).toBeUndefined()
  })
})

describe("the window setting's own bounds permit only a narrowing", () => {
  const valid = [
    { startHour: 7, endHour: 21 }, // the ceiling itself
    { startHour: 9, endHour: 20 },
    { startHour: 20, endHour: 21 }, // the narrowest single hour at the top
    { startHour: 7, endHour: 8 }, // and at the bottom
  ]

  const invalid: readonly { readonly value: unknown; readonly why: string }[] = [
    {
      value: { startHour: 0, endHour: 24 },
      why: 'the whole day, which is quiet hours switched off',
    },
    { value: { startHour: 6, endHour: 21 }, why: 'an hour earlier than TDRA permits' },
    { value: { startHour: 7, endHour: 22 }, why: 'an hour later than TDRA permits' },
    { value: { startHour: 21, endHour: 21 }, why: 'inside the ceiling and never opens' },
    {
      value: { startHour: 20, endHour: 8 },
      why: 'inverted, which is "off" spelled as a narrowing',
    },
    { value: { startHour: 7.5, endHour: 21 }, why: 'not a whole hour' },
    { value: null, why: 'null' },
    { value: false, why: 'false' },
    { value: 'off', why: 'the string "off"' },
    { value: 0, why: 'zero' },
    { value: {}, why: 'an object with no hours at all' },
  ]

  it('the registry schema accepts every narrowing', () => {
    for (const window of valid) {
      expect(
        validateSetting(PROMOTIONAL_WINDOW_SETTING_KEY, window),
        JSON.stringify(window),
      ).toEqual(window)
    }
  })

  it('the registry schema refuses every widening and every spelling of off', () => {
    // This is the layer the ADMIN PANEL sees, and it used to be `min(0).max(23)` / `min(1).max(24)` — so
    // `{startHour: 0, endHour: 24}` validated here and was refused only by the code layer, which meant a
    // seed, an import or a script writing the row directly got the widening.
    for (const { value, why } of invalid) {
      expect(() => validateSetting(PROMOTIONAL_WINDOW_SETTING_KEY, value), why).toThrow()
    }
  })

  it('the code layer refuses the same set, and names the role before the value', () => {
    for (const { value, why } of invalid) {
      expect(() => assertPromotionalWindowChange({ proposed: value, role: 'owner' }), why).toThrow(
        AppError,
      )
    }
    for (const window of valid) {
      expect(
        assertPromotionalWindowChange({ proposed: window, role: 'owner' }),
        JSON.stringify(window),
      ).toEqual(window)
    }
    // The role first, because the setting is compliance-locked: a manager cannot touch it at all, and
    // finding that out only after the value validated would show a validation error where the honest
    // answer is "not you".
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 9, endHour: 20 }, role: 'manager' }),
    ).toThrow(AppError)
    expect(() =>
      assertPromotionalWindowChange({ proposed: { startHour: 0, endHour: 24 }, role: 'manager' }),
    ).toThrow(/not|role|owner/i)
  })
})

import { describe, expect, it } from 'vitest'
import { PERMISSIONS, ROLE_DEFINITIONS, ROLES } from '../access/permissions.ts'
import {
  assertMayChangeBlocklist,
  BLOCKLIST_KEY_KINDS,
  BLOCKLIST_PERMISSION,
  type BlocklistEntry,
  blocklistKeysFor,
  decideBlocklist,
  MAX_EMAIL_LENGTH,
  mayChangeBlocklist,
  normaliseBlocklistKey,
  normaliseEmail,
  normalisePhoneKey,
} from './blocklist.ts'

/**
 * C-CRM-01 — the blocklist's pure half.
 *
 * Numbers here are on the unallocated `+971 59` prefix and addresses on `fixture.invalid`, the two
 * ranges `packages/fixtures/src/synthetic.ts` guarantees cannot reach anybody. This file may not import
 * that package (`packages/core` imports `@berelax/shared` only), so the shapes are written out; the
 * integration suite uses the generator itself.
 */
const PHONE = '+971590000042'
const EMAIL = 'customer.42@fixture.invalid'

const entry = (over: Partial<BlocklistEntry> = {}): BlocklistEntry => ({
  id: 'entry-1',
  kind: 'phone',
  value: PHONE,
  reason: 'Abusive to staff on 2026-09-01.',
  ...over,
})

describe('a key is a normalised contact detail', () => {
  it('folds every spelling of one number onto one key', () => {
    const spellings = [
      PHONE,
      '0590000042',
      '971 59 000 0042',
      '00971590000042',
      '+971 59 000 00 42',
    ]
    for (const spelling of spellings) {
      const result = normalisePhoneKey(spelling)
      expect(result.ok, spelling).toBe(true)
      expect(result.ok && result.key).toEqual({ kind: 'phone', value: PHONE })
    }
    // The control. A different number must not fold onto the same key, or the assertion above is
    // satisfied by a normaliser that ignores its argument.
    const other = normalisePhoneKey('+971590000043')
    expect(other.ok && other.key.value).toBe('+971590000043')
  })

  it('folds case in an address, local part included, and refuses a malformed one', () => {
    for (const spelling of [
      EMAIL,
      '  Customer.42@Fixture.Invalid  ',
      'CUSTOMER.42@FIXTURE.INVALID',
    ]) {
      const result = normaliseEmail(spelling)
      expect(result.ok, spelling).toBe(true)
      expect(result.ok && result.key).toEqual({ kind: 'email', value: EMAIL })
    }
    for (const bad of [
      '',
      '   ',
      'not-an-address',
      'two@@at.invalid',
      'no@domain',
      'a b@x.invalid',
    ]) {
      const result = normaliseEmail(bad)
      expect(result.ok, bad).toBe(false)
      expect(result.ok === false && result.reason).toMatch(/^(empty|not_an_email)$/)
    }
  })

  it('refuses an address longer than the forward-path limit rather than truncating it', () => {
    // A truncated address is a DIFFERENT address, and an entry that silently became a prefix of
    // somebody else's would refuse the wrong person.
    const long = `${'a'.repeat(MAX_EMAIL_LENGTH)}@fixture.invalid`
    const result = normaliseEmail(long)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('too_long')
  })

  it('does NOT fold provider-specific dots or plus tags', () => {
    // Folding them would over-block: `a.b@x` and `ab@x` are two mailboxes at every provider except one.
    const dotted = normaliseEmail('a.b@fixture.invalid')
    const undotted = normaliseEmail('ab@fixture.invalid')
    expect(dotted.ok && dotted.key.value).not.toBe(undotted.ok && undotted.key.value)
    const tagged = normaliseEmail('a+spa@fixture.invalid')
    expect(tagged.ok && tagged.key.value).toBe('a+spa@fixture.invalid')
  })

  it('carries the phone normaliser’s own reason rather than inventing one', () => {
    const landline = normalisePhoneKey('+97142345678')
    expect(landline.ok).toBe(false)
    expect(landline.ok === false && landline.reason).toBe('not_a_phone')
    expect(landline.ok === false && landline.detail).toBe('landline_not_an_sms_target')
  })

  it('dispatches on kind, and the two kinds are the only two', () => {
    expect(BLOCKLIST_KEY_KINDS).toEqual(['phone', 'email'])
    expect(normaliseBlocklistKey('phone', '0590000042')).toEqual({
      ok: true,
      key: { kind: 'phone', value: PHONE },
    })
    expect(normaliseBlocklistKey('email', 'CUSTOMER.42@fixture.invalid')).toEqual({
      ok: true,
      key: { kind: 'email', value: EMAIL },
    })
  })
})

describe('the keys a booking attempt offers', () => {
  it('collects both, and drops what will not normalise rather than comparing it raw', () => {
    expect(blocklistKeysFor({ phone: '0590000042', email: 'CUSTOMER.42@fixture.invalid' })).toEqual(
      [
        { kind: 'phone', value: PHONE },
        { kind: 'email', value: EMAIL },
      ],
    )
    expect(blocklistKeysFor({ phone: 'nonsense', email: 'also nonsense' })).toEqual([])
    expect(blocklistKeysFor({})).toEqual([])
    expect(blocklistKeysFor({ phone: null, email: null })).toEqual([])
  })

  it('collects the email even when the phone already matches, so the audit row can say which', () => {
    const keys = blocklistKeysFor({ phone: PHONE, email: EMAIL })
    expect(keys.map((key) => key.kind)).toEqual(['phone', 'email'])
  })
})

describe('the match', () => {
  it('matches on the phone key', () => {
    const verdict = decideBlocklist(blocklistKeysFor({ phone: '0590000042' }), [entry()])
    expect(verdict.kind).toBe('matched')
    expect(verdict.kind === 'matched' && verdict.matchedKeyKind).toBe('phone')
    expect(verdict.kind === 'matched' && verdict.entryId).toBe('entry-1')
  })

  it('matches on the email key when the phone is not listed', () => {
    const verdict = decideBlocklist(blocklistKeysFor({ phone: '+971590000099', email: EMAIL }), [
      entry({ id: 'entry-2', kind: 'email', value: EMAIL }),
    ])
    expect(verdict.kind === 'matched' && verdict.matchedKeyKind).toBe('email')
    expect(verdict.kind === 'matched' && verdict.entryId).toBe('entry-2')
  })

  it('is clear when neither key is listed, and records which kinds it checked', () => {
    const verdict = decideBlocklist(blocklistKeysFor({ phone: '+971590000099', email: EMAIL }), [
      entry({ value: '+971590000001' }),
    ])
    expect(verdict.kind).toBe('clear')
    expect(verdict.kind === 'clear' && verdict.keyKindsChecked).toEqual(['phone', 'email'])
  })

  it('prefers the phone deterministically when both keys are listed', () => {
    // Two entries covering one person must produce one stable audit trail rather than whichever row
    // the planner happened to return first.
    const entries = [
      entry({ id: 'email-entry', kind: 'email', value: EMAIL }),
      entry({ id: 'phone-entry', kind: 'phone', value: PHONE }),
    ]
    const verdict = decideBlocklist(blocklistKeysFor({ phone: PHONE, email: EMAIL }), entries)
    expect(verdict.kind === 'matched' && verdict.entryId).toBe('phone-entry')
    // And the same answer with the rows the other way round.
    expect(
      decideBlocklist(blocklistKeysFor({ phone: PHONE, email: EMAIL }), [...entries].reverse()),
    ).toEqual(verdict)
  })

  it('does not match an entry of the other kind holding the same string', () => {
    // The control on the kind being part of the key: a phone entry must not be matched by an email
    // whose text happens to be the same, which is what a value-only comparison would do.
    const verdict = decideBlocklist([{ kind: 'email', value: PHONE }], [entry({ value: PHONE })])
    expect(verdict.kind).toBe('clear')
  })

  it('is clear against an empty list, and against no keys at all', () => {
    expect(decideBlocklist(blocklistKeysFor({ phone: PHONE }), []).kind).toBe('clear')
    expect(decideBlocklist([], [entry()]).kind).toBe('clear')
  })
})

describe('changing the list is deny-by-default', () => {
  it('permits manager and owner, and refuses receptionist', () => {
    expect(mayChangeBlocklist('manager')).toEqual({ allowed: true, role: 'manager' })
    expect(mayChangeBlocklist('owner')).toEqual({ allowed: true, role: 'owner' })
    expect(mayChangeBlocklist('receptionist')).toEqual({
      allowed: false,
      refusal: 'permission_not_granted',
    })
  })

  it('refuses an unlisted role by name instead of throwing a TypeError', () => {
    // The arm this function exists for. `ROLE_DEFINITIONS['floor_manager']` is undefined and reading
    // `.permissions` off it throws — a deny-by-default failure that presents as a 500.
    for (const unlisted of ['floor_manager', 'admin', '', 'MANAGER', '__proto__', 'constructor']) {
      expect(mayChangeBlocklist(unlisted), unlisted).toEqual({
        allowed: false,
        refusal: 'unknown_role',
      })
    }
  })

  it('refuses every role the policy layer does not grant the permission to', () => {
    const permitted = ROLES.filter((role) => mayChangeBlocklist(role).allowed)
    // Derived from the policy layer rather than restated, so a grant changed in ROLE_DEFINITIONS
    // changes this expectation in the same commit.
    const granted = ROLES.filter((role) => {
      const def = ROLE_DEFINITIONS[role]
      return def.permissions === 'all' || def.permissions.includes(BLOCKLIST_PERMISSION)
    })
    expect([...permitted].sort()).toEqual([...granted].sort())
    expect(permitted).toContain('manager')
    expect(permitted).not.toContain('receptionist')
    expect(PERMISSIONS).toContain(BLOCKLIST_PERMISSION)
  })

  it('throws a named forbidden error at a call site that must not proceed', () => {
    expect(assertMayChangeBlocklist('manager')).toBe('manager')
    expect(() => assertMayChangeBlocklist('receptionist')).toThrow(/may not add or lift/)
    expect(() => assertMayChangeBlocklist('floor_manager')).toThrow(/unknown_role/)
  })
})

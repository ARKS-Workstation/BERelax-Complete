import { COMPLIANCE_LOCKED, can, ROLES } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  assertMayOperateOnCollection,
  assertMayWriteGlobal,
  CMS_OPERATIONS,
  isRole,
  mayOperateOnCollection,
  mayReadGlobal,
  mayWriteGlobal,
  permissionFor,
} from './access.ts'
import { COMPLIANCE_NOTICES, EDITORIAL_DEFAULTS } from './globals/index.ts'

/**
 * W-SYS-08 — CMS access, decided by the F07 matrix.
 *
 * Each claim is paired with the case that must go the other way. "A receptionist cannot publish" is
 * satisfied by an access layer that refuses everybody, so the owner's publish is asserted too; "an
 * editor cannot write the compliance global" is satisfied by one that refuses every global, so the
 * editorial global is asserted as writable by the same role in the same breath.
 */
describe('acceptance — a receptionist cannot publish', () => {
  it('refuses publish, and refuses the draft as well', () => {
    expect(mayOperateOnCollection('receptionist', 'publish')).toBe(false)
    // Not asked for by the acceptance, and worth pinning: a receptionist holds neither content
    // permission, so they cannot draft either. If that ever changes it should change deliberately.
    expect(mayOperateOnCollection('receptionist', 'create')).toBe(false)
    expect(mayOperateOnCollection('receptionist', 'update')).toBe(false)
  })

  it('throws naming the role and the permission it lacks', () => {
    expect(() => assertMayOperateOnCollection('receptionist', 'pages', 'publish')).toThrow(
      /"receptionist" may not publish pages: it requires content:publish/,
    )
  })

  it('lets the owner publish, so the refusal is about the role and not about publishing', () => {
    expect(mayOperateOnCollection('owner', 'publish')).toBe(true)
    expect(() => assertMayOperateOnCollection('owner', 'pages', 'publish')).not.toThrow()
  })

  it('lets a marketer draft but not publish, which is what F07 actually grants', () => {
    // Worth an assertion rather than a comment: `content:publish` is in no role's list but the owner's
    // wildcard, so the marketer and the manager draft and the owner puts it live. This unit binds to
    // that rather than widening it.
    expect(can('marketer', 'content:write')).toBe(true)
    expect(can('marketer', 'content:publish')).toBe(false)
    expect(mayOperateOnCollection('marketer', 'update')).toBe(true)
    expect(mayOperateOnCollection('marketer', 'publish')).toBe(false)
    expect(mayOperateOnCollection('manager', 'update')).toBe(true)
    expect(mayOperateOnCollection('manager', 'publish')).toBe(false)
  })

  it('lets an auditor read and change nothing', () => {
    expect(mayOperateOnCollection('auditor', 'read')).toBe(true)
    for (const operation of CMS_OPERATIONS.filter((o) => o !== 'read')) {
      expect(mayOperateOnCollection('auditor', operation), operation).toBe(false)
    }
  })

  it('names the permission each operation needs', () => {
    expect(permissionFor('publish')).toBe('content:publish')
    expect(permissionFor('update')).toBe('content:write')
  })
})

describe('acceptance — an editor cannot mutate the compliance-locked global', () => {
  const editors = ['marketer', 'manager'] as const

  for (const role of editors) {
    it(`refuses ${role} on ${COMPLIANCE_NOTICES.slug}`, () => {
      expect(mayWriteGlobal(role, COMPLIANCE_NOTICES.slug)).toBe(false)
      expect(() => assertMayWriteGlobal(role, COMPLIANCE_NOTICES.slug)).toThrow(
        /requires settings:write_compliance/,
      )
    })

    it(`allows ${role} on ${EDITORIAL_DEFAULTS.slug}`, () => {
      // The control. Without it, "cannot mutate the compliance global" is satisfied by an access layer
      // that refuses every global, and the admin would be unusable in a way no test would report.
      expect(mayWriteGlobal(role, EDITORIAL_DEFAULTS.slug)).toBe(true)
      expect(() => assertMayWriteGlobal(role, EDITORIAL_DEFAULTS.slug)).not.toThrow()
    })

    it(`lets ${role} read the compliance global, because a diff is not a change`, () => {
      expect(mayReadGlobal(role, COMPLIANCE_NOTICES.slug)).toBe(true)
    })
  }

  it('is gated on a permission core itself calls compliance-locked', () => {
    // The F09 link, made mechanical. `COMPLIANCE_LOCKED` in packages/core is the list of permissions that
    // may only change as an audited act, and it is the same list F09's registry enforces its
    // `compliance_locked` tier with (`editableBy: ['owner']`). Asserting membership rather than the literal
    // string means a rename in core breaks this test instead of silently downgrading the global to an
    // ordinary editorial one.
    expect([...COMPLIANCE_LOCKED]).toContain(COMPLIANCE_NOTICES.writePermission)
    // The control: the editorial global is deliberately NOT on that list.
    expect([...COMPLIANCE_LOCKED]).not.toContain(EDITORIAL_DEFAULTS.writePermission)
  })

  it('allows the owner on both', () => {
    expect(mayWriteGlobal('owner', COMPLIANCE_NOTICES.slug)).toBe(true)
    expect(mayWriteGlobal('owner', EDITORIAL_DEFAULTS.slug)).toBe(true)
  })

  it('refuses an unknown global for every role, including the owner', () => {
    // Deny by default, the same way `can()` treats an unknown permission. A global that is not in the
    // model is a slug somebody typed, and the owner's wildcard must not turn a typo into a grant.
    for (const role of ROLES) {
      expect(mayWriteGlobal(role, 'not_a_global'), role).toBe(false)
      expect(mayReadGlobal(role, 'not_a_global'), role).toBe(false)
    }
    expect(() => assertMayWriteGlobal('owner', 'not_a_global')).toThrow(/unknown global/)
  })
})

describe('acceptance — the principal’s role comes from the F07 role set', () => {
  it('accepts every declared role and nothing else', () => {
    for (const role of ROLES) expect(isRole(role), role).toBe(true)
    for (const invalid of ['editor', 'admin', 'Owner', '', null, 7]) {
      expect(isRole(invalid), String(invalid)).toBe(false)
    }
  })

  it('has no “editor” role, which is what the manifest calls the role that drafts', () => {
    // Recorded rather than papered over. The acceptance line says "an editor"; F07 has no such role.
    // `marketer` and `manager` are the roles holding content:write, and they are what the tests above use.
    expect(isRole('editor')).toBe(false)
  })
})

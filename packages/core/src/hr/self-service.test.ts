import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { ROLES, type Role } from '../access/permissions.ts'
import { EMPLOYEE_FIELD_GROUPS, EMPLOYEE_SEALED_FIELD_GROUPS } from './employee.ts'
import {
  assertPortalSubject,
  isPortalSubjectTheViewer,
  mayUseStaffPortal,
  PORTAL_BANK_MASK,
  PORTAL_EMPLOYEE_FIELDS,
  PORTAL_FORBIDDEN_FIELD_GROUPS,
  PORTAL_SELF_ONLY_REFUSAL,
  PORTAL_SURFACES,
  portalBankView,
  portalFieldPolicyProblems,
  portalRefusalOf,
} from './self-service.ts'

/**
 * P-HR-14 — the portal's access rule and its field policy.
 *
 * Two claims and each is paired with the control that must fail (brief rule 3):
 *
 *   1. **Every role is refused a colleague's subject, on every surface.** The control is that every role
 *      is ALLOWED its own, so a function that refused unconditionally would fail here rather than pass
 *      this file perfectly. The `owner` case is the one that matters: it holds `permissions: 'all'`, so a
 *      rule that had acquired a permission in its condition would start permitting it, and that is the
 *      mutation gate case 195a makes.
 *   2. **The exposed field set contains nothing but `open` fields.** The control is that the function
 *      REPORTS a problem for a salary field and for an unclassified one, so an empty answer means the
 *      walk discriminated rather than that it found nothing to look at.
 */

const VIEWER = '11111111-1111-7111-8111-111111111111'
const COLLEAGUE = '22222222-2222-7222-8222-222222222222'

describe('the portal answers for the viewer and for nobody else', () => {
  it('refuses a colleague for every role on every surface', () => {
    const refused: string[] = []
    for (const role of ROLES) {
      for (const surface of PORTAL_SURFACES) {
        let thrown: unknown
        try {
          assertPortalSubject({
            surface,
            role,
            viewerEmployeeId: VIEWER,
            subjectEmployeeId: COLLEAGUE,
          })
        } catch (error) {
          thrown = error
        }
        expect(
          thrown,
          `portal_subject_is_not_the_viewer: ${role}/${surface} was not refused a colleague`,
        ).toBeInstanceOf(AppError)
        expect(portalRefusalOf(thrown)).toBe(PORTAL_SELF_ONLY_REFUSAL)
        expect((thrown as AppError).kind).toBe('forbidden')
        refused.push(`${role}/${surface}`)
      }
    }
    // The count is the non-vacuity floor: a loop over an empty enumeration would otherwise pass with
    // nothing asserted. A FLOOR and not an exact number, because the matrix gains a role when somebody
    // adds one and a case that had to be edited for that would be edited without being read. Eight roles
    // and four surfaces as this is written, which is 32.
    expect(refused).toHaveLength(ROLES.length * PORTAL_SURFACES.length)
    expect(refused.length).toBeGreaterThanOrEqual(32)
  })

  it('allows every role its own subject, which is the control for the refusal above', () => {
    for (const role of ROLES) {
      for (const surface of PORTAL_SURFACES) {
        expect(() =>
          assertPortalSubject({
            surface,
            role,
            viewerEmployeeId: VIEWER,
            subjectEmployeeId: VIEWER,
          }),
        ).not.toThrow()
      }
    }
  })

  it('refuses the OWNER, so the rule is about the surface and not about the role', () => {
    // The case that would start passing if a permission crept into the condition. `owner` holds
    // `permissions: 'all'`, so any `can(role, …)` in the rule answers true for it.
    const owner: Role = 'owner'
    expect(
      isPortalSubjectTheViewer({ viewerEmployeeId: VIEWER, subjectEmployeeId: COLLEAGUE }),
    ).toBe(false)
    expect(() =>
      assertPortalSubject({
        surface: 'payslip',
        role: owner,
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: COLLEAGUE,
      }),
    ).toThrow(PORTAL_SELF_ONLY_REFUSAL)
  })

  it('carries the surface and both ids on the refusal, so a log names what was asked', () => {
    try {
      assertPortalSubject({
        surface: 'commission',
        role: 'therapist',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: COLLEAGUE,
      })
      expect.unreachable('a colleague subject must be refused')
    } catch (error) {
      const details = (error as AppError).details
      expect(details['surface']).toBe('commission')
      expect(details['viewerEmployeeId']).toBe(VIEWER)
      expect(details['subjectEmployeeId']).toBe(COLLEAGUE)
    }
  })

  it('answers null for an error that is not this refusal', () => {
    expect(portalRefusalOf(new AppError('forbidden', 'something else'))).toBeNull()
    expect(portalRefusalOf(new Error('plain'))).toBeNull()
    expect(portalRefusalOf(undefined)).toBeNull()
  })
})

describe('who may use the portal at all', () => {
  it('admits the roles that may request leave and refuses the rest', () => {
    // Asked as a permission rather than as a role list, so the two halves are read off the matrix.
    expect(mayUseStaffPortal('therapist')).toBe(true)
    expect(mayUseStaffPortal('owner')).toBe(true)
    // The control: a role with no employment surface of its own. `marketer` holds no `leave:request`.
    expect(mayUseStaffPortal('marketer')).toBe(false)
    expect(mayUseStaffPortal('auditor')).toBe(false)
  })

  it('never widens the subject rule', () => {
    // The two questions are independent, and this is the assertion that says so: a role admitted to the
    // portal is still refused a colleague.
    expect(mayUseStaffPortal('owner')).toBe(true)
    expect(() =>
      assertPortalSubject({
        surface: 'leave',
        role: 'owner',
        viewerEmployeeId: VIEWER,
        subjectEmployeeId: COLLEAGUE,
      }),
    ).toThrow()
  })
})

describe('the exposed field set', () => {
  it('is wholly open fields', () => {
    expect(portalFieldPolicyProblems()).toEqual([])
    // Not vacuous: the set is non-empty and every name in it is one the classification knows.
    expect(PORTAL_EMPLOYEE_FIELDS.length).toBeGreaterThanOrEqual(5)
    for (const field of PORTAL_EMPLOYEE_FIELDS) {
      expect(Object.keys(EMPLOYEE_FIELD_GROUPS)).toContain(field)
    }
  })

  it('reports a wage field, an identity field and an unclassified one, which is the control', () => {
    const problems = portalFieldPolicyProblems([
      'basicWageFils',
      'gender',
      'somethingNobodyClassified',
    ])
    expect(
      problems,
      'portal-field-policy-refuses-a-non-open-field: a wage, an identity field and an unclassified ' +
        'one must each be reported, or the empty answer for the real set proves nothing',
    ).toHaveLength(3)
    expect(problems.join(' ')).toContain('employee.salary')
    expect(problems.join(' ')).toContain('employee.identity_documents')
    expect(problems.join(' ')).toContain('not classified')
  })

  it('reports every sealed field, so the bank number cannot be added to the set', () => {
    // The sealed fields are not in `EMPLOYEE_FIELD_GROUPS` at all — they are in
    // `EMPLOYEE_SEALED_FIELD_GROUPS` — so they come back as UNCLASSIFIED rather than as the wrong group.
    // That is the right failure: a portal that asked for `bankIban` is asking for something no projection
    // returns, and the message says so.
    const sealed = Object.keys(EMPLOYEE_SEALED_FIELD_GROUPS)
    expect(sealed.length).toBeGreaterThan(0)
    expect(portalFieldPolicyProblems(sealed)).toHaveLength(sealed.length)
  })

  it('names the three field groups the portal may never expose', () => {
    expect([...PORTAL_FORBIDDEN_FIELD_GROUPS].sort()).toEqual([
      'employee.bank',
      'employee.identity_documents',
      'employee.salary',
    ])
  })
})

describe('the bank panel', () => {
  it('shows the mask, the label and the filing date, and holds no number', () => {
    const view = portalBankView({ onFile: true, label: 'Salary account', filedOn: '2026-03-04' })
    expect(view.onFile).toBe(true)
    expect(view.label).toBe('Salary account')
    expect(view.filedOn).toBe('2026-03-04')
    expect(view.maskedNumber).toBe(PORTAL_BANK_MASK)
    /*
      The claim that matters: the only account-shaped field on the view is the mask, and the mask has no
      alphanumeric character in it. This is not "the number was redacted" — the type has nowhere to put
      one, so a future edit cannot print one.

      Asserted on the mask and on the view's KEY SET rather than on the serialised view, which is the
      first version of this case and it was wrong in a way worth recording: `filedOn` is `2026-03-04`, so
      a blanket "no run of four digits" matched the year and the case failed about the date. A rule whose
      counter-example is the data it is meant to allow is a rule about the wrong thing.
    */
    expect(PORTAL_BANK_MASK).not.toMatch(/[0-9A-Za-z]/)
    expect(Object.keys(view).sort()).toEqual(['filedOn', 'label', 'maskedNumber', 'onFile'])
  })

  it('drops the label and the date when nothing is on file', () => {
    // A label with no account behind it is a sentence about an account that does not exist, and the
    // screen would read as though payroll were configured.
    const view = portalBankView({ onFile: false, label: 'Salary account', filedOn: '2026-03-04' })
    expect(view.label).toBeNull()
    expect(view.filedOn).toBeNull()
    expect(view.onFile).toBe(false)
  })
})

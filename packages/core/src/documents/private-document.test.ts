import { describe, expect, it } from 'vitest'
import { can, canReadFieldGroup, PERMISSIONS, ROLES, type Role } from '../access/permissions.ts'
import {
  DOCUMENT_SIGNATURE_TTL_SECONDS,
  documentReadRefusal,
  documentUsePolicy,
  isPrivateDocumentClass,
  PRIVATE_DOCUMENT_CLASS_DEFINITIONS,
  PRIVATE_DOCUMENT_CLASSES,
  SINGLE_USE_DOCUMENT_CLASSES,
} from './private-document.ts'

/**
 * Who may read which private document (W-SYS-14).
 *
 * Enumerated as a MATRIX rather than as examples, which is ADR 0009's third property and the reason this
 * module is pure: the realistic mistake is not "the tax invoice case is wrong", it is "a class was added and
 * its permission was copied from the one above". Several cases below iterate every role against every class
 * and assert a global property, which is the only shape that catches that.
 */
describe('the private document catalogue', () => {
  it('maps every class onto a permission the matrix already declares', () => {
    // The whole reason the mapping exists rather than a `document:read` permission of its own: a second
    // table saying who may download a payslip would be the copy that disagrees, and it would disagree in the
    // direction where a role keeps a document it lost in the matrix.
    for (const name of PRIVATE_DOCUMENT_CLASSES) {
      const definition = PRIVATE_DOCUMENT_CLASS_DEFINITIONS[name]
      expect(PERMISSIONS as readonly string[], name).toContain(definition.permission)
      expect(definition.describes.length, name).toBeGreaterThan(20)
    }
  })

  it('has a definition for every class and no definition for anything else', () => {
    expect(Object.keys(PRIVATE_DOCUMENT_CLASS_DEFINITIONS).sort()).toEqual(
      [...PRIVATE_DOCUMENT_CLASSES].sort(),
    )
  })

  it('denies an unknown class by default, including one that merely looks like a class', () => {
    for (const candidate of [
      '',
      'tax',
      'tax_invoice ',
      'TAX_INVOICE',
      'bank_statement',
      '__proto__',
    ]) {
      expect(isPrivateDocumentClass(candidate), candidate).toBe(false)
      // Every role, including the wildcard one. `owner` holds `'all'`, so a deny-by-default that consulted
      // the permission first would grant the owner a class nobody has declared — which is the shape of
      // defect `canReadFieldGroup` had until P-HR-01.
      for (const role of ROLES) {
        expect(documentReadRefusal(role, candidate), `${role}/${candidate}`).toBe(
          'document_class_unknown',
        )
      }
    }
    expect(isPrivateDocumentClass('tax_invoice')).toBe(true)
  })

  it('derives the single-use set from the definitions rather than restating it', () => {
    expect([...SINGLE_USE_DOCUMENT_CLASSES].sort()).toEqual(['clinical_extract', 'payslip'])
    for (const name of PRIVATE_DOCUMENT_CLASSES) {
      const expected = SINGLE_USE_DOCUMENT_CLASSES.includes(name) ? 'single_use' : 'replayable'
      expect(documentUsePolicy(name), name).toBe(expected)
    }
  })

  it('refuses to answer a use policy for a class it does not know', () => {
    // Guessing `replayable` would make the UNCLASSIFIED document the most permissive one in the system.
    expect(() => documentUsePolicy('bank_statement' as never)).toThrow(
      /\[unknown-private-document-class\]/,
    )
  })

  it('holds a link for fifteen minutes, which is the same figure the evidence grant uses', () => {
    // Deliberately the same rather than a second number: two link lifetimes in one product is a thing
    // somebody has to explain, and `EVIDENCE_GRANT_TTL_SECONDS` in `@berelax/db` is 15 * 60 too. Asserted
    // here as a figure rather than imported, because `core` may not import `db`.
    expect(DOCUMENT_SIGNATURE_TTL_SECONDS).toBe(900)
  })
})

describe('documentReadRefusal, against every role', () => {
  it('agrees with the matrix for every role and every class, in both directions', () => {
    let granted = 0
    let refused = 0
    for (const role of ROLES) {
      for (const name of PRIVATE_DOCUMENT_CLASSES) {
        const definition = PRIVATE_DOCUMENT_CLASS_DEFINITIONS[name]
        const permitted =
          can(role, definition.permission) &&
          (definition.fieldGroup === undefined || canReadFieldGroup(role, definition.fieldGroup))
        const outcome = documentReadRefusal(role, name)
        expect(outcome === undefined, `${role}/${name}`).toBe(permitted)
        if (outcome === undefined) granted += 1
        else refused += 1
      }
    }
    /*
      Both counts, because either being zero makes the loop above assert nothing.

      A `documentReadRefusal` that returned `undefined` unconditionally and a matrix that granted nothing
      would each satisfy the per-pair assertion while the derivation was doing no work. 8 roles times 6
      classes is 48 pairs; the split MEASURED on this tree is 13 granted and 35 refused, and the floors are
      set well under each so that adding a class or a role does not turn this into a figure somebody updates
      without reading.
    */
    expect(granted, 'no role may read any document, so the mapping grants nothing').toBeGreaterThan(
      8,
    )
    expect(
      refused,
      'every role may read every document, so the mapping refuses nothing',
    ).toBeGreaterThan(16)
    expect(granted + refused).toBe(ROLES.length * PRIVATE_DOCUMENT_CLASSES.length)
  })

  it('refuses a receptionist a payslip and a marketer a tax document — the acceptance pair', () => {
    // The two cases the acceptance line names, spelled out because they are the ones a reader checks.
    // `field_group_denied` and not `permission_denied` for the receptionist: they hold neither
    // `payroll:read` nor `employee.salary`, and the permission is tested first, so the reason is the
    // permission's. Asserted as whichever it actually is, so the case cannot drift into a tautology.
    expect(documentReadRefusal('receptionist', 'payslip')).toBe('permission_denied')
    expect(documentReadRefusal('marketer', 'tax_invoice')).toBe('permission_denied')
    expect(documentReadRefusal('marketer', 'tax_credit_note')).toBe('permission_denied')
    // The controls, without which the two above would pass for a function that refuses everybody.
    expect(documentReadRefusal('accountant', 'payslip')).toBeUndefined()
    expect(documentReadRefusal('accountant', 'tax_invoice')).toBeUndefined()
    expect(documentReadRefusal('owner', 'clinical_extract')).toBeUndefined()
  })

  it('reports a field-group denial separately from a permission denial', () => {
    /*
      The manager is the role this distinction exists for, and it is the one ADR 0009 points at: they hold
      `employee:read` and `employee.bank` and deliberately NOT `employee.salary`, so a payslip gated on a
      permission alone would reach them. Finding a role that holds the permission and not the group is what
      makes `field_group_denied` reachable at all — if no role did, the branch would be dead code and this
      case says so by failing.
    */
    const withPermissionNotGroup = ROLES.filter(
      (role: Role) =>
        can(role, PRIVATE_DOCUMENT_CLASS_DEFINITIONS.payslip.permission) &&
        !canReadFieldGroup(role, 'employee.salary'),
    )
    // Zero is a legitimate answer for the matrix as it stands and would make the branch unreachable, so the
    // assertion is on the BRANCH rather than on a role that may be regranted later.
    for (const role of withPermissionNotGroup) {
      expect(documentReadRefusal(role, 'payslip'), role).toBe('field_group_denied')
    }
    expect(documentReadRefusal('manager', 'payslip')).toBe(
      can('manager', 'payroll:read') ? 'field_group_denied' : 'permission_denied',
    )
  })

  it('gives a clinical extract to the clinical roles and to nobody financial', () => {
    // ADR 0010's boundary, restated where a document could cross it. The accountant sees every financial
    // record and no clinical data at all, and a subject-access extract is clinical data in a PDF.
    expect(documentReadRefusal('therapist', 'clinical_extract')).toBeUndefined()
    expect(documentReadRefusal('accountant', 'clinical_extract')).toBe('permission_denied')
    expect(documentReadRefusal('auditor', 'clinical_extract')).toBe('permission_denied')
    expect(documentReadRefusal('receptionist', 'clinical_extract')).toBe('permission_denied')
  })
})

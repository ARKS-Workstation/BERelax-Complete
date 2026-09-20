import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  assertCan,
  assertCanReadFieldGroup,
  can,
  canReadFieldGroup,
  FIELD_GROUPS,
  type FieldGroup,
  PERMISSIONS,
  type Permission,
  ROLE_DEFINITIONS,
  ROLES,
  redactForRole,
  requiresTotp,
} from './permissions.ts'

describe('deny by default', () => {
  it('refuses a permission that is not in the catalogue', () => {
    expect(can('owner', 'nonsense:action' as Permission)).toBe(false)
  })

  it('refuses every permission for a role that was granted none', () => {
    // marketer holds no field groups at all.
    for (const group of FIELD_GROUPS) {
      expect(canReadFieldGroup('marketer', group)).toBe(false)
    }
  })

  it('refuses a field group that is not in the catalogue, even for the wildcard role', () => {
    // `can()` has refused an unrecognised permission string since F07; `canReadFieldGroup` did not until
    // P-HR-01, so the two halves of one policy disagreed in the direction that matters: `owner` holds
    // every group as `'all'`, which answered TRUE for a group nobody had declared — and the group nobody
    // has declared is a field somebody has just added. The `owner` case is the whole assertion; a
    // non-wildcard role was already refused by the `includes` that follows.
    expect(canReadFieldGroup('owner', 'employee.made_up' as FieldGroup)).toBe(false)
    expect(canReadFieldGroup('manager', 'employee.made_up' as FieldGroup)).toBe(false)
    expect(() => assertCanReadFieldGroup('owner', 'employee.made_up' as FieldGroup)).toThrow(
      AppError,
    )
  })

  it('grants the manager the HR file and NOT the wage, which keeps the projection reachable', () => {
    // P-HR-01 widened the manager to the two groups an HR screen cannot work without, and deliberately
    // not to `employee.salary`. This pins both halves: the second is what makes `manager` the role that
    // holds `employee:read` without `employee.salary`, so the field-level projection in
    // `../hr/employee.ts` drops a column for somebody rather than for nobody.
    expect(canReadFieldGroup('manager', 'employee.bank')).toBe(true)
    expect(canReadFieldGroup('manager', 'employee.identity_documents')).toBe(true)
    expect(canReadFieldGroup('manager', 'employee.salary')).toBe(false)
    expect(can('manager', 'employee:read')).toBe(true)
    // And the clinical boundary is untouched by that widening: it is a different boundary (ADR 0010).
    expect(canReadFieldGroup('manager', 'clinical.notes')).toBe(false)
  })

  it('assertCan throws a forbidden AppError naming the role and permission', () => {
    try {
      assertCan('receptionist', 'payroll:run')
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).kind).toBe('forbidden')
      expect((e as AppError).message).toContain('receptionist')
      expect((e as AppError).message).toContain('payroll:run')
    }
  })

  it('every role has a definition, so no role can fall through to an implicit allow', () => {
    for (const role of ROLES) {
      expect(ROLE_DEFINITIONS[role]).toBeDefined()
      expect(ROLE_DEFINITIONS[role].description.length).toBeGreaterThan(10)
    }
  })

  it('no role grants a permission outside the declared catalogue', () => {
    const known = new Set<string>(PERMISSIONS)
    for (const role of ROLES) {
      const def = ROLE_DEFINITIONS[role]
      if (def.permissions === 'all') continue
      for (const p of def.permissions) expect(known.has(p)).toBe(true)
    }
  })
})

describe('the receptionist boundary — the case route-level checks cannot express', () => {
  it('CAN read a customer, because taking a booking requires it', () => {
    expect(can('receptionist', 'customer:read')).toBe(true)
  })

  it('CANNOT read clinical notes', () => {
    expect(can('receptionist', 'clinical_note:read')).toBe(false)
    expect(canReadFieldGroup('receptionist', 'clinical.notes')).toBe(false)
  })

  it('CAN see that a contraindication flag exists, which is what it needs to route a booking', () => {
    expect(can('receptionist', 'clinical_flags:read')).toBe(true)
    expect(canReadFieldGroup('receptionist', 'clinical.flags')).toBe(true)
  })

  it('CANNOT read salary or bank details', () => {
    expect(canReadFieldGroup('receptionist', 'employee.salary')).toBe(false)
    expect(canReadFieldGroup('receptionist', 'employee.bank')).toBe(false)
    expect(can('receptionist', 'payroll:read')).toBe(false)
  })

  it('CANNOT export the client list — the insider-threat path', () => {
    expect(can('receptionist', 'customer:export')).toBe(false)
  })

  it('CANNOT lock a period or prepare a VAT return', () => {
    expect(can('receptionist', 'period:lock')).toBe(false)
    expect(can('receptionist', 'vat_return:prepare')).toBe(false)
  })
})

describe('role separation', () => {
  it('the accountant sees every financial record and NO clinical data', () => {
    expect(can('accountant', 'ledger:read')).toBe(true)
    expect(can('accountant', 'vat_return:prepare')).toBe(true)
    expect(canReadFieldGroup('accountant', 'employee.salary')).toBe(true)
    expect(canReadFieldGroup('accountant', 'clinical.notes')).toBe(false)
    expect(canReadFieldGroup('accountant', 'clinical.flags')).toBe(false)
    expect(can('accountant', 'clinical_note:read')).toBe(false)
  })

  it('the therapist reads clinical notes but no money or people data', () => {
    expect(canReadFieldGroup('therapist', 'clinical.notes')).toBe(true)
    expect(canReadFieldGroup('therapist', 'employee.salary')).toBe(false)
    expect(canReadFieldGroup('therapist', 'customer.spend_history')).toBe(false)
    expect(can('therapist', 'ledger:read')).toBe(false)
    expect(can('therapist', 'customer:export')).toBe(false)
  })

  it('the marketer works with segments and cannot reach individual contact details', () => {
    expect(can('marketer', 'segment:write')).toBe(true)
    expect(can('marketer', 'campaign:send')).toBe(true)
    expect(canReadFieldGroup('marketer', 'customer.contact')).toBe(false)
    expect(can('marketer', 'customer:export')).toBe(false)
    expect(can('marketer', 'customer:read')).toBe(false)
  })

  it('the auditor reads everything relevant and writes nothing', () => {
    expect(can('auditor', 'audit:read')).toBe(true)
    const writes = PERMISSIONS.filter(
      (p) =>
        p.endsWith(':write') || p.endsWith(':send') || p.endsWith(':publish') || p.endsWith(':run'),
    )
    for (const p of writes) expect(can('auditor', p)).toBe(false)
  })

  it('only the owner may change compliance-locked settings', () => {
    const allowed = ROLES.filter((r) => can(r, 'settings:write_compliance'))
    expect(allowed).toEqual(['owner'])
  })

  it('only the owner and manager may override a booking constraint', () => {
    const allowed = ROLES.filter((r) => can(r, 'booking:override_constraints'))
    expect(allowed.sort()).toEqual(['manager', 'owner'])
  })

  it('the system role has no interactive write to settings', () => {
    expect(can('system', 'settings:write')).toBe(false)
    expect(can('system', 'settings:write_compliance')).toBe(false)
  })
})

describe('TOTP requirement', () => {
  it('is mandatory for every role that touches money, people or settings', () => {
    for (const role of ['owner', 'manager', 'accountant', 'auditor'] as const) {
      expect(requiresTotp(role), `${role} must require TOTP`).toBe(true)
    }
  })

  it('is not forced on floor roles, which use shared front-desk hardware', () => {
    for (const role of ['receptionist', 'therapist', 'marketer'] as const) {
      expect(requiresTotp(role)).toBe(false)
    }
  })

  it('every role that can read salary or post to the ledger requires TOTP', () => {
    for (const role of ROLES) {
      const sensitive =
        canReadFieldGroup(role, 'employee.salary') ||
        canReadFieldGroup(role, 'employee.bank') ||
        can(role, 'ledger:post') ||
        can(role, 'payroll:run')
      if (sensitive && role !== 'system') {
        expect(requiresTotp(role), `${role} reaches sensitive data and must require TOTP`).toBe(
          true,
        )
      }
    }
  })
})

describe('redactForRole', () => {
  const record = {
    id: 'emp-1',
    name: 'A. Therapist',
    salaryFils: 1_200_000,
    bankIban: 'AE000000000000000000000',
    clinicalNote: 'private',
    contraindicationFlags: { pregnancy: false },
  }
  const fieldMap = {
    salaryFils: 'employee.salary',
    bankIban: 'employee.bank',
    clinicalNote: 'clinical.notes',
    contraindicationFlags: 'clinical.flags',
  } as const

  it('strips salary, bank and clinical notes for a receptionist but keeps the flags', () => {
    const out = redactForRole('receptionist', record, fieldMap)
    expect(out.name).toBe('A. Therapist')
    expect(out.contraindicationFlags).toBeDefined()
    expect(out.salaryFils).toBeUndefined()
    expect(out.bankIban).toBeUndefined()
    expect(out.clinicalNote).toBeUndefined()
  })

  it('keeps salary and bank for the accountant but still strips clinical notes', () => {
    const out = redactForRole('accountant', record, fieldMap)
    expect(out.salaryFils).toBeDefined()
    expect(out.bankIban).toBeDefined()
    expect(out.clinicalNote).toBeUndefined()
  })

  it('keeps everything for the owner', () => {
    const out = redactForRole('owner', record, fieldMap)
    expect(Object.keys(out).sort()).toEqual(Object.keys(record).sort())
  })

  it('keeps fields that are not in the sensitivity map', () => {
    const out = redactForRole('marketer', record, fieldMap)
    expect(out.id).toBe('emp-1')
    expect(out.salaryFils).toBeUndefined()
  })

  it('assertCanReadFieldGroup throws for a denied group', () => {
    expect(() => assertCanReadFieldGroup('receptionist', 'employee.salary')).toThrow(AppError)
  })
})

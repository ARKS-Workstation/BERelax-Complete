import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { FIELD_GROUPS, ROLES } from '../access/permissions.ts'
import { filsFrom } from '../money.ts'
import {
  assertEmployeeFieldReadable,
  assertStaffReadPurpose,
  canReadEmployeeField,
  EMPLOYEE_FIELD_ERRORS,
  EMPLOYEE_FIELD_GROUPS,
  EMPLOYEE_SEALED_FIELD_GROUPS,
  employeeFieldSensitivity,
  gratuityBaseFils,
  isEmployeePublishable,
  projectEmployeeRecord,
  STAFF_READ_PURPOSES,
  totalMonthlyWageFils,
} from './employee.ts'

/**
 * The employment record's field policy and wage arithmetic, as pure functions.
 *
 * The property that matters most is the one the acceptance criterion calls deny-by-default, and it has
 * two halves that are easy to confuse: a field whose GROUP the role lacks, and a field nobody has
 * CLASSIFIED. The second is the defect this module exists to prevent — `redactForRole` in
 * `../access/permissions.ts` returns an unmapped field, which is right for a customer record and wrong
 * for this one — so every assertion about it is paired with its opposite.
 */

const wage = (basic: number | null, housing = 0, transport = 0, other = 0) => ({
  basicWageFils: basic === null ? null : filsFrom(basic),
  housingAllowanceFils: filsFrom(housing),
  transportAllowanceFils: filsFrom(transport),
  otherAllowanceFils: filsFrom(other),
})

describe('the employment record is a closed map', () => {
  it('classifies every field it names as a declared field group or explicitly open', () => {
    const groups = new Set<string>(FIELD_GROUPS)
    for (const [field, sensitivity] of Object.entries(EMPLOYEE_FIELD_GROUPS)) {
      expect(sensitivity === 'open' || groups.has(sensitivity), `${field}`).toBe(true)
    }
    for (const [field, group] of Object.entries(EMPLOYEE_SEALED_FIELD_GROUPS)) {
      expect(groups.has(group), `${field}`).toBe(true)
    }
  })

  it('classifies every money column under employee.salary, with none left open', () => {
    // The field somebody adds next is a wage column, and the failure mode is adding it as `'open'`.
    for (const field of Object.keys(EMPLOYEE_FIELD_GROUPS).filter((name) =>
      name.endsWith('Fils'),
    )) {
      expect(employeeFieldSensitivity(field), field).toBe('employee.salary')
    }
  })

  it('refuses an unclassified field for every role, including the wildcard one', () => {
    for (const role of ROLES) {
      expect(canReadEmployeeField(role, 'ibanLast4')).toBe(false)
      expect(canReadEmployeeField(role, 'constructor')).toBe(false)
      expect(canReadEmployeeField(role, '__proto__')).toBe(false)
    }
    // The control: a classified open field is readable by every role, so the refusals above are the
    // rule and not a function that always says no.
    for (const role of ROLES) {
      expect(canReadEmployeeField(role, 'staffReference')).toBe(true)
    }
  })

  it('names the two refusals differently, because they are different defects', () => {
    try {
      assertEmployeeFieldReadable('owner', 'ibanLast4')
      expect.unreachable('an unclassified field must be refused')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).kind).toBe('forbidden')
      expect((error as AppError).message).toContain(EMPLOYEE_FIELD_ERRORS.unknownField)
    }
    try {
      assertEmployeeFieldReadable('receptionist', 'basicWageFils')
      expect.unreachable('a refused group must be refused')
    } catch (error) {
      expect((error as AppError).message).toContain(EMPLOYEE_FIELD_ERRORS.fieldGroupRefused)
      expect((error as AppError).message).toContain('employee.salary')
    }
    // An unclassified field is refused and a classified permitted one is not: the pair is what makes
    // this a check rather than a thrower.
    expect(() => assertEmployeeFieldReadable('receptionist', 'staffReference')).not.toThrow()
    expect(() => assertEmployeeFieldReadable('owner', 'basicWageFils')).not.toThrow()
  })

  it('never treats a sealed field as an ordinary column', () => {
    for (const field of Object.keys(EMPLOYEE_SEALED_FIELD_GROUPS)) {
      expect(employeeFieldSensitivity(field)).not.toBe('open')
      expect(canReadEmployeeField('receptionist', field)).toBe(false)
    }
    // The owner MAY read them — through an audited decrypt, which is the repository's job. The policy
    // does not forbid the group; it forbids the route that skips the audit, and that is a different file.
    expect(canReadEmployeeField('owner', 'bankIban')).toBe(true)
  })
})

describe('projectEmployeeRecord', () => {
  const record = {
    staffReference: 'Therapist 07',
    displayName: null,
    isPublishable: false,
    gender: 'female',
    basicWageFils: 300_000,
    totalWageFils: 420_000,
    notes: 'a manager wrote something here',
  }

  it('keeps the open fields and drops the governed ones for a receptionist', () => {
    const { visible, refused } = projectEmployeeRecord('receptionist', record)
    expect(visible.staffReference).toBe('Therapist 07')
    expect(visible.isPublishable).toBe(false)
    expect(visible.basicWageFils).toBeUndefined()
    expect(visible.gender).toBeUndefined()
    expect(visible.notes).toBeUndefined()
    expect(refused.map((entry) => entry.field).sort()).toEqual([
      'basicWageFils',
      'gender',
      'notes',
      'totalWageFils',
    ])
    for (const entry of refused) {
      expect(entry.reason).toContain(EMPLOYEE_FIELD_ERRORS.fieldGroupRefused)
    }
  })

  it('keeps everything for the owner, which is the control', () => {
    const { visible, refused } = projectEmployeeRecord('owner', record)
    expect(Object.keys(visible).sort()).toEqual(Object.keys(record).sort())
    expect(refused).toEqual([])
  })

  it('drops the wage and keeps the HR file for a manager', () => {
    // The role that holds `employee:read` without `employee.salary`. If this ever changes, the field-level
    // projection stops being exercised by any role and the integration test that pins it fails too.
    const { visible } = projectEmployeeRecord('manager', record)
    expect(visible.basicWageFils).toBeUndefined()
    expect(visible.totalWageFils).toBeUndefined()
    expect(visible.gender).toBe('female')
    expect(visible.notes).toBe('a manager wrote something here')
  })

  it('drops a field nobody classified, even for the owner, and says which rule did it', () => {
    const { visible, refused } = projectEmployeeRecord('owner', {
      ...record,
      ibanLast4: '0000',
    })
    expect(visible).not.toHaveProperty('ibanLast4')
    expect(refused).toEqual([{ field: 'ibanLast4', reason: EMPLOYEE_FIELD_ERRORS.unknownField }])
  })

  it('returns an empty projection for an empty record rather than throwing', () => {
    expect(projectEmployeeRecord('owner', {})).toEqual({ visible: {}, refused: [] })
  })
})

describe('the read purpose is a closed list', () => {
  it('accepts each declared purpose and refuses anything else', () => {
    for (const purpose of STAFF_READ_PURPOSES) {
      expect(assertStaffReadPurpose(purpose)).toBe(purpose)
    }
    for (const bad of ['', 'read', 'because', 'PAYROLL_RUN']) {
      expect(() => assertStaffReadPurpose(bad)).toThrow(AppError)
    }
  })

  it('names the declared purposes in the refusal, so the caller can pick one', () => {
    try {
      assertStaffReadPurpose('curiosity')
      expect.unreachable('an undeclared purpose must be refused')
    } catch (error) {
      expect((error as AppError).kind).toBe('validation')
      expect((error as AppError).message).toContain('payroll_run')
    }
  })
})

describe('wage arithmetic is integer fils', () => {
  it('sums the basic and the three allowances', () => {
    expect(totalMonthlyWageFils(wage(300_000, 120_000, 30_000, 1))).toBe(450_001)
  })

  it('treats an absent allowance as nothing and an absent basic wage as unknown', () => {
    expect(
      totalMonthlyWageFils({
        basicWageFils: filsFrom(200_000),
        housingAllowanceFils: null,
        transportAllowanceFils: null,
        otherAllowanceFils: null,
      }),
    ).toBe(200_000)
    // NULL and not zero: a zero total would be paid, and nobody has stated this wage (Y8-staff).
    expect(
      totalMonthlyWageFils({
        basicWageFils: null,
        housingAllowanceFils: filsFrom(50_000),
        transportAllowanceFils: null,
        otherAllowanceFils: null,
      }),
    ).toBeNull()
  })

  it('refuses a fractional figure rather than rounding it', () => {
    // `filsFrom` is the guard, and this is the assertion that the wage path goes through it: money is
    // never fractional, and a division that produced this has to be rounded deliberately first.
    expect(() =>
      totalMonthlyWageFils({
        basicWageFils: 1250.5 as never,
        housingAllowanceFils: null,
        transportAllowanceFils: null,
        otherAllowanceFils: null,
      }),
    ).toThrow(/integer number of fils/)
  })

  it('accrues gratuity on the basic wage and never on the total', () => {
    const terms = wage(300_000, 120_000)
    // docs/04 §7 and docs/06 C4. The mistake this exists to prevent is reaching for the larger figure
    // that is right there.
    expect(gratuityBaseFils(terms)).toBe(300_000)
    expect(gratuityBaseFils(terms)).not.toBe(totalMonthlyWageFils(terms))
    expect(gratuityBaseFils(wage(null, 120_000))).toBeNull()
  })
})

describe('the publication guard', () => {
  it('needs both a display name and a recorded consent', () => {
    expect(isEmployeePublishable({ displayName: null, photoConsent: false })).toBe(false)
    expect(isEmployeePublishable({ displayName: null, photoConsent: true })).toBe(false)
    expect(isEmployeePublishable({ displayName: 'A Name', photoConsent: false })).toBe(false)
    expect(isEmployeePublishable({ displayName: 'A Name', photoConsent: true })).toBe(true)
  })

  it('is the same predicate the database generates, spelled once here', () => {
    // `employee.is_publishable` is GENERATED from the same two columns (migration 0050). This function is
    // for a caller holding the pair and not the row; the integration suite asserts the two agree.
    const cases = [
      { displayName: null, photoConsent: false },
      { displayName: 'x', photoConsent: true },
    ] as const
    for (const record of cases) {
      expect(isEmployeePublishable(record)).toBe(record.displayName !== null && record.photoConsent)
    }
  })
})

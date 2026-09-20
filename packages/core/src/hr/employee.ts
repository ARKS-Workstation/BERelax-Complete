import { AppError } from '@berelax/shared'
import {
  assertCanReadFieldGroup,
  canReadFieldGroup,
  type FieldGroup,
  type Role,
} from '../access/permissions.ts'
import { type Fils, filsFrom } from '../money.ts'

/**
 * The employment record's field-level authorisation, and the wage arithmetic. Pure.
 *
 * docs/04 §7 asks for "field-level encryption plus separate access control on identity document
 * numbers and bank details, with every read audited". F07 built the access control's vocabulary —
 * `employee.salary`, `employee.bank`, `employee.identity_documents` are field groups in
 * `../access/permissions.ts`. This module is the part that decides, **per field of the employment
 * record**, which group governs it.
 *
 * ## Why this is a MAP and not a function over field names
 *
 * `redactForRole` in `../access/permissions.ts` is allow-by-default for an unmapped key: a field the
 * sensitivity map does not mention is returned. That is the right behaviour for the record it was
 * written for — an appointment or a customer, where most fields are innocuous and the map names the
 * exceptions — and it is the wrong behaviour here. The employment record is the opposite shape: almost
 * every field is sensitive, and the field somebody forgets to map is a new one, which is exactly the
 * field most likely to be a wage or a number.
 *
 * So the employment record is **closed**: `EMPLOYEE_FIELD_GROUPS` names every field, and a field that
 * is not named is refused rather than returned (`UnknownEmployeeField`). "Deny by default" for a whole
 * record means the default has to be denial for a field nobody has classified, not just for a group
 * nobody has granted — otherwise adding `iban_last4` to a query leaks it to a receptionist and no test
 * fails.
 *
 * The fields deliberately readable by anyone who may read the record at all are marked `'open'`, and
 * each is open for a stated reason: the rota needs the reference and the shift dates, and the therapist
 * grid needs the display name and the consent flag.
 */

/** A field of the employment record, mapped to the group that governs it, or explicitly `'open'`. */
export type EmployeeFieldSensitivity = FieldGroup | 'open'

/**
 * Every field of the employment record, closed.
 *
 * Keyed by the **camelCase** name the repository returns, not the column name: the projection runs at
 * the boundary where a record leaves the data layer, and a map keyed on column names would be applied
 * one layer too early — before the query has decided what it selects.
 */
export const EMPLOYEE_FIELD_GROUPS = Object.freeze({
  // Identity and roster. Open because the rota, the therapist grid and every screen that lists staff
  // need them, and none of them is a fact about the person beyond "works here".
  id: 'open',
  staffReference: 'open',
  employedFrom: 'open',
  employedUntil: 'open',
  contractType: 'open',
  isProvisional: 'open',
  provisionalNote: 'open',
  openQuestionId: 'open',
  // The publication trio. Open: `displayName` is by definition public once set (a therapist page shows
  // it), and `isPublishable` is the guard's own answer, which every caller must be able to see.
  displayName: 'open',
  photoConsent: 'open',
  isPublishable: 'open',
  // Who recorded the consent and when. `employee.identity_documents` rather than `open`: it names a
  // member of staff and a moment, which is the evidence half of the consent and not the flag.
  photoConsentRecordedAt: 'employee.identity_documents',
  photoConsentRecordedBy: 'employee.identity_documents',
  // Gender is read by the same-gender matching rule (B-AVAIL-05) inside the solver, which runs as
  // `system`. It is NOT open: it is a protected characteristic of a named person, and a receptionist
  // taking a booking needs the MATCH, never the therapist's gender.
  gender: 'employee.identity_documents',
  // Money.
  basicWageFils: 'employee.salary',
  housingAllowanceFils: 'employee.salary',
  transportAllowanceFils: 'employee.salary',
  otherAllowanceFils: 'employee.salary',
  totalWageFils: 'employee.salary',
  // Free text on an employment record is where a manager writes a performance note or a grievance.
  notes: 'employee.identity_documents',
} as const satisfies Readonly<Record<string, EmployeeFieldSensitivity>>)

export type EmployeeField = keyof typeof EMPLOYEE_FIELD_GROUPS

/** The sealed fields, which are never returned by a projection — only by an audited decrypt. */
export const EMPLOYEE_SEALED_FIELD_GROUPS = Object.freeze({
  bankIban: 'employee.bank',
  bankAccountHolder: 'employee.bank',
  documentNumber: 'employee.identity_documents',
} as const satisfies Readonly<Record<string, FieldGroup>>)

export type EmployeeSealedField = keyof typeof EMPLOYEE_SEALED_FIELD_GROUPS

const SENSITIVITY: Readonly<Record<string, EmployeeFieldSensitivity>> = Object.freeze({
  ...EMPLOYEE_FIELD_GROUPS,
  ...EMPLOYEE_SEALED_FIELD_GROUPS,
})

/** Named so a refusal is greppable and a test can assert the rule rather than the exit code. */
export const EMPLOYEE_FIELD_ERRORS = Object.freeze({
  unknownField: 'UnknownEmployeeField',
  fieldGroupRefused: 'EmployeeFieldGroupRefused',
})

/**
 * The group governing a field, or `undefined` if the field is not classified.
 *
 * Returns rather than throws, so a caller building a projection can decide; `assertEmployeeFieldReadable`
 * is the one that must not proceed.
 */
export function employeeFieldSensitivity(field: string): EmployeeFieldSensitivity | undefined {
  return Object.hasOwn(SENSITIVITY, field) ? SENSITIVITY[field] : undefined
}

/** True only for a field this module classifies AND the role's groups permit. */
export function canReadEmployeeField(role: Role, field: string): boolean {
  const sensitivity = employeeFieldSensitivity(field)
  if (sensitivity === undefined) return false
  return sensitivity === 'open' ? true : canReadFieldGroup(role, sensitivity)
}

/**
 * Throws unless the role may read the field. Two distinct named errors on purpose.
 *
 * An UNCLASSIFIED field and a REFUSED field are different defects with different fixes: the first is a
 * field somebody added to a query without deciding who may see it, the second is authorisation working.
 * One error for both would send the reader of the log to the wrong place.
 */
export function assertEmployeeFieldReadable(role: Role, field: string): void {
  const sensitivity = employeeFieldSensitivity(field)
  if (sensitivity === undefined) {
    throw new AppError(
      'forbidden',
      `${EMPLOYEE_FIELD_ERRORS.unknownField}: "${field}" is not a classified field of the employment ` +
        'record, so it is refused. Add it to EMPLOYEE_FIELD_GROUPS with the field group that governs ' +
        'it — an unclassified field is denied rather than returned, because the field nobody ' +
        'classified is the one most likely to be a wage or an identity number.',
      { details: { role, field } },
    )
  }
  if (sensitivity === 'open') return
  if (!canReadFieldGroup(role, sensitivity)) {
    throw new AppError(
      'forbidden',
      `${EMPLOYEE_FIELD_ERRORS.fieldGroupRefused}: role "${role}" may not read ${sensitivity}, which ` +
        `governs the employment-record field "${field}".`,
      { details: { role, field, group: sensitivity } },
    )
  }
}

/**
 * Projects an employment record down to what the role may read.
 *
 * Deny by default in both directions: a field the role's groups do not cover is dropped, and so is a
 * field this module does not classify. `refused` names what was dropped and why, so a screen missing a
 * column can say which rule removed it instead of rendering a blank.
 */
export function projectEmployeeRecord<T extends Record<string, unknown>>(
  role: Role,
  record: T,
): {
  readonly visible: Partial<T>
  readonly refused: readonly { readonly field: string; readonly reason: string }[]
} {
  const visible: Record<string, unknown> = {}
  const refused: { field: string; reason: string }[] = []
  for (const [field, value] of Object.entries(record)) {
    const sensitivity = employeeFieldSensitivity(field)
    if (sensitivity === undefined) {
      refused.push({ field, reason: EMPLOYEE_FIELD_ERRORS.unknownField })
      continue
    }
    if (sensitivity !== 'open' && !canReadFieldGroup(role, sensitivity)) {
      refused.push({ field, reason: `${EMPLOYEE_FIELD_ERRORS.fieldGroupRefused}:${sensitivity}` })
      continue
    }
    visible[field] = value
  }
  return { visible: visible as Partial<T>, refused }
}

/** The purpose a sensitive read is recorded under. A read with no stated purpose is not auditable. */
export const STAFF_READ_PURPOSES = [
  'payroll_run',
  'wps_file',
  'bank_detail_verification',
  'credential_check',
  'government_submission',
  'employee_request',
  'audit_response',
] as const

export type StaffReadPurpose = (typeof STAFF_READ_PURPOSES)[number]

const PURPOSE_SET: ReadonlySet<string> = new Set(STAFF_READ_PURPOSES)

/**
 * Deny by default for the purpose as well, and this is not ceremony.
 *
 * The audit row's whole value is answering "why was this account opened", and a free-text purpose
 * becomes `''` or `'read'` on the third call site. A closed list means a new reason to open a bank
 * record is a change somebody has to make deliberately, in a file a reviewer reads.
 */
export function assertStaffReadPurpose(purpose: string): StaffReadPurpose {
  if (!PURPOSE_SET.has(purpose)) {
    throw new AppError(
      'validation',
      `"${purpose}" is not a declared purpose for reading staff PII. One of: ` +
        `${STAFF_READ_PURPOSES.join(', ')}. An unexplained read is an audit row that answers nothing.`,
      { details: { purpose } },
    )
  }
  return purpose as StaffReadPurpose
}

/** The wage terms as the database holds them: integer fils, any of them unknown. */
export interface WageTerms {
  readonly basicWageFils: Fils | null
  readonly housingAllowanceFils: Fils | null
  readonly transportAllowanceFils: Fils | null
  readonly otherAllowanceFils: Fils | null
}

/**
 * basic + housing + transport + other, in integer fils, or `null` while the basic wage is unknown.
 *
 * The same expression `employee.total_wage_fils` is GENERATED from, and it exists here for the caller
 * that has the terms in hand and not the row — a payroll preview, a WPS export being assembled. The
 * database is the authority; this must agree with it, and `employee.itest.ts` asserts the two against
 * each other on the same row rather than trusting that they read alike.
 *
 * `null` and not zero when the basic wage is absent: a zero total would be paid.
 */
export function totalMonthlyWageFils(terms: WageTerms): Fils | null {
  if (terms.basicWageFils === null) return null
  return filsFrom(
    terms.basicWageFils +
      (terms.housingAllowanceFils ?? 0) +
      (terms.transportAllowanceFils ?? 0) +
      (terms.otherAllowanceFils ?? 0),
  )
}

/**
 * End-of-service gratuity accrues on the BASIC wage alone (docs/04 §7, docs/06 C4).
 *
 * A function rather than a comment on the column, because the mistake it prevents is reaching for
 * `totalWageFils` — which is right there, is larger, and is wrong. The accrual itself is P-HR's later
 * unit; this is the figure it must start from.
 */
export function gratuityBaseFils(terms: WageTerms): Fils | null {
  return terms.basicWageFils
}

/** ADR 0020's publication guard, as the database generates it. */
export function isEmployeePublishable(record: {
  readonly displayName: string | null
  readonly photoConsent: boolean
}): boolean {
  return record.displayName !== null && record.photoConsent
}

/**
 * Re-exported so a call site that needs the group check alone does not import two modules.
 *
 * `assertCanReadFieldGroup` is F07's; this module's `assertEmployeeFieldReadable` is the per-field
 * layer above it. Both exist because a caller sometimes knows the group (a whole bank-detail read) and
 * sometimes only the field name (a projection over a row).
 */
export { assertCanReadFieldGroup }

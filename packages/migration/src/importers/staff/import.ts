import type { StaffQuarantine, UnitOfWork } from '@berelax/db'
import {
  insertImportedStaff,
  readImportableDocumentTypes,
  readLeaveRuleInForce,
  recordImportedStaffRow,
  STAFF_QUARANTINES,
  staffReferenceIsHeld,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { ImporterDefinition, RowVerdict, StagedSourceRow } from '../../framework.ts'
import type { ImportedEntity } from '../../provenance.ts'
import { wholeOrNaN } from '../appointments/import.ts'
import type { LeaveBasis, LeaveYearAnchor } from './leave-opening.ts'
import {
  assertLeaveYearAnchor,
  isIsoDate,
  isLeaveBasis,
  LEAVE_BASES,
  readCredentialCell,
} from './leave-opening.ts'
import type { StaffCell } from './workbook.ts'
import { parseStaffWorkbook, STAFF_GENDERS, STAFF_LANGUAGES, STAFF_SKILLS } from './workbook.ts'

/**
 * The staff importer — H-MIG-06, and the unit whose subject is the four things it REFUSES to infer.
 *
 * ## The four
 *
 * 1. **A gender.** `employee.gender` is nullable because migration 0030 refused to have a migration
 *    "invent nineteen people's genders", and gender is a hard constraint on assignment (B-AVAIL-05): a
 *    customer may ask for a female therapist and the booking rules enforce it. A guessed value therefore
 *    decides who may treat whom, and a null one quietly makes that therapist unassignable to every
 *    gender-specified request while looking like an ordinary row. A blank cell is QUARANTINED, and ZY374
 *    is what makes the quarantine unforgeable rather than a convention of this file.
 * 2. **A leave balance's unit.** `./leave-opening.ts` is the whole argument. The short version: there is
 *    no conversion to apply, which is exactly why nobody would notice the question was never asked.
 * 3. **A wage, an allowance or a contract type.** Not a column, and `employee.basic_wage_fils` stays
 *    NULL. Brief rule 15 is sharpest where the consequence is a payment, and `Y8-wps` already records
 *    that a plausible identifier here would pay nineteen people against somebody else's registration.
 * 4. **A bank account or an identity number.** Not a column either, and the reason is this unit's
 *    sharpest instance of ADR 0072: `import_row.payload` is kept for ever and no erasure reaches it, so
 *    an IBAN in this workbook is an IBAN in that ledger permanently — strictly worse than the plaintext
 *    column `employee_bank_detail` was built to avoid, because that column does not exist and this one
 *    could not be removed afterwards.
 *
 * ## What it DOES import about a credential, and why that half is enough
 *
 * The type and the expiry. That is the half availability is gated on: `readEligibleTherapists` excludes a
 * therapist whose mandatory document has lapsed by the trading date with `credential_expired`, and
 * `readReassignmentCandidates` is what then finds their future appointments. A document NUMBER is not in
 * that path at all, so leaving it out costs nothing the acceptance line asks for and removes the one
 * thing that could not be taken back.
 *
 * An expiry already in the past is imported AS IT STANDS. That is the acceptance line "an imported
 * document with a past expiry date removes that therapist from bookable availability immediately and
 * flags their future appointments for reassignment": the import writes the truth and the existing gate
 * does the rest, which is why this unit adds no availability code.
 *
 * ## Publishability is not this importer's promise
 *
 * `display_name` is NULL and `photo_consent` false, and `employee.is_publishable` is GENERATED from both
 * (0030, decision 23). So nothing this import writes can publish a therapist whatever it does, and the
 * acceptance line is asserted against that generation rather than against a rule here. ADR 0020 is why
 * there is no name column at all.
 */

export const STAFF_IMPORTER_NAME = 'staff'

/**
 * The importer's own version, recorded on every run.
 *
 * `1`: nothing has read a staff file before. For this importer the code's JUDGEMENT is the figure —
 * which lines were quarantined and why — so a balance somebody disputes has to be traceable to the
 * version that decided it as well as to the row it came from (H-MIG-01).
 */
export const STAFF_IMPORTER_VERSION = '1'

/**
 * The tables this importer writes, schema-qualified and complete: ZY194 refuses provenance for anything
 * not in this list, and the report's before/after checksums are taken over exactly it.
 *
 * `imported_staff_row` is first because it is the row that ALWAYS exists. `employee_skill` and
 * `employee_language` are absent and that is not an omission: their primary key is
 * `(employee_id, skill)`, and `import_provenance` addresses a target by a SINGLE-column primary key —
 * ZY199 refuses a coverage read over a relation without one. They are provenanced through the `employee`
 * row they cascade from, which is the row the file's line is actually about.
 */
export const STAFF_IMPORTER_TARGETS: readonly string[] = Object.freeze([
  'public.imported_staff_row',
  'public.employee',
  'public.employee_document',
  'public.leave_movement',
])

/**
 * Every reason a staged staff payload is refused, and every one of them is about the ROW'S OWN TEXT.
 *
 * A rejection fails the WHOLE FILE and imports nothing (ADR 0065). A line that is well-formed and states
 * something that cannot be ACCEPTED — an unrecorded gender, a balance whose unit nobody confirmed, a
 * reference somebody already holds — is a QUARANTINE instead (`STAFF_QUARANTINES` in `@berelax/db`),
 * because refusing the whole file for one of those would mean no therapist could be imported until every
 * open question about every therapist had been answered.
 *
 * The two lists live in different packages deliberately: the quarantine vocabulary is checked by
 * `imported_staff_row`'s CHECK and belongs beside the SQL.
 */
export const STAFF_REJECTIONS = {
  payloadNotMinimised: 'staged-payload-must-carry-only-the-declared-keys',
  staffReferenceMissing: 'staff-reference-must-be-stated',
  genderNotAKnownValue: 'gender-must-be-female-or-male-or-blank',
  employedFromNotADate: 'employed-from-must-be-an-iso-date',
  employedUntilNotADate: 'employed-until-must-be-an-iso-date-or-blank',
  employmentPeriodNotOrdered: 'employed-until-must-not-precede-employed-from',
  skillNotAKnownStyle: 'style-skills-must-name-asian-style-or-arabic-style',
  languageNotAKnownLanguage: 'languages-must-name-english-or-arabic',
  credentialNotATypeAndADate: 'credential-expiries-must-be-type-equals-iso-date-pairs',
  credentialTypeRepeated: 'credential-expiries-must-not-name-one-type-twice',
  leaveBalanceNotWholeHundredths: 'leave-opening-must-be-whole-day-hundredths',
  leaveBalanceNegative: 'leave-opening-must-not-be-negative',
  leaveBasisNotAKnownValue: 'leave-opening-basis-must-be-stated',
  leaveAsAtNotADate: 'leave-balance-as-at-must-be-an-iso-date',
  leaveAsAtBeforeEmployment: 'leave-balance-as-at-must-not-precede-employed-from',
  staffReferenceRepeated: 'staff-reference-is-already-on-another-line',
} as const

export type StaffRejection = (typeof STAFF_REJECTIONS)[keyof typeof STAFF_REJECTIONS]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const STAFF_REJECTION_REASONS: readonly StaffRejection[] = Object.freeze(
  Object.values(STAFF_REJECTIONS),
)

/**
 * The keys a staged staff payload may carry, and NOT ONE MORE.
 *
 * Unlike H-MIG-04's and H-MIG-05's lists this is not about minimising personal data to a digest — there
 * is none here to digest, because the file carries no number, no name and no identity field. It is about
 * the ledger's permanence from the other side: a key added to the payload is a key kept for ever, so the
 * set is closed and a payload carrying anything else refuses the file rather than being kept.
 */
export const DECLARED_STAFF_PAYLOAD_KEYS = [
  'staffReference',
  'gender',
  'employedFrom',
  'employedUntil',
  'styleSkills',
  'languages',
  'credentialExpiries',
  'leaveOpeningHundredths',
  'leaveOpeningBasis',
  'leaveBalanceAsAt',
] as const

export type DeclaredStaffPayloadKey = (typeof DECLARED_STAFF_PAYLOAD_KEYS)[number]

export interface StagedStaffPayload {
  readonly staffReference: string
  /** `female`, `male`, or the empty string for a cell nobody filled in — which quarantines. */
  readonly gender: string
  readonly employedFrom: string
  /** The empty string for somebody still employed, which is the ordinary case. */
  readonly employedUntil: string
  readonly styleSkills: readonly string[]
  readonly languages: readonly string[]
  /** `type=YYYY-MM-DD` pairs, as typed. */
  readonly credentialExpiries: readonly string[]
  readonly leaveOpeningHundredths: number
  readonly leaveOpeningBasis: string
  readonly leaveBalanceAsAt: string
}

const DECLARED = new Set<string>(DECLARED_STAFF_PAYLOAD_KEYS)

const strings = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : null

/** The identity, the employment period and the two list cells. */
function validateStaffIdentity(payload: Readonly<Record<string, unknown>>): RowVerdict {
  for (const key of Object.keys(payload)) {
    if (!DECLARED.has(key)) return { ok: false, reason: STAFF_REJECTIONS.payloadNotMinimised }
  }
  const reference = payload['staffReference']
  if (typeof reference !== 'string' || reference.trim().length === 0) {
    return { ok: false, reason: STAFF_REJECTIONS.staffReferenceMissing }
  }
  const gender = payload['gender']
  // The empty string is PERMITTED here and quarantines at apply. That split is the acceptance line: an
  // unrecorded gender is a fact about the business, not a malformed cell, so it must not fail the file.
  if (typeof gender !== 'string' || (gender !== '' && !STAFF_GENDERS.includes(gender))) {
    return { ok: false, reason: STAFF_REJECTIONS.genderNotAKnownValue }
  }
  if (!isIsoDate(payload['employedFrom'])) {
    return { ok: false, reason: STAFF_REJECTIONS.employedFromNotADate }
  }
  const until = payload['employedUntil']
  if (typeof until !== 'string' || (until !== '' && !isIsoDate(until))) {
    return { ok: false, reason: STAFF_REJECTIONS.employedUntilNotADate }
  }
  if (until !== '' && until < (payload['employedFrom'] as string)) {
    return { ok: false, reason: STAFF_REJECTIONS.employmentPeriodNotOrdered }
  }

  const skills = strings(payload['styleSkills'])
  if (skills === null || skills.some((skill) => !STAFF_SKILLS.includes(skill))) {
    return { ok: false, reason: STAFF_REJECTIONS.skillNotAKnownStyle }
  }
  const languages = strings(payload['languages'])
  if (languages === null || languages.some((language) => !STAFF_LANGUAGES.includes(language))) {
    return { ok: false, reason: STAFF_REJECTIONS.languageNotAKnownLanguage }
  }
  return { ok: true }
}

/** The credential pairs and the leave figure. */
function validateStaffCredentialsAndLeave(payload: Readonly<Record<string, unknown>>): RowVerdict {
  const credentials = strings(payload['credentialExpiries'])
  if (credentials === null) {
    return { ok: false, reason: STAFF_REJECTIONS.credentialNotATypeAndADate }
  }
  const seen = new Set<string>()
  for (const cell of credentials) {
    const pair = readCredentialCell(cell)
    if (!pair.ok) return { ok: false, reason: STAFF_REJECTIONS.credentialNotATypeAndADate }
    // `employee_document_one_row_per_expiry` is unique on (employee, type, expiry), so two lines with
    // the same type and DIFFERENT dates would both insert and the gate would read `max(expires_on)` —
    // the later one — which is the lapsed credential silently ignored. Refused here by name.
    if (seen.has(pair.documentType)) {
      return { ok: false, reason: STAFF_REJECTIONS.credentialTypeRepeated }
    }
    seen.add(pair.documentType)
  }

  const hundredths = payload['leaveOpeningHundredths']
  if (typeof hundredths !== 'number' || !Number.isInteger(hundredths)) {
    return { ok: false, reason: STAFF_REJECTIONS.leaveBalanceNotWholeHundredths }
  }
  if (hundredths < 0) return { ok: false, reason: STAFF_REJECTIONS.leaveBalanceNegative }

  if (!isLeaveBasis(payload['leaveOpeningBasis'])) {
    return { ok: false, reason: STAFF_REJECTIONS.leaveBasisNotAKnownValue }
  }
  if (!isIsoDate(payload['leaveBalanceAsAt'])) {
    return { ok: false, reason: STAFF_REJECTIONS.leaveAsAtNotADate }
  }
  if ((payload['leaveBalanceAsAt'] as string) < (payload['employedFrom'] as string)) {
    // `leaveYearStart` throws for a date before the employment started, so this is the cell error that
    // would otherwise arrive as an exception from inside the anchor with no line number attached.
    return { ok: false, reason: STAFF_REJECTIONS.leaveAsAtBeforeEmployment }
  }
  return { ok: true }
}

export function validateStagedStaff(payload: Readonly<Record<string, unknown>>): RowVerdict {
  const identity = validateStaffIdentity(payload)
  if (!identity.ok) return identity
  return validateStaffCredentialsAndLeave(payload)
}

/** The staged payload, read back from `jsonb` with its keys typed. */
function readStaged(payload: Readonly<Record<string, unknown>>): StagedStaffPayload {
  const verdict = validateStagedStaff(payload)
  if (!verdict.ok) {
    throw new AppError(
      'invariant_violated',
      `A staged staff payload reached apply that staging should have refused (${verdict.reason}). ` +
        'Validation happens over every row before anything is applied, so reaching here means a payload ' +
        'was written into the ledger by something other than this importer.',
      { details: { reason: verdict.reason } },
    )
  }
  return {
    staffReference: payload['staffReference'] as string,
    gender: payload['gender'] as string,
    employedFrom: payload['employedFrom'] as string,
    employedUntil: payload['employedUntil'] as string,
    styleSkills: payload['styleSkills'] as readonly string[],
    languages: payload['languages'] as readonly string[],
    credentialExpiries: payload['credentialExpiries'] as readonly string[],
    leaveOpeningHundredths: payload['leaveOpeningHundredths'] as number,
    leaveOpeningBasis: payload['leaveOpeningBasis'] as LeaveBasis,
    leaveBalanceAsAt: payload['leaveBalanceAsAt'] as string,
  }
}

export interface StaffImporterOptions {
  /** `leaveYearStart` from `@berelax/core`, injected. See `./leave-opening.ts` on why. */
  readonly leaveYearStart: LeaveYearAnchor
  /** A label recorded on every leave movement. Never a uuid; the audit row carries the actor. */
  readonly importedBy: string
}

export interface StaffImportPlan {
  readonly rows: readonly StagedSourceRow[]
  /** Lines the plan itself refuses, by name, before the database is touched. */
  readonly rejections: readonly { readonly lineNumber: number; readonly reason: StaffRejection }[]
  /** The staff references a repeat was found on, so the report can name them. */
  readonly repeatedReferences: readonly string[]
}

/**
 * Stages one cell.
 *
 * The two numeric-looking cells go through {@link wholeOrNaN}, shared with the appointment importer
 * rather than restated: `Number('2.50')` is 2.5 and `Number('250.00')` is 250, so a decimal point in a
 * spreadsheet is how a balance comes to be a hundred times too small. H-MIG-05 found that defect in its
 * own price column and the fix is one function.
 */
export function stageStaffCell(cell: StaffCell): StagedStaffPayload {
  return {
    staffReference: cell.staffReference,
    gender: cell.gender,
    employedFrom: cell.employedFrom,
    employedUntil: cell.employedUntil,
    styleSkills: cell.styleSkills,
    languages: cell.languages,
    credentialExpiries: cell.credentialExpiries,
    leaveOpeningHundredths: wholeOrNaN(cell.leaveOpeningDayHundredths),
    leaveOpeningBasis: cell.leaveOpeningBasis,
    leaveBalanceAsAt: cell.leaveBalanceAsAt,
  }
}

/**
 * Stages every line and names the one clash a file can see: two lines about one person.
 *
 * `employee.staff_reference` is not unique in the database — 0030 left it that way — so two lines naming
 * one reference would import as two employment records, and every later read of "the therapist whose
 * reference is X" would answer whichever the planner reached first. Refused by name, both lines, so the
 * file is corrected in one pass (ADR 0065).
 */
export function planStaffImport(
  options: StaffImporterOptions,
  cells: readonly StaffCell[],
): StaffImportPlan {
  assertLeaveYearAnchor(options.leaveYearStart)

  const rows: StagedSourceRow[] = []
  const byReference = new Map<string, number[]>()
  for (const cell of cells) {
    rows.push({ lineNumber: cell.lineNumber, payload: { ...stageStaffCell(cell) } })
    const reference = cell.staffReference
    if (reference.length === 0) continue
    byReference.set(reference, [...(byReference.get(reference) ?? []), cell.lineNumber])
  }

  const rejections: { lineNumber: number; reason: StaffRejection }[] = []
  const repeatedReferences: string[] = []
  for (const [reference, lineNumbers] of [...byReference].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (lineNumbers.length < 2) continue
    repeatedReferences.push(reference)
    for (const lineNumber of lineNumbers) {
      rejections.push({ lineNumber, reason: STAFF_REJECTIONS.staffReferenceRepeated })
    }
  }
  return { rows, rejections, repeatedReferences: Object.freeze(repeatedReferences) }
}

/**
 * Applies one staged staff line.
 *
 * Two outcomes and one shape: every line produces exactly one `imported_staff_row` record, and a line
 * that was ACCEPTED produces the employment record, its credential rows and its leave movement beside
 * it. That is what `import_provenance_one_per_target` forces and what ZY196 forces, and ZY374 holds the
 * other direction: an `imported` record naming an employee with no gender cannot COMMIT.
 */
async function applyStaffRow(
  uow: UnitOfWork,
  payload: Readonly<Record<string, unknown>>,
  options: StaffImporterOptions,
): Promise<readonly ImportedEntity[]> {
  const staged = readStaged(payload)

  const quarantine = async (reason: StaffQuarantine): Promise<readonly ImportedEntity[]> => {
    const id = await recordImportedStaffRow(uow, {
      staffReference: staged.staffReference,
      outcome: 'quarantined',
      quarantineReason: reason,
    })
    return [{ table: 'imported_staff_row', id }]
  }

  // Order matters only in that each check must be reachable, and the test iterates the pair — so the
  // cheapest and most specific first, and the ones that need a read after them.
  if (staged.gender === '') return quarantine(STAFF_QUARANTINES.genderNotRecorded)
  if (staged.leaveOpeningBasis === LEAVE_BASES.calendarDay) {
    // Quarantined WHOLE rather than imported without the balance. `./leave-opening.ts` says why: an
    // employee with no opening-balance movement has a balance of zero by construction, accrual runs
    // forward from it, and nothing is marked provisional because no row was written to mark.
    return quarantine(STAFF_QUARANTINES.leaveBalanceInCalendarDays)
  }
  if (await staffReferenceIsHeld(uow.sql, staged.staffReference)) {
    return quarantine(STAFF_QUARANTINES.staffReferenceAlreadyHeld)
  }

  const importable = await readImportableDocumentTypes(uow.sql)
  const credentials = staged.credentialExpiries.map((cell) => readCredentialCell(cell))
  for (const credential of credentials) {
    if (!credential.ok) {
      throw new AppError(
        'invariant_violated',
        'A credential cell reached apply that staging should have refused. Validation happens over ' +
          'every row before anything is applied.',
      )
    }
    if (!importable.includes(credential.documentType)) {
      return quarantine(STAFF_QUARANTINES.documentTypeUnknown)
    }
  }

  const rule = await readLeaveRuleInForce(uow.sql, staged.leaveBalanceAsAt)
  if (rule === null) return quarantine(STAFF_QUARANTINES.noLeaveRuleInForce)

  const inserted = await insertImportedStaff(uow, {
    staffReference: staged.staffReference,
    gender: staged.gender as 'female' | 'male',
    employedFrom: staged.employedFrom,
    employedUntil: staged.employedUntil === '' ? null : staged.employedUntil,
    styleSkills: staged.styleSkills,
    languages: staged.languages,
    credentials: credentials.map((credential) => ({
      documentType: credential.ok ? credential.documentType : '',
      expiresOn: credential.ok ? credential.expiresOn : '',
    })),
    leaveOpeningHundredths: staged.leaveOpeningHundredths,
    leaveBalanceAsAt: staged.leaveBalanceAsAt,
    leaveYearStart: options.leaveYearStart({
      startsOnAnniversary: rule.startsOnAnniversary,
      employedFrom: staged.employedFrom,
      on: staged.leaveBalanceAsAt,
    }),
    importedBy: options.importedBy,
  })

  const id = await recordImportedStaffRow(uow, {
    staffReference: staged.staffReference,
    outcome: 'imported',
    employeeId: inserted.employeeId,
  })
  return [
    { table: 'imported_staff_row', id },
    { table: 'employee', id: inserted.employeeId },
    ...inserted.documentIds.map((documentId) => ({
      table: 'employee_document',
      id: documentId,
    })),
    { table: 'leave_movement', id: inserted.leaveMovementId },
  ]
}

/**
 * Builds the staff importer, and the plan one run shares.
 *
 * Stateful across `parse` and `apply` for H-MIG-02's and H-MIG-04's reason: the repeated-reference claim
 * is about the FILE and cannot be judged from one payload. `parse` replaces the plan rather than adding
 * to it, so two files in one process cannot resolve through each other.
 */
export function staffImporter(options: StaffImporterOptions): ImporterDefinition {
  let plan: StaffImportPlan | null = null
  const repeated = (): ReadonlySet<string> => new Set(plan?.repeatedReferences ?? [])

  return {
    name: STAFF_IMPORTER_NAME,
    version: STAFF_IMPORTER_VERSION,
    targetTables: STAFF_IMPORTER_TARGETS,
    parse: (sourceText: string): readonly StagedSourceRow[] => {
      plan = planStaffImport(options, parseStaffWorkbook(sourceText))
      return plan.rows
    },
    validate: (payload: Readonly<Record<string, unknown>>): RowVerdict => {
      const verdict = validateStagedStaff(payload)
      if (!verdict.ok) return verdict
      // The file-scoped claim, recognised from the payload's own value: the framework hands `validate` a
      // payload and no line number (H-MIG-01's shape), and the staff reference IS what the claim is
      // about, so no composite key is needed here as it was for a visit.
      if (!repeated().has(payload['staffReference'] as string)) return { ok: true }
      return { ok: false, reason: STAFF_REJECTIONS.staffReferenceRepeated }
    },
    apply: (uow: UnitOfWork, payload: Readonly<Record<string, unknown>>) =>
      applyStaffRow(uow, payload, options),
  }
}

/**
 * What an import of this file WOULD do, without a database and without staging anything.
 *
 * The forecast a person wants BEFORE deciding to import: how many lines there are, which references
 * repeat, and which lines the file's own rules refuse. It cannot forecast the quarantines, and that is
 * honest rather than a limitation — every one of them is a question about this database (is the gender
 * cell filled in, does somebody already hold the reference, is the document type one the regulatory
 * profile knows) and answering them here would need the connection this function does not take.
 */
export function planStaffFile(options: StaffImporterOptions, sourceText: string): StaffImportPlan {
  return planStaffImport(options, parseStaffWorkbook(sourceText))
}

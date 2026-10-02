import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The write path and the one translator for a reconstructed staff file (H-MIG-06, migration 0131).
 *
 * `packages/migration` may import this package and `@berelax/shared` and nothing else first-party, so
 * every statement this import issues against `employee`, `employee_skill`, `employee_language`,
 * `employee_document`, `leave_movement` and `imported_staff_row` is here — the arrangement
 * `import-contacts.ts`, `import-package-liability.ts` and `import-appointments.ts` already hold.
 *
 * ## There is no cell, and no column here, for a bank account or an identity number
 *
 * The staging ledger keeps `import_row.payload` for ever and no erasure reaches it (ADR 0072,
 * Y9-import-ledger). An IBAN in a workbook is therefore an IBAN in that ledger permanently — strictly
 * worse than the plaintext column `employee_bank_detail` was built to avoid, because that column does not
 * exist and this one could not be removed afterwards. The sealed fields are entered through the HR
 * screens, which seal them under 0102's envelope scheme, and the schema already refuses a plaintext:
 * `employee_document_identity_number_is_encrypted` and `employee_document_visa_number_is_encrypted`
 * refuse a `reference` on an identity type at all.
 *
 * What the import DOES write for a credential is its TYPE and its EXPIRY, which is the half that gates
 * availability — `readEligibleTherapists` excludes a therapist whose mandatory document has lapsed by
 * `trading_date`, and `readReassignmentCandidates` is what then finds their future appointments. A
 * document number is not in that path at all.
 *
 * ## Nothing is inferred
 *
 * A line with no gender cell is QUARANTINED, never defaulted. `employee.gender` is nullable because 0030
 * refused to have a migration "invent nineteen people's genders", and gender is a hard constraint on
 * assignment (B-AVAIL-05) — so a guessed one decides who may treat whom, and a null one quietly makes
 * that therapist unassignable to every gender-specified request while looking like an ordinary row.
 * ZY374 is what makes the quarantine unforgeable.
 */

/** The SQLSTATEs `packages/db/migrations/0131_staff_import.sql` raises. */
export const STAFF_IMPORT_SQLSTATE = {
  /** A leave opening balance was stated in calendar days rather than confirmed trading-session days. */
  leaveOpeningBalanceInCalendarDays: 'ZY371',
  /** A leave opening balance of zero was not marked provisional. */
  leaveOpeningBalanceOfZeroIsNotAnAnswer: 'ZY372',
  /** An imported-staff record was updated or deleted. */
  importedStaffRowImmutable: 'ZY373',
  /** An imported-staff record names an employee with no recorded gender. Raised at COMMIT. */
  importedStaffHasNoGender: 'ZY374',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from 0131 into an `AppError`, or `null` for anything else.
 *
 * The match is on SQLSTATE alone, for `refusals.ts`'s reason: a reworded message would silently stop
 * translating, after which the caller that reads "this balance is in the wrong unit" as an unknown
 * failure is the caller that retries the import.
 *
 * The KINDS are chosen by what the caller has to go and do:
 *
 *   - `validation` for ZY371 and ZY372 — a cell in the file being imported is wrong or missing, and it
 *     is a cell somebody can go and look at.
 *   - `forbidden` for ZY373 — the statement will never be permitted, for any caller, with any data.
 *   - `invariant_violated` for ZY374 — this code, not the person running the import, wrote a record
 *     naming an employee with no gender. A validation failure would send whoever reads it to the
 *     spreadsheet, which is the one place the defect is not: the importer is supposed to have
 *     quarantined that line.
 */
export function staffImportError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case STAFF_IMPORT_SQLSTATE.leaveOpeningBalanceInCalendarDays:
    case STAFF_IMPORT_SQLSTATE.leaveOpeningBalanceOfZeroIsNotAnAnswer:
      return new AppError('validation', message, { details })
    case STAFF_IMPORT_SQLSTATE.importedStaffRowImmutable:
      return new AppError('forbidden', message, { details })
    case STAFF_IMPORT_SQLSTATE.importedStaffHasNoGender:
      return new AppError('invariant_violated', message, { details })
    default:
      return null
  }
}

export const isLeaveBalanceBasisRefusal = (err: unknown): boolean =>
  sqlState(err) === STAFF_IMPORT_SQLSTATE.leaveOpeningBalanceInCalendarDays

/**
 * Every reason a well-formed staff line cannot be accepted, as a closed vocabulary of short lower-case
 * names matching `imported_staff_row.quarantine_reason`'s CHECK.
 *
 * They are QUARANTINES and not rejections, and the split is ADR 0065's: a rejection is about the row's
 * own text and fails the whole file, because a malformed staff file was filled in wrongly. A quarantine
 * is about something that CANNOT BE INFERRED — an unrecorded gender, a leave figure whose unit nobody
 * has confirmed, a reference somebody else already holds — and refusing the file for one of those would
 * mean no therapist could be imported until every open question about every therapist was answered.
 */
export const STAFF_QUARANTINES = {
  /** No gender cell. Never defaulted: gender decides who may treat whom (B-AVAIL-05). */
  genderNotRecorded: 'gender_not_recorded',
  /** An employee already holds this staff reference, so the line names somebody who is already here. */
  staffReferenceAlreadyHeld: 'staff_reference_already_held',
  /** The leave opening balance is stated in calendar days. See `assert_leave_opening_balance_is_sound`. */
  leaveBalanceInCalendarDays: 'leave_balance_in_calendar_days',
  /** The line names a document type no regulatory profile knows about. */
  documentTypeUnknown: 'document_type_unknown',
  /** No leave entitlement rule governs the date the balance is as at, so no leave year can be anchored. */
  noLeaveRuleInForce: 'no_leave_rule_in_force',
} as const

export type StaffQuarantine = (typeof STAFF_QUARANTINES)[keyof typeof STAFF_QUARANTINES]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const STAFF_QUARANTINE_REASONS: readonly StaffQuarantine[] = Object.freeze(
  Object.values(STAFF_QUARANTINES),
)

/**
 * What `leave_movement.source_note` records for an imported opening balance.
 *
 * A constant and not the file's path: `source_note` is NOT NULL for an opening balance and must not be
 * placeholder text, and the file and line already live once each in `import_staging.import_provenance`
 * (ADR 0061 — provenance is a reference, never a copy). A second copy of the path here would be the
 * statement that drifts, and it would drift silently because nothing joins the two.
 */
export const IMPORTED_LEAVE_SOURCE_NOTE =
  'Reconstructed staff file imported by H-MIG-06. The file and the line are in ' +
  'import_staging.import_provenance, resolved through this movement.'

/** The open question a zero opening balance names, which ZY372 requires it to have. */
export const ZERO_LEAVE_BALANCE_QUESTION = 'Y8-leave'

export interface StaffCredential {
  readonly documentType: string
  /** The date it lapses. A credential with no expiry is not importable — see `insertImportedStaff`. */
  readonly expiresOn: string
}

export interface ImportedStaffInput {
  readonly staffReference: string
  readonly gender: 'female' | 'male'
  readonly employedFrom: string
  readonly employedUntil: string | null
  readonly styleSkills: readonly string[]
  readonly languages: readonly string[]
  readonly credentials: readonly StaffCredential[]
  /** Signed day-hundredths. 250 is 2.5 days, which is the unit the whole leave ledger is in. */
  readonly leaveOpeningHundredths: number
  /** The date the balance was measured, and the movement's `occurred_on`. */
  readonly leaveBalanceAsAt: string
  /** From `leaveYearStart()` in `@berelax/core`, computed by the caller. See the importer on why. */
  readonly leaveYearStart: string
  /** A label, never a uuid: the audit row written in the same transaction carries the actor. */
  readonly importedBy: string
}

export interface InsertedImportedStaff {
  readonly employeeId: string
  readonly leaveMovementId: string
  readonly documentIds: readonly string[]
}

/**
 * The document types the regulatory profile in force makes mandatory for a therapist.
 *
 * Read from `regulatory_profile_current` — the VIEW, never the table (0004) — and it THROWS when no
 * profile is in force, for `readMandatoryDocumentTypes`'s stated reason: defaulting to an empty list
 * would be a credential gate that silently permits every row.
 */
export async function readImportableDocumentTypes(sql: Sql): Promise<readonly string[]> {
  const rows = await sql<{ mandatory: string[] }[]>`
    select mandatory_therapist_document_types as mandatory from regulatory_profile_current
  `
  const mandatory = rows[0]?.mandatory
  if (mandatory === undefined) {
    throw new AppError(
      'invariant_violated',
      'No regulatory profile is in force, so which therapist credentials are mandatory is unknown. An ' +
        'import that defaulted to an empty list would write expiry dates nothing gates availability on, ' +
        'and the therapists would look bookable.',
    )
  }
  return mandatory
}

/** Does any employee already hold this staff reference? */
export async function staffReferenceIsHeld(sql: Sql, staffReference: string): Promise<boolean> {
  const rows = await sql<{ held: boolean }[]>`
    select true as held from employee where staff_reference = ${staffReference}
  `
  return rows[0]?.held === true
}

/**
 * The leave entitlement rule in force on a date, as the fields `leaveYearStart` needs.
 *
 * The latest version at or before the date, which is `leaveRulesFor`'s rule stated in SQL for one
 * version rather than re-implemented: this returns the ROW and the caller applies `@berelax/core`'s
 * function to it, so the policy is read here and interpreted there.
 */
export async function readLeaveRuleInForce(
  sql: Sql,
  on: string,
): Promise<{ readonly effectiveFrom: string; readonly startsOnAnniversary: boolean } | null> {
  const rows = await sql<{ effectiveFrom: string; startsOnAnniversary: boolean }[]>`
    select effective_from::text as "effectiveFrom",
           leave_year_starts_on_anniversary as "startsOnAnniversary"
      from leave_entitlement_rule
     where effective_from <= ${on}::date
     order by effective_from desc
     limit 1
  `
  return rows[0] ?? null
}

/**
 * Inserts one reconstructed employment record: the employee, their skills, their languages, their
 * credential expiries and their leave opening balance.
 *
 * `display_name` is NULL and `photo_consent` false, and neither is a parameter. ADR 0020 and decision 23:
 * a name is set by an admin, a photography consent is recorded with who recorded it and when, and
 * `employee.is_publishable` is GENERATED from both — so nothing this import writes can publish a
 * therapist, and the acceptance line is a property of the schema rather than a promise of this function.
 *
 * `is_provisional` on the employment record is TRUE with `Y8-staff` named, because the handover supplies
 * the headcount and nothing else; and the leave movement is provisional exactly when its figure is zero,
 * which ZY372 requires and which is the difference between "the owner says it is zero" and "nobody has
 * said".
 *
 * The leave year start is a PARAMETER and not computed here. `leaveYearStart()` in `@berelax/core` is the
 * one implementation of that policy, `leave_movement.leaveYearStart`'s own comment says re-deriving it in
 * SQL "would be a second reading of that policy which disagrees for every employee not engaged on 1
 * January", and `packages/db` may not import `packages/core` — so the caller computes it and hands it
 * over, which is the same seam the transition decider crosses.
 */
export async function insertImportedStaff(
  uow: UnitOfWork,
  input: ImportedStaffInput,
): Promise<InsertedImportedStaff> {
  const employees = await uow.sql<{ id: string }[]>`
    insert into employee (
      staff_reference, gender, employed_from, employed_until, is_provisional, provisional_note,
      open_question_id
    ) values (
      ${input.staffReference}, ${input.gender}::employee_gender, ${input.employedFrom}::date,
      ${input.employedUntil}::date, true,
      'Imported from the reconstructed staff file. The employment record is the headcount and the facts '
        || 'the file carried; no wage, no contract type and no sealed identity field is imported.',
      'Y8-staff'
    )
    returning id
  `
  const employeeId = employees[0]?.id
  if (employeeId === undefined) {
    throw new AppError(
      'invariant_violated',
      'The employee insert for a reconstructed staff line returned no row, which cannot happen for an ' +
        'INSERT ... RETURNING that did not raise.',
    )
  }

  for (const skill of input.styleSkills) {
    await uow.sql`
      insert into employee_skill (employee_id, skill, is_provisional, open_question_id)
      values (${employeeId}::uuid, ${skill}::therapist_skill, true, 'Y8-staff')
    `
  }
  for (const language of input.languages) {
    await uow.sql`
      insert into employee_language (employee_id, language, is_provisional, open_question_id)
      values (${employeeId}::uuid, ${language}::staff_language, true, 'Y8-staff')
    `
  }

  const documentIds: string[] = []
  for (const credential of input.credentials) {
    // `issuing_authority` is left NULL, deliberately: nothing in the handover names the authority that
    // issued any of these, and `employee_document_issuing_authority_not_placeholder` would refuse a
    // marker — so the honest value is the absent one (brief rule 15). `reference` is left NULL too, and
    // for an identity type the schema refuses one outright.
    const rows = await uow.sql<{ id: string }[]>`
      insert into employee_document (employee_id, document_type, expires_on)
      values (
        ${employeeId}::uuid, ${credential.documentType}::employee_document_type,
        ${credential.expiresOn}::date
      )
      returning id
    `
    const id = rows[0]?.id
    if (id === undefined) {
      throw new AppError(
        'invariant_violated',
        `The employee_document insert for ${credential.documentType} returned no row.`,
      )
    }
    documentIds.push(id)
  }

  const isZero = input.leaveOpeningHundredths === 0
  const movements = await uow.sql<{ id: string }[]>`
    insert into leave_movement (
      employee_id, kind, hundredths, occurred_on, leave_year_start, created_by, source_note,
      day_basis, is_provisional, provisional_note, open_question_id
    ) values (
      ${employeeId}::uuid, 'opening_balance', ${input.leaveOpeningHundredths},
      ${input.leaveBalanceAsAt}::date, ${input.leaveYearStart}::date, ${input.importedBy},
      ${IMPORTED_LEAVE_SOURCE_NOTE},
      'trading_session_day',
      ${isZero},
      ${
        isZero
          ? 'Imported as zero. docs/11 section 7 says the accrual engine needs a real opening balance ' +
            'rather than a zero, so this is the absence of an answer and not an answer.'
          : null
      },
      ${isZero ? ZERO_LEAVE_BALANCE_QUESTION : null}
    )
    returning id
  `
  const leaveMovementId = movements[0]?.id
  if (leaveMovementId === undefined) {
    throw new AppError(
      'invariant_violated',
      'The leave_movement insert for a reconstructed opening balance returned no row.',
    )
  }

  return { employeeId, leaveMovementId, documentIds }
}

export interface ImportedStaffRowInput {
  readonly staffReference: string
  readonly outcome: 'imported' | 'quarantined'
  /** Required for `quarantined` and refused for `imported`, by CHECK. */
  readonly quarantineReason?: StaffQuarantine | null
  /** Required for `imported` and refused for `quarantined`, by CHECK. */
  readonly employeeId?: string | null
}

/**
 * Records what one line of a reconstructed staff file became.
 *
 * One row per staged line, always — 0119's, 0121's and 0130's arrangement, and the framework's reason: a
 * staged row that reaches `applied` having recorded no entity cannot COMMIT (ZY196), and the line that
 * recorded nothing is precisely the one somebody has to go and look at.
 *
 * Nothing is audited here. The framework already writes one `migration.row.imported` audit row per
 * staged row naming every entity that row produced, and `imported_staff_row.outcome` is the column ZY374
 * holds to those same facts.
 */
export async function recordImportedStaffRow(
  uow: UnitOfWork,
  input: ImportedStaffRowInput,
): Promise<string> {
  const reason = input.quarantineReason ?? null
  const employeeId = input.employeeId ?? null
  const rows = await uow.sql<{ id: string }[]>`
    insert into imported_staff_row (staff_reference, outcome, quarantine_reason, employee_id)
    values (${input.staffReference}, ${input.outcome}, ${reason}, ${employeeId}::uuid)
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    throw new AppError(
      'invariant_violated',
      'The imported-staff insert returned no row, which cannot happen for an INSERT ... RETURNING that ' +
        'did not raise. Treated as a failure rather than ignored: the alternative is an applied row ' +
        'whose provenance nobody holds an id for.',
    )
  }
  return id
}

export interface ImportedStaffCounts {
  readonly imported: number
  readonly quarantined: number
}

/**
 * The counts an import report is read off.
 *
 * Counted in SQL rather than by reading rows into the process, for `settings-store.itest.ts`'s recorded
 * reason: this table only grows, so a capped reader would pin both sides of a delta at its limit.
 */
export async function readImportedStaffCounts(sql: Sql): Promise<ImportedStaffCounts> {
  const rows = await sql<{ imported: string; quarantined: string }[]>`
    select count(*) filter (where outcome = 'imported')::text    as imported,
           count(*) filter (where outcome = 'quarantined')::text as quarantined
      from imported_staff_row
  `
  const row = rows[0]
  return {
    imported: Number(row?.imported ?? '0'),
    quarantined: Number(row?.quarantined ?? '0'),
  }
}

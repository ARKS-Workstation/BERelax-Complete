import {
  AppError,
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  credentialExpiringSoonDaysSchema,
  PROVISIONAL_EXPIRING_SOON_DAYS,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The credential registry's read side: the policy in force, and what an employee holds.
 *
 * The judgement is `packages/core/src/hr/credentials.ts`'s and stays there — `packages/db` must never
 * import `packages/core` (the dependency runs the other way), which is why this module returns **rows
 * and a policy** and never a status. `packages/fixtures/src/hr-credentials.itest.ts` is the one place
 * that may import both and is where the pair is asserted to work.
 *
 * ## Why the policy is one read and not three
 *
 * `mandatory_therapist_document_types` and `non_expiring_document_types` are two columns of one
 * `regulatory_profile` row, and the table is append-only and versioned (ADR 0008): two separate reads
 * can land either side of a supersede and describe two different profiles, which would produce an answer
 * no version ever had. The window is an `app_setting` and cannot be read in the same statement, so it is
 * fetched alongside and the profile's `version` is returned with the policy — a caller that needs to say
 * which profile it judged against has the number rather than having to guess.
 */

/** The `app_setting` key and the provisional default, re-exported so a caller needs one import. */
export { CREDENTIAL_EXPIRING_SOON_SETTING_KEY, PROVISIONAL_EXPIRING_SOON_DAYS }

/**
 * The credential policy in force. Structurally `CredentialPolicy` in `@berelax/core`, plus the version.
 *
 * `readonly string[]` and not a union of document types, for the reason
 * `readMandatoryDocumentTypes` gives: the mandatory list is DATA, so a label this build has not been
 * taught must flow through rather than fail to typecheck. The database constrains both arrays to the
 * `employee_document_type` enum.
 */
export interface CredentialPolicyRead {
  readonly mandatoryTypes: readonly string[]
  readonly nonExpiringTypes: readonly string[]
  readonly expiringSoonDays: number
  /** `regulatory_profile.version` the two arrays came from, so an answer can name the row it used. */
  readonly profileVersion: number
}

/** One row of `employee_document`, reduced to what a status decision needs. */
export interface EmployeeCredentialRow {
  readonly employeeId: string
  readonly documentType: string
  /** Null exactly for a type the profile declares non-expiring (0054's ZS006 trigger). */
  readonly expiresOn: string | null
  readonly issuedOn: string | null
  readonly issuingAuthority: string | null
  /** True when the document's number is sealed. **Never the number itself**; see the note below. */
  readonly hasSealedNumber: boolean
}

/**
 * The whole credential policy, from the profile in force and the settings row.
 *
 * **Throws** when there is no profile, exactly as `readMandatoryDocumentTypes` does and for the same
 * reason: 0004 seeds one precisely so the system is never without it, so an empty result means the
 * migration did not run or somebody stamped `superseded_at` on every row. Defaulting to empty arrays
 * here would be a credential gate that silently permits every therapist — which is the one outcome worse
 * than no gate, because it looks like a gate.
 *
 * The window is the opposite case and is deliberately NOT a throw. An unseeded `app_setting` key falls
 * back to its declared default, which is how `readSetting` behaves for every other key and is what makes
 * a fresh database behave like a seeded one; a stored value that fails its schema also falls back,
 * because a row written before the schema existed must not stop a screen rendering. Both are the same
 * argument `reviewCoolingOffHours` makes for re-validating on the READ path.
 */
export async function readCredentialPolicy(sql: Sql): Promise<CredentialPolicyRead> {
  const [profile] = await sql<
    {
      version: number
      mandatory_therapist_document_types: string[]
      non_expiring_document_types: string[]
    }[]
  >`
    select version, mandatory_therapist_document_types, non_expiring_document_types
      from regulatory_profile_current
  `
  if (profile === undefined) {
    throw new AppError(
      'invariant_violated',
      'No regulatory profile is in force, so which credentials are mandatory and which types do not ' +
        'expire is unknown. 0004 seeds one; an empty result means the profile was superseded without a ' +
        'replacement. An empty policy would be a credential gate that permits everybody.',
    )
  }
  const [setting] = await sql<{ value: unknown }[]>`
    select value from app_setting where key = ${CREDENTIAL_EXPIRING_SOON_SETTING_KEY}
  `
  const parsed = credentialExpiringSoonDaysSchema.safeParse(setting?.value)
  return {
    mandatoryTypes: profile.mandatory_therapist_document_types,
    nonExpiringTypes: profile.non_expiring_document_types,
    expiringSoonDays: parsed.success ? parsed.data : PROVISIONAL_EXPIRING_SOON_DAYS,
    profileVersion: Number(profile.version),
  }
}

/** An employee a credential report is about. The internal handle, never a person's name. */
export interface CredentialSubjectRow {
  readonly employeeId: string
  readonly reference: string
}

/**
 * The employees a credential report covers: currently employed, by internal handle.
 *
 * `employed_until` is honoured — a leaver's credentials are not a live compliance question and listing
 * them would make the screen's "not eligible" count grow for ever — but the rows are NOT deleted and the
 * documents stay on file, because a credential check that happened is evidence.
 *
 * `staff_reference` and never `display_name`. Nineteen of these people have no name recorded (Y8-staff)
 * and the ones that will have it hold it behind ADR 0020's publication guard; a screen keyed on a
 * nullable name is a screen that reads "null" for most of the roster.
 *
 * Bounded by `limit`, and the caller has to choose one. An unbounded admin list is a page that gets
 * slower every month and a screenshot that changes size on every run.
 */
export async function readCredentialSubjects(
  sql: Sql,
  args: { readonly limit: number; readonly asOf: string },
): Promise<readonly CredentialSubjectRow[]> {
  return sql<CredentialSubjectRow[]>`
    select id as "employeeId", staff_reference as reference
      from employee
     where employed_from <= ${args.asOf}::date
       and (employed_until is null or employed_until >= ${args.asOf}::date)
     order by staff_reference
     limit ${args.limit}
  `
}

/**
 * Every document on file for the given employees, newest expiry first.
 *
 * **No document number, sealed or otherwise, and no key.** `hasSealedNumber` is a boolean over
 * `number_ct is not null`, which is the only thing about that column this layer may know: the seal and
 * the open live in `packages/hr/src/staff-secret.ts`, the only module holding the `STAFF_PII_KEK`, and
 * every decrypt goes through the audited repository beside it. A screen that lists credentials needs to
 * show whether a number was recorded and must never show the number, so the boolean is the whole of
 * what it gets — the same rule `packages/db/src/schema/hr.ts` states for its own file.
 *
 * Every row is returned rather than the latest per type, and that is not laziness. A renewal is a NEW
 * ROW (`employee_document_one_row_per_expiry`), so the history is the evidence of what was valid last
 * March; reducing to the latest here would make "which licence covered the appointment on the 18th"
 * unanswerable from this read. `credentialStatusFor` takes the latest of what it is given.
 *
 * `employeeIds` is required and may not be empty. `null` for "everybody" is the shape
 * `therapistPoolCtes` uses, and the opposite choice is made here deliberately: this read is per employee
 * on a screen and per employee in a sweep, and an accidental unbounded read of every credential in the
 * business is not a default worth having.
 */
export async function readEmployeeCredentials(
  sql: Sql,
  employeeIds: readonly string[],
): Promise<readonly EmployeeCredentialRow[]> {
  if (employeeIds.length === 0) return []
  return sql<EmployeeCredentialRow[]>`
    select employee_id                as "employeeId",
           document_type::text        as "documentType",
           expires_on::text           as "expiresOn",
           issued_on::text            as "issuedOn",
           issuing_authority          as "issuingAuthority",
           number_ct is not null      as "hasSealedNumber"
      from employee_document
     where employee_id = any(${[...employeeIds]}::uuid[])
     -- "nulls first" on the expiry: a non-expiring record has no date, and the default nulls-last would
     -- put the one document that never lapses at the bottom of the list on the screen.
     order by employee_id, document_type, expires_on desc nulls first
  `
}

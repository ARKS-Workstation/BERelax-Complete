import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * `credential_expiry_notice` (0163): the documents a pass has to judge, and the notice it records.
 *
 * ## Why this reader exists beside `readEmployeeCredentials`
 *
 * That one returns a credential as the EVALUATOR wants it — type and expiry, no row identity — because
 * `credentialStatusFor` takes the latest expiry per type and the individual row is not the unit of its
 * answer. A notice IS keyed on the row: `credential_expiry_notice_once` is
 * `(employee_id, employee_document_id, window_days)`, so the pass needs the document's id, and a reader
 * returning a type-level view could not supply one.
 *
 * The two are not a second statement of one fact: this returns rows, that returns a projection of rows for
 * one function's argument shape, and the evaluator is still the only thing that decides a STATUS. The pass
 * joins the two — see `apps/worker/src/jobs/credential-expiry-notice.ts`.
 */

export interface ExpiringCandidateRow {
  readonly employeeDocumentId: string
  readonly employeeId: string
  readonly staffReference: string
  readonly documentType: string
  /** Null exactly for a type the profile declares non-expiring (0054's ZS006 trigger). */
  readonly expiresOn: string | null
}

/**
 * Every document on the file of an employee who is still employed on `asOfDate`.
 *
 * Bounded by employment and by nothing else — no date arithmetic on the expiry, deliberately. The window
 * is the EVALUATOR's (`credentialStatusFor` in `@berelax/core`), and a `where expires_on <= now() +
 * interval` here would be a second reading of it: the SQL would compare calendar dates while the evaluator
 * compares wall-clock dates in the policy's zone, and the two disagree for two hours of every trading day.
 * The acceptance line says the notices are "generated from the P-HR-02 evaluator at the configured window",
 * and this reader is what makes that literally true rather than approximately.
 *
 * `employed_until` null means current; a date means the employment ends then. Somebody who has left is
 * excluded, because a warning about a lapsing licence is a request to bring a renewal in.
 */
export async function readExpiringCredentialCandidates(
  sql: Sql,
  args: { readonly asOfDate: string },
): Promise<readonly ExpiringCandidateRow[]> {
  return sql<ExpiringCandidateRow[]>`
    select d.id::text            as "employeeDocumentId",
           d.employee_id::text   as "employeeId",
           e.staff_reference     as "staffReference",
           d.document_type::text as "documentType",
           d.expires_on::text    as "expiresOn"
      from employee_document d
      join employee e on e.id = d.employee_id
     where e.employed_from <= ${args.asOfDate}::date
       and (e.employed_until is null or e.employed_until >= ${args.asOfDate}::date)
     order by e.staff_reference, d.document_type, d.expires_on desc nulls first
  `
}

export interface CredentialExpiryNoticeRow {
  readonly id: string
  readonly employeeId: string
  readonly employeeDocumentId: string
  readonly windowDays: number
  readonly expiresOn: string
  readonly detectedOn: string
  readonly templateKey: string
  readonly outcome: string
  readonly skipReason: string | null
  readonly messageId: string | null
}

export interface RecordCredentialExpiryNoticeInput {
  readonly employeeId: string
  readonly employeeDocumentId: string
  readonly windowDays: number
  readonly expiresOn: string
  readonly detectedOn: string
  readonly templateKey: string
  readonly outcome: 'sent' | 'skipped'
  readonly skipReason?: string
  readonly messageId?: string
  readonly createdBy: string
}

/**
 * Records one notice, or returns null when one already exists for that (employee, document, window).
 *
 * **`on conflict do nothing`, and the null return is the idempotency.** A second pass over the same
 * window gets null, so it sends nothing and writes no audit row — the acceptance line's "a second run
 * sends nothing" is this branch, and `apps/worker/src/jobs/credential-expiry-notice.itest.ts` proves it
 * against the fake SMS outbox rather than against a count.
 *
 * It takes a `UnitOfWork` so the notice and the audit row commit together. A notice committed without its
 * audit row is a message somebody received with nothing recording that the system decided to send it.
 */
export async function recordCredentialExpiryNotice(
  uow: UnitOfWork,
  input: RecordCredentialExpiryNoticeInput,
): Promise<CredentialExpiryNoticeRow | null> {
  if (input.outcome === 'skipped' && input.skipReason === undefined) {
    throw new AppError(
      'validation',
      'A skipped credential expiry notice must name a reason. `credential_expiry_notice_skip_has_a_reason` ' +
        'refuses it at the database; this says so before the statement, because the constraint name is ' +
        'not a sentence an operator can act on.',
    )
  }
  const rows = await uow.sql<CredentialExpiryNoticeRow[]>`
    insert into credential_expiry_notice
      (employee_id, employee_document_id, window_days, expires_on, detected_on, template_key,
       outcome, skip_reason, message_id, created_by)
    values (
      ${input.employeeId}::uuid,
      ${input.employeeDocumentId}::uuid,
      ${input.windowDays}::integer,
      ${input.expiresOn}::date,
      ${input.detectedOn}::date,
      ${input.templateKey},
      ${input.outcome},
      ${input.skipReason ?? null},
      ${input.messageId ?? null},
      ${input.createdBy}
    )
    on conflict (employee_id, employee_document_id, window_days) do nothing
    returning id::text                   as "id",
              employee_id::text          as "employeeId",
              employee_document_id::text as "employeeDocumentId",
              window_days                as "windowDays",
              expires_on::text           as "expiresOn",
              detected_on::text          as "detectedOn",
              template_key               as "templateKey",
              outcome                    as "outcome",
              skip_reason                as "skipReason",
              message_id                 as "messageId"
  `
  return rows[0] ?? null
}

/** Every notice on one employee's file, newest detection first. The whole history: the table is append-only. */
export async function readCredentialExpiryNotices(
  sql: Sql,
  args: { readonly employeeId: string },
): Promise<readonly CredentialExpiryNoticeRow[]> {
  return sql<CredentialExpiryNoticeRow[]>`
    select id::text                   as "id",
           employee_id::text          as "employeeId",
           employee_document_id::text as "employeeDocumentId",
           window_days                as "windowDays",
           expires_on::text           as "expiresOn",
           detected_on::text          as "detectedOn",
           template_key               as "templateKey",
           outcome                    as "outcome",
           skip_reason                as "skipReason",
           message_id                 as "messageId"
      from credential_expiry_notice
     where employee_id = ${args.employeeId}::uuid
     order by detected_on desc, id desc
  `
}

import type { Kek } from '@berelax/clinical'
import {
  assertCan,
  assertCanReadFieldGroup,
  assertStaffReadPurpose,
  type FieldGroup,
  projectEmployeeRecord,
  type Role,
  type StaffReadPurpose,
} from '@berelax/core'
import { type Actor, AuditWriter, type RequestContext, type Sql, withUnitOfWork } from '@berelax/db'
import { AppError } from '@berelax/shared'
import {
  type BankDetail,
  openBankDetail,
  openDocumentNumber,
  type SealedStaffSecret,
  type StaffSecretBinding,
  sealBankDetail,
  sealDocumentNumber,
} from './staff-secret.ts'

/**
 * Reading and writing staff PII, with the audit row and the field-group check in the same place as the
 * decrypt.
 *
 * ## Why the audit row is written HERE and not by the caller
 *
 * docs/04 §7 requires every read of a bank or identity field to be audited, and docs/06 D4 says why:
 * "the insider threat is the realistic breach. A therapist leaving with the client list is more likely
 * than an external attacker." A rule that depends on each caller remembering to log is a rule that holds
 * until the third caller. So the decrypt is not reachable without the audit: there is no exported
 * function in this module that returns a plaintext without writing an `audit_event` first.
 *
 * ## The order is: authorise, audit, decrypt — and the order is the decision
 *
 * The audit row is written **before** the decrypt is attempted, in its own statement and not inside a
 * transaction the caller controls. Two consequences, both wanted:
 *
 *   - a decrypt that FAILS is still recorded. An attempted read of a bank account under a key that no
 *     longer opens it is the single most interesting line in the table, and recording after the fact
 *     loses exactly those.
 *   - the audit row count equals the number of times a decrypt was attempted, which is the property
 *     `employee.itest.ts` asserts as a delta. Recording afterwards would make the count equal the number
 *     of SUCCESSFUL reads, and the difference between those two numbers is the incident.
 *
 * A refusal writes `operation = 'denied'` rather than nothing, for the same reason: "who tried" is the
 * question an insider-threat trail is asked, and a refused attempt that leaves no trace answers it with
 * silence. The denied rows carry a different `operation`, so they do not disturb the read count.
 *
 * ## No key is stored in this module
 *
 * The `Kek` is a parameter. Nothing here reads `process.env`, so the environment name lives in exactly
 * one place (`packages/config/src/env.ts`, classified in `build/secret-inventory.json`) and a test can
 * drive this with a key it generated in memory.
 */

/** What every audited operation here needs to know about its caller. */
export interface StaffAccess {
  readonly role: Role
  readonly actor: Actor
  readonly context?: RequestContext
}

export interface EmployeeRepository {
  /**
   * The employment record, projected to what the role may read.
   *
   * Deny by default in both directions: a field the role's groups do not cover is dropped, and so is a
   * field `EMPLOYEE_FIELD_GROUPS` does not classify. Reading the record is NOT an audited sensitive
   * read — the wage columns come back only for a role holding `employee.salary`, and auditing every
   * rota screen would bury the bank reads this table exists to surface.
   */
  readEmployee(
    access: StaffAccess,
    employeeId: string,
  ): Promise<{
    readonly visible: Record<string, unknown>
    readonly refused: readonly { readonly field: string; readonly reason: string }[]
  } | null>

  /** Files a bank account, superseding the current one in the same transaction. */
  writeBankDetail(
    access: StaffAccess,
    args: {
      readonly employeeId: string
      readonly detail: BankDetail
      readonly label?: string
    },
  ): Promise<{ readonly bankDetailId: string; readonly supersededId: string | null }>

  /** Decrypts the current bank account. Writes exactly one `operation = 'read'` audit row. */
  readBankDetail(
    access: StaffAccess,
    args: { readonly employeeId: string; readonly purpose: StaffReadPurpose | string },
  ): Promise<BankDetail | null>

  /** Files a document number against an existing `employee_document` row. */
  writeDocumentNumber(
    access: StaffAccess,
    args: {
      readonly employeeId: string
      readonly documentId: string
      readonly number: string
    },
  ): Promise<void>

  /** Decrypts a document number. Writes exactly one `operation = 'read'` audit row. */
  readDocumentNumber(
    access: StaffAccess,
    args: {
      readonly employeeId: string
      readonly documentId: string
      readonly purpose: StaffReadPurpose | string
    },
  ): Promise<string | null>
}

interface SealedRow {
  readonly id: string
  readonly ct: Buffer
  readonly nonce: Buffer
  readonly wrapped_key: Buffer
  readonly kid: string
  readonly aad_fp: string
}

const toSealed = (row: SealedRow): SealedStaffSecret => ({
  ct: row.ct,
  nonce: row.nonce,
  wrappedKey: row.wrapped_key,
  kid: row.kid,
  aadFp: row.aad_fp,
})

export function createEmployeeRepository(sql: Sql, kek: Kek): EmployeeRepository {
  const auditFor = (access: StaffAccess) => new AuditWriter(sql, access.actor, access.context ?? {})

  /**
   * The authorisation gate every sensitive operation passes through.
   *
   * Writes a `denied` audit row before rethrowing, so a refused attempt is evidence rather than a 403
   * somebody reads in an application log that is rotated in a week.
   */
  const authorise = async (
    access: StaffAccess,
    group: FieldGroup,
    args: { readonly action: string; readonly entityType: string; readonly entityId: string },
  ): Promise<void> => {
    try {
      assertCanReadFieldGroup(access.role, group)
    } catch (error) {
      await auditFor(access).record({
        action: args.action,
        entityType: args.entityType,
        entityId: args.entityId,
        operation: 'denied',
        after: { role: access.role, fieldGroup: group },
      })
      throw error
    }
  }

  /** One audit row, written before the decrypt, naming who, what, and why. */
  const recordSensitiveRead = async (
    access: StaffAccess,
    args: {
      readonly action: string
      readonly entityType: string
      /**
       * The EMPLOYEE, not the row.
       *
       * The question asked of this table is "who read whose bank details", and a superseded
       * `employee_bank_detail` id answers a question nobody asks. The row id goes in `after_state`, so
       * both are recoverable and only one is the index.
       */
      readonly employeeId: string
      readonly purpose: StaffReadPurpose
      readonly detail: Record<string, unknown>
    },
  ): Promise<void> => {
    await auditFor(access).record({
      action: args.action,
      entityType: args.entityType,
      entityId: args.employeeId,
      operation: 'read',
      after: { purpose: args.purpose, role: access.role, ...args.detail },
    })
  }

  return {
    readEmployee: async (access, employeeId) => {
      assertCan(access.role, 'employee:read')
      const [row] = await sql<Record<string, unknown>[]>`
        select id,
               staff_reference          as "staffReference",
               display_name             as "displayName",
               photo_consent            as "photoConsent",
               photo_consent_recorded_at as "photoConsentRecordedAt",
               photo_consent_recorded_by as "photoConsentRecordedBy",
               is_publishable           as "isPublishable",
               gender,
               contract_type            as "contractType",
               employed_from            as "employedFrom",
               employed_until           as "employedUntil",
               basic_wage_fils          as "basicWageFils",
               housing_allowance_fils   as "housingAllowanceFils",
               transport_allowance_fils as "transportAllowanceFils",
               other_allowance_fils     as "otherAllowanceFils",
               total_wage_fils          as "totalWageFils",
               notes,
               is_provisional           as "isProvisional",
               provisional_note         as "provisionalNote",
               open_question_id         as "openQuestionId"
          from employee
         where id = ${employeeId}
      `
      if (row === undefined) return null
      const { visible, refused } = projectEmployeeRecord(access.role, row)
      return { visible: visible as Record<string, unknown>, refused }
    },

    writeBankDetail: async (access, args) => {
      assertCan(access.role, 'employee:write')
      await authorise(access, 'employee.bank', {
        action: 'employee.bank_detail.write',
        entityType: 'employee_bank_detail',
        entityId: args.employeeId,
      })

      // `withUnitOfWork` rather than a bare `sql.begin`: the state change and its audit row share one
      // transaction, which is the whole point of that seam ("any two of the three committing without the
      // third is a bug whose evidence is precisely the record that is missing").
      return withUnitOfWork(
        sql,
        access.actor,
        async ({ sql: tx, audit }) => {
          /*
          The row id is part of the AAD, so it has to exist before the payload can be sealed.

          Drawn from the database's own `uuid_generate_v7()` rather than invented in the application: one
          generator means one ordering, and v7 ids sort by creation time, which is what makes a superseded
          account's history readable. The alternative — insert a placeholder ciphertext and UPDATE it with
          the real one — is not available here and that is the point of 0050's ZS002 trigger: an UPDATE may
          rewrite the wrapped key, the key version and `superseded_at`, and nothing else. A sealed row is
          written once.
        */
          const [generated] = await tx<{ id: string }[]>`select uuid_generate_v7() as id`
          if (generated === undefined) {
            throw new AppError('invariant_violated', 'uuid_generate_v7() returned no row.')
          }
          const binding: StaffSecretBinding = {
            table: 'employee_bank_detail',
            recordId: generated.id,
            employeeId: args.employeeId,
          }
          const sealed = sealBankDetail(kek, binding, args.detail)
          // Supersede BEFORE inserting: `employee_bank_detail_one_current` is a partial unique index, so
          // this is not tidying up afterwards — without it the insert below is refused.
          const superseded = await tx<{ id: string }[]>`
          update employee_bank_detail
             set superseded_at = now()
           where employee_id = ${args.employeeId} and superseded_at is null
          returning id
        `
          const [row] = await tx<{ id: string }[]>`
          insert into employee_bank_detail
            (id, employee_id, label, detail_ct, detail_nonce, detail_wrapped_key, detail_kid,
             detail_aad_fp, created_by)
          values (${generated.id}, ${args.employeeId}, ${args.label ?? null}, ${sealed.ct},
                  ${sealed.nonce}, ${sealed.wrappedKey}, ${sealed.kid}, ${sealed.aadFp},
                  ${access.actor.label ?? access.actor.kind})
          returning id
        `
          if (row === undefined) {
            throw new AppError(
              'invariant_violated',
              'The sealed bank-detail insert returned no row.',
            )
          }
          await audit.record({
            action: 'employee.bank_detail.write',
            entityType: 'employee_bank_detail',
            entityId: args.employeeId,
            operation: 'create',
            // No part of the account, not even a last-four: an audit row is read by more people than the
            // bank screen is, and a partial number is still a disclosure.
            after: { bankDetailId: row.id, supersededId: superseded[0]?.id ?? null },
          })
          return { bankDetailId: row.id, supersededId: superseded[0]?.id ?? null }
        },
        access.context ?? {},
      )
    },

    readBankDetail: async (access, args) => {
      const purpose = assertStaffReadPurpose(args.purpose)
      /*
        The FIELD GROUP is the authorisation for a field-level read, and `employee:read` deliberately is
        not required here.

        `employee.bank` is granted to owner, manager and accountant; `employee:read` is granted to owner
        and manager. Requiring both would refuse the accountant the account they hold the group in order
        to pay into — which is the whole reason F07 gave them `employee.salary` and `employee.bank` and
        no `employee:read`: "Salary and bank are needed to run payroll; clinical data never is." A
        coarse route permission on top of the field group would make the field group decorative for one
        role and blocking for another.

        The record-level read is the other way round: `readEmployee` asserts `employee:read` and then
        projects, so a role that may see the person sees only the fields its groups cover.
      */
      await authorise(access, 'employee.bank', {
        action: 'employee.bank_detail.read',
        entityType: 'employee_bank_detail',
        entityId: args.employeeId,
      })

      const [row] = await sql<SealedRow[]>`
        select id,
               detail_ct          as ct,
               detail_nonce       as nonce,
               detail_wrapped_key as wrapped_key,
               detail_kid         as kid,
               detail_aad_fp      as aad_fp
          from employee_bank_detail
         where employee_id = ${args.employeeId} and superseded_at is null
      `
      if (row === undefined) return null

      await recordSensitiveRead(access, {
        action: 'employee.bank_detail.read',
        entityType: 'employee_bank_detail',
        employeeId: args.employeeId,
        purpose,
        detail: { bankDetailId: row.id, kid: row.kid },
      })

      return openBankDetail(
        kek,
        { table: 'employee_bank_detail', recordId: row.id, employeeId: args.employeeId },
        toSealed(row),
      )
    },

    writeDocumentNumber: async (access, args) => {
      assertCan(access.role, 'employee:write')
      await authorise(access, 'employee.identity_documents', {
        action: 'employee.document_number.write',
        entityType: 'employee_document',
        entityId: args.employeeId,
      })
      const sealed = sealDocumentNumber(
        kek,
        {
          table: 'employee_document',
          recordId: args.documentId,
          employeeId: args.employeeId,
        },
        args.number,
      )
      await withUnitOfWork(
        sql,
        access.actor,
        async ({ sql: tx, audit }) => {
          const updated = await tx`
            update employee_document
               set number_ct          = ${sealed.ct},
                   number_nonce       = ${sealed.nonce},
                   number_wrapped_key = ${sealed.wrappedKey},
                   number_kid         = ${sealed.kid},
                   number_aad_fp      = ${sealed.aadFp}
             where id = ${args.documentId} and employee_id = ${args.employeeId}
          `
          if (updated.count !== 1) {
            // The employee id is in the predicate, not only in the AAD: sealing against an employee the
            // row does not belong to would produce a ciphertext nothing can open, and the failure would
            // arrive months later looking like key loss.
            throw new AppError(
              'not_found',
              `employee_document ${args.documentId} does not belong to employee ${args.employeeId}, ` +
                'so its number was not sealed. The AAD binds a ciphertext to both.',
              { details: { matched: updated.count } },
            )
          }
          await audit.record({
            action: 'employee.document_number.write',
            entityType: 'employee_document',
            entityId: args.employeeId,
            operation: 'update',
            after: { documentId: args.documentId, kid: sealed.kid },
          })
        },
        access.context ?? {},
      )
    },

    readDocumentNumber: async (access, args) => {
      const purpose = assertStaffReadPurpose(args.purpose)
      // The field group alone, for the reason spelled out on `readBankDetail`.
      await authorise(access, 'employee.identity_documents', {
        action: 'employee.document_number.read',
        entityType: 'employee_document',
        entityId: args.employeeId,
      })

      const [row] = await sql<SealedRow[]>`
        select id,
               number_ct          as ct,
               number_nonce       as nonce,
               number_wrapped_key as wrapped_key,
               number_kid         as kid,
               number_aad_fp      as aad_fp
          from employee_document
         where id = ${args.documentId} and employee_id = ${args.employeeId}
           and number_ct is not null
      `
      if (row === undefined) return null

      await recordSensitiveRead(access, {
        action: 'employee.document_number.read',
        entityType: 'employee_document',
        employeeId: args.employeeId,
        purpose,
        detail: { documentId: row.id, kid: row.kid },
      })

      return openDocumentNumber(
        kek,
        { table: 'employee_document', recordId: row.id, employeeId: args.employeeId },
        toSealed(row),
      )
    },
  }
}

import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The staff portal's reads and its one write (P-HR-14).
 *
 * ## Every function here REQUIRES an employee id, and none of them has an "everybody" shape
 *
 * That is the design decision in this file. `readPayslips` and `readCommissionDerivation` both take
 * `employeeId?` — optional, because a payroll run legitimately reads a whole period — and the narrowing is
 * then something a caller does. A function with an optional filter is one `??` away from returning the
 * roster, and the shape of that mistake is a missing argument rather than a wrong one, which is the kind a
 * reviewer does not see.
 *
 * So the portal has its own readers and the argument is not optional. There is no value of
 * `PortalSubject.employeeId` that widens the query: a null arrives as a type error, and an id naming
 * somebody else never reaches here because `@berelax/hr`'s `staff-portal.ts` refuses it first
 * (`assertPortalSubject` in `@berelax/core`). Two independent layers, and this is the one that holds when
 * the first is edited.
 *
 * ## Why the authorisation is NOT in this file
 *
 * `packages/db` may not import `packages/core` (brief rule 4), and the rule that decides whose data this is
 * lives in `packages/core/src/hr/self-service.ts` with the rest of the matrix. The composition is
 * `packages/hr/src/staff-portal.ts`, which depends on both — the division P-HR-11 and P-HR-12 already made
 * for the derivation and the payslip, restated here because it applies unchanged.
 */

/** Whose data. One required field, so there is no call shape that omits the subject. */
export interface PortalSubject {
  readonly employeeId: string
}

export interface PortalShiftRow {
  readonly tradingDate: string
  readonly startsAt: number
  readonly endsAt: number
  /** The published version the shift came from, so the screen can say which rota it is reading. */
  readonly rotaVersionId: string
  readonly versionNo: number
  readonly publishedAt: Date
}

/**
 * The viewer's own published shifts from a given trading date onwards.
 *
 * Read from `rota_version_assignment` and not from `shift`, because what a member of staff is owed is the
 * roster that was PUBLISHED: `shift` is the working draft the rota screen edits, and showing it would tell
 * a therapist about a Tuesday somebody is still moving. The version is the one nothing supersedes, which is
 * `readCurrentRotaVersion`'s reading of the same chain — expressed as "no later row points at me" rather
 * than `max(version_no)`, because the supersession chain is what the database enforces.
 *
 * `fromTradingDate` is required and there is no unbounded form. A portal that showed every shift ever
 * assigned gets slower every month, and the question a therapist has is about this week.
 */
export async function readPortalShifts(
  sql: Sql,
  args: {
    readonly subject: PortalSubject
    readonly fromTradingDate: string
    readonly toTradingDate: string
  },
): Promise<readonly PortalShiftRow[]> {
  const rows = await sql<
    {
      tradingDate: string
      startsAt: Date
      endsAt: Date
      rotaVersionId: string
      versionNo: number
      publishedAt: Date
    }[]
  >`
    select a.trading_date::text as "tradingDate",
           lower(a.period)      as "startsAt",
           upper(a.period)      as "endsAt",
           v.id::text           as "rotaVersionId",
           v.version_no         as "versionNo",
           v.published_at       as "publishedAt"
      from rota_version_assignment a
      join rota_version v on v.id = a.rota_version_id
     where a.employee_id = ${args.subject.employeeId}::uuid
       and a.trading_date >= ${args.fromTradingDate}::date
       and a.trading_date <= ${args.toTradingDate}::date
       and not exists (select 1 from rota_version later where later.supersedes_id = v.id)
     order by a.trading_date, lower(a.period)
  `
  return rows.map((row) => ({
    tradingDate: row.tradingDate,
    startsAt: row.startsAt.getTime(),
    endsAt: row.endsAt.getTime(),
    rotaVersionId: row.rotaVersionId,
    versionNo: row.versionNo,
    publishedAt: row.publishedAt,
  }))
}

export interface PortalLeaveRequestRow {
  readonly id: string
  readonly kind: string
  readonly status: string
  readonly startsAt: number
  readonly endsAt: number
  readonly decidedAt: Date | null
  readonly reason: string | null
}

/** The viewer's own leave requests, newest first. */
export async function readPortalLeaveRequests(
  sql: Sql,
  args: { readonly subject: PortalSubject },
): Promise<readonly PortalLeaveRequestRow[]> {
  const rows = await sql<
    {
      id: string
      kind: string
      status: string
      startsAtText: string
      endsAtText: string
      decidedAt: Date | null
      reason: string | null
    }[]
  >`
    select id::text        as "id",
           kind::text      as "kind",
           status::text    as "status",
           (extract(epoch from lower(period)) * 1000)::bigint::text as "startsAtText",
           (extract(epoch from upper(period)) * 1000)::bigint::text as "endsAtText",
           decided_at      as "decidedAt",
           reason          as "reason"
      from leave_request
     where employee_id = ${args.subject.employeeId}::uuid
     order by lower(period) desc
  `
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    // Through a string, for `leave-request.ts`'s reason: `extract(epoch …)` is numeric and postgres.js
    // hands a numeric back as text, so reading it as a number without saying so turns a period into NaN
    // and every comparison then answers "not inside" with nothing wrong on the face of it.
    startsAt: finiteInstant(row.startsAtText, row.id),
    endsAt: finiteInstant(row.endsAtText, row.id),
    decidedAt: row.decidedAt,
    reason: row.reason,
  }))
}

const finiteInstant = (text: string, requestId: string): number => {
  const value = Number(text)
  if (!Number.isFinite(value)) {
    throw new AppError(
      'invariant_violated',
      `Leave request ${requestId} has a period bound that read back as ${text}, which is not a finite ` +
        'instant.',
    )
  }
  return value
}

export interface PortalBankSummaryRow {
  readonly label: string | null
  readonly filedOn: string
}

/**
 * Whether an account is on file for the viewer, its label and when it was filed. **Never the number.**
 *
 * The sealed columns are not in the select list, which is the point: this statement cannot return
 * ciphertext, so no caller of it can decrypt one. `label` and `created_at` are the only non-sealed columns
 * on `employee_bank_detail` that say anything (0050), and the label is the handle payroll files the account
 * under rather than a property of the account.
 *
 * `superseded_at is null` so the answer is about the CURRENT account. A superseded row is a previous
 * account, and a portal listing them would be a history of where somebody used to bank.
 */
export async function readPortalBankSummary(
  sql: Sql,
  args: { readonly subject: PortalSubject },
): Promise<PortalBankSummaryRow | null> {
  const [row] = await sql<{ label: string | null; filedOn: string }[]>`
    select label                  as "label",
           created_at::date::text as "filedOn"
      from employee_bank_detail
     where employee_id = ${args.subject.employeeId}::uuid
       and superseded_at is null
     order by created_at desc
     limit 1
  `
  return row ?? null
}

export interface WritePortalLeaveReservationInput {
  readonly subject: PortalSubject
  readonly leaveRequestId: string
  /** Day-hundredths, POSITIVE as the caller computed it; the sign is applied here. */
  readonly hundredths: number
  readonly occurredOn: string
  readonly leaveYearStart: string
  readonly createdBy: string
}

/**
 * The `reserved` movement a submitted request owes the balance (0066).
 *
 * 0066 is explicit that **a request reserves when it is MADE** and approval only makes the reservation
 * final — there is no `taken` kind, because a taken row would have to be paired with a reversal of the
 * reservation, which is two rows saying one thing. P-HR-09's approval path therefore writes no movement and
 * records so in its header; this is the other half, and it is why the balance a therapist reads on the
 * portal already has their pending request out of it.
 *
 * The sign is applied HERE from a positive argument rather than taken from the caller.
 * `leave_movement_sign_matches_kind` would refuse a positive `reserved` row at the database, so a caller
 * that passed its own sign could only ever get it wrong in a way that fails loudly — but the failure would
 * arrive as a constraint name in a 503 rather than as a reservation, and the subtraction is this function's
 * to know.
 *
 * It takes a `UnitOfWork` and not an `Sql`, so the movement, the request row and the audit row commit
 * together. A reservation that committed without its request is leave deducted for nothing.
 */
export async function writePortalLeaveReservation(
  uow: UnitOfWork,
  input: WritePortalLeaveReservationInput,
): Promise<{ readonly movementId: string; readonly hundredths: number }> {
  if (!Number.isInteger(input.hundredths) || input.hundredths <= 0) {
    throw new AppError(
      'validation',
      `A leave reservation must be a whole positive number of day-hundredths, got ${input.hundredths}. ` +
        'Zero would be a request that reserves nothing, which is a request the balance cannot refuse.',
    )
  }
  /*
    NO `rule_effective_from`, and it is a constraint rather than an omission.

    `leave_movement_rule_matches_kind` is a biconditional: the column is set on `accrual` and
    `carry_over_forfeited` and on NOTHING else. That is right — a reservation is a number of days somebody
    asked for, not a figure a policy version computed, so pinning a version to it would claim a derivation
    that did not happen. The first draft passed the governing version through and the constraint refused
    it, which is the schema saying so rather than a reviewer.
  */
  const [row] = await uow.sql<{ id: string; hundredths: number }[]>`
    insert into leave_movement
      (employee_id, kind, hundredths, occurred_on, leave_year_start, leave_request_id, created_by)
    values (
      ${input.subject.employeeId}::uuid,
      'reserved',
      ${-input.hundredths}::integer,
      ${input.occurredOn}::date,
      ${input.leaveYearStart}::date,
      ${input.leaveRequestId}::uuid,
      ${input.createdBy}
    )
    returning id::text as id, hundredths
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The leave reservation insert returned no row')
  }
  return { movementId: row.id, hundredths: row.hundredths }
}

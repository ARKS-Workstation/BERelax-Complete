import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The leave ledger's read and write side (P-HR-08, migration 0066): the versioned policy, the accrual
 * insert, the months already accrued, the unpaid days that reduce a month, and the balance.
 *
 * The **arithmetic** is `packages/core/src/hr/leave-accrual.ts`'s and stays there — `packages/db` must
 * never import `packages/core` — so this module returns rows and takes figures, and never computes an
 * entitlement, an accrual or a carry-over. `apps/worker/src/jobs/leave-accrual.ts` is the one module that
 * sees both, the same arrangement the credential sweep has.
 *
 * ## Why the accrual insert is `on conflict do nothing` and returns only what it wrote
 *
 * `leave_movement_one_accrual_per_month` is a partial unique index on `(employee_id, accrual_month)`, so
 * the DATABASE is the idempotency guarantee and not this function. The insert returns only the rows it
 * actually accepted, which is what makes "one audit row and one event per accrual" checkable: the count
 * the job audits cannot drift from the count the database took. Nothing is remembered in the job — 0031
 * records what that costs, which is a second accrual the first time a job's own state is lost.
 *
 * ## The balance is read from the view, never summed here
 *
 * `leave_balance` (0066) is a view over `leave_movement`, and this module reads it rather than writing its
 * own `sum(hundredths)`. A second summation would be a second reading of "what is the balance", and the
 * two would differ the first time a movement kind was added — which is the drift the view exists to make
 * impossible.
 */

/** One version of `leave_entitlement_rule`. Structurally `LeaveEntitlementRules` in `@berelax/core`. */
export interface LeaveEntitlementRuleRow {
  readonly effectiveFrom: string
  readonly annualEntitlementDays: number
  readonly monthlyAccrualHundredths: number
  readonly probationMonths: number
  readonly accruesDuringProbation: boolean
  readonly carryOverCapHundredths: number
  readonly carryOverExpiresAfterOneLeaveYear: boolean
  readonly leaveYearStartsOnAnniversary: boolean
  readonly unpaidLeaveReducesAccrual: boolean
  readonly absentDayReducesAccrual: boolean
  readonly sickFullPayDays: number
  readonly sickHalfPayDays: number
  readonly sickUnpaidDays: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
  readonly sourceNote: string
}

/** An employee the accrual pass has to consider, with the two dates that bound their service. */
export interface AccruingEmployeeRow {
  readonly employeeId: string
  readonly staffReference: string
  readonly employedFrom: string
  readonly employedUntil: string | null
}

/** One accrual to write. Every figure was computed by `accrueMonth()` in `@berelax/core`. */
export interface LeaveAccrualInput {
  readonly employeeId: string
  /** The first day of the month accrued for. The database refuses any other day (0066). */
  readonly accrualMonth: string
  readonly hundredths: number
  /** The date the movement is dated on: the last day of the month accrued for. */
  readonly occurredOn: string
  readonly leaveYearStart: string
  /** Which policy version produced the figure. */
  readonly ruleEffectiveFrom: string
  readonly createdBy: string
}

/** One accrual the database actually accepted. A second pass over the same month returns none. */
export interface WrittenLeaveAccrual {
  readonly movementId: string
  readonly employeeId: string
  readonly accrualMonth: string
  readonly hundredths: number
}

/** The months an employee already has an accrual row for. */
export interface AccruedMonthRow {
  readonly employeeId: string
  readonly accrualMonth: string
}

/** Approved unpaid-leave days in one calendar month, per employee. */
export interface UnpaidLeaveDaysRow {
  readonly employeeId: string
  readonly accrualMonth: string
  readonly unpaidDays: number
}

/** One row of `leave_balance`. Read, never summed here. */
export interface LeaveBalanceRow {
  readonly employeeId: string
  readonly balanceHundredths: number
  readonly openingHundredths: number
  readonly accruedHundredths: number
  readonly reservedHundredths: number
  readonly releasedHundredths: number
  readonly forfeitedHundredths: number
  readonly movementCount: number
  readonly lastAccrualMonth: string | null
}

/**
 * Every version of the policy, oldest first.
 *
 * All of them and not the one in force, which is the table's whole reason for existing: a disputed month
 * recomputed after a policy change must use the policy that applied then. `leaveRulesFor` in
 * `@berelax/core` picks the version governing each date, and it is pure precisely so that choice is
 * testable without a database.
 *
 * **Throws** when the table is empty, for `readWorkingHoursRules`'s reason: 0066 seeds a version from a
 * sentinel date before any employment this business could have had, so an empty result means the row is
 * gone rather than that no policy has been decided. An empty array would hand the arithmetic a choice
 * between inventing an entitlement and failing somewhere less informative.
 */
export async function readLeaveEntitlementRules(
  sql: Sql,
): Promise<readonly LeaveEntitlementRuleRow[]> {
  const rows = await sql<LeaveEntitlementRuleRow[]>`
    select effective_from::text                     as "effectiveFrom",
           annual_entitlement_days                  as "annualEntitlementDays",
           monthly_accrual_hundredths               as "monthlyAccrualHundredths",
           probation_months                         as "probationMonths",
           accrues_during_probation                 as "accruesDuringProbation",
           carry_over_cap_hundredths                as "carryOverCapHundredths",
           carry_over_expires_after_one_leave_year  as "carryOverExpiresAfterOneLeaveYear",
           leave_year_starts_on_anniversary         as "leaveYearStartsOnAnniversary",
           unpaid_leave_reduces_accrual             as "unpaidLeaveReducesAccrual",
           absent_day_reduces_accrual               as "absentDayReducesAccrual",
           sick_full_pay_days                       as "sickFullPayDays",
           sick_half_pay_days                       as "sickHalfPayDays",
           sick_unpaid_days                         as "sickUnpaidDays",
           is_provisional                           as "isProvisional",
           open_question_id                         as "openQuestionId",
           provisional_note                         as "provisionalNote",
           source_note                              as "sourceNote"
      from leave_entitlement_rule
     order by effective_from
  `
  if (rows.length === 0) {
    throw new AppError(
      'invariant_violated',
      'No leave entitlement version exists, so the annual entitlement, the monthly accrual, the ' +
        'probation length, the carry-over cap and the sick-leave tiers are all unknown. 0066 seeds ' +
        'version 1 flagged provisional against Y9-leave-detail; an empty table means it was deleted. An ' +
        'empty answer here would leave the arithmetic to invent an entitlement nobody decided.',
    )
  }
  return rows
}

/**
 * The employees an accrual pass considers: everybody engaged on or before the end of the window.
 *
 * Everybody and not "everybody currently employed", because the pass is a catch-up sweep and a leaver's
 * final month still accrues — a balance owed at the end of employment is the figure a settlement is
 * computed from. `employedUntil` is returned rather than filtered on, so the pure engine pro-rates the
 * final month and this query makes no judgement about it.
 *
 * `staffReference` is returned for the audit row and the event. No display name: a therapist has none
 * until an admin sets one (ADR 0020), and the handle is what identifies them.
 */
export async function readAccruingEmployees(
  sql: Sql,
  args: {
    readonly engagedOnOrBefore: string
    /**
     * Narrows the pass to these employees.
     *
     * Omitted means every employee, which is what the monthly cron asks. The narrowed form is the one an
     * admin re-run after a corrected employment date needs, and it is what lets the integration suite
     * isolate itself: the pass reads the WHOLE roster in production, so a suite driving it unnarrowed
     * against a shared database would accrue for every other file's fixture employees and for the
     * nineteen seeded therapists (brief rule 12 — narrow what the code under test can SEE).
     *
     * `[]` is refused rather than silently meaning "everybody", because an empty list is what an
     * unfiltered variable looks like.
     */
    readonly employeeIds?: readonly string[]
  },
): Promise<readonly AccruingEmployeeRow[]> {
  if (args.employeeIds !== undefined && args.employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readAccruingEmployees was given an empty employee list. Omit the argument to mean every ' +
        'employee; an empty array is what an unfiltered variable looks like.',
    )
  }
  return sql<AccruingEmployeeRow[]>`
    select id::text              as "employeeId",
           staff_reference       as "staffReference",
           employed_from::text   as "employedFrom",
           employed_until::text  as "employedUntil"
      from employee
     where employed_from <= ${args.engagedOnOrBefore}::date
       ${
         args.employeeIds === undefined
           ? sql``
           : sql`and id = any(${[...args.employeeIds]}::uuid[])`
       }
     order by staff_reference, id
  `
}

/**
 * The accrual months these employees already have a row for, within a window.
 *
 * Bounded by the window rather than unbounded, because the pass only ever asks about the months it is
 * willing to write: an unbounded read would grow with the age of the roster and answer a question nobody
 * asked. An empty employee list is refused, for `readLeaveOpeningBalances`'s reason.
 */
export async function readAccruedMonths(
  sql: Sql,
  args: {
    readonly employeeIds: readonly string[]
    readonly fromMonth: string
    readonly toMonth: string
  },
): Promise<readonly AccruedMonthRow[]> {
  if (args.employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readAccruedMonths was given an empty employee list; an empty array is what an unfiltered ' +
        'variable looks like',
    )
  }
  return sql<AccruedMonthRow[]>`
    select employee_id::text     as "employeeId",
           accrual_month::text   as "accrualMonth"
      from leave_movement
     where kind = 'accrual'
       and employee_id = any(${[...args.employeeIds]}::uuid[])
       and accrual_month between ${args.fromMonth}::date and ${args.toMonth}::date
     order by employee_id, accrual_month
  `
}

/**
 * Approved unpaid-leave days per employee per calendar month, inside a window.
 *
 * Counted as **calendar days**, which is what a leave day is, and counted from the `leave_request.period`
 * instants by expanding them into the dates they cover. The expansion is in SQL and the count is a
 * count of dates, so a period crossing midnight — which every one of them does, because a leave day runs
 * 11:00 to 02:00 — contributes its trading date once and not twice. `generate_series` over the period's
 * own instants would do exactly that double count, which is why the series is over the DATES the period
 * spans and the last one is excluded when the period ends at or before that date's start.
 *
 * Only `approved` rows, read through `employee_approved_leave` rather than `leave_request`: 0030 created
 * that view so the predicate cannot be forgotten, and a pending request reducing somebody's accrual would
 * be a request that had already cost them something.
 *
 * ABSENT days are **not** here, and cannot be: there is no attendance register in this schema. That is
 * P-HR-07's, and until it lands the pass supplies zero absent days — stated in the job's header and
 * deferred in the manifest rather than guessed at.
 */
export async function readUnpaidLeaveDaysByMonth(
  sql: Sql,
  args: {
    readonly employeeIds: readonly string[]
    readonly fromMonth: string
    readonly toMonth: string
  },
): Promise<readonly UnpaidLeaveDaysRow[]> {
  if (args.employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readUnpaidLeaveDaysByMonth was given an empty employee list; an empty array is what an ' +
        'unfiltered variable looks like',
    )
  }
  return sql<UnpaidLeaveDaysRow[]>`
    with covered as (
      select l.employee_id,
             -- The dates the period covers, in the business zone. The period's lower bound rendered in
             -- Asia/Dubai is the leave day itself, because leaveCoveragePeriod() starts a leave day at
             -- the session's 11:00 opening; the period ends at 02:00 the following calendar day, so the
             -- series stops one day short of its upper bound.
             generate_series(
               (lower(l.period) at time zone 'Asia/Dubai')::date,
               ((upper(l.period) at time zone 'Asia/Dubai')::date - interval '1 day')::date,
               interval '1 day'
             )::date as covered_on
        from employee_approved_leave l
       where l.kind = 'unpaid'
         and l.employee_id = any(${[...args.employeeIds]}::uuid[])
    )
    select employee_id::text                                   as "employeeId",
           date_trunc('month', covered_on)::date::text          as "accrualMonth",
           count(*)::integer                                    as "unpaidDays"
      from covered
     where covered_on >= ${args.fromMonth}::date
       and covered_on < (${args.toMonth}::date + interval '1 month')::date
     group by employee_id, date_trunc('month', covered_on)
     order by employee_id, 2
  `
}

/**
 * Writes accruals, skipping any `(employee, accrual_month)` that already has one.
 *
 * ACCEPTANCE: this is where the idempotency lives, and it lives in the INDEX rather than here. A second
 * pass over the same month inserts nothing and returns nothing, so the caller writes no second audit row
 * and publishes no second event — and the balance is unchanged because the balance is the sum of these
 * rows.
 *
 * A zero accrual is still written. A month somebody was employed for and earned nothing in — wholly
 * unpaid, or probationary under a policy where accrual waits — is a fact, and the row is what stops the
 * next pass re-deriving it for ever.
 */
export async function writeLeaveAccruals(
  sql: Sql,
  accruals: readonly LeaveAccrualInput[],
): Promise<readonly WrittenLeaveAccrual[]> {
  if (accruals.length === 0) return []
  for (const accrual of accruals) {
    if (!Number.isInteger(accrual.hundredths) || accrual.hundredths < 0) {
      throw new AppError(
        'validation',
        `An accrual must be a whole non-negative number of day-hundredths, got ${accrual.hundredths} ` +
          `for employee ${accrual.employeeId} in ${accrual.accrualMonth}`,
      )
    }
  }
  const rows = await sql<
    { id: string; employee_id: string; accrual_month: string; hundredths: number }[]
  >`
    insert into leave_movement
      (employee_id, kind, hundredths, occurred_on, leave_year_start, accrual_month,
       rule_effective_from, created_by)
    select a."employeeId"::uuid,
           'accrual',
           a.hundredths::integer,
           a."occurredOn"::date,
           a."leaveYearStart"::date,
           a."accrualMonth"::date,
           a."ruleEffectiveFrom"::date,
           a."createdBy"
      -- Column names are QUOTED so they match the JSON keys exactly. jsonb_to_recordset pairs a key to a
      -- column by name and an unquoted identifier is folded to lower case, so employee_id would never
      -- match employeeId and every row would arrive with a null employee.
      from jsonb_to_recordset(${sql.json([...accruals] as never)}) as a(
             "employeeId"        text,
             hundredths          integer,
             "occurredOn"        text,
             "leaveYearStart"    text,
             "accrualMonth"      text,
             "ruleEffectiveFrom" text,
             "createdBy"         text
           )
    on conflict do nothing
    returning id::text as id, employee_id::text as employee_id,
              accrual_month::text as accrual_month, hundredths
  `
  return rows.map((row) => ({
    movementId: row.id,
    employeeId: row.employee_id,
    accrualMonth: row.accrual_month,
    hundredths: row.hundredths,
  }))
}

/**
 * The balance for each employee asked about, from the `leave_balance` view.
 *
 * An employee with no movement at all has no row in the view and none here: a balance of zero with no
 * movements behind it is not a balance, it is the absence of one, and `readLeaveOpeningBalances` is the
 * reader whose job it is to say so with a flag. Returning a synthetic zero row here would make the two
 * readers disagree about what "nothing" means.
 */
export async function readLeaveBalances(
  sql: Sql,
  employeeIds: readonly string[],
): Promise<readonly LeaveBalanceRow[]> {
  if (employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readLeaveBalances was given an empty employee list; an empty array is what an unfiltered ' +
        'variable looks like',
    )
  }
  return sql<LeaveBalanceRow[]>`
    select employee_id::text          as "employeeId",
           balance_hundredths         as "balanceHundredths",
           opening_hundredths         as "openingHundredths",
           accrued_hundredths         as "accruedHundredths",
           reserved_hundredths        as "reservedHundredths",
           released_hundredths        as "releasedHundredths",
           forfeited_hundredths       as "forfeitedHundredths",
           movement_count             as "movementCount",
           last_accrual_month::text   as "lastAccrualMonth"
      from leave_balance
     where employee_id = any(${[...employeeIds]}::uuid[])
     order by employee_id
  `
}

import {
  accrualCatchUpFloor,
  accrualMonthsOwing,
  accrueMonth,
  type LeaveEntitlementRules,
  latestCompletedAccrualMonth,
  leaveRulesFor,
  leaveYearStart,
  localDate,
  monthEnd,
} from '@berelax/core'
import {
  type AccruingEmployeeRow,
  type Actor,
  businessDayAt,
  type LeaveAccrualInput,
  type LeaveEntitlementRuleRow,
  readAccruedMonths,
  readAccruingEmployees,
  readLeaveEntitlementRules,
  readUnpaidLeaveDaysByMonth,
  type Sql,
  type WrittenLeaveAccrual,
  withUnitOfWork,
  writeLeaveAccruals,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The monthly leave accrual pass (P-HR-08).
 *
 * Annual leave is earned month by month — 2.5 calendar days a month under the build's provisional answer
 * to Y9-leave-detail — and nothing else in this system earns it. The availability engine, the rota and
 * the leave screens all READ a balance; this pass is the only thing that adds to it.
 *
 * ## A catch-up sweep, not a "this month" pass
 *
 * Every complete month with no accrual row yet is accrued, bounded by {@link CATCH_UP_MONTHS}. That shape
 * is chosen rather than "accrue last month", and the reason is the watchdog interval: a monthly cron
 * declares a 31-day interval, so a dead pass is reported after about two months rather than after two
 * hours (0066 says so on the `agent_definition` row). A pass that only ever accrued the month just gone
 * would lose every month it missed; this one repairs them on the next run, which is the same reasoning
 * `seo.gsc-snapshot` records for its overlapping window.
 *
 * The bound matters in the other direction. Without it, a first run against a roster engaged years ago
 * would derive a decade of accrual the business has no record of agreeing. History before the window is
 * what the opening-balance importer is for — one stated figure with a source beats a hundred derived ones
 * — and `readLeaveOpeningBalances` in `@berelax/db` is where that figure is read.
 *
 * ## Which month is complete is a question about the TRADING session
 *
 * Trading runs 11:00–02:00 (0011), so at 01:30 on 1 March the session in force opened on 28 February and
 * February's last trading day has not finished: this pass must accrue January. At 05:00 on the same
 * calendar day that session has closed and February is complete. Both facts come from `business_day`
 * through {@link businessDayAt} — the trading date and whether its session is still open — and
 * `latestCompletedAccrualMonth` in `@berelax/core` turns the pair into a month. Nothing here re-derives
 * where a trading day ends; `resolveTradingDate` is the one reading of that and it is not in this file.
 *
 * A calendar reading of the same question — `date(at)` minus one month — is right for twenty-two hours of
 * every day and wrong for the two after midnight, and the month it gets wrong is the month a 1st-of-the-
 * month cron runs in.
 *
 * ## Idempotent because the database says so
 *
 * `leave_movement_one_accrual_per_month` is a partial unique index on `(employee_id, accrual_month)` and
 * the insert is `on conflict do nothing`, so a second pass over the same month inserts nothing, returns
 * nothing, and therefore writes no second audit row and publishes no second event. The balance is a VIEW
 * summing those rows, so an unchanged row count IS an unchanged balance — there is no second figure that
 * could move. Nothing is remembered in this module: 0031 records what that costs, which is a second
 * accrual the first time a job's own state is lost.
 *
 * ## What reduces a month, and the half that is deferred
 *
 * Approved **unpaid leave** reduces the month's accrual when the policy version says so, counted as
 * calendar days from `employee_approved_leave` by `readUnpaidLeaveDaysByMonth`. **ABSENT days** reduce it
 * too, by the same rule and behind their own flag, and the engine takes them as an argument with a worked
 * example either way — but this pass supplies **zero**, because there is no attendance register in this
 * schema. ABSENT is P-HR-07's variance outcome and P-HR-07 has not landed. Passing zero is stated here
 * and deferred in the manifest rather than guessed at; when the register arrives this file gains one read
 * and the engine gains nothing.
 *
 * ## The instant is injected
 *
 * `atIso` is an argument and not a clock read, so the pass is reproducible: the integration suite drives
 * it at a frozen instant and asserts the second run writes nothing, which is exactly what a job reading
 * `new Date()` could not be asked.
 */

/** The `agent_definition` this pass reports to. Seeded by 0066; `assertRegistry` refuses a cron without one. */
export const LEAVE_ACCRUAL_AGENT = 'leave_accrual'

/** Published per accrual written, so a balance change is visible outside the database. */
export const LEAVE_ACCRUED_EVENT = 'leave.accrued'

/**
 * How far back a pass will reach for a month with no accrual row.
 *
 * Twenty-four months. Long enough that a pass silenced for a year still repairs itself, short enough that
 * a first run against a long-standing roster does not derive years of entitlement nobody agreed. It is a
 * constant rather than a setting because the figure it trades off is a choice about THIS pass and not a
 * policy about leave: a business that wants more history imports an opening balance, which is a stated
 * figure with a source rather than a derived one.
 */
export const CATCH_UP_MONTHS = 24

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR: Actor = { kind: 'system', label: 'leave.accrual' }

/** The `created_by` label on every movement this pass writes. */
const CREATED_BY = 'leave.accrual'

export interface LeaveAccrualResult {
  /** The trading date the pass was made for — the session the instant belongs to. */
  readonly tradingDate: string
  /** True when that session was still open, which is what makes its month incomplete. */
  readonly withinTradingHours: boolean
  /** The latest month the pass was willing to accrue. */
  readonly throughMonth: string
  /** Employees considered. Reported even when zero, so "nothing owing" is not "nothing ran". */
  readonly considered: number
  /** Accruals written. Empty on a second pass of the same month, which is the acceptance criterion. */
  readonly written: readonly WrittenLeaveAccrual[]
  /** Day-hundredths added across every accrual written. */
  readonly accruedHundredths: number
  /** The policy versions in hand, for the record. */
  readonly policyVersions: number
}

/** The row shape `@berelax/db` returns, in the shape the pure engine takes. */
function asRules(row: LeaveEntitlementRuleRow): LeaveEntitlementRules {
  return {
    effectiveFrom: localDate(row.effectiveFrom),
    annualEntitlementDays: row.annualEntitlementDays,
    monthlyAccrualHundredths: row.monthlyAccrualHundredths,
    probationMonths: row.probationMonths,
    accruesDuringProbation: row.accruesDuringProbation,
    carryOverCapHundredths: row.carryOverCapHundredths,
    carryOverExpiresAfterOneLeaveYear: row.carryOverExpiresAfterOneLeaveYear,
    leaveYearStartsOnAnniversary: row.leaveYearStartsOnAnniversary,
    unpaidLeaveReducesAccrual: row.unpaidLeaveReducesAccrual,
    absentDayReducesAccrual: row.absentDayReducesAccrual,
    sickLeave: {
      fullPayDays: row.sickFullPayDays,
      halfPayDays: row.sickHalfPayDays,
      unpaidDays: row.sickUnpaidDays,
    },
  }
}

/**
 * One pass, for the business day containing `atIso`.
 *
 * Reads once, outside every loop: the policy versions, the employees, the months already accrued and the
 * unpaid days. A read per employee would make the cost of a quiet month grow with the size of the roster
 * rather than with the number of months owing — and, more to the point, a policy re-read per employee
 * could judge the first half of the roster against one version and the second half against another, with
 * no movement saying which.
 */
export async function runLeaveAccrual(
  sql: Sql,
  atIso: string,
  options: {
    /**
     * Narrows the pass to these employees. Omitted means every employee, which is what the cron asks.
     *
     * The narrowed form is the one an admin re-run after a corrected employment date needs, and it is
     * what lets the integration suite isolate itself against a shared database (brief rule 12): the pass
     * reads the whole roster in production, so an unnarrowed run from a test would accrue for every other
     * file's fixture employees and for the nineteen seeded therapists — into an append-only table.
     */
    readonly employeeIds?: readonly string[]
  } = {},
): Promise<LeaveAccrualResult> {
  const day = await businessDayAt(sql, atIso)
  if (day === null) {
    throw new AppError(
      'invariant_violated',
      `The leave accrual pass ran at ${atIso} and business_day holds no trading session at or before ` +
        'it, so which month has completed is unknown. Generate the trading calendar ' +
        '(generateBusinessDays) first: deciding it from the instant’s own calendar date would accrue ' +
        'the wrong month for every pass between midnight and 02:00, which is when a 1st-of-the-month ' +
        'cron runs.',
    )
  }

  const versions = (await readLeaveEntitlementRules(sql)).map(asRules)
  const throughMonth = latestCompletedAccrualMonth({
    tradingDate: localDate(day.tradingDate),
    sessionIsOpen: day.isOpen,
  })
  // The window's floor, from the engine rather than re-derived here: the two reads below must cover
  // exactly the months accrualMonthsOwing() will offer, and an off-by-one between them would leave the
  // oldest month's existing row unread and re-accrued on every pass.
  const earliestMonth = accrualCatchUpFloor(throughMonth, CATCH_UP_MONTHS)

  // Everybody engaged by the last day of the last complete month. A leaver's final month still accrues,
  // so the filter is on engagement and never on `employed_until`.
  const employees = await readAccruingEmployees(sql, {
    engagedOnOrBefore: monthEnd(throughMonth),
    ...(options.employeeIds === undefined ? {} : { employeeIds: options.employeeIds }),
  })
  if (employees.length === 0) {
    return {
      tradingDate: day.tradingDate,
      withinTradingHours: day.isOpen,
      throughMonth,
      considered: 0,
      written: [],
      accruedHundredths: 0,
      policyVersions: versions.length,
    }
  }
  const employeeIds = employees.map((employee) => employee.employeeId)

  const accruedAlready = new Map<string, LocalDateSet>()
  for (const row of await readAccruedMonths(sql, {
    employeeIds,
    fromMonth: earliestMonth,
    toMonth: throughMonth,
  })) {
    const held = accruedAlready.get(row.employeeId) ?? []
    held.push(row.accrualMonth)
    accruedAlready.set(row.employeeId, held)
  }

  const unpaidDays = new Map<string, number>()
  for (const row of await readUnpaidLeaveDaysByMonth(sql, {
    employeeIds,
    fromMonth: earliestMonth,
    toMonth: throughMonth,
  })) {
    unpaidDays.set(`${row.employeeId}\u0000${row.accrualMonth}`, row.unpaidDays)
  }

  const toWrite: LeaveAccrualInput[] = []
  for (const employee of employees) {
    for (const month of monthsOwingFor(employee, throughMonth, accruedAlready)) {
      const accrual = accrueMonth({
        versions,
        employedFrom: localDate(employee.employedFrom),
        employedUntil: employee.employedUntil === null ? null : localDate(employee.employedUntil),
        accrualMonth: localDate(month),
        unpaidLeaveDays: unpaidDays.get(`${employee.employeeId}\u0000${month}`) ?? 0,
        // Zero, and the reason is in this module's header: there is no attendance register in this
        // schema, so an ABSENT day has no source. The engine honours the figure; nothing can supply it
        // until P-HR-07 lands.
        absentDays: 0,
      })
      const rules = leaveRulesFor(versions, accrual.accrualMonth)
      toWrite.push({
        employeeId: employee.employeeId,
        accrualMonth: accrual.accrualMonth,
        hundredths: accrual.hundredths,
        // The last day of the month accrued for. The accrual is earned BY that day and dating it on the
        // pass instant would put January's accrual in March after a catch-up, which is the date every
        // later report would group it by.
        occurredOn: monthEnd(accrual.accrualMonth),
        leaveYearStart: leaveYearStart(
          rules,
          localDate(employee.employedFrom),
          monthEnd(accrual.accrualMonth),
        ),
        ruleEffectiveFrom: accrual.ruleEffectiveFrom,
        createdBy: CREATED_BY,
      })
    }
  }

  // One transaction for the movements, the audit rows and the events. Any two of the three committing
  // without the third is the bug `UnitOfWork` exists to make impossible: an accrual with no audit row is
  // a balance change nobody can account for.
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const written = await writeLeaveAccruals(uow.sql, toWrite)
    let accruedHundredths = 0
    for (const accrual of written) {
      accruedHundredths += accrual.hundredths
      await uow.audit.record({
        action: 'leave.accrued',
        entityType: 'employee',
        entityId: accrual.employeeId,
        operation: 'create',
        // No `before`: the balance is the sum of the movements and has no prior value of its own to
        // record. The movement IS the change, which is the claim this ledger makes about itself.
        after: {
          movementId: accrual.movementId,
          accrualMonth: accrual.accrualMonth,
          hundredths: accrual.hundredths,
        },
      })
      await uow.publish({
        eventType: LEAVE_ACCRUED_EVENT,
        aggregateType: 'employee',
        aggregateId: accrual.employeeId,
        payload: {
          accrualMonth: accrual.accrualMonth,
          hundredths: accrual.hundredths,
          movementId: accrual.movementId,
        },
        // Keyed on the employee and the accrual MONTH rather than on the pass, so a transaction retried
        // after the movement committed enqueues nothing, and a genuine later month can still notify.
        idempotencyKey: `${LEAVE_ACCRUED_EVENT}:${accrual.employeeId}:${accrual.accrualMonth}`,
      })
    }
    return {
      tradingDate: day.tradingDate,
      withinTradingHours: day.isOpen,
      throughMonth,
      considered: employees.length,
      written,
      accruedHundredths,
      policyVersions: versions.length,
    }
  })
}

/** Mutable list of month keys, kept local so the map's value type reads as what it is. */
type LocalDateSet = string[]

/** The months this employee owes accrual for, oldest first. */
function monthsOwingFor(
  employee: AccruingEmployeeRow,
  throughMonth: string,
  accruedAlready: ReadonlyMap<string, LocalDateSet>,
): readonly string[] {
  return accrualMonthsOwing({
    employedFrom: localDate(employee.employedFrom),
    employedUntil: employee.employedUntil === null ? null : localDate(employee.employedUntil),
    throughMonth: localDate(throughMonth),
    maxMonths: CATCH_UP_MONTHS,
    alreadyAccrued: (accruedAlready.get(employee.employeeId) ?? []).map((month) =>
      localDate(month),
    ),
  })
}

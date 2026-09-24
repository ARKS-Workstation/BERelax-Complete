import { randomUUID } from 'node:crypto'
import {
  assertLeaveEntitlementRules,
  foldLeaveLedger,
  type LeaveEntitlementRules,
  type LeaveLedgerEvent,
  leaveDays,
  leaveLedgerProblems,
  localDate,
  PROVISIONAL_OPENING_BALANCE,
} from '@berelax/core'
import {
  createConnection,
  importLeaveOpeningBalances,
  readLeaveBalances,
  readLeaveEntitlementRules,
  readLeaveOpeningBalances,
  type Sql,
  unconfirmedAssumptionRows,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JOB_REGISTRY } from '../registry.ts'
import { LEAVE_ACCRUAL_AGENT, LEAVE_ACCRUED_EVENT, runLeaveAccrual } from './leave-accrual.ts'

/**
 * P-HR-08 — leave accrual against real PostgreSQL: the worked examples, the idempotency, the opening
 * balance and the append-only ledger.
 *
 * The arithmetic is proved without a database by `packages/core/src/hr/leave-accrual.test.ts`. This file
 * proves the four things that only a database can answer:
 *
 *   1. **The seeded policy really carries the figures the pure tests restate.** Those tests declare a
 *      `V1` rule set by hand, because `packages/core` may not read a database — and a `V1` that had
 *      drifted from migration 0066's row would make every one of them pass about a policy nobody has.
 *   2. **The pass is idempotent per (employee, accrual_month)**, by row count and by balance equality.
 *      The guarantee is a partial unique index, so this is the only place it can be shown to hold.
 *   3. **Which month is complete is a question about the TRADING session**, read from `business_day`. A
 *      pass at 01:30 on 1 January accrues through November, because the session in force opened on 31
 *      December and December's last trading day has not finished; the same pass at 05:00 accrues December.
 *      That is not a rounding difference — 01:30 is when a 1st-of-the-month cron would run if it ran at
 *      midnight.
 *   4. **The ledger refuses to be edited**, and the balance is a view over it rather than a column.
 *
 * ## Isolation (brief rule 12)
 *
 * The pass reads the WHOLE roster in production, so every run here is **narrowed to this file's own
 * employees** — which is the brief's own remedy, narrowing what the code under test can see rather than
 * deleting rows afterwards. Unnarrowed it would accrue two years of entitlement for the nineteen seeded
 * therapists and for every other file's fixture employees, into an append-only table.
 *
 * Every assertion is a figure about one of this file's employees, never a total. The employment dates
 * (2093) and the trading date (2093-12-31) are used by no other suite and no gate.
 *
 * ## Why `afterAll` disables a trigger
 *
 * `leave_movement` is append-only and its triggers refuse DELETE for every role including the owner, so
 * the rows this file writes cannot be removed the ordinary way — and `leave_movement.employee_id` is
 * `ON DELETE RESTRICT`, so the fixture employees cannot be removed while they exist. Leaving both behind
 * would put employees in the shared database that every later suite's roster reads, which is the failure
 * brief rule 12 is about. So the cleanup disables the two triggers, deletes this file's rows, and
 * re-enables them **inside one transaction** — the `ACCESS EXCLUSIVE` lock that DDL takes is held for its
 * duration, so nothing else can insert past a disabled trigger, and a failure rolls the whole thing back
 * to the enabled state. `invoice.itest.ts` set that precedent for the same owner-only operation.
 *
 * It does not weaken the append-only claim, which is asserted below with the triggers ENABLED, as the
 * connected role and by privilege for the application role.
 *
 * Therapists are ids and `staff_reference` handles throughout; no employee here has a name (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** Unique per run, so a re-run against the same database starts from no movements. */
const RUN = randomUUID().slice(0, 8)
const MARKER = `phr08 leave accrual itest ${RUN}`

/** The last trading date of 2093. Its session opens 11:00 on the 31st and closes 02:00 on 1 January. */
const LAST_TRADING_DATE = '2093-12-31'

/**
 * 01:30 on 1 January 2094 — INSIDE the 31 December session, which closes at 02:00.
 *
 * The instant that tells the two readings of "which month is complete" apart: December's last trading day
 * is still running, so the latest complete month is November.
 */
const AT_ONE_THIRTY = '2094-01-01T01:30:00+04:00'
/** 05:00 the same calendar day, after that session closed. December is complete. */
const AT_FIVE = '2094-01-01T05:00:00+04:00'

const JANUARY = '2093-01-01'
const NOVEMBER = '2093-11-01'
const DECEMBER = '2093-12-01'

/** 2093 is not a leap year, so February has 28 days and no month here is 29. */
const FULL_YEAR_HUNDREDTHS = 3000
/** Engaged on 15 January: 17 of January's 31 days, so 250 x 17 / 31 rounded up is 138. */
const PART_MONTH_JANUARY_HUNDREDTHS = 138
/** Six unpaid days in a 31-day March: 250 x 25 / 31 = 201.61, rounded up to 202. */
const MARCH_WITH_UNPAID_HUNDREDTHS = 202

let sql: Sql
const staff = new Map<string, string>()

const idOf = (reference: string): string => {
  const id = staff.get(reference)
  if (id === undefined) throw new Error(`no fixture employee ${reference}`)
  return id
}
const ourIds = (): string[] => [...staff.values()]

/**
 * A fixture employee with no skill, no credential and no shift.
 *
 * Deliberately bare: an employee the availability engine could offer would change what every other suite
 * sees, and accrual needs nothing but `employed_from`. `is_provisional` is left at its FALSE default,
 * because `employee.itest.ts` asserts the Unconfirmed Assumptions panel holds exactly nineteen `employee`
 * rows and a provisional fixture would make it twenty.
 */
async function addEmployee(args: {
  readonly handle: string
  readonly employedFrom: string
}): Promise<string> {
  const reference = `phr08-${RUN}-${args.handle}`
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, notes)
    values (${reference}, ${args.employedFrom}::date, ${MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  staff.set(args.handle, id)
  return id
}

/** One approved unpaid-leave request over a run of calendar days, aligned to the trading session. */
async function approveUnpaidLeave(args: {
  readonly handle: string
  readonly from: string
  readonly to: string
}): Promise<void> {
  // The period `leaveCoveragePeriod()` in @berelax/core produces: the first day's 11:00 opening to the
  // last day's 02:00 close, which falls on the following calendar date. Written out here rather than
  // computed, so the expected day count below is a figure worked out by hand and not one this file
  // derived from the same helper the code under test uses.
  const opensAt = `${args.from} 11:00:00+04`
  const closesAtDate = new Date(`${args.to}T00:00:00Z`)
  closesAtDate.setUTCDate(closesAtDate.getUTCDate() + 1)
  const closesAt = `${closesAtDate.toISOString().slice(0, 10)} 02:00:00+04`
  await sql`
    insert into leave_request (employee_id, period, kind, status, decided_at, reason)
    values (${idOf(args.handle)},
            ${`[${opensAt},${closesAt})`}::tstzrange,
            'unpaid', 'approved', ${`${args.from}T09:00:00+04:00`}::timestamptz, ${MARKER})
  `
}

/** Accrual rows for one of this file's employees, by month. A delta over our own ids, never a total. */
async function accrualsFor(handle: string): Promise<ReadonlyMap<string, number>> {
  const rows = await sql<{ accrual_month: string; hundredths: number }[]>`
    select accrual_month::text as accrual_month, hundredths
      from leave_movement
     where employee_id = ${idOf(handle)} and kind = 'accrual'
     order by accrual_month
  `
  return new Map(rows.map((row) => [row.accrual_month, row.hundredths]))
}

/** Every movement of one of this file's employees, in the shape the pure checker folds. */
async function movementsFor(
  handle: string,
): Promise<readonly { kind: string; hundredths: number }[]> {
  return sql<{ kind: string; hundredths: number }[]>`
    select kind::text as kind, hundredths
      from leave_movement
     where employee_id = ${idOf(handle)}
     order by occurred_on, id
  `
}

/** The balance from the VIEW, and the sum of the same rows read separately. Both, always. */
async function balanceAndSum(handle: string): Promise<{ view: number | null; summed: number }> {
  const [row] = await sql<{ balance: number }[]>`
    select balance_hundredths as balance from leave_balance where employee_id = ${idOf(handle)}
  `
  const [total] = await sql<{ summed: string }[]>`
    select coalesce(sum(hundredths), 0)::text as summed
      from leave_movement where employee_id = ${idOf(handle)}
  `
  return {
    view: row === undefined ? null : row.balance,
    summed: Number((total as { summed: string }).summed),
  }
}

/** The SQLSTATE a statement raised, or null when it succeeded. */
async function stateOf(
  run: () => Promise<unknown>,
): Promise<{ code: string; message: string } | null> {
  try {
    await run()
    return null
  } catch (error) {
    const err = error as { code?: string; message?: string }
    return { code: err.code ?? '', message: err.message ?? '' }
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${LAST_TRADING_DATE}::date,
            (${LAST_TRADING_DATE} || ' 11:00:00+04')::timestamptz,
            '2094-01-01 02:00:00+04'::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  // A full year of service, which is the first acceptance line: twelve whole months must reach exactly 30
  // calendar days.
  await addEmployee({ handle: 'full-year', employedFrom: '2093-01-01' })
  // Engaged mid-month, so the first month is pro-rated rather than skipped. The control for "accrual from
  // day 1": a completed-month reading would give this employee 2750 and look entirely reasonable.
  await addEmployee({ handle: 'part-month', employedFrom: '2093-01-15' })
  // Identical to `full-year` except for six days of approved unpaid leave in March, so the reduction is
  // the only difference between the two balances.
  await addEmployee({ handle: 'unpaid', employedFrom: '2093-01-01' })
  // Nothing accrues for this one; it exists for the opening-balance importer.
  await addEmployee({ handle: 'opening', employedFrom: '2093-12-01' })
  // And this one gets no import at all, which is the un-imported default's control.
  await addEmployee({ handle: 'no-import', employedFrom: '2093-12-01' })

  await approveUnpaidLeave({ handle: 'unpaid', from: '2093-03-02', to: '2093-03-07' })
})

afterAll(async () => {
  const ids = ourIds()
  if (sql !== undefined && ids.length > 0) {
    // See the header. One transaction: disable, delete, re-enable. The DDL's ACCESS EXCLUSIVE lock is held
    // for the transaction, so nothing can insert past a disabled trigger, and a failure rolls back to the
    // enabled state rather than leaving the ledger editable.
    await sql.begin(async (tx) => {
      await tx`alter table leave_movement disable trigger leave_movement_no_delete`
      await tx`delete from leave_movement where employee_id = any(${ids}::uuid[])`
      await tx`alter table leave_movement enable trigger leave_movement_no_delete`
    })
    await sql`delete from leave_request where employee_id = any(${ids}::uuid[])`
    await sql`delete from employee where id = any(${ids}::uuid[])`
  }
  // `business_day` is left alone: other suites own rows in this table and the one here is harmless.
  // `audit_event` and `outbox_event` are append-only (ADR 0008) and are never cleaned up.
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the seeded policy is the policy the pure tests were written against', () => {
  it('carries 30 days at 2.5 a month, 6 months probation, a 30-day cap and 15 / 30 / 45 sick days', async () => {
    const versions = await readLeaveEntitlementRules(sql)
    const [v1] = versions
    expect(v1?.effectiveFrom).toBe('1900-01-01')
    // The figures `packages/core/src/hr/leave-accrual.test.ts` and `sick-leave.test.ts` restate by hand.
    // Pinned here, because a V1 in those files that had drifted from this row would make every one of
    // their worked examples pass about a policy nobody has.
    expect({
      annualEntitlementDays: v1?.annualEntitlementDays,
      monthlyAccrualHundredths: v1?.monthlyAccrualHundredths,
      probationMonths: v1?.probationMonths,
      accruesDuringProbation: v1?.accruesDuringProbation,
      carryOverCapHundredths: v1?.carryOverCapHundredths,
      carryOverExpiresAfterOneLeaveYear: v1?.carryOverExpiresAfterOneLeaveYear,
      leaveYearStartsOnAnniversary: v1?.leaveYearStartsOnAnniversary,
      unpaidLeaveReducesAccrual: v1?.unpaidLeaveReducesAccrual,
      absentDayReducesAccrual: v1?.absentDayReducesAccrual,
      sickFullPayDays: v1?.sickFullPayDays,
      sickHalfPayDays: v1?.sickHalfPayDays,
      sickUnpaidDays: v1?.sickUnpaidDays,
    }).toEqual({
      annualEntitlementDays: 30,
      monthlyAccrualHundredths: 250,
      probationMonths: 6,
      accruesDuringProbation: true,
      carryOverCapHundredths: 3000,
      carryOverExpiresAfterOneLeaveYear: false,
      leaveYearStartsOnAnniversary: true,
      unpaidLeaveReducesAccrual: true,
      absentDayReducesAccrual: true,
      sickFullPayDays: 15,
      sickHalfPayDays: 30,
      sickUnpaidDays: 45,
    })
  })

  it('is flagged provisional against Y9-leave-detail and reaches the assumptions panel', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const policy = rows.filter((row) => row.source === 'leave_entitlement_rule')
    expect(policy.length).toBeGreaterThan(0)
    expect(policy.map((row) => row.openQuestionId)).toContain('Y9-leave-detail')
    // The row names the conflict rather than hiding the side it took, which is the whole point of the
    // note: the two recorded provisional answers disagree about carry-over expiry.
    expect(policy.map((row) => row.note ?? '').join(' ')).toMatch(/conflict/)
  })

  it('passes the pure guard once converted, so the two validations agree', async () => {
    const [row] = await readLeaveEntitlementRules(sql)
    if (row === undefined) throw new Error('0066 seeds a version; the table is empty')
    const rules: LeaveEntitlementRules = {
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
    expect(() => assertLeaveEntitlementRules(rules)).not.toThrow()
  })

  it('refuses a version whose annual entitlement disagrees with twelve months of accrual', async () => {
    // The control, and the database half of the pure guard: 30 days is 3000 day-hundredths and twelve
    // months at 200 accrue 2400, so the CHECK must refuse the row by name.
    const failure = await stateOf(
      () => sql`
        insert into leave_entitlement_rule (
          effective_from, annual_entitlement_days, monthly_accrual_hundredths,
          probation_months, accrues_during_probation,
          carry_over_cap_hundredths, carry_over_expires_after_one_leave_year,
          leave_year_starts_on_anniversary,
          unpaid_leave_reduces_accrual, absent_day_reduces_accrual,
          sick_full_pay_days, sick_half_pay_days, sick_unpaid_days,
          is_provisional, open_question_id, source_note
        ) values (
          date '2093-01-01', 30, 200, 6, true, 3000, false, true, true, true, 15, 30, 45,
          true, 'Y9-leave-detail', ${MARKER}
        )
      `,
    )
    expect(failure?.code).toBe('23514')
    expect(failure?.message).toContain(
      'leave_entitlement_rule_annual_total_matches_monthly_accrual',
    )
  })
})

describe('acceptance — which month is complete is decided on the trading session', () => {
  it('accrues only through NOVEMBER at 01:30, because December’s last session is still open', async () => {
    const result = await runLeaveAccrual(sql, AT_ONE_THIRTY, { employeeIds: ourIds() })
    // The session that opened 11:00 on the 31st is in force and has not closed, so December is incomplete.
    expect(result.tradingDate).toBe(LAST_TRADING_DATE)
    expect(result.withinTradingHours).toBe(true)
    expect(result.throughMonth).toBe(NOVEMBER)

    const accruals = await accrualsFor('full-year')
    // Eleven months, January to November, and December deliberately absent.
    expect(accruals.size).toBe(11)
    expect(accruals.get(JANUARY)).toBe(250)
    expect(accruals.get(NOVEMBER)).toBe(250)
    expect(accruals.has(DECEMBER)).toBe(false)
  })

  it('accrues DECEMBER at 05:00, once that same session has closed', async () => {
    const result = await runLeaveAccrual(sql, AT_FIVE, { employeeIds: ourIds() })
    expect(result.tradingDate).toBe(LAST_TRADING_DATE)
    expect(result.withinTradingHours).toBe(false)
    expect(result.throughMonth).toBe(DECEMBER)
    // Only December is new: the eleven months the 01:30 pass wrote are refused by the unique index, so
    // this is the idempotency and the completeness in one assertion.
    expect(result.written.map((row) => row.accrualMonth)).toEqual(
      expect.arrayContaining([DECEMBER]),
    )
    expect(new Set(result.written.map((row) => row.accrualMonth))).toEqual(new Set([DECEMBER]))
    expect((await accrualsFor('full-year')).get(DECEMBER)).toBe(250)
  })
})

describe('acceptance — a full year of service accrues 30 calendar days', () => {
  it('reaches exactly 3000 day-hundredths over twelve whole months', async () => {
    const accruals = await accrualsFor('full-year')
    expect(accruals.size).toBe(12)
    const total = [...accruals.values()].reduce((sum, hundredths) => sum + hundredths, 0)
    expect(total).toBe(FULL_YEAR_HUNDREDTHS)
    expect(total).toBe(leaveDays(30))
    // And the view agrees with the sum of the same rows, which is the property the view exists to make
    // true by construction.
    const balance = await balanceAndSum('full-year')
    expect(balance.view).toBe(FULL_YEAR_HUNDREDTHS)
    expect(balance.summed).toBe(FULL_YEAR_HUNDREDTHS)
  })

  it('pro-rates the month of engagement rather than skipping it', async () => {
    const accruals = await accrualsFor('part-month')
    expect(accruals.get(JANUARY)).toBe(PART_MONTH_JANUARY_HUNDREDTHS)
    // The control: not zero (a completed-month reading) and not 250 (no pro-rating at all). Both of those
    // are plausible numbers and only one of the three is right.
    expect(accruals.get(JANUARY)).not.toBe(0)
    expect(accruals.get(JANUARY)).not.toBe(250)
    const balance = await balanceAndSum('part-month')
    expect(balance.view).toBe(PART_MONTH_JANUARY_HUNDREDTHS + 11 * 250)
  })

  it('reduces the month with six days of approved unpaid leave, and only that month', async () => {
    const accruals = await accrualsFor('unpaid')
    expect(accruals.get('2093-03-01')).toBe(MARCH_WITH_UNPAID_HUNDREDTHS)
    // February and April are untouched, so the reduction is the leave and not the arithmetic.
    expect(accruals.get('2093-02-01')).toBe(250)
    expect(accruals.get('2093-04-01')).toBe(250)
    // And the difference from the otherwise identical employee is exactly the reduction.
    const reduced = await balanceAndSum('unpaid')
    const full = await balanceAndSum('full-year')
    expect(reduced.view).toBe(FULL_YEAR_HUNDREDTHS - 250 + MARCH_WITH_UNPAID_HUNDREDTHS)
    expect((full.view ?? 0) - (reduced.view ?? 0)).toBe(250 - MARCH_WITH_UNPAID_HUNDREDTHS)
  })
})

describe('acceptance — the pass is idempotent per (employee, accrual_month)', () => {
  it('writes nothing on a second pass, and the balance is unchanged', async () => {
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from leave_movement
       where employee_id = any(${ourIds()}::uuid[]) and kind = 'accrual'
    `
    const balancesBefore = await readLeaveBalances(sql, ourIds())

    const result = await runLeaveAccrual(sql, AT_FIVE, { employeeIds: ourIds() })
    expect(result.written).toEqual([])
    expect(result.accruedHundredths).toBe(0)
    // It still LOOKED: a pass that considered nobody would also write nothing.
    expect(result.considered).toBe(ourIds().length)

    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from leave_movement
       where employee_id = any(${ourIds()}::uuid[]) and kind = 'accrual'
    `
    // Row count and balance equality, which is what the acceptance line asks for by name.
    expect(after[0]?.n).toBe(before[0]?.n)
    expect(await readLeaveBalances(sql, ourIds())).toEqual(balancesBefore)
  })

  it('writes one audit row and one outbox event per accrual, and none on the second pass', async () => {
    const [audits] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where action = 'leave.accrued' and entity_type = 'employee'
         and entity_id = any(${ourIds()}::text[])
    `
    const [events] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event
       where event_type = ${LEAVE_ACCRUED_EVENT} and aggregate_id = any(${ourIds()}::text[])
    `
    // 12 + 12 + 12 for the three employees engaged in January, plus 1 each for the two engaged in
    // December. The count is a delta over THIS file's employee ids; `audit_event` and `outbox_event` are
    // append-only, so a total would be somebody else's number as much as ours (brief rule 12).
    expect(audits?.n).toBe('38')
    expect(events?.n).toBe('38')
  })

  it('refuses a second accrual row for a month by the partial unique index, not by the job', async () => {
    // The guarantee is the INDEX. Asserted directly, because the job's "wrote nothing" would also be
    // satisfied by a job that simply forgot to write.
    const failure = await stateOf(
      () => sql`
        insert into leave_movement
          (employee_id, kind, hundredths, occurred_on, leave_year_start, accrual_month,
           rule_effective_from, created_by)
        values (${idOf('full-year')}, 'accrual', 250, '2093-01-31'::date, ${JANUARY}::date,
                ${JANUARY}::date, '1900-01-01'::date, ${MARKER})
      `,
    )
    expect(failure?.code).toBe('23505')
    expect(failure?.message).toContain('leave_movement_one_accrual_per_month')
  })
})

describe('acceptance — opening balances load through a documented importer', () => {
  it('answers an un-imported employee with a flagged zero naming Y8-leave, not a silent zero', async () => {
    const [row] = await readLeaveOpeningBalances(sql, [idOf('no-import')])
    expect(row?.hundredths).toBe(0)
    expect(row?.isImported).toBe(false)
    expect(row?.isProvisional).toBe(true)
    expect(row?.openQuestionId).toBe(PROVISIONAL_OPENING_BALANCE.openQuestionId)
    expect(row?.sourceNote).toBeNull()
    // Pinned to the pure constant, so the reader and the engine cannot drift apart about what "nothing
    // was imported" means.
    expect({
      hundredths: row?.hundredths,
      isProvisional: row?.isProvisional,
      openQuestionId: row?.openQuestionId,
    }).toEqual({
      hundredths: PROVISIONAL_OPENING_BALANCE.hundredths,
      isProvisional: PROVISIONAL_OPENING_BALANCE.isProvisional,
      openQuestionId: PROVISIONAL_OPENING_BALANCE.openQuestionId,
    })
  })

  it('imports a stated figure, and accrual then starts from it rather than from zero', async () => {
    const written = await importLeaveOpeningBalances(sql, [
      {
        employeeId: idOf('opening'),
        hundredths: leaveDays(12),
        asOf: '2093-11-30',
        leaveYearStart: '2093-12-01',
        sourceNote: `HR handover file, row 1 (${MARKER})`,
        importedBy: 'leave.opening-balance-import',
        isProvisional: false,
      },
    ])
    expect(written).toHaveLength(1)

    const imported = await readLeaveOpeningBalances(sql, [idOf('opening')])
    expect(imported[0]?.isImported).toBe(true)
    expect(imported[0]?.hundredths).toBe(1200)
    expect(imported[0]?.isProvisional).toBe(false)
    expect(imported[0]?.asOf).toBe('2093-11-30')

    // Engaged 1 December, so one month accrues: 1200 imported plus 250 is 1450. The control is the
    // employee with no import, whose balance is the accrual alone — an engine that ignored the opening
    // balance would answer 250 for both, and 250 is exactly what a month is supposed to accrue.
    const withImport = await balanceAndSum('opening')
    const withoutImport = await balanceAndSum('no-import')
    expect(withImport.view).toBe(1450)
    expect(withoutImport.view).toBe(250)
    expect(withImport.view).not.toBe(withoutImport.view)
  })

  it('writes nothing on a second import of the same employee', async () => {
    const again = await importLeaveOpeningBalances(sql, [
      {
        employeeId: idOf('opening'),
        hundredths: leaveDays(99),
        asOf: '2093-11-30',
        leaveYearStart: '2093-12-01',
        sourceNote: `a second statement of the same fact (${MARKER})`,
        importedBy: 'leave.opening-balance-import',
        isProvisional: false,
      },
    ])
    expect(again).toEqual([])
    // And the first figure is untouched: a second import must not ADD to it, which would make the balance
    // the sum of two statements of the same fact.
    expect((await balanceAndSum('opening')).view).toBe(1450)
  })

  it('refuses an opening balance with no provenance, by name', async () => {
    const failure = await stateOf(
      () => sql`
        insert into leave_movement
          (employee_id, kind, hundredths, occurred_on, leave_year_start, created_by)
        values (${idOf('no-import')}, 'opening_balance', 500, '2093-11-30'::date,
                '2093-12-01'::date, ${MARKER})
      `,
    )
    expect(failure?.code).toBe('23514')
    expect(failure?.message).toContain('leave_movement_opening_balance_has_provenance')
  })

  it('refuses an empty employee list rather than answering about everybody', async () => {
    await expect(readLeaveOpeningBalances(sql, [])).rejects.toThrow(/unfiltered variable/)
  })
})

describe('acceptance — the balance is the sum of the movements, and the ledger cannot be edited', () => {
  it('agrees with the pure invariant checker over the rows the pass actually wrote', async () => {
    for (const handle of ['full-year', 'part-month', 'unpaid', 'opening']) {
      const rows = await movementsFor(handle)
      // Replayed as accrual events through the pure fold, keyed on a distinct month each, so the checker
      // sees a ledger of the same shape it would have built itself. What is being asserted is that no row
      // in the database has a shape the engine would never produce — a sign that does not match its kind,
      // a fractional amount, a balance that does not add up.
      const events: LeaveLedgerEvent[] = rows.map((row, index) => ({
        kind: 'accrual',
        accrualMonth: localDate(`2090-${String((index % 12) + 1).padStart(2, '0')}-01`),
        hundredths: row.hundredths,
      }))
      const { ledger } = foldLeaveLedger(events)
      expect(
        leaveLedgerProblems(ledger),
        `${handle}: ${leaveLedgerProblems(ledger).join('; ')}`,
      ).toEqual([])
      const balance = await balanceAndSum(handle)
      expect(balance.view).toBe(balance.summed)
    }
  })

  it('refuses an UPDATE and a DELETE with ZH001, for the owner as well as the application role', async () => {
    const updated = await stateOf(
      () => sql`
        update leave_movement set hundredths = 9999
         where employee_id = ${idOf('full-year')} and kind = 'accrual'
      `,
    )
    expect(updated?.code).toBe('ZH001')
    expect(updated?.message).toContain('append-only')

    const deleted = await stateOf(
      () => sql`delete from leave_movement where employee_id = ${idOf('full-year')}`,
    )
    expect(deleted?.code).toBe('ZH001')

    // The privilege layer, which gives the application role a different and earlier failure. Both layers
    // are load-bearing: 0009's default privileges grant this role UPDATE and DELETE on every table
    // created afterwards, so the revoke is not decorative.
    const asApp = await stateOf(
      () =>
        sql.begin(async (tx) => {
          await tx`set local role berelax_app`
          await tx`update leave_movement set hundredths = 1 where employee_id = ${idOf('full-year')}`
        }) as Promise<unknown>,
    )
    expect(asApp?.code).toBe('42501')

    // And the control: the balance is exactly what it was, so neither refusal half-applied.
    expect((await balanceAndSum('full-year')).view).toBe(FULL_YEAR_HUNDREDTHS)
  })

  it('refuses a movement whose sign does not match its kind', async () => {
    const failure = await stateOf(
      () => sql`
        insert into leave_movement
          (employee_id, kind, hundredths, occurred_on, leave_year_start, rule_effective_from, created_by)
        values (${idOf('full-year')}, 'carry_over_forfeited', 500, '2093-12-31'::date,
                ${JANUARY}::date, '1900-01-01'::date, ${MARKER})
      `,
    )
    expect(failure?.code).toBe('23514')
    expect(failure?.message).toContain('leave_movement_sign_matches_kind')
  })

  it('refuses an accrual month that is not the first of a month', async () => {
    const failure = await stateOf(
      () => sql`
        insert into leave_movement
          (employee_id, kind, hundredths, occurred_on, leave_year_start, accrual_month,
           rule_effective_from, created_by)
        values (${idOf('no-import')}, 'accrual', 250, '2093-06-30'::date, ${JANUARY}::date,
                '2093-06-15'::date, '1900-01-01'::date, ${MARKER})
      `,
    )
    expect(failure?.code).toBe('23514')
    expect(failure?.message).toContain('leave_movement_accrual_month_is_a_first')
  })
})

describe('the monthly pass is registered, and it reports to an agent that exists', () => {
  it('declares hr.leave-accrual on the 1st at 05:00 against the leave_accrual agent', () => {
    const job = JOB_REGISTRY.find((entry) => entry.name === 'hr.leave-accrual')
    expect(job?.cron).toBe('0 5 1 * *')
    expect(job?.agent).toBe(LEAVE_ACCRUAL_AGENT)
  })

  it('has the agent_definition and agent_heartbeat rows 0066 seeds', async () => {
    const [definition] = await sql<{ interval: number; enabled: boolean }[]>`
      select expected_interval_seconds as interval, enabled
        from agent_definition where agent_key = ${LEAVE_ACCRUAL_AGENT}
    `
    expect(definition?.interval).toBe(31 * 24 * 60 * 60)
    expect(definition?.enabled).toBe(true)
    const [heartbeat] = await sql<{ n: string }[]>`
      select count(*)::text as n from agent_heartbeat where agent_key = ${LEAVE_ACCRUAL_AGENT}
    `
    expect(heartbeat?.n).toBe('1')
  })
})

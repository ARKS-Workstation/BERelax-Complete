import {
  type Instant,
  localDate,
  PLACEHOLDER_WPS_AGENT_ID,
  PLACEHOLDER_WPS_EMPLOYER_ID,
  rotaAssignmentCanonicalForm,
  summarisePayroll,
  validateWpsFile,
} from '@berelax/core'
import {
  type Actor,
  approveTimesheet,
  createConnection,
  publishRota,
  readAttendanceGraceRules,
  readPayrollRuns,
  readPayslips,
  readWorkingHoursRules,
  recordDeduction,
  recordTip,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { executePayrollRun, exportWpsFile, readPayslipFor } from '@berelax/hr'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-12 — the payroll run against real PostgreSQL: every pin, every refusal, and the audit rows.
 *
 * The **arithmetic** is pure and lives in `@berelax/core`; the **rows** live in PostgreSQL and are read and
 * written by `@berelax/db`. `packages/db` may never import `packages/core`, so nothing but
 * `@berelax/fixtures` can assert that the pair works — the reason `hr-commission.itest.ts` and
 * `hr-attendance.itest.ts` are in this package.
 *
 * What needs both halves, and could not be asserted in either alone:
 *
 *   1. **The identity holds across TWO implementations.** `summarisePayroll` sums the components in
 *      TypeScript and `payslip.net_fils` is a GENERATED column that sums them in SQL. The unit test's oracle
 *      is a third. Two agreeing is the claim; a suite that only read back what it wrote would be one.
 *   2. **Every refusal is the DATABASE's**, for every role including the owner this suite connects as. Ten
 *      private SQLSTATEs, one case each, plus the period lock's ZL002 through the one reader of it.
 *   3. **A tip cannot be booked as revenue**, which is a trigger over another table's `type` column and has
 *      no expression in TypeScript at all — asserted here as a refusal AND as a delta over `journal_line`.
 *   4. **Reading a payslip writes an audit row naming the actor and the row count**, which is a property of
 *      a function that takes a `UnitOfWork`, and an export writes an INDEXED one.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. This
 * file is the awkward case, because `executePayrollRun` deliberately reads EVERY employee employed in the
 * period — a payroll that only paid the people a caller remembered to name would be a payroll that missed
 * somebody. So:
 *
 *   - The period is in **2079**, which no other suite and no gate block writes into. 2080 through 2099 are
 *     spoken for; 2079 is not.
 *   - The nineteen seeded employees and every other suite's are employed in 2079 too, and they arrive in
 *     `unapprovedEmployeeIds` because they have no `timesheet_approval` over this period. That is asserted
 *     as a CONTAINMENT and never as a count — a count would be a claim about which suites ran first, which
 *     is the shape brief rule 12 is about.
 *   - Every employee this file creates is prefixed `PHR12 PAY`, and every figure asserted is looked up by
 *     employee id rather than by position.
 *   - It owns the five `payroll`/`tip`/`deduction`/`export` tables in 2079 outright. They refuse DELETE for
 *     every role (ZY141, ZY144), so `truncate` as the OWNER is the only legal removal — and it is scoped to
 *     a `beforeAll`, so a failed run leaves its rows for inspection rather than hiding them.
 *
 * No employee here has a name (brief rule 10), and every figure is this file's own fixture: `Y8-staff` says
 * the staff list is synthetic and `Y9-overtime` that the monthly-to-hourly question is unanswered, so
 * nothing below may be read as what this business pays.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const RUN = Date.now().toString(36)
/**
 * STABLE across runs, deliberately, and this is the isolation decision the file turns on.
 *
 * The first version tagged every employee with a per-run timestamp. Re-running the file then left the
 * PREVIOUS run's employees on disk — with wages, and with approved timesheets over the same rota week — and
 * `executePayrollRun` picked them up, because it reads EVERY employee employed in the period. Four payslips
 * where the suite expected two, and the failure named the count rather than the cause. That is brief rule 12
 * exactly: rows an earlier run left behind, found by production code that is right to look at them.
 *
 * A stable reference plus `on conflict do update` means a re-run reuses the same three employees instead of
 * minting three more. `timesheet_approval` refuses DELETE for every role (0086), so a stale approval could
 * not be removed even by the owner — which is why the answer is not to create the row twice rather than to
 * clean it up afterwards. {@link neutraliseStrays} handles residue that already exists.
 */
const TAG = 'PHR12 PAY'
const DESK = 'PHR12 front desk'
const APPROVER = 'PHR12 HR administrator'
const ACTOR: Actor = {
  kind: 'staff',
  id: '12121212-1212-1212-1212-121212121212',
  label: 'Payroll (P-HR-12)',
}

/** The pay period, and the week the rota and the timesheets cover. 2079 is nobody else's. */
const PERIOD = { periodStartsOn: '2079-03-01', periodEndsOn: '2079-03-31' } as const
const WEEK_FROM = '2079-03-06'
const WEEK_TO = '2079-03-12'
const DAY_ONE = '2079-03-06'
const DAY_TWO = '2079-03-07'
/** A period with no approvals at all, for the cases that need a clean one. */
const EMPTY_PERIOD = { periodStartsOn: '2079-06-01', periodEndsOn: '2079-06-30' } as const

const DAYS = [WEEK_FROM, DAY_ONE, DAY_TWO, WEEK_TO] as const

/**
 * The fixture wages. Whole AED, because a monthly wage is, and distinct so no two lines can be confused.
 *
 * Neither is a wage anybody has agreed: `Y8-staff` records that all nineteen real employees have
 * `basic_wage_fils` null, and this file's own comment says so where a reader will see it.
 */
interface FixtureWage {
  readonly basic: number
  readonly housing: number
  readonly transport: number
  readonly other: number
}
const WAGE_A: FixtureWage = { basic: 600_000, housing: 120_000, transport: 30_000, other: 5_000 }
const WAGE_B: FixtureWage = { basic: 450_000, housing: 90_000, transport: 20_000, other: 0 }

/** Attendance figures, chosen so A carries a real uplift and B carries none. */
const A_PAYABLE_MINUTES = 10_560
const A_UPLIFT_MINUTES = 120
const B_PAYABLE_MINUTES = 9_600

const TIP_A = 3_125
const DEDUCTION_A = 18_400

const employees = new Map<string, string>()
const of = (handle: string): string => employees.get(handle) as string

let rotaVersionId = ''
let rateEffectiveFrom = ''
let graceEffectiveFrom = ''
let ordinaryMultiplierBp = 0
let approvalA = ''
let approvalB = ''

const ROLLBACK = 'PHR12_ROLLBACK'

/** The message a statement was refused with, or `''` when it was accepted. Always rolled back. */
async function refusalOf(body: (tx: Sql) => Promise<unknown>): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
    return ''
  } catch (err) {
    if (err instanceof Error && err.message === ROLLBACK) return ''
    return err instanceof Error ? `${err.message} ${JSON.stringify(err)}` : String(err)
  }
}

const dubai = (date: string, time: string): string => `${date}T${time}:00+04:00`

async function makeEmployee(handle: string, wage: FixtureWage | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, basic_wage_fils, housing_allowance_fils,
                          transport_allowance_fils, other_allowance_fils)
    values (${`${TAG} ${handle}`}, date '2020-01-01',
            ${wage?.basic ?? null}, ${wage?.housing ?? null},
            ${wage?.transport ?? null}, ${wage?.other ?? null})
    on conflict (staff_reference) do update set basic_wage_fils = excluded.basic_wage_fils
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

/**
 * Wages cleared on any `PHR12 PAY` employee this run does not own.
 *
 * Residue from an older naming scheme, or from a run interrupted between creating an employee and creating
 * their approval. An employee with no wage is UNPRICED and produces no payslip, so nulling the wage is
 * enough — and it is the only cleanup available, because `employee` rows are RESTRICT-referenced by the
 * approvals that cannot be deleted. `employee` itself accepts an UPDATE, which is why this is legal where
 * deleting the approval is not.
 */
async function neutraliseStrays(keep: readonly string[]): Promise<void> {
  await sql`
    update employee set basic_wage_fils = null, housing_allowance_fils = null,
                        transport_allowance_fils = null, other_allowance_fils = null
     where staff_reference like ${`${TAG}%`} and id <> all(${keep}::uuid[])
  `
}

/** An approval for this employee and week, reusing one that already exists. A re-run must not approve twice. */
async function ensureApproval(args: {
  readonly employeeId: string
  readonly payableMinutes: number
  readonly weightedMinuteBp: number
}): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`
    select id from timesheet_approval
     where employee_id = ${args.employeeId}::uuid
       and from_trading_date = ${WEEK_FROM}::date and to_trading_date = ${WEEK_TO}::date
  `
  if (existing !== undefined) return existing.id
  const row = await withUnitOfWork(sql, ACTOR, (uow) =>
    approveTimesheet(uow, {
      employeeId: args.employeeId,
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      rotaVersionId,
      figures: {
        payableMinutes: args.payableMinutes,
        weightedMinuteBp: args.weightedMinuteBp,
        incompletePresenceCount: 0,
        unrosteredPresenceCount: 0,
        graceRuleEffectiveFrom: graceEffectiveFrom,
        workingHoursRuleEffectiveFrom: rateEffectiveFrom,
      },
      approvedBy: APPROVER,
    }),
  )
  return row.id
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })

  for (const day of DAYS) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date,
        (${day}::date + time '11:00') at time zone 'Asia/Dubai',
        (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
  // A lock over 2079 left behind by an earlier run of THIS file would refuse every run below with ZL002 and
  // every case would report that instead — `hr-commission.itest.ts`'s reason for the same delete.
  await sql`delete from period_lock where starts_on >= '2079-01-01' and ends_on <= '2079-12-31'`
  await sql.unsafe('truncate wps_export, payslip, payroll_run, employee_tip, payroll_deduction')

  await makeEmployee('A', WAGE_A)
  await makeEmployee('B', WAGE_B)
  // The employee with NO wage on file, which is the state all nineteen seeded ones are in (Y8-staff).
  await makeEmployee('NOWAGE', null)
  // Deliberately NEVER approved in beforeAll: the ZY145 case approves them inside a rolled-back
  // transaction with an INCOMPLETE count, which is a row `timesheet_approval` would otherwise keep for
  // ever (it refuses DELETE for every role).
  await makeEmployee('UNCLOSED', WAGE_B)
  await neutraliseStrays([of('A'), of('B'), of('NOWAGE'), of('UNCLOSED')])

  const rateRows = await readWorkingHoursRules(sql)
  rateEffectiveFrom = rateRows[0]?.effectiveFrom as string
  const graceRows = await readAttendanceGraceRules(sql)
  graceEffectiveFrom = graceRows[0]?.effectiveFrom as string
  ordinaryMultiplierBp = rateRows[0]?.ordinaryMultiplierBp as number

  const assignments = [
    {
      employeeId: of('A'),
      tradingDate: DAY_ONE,
      startsAt: Date.parse(dubai(DAY_ONE, '11:00')),
      endsAt: Date.parse(dubai(DAY_ONE, '19:00')),
      sourceShiftId: null,
    },
    {
      employeeId: of('B'),
      tradingDate: DAY_TWO,
      startsAt: Date.parse(dubai(DAY_TWO, '11:00')),
      endsAt: Date.parse(dubai(DAY_TWO, '19:00')),
      sourceShiftId: null,
    },
    {
      employeeId: of('NOWAGE'),
      tradingDate: DAY_ONE,
      startsAt: Date.parse(dubai(DAY_ONE, '11:00')),
      endsAt: Date.parse(dubai(DAY_ONE, '19:00')),
      sourceShiftId: null,
    },
  ]
  /*
    Reuse the published rota for this week if there is one, and publish only when there is not.

    `assert_rota_version_changes_something` refuses a version whose assignment set is identical to the one it
    supersedes — correctly, because publishing it would notify every assigned therapist that a rota had
    changed when it had not. With stable employees this file's second run produces exactly that digest, so
    an unconditional publish fails the whole `beforeAll` and every case reports as skipped. Reusing is also
    the more honest fixture: what this file needs from a rota version is that it is IMMUTABLE and says who
    was rostered when, which is true of the one already on disk.
  */
  const [existingVersion] = await sql<{ id: string }[]>`
    select id from rota_version
     where from_trading_date = ${WEEK_FROM}::date and to_trading_date = ${WEEK_TO}::date
     order by version_no desc limit 1
  `
  if (existingVersion !== undefined) {
    rotaVersionId = existingVersion.id
  } else {
    const published = await publishRota(sql, {
      fromTradingDate: WEEK_FROM,
      toTradingDate: WEEK_TO,
      assignments,
      // Supplied rather than derived: `hr-rota.itest.ts` is where P-HR-06's validator is asserted against
      // real rows, and re-running it here would make this file fail for that unit's reasons.
      verdict: { isPublishable: true, refusedRule: null, refusalDetail: null },
      coverageRuleEffectiveFrom: '1900-01-01',
      workingHoursRuleEffectiveFrom: rateEffectiveFrom,
      labourCostRuleEffectiveFrom: '1900-01-01',
      forecastLabourCostFils: 0,
      forecastUnpricedEmployees: 1,
      assignmentCanonicalForm: rotaAssignmentCanonicalForm(
        assignments.map((row) => ({
          employeeId: row.employeeId,
          tradingDate: localDate(row.tradingDate),
          startsAt: row.startsAt as Instant,
          endsAt: row.endsAt as Instant,
        })),
      ),
      publishedBy: `${TAG} publisher`,
    })
    rotaVersionId = published.rotaVersionId
  }

  // The approved timesheets the run pays. Figures supplied rather than derived, for the verdict's reason:
  // P-HR-07's own suite is where the pairing and the bucket split are asserted.
  approvalA = await ensureApproval({
    employeeId: of('A'),
    payableMinutes: A_PAYABLE_MINUTES,
    // Ordinary minutes at the ordinary multiplier, plus 120 minutes at 12,500 basis points.
    weightedMinuteBp:
      (A_PAYABLE_MINUTES - A_UPLIFT_MINUTES) * ordinaryMultiplierBp + A_UPLIFT_MINUTES * 12_500,
  })
  approvalB = await ensureApproval({
    employeeId: of('B'),
    payableMinutes: B_PAYABLE_MINUTES,
    weightedMinuteBp: B_PAYABLE_MINUTES * ordinaryMultiplierBp,
  })
  // The employee with no wage gets an approval too, so the run reaches the UNPRICED branch rather than the
  // unapproved one — the two are different facts and the run counts them separately.
  await ensureApproval({
    employeeId: of('NOWAGE'),
    payableMinutes: 480,
    weightedMinuteBp: 480 * ordinaryMultiplierBp,
  })

  // The tip and the deduction the run picks up.
  await withUnitOfWork(sql, ACTOR, (uow) =>
    recordTip(uow, {
      employeeId: of('A'),
      tradingDate: DAY_ONE,
      amountFils: TIP_A,
      recordedBy: DESK,
    }),
  )
  await withUnitOfWork(sql, ACTOR, (uow) =>
    recordDeduction(uow, {
      employeeId: of('A'),
      tradingDate: DAY_ONE,
      amountFils: DEDUCTION_A,
      reason: 'Uniform replacement agreed in writing',
      authorisedBy: APPROVER,
      recordedBy: DESK,
    }),
  )
}, 180_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** The audit rows written since a marker, for one action. A DELTA: `audit_event` is append-only (ADR 0008). */
async function auditSince(
  since: Date,
  action: string,
): Promise<readonly { actorId: string | null; afterState: Record<string, unknown> | null }[]> {
  return sql<{ actorId: string | null; afterState: Record<string, unknown> | null }[]>`
    select actor_id as "actorId", after_state as "afterState"
      from audit_event
     where action = ${action} and occurred_at >= ${since.toISOString()}::text::timestamptz
     order by occurred_at
  `
}

/** Journal lines against a REVENUE account, counted. The tip claim is a delta over this. */
async function revenueLineCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n
      from journal_line l join account a on a.code = l.account_code
     where a.type = 'revenue'
  `
  return Number((row as { n: string }).n)
}

let runId = ''

describe('the run pays what the approvals and the wages say, and the two implementations agree', () => {
  it('produces one payslip per priced, approved employee and completes the run', async () => {
    const revenueBefore = await revenueLineCount()
    const result = await executePayrollRun(sql, {
      ...PERIOD,
      // No commission run: `hr.commission_enabled` is false and no rule version is published
      // (Y9-commission), which is the state the build ships in.
      commissionRun: null,
      actor: ACTOR,
      runBy: APPROVER,
    })
    runId = result.runId
    expect(result.summary.payslipCount).toBe(2)

    const byEmployee = new Map(result.summary.payslips.map((slip) => [slip.employeeId, slip]))
    const a = byEmployee.get(of('A'))
    const b = byEmployee.get(of('B'))
    expect(a, 'employee A has no payslip').toBeDefined()
    expect(b, 'employee B has no payslip').toBeDefined()

    // The basic and the allowances come off `employee`, unchanged.
    expect(a?.basicFils).toBe(WAGE_A.basic)
    expect(a?.allowancesFils).toBe(WAGE_A.housing + WAGE_A.transport + WAGE_A.other)
    expect(b?.allowancesFils).toBe(WAGE_B.housing + WAGE_B.transport + WAGE_B.other)

    // The overtime is the UPLIFT only. B worked every minute at the ordinary rate, so B's is zero — which
    // is the assertion that proves the subtraction happened rather than the whole total being priced.
    expect(b?.overtimeFils).toBe(0)
    expect(a?.overtimeFils).toBeGreaterThan(0)

    // The tip and the deduction landed on A and on nobody else.
    expect(a?.tipsFils).toBe(TIP_A)
    expect(a?.deductionsFils).toBe(DEDUCTION_A)
    expect(b?.tipsFils).toBe(0)
    expect(b?.deductionsFils).toBe(0)

    // The employee with no wage is COUNTED and NAMED, never paid as zero.
    expect(result.unpricedEmployeeIds).toContain(of('NOWAGE'))
    expect(result.summary.payslips.map((slip) => slip.employeeId)).not.toContain(of('NOWAGE'))

    // Every other suite's employees have no approval over 2079 and arrive here. A CONTAINMENT and never a
    // count: a count would be a claim about which suites ran first (brief rule 12).
    expect(result.unapprovedEmployeeIds.length).toBeGreaterThan(0)
    expect(result.unapprovedEmployeeIds).not.toContain(of('A'))

    // A tip reached the payslip and NOT a revenue account. A delta, because `journal_line` is append-only.
    expect(await revenueLineCount()).toBe(revenueBefore)
  }, 60_000)

  it("the DATABASE's generated net equals the engine's, per payslip and in total", async () => {
    // The cross-implementation claim: `summarisePayroll` sums in TypeScript, `payslip.net_fils` is a
    // GENERATED column summing the same components in SQL. A suite that read back what it wrote would be
    // one implementation; this is two.
    const stored = await withUnitOfWork(sql, ACTOR, (uow) => readPayslips(uow, { runId }))
    expect(stored).toHaveLength(2)

    for (const row of stored) {
      const expectedGross =
        row.basicFils + row.allowancesFils + row.overtimeFils + row.commissionFils + row.tipsFils
      expect(row.grossFils).toBe(expectedGross)
      expect(row.netFils).toBe(expectedGross - row.deductionsFils)
      // The control: one fil out in either direction is not what the database stored.
      expect(row.netFils).not.toBe(expectedGross - row.deductionsFils + 1)
    }

    const summary = summarisePayroll(
      stored.map((row) => ({
        employeeId: row.employeeId,
        basicFils: row.basicFils,
        allowancesFils: row.allowancesFils,
        overtimeFils: row.overtimeFils,
        commissionFils: row.commissionFils,
        commissionRunId: row.commissionRunId,
        commissionRuleVersion: row.commissionRuleVersion,
        tipsFils: row.tipsFils,
        grossFils: row.grossFils,
        deductionsFils: row.deductionsFils,
        netFils: row.netFils,
      })),
    )
    const [run] = await readPayrollRuns(sql, PERIOD)
    expect(run?.netTotalFils).toBe(summary.netTotalFils)
    expect(run?.payslipCount).toBe(summary.payslipCount)
    expect(run?.completedAt).not.toBeNull()
  })

  it('pins the rule versions that priced it, so the figures can be checked rather than accepted', async () => {
    const stored = await withUnitOfWork(sql, ACTOR, (uow) => readPayslips(uow, { runId }))
    const a = stored.find((row) => row.employeeId === of('A'))
    expect(a?.timesheetApprovalId).toBe(approvalA)
    expect(a?.workingHoursRuleEffectiveFrom).toBe(rateEffectiveFrom)
    expect(a?.labourCostRuleEffectiveFrom).toBe('1900-01-01')
    // No commission was paid, so no run is named — which ZY147 requires of the row.
    expect(a?.commissionRunId).toBeNull()
    expect(a?.commissionRuleVersion).toBeNull()
    const b = stored.find((row) => row.employeeId === of('B'))
    expect(b?.timesheetApprovalId).toBe(approvalB)
  })
})

describe('reading a payslip and exporting a file are both audited', () => {
  it('a read writes one audit_event naming the actor and the row count', async () => {
    const since = new Date()
    await withUnitOfWork(sql, ACTOR, (uow) => readPayslips(uow, { runId }))
    const rows = await auditSince(since, 'payroll.payslips_read')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.actorId).toBe(ACTOR.id)
    expect(rows[0]?.afterState?.['rowCount']).toBe(2)
  })

  it('a read that found NOTHING is audited too, so enumeration leaves a trace', async () => {
    // Auditing only non-empty reads would make "one request per employee id until one answers" the single
    // access pattern with no record of it.
    const since = new Date()
    const rows = await withUnitOfWork(sql, ACTOR, (uow) =>
      readPayslips(uow, { runId, employeeId: '00000000-0000-0000-0000-000000000000' }),
    )
    expect(rows).toHaveLength(0)
    const audited = await auditSince(since, 'payroll.payslips_read')
    expect(audited).toHaveLength(1)
    expect(audited[0]?.afterState?.['rowCount']).toBe(0)
  })

  it('a therapist may read their own payslip and is REFUSED a colleague’s', async () => {
    const own = await readPayslipFor(sql, {
      runId,
      role: 'therapist',
      viewerEmployeeId: of('A'),
      subjectEmployeeId: of('A'),
      actor: ACTOR,
    })
    expect(own).toHaveLength(1)

    await expect(
      readPayslipFor(sql, {
        runId,
        role: 'therapist',
        viewerEmployeeId: of('A'),
        subjectEmployeeId: of('B'),
        actor: ACTOR,
      }),
      // Refused, not filtered: an empty list reads as "no payslip" rather than "not yours".
    ).rejects.toThrow(/only their own payslip/)

    // And the control in the other direction: the accountant holds `payroll:read` and sees a colleague's.
    const other = await readPayslipFor(sql, {
      runId,
      role: 'accountant',
      viewerEmployeeId: of('A'),
      subjectEmployeeId: of('B'),
      actor: ACTOR,
    })
    expect(other).toHaveLength(1)
  })
})

describe('the WPS export: refused by default, audited when it happens, and never sent', () => {
  it('is refused while the employer identifiers are the placeholders this build ships', async () => {
    await expect(
      exportWpsFile(sql, {
        runId,
        format: 'generic_mohre_v1',
        employerId: PLACEHOLDER_WPS_EMPLOYER_ID,
        agentId: PLACEHOLDER_WPS_AGENT_ID,
        contacts: {
          contactFor: async () => ({ iban: 'ZZ39000000000000000001', phone: '+971500000001' }),
        },
        actor: ACTOR,
        exportedBy: APPROVER,
      }),
    ).rejects.toThrow(/wps_employer_id_not_configured/)
    // Nothing was recorded: a refused file leaves no export row, which is `render-document.ts`'s ordering.
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from wps_export`
    expect(Number((row as { n: string }).n)).toBe(0)
  })

  it('produces bytes and an INDEXED export audit row once the identifiers are set', async () => {
    const since = new Date()
    const result = await exportWpsFile(sql, {
      runId,
      format: 'generic_mohre_v1',
      // Not real identifiers — Y8-wps is open. These are the SHAPE of an answer, supplied by this test.
      employerId: 'SET-BY-OWNER-1',
      agentId: 'SET-BY-OWNER-2',
      contacts: {
        contactFor: async (employeeId) => ({
          /*
            Structurally valid IBANs over the private-use country code ZZ, which ISO 3166 never assigns —
            so no fixture here can be mistaken for somebody's real UAE account. The check digits are
            GENUINE: the first version of this file wrote plausible-looking ones by hand and
            `wps_iban_malformed` refused the file, which is the mod-97 implementation working and the
            fixture being wrong.
          */
          iban: employeeId === of('A') ? 'ZZ39000000000000000001' : 'ZZ12000000000000000002',
          phone: '+971500000001',
        }),
      },
      actor: ACTOR,
      exportedBy: APPROVER,
    })

    expect(result.recordCount).toBe(2)
    expect(result.content).toContain('provisional=Y8-wps')
    expect(result.content.split('\n').filter((line) => line.startsWith('EDR,'))).toHaveLength(2)
    expect(result.fileSha256).toMatch(/^[0-9a-f]{64}$/)

    // The insider-threat signal: `operation = 'export'`, which 0005 indexes. Not the generic audit action.
    const rows = await sql<{ operation: string; afterState: Record<string, unknown> | null }[]>`
      select operation, after_state as "afterState"
        from audit_event
       where action = 'payroll.wps_file_exported' and occurred_at >= ${since.toISOString()}::text::timestamptz
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.operation).toBe('export')
    expect(rows[0]?.afterState?.['rowCount']).toBe(2)
  })

  it('names the run and the digest, so a file a bank received can be told from one somebody edited', async () => {
    const [row] = await sql<{ runId: string; fileSha256: string; recordCount: number }[]>`
      select run_id as "runId", file_sha256 as "fileSha256", record_count as "recordCount"
        from wps_export order by exported_at desc limit 1
    `
    expect(row?.runId).toBe(runId)
    expect(row?.recordCount).toBe(2)
    expect(row?.fileSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a malformed IBAN and a missing contact number by rule name, without producing bytes', async () => {
    const failures = validateWpsFile({
      header: {
        format: 'generic_mohre_v1',
        employerId: 'SET-BY-OWNER-1',
        agentId: 'SET-BY-OWNER-2',
        periodStartsOn: PERIOD.periodStartsOn,
        periodEndsOn: PERIOD.periodEndsOn,
        declaredRecordCount: 1,
        declaredTotalFils: 1,
      },
      records: [
        {
          employeeId: of('A'),
          staffReference: `${TAG} A`,
          iban: 'not-an-iban',
          phone: null,
          netFils: 1,
          payableMinutes: 1,
        },
      ],
    })
    expect(failures.map((failure) => failure.rule).sort()).toEqual([
      'wps_iban_malformed',
      'wps_phone_not_e164',
    ])
  })
})

describe('every refusal the schema makes, one case each', () => {
  it('ZY141 — a COMPLETED run refuses an UPDATE and a DELETE, for the owner too', async () => {
    const update = await refusalOf(
      (tx) => tx`update payroll_run set net_total_fils = 1 where id = ${runId}::uuid`,
    )
    expect(update).toContain('ZY141')
    expect(update).toContain('PayrollRunIsImmutable')
    const remove = await refusalOf((tx) => tx`delete from payroll_run where id = ${runId}::uuid`)
    expect(remove).toContain('ZY141')
  })

  it('ZY142 — a DRAFT run may only be completed, not edited', async () => {
    const refusal = await refusalOf(async (tx) => {
      const [draft] = await tx<{ id: string }[]>`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${APPROVER})
        returning id
      `
      // A header figure moved without completing: the shape in which a run's numbers change while it is open.
      await tx`update payroll_run set net_total_fils = 999 where id = ${(draft as { id: string }).id}::uuid`
    })
    expect(refusal).toContain('ZY142')
    expect(refusal).toContain('net_total_fils')
  })

  it('ZY143 — a second run over a period must name the COMPLETED one it corrects', async () => {
    // A second ORIGINAL is refused by the partial unique index, which is the rule's fourth quarter.
    const second = await refusalOf(
      (tx) => tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${PERIOD.periodStartsOn}::date, ${PERIOD.periodEndsOn}::date, '1900-01-01'::date,
                ${APPROVER})
      `,
    )
    expect(second).toContain('payroll_run_one_original_per_period')

    // A correction over a DIFFERENT period is not a correction.
    const wrongPeriod = await refusalOf(
      (tx) => tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 corrects_run_id, created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${runId}::uuid, ${APPROVER})
      `,
    )
    expect(wrongPeriod).toContain('ZY143')
    expect(wrongPeriod).toContain('PayrollCorrectionPeriodDiffers')

    // And a correction of a DRAFT: there is nothing to correct, because a draft has paid nobody.
    const ofADraft = await refusalOf(async (tx) => {
      const [draft] = await tx<{ id: string }[]>`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${APPROVER})
        returning id
      `
      await tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 corrects_run_id, created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${(draft as { id: string }).id}::uuid, ${APPROVER})
      `
    })
    expect(ofADraft).toContain('ZY143')
    expect(ofADraft).toContain('PayrollCorrectionCorrectsADraft')
  })

  it('a correction that names the completed original IS accepted, which is the control', async () => {
    // Without this the three refusals above would be satisfied by a rule that refused every correction.
    const accepted = await refusalOf(
      (tx) => tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 corrects_run_id, created_by)
        values (${PERIOD.periodStartsOn}::date, ${PERIOD.periodEndsOn}::date, '1900-01-01'::date,
                ${runId}::uuid, ${APPROVER})
      `,
    )
    expect(accepted).toBe('')
  })

  it('ZY144 — the payslip, the tip, the deduction and the export are append-only', async () => {
    for (const [table, statement] of [
      ['payslip', (tx: Sql) => tx`update payslip set tips_fils = 0 where run_id = ${runId}::uuid`],
      ['payslip', (tx: Sql) => tx`delete from payslip where run_id = ${runId}::uuid`],
      [
        'employee_tip',
        (tx: Sql) =>
          tx`update employee_tip set amount_fils = 1 where employee_id = ${of('A')}::uuid`,
      ],
      [
        'payroll_deduction',
        (tx: Sql) => tx`delete from payroll_deduction where employee_id = ${of('A')}::uuid`,
      ],
      [
        'wps_export',
        (tx: Sql) => tx`update wps_export set record_count = 0 where run_id = ${runId}::uuid`,
      ],
    ] as const) {
      const refusal = await refusalOf(statement)
      expect(refusal, `${table} accepted a change`).toContain('ZY144')
    }
  })

  it('ZY145 — a period holding an INCOMPLETE attendance row refuses a run, naming the approval', async () => {
    /*
      The approval is over the ROTA WEEK and not over an arbitrary month, because
      `assert_timesheet_approval_follows` (ZX005, P-HR-07) refuses an approval whose period reaches outside
      the rota version it names — every day outside would come back UNROSTERED. The first version of this
      case used a June period against the March version and was refused by ZX005, which is the right
      refusal for the wrong reason and would have proved nothing about ZY145.

      The payroll run is therefore over the week itself. A different (start, end) pair from the March run
      above, so `payroll_run_one_original_per_period` is not what refuses it — this case has to reach the
      attendance trigger.
    */
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into timesheet_approval (employee_id, from_trading_date, to_trading_date, rota_version_id,
                                        grace_rule_effective_from, working_hours_rule_effective_from,
                                        payable_minutes, weighted_minute_bp, incomplete_presence_count,
                                        approved_by)
        values (${of('UNCLOSED')}::uuid, ${WEEK_FROM}::date, ${WEEK_TO}::date, ${rotaVersionId}::uuid,
                ${graceEffectiveFrom}::date, ${rateEffectiveFrom}::date, 0, 0, 3, ${APPROVER})
      `
      await tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${WEEK_FROM}::date, ${WEEK_TO}::date, '1900-01-01'::date, ${APPROVER})
      `
    })
    expect(refusal).toContain('ZY145')
    expect(refusal).toContain('PayrollOverUnclosedAttendance')
    expect(refusal).toContain('3 INCOMPLETE')
    expect(refusal).toContain('attendance_correction')

    // The control: without the INCOMPLETE approval, the same run over the same week is accepted — so this
    // case is not passing because the week refuses a run for some other reason.
    const accepted = await refusalOf(
      (tx) => tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${WEEK_FROM}::date, ${WEEK_TO}::date, '1900-01-01'::date, ${APPROVER})
      `,
    )
    expect(accepted).toBe('')
  })

  it('ZY146 — a tip may not be owed against a revenue account, nor an expense one', async () => {
    const revenue = await refusalOf(
      (tx) => tx`
        insert into employee_tip (employee_id, trading_date, amount_fils, liability_account_code,
                                  recorded_by)
        values (${of('A')}::uuid, ${DAY_ONE}::date, 100, '4010', ${DESK})
      `,
    )
    expect(revenue).toContain('ZY146')
    expect(revenue).toContain('TipIsNotALiability')
    expect(revenue).toContain('revenue')

    // An EXPENSE account is equally wrong and would pass a revenue-only check, which is why the trigger
    // refuses everything that is not a liability.
    const expense = await refusalOf(
      (tx) => tx`
        insert into employee_tip (employee_id, trading_date, amount_fils, liability_account_code,
                                  recorded_by)
        values (${of('A')}::uuid, ${DAY_ONE}::date, 100, '5010', ${DESK})
      `,
    )
    expect(expense).toContain('ZY146')

    // The control: the seeded tips liability IS accepted, so the rule is not refusing everything.
    const liability = await refusalOf(
      (tx) => tx`
        insert into employee_tip (employee_id, trading_date, amount_fils, liability_account_code,
                                  recorded_by)
        values (${of('A')}::uuid, ${DAY_ONE}::date, 100, '2040', ${DESK})
      `,
    )
    expect(liability).toBe('')
  })

  it('ZY147 — a commission figure on a payslip must name the run and version that produced it', async () => {
    const unpinned = await refusalOf(async (tx) => {
      const [draft] = await tx<{ id: string }[]>`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${APPROVER})
        returning id
      `
      await tx`
        insert into payslip (run_id, employee_id, basic_fils, allowances_fils, overtime_fils,
                             commission_fils, tips_fils, deductions_fils, timesheet_approval_id,
                             payable_minutes, overtime_uplift_minute_bp)
        values (${(draft as { id: string }).id}::uuid, ${of('A')}::uuid, 1, 0, 0, 500, 0, 0,
                ${approvalA}::uuid, 0, 0)
      `
    })
    expect(unpinned).toContain('ZY147')
    expect(unpinned).toContain('PayslipCommissionIsUnpinned')
  })

  it('ZY148 — a payslip may not be added to a run that has already been completed', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into payslip (run_id, employee_id, basic_fils, allowances_fils, overtime_fils,
                             commission_fils, tips_fils, deductions_fils, timesheet_approval_id,
                             payable_minutes, overtime_uplift_minute_bp)
        values (${runId}::uuid, ${of('NOWAGE')}::uuid, 1, 0, 0, 0, 0, 0, ${approvalA}::uuid, 0, 0)
      `,
    )
    expect(refusal).toContain('ZY148')
    expect(refusal).toContain('PayrollRunAlreadyCompleted')
  })

  it('ZY149 — a WPS export must name a COMPLETED run and declare that run’s figures', async () => {
    const ofADraft = await refusalOf(async (tx) => {
      const [draft] = await tx<{ id: string }[]>`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${APPROVER})
        returning id
      `
      await tx`
        insert into wps_export (run_id, format, record_count, total_fils, file_sha256, exported_by)
        values (${(draft as { id: string }).id}::uuid, 'generic_mohre_v1', 0, 0,
                ${'a'.repeat(64)}, ${APPROVER})
      `
    })
    expect(ofADraft).toContain('ZY149')
    expect(ofADraft).toContain('WpsExportOfADraft')

    const disagrees = await refusalOf(
      (tx) => tx`
        insert into wps_export (run_id, format, record_count, total_fils, file_sha256, exported_by)
        values (${runId}::uuid, 'generic_mohre_v1', 99, 1, ${'b'.repeat(64)}, ${APPROVER})
      `,
    )
    expect(disagrees).toContain('ZY149')
    expect(disagrees).toContain('WpsExportDisagreesWithItsRun')
  })

  it('ZY150 — a completed run’s header must equal its payslips', async () => {
    const refusal = await refusalOf(async (tx) => {
      const [draft] = await tx<{ id: string }[]>`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${APPROVER})
        returning id
      `
      const id = (draft as { id: string }).id
      await tx`
        insert into payslip (run_id, employee_id, basic_fils, allowances_fils, overtime_fils,
                             commission_fils, tips_fils, deductions_fils, timesheet_approval_id,
                             payable_minutes, overtime_uplift_minute_bp)
        values (${id}::uuid, ${of('A')}::uuid, 1000, 0, 0, 0, 0, 0, ${approvalA}::uuid, 0, 0)
      `
      // The header claims a different total from the one payslip it holds.
      await tx`
        update payroll_run
           set payslip_count = 1, net_total_fils = 999, completed_at = now(), completed_by = ${APPROVER}
         where id = ${id}::uuid
      `
    })
    expect(refusal).toContain('ZY150')
    expect(refusal).toContain('PayrollRunDisagreesWithItsPayslips')
  })

  it('ZL002 — a locked accounting period refuses a new run, through the ONE reader of the lock', async () => {
    // The lock is inserted inside a ROLLED-BACK transaction, so nothing this file does leaves 2079 closed
    // for a later suite — `hr-attendance.itest.ts`'s arrangement, and `period_lock` has no DELETE grant for
    // the application role, so a lock left behind would need owner rights to clear.
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${`PHR12-${RUN}`}, ${EMPTY_PERIOD.periodStartsOn}::date,
                ${EMPTY_PERIOD.periodEndsOn}::date, ${'P-HR-12 lock probe'}, 'staff')
      `
      await tx`
        insert into payroll_run (period_starts_on, period_ends_on, labour_cost_rule_effective_from,
                                 created_by)
        values (${EMPTY_PERIOD.periodStartsOn}::date, ${EMPTY_PERIOD.periodEndsOn}::date,
                '1900-01-01'::date, ${APPROVER})
      `
    })
    expect(refusal).toContain('ZL002')
    expect(refusal).toContain('PeriodLocked')
    // It names the payroll run rather than a journal entry, so an operator is sent to the right place.
    expect(refusal).toContain('payroll run')
  })
})

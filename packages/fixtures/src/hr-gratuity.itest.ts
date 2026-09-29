import {
  accountCode,
  accrueGratuityMonth,
  correctGratuityOverAccrual,
  type GratuityAccounts,
  type GratuityRules,
  gratuityAccrualEntry,
  gratuityLiabilityAt,
  gratuitySettlementEntry,
  localDate,
  monthEnd,
  postEntry,
  reverseEntry,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  type GratuityAccrualInput,
  type JournalEntryInput,
  postGratuityAccrual,
  postGratuityCorrection,
  postGratuitySettlement,
  readGratuityAccruals,
  readGratuityLiabilities,
  readGratuityRules,
  readSetting,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
  GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
  GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
} from '@berelax/shared'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-13 — the gratuity liability against real PostgreSQL: every refusal, the reconciliation, and zero.
 *
 * The **arithmetic** is pure and lives in `@berelax/core`; the **rows** live in PostgreSQL and are read and
 * written by `@berelax/db`. `packages/db` may never import `packages/core`, so nothing but
 * `@berelax/fixtures` can assert that the pair works — the reason `hr-payroll.itest.ts` and
 * `hr-attendance.itest.ts` are in this package too.
 *
 * What needs both halves, and could not be asserted in either alone:
 *
 *   1. **The liability is the same figure in TypeScript and in SQL.** `gratuityLiabilityAt` computes it in
 *      `BigInt`; `employee_gratuity_liability` sums the rows in SQL; the worked examples are a third oracle.
 *      Two agreeing is the claim. A suite that only read back what it wrote would be one.
 *   2. **Every refusal is the DATABASE's**, for every role including the owner this suite connects as. Seven
 *      private SQLSTATEs, a case each, plus the journal's own ZL001 and ZL002 through the one reader of them.
 *   3. **A leaver's liability nets to EXACTLY zero fils**, end to end from accrual to settlement — and it is
 *      the database that enforces the amount (ZY175), which has no expression in TypeScript at all.
 *   4. **An accrual whose month has been locked lands in the next open period naming the locked one**, which
 *      is a property of a trigger reading `period_lock_for` and cannot be tested without both.
 *
 * ## What is NOT here, and why
 *
 * The monthly PASS is asserted in `apps/worker/src/jobs/gratuity-accrual.itest.ts` and not here, and the
 * reason is the dependency graph rather than taste: `@berelax/worker` depends on `@berelax/fixtures`, so a
 * fixtures suite importing the job would be a cycle. That split is why every accrual below is posted through
 * the REPOSITORY with an entry built by the pure engine — which is the cross-package claim this file is for —
 * while "does a second run of the cron write anything" is asked where the cron lives.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind.
 *
 *   - Everything is in **2083**, which no other suite and no gate block writes into. 2079, 2080, 2081, 2084,
 *     2086, 2088 through 2091 and 2094 through 2099 are spoken for; 2083 is not.
 *   - The pass is ALWAYS driven with an explicit `employeeIds`, because unnarrowed it reads the whole roster
 *     — so an unnarrowed run from here would accrue for every other file's fixture employees, into tables
 *     that refuse DELETE for every role.
 *   - Every employee is prefixed `PHR13 GRA` with a STABLE reference, so a re-run reuses the same rows
 *     rather than minting more. That is `hr-payroll.itest.ts`'s recorded lesson: a per-run tag left the
 *     previous run's employees on disk with wages, and production code that is right to look at them found
 *     them.
 *   - It owns its three tables outright and truncates them as the OWNER in `beforeAll`, which is the only
 *     legal removal — they refuse DELETE for every role (ZY171) — and it is declared in
 *     `packages/db/src/suite-table-declarations.ts` as `owns`, because W-SYS-13's scan refuses an
 *     unqualified `truncate` that is not.
 *   - Every period lock is inserted inside a **rolled-back** transaction. `period_lock` has no DELETE grant
 *     for the application role and overlapping locks are refused by an exclusion constraint, so a lock left
 *     behind would close 2083 for every later run of this file and could only be cleared with owner rights.
 *     That is `hr-attendance.itest.ts`'s arrangement and `hr-payroll.itest.ts`'s.
 *
 * No employee here has a name (brief rule 10), and every figure is this file's own fixture: `Y8-staff`
 * records that all nineteen real employees have `basic_wage_fils` null and `Y9-gratuity` that not one
 * gratuity figure is confirmed, so nothing below may be read as what this business owes.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** Stable, for `hr-payroll.itest.ts`'s recorded reason. A per-run tag leaves the last run's rows behind. */
const TAG = 'PHR13 GRA'
const ACTOR: Actor = {
  kind: 'staff',
  id: '13131313-1313-1313-1313-131313131313',
  label: 'Gratuity (P-HR-13)',
}
const CREATED_BY = 'gratuity.itest'

/** 2083 is nobody else's. */
const YEAR = 2083
/** The trading day the instant belongs to. `businessDayAt` needs a row at or before the instant. */
const TRADING_DAY = `${YEAR}-07-04`

/** AED 3,000 a month, so a day of wage is exactly AED 100 under version 1's 30-day divisor. */
const WAGE = 300_000

/** Engaged four years before the window, so probation is long past and every month of it earns. */
const LONG_FROM = `${YEAR - 4}-01-01`
/** The three months this file accrues. Consecutive, so the cumulative figure can be carried forward. */
const MONTHS = [`${YEAR}-04-01`, `${YEAR}-05-01`, `${YEAR}-06-01`] as const

/** The journal entry ids each handle's seeded accruals produced, in month order. */
const seeded = new Map<string, readonly string[]>()

const employees = new Map<string, string>()
const of = (handle: string): string => employees.get(handle) as string

let rules: GratuityRules
let accounts: GratuityAccounts
let payableAccount = ''

const ROLLBACK = 'PHR13_ROLLBACK'

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

async function makeEmployee(
  handle: string,
  args: { employedFrom: string; employedUntil?: string | null; wage?: number | null },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, employed_until, basic_wage_fils)
    values (${`${TAG} ${handle}`}, ${args.employedFrom}::date,
            ${args.employedUntil ?? null}, ${args.wage === undefined ? WAGE : args.wage})
    on conflict (staff_reference) do update
      set employed_from = excluded.employed_from,
          employed_until = excluded.employed_until,
          basic_wage_fils = excluded.basic_wage_fils
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

/** Maps a core entry draft onto the structural mirror `@berelax/db` takes. The job's own mapper's twin. */
function asInput(draft: ReturnType<typeof gratuityAccrualEntry>): JournalEntryInput {
  return {
    entryId: draft.entryId as string,
    entryDate: draft.entryDate as string,
    narrative: draft.narrative,
    source: draft.source,
    lines: draft.lines.map((line) => ({
      accountCode: line.account as string,
      debitFils: line.side === 'debit' ? line.amount.fils : 0,
      creditFils: line.side === 'credit' ? line.amount.fils : 0,
      ...(line.memo === undefined ? {} : { memo: line.memo }),
    })),
  }
}

/** One accrual row's worth of input, built from the engine so nothing here restates its arithmetic. */
function accrualInputFor(args: {
  readonly handle: string
  readonly employedFrom: string
  readonly accrualMonth: string
  readonly alreadyAccruedFils?: number
  readonly entryId: string
  readonly entryDate?: string
  readonly lockedPeriodId?: string | null
  readonly correctsAccrualId?: string | null
  readonly amountFils?: number
}): GratuityAccrualInput {
  const accrual = accrueGratuityMonth({
    rules,
    service: { employedFrom: localDate(args.employedFrom) },
    accrualMonth: localDate(args.accrualMonth),
    wageFils: WAGE,
    alreadyAccruedFils: args.alreadyAccruedFils ?? 0,
  })
  const amountFils = args.amountFils ?? accrual.movementFils
  const entryDate = args.entryDate ?? (accrual.accruedTo as string)
  const contribution = accrual.liability.contributions.at(-1)
  return {
    employeeId: of(args.handle),
    staffReference: `${TAG} ${args.handle}`,
    accrualMonth: accrual.accrualMonth as string,
    accruedTo: accrual.accruedTo as string,
    wageFils: WAGE,
    wageBasis: rules.wageBasis,
    employedDays: contribution?.employedDays ?? 0,
    unpaidLeaveDays: contribution?.excludedDays ?? 0,
    cumulativeFils: accrual.cumulativeFils,
    accruedFils: amountFils,
    ruleEffectiveFrom: rules.effectiveFrom as string,
    lockedPeriodId: args.lockedPeriodId ?? null,
    correctsAccrualId: args.correctsAccrualId ?? null,
    createdBy: CREATED_BY,
    entry: asInput(
      gratuityAccrualEntry({
        entryId: args.entryId as never,
        entryDate: localDate(entryDate),
        accounts,
        amountFils,
        accrualMonth: accrual.accrualMonth,
        staffReference: `${TAG} ${args.handle}`,
        lockedPeriodId: args.lockedPeriodId ?? null,
      }),
    ),
  }
}

/**
 * A valid two-line gratuity entry, inside a caller's transaction.
 *
 * Every probe below that inserts a `gratuity_accrual` row by hand needs one, because ZY173 fires FIRST and
 * refuses an accrual whose entry does not exist or is not a gratuity posting. The first version of those
 * probes skipped it and every one of them reported ZY173 — a refusal, so the case "passed" in the sense that
 * something was rejected, while asserting the name of a constraint it had never reached. That is ADR 0003's
 * point from the inside: a probe has to be shown to reach the rule it names.
 */
async function postEntryIn(
  tx: Sql,
  args: { readonly entryId: string; readonly entryDate: string; readonly amountFils: number },
): Promise<void> {
  await tx`
    insert into journal_entry (entry_id, entry_date, narrative, source)
    values (${args.entryId}, ${args.entryDate}::date, 'P-HR-13 probe', 'gratuity_accrual')
  `
  await tx`
    insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
    values (${args.entryId}, 1, ${accounts.expense as string}, ${args.amountFils}, 0),
           (${args.entryId}, 2, ${accounts.liability as string}, 0, ${args.amountFils})
  `
}

/**
 * Posts consecutive months for one employee through the repository, carrying the cumulative figure forward.
 *
 * Oldest first and the running total threaded, because each month's movement is a DIFFERENCE against what the
 * previous month left. Posting them in any other order, or each against zero, would put the whole liability
 * in the first month and nothing in the rest — which is the shape ADR 0057 is about and the shape the
 * cumulative assertions below would catch.
 */
async function seedAccruals(handle: string, employedFrom: string): Promise<void> {
  const entryIds: string[] = []
  let already = 0
  for (const month of MONTHS) {
    const input = accrualInputFor({
      handle,
      employedFrom,
      accrualMonth: month,
      alreadyAccruedFils: already,
      entryId: `PHR13-${handle}-${month}`,
    })
    const written = await withUnitOfWork(sql, ACTOR, (uow) => postGratuityAccrual(uow, input))
    // `null` means an earlier run of this file already posted this month. Reuse it rather than failing:
    // nothing here can be removed, the id is stable, and the figures are a pure function of the service
    // history and the rule version — so the row a previous run wrote is the row this one would have.
    entryIds.push(written?.entryId ?? input.entry.entryId)
    already = input.cumulativeFils
  }
  seeded.set(handle, entryIds)
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${TRADING_DAY}::date,
      (${TRADING_DAY}::date + time '11:00') at time zone 'Asia/Dubai',
      (${TRADING_DAY}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
      'weekly'
    )
    on conflict (trading_date) do nothing
  `

  // A lock over 2083 left behind by an interrupted earlier run of THIS file would refuse every case below
  // with ZL002 or ZY174 and every one would report that instead — `hr-payroll.itest.ts`'s reason for the
  // same scoped delete. Scoped to 2083, which is this file's year, so it can take nobody else's lock.
  await sql`
    delete from period_lock
     where starts_on >= ${`${YEAR}-01-01`}::date and ends_on <= ${`${YEAR}-12-31`}::date
       -- A lock an accrual NAMES cannot be removed: gratuity_accrual.locked_period_id references it and the
       -- accrual itself refuses DELETE for every role (ZY171). That is ADR 0026 made structural — a closed
       -- period a liability has been posted against is not one anybody may re-open — and it means this
       -- cleanup has to skip such a lock rather than fail on it. Leaving it is safe: it can only exist over a
       -- month this file has already accrued, which the assertions below read rather than re-create.
       and not exists (
         select 1 from gratuity_accrual a where a.locked_period_id = period_lock.period_id
       )
  `
  /*
   * There is deliberately NO truncate here, and the first version of this file had one.
   *
   * Truncating `gratuity_accrual` as the owner is legal and looks like the obvious way to start from a known
   * state — `hr-payroll.itest.ts` does exactly that with its five tables. It is wrong here for a reason that
   * only shows up on the SECOND run: every accrual row names a `journal_entry`, and `journal_entry` refuses
   * DELETE for every role including the owner (ZL001). So the truncate removed the rows and left their
   * entries, and the next run's first insert died on `journal_entry_pkey` — a duplicate key from a suite that
   * had just emptied the table it thought it owned. Worse, the reconciliation would then have compared a
   * ledger holding two runs of entries against a schedule holding one.
   *
   * So nothing is removed. Every id below is STABLE, every write is ensure-then-assert, and a re-run reuses
   * the rows it finds. That is `hr-payroll.itest.ts`'s `ensureApproval` reasoning applied to a table whose
   * children cannot be deleted either — and it is what makes the append-only claim this file makes about the
   * schema true of the suite as well.
   */

  const versions = await readGratuityRules(sql)
  const seeded = versions.at(0)
  if (seeded === undefined)
    throw new Error('0107 seeds gratuity_rule version 1; the table is empty.')
  rules = {
    effectiveFrom: localDate(seeded.effectiveFrom),
    daysPerYearFirstBand: seeded.daysPerYearFirstBand,
    daysPerYearAfterBand: seeded.daysPerYearAfterBand,
    bandBoundaryYears: seeded.bandBoundaryYears,
    dailyWageDaysDivisor: seeded.dailyWageDaysDivisor,
    wageBasis: seeded.wageBasis === 'gross' ? 'gross' : 'basic',
    probationMonths: seeded.probationMonths,
    accruesDuringProbation: seeded.accruesDuringProbation,
    unpaidLeaveDaysExcluded: seeded.unpaidLeaveDaysExcluded,
  }
  accounts = {
    expense: accountCode(await readSetting<string>(sql, GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY)),
    liability: accountCode(await readSetting<string>(sql, GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY)),
  }
  payableAccount = await readSetting<string>(sql, GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY)

  // LONG: engaged well before the window, so every month of the catch-up earns and probation is long past.
  await makeEmployee('LONG', { employedFrom: LONG_FROM })
  // PROBATION: engaged so recently that every month the pass will reach is inside the 6-month probation.
  await makeEmployee('PROBATION', { employedFrom: `${YEAR}-05-01` })
  // NOWAGE: the state all nineteen seeded employees are in (Y8-staff).
  await makeEmployee('NOWAGE', { employedFrom: `${YEAR - 4}-01-01`, wage: null })
  // LEAVER: employment ended inside the window, so a settlement is legal for them.
  await makeEmployee('LEAVER', {
    employedFrom: `${YEAR - 3}-01-01`,
    employedUntil: `${YEAR}-06-30`,
  })
  // CORRECT and LOCKED get their own rows so a correction and a locked month cannot disturb the others.
  await makeEmployee('CORRECT', { employedFrom: `${YEAR - 4}-01-01` })
  await makeEmployee('LOCKED', { employedFrom: `${YEAR - 4}-01-01` })
  await makeEmployee('ADJUST', { employedFrom: `${YEAR - 4}-01-01` })

  // LONG and LEAVER get three consecutive months each. Everything below reads these rows; CORRECT, LOCKED,
  // PROBATION and ADJUST are deliberately left with none, so a case that needs a clean employee has one.
  await seedAccruals('LONG', LONG_FROM)
  await seedAccruals('LEAVER', `${YEAR - 3}-01-01`)
}, 60_000)

// --- the fixture and the seeded row are the same policy ------------------------------------------

describe('the seeded policy version', () => {
  it('is flagged provisional against Y9-gratuity and carries a stated provenance', async () => {
    const [row] = await readGratuityRules(sql)
    expect(row?.isProvisional).toBe(true)
    expect(row?.openQuestionId).toBe('Y9-gratuity')
    // The provenance is what stops the row reading as agreed. NOT NULL and not a placeholder at the column;
    // asserted here for its CONTENT, because a stated provenance that said nothing would satisfy the CHECK.
    expect(row?.sourceNote).toContain('docs/04')
    expect(row?.provisionalNote).toContain('NO CAP')
  })

  it('appears on the Unconfirmed Assumptions panel, keyed by the version it takes effect on', async () => {
    // The panel is the whole mechanism docs/04 §7 prescribes for these figures: a provisional row that did
    // not appear on it would be indistinguishable from a confirmed one. Asserted through the real reader.
    const rows = await sql<{ source: string; reference: string; openQuestionId: string | null }[]>`
      select source, reference, "openQuestionId" from (
        select 'gratuity_rule' as source, 'gratuity effective ' || effective_from::text as reference,
               open_question_id as "openQuestionId"
          from gratuity_rule where is_provisional
      ) as r
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reference).toContain('gratuity effective')
    expect(rows[0]?.openQuestionId).toBe('Y9-gratuity')
  })

  it('refuses a version outside its bounds, at the database (the engine refuses the same row)', async () => {
    // The pair the engine's `assertGratuityRules` and these CHECKs make: both must refuse, or one of them is
    // decoration. The engine half is asserted in packages/core/src/hr/gratuity.test.ts.
    const refusal = await refusalOf(
      (tx) => tx`
        insert into gratuity_rule (effective_from, days_per_year_first_band, days_per_year_after_band,
          band_boundary_years, daily_wage_days_divisor, wage_basis, probation_months,
          accrues_during_probation, unpaid_leave_days_excluded, is_provisional, open_question_id,
          source_note)
        values (date '2090-01-01', 400, 30, 5, 30, 'basic', 6, false, true, true, 'Y9-gratuity', 'probe')
      `,
    )
    expect(refusal).toContain('gratuity_rule_first_band_plausible')
  })

  it('refuses a version that earns nothing in either band', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into gratuity_rule (effective_from, days_per_year_first_band, days_per_year_after_band,
          band_boundary_years, daily_wage_days_divisor, wage_basis, probation_months,
          accrues_during_probation, unpaid_leave_days_excluded, is_provisional, open_question_id,
          source_note)
        values (date '2090-01-01', 0, 0, 5, 30, 'basic', 6, false, true, true, 'Y9-gratuity', 'probe')
      `,
    )
    expect(refusal).toContain('gratuity_rule_earns_something')
  })

  it('refuses a provisional version that names no open question', async () => {
    const refusal = await refusalOf(
      (tx) => tx`
        insert into gratuity_rule (effective_from, days_per_year_first_band, days_per_year_after_band,
          band_boundary_years, daily_wage_days_divisor, wage_basis, probation_months,
          accrues_during_probation, unpaid_leave_days_excluded, is_provisional, open_question_id,
          source_note)
        values (date '2090-01-01', 21, 30, 5, 30, 'basic', 6, false, true, true, null, 'probe')
      `,
    )
    expect(refusal).toContain('gratuity_rule_provisional_names_a_question')
  })

  it('holds no write grant for the application role: publishing a version is a migration', async () => {
    const grants = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
       where table_name = 'gratuity_rule' and grantee = 'berelax_app'
    `
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['SELECT'])
  })
})

// --- the monthly pass ----------------------------------------------------------------------------

describe('the accrual rows the engine and the repository produce together', () => {
  it('posts one balanced entry per accrual, every one summing to exactly zero fils', async () => {
    const entryIds = seeded.get('LONG') as readonly string[]
    expect(entryIds.length).toBeGreaterThan(0)
    const rows = await sql<{ entry_id: string; debit: string; credit: string; lines: number }[]>`
      select l.entry_id,
             sum(l.debit_fils)::text  as debit,
             sum(l.credit_fils)::text as credit,
             count(*)::int            as lines
        from journal_line l
       where l.entry_id = any (${[...entryIds]}::text[])
       group by l.entry_id
    `
    expect(rows).toHaveLength(entryIds.length)
    for (const row of rows) {
      // Sums to zero fils, which for a two-line entry means the debit equals the credit exactly.
      expect(Number(row.debit) - Number(row.credit)).toBe(0)
      expect(row.lines).toBe(2)
    }
  })

  it('debits the configured expense account and credits the configured liability account', async () => {
    const entryIds = seeded.get('LONG') as readonly string[]
    const rows = await sql<{ account_code: string; debit: string; credit: string }[]>`
      select account_code, sum(debit_fils)::text as debit, sum(credit_fils)::text as credit
        from journal_line
       where entry_id = any (${[...entryIds]}::text[])
       group by account_code
       order by account_code
    `
    const byAccount = new Map(rows.map((r) => [r.account_code, r]))
    expect(byAccount.get(accounts.expense as string)?.credit).toBe('0')
    expect(byAccount.get(accounts.liability as string)?.debit).toBe('0')
    // Two accounts and no others. An entry that also touched a third would still balance.
    expect(rows).toHaveLength(2)
  })

  it('the SQL liability view agrees with the engine’s own figure, to the fil', async () => {
    // The claim this file exists for: two implementations of one number. The engine computes it in BigInt
    // from the service history; the view sums the rows the repository wrote.
    const [row] = await readGratuityLiabilities(sql, [of('LONG')])
    const engine = gratuityLiabilityAt({
      rules,
      service: { employedFrom: localDate(LONG_FROM) },
      asOf: monthEnd(localDate(MONTHS.at(-1) as string)),
      wageFils: WAGE,
    })
    expect(row?.accruedFils).toBe(engine.fils)
    // And the control: the figure is not zero, so the equality is not two zeroes agreeing.
    expect(engine.fils).toBeGreaterThan(0)
  })

  it('every accrual row pins the wage, the basis and the rule version that produced it', async () => {
    const rows = await readGratuityAccruals(sql, {
      employeeIds: [of('LONG')],
      fromMonth: MONTHS[0] as string,
      toMonth: monthEnd(localDate(MONTHS.at(-1) as string)) as string,
    })
    expect(rows.length).toBe(MONTHS.length)
    for (const row of rows) {
      expect(row.wageFils).toBe(WAGE)
      expect(row.wageBasis).toBe(rules.wageBasis)
      expect(row.ruleEffectiveFrom).toBe(rules.effectiveFrom as string)
    }
    // The cumulative figure never goes backwards, which is what makes the movements a telescoping sum
    // rather than independent guesses.
    const cumulatives = rows.map((r) => r.cumulativeFils)
    expect([...cumulatives].sort((a, b) => a - b)).toEqual(cumulatives)
    // The movements sum to the last cumulative figure, exactly. This is ADR 0057's claim, in SQL.
    expect(rows.reduce((total, r) => total + r.accruedFils, 0)).toBe(cumulatives.at(-1))
  })

  it('is idempotent per (employee, accrual_month): a second post writes no line and no row', async () => {
    const before = await sql<{ lines: string; accruals: string }[]>`
      select (select count(*) from journal_line l join journal_entry e on e.entry_id = l.entry_id
               where e.source = 'gratuity_accrual')::text as lines,
             (select count(*) from gratuity_accrual)::text as accruals
    `
    // The same month again, through the same path. `postGratuityAccrual` returns null and posts nothing: the
    // pre-check sees the original row, so the journal entry is never reached — which is why the check is
    // BEFORE the entry rather than an `on conflict do nothing` on the accrual row alone.
    const again = await withUnitOfWork(sql, ACTOR, (uow) =>
      postGratuityAccrual(
        uow,
        accrualInputFor({
          handle: 'LONG',
          employedFrom: LONG_FROM,
          accrualMonth: MONTHS[0] as string,
          entryId: 'PHR13-LONG-DUPLICATE',
        }),
      ),
    )
    expect(again).toBeNull()
    const after = await sql<{ lines: string; accruals: string }[]>`
      select (select count(*) from journal_line l join journal_entry e on e.entry_id = l.entry_id
               where e.source = 'gratuity_accrual')::text as lines,
             (select count(*) from gratuity_accrual)::text as accruals
    `
    // A DELTA of zero rather than a total, because other suites' rows may be in these tables (brief rule 9).
    expect(Number(after[0]?.lines) - Number(before[0]?.lines)).toBe(0)
    expect(Number(after[0]?.accruals) - Number(before[0]?.accruals)).toBe(0)
    // And no orphan entry was left behind, which is what the pre-check ordering is FOR: an entry crediting
    // the liability with no accrual row attributing it to anybody is worse than the duplicate it prevented.
    const orphan = await sql<{ entry_id: string }[]>`
      select entry_id from journal_entry where entry_id = 'PHR13-LONG-DUPLICATE'
    `
    expect(orphan).toEqual([])
  })

  it('a second ORIGINAL for one employee-month is refused at the index, whatever the path', async () => {
    // The pre-check makes the ordinary second run cheap; THIS is what makes a concurrent one safe.
    const [existing] = await readGratuityAccruals(sql, {
      employeeIds: [of('LONG')],
      fromMonth: MONTHS[0] as string,
      toMonth: MONTHS[0] as string,
    })
    const refusal = await refusalOf(async (tx) => {
      await postEntryIn(tx, {
        entryId: 'PHR13-LONG-DUP',
        entryDate: (existing as { entryDate: string }).entryDate,
        amountFils: (existing as { accruedFils: number }).accruedFils,
      })
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, created_by)
        select a.employee_id, a.accrual_month, a.accrued_to, a.wage_fils, a.wage_basis,
               a.employed_days, a.unpaid_leave_days, a.cumulative_fils, a.accrued_fils,
               a.rule_effective_from, 'PHR13-LONG-DUP', a.entry_date, 'probe'
          from gratuity_accrual a where a.accrual_id = ${(existing as { accrualId: string }).accrualId}::uuid
      `
    })
    expect(refusal).toContain('gratuity_accrual_one_original_per_month')
  })

  it('accrues nothing for a month wholly inside probation, per the CONFIGURED rule', async () => {
    // The acceptance line, against the rule ROW rather than against a number in this file: version 1 says
    // accrual does not run during a six-month probation, and PROBATION was engaged one month before.
    const accrual = accrueGratuityMonth({
      rules,
      service: { employedFrom: localDate(`${YEAR}-05-01`) },
      accrualMonth: localDate(`${YEAR}-06-01`),
      wageFils: WAGE,
      alreadyAccruedFils: 0,
    })
    expect(accrual.movementFils).toBe(0)
    // And a zero movement cannot be recorded at all: `accrued_fils > 0` refuses it, so a caller that tried
    // to write "nothing happened" as a row would fail rather than filling the table with empty accruals.
    const refusal = await refusalOf(async (tx) => {
      // A one-fil entry, so the entry itself is postable: a zero-fils journal line is refused by
      // `journal_line_exactly_one_side` long before this table is reached, and the claim here is about the
      // ACCRUAL row being refused rather than about the entry.
      await postEntryIn(tx, {
        entryId: 'PHR13-ZERO',
        entryDate: `${YEAR}-06-30`,
        amountFils: 1,
      })
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, created_by)
        values (${of('PROBATION')}::uuid, ${`${YEAR}-06-01`}::date, ${`${YEAR}-06-30`}::date, ${WAGE},
                'basic', 30, 0, 0, 0, ${rules.effectiveFrom as string}::date,
                'PHR13-ZERO', ${`${YEAR}-06-30`}::date, 'probe')
      `
    })
    /*
     * ZY173 is what refuses it, and `gratuity_accrual_movement_is_positive` is NOT reachable while that
     * trigger exists — which is worth stating rather than papering over. A zero-fils journal line is refused
     * by `journal_line_exactly_one_side` (0018), so a zero-amount ENTRY cannot exist at all; any entry a
     * zero-movement accrual could name therefore disagrees with it, and ZY173 fires first because PostgreSQL
     * evaluates BEFORE triggers before table CHECKs.
     *
     * The CHECK is the layer that survives the trigger being dropped, so it is asserted to EXIST rather than
     * to fire. A check that cannot be shown to fire is exactly what ADR 0003 is about; the honest version of
     * the claim is "the row cannot exist, here is which layer refuses it, and here is the second layer".
     */
    expect(refusal).toContain('ZY173')
    const [check] = await sql<{ conname: string }[]>`
      select conname from pg_constraint
       where conname = 'gratuity_accrual_movement_is_positive'
         and conrelid = 'gratuity_accrual'::regclass
    `
    expect(check?.conname).toBe('gratuity_accrual_movement_is_positive')
    // The control that stops the zero above meaning "the engine returns zero for everything".
    expect(
      accrueGratuityMonth({
        rules,
        service: { employedFrom: localDate(LONG_FROM) },
        accrualMonth: localDate(`${YEAR}-06-01`),
        wageFils: WAGE,
        alreadyAccruedFils: 0,
      }).movementFils,
    ).toBeGreaterThan(0)
  })
})

// --- append-only ---------------------------------------------------------------------------------

describe('the journal and the accrual rows are append-only', () => {
  it('ZL001 — an UPDATE against journal_line is refused', async () => {
    const [line] = await sql<{ entry_id: string }[]>`
      select l.entry_id from journal_line l join journal_entry e on e.entry_id = l.entry_id
       where e.source = 'gratuity_accrual' limit 1
    `
    const refusal = await refusalOf(
      (tx) =>
        tx`update journal_line set debit_fils = 1 where entry_id = ${line?.entry_id as string}`,
    )
    expect(refusal).toContain('ZL001')
    expect(refusal).toContain('append-only')
  })

  it('ZL001 — a DELETE against journal_line is refused', async () => {
    const [line] = await sql<{ entry_id: string }[]>`
      select l.entry_id from journal_line l join journal_entry e on e.entry_id = l.entry_id
       where e.source = 'gratuity_accrual' limit 1
    `
    const refusal = await refusalOf(
      (tx) => tx`delete from journal_line where entry_id = ${line?.entry_id as string}`,
    )
    expect(refusal).toContain('ZL001')
  })

  it('ZY171 — an UPDATE and a DELETE against gratuity_accrual are both refused', async () => {
    for (const statement of ['update', 'delete'] as const) {
      const refusal = await refusalOf((tx) =>
        statement === 'update'
          ? tx`update gratuity_accrual set accrued_fils = 1 where employee_id = ${of('LONG')}::uuid`
          : tx`delete from gratuity_accrual where employee_id = ${of('LONG')}::uuid`,
      )
      expect(refusal, `${statement} must be refused`).toContain('ZY171')
    }
  })

  it('ZY171 — and against gratuity_settlement and closed_period_labour_adjustment', async () => {
    // Asserted per TABLE rather than once, because the pair of triggers is where this defect hides: you
    // write one, copy it for the other event, and forget to change the word. `pnpm db:conventions` makes the
    // same check statically; this is the same claim executed.
    // Each probe creates its own row INSIDE the rolled-back transaction, and that is not ceremony: a
    // BEFORE UPDATE trigger fires per ROW, so an UPDATE matching nothing is a silent no-op. The first version
    // ran against empty tables, got no refusal, and reported that the trigger was missing — the same class of
    // vacuous pass as a scan that matches nothing.
    const triggers = await sql<{ tgname: string; relname: string }[]>`
      select t.tgname, c.relname
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and c.relname in ('gratuity_accrual', 'gratuity_settlement', 'closed_period_labour_adjustment')
         and t.tgname like '%_no_update' or t.tgname like '%_no_delete'
    `
    // Both members of the pair, per table. This is where the defect hides: you write one trigger, copy it for
    // the other event, and forget to change the word — and the table then documents a guarantee it half keeps.
    for (const table of [
      'gratuity_accrual',
      'gratuity_settlement',
      'closed_period_labour_adjustment',
    ] as const) {
      const names = triggers.filter((t) => t.relname === table).map((t) => t.tgname)
      expect(names, `${table} needs both refusal triggers`).toEqual(
        expect.arrayContaining([`${table}_no_update`, `${table}_no_delete`]),
      )
    }

    const refusal = await refusalOf(async (tx) => {
      await postEntryIn(tx, {
        entryId: 'PHR13-ZY171-SETTLE',
        entryDate: `${YEAR}-07-04`,
        amountFils: 100,
      })
      await tx`
        insert into gratuity_settlement (employee_id, employed_until, settled_fils, entry_id, entry_date,
                                         created_by)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-06-30`}::date, 100, 'PHR13-ZY171-SETTLE',
                ${`${YEAR}-07-04`}::date, 'probe')
      `
      await tx`update gratuity_settlement set created_by = 'edited' where entry_id = 'PHR13-ZY171-SETTLE'`
    })
    // ZY176 would refuse the INSERT (ADJUST is still employed), so the update is never reached. Set the
    // leaving date inside the same transaction so the row lands and the UPDATE is what is refused.
    const refusalWithLeaver = await refusalOf(async (tx) => {
      await tx`update employee set employed_until = ${`${YEAR}-06-30`}::date where id = ${of('ADJUST')}::uuid`
      await postEntryIn(tx, {
        entryId: 'PHR13-ZY171-SETTLE2',
        entryDate: `${YEAR}-07-04`,
        amountFils: 100,
      })
      await tx`
        insert into gratuity_settlement (employee_id, employed_until, settled_fils, entry_id, entry_date,
                                         created_by)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-06-30`}::date, 100, 'PHR13-ZY171-SETTLE2',
                ${`${YEAR}-07-04`}::date, 'probe')
      `
      await tx`update gratuity_settlement set created_by = 'edited' where entry_id = 'PHR13-ZY171-SETTLE2'`
    })
    // ADJUST has no accrued liability, so 100 fils is not the live figure and ZY175 refuses the insert. Either
    // way the row cannot be created for a probe, which is itself the strongest statement the schema makes —
    // so the UPDATE claim is carried by the adjustment table, where a row CAN be created.
    expect(refusal === '' ? refusalWithLeaver : refusal).not.toBe('')

    const adjustmentRefusal = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values ('PHR13-ZY171-LOCK', ${`${YEAR}-01-01`}::date, ${`${YEAR}-01-31`}::date, 'probe', 'staff')
      `
      await postEntryIn(tx, {
        entryId: 'PHR13-ZY171-ADJ',
        entryDate: `${YEAR}-05-31`,
        amountFils: 100,
      })
      await tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-01-15`}::date, 'PHR13-ZY171-LOCK', 100,
                'P-HR-13 append-only probe', 'PHR13 manager', 'PHR13 front desk',
                'PHR13-ZY171-ADJ', ${`${YEAR}-05-31`}::date)
      `
      await tx`update closed_period_labour_adjustment set recorded_by = 'edited'
                where entry_id = 'PHR13-ZY171-ADJ'`
    })
    expect(adjustmentRefusal).toContain('ZY171')

    const adjustmentDelete = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values ('PHR13-ZY171-LOCK2', ${`${YEAR}-01-01`}::date, ${`${YEAR}-01-31`}::date, 'probe', 'staff')
      `
      await postEntryIn(tx, {
        entryId: 'PHR13-ZY171-ADJ2',
        entryDate: `${YEAR}-05-31`,
        amountFils: 100,
      })
      await tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-01-15`}::date, 'PHR13-ZY171-LOCK2', 100,
                'P-HR-13 append-only probe', 'PHR13 manager', 'PHR13 front desk',
                'PHR13-ZY171-ADJ2', ${`${YEAR}-05-31`}::date)
      `
      await tx`delete from closed_period_labour_adjustment where entry_id = 'PHR13-ZY171-ADJ2'`
    })
    expect(adjustmentDelete).toContain('ZY171')
  })

  it('the repository exports no update and no delete', async () => {
    const exported = Object.keys(await import('@berelax/db'))
    // A function named `updateGratuityAccrual` would fail the build here, which is the point of asserting it.
    for (const forbidden of [
      'updateGratuityAccrual',
      'deleteGratuityAccrual',
      'voidGratuityAccrual',
    ]) {
      expect(exported).not.toContain(forbidden)
    }
    expect(exported).toContain('postGratuityAccrual')
    expect(exported).toContain('postGratuityCorrection')
  })
})

// --- correction by dated reversal ----------------------------------------------------------------

describe('correcting an over-accrual', () => {
  it('posts a dated reversal plus a replacement, and the liability lands on the corrected figure', async () => {
    const month = `${YEAR}-03-01`
    const original = accrualInputFor({
      handle: 'CORRECT',
      employedFrom: `${YEAR - 4}-01-01`,
      accrualMonth: month,
      entryId: `PHR13-CORRECT-${month}`,
    })
    const written = await withUnitOfWork(sql, ACTOR, (uow) => postGratuityAccrual(uow, original))
    // `null` on a re-run: the original is already there. The correction below is likewise ensure-then-assert,
    // so this case reaches the same end state whether it is the first run or the fifth — which it has to,
    // because nothing in these three tables can be removed.
    const originalId =
      written?.accrualId ??
      (
        await sql<{ accrual_id: string }[]>`
          select accrual_id::text as accrual_id from gratuity_accrual
           where employee_id = ${of('CORRECT')}::uuid and accrual_month = ${month}::date
             and corrects_accrual_id is null
        `
      )[0]?.accrual_id
    expect(originalId).toBeDefined()

    // Half the figure, as though the wage had been wrong. Built through core, so the reversal's amounts are
    // the original's swapped rather than recomputed.
    const correctedFils = Math.floor(original.accruedFils / 2)
    const posted = postEntry(
      gratuityAccrualEntry({
        entryId: original.entry.entryId as never,
        entryDate: localDate(original.entry.entryDate),
        accounts,
        amountFils: original.accruedFils,
        accrualMonth: localDate(month),
        staffReference: `${TAG} CORRECT`,
      }),
      STANDARD_SPA_CHART,
    )
    /*
     * Dated at MARCH's month end and not in April, and that is `reverseEntry`'s own documented rule rather
     * than a convenience: "a correction found in March for a February entry is dated in February if February
     * is still open and in March if it is closed". March is open here, so the correction belongs in March.
     *
     * The first version dated it 30 April and ZY174 refused it — correctly. A correction dated outside an
     * OPEN month would put the liability in a period that did not earn it, which is what that rule exists to
     * prevent; the PERIOD LOCK is the thing that legitimately moves a correction forward, and the locked case
     * is asserted in its own describe block below. So the two rules compose rather than conflict, and finding
     * that out is what this case is for.
     */
    const on = monthEnd(localDate(month)) as string
    const reversal = reverseEntry(posted, localDate(on))
    const plan = correctGratuityOverAccrual({
      original: posted.entryId,
      replacementEntryId: `PHR13-CORRECT-${month}-R1` as never,
      on: localDate(on),
      accounts,
      correctedFils,
      accrualMonth: localDate(month),
      staffReference: `${TAG} CORRECT`,
    })
    expect(plan.reversalOf).toBe(posted.entryId)

    const replacement: GratuityAccrualInput = {
      ...accrualInputFor({
        handle: 'CORRECT',
        employedFrom: `${YEAR - 4}-01-01`,
        accrualMonth: month,
        entryId: `PHR13-CORRECT-${month}-R1`,
        entryDate: on,
        amountFils: correctedFils,
      }),
      correctsAccrualId: originalId as string,
    }
    const alreadyCorrected = await sql<{ accrual_id: string }[]>`
      select accrual_id::text as accrual_id from gratuity_accrual
       where corrects_accrual_id = ${originalId as string}::uuid
    `
    if (alreadyCorrected.length === 0) {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        postGratuityCorrection(uow, {
          reversal: {
            entryId: reversal.entryId as string,
            entryDate: reversal.entryDate as string,
            narrative: reversal.narrative,
            source: reversal.source,
            reverses: reversal.reverses as string,
            lines: reversal.lines.map((line) => ({
              accountCode: line.account as string,
              debitFils: line.debitFils,
              creditFils: line.creditFils,
            })),
          },
          replacement,
        }),
      )
    }

    // The liability view now holds ONLY the corrected figure: the superseded row is excluded.
    const after = await readGratuityLiabilities(sql, [of('CORRECT')])
    expect(after[0]?.accruedFils).toBe(correctedFils)

    // And the journal agrees: the three entries net to the corrected figure on the liability account.
    const [net] = await sql<{ net: string }[]>`
      select (coalesce(sum(credit_fils), 0) - coalesce(sum(debit_fils), 0))::text as net
        from journal_line
       where account_code = ${accounts.liability as string}
         and entry_id in (${posted.entryId as string}, ${reversal.entryId as string},
                          ${replacement.entry.entryId})
    `
    expect(Number((net as { net: string }).net)).toBe(correctedFils)

    // The reversal is DATED and points at what it reverses, which is what makes it a correction rather than
    // a second opinion.
    const [stored] = await sql<{ reverses: string | null; entry_date: string }[]>`
      select reverses, entry_date::text as entry_date from journal_entry
       where entry_id = ${reversal.entryId as string}
    `
    expect(stored?.reverses).toBe(posted.entryId as string)
    expect(stored?.entry_date).toBe(on)
  })

  it('ZY172 — a correction may not supersede another employee’s or another month’s accrual', async () => {
    const [victim] = await readGratuityAccruals(sql, {
      employeeIds: [of('LONG')],
      fromMonth: `${YEAR - 2}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    const refusal = await refusalOf(
      (tx) => tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, corrects_accrual_id, created_by)
        select ${of('CORRECT')}::uuid, a.accrual_month, a.accrued_to, a.wage_fils, a.wage_basis,
               a.employed_days, a.unpaid_leave_days, a.cumulative_fils, a.accrued_fils,
               a.rule_effective_from, a.entry_id || '-X', a.entry_date, a.accrual_id, 'probe'
          from gratuity_accrual a where a.accrual_id = ${(victim as { accrualId: string }).accrualId}::uuid
      `,
    )
    expect(refusal).toContain('ZY172')
  })

  it('at most one correction per original, so a correction cannot be applied twice', async () => {
    // Self-contained: the original AND both corrections are created inside the rolled-back transaction, so
    // the case does not depend on another `it` having run first. The first version read a corrected row the
    // preceding case had committed, which made it an assertion about test ORDER.
    const [original] = await readGratuityAccruals(sql, {
      employeeIds: [of('LONG')],
      fromMonth: MONTHS[1] as string,
      toMonth: MONTHS[1] as string,
    })
    const originalId = (original as { accrualId: string }).accrualId
    const amount = (original as { accruedFils: number }).accruedFils
    const refusal = await refusalOf(async (tx) => {
      for (const suffix of ['C1', 'C2']) {
        await postEntryIn(tx, {
          entryId: `PHR13-CHAIN-${suffix}`,
          entryDate: (original as { entryDate: string }).entryDate,
          amountFils: amount,
        })
        await tx`
          insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
            employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
            entry_id, entry_date, corrects_accrual_id, created_by)
          select a.employee_id, a.accrual_month, a.accrued_to, a.wage_fils, a.wage_basis,
                 a.employed_days, a.unpaid_leave_days, a.cumulative_fils, a.accrued_fils,
                 a.rule_effective_from, ${`PHR13-CHAIN-${suffix}`}, a.entry_date,
                 ${originalId}::uuid, 'probe'
            from gratuity_accrual a where a.accrual_id = ${originalId}::uuid
        `
      }
    })
    // Two corrections of ONE original would each count in the liability view and double the correction.
    expect(refusal).toContain('gratuity_accrual_one_correction_per_original')
  })
})

// --- the entry must BE a gratuity accrual --------------------------------------------------------

describe('ZY173 — an accrual row and its journal entry cannot disagree', () => {
  it('refuses an accrual naming an entry whose source is not gratuity_accrual', async () => {
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-WRONGSOURCE', ${`${YEAR}-02-28`}::date, 'probe', 'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-WRONGSOURCE', 1, ${accounts.expense as string}, 1000, 0),
               ('PHR13-WRONGSOURCE', 2, ${accounts.liability as string}, 0, 1000)
      `
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, created_by)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-02-01`}::date, ${`${YEAR}-02-28`}::date, ${WAGE},
                'basic', 28, 0, 1000, 1000, ${rules.effectiveFrom as string}::date,
                'PHR13-WRONGSOURCE', ${`${YEAR}-02-28`}::date, 'probe')
      `
    })
    expect(refusal).toContain('ZY173')
    expect(refusal).toContain('gratuity_accrual')
  })

  it('refuses an accrual whose entry credits a REVENUE account instead of a liability', async () => {
    // The sharpest case, and the reason the trigger checks the TYPE rather than the code: an accrual
    // credited to revenue balances perfectly and turns a debt into income.
    const [revenue] = await sql<{ code: string }[]>`
      select code from account where type = 'revenue' order by code limit 1
    `
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-REVENUE', ${`${YEAR}-02-28`}::date, 'probe', 'gratuity_accrual')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-REVENUE', 1, ${accounts.expense as string}, 1000, 0),
               ('PHR13-REVENUE', 2, ${(revenue as { code: string }).code}, 0, 1000)
      `
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, created_by)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-02-01`}::date, ${`${YEAR}-02-28`}::date, ${WAGE},
                'basic', 28, 0, 1000, 1000, ${rules.effectiveFrom as string}::date,
                'PHR13-REVENUE', ${`${YEAR}-02-28`}::date, 'probe')
      `
    })
    expect(refusal).toContain('ZY173')
  })

  it('refuses an accrual whose amount disagrees with the entry it names', async () => {
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-MISMATCH', ${`${YEAR}-02-28`}::date, 'probe', 'gratuity_accrual')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-MISMATCH', 1, ${accounts.expense as string}, 1000, 0),
               ('PHR13-MISMATCH', 2, ${accounts.liability as string}, 0, 1000)
      `
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, created_by)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-02-01`}::date, ${`${YEAR}-02-28`}::date, ${WAGE},
                'basic', 28, 0, 9999, 9999, ${rules.effectiveFrom as string}::date,
                'PHR13-MISMATCH', ${`${YEAR}-02-28`}::date, 'probe')
      `
    })
    expect(refusal).toContain('ZY173')
  })
})

// --- period locking -------------------------------------------------------------------------------

describe('ZY174 — a locked accrual month lands in the next open period', () => {
  const LOCKED_MONTH = `${YEAR}-01-01`
  const LOCKED_END = `${YEAR}-01-31`
  const lockId = `PHR13-${YEAR}-01`

  /** Locks January 2083 inside a transaction, runs the body, and ALWAYS rolls back. */
  async function withLockedJanuary<T>(body: (tx: Sql) => Promise<T>): Promise<T | string> {
    let captured: T | undefined
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${lockId}, ${LOCKED_MONTH}::date, ${LOCKED_END}::date, 'P-HR-13 lock probe', 'staff')
      `
      captured = await body(tx)
    })
    return refusal === '' ? (captured as T) : refusal
  }

  it('refuses an accrual for a locked month that is dated INSIDE the lock', async () => {
    const result = await withLockedJanuary(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-INLOCK', ${LOCKED_END}::date, 'probe', 'gratuity_accrual')
      `
    })
    // ZL002 from the journal's own guard: the entry cannot even be posted into a locked period, which is the
    // first of the two layers. ADR 0026 — a closed period cannot be reopened without a migration.
    expect(String(result)).toContain('ZL002')
  })

  it('refuses an accrual for a locked month that does not NAME the lock', async () => {
    const result = await withLockedJanuary(async (tx) => {
      const entryId = 'PHR13-UNNAMED'
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, ${`${YEAR}-02-28`}::date, 'probe', 'gratuity_accrual')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${entryId}, 1, ${accounts.expense as string}, 1000, 0),
               (${entryId}, 2, ${accounts.liability as string}, 0, 1000)
      `
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, locked_period_id, created_by)
        values (${of('LOCKED')}::uuid, ${LOCKED_MONTH}::date, ${LOCKED_END}::date, ${WAGE},
                'basic', 31, 0, 1000, 1000, ${rules.effectiveFrom as string}::date,
                ${entryId}, ${`${YEAR}-02-28`}::date, null, 'probe')
      `
    })
    expect(String(result)).toContain('ZY174')
  })

  it('accepts one dated in the next OPEN period and NAMING the locked one', async () => {
    const result = await withLockedJanuary(async (tx) => {
      const entryId = 'PHR13-REBASED'
      const entryDate = `${YEAR}-02-28`
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, ${entryDate}::date,
                ${`Gratuity accrual for ${TAG} LOCKED, month ${LOCKED_MONTH} (accounting period "${lockId}" is locked; posted in the next open period)`},
                'gratuity_accrual')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${entryId}, 1, ${accounts.expense as string}, 1000, 0),
               (${entryId}, 2, ${accounts.liability as string}, 0, 1000)
      `
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, locked_period_id, created_by)
        values (${of('LOCKED')}::uuid, ${LOCKED_MONTH}::date, ${LOCKED_END}::date, ${WAGE},
                'basic', 31, 0, 1000, 1000, ${rules.effectiveFrom as string}::date,
                ${entryId}, ${entryDate}::date, ${lockId}, 'probe')
      `
      const [row] = await tx<{ narrative: string; entry_date: string }[]>`
        select narrative, entry_date::text as entry_date from journal_entry where entry_id = ${entryId}
      `
      return row
    })
    // Accepted, and the narrative carries the DATED REFERENCE to the locked period, which is the half of the
    // acceptance line a SQLSTATE cannot express.
    expect(typeof result).toBe('object')
    const row = result as { narrative: string; entry_date: string }
    expect(row.entry_date).toBe(`${YEAR}-02-28`)
    expect(row.narrative).toContain(lockId)
    expect(row.narrative).toContain(LOCKED_MONTH)
  })

  it('refuses an accrual for an OPEN month dated anywhere but its month end', async () => {
    // The other half of ZY174, and it is not symmetry for its own sake: a freely-dated accrual for an open
    // month puts the liability in a period that did not earn it, and every reconciliation is built on a
    // date-ordered report.
    const refusal = await refusalOf(async (tx) => {
      const entryId = 'PHR13-MISDATED'
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, ${`${YEAR}-05-15`}::date, 'probe', 'gratuity_accrual')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${entryId}, 1, ${accounts.expense as string}, 1000, 0),
               (${entryId}, 2, ${accounts.liability as string}, 0, 1000)
      `
      await tx`
        insert into gratuity_accrual (employee_id, accrual_month, accrued_to, wage_fils, wage_basis,
          employed_days, unpaid_leave_days, cumulative_fils, accrued_fils, rule_effective_from,
          entry_id, entry_date, created_by)
        values (${of('LOCKED')}::uuid, ${`${YEAR}-05-01`}::date, ${`${YEAR}-05-31`}::date, ${WAGE},
                'basic', 31, 0, 1000, 1000, ${rules.effectiveFrom as string}::date,
                ${entryId}, ${`${YEAR}-05-15`}::date, 'probe')
      `
    })
    expect(refusal).toContain('ZY174')
  })

  it('leaves 2083 unlocked, so nothing above closed the year for a later run', async () => {
    const locks = await sql<{ period_id: string }[]>`
      select period_id from period_lock
       where starts_on >= ${`${YEAR}-01-01`}::date and ends_on <= ${`${YEAR}-12-31`}::date
    `
    expect(locks).toEqual([])
  })
})

// --- the leaver's settlement ----------------------------------------------------------------------

describe('a leaver’s settlement nets the liability to exactly zero fils', () => {
  it('proves it end to end, from accrual to settlement', async () => {
    // The leaver's accruals were posted in `beforeAll` through the repository, so the figure being settled is
    // one the production write path produced rather than one this test computed.
    const entryIds = seeded.get('LEAVER') as readonly string[]
    expect(entryIds.length).toBeGreaterThan(0)

    const [liability] = await readGratuityLiabilities(sql, [of('LEAVER')])
    const accrued = (liability as { accruedFils: number }).accruedFils
    expect(accrued).toBeGreaterThan(0)

    const settlementEntry = gratuitySettlementEntry({
      entryId: 'PHR13-SETTLE-LEAVER' as never,
      entryDate: localDate(`${YEAR}-07-04`),
      liabilityAccount: accounts.liability,
      payableAccount: accountCode(payableAccount),
      amountFils: accrued,
      staffReference: `${TAG} LEAVER`,
      employedUntil: localDate(`${YEAR}-06-30`),
    })
    const alreadySettled = await sql<{ settlement_id: string }[]>`
      select settlement_id::text as settlement_id from gratuity_settlement
       where employee_id = ${of('LEAVER')}::uuid
    `
    if (alreadySettled.length === 0) {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        postGratuitySettlement(uow, {
          employeeId: of('LEAVER'),
          employedUntil: `${YEAR}-06-30`,
          settledFils: accrued,
          createdBy: CREATED_BY,
          entry: {
            entryId: settlementEntry.entryId as string,
            entryDate: settlementEntry.entryDate as string,
            narrative: settlementEntry.narrative,
            source: settlementEntry.source,
            lines: settlementEntry.lines.map((line) => ({
              accountCode: line.account as string,
              debitFils: line.side === 'debit' ? line.amount.fils : 0,
              creditFils: line.side === 'credit' ? line.amount.fils : 0,
            })),
          },
        }),
      )
    }

    // THE acceptance line: that employee's liability balance nets to EXACTLY zero fils, netted over the
    // journal lines their own accruals and settlement produced. Scoped to their entries rather than to the
    // account, because `journal_line` carries no employee and the account holds everybody's.
    const netted = [...entryIds, settlementEntry.entryId as string]
    const [net] = await sql<{ net: string }[]>`
      select (coalesce(sum(credit_fils), 0) - coalesce(sum(debit_fils), 0))::text as net
        from journal_line
       where account_code = ${accounts.liability as string}
         and entry_id = any (${netted}::text[])
    `
    expect(Number((net as { net: string }).net)).toBe(0)

    // And it credits a PAYABLE rather than cash: the money leaves through the payroll run, so a cash credit
    // here would pay it twice.
    const [payable] = await sql<{ credit: string }[]>`
      select coalesce(sum(credit_fils), 0)::text as credit from journal_line
       where entry_id = ${settlementEntry.entryId as string} and account_code = ${payableAccount}
    `
    expect(Number((payable as { credit: string }).credit)).toBe(accrued)
  }, 60_000)

  it('ZY175 — a settlement for anything but the live accrued liability is refused', async () => {
    const [liability] = await readGratuityLiabilities(sql, [of('LONG')])
    const accrued = (liability as { accruedFils: number }).accruedFils
    // Employed_until must be set for the ZY176 check to pass, so the refusal below is ZY175's and not its.
    const refusal = await refusalOf(async (tx) => {
      await tx`update employee set employed_until = ${`${YEAR}-06-30`}::date where id = ${of('LONG')}::uuid`
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-SHORT', ${`${YEAR}-07-04`}::date, 'probe', 'payroll')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-SHORT', 1, ${accounts.liability as string}, ${accrued - 1}, 0),
               ('PHR13-SHORT', 2, ${payableAccount}, 0, ${accrued - 1})
      `
      await tx`
        insert into gratuity_settlement (employee_id, employed_until, settled_fils, entry_id, entry_date,
                                         created_by)
        values (${of('LONG')}::uuid, ${`${YEAR}-06-30`}::date, ${accrued - 1}, 'PHR13-SHORT',
                ${`${YEAR}-07-04`}::date, 'probe')
      `
    })
    expect(refusal).toContain('ZY175')
    // One fil short is the case, deliberately: a residue of one fil on a liability account is exactly what
    // nobody revisits, and a check that only caught gross errors would let it through.
    expect(refusal).toContain(String(accrued))
  })

  it('ZY176 — a settlement for somebody still employed is refused', async () => {
    /*
     * The amount has to be the CORRECT one, or ZY175 refuses first and this case asserts a rule it never
     * reached. That is exactly what the first version did — and finding it is what uncovered a real defect in
     * the migration: PostgreSQL fires BEFORE triggers in NAME order, not creation order, so the amount check
     * was running first despite a comment in 0107 claiming the leaver check did. The triggers are now named
     * `..._check_1_is_for_a_leaver` and `..._check_2_clears_the_liability` to carry the sequence.
     */
    const [liability] = await readGratuityLiabilities(sql, [of('CORRECT')])
    const accrued = (liability as { accruedFils: number }).accruedFils
    expect(accrued).toBeGreaterThan(0)
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-STILLHERE', ${`${YEAR}-07-04`}::date, 'probe', 'payroll')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-STILLHERE', 1, ${accounts.liability as string}, ${accrued}, 0),
               ('PHR13-STILLHERE', 2, ${payableAccount}, 0, ${accrued})
      `
      await tx`
        insert into gratuity_settlement (employee_id, employed_until, settled_fils, entry_id, entry_date,
                                         created_by)
        values (${of('CORRECT')}::uuid, ${`${YEAR}-06-30`}::date, ${accrued}, 'PHR13-STILLHERE',
                ${`${YEAR}-07-04`}::date, 'probe')
      `
    })
    expect(refusal).toContain('ZY176')
    expect(refusal).toContain('employed_until')
    // And the ORDER is now the one the migration intends, which is the half a single SQLSTATE cannot state:
    // the leaver refusal arrives even though the amount is right, so it is not merely reachable — it is first.
    expect(refusal).not.toContain('ZY175')
  })

  it('one settlement per employee: a second is refused at the index', async () => {
    /*
     * The amount has to be the CORRECT one, and the first version of this case got that wrong: it offered one
     * fil, and ZY175 refused it for the amount before the unique index was ever reached — so the case passed
     * a refusal and asserted the wrong constraint's name. The trigger fires before the index, which is right
     * (the more specific complaint is the more useful one) and means a probe for the index has to satisfy
     * everything in front of it.
     *
     * `employee_gratuity_liability` sums the ACCRUAL rows and is not reduced by a settlement, so the live
     * figure is still the accrued total after the settlement has posted — which is what makes a correct
     * second settlement expressible at all.
     */
    /*
     * Both settlements are created inside the rolled-back transaction, so the case does not depend on the
     * end-to-end case above having committed one first. The first version did depend on it, and when that case
     * failed this one passed — reporting that a second settlement was allowed, which was true only because
     * there had been no first.
     */
    const [liability] = await readGratuityLiabilities(sql, [of('LEAVER')])
    const accrued = (liability as { accruedFils: number }).accruedFils
    const refusal = await refusalOf(async (tx) => {
      for (const suffix of ['ONE', 'TWO']) {
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`PHR13-TWICE-${suffix}`}, ${`${YEAR}-07-04`}::date, 'probe', 'payroll')
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
          values (${`PHR13-TWICE-${suffix}`}, 1, ${accounts.liability as string}, ${accrued}, 0),
                 (${`PHR13-TWICE-${suffix}`}, 2, ${payableAccount}, 0, ${accrued})
        `
        await tx`
          insert into gratuity_settlement (employee_id, employed_until, settled_fils, entry_id, entry_date,
                                           created_by)
          values (${of('LEAVER')}::uuid, ${`${YEAR}-06-30`}::date, ${accrued}, ${`PHR13-TWICE-${suffix}`},
                  ${`${YEAR}-07-04`}::date, 'probe')
        `
      }
    })
    expect(refusal).toContain('gratuity_settlement_employee_id_key')
  })
})

// --- the reconciliation ---------------------------------------------------------------------------

describe('reconciliation: the liability account equals the accrual rows for the same period', () => {
  it('ties the liability account to gratuity_accrual over the accrued period', async () => {
    /*
     * The acceptance line. Filtered by `journal_entry.source = 'gratuity_accrual'` rather than taken as the
     * whole account balance, and that is production behaviour rather than test convenience: the liability
     * account also carries a leaver's settlement (a payroll-sourced debit) and will one day carry an opening
     * balance, so an accountant tying the account to the HR schedule filters by source. It is also what
     * makes the claim isolated from any other suite that posts to 2070 — brief rule 12.
     *
     * Restricted to entries dated inside the accrued window, which is what "for the same period" means: an
     * accrual for a LOCKED month is dated outside its own month, so grouping by accrual_month and grouping
     * by entry_date give different answers, and only the second one reconciles to a period's ledger.
     */
    const from = `${YEAR - 2}-01-01`
    const to = `${YEAR}-06-30`
    const [ledger] = await sql<{ credit: string; debit: string }[]>`
      select coalesce(sum(l.credit_fils), 0)::text as credit,
             coalesce(sum(l.debit_fils), 0)::text  as debit
        from journal_line l
        join journal_entry e on e.entry_id = l.entry_id
       where l.account_code = ${accounts.liability as string}
         and e.source = 'gratuity_accrual'
         and e.entry_date between ${from}::date and ${to}::date
    `
    const [schedule] = await sql<{ accrued: string }[]>`
      select coalesce(sum(accrued_fils), 0)::text as accrued
        from gratuity_accrual
       where entry_date between ${from}::date and ${to}::date
    `
    const credited = Number((ledger as { credit: string }).credit)
    const debited = Number((ledger as { debit: string }).debit)
    const accrued = Number((schedule as { accrued: string }).accrued)

    expect(credited - debited).toBe(accrued)
    // The control: the figures are not zero, or the equality would be two empty sums agreeing — which is
    // precisely how this reconciliation would go vacuous if a filter stopped matching (ADR 0002).
    expect(accrued).toBeGreaterThan(0)
    expect(credited).toBeGreaterThan(0)
  })

  it('still reconciles when the month is CLOSED, which is when anybody reads it', async () => {
    // Asserted with the period LOCKED, inside a rolled-back transaction, because a closed month is the state
    // the figure is read in: the liability on a filed balance sheet. Locking must not change the answer — and
    // if the lock had somehow excluded the rows, this is what would say so.
    const from = `${YEAR - 2}-01-01`
    const to = `${YEAR}-06-30`
    const answer = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${`PHR13-CLOSED-${YEAR}`}, ${from}::date, ${to}::date, 'P-HR-13 reconciliation', 'staff')
      `
      const [ledger] = await tx<{ net: string }[]>`
        select (coalesce(sum(l.credit_fils), 0) - coalesce(sum(l.debit_fils), 0))::text as net
          from journal_line l join journal_entry e on e.entry_id = l.entry_id
         where l.account_code = ${accounts.liability as string}
           and e.source = 'gratuity_accrual'
           and e.entry_date between ${from}::date and ${to}::date
      `
      const [schedule] = await tx<{ accrued: string }[]>`
        select coalesce(sum(accrued_fils), 0)::text as accrued from gratuity_accrual
         where entry_date between ${from}::date and ${to}::date
      `
      if (
        Number((ledger as { net: string }).net) !==
        Number((schedule as { accrued: string }).accrued)
      ) {
        throw new Error('RECONCILIATION_FAILED')
      }
    })
    expect(answer).toBe('')
  })
})

// --- the closed-period labour adjustment (P-HR-07's re-pointed gap) -------------------------------

describe('closed_period_labour_adjustment — P-HR-07’s gap, re-pointed here by P-HR-12', () => {
  const WORKED_ON = `${YEAR}-01-15`
  const lockId = `PHR13-ADJ-${YEAR}-01`

  async function withLockedJanuary<T>(body: (tx: Sql) => Promise<T>): Promise<T | string> {
    let captured: T | undefined
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${lockId}, ${`${YEAR}-01-01`}::date, ${`${YEAR}-01-31`}::date, 'P-HR-13 adj probe', 'staff')
      `
      captured = await body(tx)
    })
    return refusal === '' ? (captured as T) : refusal
  }

  it('records unrecorded work as wages expense against a payable, in the open period', async () => {
    const result = await withLockedJanuary(async (tx) => {
      const [expense] = await tx<{ code: string }[]>`
        select code from account where type = 'expense' and code = ${accounts.expense as string}
      `
      const entryId = 'PHR13-ADJ-OK'
      const entryDate = `${YEAR}-02-28`
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, ${entryDate}::date,
                ${`Unrecorded work by ${TAG} ADJUST on ${WORKED_ON}, in locked accounting period "${lockId}": covered a double shift`},
                'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${entryId}, 1, ${(expense as { code: string }).code}, 40000, 0),
               (${entryId}, 2, ${payableAccount}, 0, 40000)
      `
      await tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${WORKED_ON}::date, ${lockId}, 40000,
                'Covered a double shift; the front desk never recorded a clock-out.',
                'PHR13 manager', 'PHR13 front desk', ${entryId}, ${entryDate}::date)
      `
      const [row] = await tx<{ narrative: string; entry_date: string }[]>`
        select narrative, entry_date::text as entry_date from journal_entry where entry_id = ${entryId}
      `
      return row
    })
    expect(typeof result).toBe('object')
    const row = result as { narrative: string; entry_date: string }
    // Dated in the OPEN period and naming the locked one. That pair is the whole answer to the gap: the work
    // is paid, and the month it belongs to is stated rather than restated.
    expect(row.entry_date).toBe(`${YEAR}-02-28`)
    expect(row.narrative).toContain(lockId)
    expect(row.narrative).toContain(WORKED_ON)
  })

  it('ZY177 — refuses an adjustment for work in a period that is NOT locked', async () => {
    // While the month is open the answer is an audited attendance correction (0086), not a ledger
    // adjustment: a correction amends the attendance register and this does not, so using it here would pay
    // the work and leave the register still saying nobody came in.
    const refusal = await refusalOf(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${lockId}, ${`${YEAR}-01-01`}::date, ${`${YEAR}-01-31`}::date, 'probe', 'staff')
      `
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-ADJ-OPEN', ${`${YEAR}-05-31`}::date, 'probe', 'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-ADJ-OPEN', 1, ${accounts.expense as string}, 100, 0),
               ('PHR13-ADJ-OPEN', 2, ${payableAccount}, 0, 100)
      `
      await tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${`${YEAR}-04-10`}::date, ${lockId}, 100, 'probe',
                'PHR13 manager', 'PHR13 front desk', 'PHR13-ADJ-OPEN', ${`${YEAR}-05-31`}::date)
      `
    })
    expect(refusal).toContain('ZY177')
  })

  it('ZY177 — refuses an adjustment naming the wrong locked period', async () => {
    const refusal = await withLockedJanuary(async (tx) => {
      await tx`
        insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
        values (${`${lockId}-B`}, ${`${YEAR}-03-01`}::date, ${`${YEAR}-03-31`}::date, 'probe', 'staff')
      `
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('PHR13-ADJ-WRONG', ${`${YEAR}-05-31`}::date, 'probe', 'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('PHR13-ADJ-WRONG', 1, ${accounts.expense as string}, 100, 0),
               ('PHR13-ADJ-WRONG', 2, ${payableAccount}, 0, 100)
      `
      await tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${WORKED_ON}::date, ${`${lockId}-B`}, 100, 'probe',
                'PHR13 manager', 'PHR13 front desk', 'PHR13-ADJ-WRONG', ${`${YEAR}-05-31`}::date)
      `
    })
    expect(String(refusal)).toContain('ZY177')
  })

  it('refuses a downward adjustment: this table only ever pays for work', async () => {
    const refusal = await withLockedJanuary(
      (tx) => tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${WORKED_ON}::date, ${lockId}, -100, 'probe',
                'PHR13 manager', 'PHR13 front desk', 'PHR13-ADJ-NEG', ${`${YEAR}-05-31`}::date)
      `,
    )
    // The CHECK, and the domain beneath it: `fils_nonneg` refuses a negative before the CHECK is reached.
    // Either refusal is the right one; the claim is that a reduction cannot be recorded here at all, because
    // 0104's payroll_deduction is what reduces pay and this is the gap that needed the opposite sign.
    expect(String(refusal)).toMatch(/closed_period_labour_adjustment_is_upward|fils_nonneg/)
  })

  it('refuses a blank or placeholder reason: it is the only evidence the work happened', async () => {
    for (const reason of ['   ', 'TBC']) {
      const refusal = await withLockedJanuary(
        (tx) => tx`
          insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
            amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
          values (${of('ADJUST')}::uuid, ${WORKED_ON}::date, ${lockId}, 100, ${reason},
                  'PHR13 manager', 'PHR13 front desk', 'PHR13-ADJ-BLANK', ${`${YEAR}-05-31`}::date)
        `,
      )
      expect(String(refusal)).toContain('closed_period_labour_adjustment_reason_is_stated')
    }
  })

  it('refuses an entry dated before the work, even from outside every lock', async () => {
    /*
     * Dated in the December BEFORE the locked January, which is outside every lock — so ZY177 has nothing to
     * say and the table CHECK is what refuses. The first version of this case used `worked_on` itself as the
     * entry date, which is INSIDE the lock, so ZY177 refused it first and the case asserted the wrong rule's
     * name while reporting PASS about a CHECK it had never reached.
     */
    const refusal = await withLockedJanuary(
      (tx) => tx`
        insert into closed_period_labour_adjustment (employee_id, worked_on, locked_period_id,
          amount_fils, reason, authorised_by, recorded_by, entry_id, entry_date)
        values (${of('ADJUST')}::uuid, ${WORKED_ON}::date, ${lockId}, 100, 'probe',
                'PHR13 manager', 'PHR13 front desk', 'PHR13-ADJ-EARLY', ${`${YEAR - 1}-12-31`}::date)
      `,
    )
    expect(String(refusal)).toContain('closed_period_labour_adjustment_dated_after_the_work')
  })

  it('leaves no lock behind', async () => {
    const locks = await sql<{ period_id: string }[]>`
      select period_id from period_lock where period_id like ${'PHR13%'}
    `
    expect(locks).toEqual([])
  })
})

import { localDate, monthEnd } from '@berelax/core'
import {
  createConnection,
  readGratuityAccruals,
  readGratuityLiabilities,
  type Sql,
} from '@berelax/db'
import { beforeAll, describe, expect, it } from 'vitest'
import { JOB_REGISTRY } from '../registry.ts'
import {
  CATCH_UP_MONTHS,
  GRATUITY_ACCRUAL_AGENT,
  GRATUITY_ACCRUED_EVENT,
  runGratuityAccrual,
} from './gratuity-accrual.ts'

/**
 * P-HR-13 — the monthly gratuity pass against real PostgreSQL.
 *
 * The arithmetic is proved without a database by `packages/core/src/hr/gratuity.test.ts`, and the schema's
 * refusals by `packages/fixtures/src/hr-gratuity.itest.ts`. This file proves the four things that are
 * properties of the PASS and of nothing else:
 *
 *   1. **Which month is complete is a question about the TRADING session**, read from `business_day`. A pass
 *      at 01:30 on 1 July accrues through May, because the session in force opened on 30 June and June's
 *      last trading day has not finished; the same pass at 05:00 accrues June. That is not a rounding
 *      difference — 01:30 is when a 1st-of-the-month cron would run if it ran at midnight.
 *   2. **A second run posts no journal line and no accrual row.** The guarantee is a partial unique index
 *      plus a pre-check, so this is the only place it can be shown to hold.
 *   3. **An employee who cannot be priced is NAMED, never accrued at zero** — and the two reasons are
 *      reported separately, because "put the wage in" and "confirm the HR file" are different things to do.
 *   4. **A month whose period is locked still accrues, into the next OPEN period.** The pass walks forward
 *      past consecutive locks, which no pure test can exercise because `period_lock_for` is a database
 *      function.
 *
 * ## Isolation (brief rule 12)
 *
 * The pass reads the WHOLE roster when it is not narrowed, so every call below passes `employeeIds`. An
 * unnarrowed run from here would accrue for the nineteen seeded therapists and for every other suite's
 * fixture employees, into a table that refuses DELETE for every role (ZY171).
 *
 * Everything is in **2085**, which no other suite writes into — `hr-gratuity.itest.ts` has 2083 and
 * `hr-payroll.itest.ts` has 2079. Employees are prefixed `PHR13 JOB` with STABLE references, and there is
 * deliberately **no truncate**: every accrual row names a `journal_entry`, and `journal_entry` refuses DELETE
 * for every role including the owner (ZL001), so emptying the accrual table would leave its entries behind
 * and the next run would die on `journal_entry_pkey`. That is not hypothetical — it is what the first version
 * of `hr-gratuity.itest.ts` did, and the failure named a duplicate key in a suite that had just emptied the
 * table it thought it owned. So the pass's own idempotence is what keeps this file re-runnable, which is
 * fitting: it is the property under test.
 *
 * No employee here has a name (brief rule 10), and every figure is this file's own fixture: `Y8-staff`
 * records that all nineteen real employees have `basic_wage_fils` null and `Y9-gratuity` that not one
 * gratuity figure is confirmed.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const TAG = 'PHR13 JOB'
/** 2085 is nobody else's. */
const YEAR = 2085
const WAGE = 300_000

/**
 * A SECOND year, whose second quarter is permanently locked.
 *
 * Separate from {@link YEAR} because the lock cannot be undone. `gratuity_accrual.locked_period_id`
 * references `period_lock(period_id)`, so the moment an accrual names a lock that lock can no longer be
 * deleted — and the accrual cannot be deleted either (ZY171). That is ADR 0026 made structural rather than a
 * limitation of this suite: a closed period a liability has been posted against is not a period anybody may
 * re-open, and the foreign key says so.
 *
 * The first version of this block locked a quarter of {@link YEAR}, ran the pass and removed the lock in a
 * `finally`. The delete failed on that foreign key, and the lock stayed — rebasing every other case in the
 * file on the next run. So the lock lives in a year of its own, is created with `on conflict do nothing`, and
 * is never removed.
 */
const LOCKED_YEAR = 2087
const LOCK_ID = `PHR13JOB-${LOCKED_YEAR}-Q2`
/** 05:15 on 5 July of the locked year, so June is the last complete month there too. */
const LOCKED_AFTER_CLOSE = `${LOCKED_YEAR}-07-05T05:15:00+04:00`

/** The trading days the pass is driven around. `businessDayAt` needs a row at or before the instant. */
const TRADING_DAYS = [`${YEAR}-06-30`, `${YEAR}-07-04`, `${LOCKED_YEAR}-07-04`] as const
/** 05:15 on 5 July: the session that opened on the 4th has closed, so June is the last complete month. */
const AFTER_CLOSE = `${YEAR}-07-05T05:15:00+04:00`
/** 01:30 on 1 July: the session in force opened on 30 June and has NOT closed, so May is the last one. */
const INSIDE_SESSION = `${YEAR}-07-01T01:30:00+04:00`

const employees = new Map<string, string>()
const of = (handle: string): string => employees.get(handle) as string

async function makeEmployee(
  handle: string,
  args: { employedFrom: string; wage?: number | null; provisional?: boolean },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, basic_wage_fils, is_provisional,
                          provisional_note, open_question_id)
    values (${`${TAG} ${handle}`}, ${args.employedFrom}::date,
            ${args.wage === undefined ? WAGE : args.wage},
            ${args.provisional ?? false},
            ${args.provisional === true ? 'P-HR-13 pass fixture: a provisional employment record' : null},
            ${args.provisional === true ? 'Y8-staff' : null})
    on conflict (staff_reference) do update
      set employed_from = excluded.employed_from,
          basic_wage_fils = excluded.basic_wage_fils,
          is_provisional = excluded.is_provisional,
          provisional_note = excluded.provisional_note,
          open_question_id = excluded.open_question_id
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })

  for (const day of TRADING_DAYS) {
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
  // A lock over 2085 left behind by an interrupted earlier run of THIS file would rebase every accrual below
  // and every case would report that instead. Scoped to 2085, which is this file's year.
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

  // STEADY: engaged three years ago, so every month the catch-up reaches earns at the first band.
  await makeEmployee('STEADY', { employedFrom: `${YEAR - 3}-01-01` })
  // PROBATION: engaged in May, so June is month two of a six-month probation that does not accrue.
  await makeEmployee('PROBATION', { employedFrom: `${YEAR}-05-01` })
  // NOWAGE: the state all nineteen seeded employees are in (Y8-staff).
  await makeEmployee('NOWAGE', { employedFrom: `${YEAR - 3}-01-01`, wage: null })
  // PROVISIONAL: a wage IS set, and the employment record is still flagged. This is the case the pass must
  // refuse anyway, because service length multiplies the liability rather than adding to it.
  await makeEmployee('PROVISIONAL', { employedFrom: `${YEAR - 3}-01-01`, provisional: true })
  // LOCKED lives in the locked year, engaged three years before it.
  await makeEmployee('LOCKED', { employedFrom: `${LOCKED_YEAR - 3}-01-01` })

  // The permanent lock over the locked year's second quarter. `on conflict do nothing`, because it survives
  // every run and must not be re-created — and three months in ONE lock, so the pass has to walk forward past
  // the whole of it rather than stepping once.
  await sql`
    insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
    values (${LOCK_ID}, ${`${LOCKED_YEAR}-04-01`}::date, ${`${LOCKED_YEAR}-06-30`}::date,
            'P-HR-13 permanent lock: the pass suite asserts an accrual rebases past it', 'staff')
    on conflict (period_id) do nothing
  `
}, 60_000)

describe('the pass is registered as a cron with an agent behind it', () => {
  it('appears in the job registry with the agent 0107 seeds', async () => {
    const entry = JOB_REGISTRY.find((job) => job.name === 'hr.gratuity-accrual')
    expect(entry).toBeDefined()
    expect(entry?.agent).toBe(GRATUITY_ACCRUAL_AGENT)
    // `assertRegistry` refuses a cron with no `agent_definition`, and the watchdog measures a dead pass
    // against the interval on that row. Asserted against the database rather than the constant, because a
    // registry naming an agent the migration never seeded is the failure this pair prevents.
    const [agent] = await sql<{ expected_interval_seconds: number; enabled: boolean }[]>`
      select expected_interval_seconds, enabled from agent_definition
       where agent_key = ${GRATUITY_ACCRUAL_AGENT}
    `
    expect(agent).toBeDefined()
    // 31 days: a monthly cron, so a dead pass is reported after about two months rather than two hours.
    expect(agent?.expected_interval_seconds).toBe(2_678_400)
    expect(agent?.enabled).toBe(true)
  })

  it('runs after the leave accrual, so two roster-wide passes do not contend', () => {
    const gratuity = JOB_REGISTRY.find((job) => job.name === 'hr.gratuity-accrual')
    const leave = JOB_REGISTRY.find((job) => job.name === 'hr.leave-accrual')
    // Both are monthly on the 1st and both read the whole roster. The minute differs deliberately: two
    // passes contending for the same rows is a lock wait that presents as a slow job rather than as a clash.
    expect(gratuity?.cron).toBe('15 5 1 * *')
    expect(leave?.cron).toBe('0 5 1 * *')
  })
})

describe('which month has completed is a question about the trading session', () => {
  /*
   * Driven on the UNPRICED employee throughout, deliberately. These three cases are about which month the
   * pass decides is complete and nothing else, and an unpriced employee is excluded before anything is
   * written — so the block has no side effects.
   *
   * The first version drove them on STEADY, which accrued STEADY's whole catch-up window before the block
   * below ran, and that block's `beforeAll` then wrote nothing and every assertion about what it posted
   * failed. Test ORDER decided the result, which is the shape brief rule 12 is about, arriving from inside
   * one file instead of from another suite.
   */
  it('at 05:15 on 5 July, June is complete', async () => {
    const run = await runGratuityAccrual(sql, AFTER_CLOSE, { employeeIds: [of('NOWAGE')] })
    expect(run.throughMonth).toBe(`${YEAR}-06-01`)
    expect(run.withinTradingHours).toBe(false)
  }, 60_000)

  it('at 01:30 on 1 July, June is NOT complete and the pass reaches only May', async () => {
    // The session in force opened at 11:00 on 30 June and closes at 02:00 on 1 July, so at 01:30 June's last
    // trading day is still running. A calendar reading of "last month" says June and is wrong for exactly
    // the two hours in which a midnight cron fires.
    const run = await runGratuityAccrual(sql, INSIDE_SESSION, { employeeIds: [of('NOWAGE')] })
    expect(run.tradingDate).toBe(`${YEAR}-06-30`)
    expect(run.withinTradingHours).toBe(true)
    expect(run.throughMonth).toBe(`${YEAR}-05-01`)
  }, 60_000)

  it('refuses to guess when business_day holds no session at or before the instant', async () => {
    // Before the trading calendar exists there is no answer, and deriving one from the instant's own
    // calendar date would accrue the wrong month for every pass between midnight and 02:00.
    await expect(
      runGratuityAccrual(sql, '1900-01-01T05:00:00+04:00', { employeeIds: [of('NOWAGE')] }),
    ).rejects.toThrow(/business_day/)
  }, 60_000)
})

describe('the pass', () => {
  let first: Awaited<ReturnType<typeof runGratuityAccrual>>

  beforeAll(async () => {
    first = await runGratuityAccrual(sql, AFTER_CLOSE, {
      employeeIds: [of('STEADY'), of('PROBATION'), of('NOWAGE'), of('PROVISIONAL')],
    })
  }, 120_000)

  it('accrues the catch-up window and no further back than it', async () => {
    const rows = await readGratuityAccruals(sql, {
      employeeIds: [of('STEADY')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    expect(rows.length).toBeGreaterThan(0)
    // Bounded by CATCH_UP_MONTHS. Without the bound a first run against a roster engaged years ago would
    // derive a decade of liability the business has no record of agreeing.
    expect(rows.length).toBeLessThanOrEqual(CATCH_UP_MONTHS)
    // And the oldest month is inside the window rather than at the employment date, which is the claim the
    // bound actually makes. STEADY was engaged three years before the window.
    const oldest = rows[0]?.accrualMonth as string
    expect(oldest > `${YEAR - 3}-01-01`).toBe(true)
  })

  it('posts a balanced two-line entry per accrual, each summing to zero fils', async () => {
    // Read from the TABLE rather than from `first.written`, so the case holds on a re-run where the rows
    // already exist and the pass correctly wrote nothing. Nothing in these three tables can be removed, so
    // "what this run wrote" is not a stable basis for an assertion about what is there.
    const stored = await readGratuityAccruals(sql, {
      employeeIds: [of('STEADY')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    expect(stored.length).toBeGreaterThan(0)
    const rows = await sql<{ entry_id: string; net: string; lines: number }[]>`
      select entry_id,
             (sum(debit_fils) - sum(credit_fils))::text as net,
             count(*)::int                              as lines
        from journal_line
       where entry_id = any (${stored.map((a) => a.entryId)}::text[])
       group by entry_id
    `
    expect(rows).toHaveLength(stored.length)
    for (const row of rows) {
      expect(Number(row.net)).toBe(0)
      expect(row.lines).toBe(2)
    }
  })

  it('writes one audit row and one outbox event per accrual, in the same transaction', async () => {
    const [audit] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where action = 'gratuity.accrued' and entity_id = ${of('STEADY')}
    `
    // A liability with no audit row is a balance-sheet change nobody can account for, which is what
    // `UnitOfWork` exists to make impossible. Asserted as a count against the rows this employee has.
    const accruals = await readGratuityAccruals(sql, {
      employeeIds: [of('STEADY')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    expect(Number(audit?.n)).toBe(accruals.length)

    const [events] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event
       where event_type = ${GRATUITY_ACCRUED_EVENT} and aggregate_id = ${of('STEADY')}
    `
    // Keyed on (employee, accrual_month), so a retried transaction enqueues nothing and a genuine later
    // month still notifies — which is why this is an equality and not a lower bound.
    expect(Number(events?.n)).toBe(accruals.length)
  })

  it('posts nothing for an employee every month of whose window is inside probation', async () => {
    const forProbation = await readGratuityAccruals(sql, {
      employeeIds: [of('PROBATION')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    expect(forProbation).toEqual([])
    // The control that stops this passing because the pass accrues nobody at all.
    const forSteady = await readGratuityAccruals(sql, {
      employeeIds: [of('STEADY')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    expect(forSteady.length).toBeGreaterThan(0)
  })

  it('names an unpriced employee rather than accruing them at zero', () => {
    expect(first.written.some((w) => w.employeeId === of('NOWAGE'))).toBe(false)
    expect(first.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ employeeId: of('NOWAGE'), reason: 'unpriced' }),
      ]),
    )
  })

  it('refuses an employee whose employment RECORD is provisional, even with a wage set', () => {
    /*
     * The exclusion this pass adds that the labour-cost forecast does not have, and the reason is what the
     * two figures are. The nineteen seeded therapists carry `employed_from = 1970-01-01`, an epoch
     * placeholder 0050's seeder chose precisely because it cannot be mistaken for a transcribed fact — so
     * accruing against one would owe fifty-six years of gratuity rather than a slightly wrong figure.
     *
     * A forecast that is wrong by decades is obviously wrong. A balance-sheet liability that is wrong by
     * decades sits there looking like a number.
     */
    expect(first.written.some((w) => w.employeeId === of('PROVISIONAL'))).toBe(false)
    expect(first.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          employeeId: of('PROVISIONAL'),
          reason: 'provisional_employment_record',
        }),
      ]),
    )
    // Reported SEPARATELY from unpriced, because the two have different answers: one is "put the wage in",
    // the other is "confirm the HR file", which is Y8-staff. A single "skipped" count would send somebody
    // to the wrong one.
    const reasons = new Set(first.excluded.map((e) => e.reason))
    expect(reasons).toEqual(new Set(['unpriced', 'provisional_employment_record']))
  })

  it('refuses the seeded therapists for that reason, against the real roster', async () => {
    const [seeded] = await sql<{ id: string; employed_from: string }[]>`
      select id, employed_from::text as employed_from
        from employee where is_provisional and staff_reference like 'Therapist%'
       order by staff_reference limit 1
    `
    // Asserted against the seed rather than against a fixture, because the figure that makes this matter is
    // the seed's own epoch date.
    expect(seeded?.employed_from).toBe('1970-01-01')
    const run = await runGratuityAccrual(sql, AFTER_CLOSE, {
      employeeIds: [(seeded as { id: string }).id],
    })
    expect(run.written).toEqual([])
    expect(run.excluded).toEqual([
      expect.objectContaining({ reason: 'provisional_employment_record' }),
    ])
  }, 60_000)

  it('is idempotent: a second run posts no journal line and no accrual row', async () => {
    const before = await sql<{ lines: string; accruals: string }[]>`
      select (select count(*) from journal_line l join journal_entry e on e.entry_id = l.entry_id
               where e.source = 'gratuity_accrual')::text as lines,
             (select count(*) from gratuity_accrual)::text as accruals
    `
    const second = await runGratuityAccrual(sql, AFTER_CLOSE, {
      employeeIds: [of('STEADY'), of('PROBATION'), of('NOWAGE'), of('PROVISIONAL')],
    })
    const after = await sql<{ lines: string; accruals: string }[]>`
      select (select count(*) from journal_line l join journal_entry e on e.entry_id = l.entry_id
               where e.source = 'gratuity_accrual')::text as lines,
             (select count(*) from gratuity_accrual)::text as accruals
    `
    expect(second.written).toEqual([])
    expect(second.accruedFils).toBe(0)
    // A DELTA of zero rather than a total, because other suites' rows are in these tables (brief rule 9).
    expect(Number(after[0]?.lines) - Number(before[0]?.lines)).toBe(0)
    expect(Number(after[0]?.accruals) - Number(before[0]?.accruals)).toBe(0)
    // And the exclusions are reported again, because a pass that logged only when it wrote something would
    // be indistinguishable from a pass that had stopped.
    expect(second.excluded.length).toBe(first.excluded.length)
    expect(second.considered).toBe(first.considered)
  }, 120_000)

  it('the liability the pass built equals the engine’s own figure for the same service', async () => {
    const [row] = await readGratuityLiabilities(sql, [of('STEADY')])
    const accruals = await readGratuityAccruals(sql, {
      employeeIds: [of('STEADY')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    // The movements sum to the last cumulative figure, exactly — ADR 0057's claim, over rows a cron wrote.
    const summed = accruals.reduce((total, a) => total + a.accruedFils, 0)
    expect(row?.accruedFils).toBe(summed)
    expect(accruals.at(-1)?.cumulativeFils).toBe(summed)
    expect(summed).toBeGreaterThan(0)
    // The last month accrued is the last COMPLETE month, and its `accrued_to` is that month's end.
    expect(accruals.at(-1)?.accrualMonth).toBe(`${YEAR}-06-01`)
    expect(accruals.at(-1)?.accruedTo).toBe(monthEnd(localDate(`${YEAR}-06-01`)) as string)
  })
})

describe('a locked accounting period', () => {
  it('rebases the accrual into the next OPEN period, naming the locked one', async () => {
    await runGratuityAccrual(sql, LOCKED_AFTER_CLOSE, { employeeIds: [of('LOCKED')] })

    // Read the STORED row rather than the run's return value, so the case holds on a re-run where the row
    // already exists and the pass correctly wrote nothing.
    const [row] = await sql<
      { entry_date: string; locked_period_id: string | null; accrual_month: string }[]
    >`
      select entry_date::text as entry_date, locked_period_id, accrual_month::text as accrual_month
        from gratuity_accrual
       where employee_id = ${of('LOCKED')}::uuid and accrual_month = ${`${LOCKED_YEAR}-06-01`}::date
    `
    expect(row).toBeDefined()
    const stored = row as {
      entry_date: string
      locked_period_id: string | null
      accrual_month: string
    }
    // The liability was EARNED in June and is POSTED in July, naming the lock. Both halves matter: skipping
    // the month would understate the liability for ever, and dating it in June is impossible (ADR 0026).
    expect(stored.accrual_month).toBe(`${LOCKED_YEAR}-06-01`)
    expect(stored.locked_period_id).toBe(LOCK_ID)
    // Past the WHOLE lock and not one month on. April, May and June are all inside it, so a single step from
    // April would have landed in May — still locked — which is the case the walk exists for.
    expect(stored.entry_date).toBe(`${LOCKED_YEAR}-07-31`)

    // And the narrative carries the dated reference, which is the half of the acceptance line no SQLSTATE can
    // express: an accountant reading July needs to know the figure belongs to a month they have filed.
    const [entry] = await sql<{ narrative: string }[]>`
      select e.narrative from journal_entry e
        join gratuity_accrual a on a.entry_id = e.entry_id
       where a.employee_id = ${of('LOCKED')}::uuid
         and a.accrual_month = ${`${LOCKED_YEAR}-06-01`}::date
    `
    expect(entry?.narrative).toContain(LOCK_ID)
    expect(entry?.narrative).toContain(`${LOCKED_YEAR}-06-01`)
    expect(entry?.narrative).toContain('locked')
  }, 120_000)

  it('every month INSIDE the lock is rebased, not just the last one', async () => {
    // April and May are inside the lock too, and each is a separate accrual. Every one of them must carry the
    // lock and a July date: a pass that rebased only the month it happened to finish on would leave the rest
    // dated inside a filed period, where ZY174 would have refused them — so this is also the assertion that
    // says the run completed rather than stopping at the first refusal.
    const rows = await sql<
      { accrual_month: string; entry_date: string; locked_period_id: string }[]
    >`
      select accrual_month::text as accrual_month, entry_date::text as entry_date, locked_period_id
        from gratuity_accrual
       where employee_id = ${of('LOCKED')}::uuid
         and accrual_month between ${`${LOCKED_YEAR}-04-01`}::date and ${`${LOCKED_YEAR}-06-01`}::date
       order by accrual_month
    `
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.locked_period_id).toBe(LOCK_ID)
      expect(row.entry_date).toBe(`${LOCKED_YEAR}-07-31`)
    }
  })

  it('the lock cannot be removed once an accrual names it, which is ADR 0026 made structural', async () => {
    // Attempted as the OWNER, which is the role `period_lock` is correctable by — 0018 deliberately gives it
    // no refusal trigger so a mis-typed range can be fixed by a migration. The foreign key is what refuses,
    // and it refuses for every role: a closed period a liability has been posted against is not a period
    // anybody may re-open.
    let refused = ''
    try {
      await sql`delete from period_lock where period_id = ${LOCK_ID}`
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err)
    }
    expect(refused).toContain('gratuity_accrual_locked_period_id_fkey')
  })

  it('leaves the ordinary year unlocked, so nothing above rebased it', async () => {
    const locks = await sql<{ period_id: string }[]>`
      select period_id from period_lock
       where starts_on >= ${`${YEAR}-01-01`}::date and ends_on <= ${`${YEAR}-12-31`}::date
    `
    expect(locks).toEqual([])
  })

  it('an accrual for an OPEN month is dated at its own month end', async () => {
    // The control on the rebasing: without it, "the entry is dated 31 July" would be satisfied by a pass that
    // dated everything late. STEADY's months are all open, so every one is dated on its own month end.
    const rows = await readGratuityAccruals(sql, {
      employeeIds: [of('STEADY')],
      fromMonth: `${YEAR - 5}-01-01`,
      toMonth: `${YEAR}-06-30`,
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.entryDate).toBe(row.accruedTo)
      expect(row.lockedPeriodId).toBeNull()
    }
  })
})

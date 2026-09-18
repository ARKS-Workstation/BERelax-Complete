import {
  createConnection,
  recordRecurringCost,
  recordSupplier,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import {
  RECURRING_COST_LOOK_BACK_MONTHS,
  RECURRING_COST_WINDOW_MONTHS,
  runRecurringCostCheck,
} from './recurring-cost-check.ts'

/**
 * M-VAT-04 — the nightly pass, driven end to end against real PostgreSQL.
 *
 * The one property the pure tests cannot reach is the one the acceptance is about: **an alert is raised
 * once across repeated job runs, not once per run.** That is a unique constraint plus
 * `on conflict do nothing`, so it can only be proved by running the job twice against a database.
 *
 * Every row this file writes is scoped to the run: the register's history tables are append-only and
 * refuse the owner too, so nothing here can be cleaned up afterwards (ADR 0008), and the integration
 * suite runs sequentially against one database where earlier files leave costs behind. The pass itself
 * sweeps the **whole** register, which is what it does in production — so every assertion below narrows
 * to this run's cost.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = { kind: 'system', label: 'recurring-cost-check-itest' } as const
const RUN = Date.now().toString(36)
const code = (suffix: string) => `itest-rcc-${suffix}-${RUN}`

/**
 * 03:45 on 19 September, Gulf time — the cron's own hour, and the case that makes reading the trading
 * calendar load-bearing. Trading closed at 02:00, so this instant belongs to the **18th**: a calendar
 * truncation would date every alert on the 19th, and at a month boundary into a period already filed.
 */
const AT_ISO = '2026-09-19T03:45:00+04:00'
const EXPECTED_AS_OF = '2026-09-18'

let sql: Sql
let costId = ''

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })

  // The trading session the pass must resolve to. `on conflict do nothing` rather than
  // `generateBusinessDays`, which deletes rows inside its horizon that it did not generate — and other
  // files in this suite own business_day rows.
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source) values
      ('2026-09-18', '2026-09-18T07:00:00Z', '2026-09-18T22:00:00Z', 'weekly')
    on conflict (trading_date) do nothing
  `

  const supplier = await withUnitOfWork(sql, ACTOR, (uow) =>
    recordSupplier(uow, {
      code: code('landlord'),
      legalName: 'FIXTURE (not a real supplier) — landlord',
      residency: 'domestic',
      placeOfSupplyRule: 'domestic_uae',
      trn: '000000000000003',
    }),
  )

  // Anchored in August, so two periods (August and September) are already past due on the 18th and
  // neither has a bill — which is exactly the shape the missing-cost alert exists for.
  const cost = await withUnitOfWork(sql, ACTOR, (uow) =>
    recordRecurringCost(uow, {
      code: code('rent'),
      description: 'Premises rent',
      supplierId: supplier.supplierId,
      expenseAccountCode: '6010',
      taxTreatment: 'standard_recoverable',
      cadence: 'monthly',
      firstDueDate: '2026-08-01',
      costKind: 'fixed',
      expectedAmountFils: 2_100_000,
      varianceToleranceBp: 0,
    }),
  )
  costId = cost.recurringCostId
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** The alerts a pass raised for this run's cost, ignoring every other file's. */
function mine(raised: readonly { recurringCostId: string; periodKey: string }[]) {
  return raised.filter((alert) => alert.recurringCostId === costId)
}

describe('acceptance — a missing cost alerts exactly once across repeated job runs', () => {
  it('dates the pass on the business day, not the calendar day the cron fired', async () => {
    const result = await runRecurringCostCheck(sql, AT_ISO)
    expect(result.asOf).toBe(EXPECTED_AS_OF)
  })

  it('generated this run cost its periods, and raised one alert per overdue unbilled period', async () => {
    // The first pass above did the work; this reads what it left. Asserted from the table rather than
    // from the return value, because the row is what somebody eventually opens.
    const rows = (await sql`
      select period_key, alert_kind, delta_fils, raised_for_date::text as raised_for_date
        from recurring_cost_alert where recurring_cost_id = ${costId}::uuid
       order by period_key
    `) as unknown as {
      period_key: string
      alert_kind: string
      delta_fils: string | null
      raised_for_date: string
    }[]
    expect(rows.map((row) => row.period_key)).toEqual(['2026-08', '2026-09'])
    for (const row of rows) {
      expect(row.alert_kind).toBe('missing_cost')
      // An absence is not a difference: nothing arrived, so there is nothing to differ from.
      expect(row.delta_fils).toBeNull()
      expect(row.raised_for_date).toBe(EXPECTED_AS_OF)
    }
  })

  it('raises nothing on the second and third pass of the same business day', async () => {
    for (const pass of [2, 3]) {
      const result = await runRecurringCostCheck(sql, AT_ISO)
      expect(mine(result.raised), `pass ${pass}`).toEqual([])
      // And it writes no periods either: generation is idempotent on the primary key.
      expect(result.generated, `pass ${pass}`).toBe(0)
    }
    const [count] = (await sql`
      select count(*)::int as n from recurring_cost_alert where recurring_cost_id = ${costId}::uuid
    `) as unknown as { n: number }[]
    expect(count?.n).toBe(2)
  })

  it('does not accumulate a fresh alert on a later business day either', async () => {
    // The dedup key is the period, not the run date. A key that included the as-of date would produce a
    // new alert every night for one unbilled August, and the 365th is the one nobody reads.
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source) values
        ('2026-09-25', '2026-09-25T07:00:00Z', '2026-09-25T22:00:00Z', 'weekly')
      on conflict (trading_date) do nothing
    `
    const later = await runRecurringCostCheck(sql, '2026-09-26T03:45:00+04:00')
    expect(later.asOf).toBe('2026-09-25')
    expect(mine(later.raised)).toEqual([])
    const [count] = (await sql`
      select count(*)::int as n from recurring_cost_alert where recurring_cost_id = ${costId}::uuid
    `) as unknown as { n: number }[]
    expect(count?.n).toBe(2)
  })

  it('generates across the declared window, so a new cost gets its periods on the first pass', async () => {
    // The control for the "generated 0" assertions above: the pass must be capable of writing something.
    const supplier = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordSupplier(uow, {
        code: code('late-supplier'),
        legalName: 'FIXTURE (not a real supplier) — late',
        residency: 'domestic',
        placeOfSupplyRule: 'domestic_uae',
        trn: '000000000000003',
      }),
    )
    const late = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordRecurringCost(uow, {
        code: code('late'),
        description: 'Trade licence renewal',
        supplierId: supplier.supplierId,
        expenseAccountCode: '6120',
        taxTreatment: 'out_of_scope',
        cadence: 'annual',
        firstDueDate: '2026-11-05',
        costKind: 'fixed',
        expectedAmountFils: 1_200_000,
        varianceToleranceBp: 0,
      }),
    )
    const result = await runRecurringCostCheck(sql, AT_ISO)
    expect(result.generated).toBeGreaterThan(0)
    const [count] = (await sql`
      select count(*)::int as n from recurring_cost_instance
       where recurring_cost_id = ${late.recurringCostId}::uuid
    `) as unknown as { n: number }[]
    // One renewal inside [2025-09-18, 2027-09-18): November 2026. November 2027 is past the window.
    expect(count?.n).toBe(1)
    // A period not yet due raises nothing, so the new cost is silent rather than immediately noisy.
    expect(mine(result.raised)).toEqual([])
  })

  it('bounds the look-back, so registering a long-standing contract is not a burst of alerts', async () => {
    // Twelve months back is one full VAT year. Generating from each cost's anchor would give a contract
    // anchored in 2019 seven years of unbilled periods and seven years of alerts on the day it was
    // registered, which is the same failure as an alert that fires every month.
    expect(RECURRING_COST_LOOK_BACK_MONTHS).toBe(12)
    expect(RECURRING_COST_WINDOW_MONTHS).toBe(24)

    const supplier = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordSupplier(uow, {
        code: code('ancient-supplier'),
        legalName: 'FIXTURE (not a real supplier) — ancient',
        residency: 'domestic',
        placeOfSupplyRule: 'domestic_uae',
        trn: '000000000000003',
      }),
    )
    const ancient = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordRecurringCost(uow, {
        code: code('ancient'),
        description: 'Premises rent',
        supplierId: supplier.supplierId,
        expenseAccountCode: '6010',
        taxTreatment: 'standard_recoverable',
        cadence: 'monthly',
        firstDueDate: '2019-03-01',
        costKind: 'fixed',
        expectedAmountFils: 2_100_000,
        varianceToleranceBp: 0,
      }),
    )
    const result = await runRecurringCostCheck(sql, AT_ISO)
    const raised = result.raised.filter(
      (alert) => alert.recurringCostId === ancient.recurringCostId,
    )
    // Twelve overdue periods at most, not eighty: [2025-09-18, 2026-09-18) holds twelve monthly ones,
    // and the periods after the 18th are not yet due.
    expect(raised.length).toBeLessThanOrEqual(12)
    expect(raised.length).toBeGreaterThan(0)
  })
})

describe('the pass refuses to guess a date it cannot resolve', () => {
  it('throws rather than dating its alerts by truncating a timestamp', async () => {
    // business_day holds nothing at or before 2001, so there is no business day. Substituting the
    // calendar date would put the alert a day out and, at a month boundary, into a filed period.
    await expect(runRecurringCostCheck(sql, '2001-01-01T00:00:00Z')).rejects.toThrow(
      /business_day holds no trading session/,
    )
  })
})

describe('the job is declared in the registry with an agent that has a row', () => {
  it('declares a daily cron after trading closes, naming its agent', () => {
    const job = JOB_REGISTRY.find((candidate) => candidate.name === 'recurring-cost.check')
    expect(job?.cron).toBe('45 3 * * *')
    expect(job?.agent).toBe('recurring_cost_register')
    // Declared in the registry rather than scheduled anywhere else: `pnpm jobs` is the static half of
    // this, and a schedule created outside the registry is never unscheduled when the job is removed.
    expect(cronRegistrations(JOB_REGISTRY).map((cron) => cron.name)).toContain(
      'recurring-cost.check',
    )
  })

  it('has an agent_definition and an agent_heartbeat row, so the watchdog can see it', async () => {
    // `agentsWithHeartbeat` INNER joins: an agent with no heartbeat row does not appear, and one that
    // does not appear is one the watchdog silently never checks.
    const [row] = (await sql`
      select d.expected_interval_seconds, d.budget_fils_per_run::text as budget,
             (h.agent_key is not null) as has_heartbeat
        from agent_definition d
        left join agent_heartbeat h on h.agent_key = d.agent_key
       where d.agent_key = 'recurring_cost_register'
    `) as unknown as {
      expected_interval_seconds: number
      budget: string
      has_heartbeat: boolean
    }[]
    expect(row?.expected_interval_seconds).toBe(60 * 60 * 24)
    // Zero: this pass is SQL and arithmetic, with no model call in it.
    expect(row?.budget).toBe('0')
    expect(row?.has_heartbeat).toBe(true)
  })
})

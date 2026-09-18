import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { recurringCostForecast } from '../queries/recurring-cost-forecast.ts'
import { isBalanced, trialBalanceAsAt } from '../queries/trial-balance.ts'
import { withUnitOfWork } from '../tx.ts'
import { postBill, purchaseError, recordSupplier } from './post-bill.ts'
import {
  generateRecurringInstances,
  isDuplicateRecurringCostMatch,
  matchBillToRecurringCost,
  postRecurringBill,
  RECURRING_COST_SQLSTATE,
  type RecurringCostInput,
  recordRecurringCost,
  recurringCostError,
  recurringCostPeriodStatus,
  sweepRecurringCostAlerts,
} from './recurring-cost.ts'

/**
 * M-VAT-04 — the recurring cost register against real PostgreSQL.
 *
 * Everything here is a guarantee that cannot be tested any other way: five CHECK constraints, two unique
 * constraints, six refusal triggers, a set of grants, and a variance computed by the database that has to
 * agree to the fils with the one `@berelax/core` computes. The pure half — the cadence arithmetic, the
 * validation refusals and the variance boundaries — is
 * `packages/core/src/money/recurring-schedule.test.ts`, and the two are proved to agree in
 * `packages/fixtures/src/recurring-costs.itest.ts`, the one package allowed to depend on both.
 *
 * ## Nothing here deletes a row, and every figure is scoped to this run
 *
 * `recurring_cost_instance`, `recurring_cost_match` and `recurring_cost_alert` are append-only and their
 * refusal triggers refuse the **owner** too, so a reset between tests is impossible by construction rather
 * than merely discouraged (ADR 0008). The integration suite also runs sequentially against one database
 * and earlier files leave rows behind, so every cost code, supplier code and supplier reference below
 * carries a per-run suffix and every query is narrowed to this run's ids. A count over "every recurring
 * cost" would pass until another unit landed.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR = { kind: 'system', label: 'm-vat-04-itest' } as const

/** Unique per run: nothing this suite writes can ever be deleted. */
const RUN = Date.now().toString(36)
/** The frozen clock of the fixture world, and a date in an open period by definition. */
const TODAY = '2026-09-18'
const TRN = '000000000000003'

let sql: Sql
let landlordId = ''
let otherSupplierId = ''

const code = (suffix: string) => `itest-mvat04-${suffix}-${RUN}`
const reference = (suffix: string) => `MVAT04-${suffix}-${RUN}`

/** The refusal a statement raised, or undefined when it was accepted. */
async function rejection(
  run: () => Promise<unknown>,
): Promise<{ code: string; constraint: string; message: string } | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    // Both shapes, because some of these statements go through a service that translates the refusal into
    // an AppError and some hit the database directly. A helper that only understood the raw driver error
    // would report an empty constraint name for every translated one and the probe would assert nothing.
    const e = error as {
      code?: string
      constraint_name?: string
      message?: string
      details?: Record<string, unknown>
    }
    const details = e.details ?? {}
    const carried = (key: string) =>
      typeof details[key] === 'string' ? (details[key] as string) : ''
    return {
      code: e.code ?? carried('sqlState'),
      constraint: e.constraint_name ?? carried('constraint'),
      message: e.message ?? '',
    }
  }
}

async function newSupplier(suffix: string): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const supplier = await recordSupplier(uow, {
      code: code(suffix),
      // A company, and unmistakably not a real one. A plausible company name gets exported and paid.
      legalName: `FIXTURE (not a real supplier) — ${suffix}`,
      residency: 'domestic',
      placeOfSupplyRule: 'domestic_uae',
      trn: TRN,
    })
    return supplier.supplierId
  })
}

function rentInput(
  suffix: string,
  overrides: Partial<RecurringCostInput> = {},
): RecurringCostInput {
  return {
    code: code(suffix),
    description: 'Premises rent',
    supplierId: landlordId,
    expenseAccountCode: '6010',
    taxTreatment: 'standard_recoverable',
    cadence: 'monthly',
    firstDueDate: '2026-01-01',
    costKind: 'fixed',
    expectedAmountFils: 2_100_000,
    varianceToleranceBp: 0,
    ...overrides,
  }
}

async function record(input: RecurringCostInput): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const cost = await recordRecurringCost(uow, input)
    return cost.recurringCostId
  })
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  landlordId = await newSupplier('landlord')
  otherSupplierId = await newSupplier('laundry')
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('acceptance — 24 months of a monthly cost: 24 instances, no duplicates, no gaps', () => {
  let costId = ''

  beforeAll(async () => {
    costId = await record(rentInput('rent-24'))
  })

  it('writes exactly one period per month across 24 simulated months', async () => {
    const generated = await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-01-01', months: 24, recurringCostId: costId }),
    )
    expect(generated).toHaveLength(24)

    const periods = await recurringCostPeriodStatus(sql, TODAY, { recurringCostId: costId })
    expect(periods).toHaveLength(24)
    // No duplicates AND no gaps, asserted as the sequence: 24 rows could be 24 Januaries.
    expect(periods.map((period) => period.periodKey).sort()).toEqual(
      Array.from({ length: 24 }, (_, index) => {
        const month = (index % 12) + 1
        return `${2026 + Math.floor(index / 12)}-${String(month).padStart(2, '0')}`
      }),
    )
  })

  it('writes nothing on a second pass over the same window', async () => {
    // Idempotence is the primary key plus `on conflict do nothing`, not a memory in the generator. This
    // is the property that makes a daily cron safe to run twice.
    const again = await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-01-01', months: 24, recurringCostId: costId }),
    )
    expect(again).toEqual([])
    expect(await recurringCostPeriodStatus(sql, TODAY, { recurringCostId: costId })).toHaveLength(
      24,
    )
  })

  it('refuses a second row for a period, by constraint name, however it arrives', async () => {
    const refusal = await rejection(() =>
      withUnitOfWork(
        sql,
        ACTOR,
        (uow) =>
          uow.sql`
          insert into recurring_cost_instance (
            recurring_cost_id, period_key, due_date, cost_kind, expected_amount_fils,
            variance_tolerance_bp
          ) values (${costId}::uuid, '2026-01', '2026-01-01', 'fixed', 2100000, 0)
        `,
      ),
    )
    expect(refusal?.constraint).toBe('recurring_cost_instance_one_per_period')
  })

  it('snapshots the expectation, so changing the definition cannot rewrite what a period was told', async () => {
    const before = await recurringCostPeriodStatus(sql, TODAY, { recurringCostId: costId })
    await sql`
      update recurring_cost set expected_amount_fils = 9900000 where recurring_cost_id = ${costId}::uuid
    `
    const after = await recurringCostPeriodStatus(sql, TODAY, { recurringCostId: costId })
    // Every generated period still expects the original amount. Without the snapshot, a rent renegotiated
    // in June would silently change what March's variance report said.
    expect(after.map((period) => period.periodKey)).toEqual(
      before.map((period) => period.periodKey),
    )
    const [count] = (await sql`
      select count(*)::int as n from recurring_cost_instance
      where recurring_cost_id = ${costId}::uuid and expected_amount_fils = 2100000
    `) as unknown as { n: number }[]
    expect(count?.n).toBe(24)
    await sql`
      update recurring_cost set expected_amount_fils = 2100000 where recurring_cost_id = ${costId}::uuid
    `
  })
})

describe('acceptance — a variable cost needs a range, a fixed cost needs an amount', () => {
  it('refuses a variable cost with no expected range, by constraint name', async () => {
    const refusal = await rejection(() =>
      record({
        ...rentInput('bad-variable'),
        costKind: 'variable',
        expectedAmountFils: null,
      }),
    )
    expect(refusal?.constraint).toBe('recurring_cost_variable_needs_an_expected_range')
  })

  it('refuses a fixed cost with no expected amount, by constraint name', async () => {
    const refusal = await rejection(() =>
      record({ ...rentInput('bad-fixed'), expectedAmountFils: null }),
    )
    expect(refusal?.constraint).toBe('recurring_cost_fixed_needs_an_expected_amount')
  })

  it('refuses a definition that states both shapes', async () => {
    const refusal = await rejection(() =>
      record({ ...rentInput('bad-both'), expectedMinFils: 1_000, expectedMaxFils: 2_000 }),
    )
    expect(refusal?.constraint).toBe('recurring_cost_fixed_needs_an_expected_amount')
  })

  it('accepts both legitimate shapes, which is what makes the two refusals above mean anything', async () => {
    await expect(
      record({
        ...rentInput('good-variable'),
        description: 'Utilities',
        expenseAccountCode: '6020',
        costKind: 'variable',
        expectedAmountFils: null,
        expectedMinFils: 210_000,
        expectedMaxFils: 525_000,
        varianceToleranceBp: 500,
      }),
    ).resolves.toMatch(/^[0-9a-f-]{36}$/)
    await expect(record(rentInput('good-fixed'))).resolves.toMatch(/^[0-9a-f-]{36}$/)
  })

  it('refuses an inverted band and an anchor whose day is missing from some months', async () => {
    const inverted = await rejection(() =>
      record({
        ...rentInput('inverted'),
        costKind: 'variable',
        expectedAmountFils: null,
        expectedMinFils: 525_000,
        expectedMaxFils: 210_000,
        varianceToleranceBp: 500,
      }),
    )
    expect(inverted?.constraint).toBe('recurring_cost_range_is_ordered')

    const anchor = await rejection(() =>
      record({ ...rentInput('anchor-31'), firstDueDate: '2026-01-31' }),
    )
    expect(anchor?.constraint).toBe('recurring_cost_anchor_day_is_in_every_month')
  })
})

describe('acceptance — a bill outside tolerance raises a variance alert carrying the delta', () => {
  /** A rent with a 1% tolerance: 21,000 fils of grace on 2,100,000. */
  let toleratedId = ''
  let strictId = ''

  beforeAll(async () => {
    toleratedId = await record(rentInput('variance-tolerated', { varianceToleranceBp: 100 }))
    strictId = await record(rentInput('variance-strict'))
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await generateRecurringInstances(uow, {
        from: '2026-09-01',
        months: 1,
        recurringCostId: toleratedId,
      })
      await generateRecurringInstances(uow, {
        from: '2026-09-01',
        months: 1,
        recurringCostId: strictId,
      })
    })
  })

  /** Posts a bill through `postRecurringBill` and returns the alerts the match raised. */
  async function post(costCode: string, suffix: string, grossFils: number, netFils: number) {
    try {
      return await withUnitOfWork(sql, ACTOR, (uow) =>
        postRecurringBill(uow, {
          recurringCostCode: costCode,
          periodKey: '2026-09',
          supplierReference: reference(suffix),
          billDate: TODAY,
          dueDate: TODAY,
          entryDate: TODAY,
          receivedBy: 'm-vat-04-itest',
          grossFils,
          netFils,
          asOf: TODAY,
        }),
      )
    } catch (err) {
      // The translation belongs around the transaction: the deferred triggers raise at COMMIT and no
      // function inside `postRecurringBill` executes it.
      throw recurringCostError(err) ?? purchaseError(err) ?? err
    }
  }

  it('raises none for a bill exactly on the tolerance boundary', async () => {
    // 2,121,000 is the contracted 2,100,000 plus exactly 1%. Strictly greater is over tolerance, so this
    // is within — an off-by-one here alerts on every cost whose tolerance was set to what it varies by.
    const posted = await post(code('variance-tolerated'), 'ON-BOUNDARY', 2_121_000, 2_020_000)
    expect(posted.match.alerts).toEqual([])
  })

  it('raises one carrying the signed delta for a bill one fils past the boundary', async () => {
    const posted = await post(code('variance-strict'), 'OVER', 2_100_001, 2_000_001)
    expect(posted.match.alerts).toHaveLength(1)
    const [alert] = posted.match.alerts
    expect(alert?.alertKind).toBe('variance_over_tolerance')
    expect(alert?.deltaFils).toBe(1)
    expect(alert?.toleranceFils).toBe(0)
  })

  it('raises one with a negative delta when the bill is under the expectation', async () => {
    const under = await record(rentInput('variance-under'))
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-09-01', months: 1, recurringCostId: under }),
    )
    const posted = await post(code('variance-under'), 'UNDER', 2_079_000, 1_980_000)
    expect(posted.match.alerts).toHaveLength(1)
    // Signed. A rent 210 AED short is a credit to chase, not an overcharge, and a non-negative delta
    // would file the two together.
    expect(posted.match.alerts[0]?.deltaFils).toBe(-21_000)
  })

  it('raises nothing anywhere inside a variable cost band, at either edge', async () => {
    const utilities = await record({
      ...rentInput('variance-band'),
      description: 'Utilities',
      expenseAccountCode: '6020',
      costKind: 'variable',
      expectedAmountFils: null,
      expectedMinFils: 210_000,
      expectedMaxFils: 525_000,
      varianceToleranceBp: 500,
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, {
        from: '2026-09-01',
        months: 1,
        recurringCostId: utilities,
      }),
    )
    // The top of the band exactly. This is the line that stops a seasonal cost alerting every summer.
    const posted = await post(code('variance-band'), 'BAND-TOP', 525_000, 500_000)
    expect(posted.match.alerts).toEqual([])

    const overBand = await record({
      ...rentInput('variance-over-band'),
      description: 'Utilities',
      expenseAccountCode: '6020',
      costKind: 'variable',
      expectedAmountFils: null,
      expectedMinFils: 210_000,
      expectedMaxFils: 525_000,
      varianceToleranceBp: 500,
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-09-01', months: 1, recurringCostId: overBand }),
    )
    // 5% of the band top is 26,250 fils of grace beyond it; one fils more is a variance of 26,251.
    const breached = await post(code('variance-over-band'), 'BAND-OVER', 551_251, 525_001)
    expect(breached.match.alerts).toHaveLength(1)
    expect(breached.match.alerts[0]?.deltaFils).toBe(26_251)
    expect(breached.match.alerts[0]?.toleranceFils).toBe(26_250)
  })

  it('posts the bill through postBill, so the ledger still balances', async () => {
    // The register does not own a second posting path. Two ways to post a purchase would be two answers
    // to "what did we spend".
    const balance = await trialBalanceAsAt(sql, '2027-12-31')
    expect(isBalanced(balance), `difference ${balance.differenceFils} fils`).toBe(true)
  })

  it('records the alert as a row, not only as a return value', async () => {
    const [row] = (await sql`
      select alert_kind, delta_fils::text as delta_fils, tolerance_fils::text as tolerance_fils,
             detail->>'actualGrossFils' as actual, detail->>'code' as code
        from recurring_cost_alert where recurring_cost_id = ${strictId}::uuid
    `) as unknown as {
      alert_kind: string
      delta_fils: string
      tolerance_fils: string
      actual: string
      code: string
    }[]
    expect(row?.alert_kind).toBe('variance_over_tolerance')
    expect(row?.delta_fils).toBe('1')
    // Every figure in the payload is text: a jsonb number becomes a double the moment JSON.parse reads
    // it, and this payload is what a person is shown about a money difference.
    expect(row?.actual).toBe('2100001')
    expect(row?.code).toBe(code('variance-strict'))
  })

  it('refuses a zero-delta variance alert, by constraint name', async () => {
    // A variance of zero is not a variance. A row like that would sit in the ledger as an alert nobody
    // can act on, which is how an alert list stops being read.
    const refusal = await rejection(() =>
      withUnitOfWork(
        sql,
        ACTOR,
        (uow) =>
          uow.sql`
          insert into recurring_cost_alert (
            recurring_cost_id, period_key, alert_kind, delta_fils, tolerance_fils, raised_for_date
          ) values (${strictId}::uuid, '2026-09', 'variance_over_tolerance', 0, 0, ${TODAY}::date)
        `,
      ),
    )
    expect(refusal?.constraint).toBe('recurring_cost_alert_variance_delta_is_not_zero')
  })

  it('refuses a missing-cost alert that carries a delta, by constraint name', async () => {
    const refusal = await rejection(() =>
      withUnitOfWork(
        sql,
        ACTOR,
        (uow) =>
          uow.sql`
          insert into recurring_cost_alert (
            recurring_cost_id, period_key, alert_kind, delta_fils, tolerance_fils, raised_for_date
          ) values (${strictId}::uuid, '2026-09', 'missing_cost', 500, 0, ${TODAY}::date)
        `,
      ),
    )
    expect(refusal?.constraint).toBe('recurring_cost_alert_variance_carries_a_delta')
  })
})

describe('acceptance — matching is idempotent on (recurring_cost_id, period)', () => {
  let costId = ''
  let firstBillId = ''
  let secondBillId = ''
  /** Entered by hand, with no cost named: the path a bill somebody matches afterwards takes. */
  let unmatchedBillId = ''

  beforeAll(async () => {
    costId = await record(rentInput('match'))
    // Four periods, so there is a free one (November) to probe the bill-level constraint against.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-09-01', months: 4, recurringCostId: costId }),
    )
    // A second cost billed by a DIFFERENT supplier, for the cross-supplier probe below.
    const otherCostId = await record({
      ...rentInput('match-other'),
      description: 'Linen laundry',
      supplierId: otherSupplierId,
      expenseAccountCode: '6050',
      expectedAmountFils: 63_000,
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, {
        from: '2026-09-01',
        months: 2,
        recurringCostId: otherCostId,
      }),
    )
    const first = await withUnitOfWork(sql, ACTOR, (uow) =>
      postRecurringBill(uow, {
        recurringCostCode: code('match'),
        periodKey: '2026-09',
        supplierReference: reference('MATCH-1'),
        billDate: TODAY,
        dueDate: TODAY,
        entryDate: TODAY,
        receivedBy: 'm-vat-04-itest',
        grossFils: 2_100_000,
        netFils: 2_000_000,
        asOf: TODAY,
      }),
    )
    firstBillId = first.bill.billId
    // A second, legitimate bill from the same supplier: October's rent, entered but not yet matched.
    const second = await withUnitOfWork(sql, ACTOR, (uow) =>
      postRecurringBill(uow, {
        recurringCostCode: code('match'),
        periodKey: '2026-10',
        supplierReference: reference('MATCH-2'),
        billDate: TODAY,
        dueDate: TODAY,
        entryDate: TODAY,
        receivedBy: 'm-vat-04-itest',
        grossFils: 2_100_000,
        netFils: 2_000_000,
        asOf: TODAY,
      }),
    )
    secondBillId = second.bill.billId
    // A bill entered WITHOUT naming a recurring cost, which is the other legitimate arrival: the
    // bookkeeper keys the invoice and somebody attaches it to a period afterwards.
    const loose = await withUnitOfWork(sql, ACTOR, (uow) =>
      postBill(uow, {
        supplierId: landlordId,
        supplierReference: reference('MATCH-3'),
        billDate: TODAY,
        dueDate: TODAY,
        entryDate: TODAY,
        receivedBy: 'm-vat-04-itest',
        lines: [
          {
            description: 'Premises rent',
            expenseAccountCode: '6010',
            taxTreatment: 'standard_recoverable',
            grossFils: 2_100_000,
            netFils: 2_000_000,
          },
        ],
      }),
    )
    unmatchedBillId = loose.billId
  })

  it('refuses a second match on the same period, by constraint name', async () => {
    // Written straight at the table, so the raw driver error is what the predicate below is tested on.
    const error = await withUnitOfWork(
      sql,
      ACTOR,
      (uow) =>
        uow.sql`
        insert into recurring_cost_match (recurring_cost_id, period_key, bill_id, matched_by)
        values (${costId}::uuid, '2026-09', ${secondBillId}::uuid, 'itest')
      `,
    ).catch((err: unknown) => err)
    expect((error as { constraint_name?: string }).constraint_name).toBe(
      'recurring_cost_match_one_per_period',
    )
    expect(isDuplicateRecurringCostMatch(error)).toBe(true)
    expect(isDuplicateRecurringCostMatch(new Error('something else'))).toBe(false)
  })

  it('translates that refusal into a sentence rather than a SQLSTATE', async () => {
    const refusal = await rejection(() =>
      withUnitOfWork(sql, ACTOR, (uow) =>
        matchBillToRecurringCost(uow, {
          recurringCostId: costId,
          periodKey: '2026-09',
          billId: secondBillId,
          matchedBy: 'm-vat-04-itest',
          asOf: TODAY,
        }),
      ),
    )
    // Translated, so the constraint survives in `details` and the message is a sentence a person reads.
    expect(refusal?.constraint).toBe('recurring_cost_match_one_per_period')
    expect(refusal?.message).toMatch(/already been matched/)
  })

  it('refuses one bill satisfying two periods, by constraint name', async () => {
    const refusal = await rejection(() =>
      withUnitOfWork(sql, ACTOR, (uow) =>
        matchBillToRecurringCost(uow, {
          recurringCostId: costId,
          periodKey: '2026-11',
          billId: firstBillId,
          matchedBy: 'm-vat-04-itest',
          asOf: TODAY,
        }),
      ),
    )
    // Either constraint is a correct refusal here; the bill-level one is what stops one invoice silencing
    // two missing-cost alerts, and it is the one that fires first.
    expect(refusal?.constraint).toBe('recurring_cost_match_one_per_bill')
  })

  it('refuses a bill from another supplier, by SQLSTATE', async () => {
    const other = await withUnitOfWork(sql, ACTOR, (uow) =>
      postRecurringBill(uow, {
        recurringCostCode: code('match-other'),
        periodKey: '2026-09',
        supplierReference: reference('OTHER-1'),
        billDate: TODAY,
        dueDate: TODAY,
        entryDate: TODAY,
        receivedBy: 'm-vat-04-itest',
        grossFils: 63_000,
        netFils: 60_000,
        asOf: TODAY,
      }),
    )
    const refusal = await rejection(() =>
      withUnitOfWork(
        sql,
        ACTOR,
        (uow) =>
          uow.sql`
          insert into recurring_cost_match (recurring_cost_id, period_key, bill_id, matched_by)
          values (${costId}::uuid, '2026-10', ${other.bill.billId}::uuid, 'itest')
        `,
      ),
    )
    expect(refusal?.code).toBe(RECURRING_COST_SQLSTATE.matchedBillFromAnotherSupplier)
    expect(refusal?.message).toMatch(/MatchedBillFromAnotherSupplier/)
  })

  it('accepts the legitimate match, which is what makes the four refusals above mean anything', async () => {
    const match = await withUnitOfWork(sql, ACTOR, (uow) =>
      matchBillToRecurringCost(uow, {
        recurringCostId: costId,
        periodKey: '2026-11',
        billId: unmatchedBillId,
        matchedBy: 'm-vat-04-itest',
        asOf: TODAY,
      }),
    )
    expect(match.matchId).toMatch(/^[0-9a-f-]{36}$/)
    // November is not yet due at the frozen clock, so a bill arriving early raises nothing at all.
    expect(match.alerts).toEqual([])
  })
})

describe('acceptance — a missing cost alerts exactly once, not once per sweep', () => {
  let costId = ''

  beforeAll(async () => {
    // Anchored in August, so two periods (August and September) are already past due at the frozen clock.
    costId = await record(rentInput('missing', { firstDueDate: '2026-08-01' }))
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-08-01', months: 2, recurringCostId: costId }),
    )
  })

  it('raises one alert per overdue unbilled period on the first sweep', async () => {
    const raised = await withUnitOfWork(sql, ACTOR, (uow) =>
      sweepRecurringCostAlerts(uow, { asOf: TODAY, recurringCostId: costId }),
    )
    expect(raised.map((alert) => alert.periodKey).sort()).toEqual(['2026-08', '2026-09'])
    for (const alert of raised) {
      expect(alert.alertKind).toBe('missing_cost')
      // Nothing arrived, so there is nothing to differ from: an absence is not a difference.
      expect(alert.deltaFils).toBeNull()
    }
  })

  it('raises nothing on the second, third and fourth sweep of the same day', async () => {
    for (const pass of [2, 3, 4]) {
      const again = await withUnitOfWork(sql, ACTOR, (uow) =>
        sweepRecurringCostAlerts(uow, { asOf: TODAY, recurringCostId: costId }),
      )
      expect(again, `sweep ${pass}`).toEqual([])
    }
  })

  it('raises nothing extra on a later business day either', async () => {
    // The dedup key is the period, not the run date. A key that included the as-of date would produce a
    // fresh alert every day for one unbilled August, and the 365th is the one nobody reads.
    const later = await withUnitOfWork(sql, ACTOR, (uow) =>
      sweepRecurringCostAlerts(uow, { asOf: '2026-09-25', recurringCostId: costId }),
    )
    expect(later).toEqual([])
    const [count] = (await sql`
      select count(*)::int as n from recurring_cost_alert
      where recurring_cost_id = ${costId}::uuid and alert_kind = 'missing_cost'
    `) as unknown as { n: number }[]
    expect(count?.n).toBe(2)
  })

  it('refuses a second alert of the same kind for the same period, by constraint name', async () => {
    const refusal = await rejection(() =>
      withUnitOfWork(
        sql,
        ACTOR,
        (uow) =>
          uow.sql`
          insert into recurring_cost_alert (
            recurring_cost_id, period_key, alert_kind, raised_for_date
          ) values (${costId}::uuid, '2026-08', 'missing_cost', ${TODAY}::date)
        `,
      ),
    )
    expect(refusal?.constraint).toBe('recurring_cost_alert_once_per_period_and_kind')
  })

  it('stops alerting for a period once a bill is matched to it', async () => {
    // The control: the sweep above must be capable of finding nothing for a reason other than dedup.
    const billed = await record(rentInput('missing-then-billed', { firstDueDate: '2026-09-01' }))
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-09-01', months: 1, recurringCostId: billed }),
    )
    await withUnitOfWork(sql, ACTOR, (uow) =>
      postRecurringBill(uow, {
        recurringCostCode: code('missing-then-billed'),
        periodKey: '2026-09',
        supplierReference: reference('BILLED'),
        billDate: TODAY,
        dueDate: TODAY,
        entryDate: TODAY,
        receivedBy: 'm-vat-04-itest',
        grossFils: 2_100_000,
        netFils: 2_000_000,
        asOf: TODAY,
      }),
    )
    // Its period is due 2026-09-01, which is overdue at the frozen clock — and matched, so no alert.
    const raised = await withUnitOfWork(sql, ACTOR, (uow) =>
      sweepRecurringCostAlerts(uow, { asOf: TODAY, recurringCostId: billed }),
    )
    expect(raised).toEqual([])
  })

  it('treats a period due today as not yet late', async () => {
    const today = await record(rentInput('due-today', { firstDueDate: '2026-09-18' }))
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-09-18', months: 1, recurringCostId: today }),
    )
    const raised = await withUnitOfWork(sql, ACTOR, (uow) =>
      sweepRecurringCostAlerts(uow, { asOf: TODAY, recurringCostId: today }),
    )
    expect(raised).toEqual([])
    // And the day after, it is.
    const tomorrow = await withUnitOfWork(sql, ACTOR, (uow) =>
      sweepRecurringCostAlerts(uow, { asOf: '2026-09-19', recurringCostId: today }),
    )
    expect(tomorrow.map((alert) => alert.periodKey)).toEqual(['2026-09'])
  })
})

describe('the history is append-only, for the owner too', () => {
  let costId = ''

  beforeAll(async () => {
    costId = await record(rentInput('append-only'))
    await withUnitOfWork(sql, ACTOR, (uow) =>
      generateRecurringInstances(uow, { from: '2026-09-01', months: 1, recurringCostId: costId }),
    )
    await withUnitOfWork(sql, ACTOR, (uow) =>
      sweepRecurringCostAlerts(uow, { asOf: '2026-10-01', recurringCostId: costId }),
    )
  })

  it('refuses an UPDATE of a period, by SQLSTATE', async () => {
    const refusal = await rejection(
      () =>
        sql`update recurring_cost_instance set due_date = '2026-09-02'
             where recurring_cost_id = ${costId}::uuid`,
    )
    expect(refusal?.code).toBe(RECURRING_COST_SQLSTATE.appendOnly)
  })

  it('refuses a DELETE of a period and of an alert, by SQLSTATE', async () => {
    const instance = await rejection(
      () => sql`delete from recurring_cost_instance where recurring_cost_id = ${costId}::uuid`,
    )
    expect(instance?.code).toBe(RECURRING_COST_SQLSTATE.appendOnly)
    const alert = await rejection(
      () => sql`delete from recurring_cost_alert where recurring_cost_id = ${costId}::uuid`,
    )
    expect(alert?.code).toBe(RECURRING_COST_SQLSTATE.appendOnly)
  })

  it('holds no UPDATE or DELETE grant on the three history tables for the application role', async () => {
    // Asserted from information_schema rather than by attempting the write as that role: the triggers
    // above already refuse it, and a table that relies only on a trigger is one grant away from being
    // rewritable by a statement no trigger sees.
    const rows = (await sql`
      select table_name, privilege_type
        from information_schema.table_privileges
       where grantee = 'berelax_app'
         and table_name in ('recurring_cost_instance', 'recurring_cost_match', 'recurring_cost_alert')
         and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')
    `) as unknown as { table_name: string; privilege_type: string }[]
    expect(rows).toEqual([])
  })

  it('does hold UPDATE on the definition, because a contract is corrected rather than reversed', async () => {
    // The control for the assertion above: it must be capable of finding a grant.
    const rows = (await sql`
      select privilege_type from information_schema.table_privileges
       where grantee = 'berelax_app' and table_name = 'recurring_cost'
         and privilege_type = 'UPDATE'
    `) as unknown as { privilege_type: string }[]
    expect(rows).toHaveLength(1)
  })
})

describe('acceptance — the 12-period forward schedule is queryable without the cost tables', () => {
  const codes = [
    'forecast-rent',
    'forecast-utilities',
    'forecast-insurance',
    'forecast-licence',
  ].map(code)

  beforeAll(async () => {
    await record(rentInput('forecast-rent'))
    await record({
      ...rentInput('forecast-utilities'),
      description: 'Utilities',
      expenseAccountCode: '6020',
      firstDueDate: '2026-02-20',
      costKind: 'variable',
      expectedAmountFils: null,
      expectedMinFils: 210_000,
      expectedMaxFils: 525_000,
      varianceToleranceBp: 500,
    })
    await record({
      ...rentInput('forecast-insurance'),
      description: 'Insurance',
      expenseAccountCode: '6110',
      cadence: 'quarterly',
      firstDueDate: '2026-04-15',
      expectedAmountFils: 315_000,
      varianceToleranceBp: 250,
    })
    await record({
      ...rentInput('forecast-licence'),
      description: 'Trade licence renewal',
      expenseAccountCode: '6120',
      taxTreatment: 'out_of_scope',
      cadence: 'annual',
      firstDueDate: '2026-11-05',
      expectedAmountFils: 1_200_000,
    })
  })

  it('totals the committed worked example to the fils', async () => {
    const forecast = await recurringCostForecast(sql, TODAY, 12, { codes })
    // The same figures as packages/fixtures/src/recurring-costs.ts, which the pure schedule is asserted
    // against separately. 12 x 2,100,000 + 12 x 525,000 + 4 x 315,000 + 1 x 1,200,000.
    expect(forecast.totalFils).toBe(33_960_000n)
    expect(forecast.lowTotalFils).toBe(30_180_000n)
    expect(forecast.rows).toHaveLength(29)
  })

  it('sums the detail to the same figure the database summed', async () => {
    // "The totals match the detail" is the property a forecast lives or dies by, and the two are computed
    // by different queries precisely so a caller that wants only the monthly figures need not pull every
    // occurrence across the wire.
    const forecast = await recurringCostForecast(sql, TODAY, 12, { codes })
    expect(forecast.rows.reduce((total, row) => total + row.expectedFils, 0n)).toBe(
      forecast.totalFils,
    )
    expect(forecast.periods.reduce((total, period) => total + period.expectedFils, 0n)).toBe(
      forecast.totalFils,
    )
  })

  it('lands each cadence in the months it is actually due', async () => {
    const forecast = await recurringCostForecast(sql, TODAY, 12, { codes })
    expect(forecast.periods.map((period) => period.periodKey)).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
      '2027-07',
      '2027-08',
      '2027-09',
    ])
    const byKey = new Map(forecast.periods.map((period) => [period.periodKey, period.expectedFils]))
    // September holds only the utility recharge (due on the 20th) because the window opens on the 18th.
    expect(byKey.get('2026-09')).toBe(525_000n)
    // November holds rent, utilities and the licence renewal.
    expect(byKey.get('2026-11')).toBe(3_825_000n)
    // September 2027 holds only the rent: the utility recharge on the 20th is past the window's close.
    expect(byKey.get('2027-09')).toBe(2_100_000n)
  })

  it('does not depend on the generator having run', async () => {
    // The forecast is computed from the definitions. A forecast that read recurring_cost_instance would
    // end wherever the nightly pass last got to, and a horizon that quietly shortens looks exactly like a
    // business with no costs in month eleven.
    const [count] = (await sql`
      select count(*)::int as n from recurring_cost_instance i
      join recurring_cost c on c.recurring_cost_id = i.recurring_cost_id
      where c.code = any(${codes}::text[])
    `) as unknown as { n: number }[]
    expect(count?.n).toBe(0)
    expect((await recurringCostForecast(sql, TODAY, 12, { codes })).rows).toHaveLength(29)
  })

  it('is reproducible: the same as-of date gives the same answer twice', async () => {
    const first = await recurringCostForecast(sql, TODAY, 12, { codes })
    const second = await recurringCostForecast(sql, TODAY, 12, { codes })
    expect(second).toEqual(first)
  })

  it('refuses a horizon of less than one month and a malformed as-of date', async () => {
    await expect(recurringCostForecast(sql, TODAY, 0)).rejects.toThrow(/at least one whole month/)
    await expect(recurringCostForecast(sql, '18/09/2026')).rejects.toThrow(/ISO business day/)
  })
})

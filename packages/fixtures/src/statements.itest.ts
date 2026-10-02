import {
  ACCOUNTS,
  buildFinancialStatements,
  directedTotalFils,
  drillableLines,
  type FinancialStatements,
  localDate,
  STANDARD_SPA_CHART,
  type StatementLayout,
  statementLayoutFor,
} from '@berelax/core'
import {
  closeAccountingPeriod,
  createConnection,
  type JournalEntryInput,
  journalRowsWrittenAfter,
  postDatedCorrection,
  postJournalEntry,
  type Sql,
  statementBytes,
  statementContentHash,
  statementDrillDown,
  statementLedgerCensus,
  statementLedgerFigures,
  statementPeriodSource,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * R-REP-02 — the three statements over a real closed month, and the four things that tie them to the
 * ledger.
 *
 * It lives in `@berelax/fixtures` because the arithmetic is `@berelax/core`'s and the rows are
 * `@berelax/db`'s, and fixtures is the one package allowed to depend on both: `db` must never import `core`
 * (ADR 0001). `packages/db/src/statements.itest.ts` is the other half of this unit and covers the QUERIES on
 * their own — window semantics, the census, and the database's refusal to let a journal row be edited.
 *
 * # What is proved here and nowhere else
 *
 *   1. **The balance sheet balances at both ends of the period**, over a ledger built by the real posting
 *      path. That is the trial-balance identity, and the identity is worth asserting only because the
 *      partition is checked separately — `statements.test.ts` shows the same sheet balancing with a
 *      liability filed under assets, which is why "it balances" is never the whole claim.
 *   2. **The articulation**: net profit equals the movement in retained earnings, to the fil, with the
 *      figure that would make the simple reading false reported alongside at zero.
 *   3. **Closing cash equals the cash and bank accounts' own position.** Two derivations: the statement's
 *      figure comes from the movement in every NON-cash account, the comparison from the cash accounts.
 *   4. **Every line of all three statements drills to `journal_line` rows that sum to it exactly** — and
 *      every row in the window is claimed by exactly one balance-sheet line, counted against a census taken
 *      with no reference to the layout. That pair is the whole of "tied to the ledger": the first says each
 *      figure is the rows behind it, the second says no row is missing from the statements.
 *   5. **A dated reversal does not restate a filed period.** The correction of a sale in the closed month
 *      lands in the next open one, and the closed month's statements are BYTE-IDENTICAL before and after.
 *
 * # Why the ledger is posted directly and the month is searched for
 *
 * A statement reads `journal_line` and nothing else, so the sixteen entries below are posted through
 * `postJournalEntry`, the one write path, with every figure counted by hand. `journal_entry` refuses DELETE
 * for every role including the owner (ZL001), so a FIXED month would double every figure on a second run
 * against the same database — M-TILL-10's recorded defect. The window is derived from `max(entry_date)`
 * inside a reserved span and every figure below is a MOVEMENT, absolute for whichever window it got.
 *
 * Positions are never asserted as totals, for brief rule 12's reason: the integration suite runs
 * sequentially against one database and earlier files leave rows behind, so the opening position holds
 * whatever they posted. What is absolute is the movement across a virgin month, and the identities, which
 * hold whatever the opening position is.
 */

/**
 * The span this suite may post into. `packages/db/src/statements.itest.ts` holds 2250-2299 and says so;
 * the two files are in one integration run and a shared span would have them racing for the same months.
 *
 * Measured: the years in any date literal under `packages`, `apps` or `scripts` before this unit were
 * 2000-2036, 2079-2100, 2120-2149, 2150-2199 (vat201) and 2200-2249 (month reconciliation). 2300 onwards
 * was claimed by nothing.
 */
const STATEMENTS_RESERVED_SPAN = { from: '2300-01-01', to: '2349-12-31' } as const

const PREFIX = 'RREP02S'
const RUN = Date.now().toString(36)
const ACTOR = { kind: 'system', label: 'r-rep-02 statements itest' } as const
const NOW_ISO = '2349-12-31T06:00:00.000Z'

// --- the month, counted by hand -------------------------------------------------------------------
//
// Sixteen entries and thirty-seven lines, dated on ONE day inside the closed month, chosen so that every
// section of every statement moves and no two subtotals are equal by accident. A month where only cash and
// revenue move satisfies the three identities without exercising a single working-capital line.
//
//    1. capital introduced     Dr 1020    400_000   Cr 3010    400_000
//    2. cash sale              Dr 1010     21_000   Cr 4010     20_000   Cr 2030      1_000
//    3. card sale              Dr 1040     42_000   Cr 4010     40_000   Cr 2030      2_000
//    4. package sold           Dr 1010     63_000   Cr 2050     60_000   Cr 2030      3_000
//    5. package redeemed       Dr 2050     20_000   Cr 4020     20_000
//    6. retail on account      Dr 1050     10_500   Cr 4030     10_000   Cr 2030        500
//    7. discount allowed       Dr 4095      1_000   Cr 1050      1_000
//    8. rent billed            Dr 6010     50_000   Dr 1080      2_500   Cr 2010     52_500
//    9. rent paid              Dr 2010     52_500   Cr 1020     52_500
//   10. stock bought on credit Dr 1070     30_000   Cr 2010     30_000
//   11. wages accrued          Dr 5010     80_000   Cr 2060     80_000
//   12. tips collected         Dr 1010      5_000   Cr 2040      5_000
//   13. couch bought           Dr 1100    120_000   Cr 1020    120_000
//   14. depreciation           Dr 6130      4_000   Cr 1110      4_000
//   15. drawings               Dr 3020     25_000   Cr 1010     25_000
//   16. banking run            Dr 1020     50_000   Cr 1010     50_000
//
// Entry 16 is there on purpose: a transfer between two CASH accounts. It must move no cash-flow line at
// all, which is the case a direct-method cash flow has to allocate and an indirect one cannot get wrong —
// neither account is in the non-cash partition, so neither appears.
const MONTH_ENTRIES = 16
const MONTH_LINES = 37
const MONTH_DEBITS = 976_500n

/** The profit and loss, to the fil. Revenue 89,000 less costs 134,000. */
const TREATMENT_REVENUE_FILS = 60_000n
const PACKAGE_REVENUE_FILS = 20_000n
const RETAIL_REVENUE_FILS = 10_000n
const DISCOUNTS_FILS = -1_000n
const TOTAL_REVENUE_FILS = 89_000n
const STAFF_COSTS_FILS = 80_000n
const PREMISES_COSTS_FILS = 50_000n
const DEPRECIATION_FILS = 4_000n
const TOTAL_EXPENSES_FILS = 134_000n
const NET_PROFIT_FILS = -45_000n

/** The cash flow, to the fil. */
const OPERATING_FILS = 36_500n
const INVESTING_FILS = -120_000n
const FINANCING_FILS = 375_000n
const NET_CASH_MOVEMENT_FILS = 291_500n

/** The balance sheet's movement across the month, by section. */
const ASSETS_MOVEMENT_FILS = 491_500n
const LIABILITIES_MOVEMENT_FILS = 161_500n
const EQUITY_MOVEMENT_FILS = 330_000n

/** The reversal of the card sale, posted after the month was filed. */
const CARD_SALE_GROSS = 42_000
const CARD_SALE_NET = 40_000
const CARD_SALE_VAT = 2_000
/** The same figure as a bigint: what the reversal takes back out of treatment revenue. */
const CARD_SALE_NET_FILS = 40_000n

interface Month {
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  readonly on: string
}

let sql: Sql
let closedMonth: Month
let openMonth: Month
let cardSaleEntryId: string
let layout: StatementLayout
let statements: FinancialStatements
let bytesBeforeTheCorrection: string
let statementsAgain: FinancialStatements
let statementsOtherNow: FinancialStatements
let statementsAfterTheCorrection: FinancialStatements
let openMonthStatements: FinancialStatements

const monthAt = (year: number, month: number): Month => {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    periodId: `${PREFIX}-${year}-${mm}`,
    startsOn: `${year}-${mm}-01`,
    endsOn: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    on: `${year}-${mm}-17`,
  }
}

const nextMonthAfter = (isoDate: string) => {
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

/** Two consecutive months in the reserved span no journal entry has ever been dated in. */
async function virginWindow(): Promise<readonly [Month, Month]> {
  const [row] = await sql<{ used: string | null }[]>`
    select max(entry_date)::text as used
      from journal_entry
     where entry_date between ${STATEMENTS_RESERVED_SPAN.from}::date
                          and ${STATEMENTS_RESERVED_SPAN.to}::date
  `
  const used = row?.used ?? null
  const first =
    used === null
      ? {
          year: Number(STATEMENTS_RESERVED_SPAN.from.slice(0, 4)),
          month: Number(STATEMENTS_RESERVED_SPAN.from.slice(5, 7)),
        }
      : nextMonthAfter(used)
  const months = [0, 1].map((offset) => {
    const zeroBased = first.month - 1 + offset
    return monthAt(first.year + Math.floor(zeroBased / 12), (zeroBased % 12) + 1)
  })
  const last = months[1] as Month
  if (last.endsOn > STATEMENTS_RESERVED_SPAN.to) {
    throw new Error(
      'The R-REP-02 statements fixture needs two consecutive months with no journal entry in them, and ' +
        `the reserved span ${STATEMENTS_RESERVED_SPAN.from}..${STATEMENTS_RESERVED_SPAN.to} is used up ` +
        `to ${used}. The journal is append-only and refuses the owner, so the entries cannot be removed: ` +
        'run this suite against a fresh database, or widen STATEMENTS_RESERVED_SPAN into a half-century ' +
        'no other suite posts into. Wrapping round would land on a month that already holds a previous ' +
        'run and every figure would read double.',
    )
  }
  return [months[0] as Month, months[1] as Month]
}

function monthEntries(month: Month): readonly JournalEntryInput[] {
  const id = (what: string) => `je-rrep02s-${RUN}-${month.periodId}-${what}`
  const on = month.on
  const entry = (
    what: string,
    narrative: string,
    source: string,
    lines: readonly { accountCode: string; debitFils: number; creditFils: number }[],
  ): JournalEntryInput => ({ entryId: id(what), entryDate: on, narrative, source, lines })
  const dr = (account: string, amount: number) => ({
    accountCode: account,
    debitFils: amount,
    creditFils: 0,
  })
  const cr = (account: string, amount: number) => ({
    accountCode: account,
    debitFils: 0,
    creditFils: amount,
  })
  return [
    entry('capital', 'Owner capital introduced', 'adjustment', [
      dr(ACCOUNTS.bankCurrent, 400_000),
      cr(ACCOUNTS.ownersCapital, 400_000),
    ]),
    entry('cash-sale', 'Cash treatment sale', 'sale', [
      dr(ACCOUNTS.cashInDrawer, 21_000),
      cr(ACCOUNTS.treatmentRevenue, 20_000),
      cr(ACCOUNTS.outputVatPayable, 1_000),
    ]),
    entry('card-sale', 'Card treatment sale', 'sale', [
      dr(ACCOUNTS.cardTerminalClearing, CARD_SALE_GROSS),
      cr(ACCOUNTS.treatmentRevenue, CARD_SALE_NET),
      cr(ACCOUNTS.outputVatPayable, CARD_SALE_VAT),
    ]),
    entry('package-sold', 'Package of three sessions sold, cash', 'package_sale', [
      dr(ACCOUNTS.cashInDrawer, 63_000),
      cr(ACCOUNTS.packageDeferredRevenue, 60_000),
      cr(ACCOUNTS.outputVatPayable, 3_000),
    ]),
    entry('package-redeemed', 'One package session redeemed', 'package_redemption', [
      dr(ACCOUNTS.packageDeferredRevenue, 20_000),
      cr(ACCOUNTS.packageRedemptionRevenue, 20_000),
    ]),
    entry('retail', 'Retail products on a corporate account', 'sale', [
      dr(ACCOUNTS.tradeReceivables, 10_500),
      cr(ACCOUNTS.retailRevenue, 10_000),
      cr(ACCOUNTS.outputVatPayable, 500),
    ]),
    entry('discount', 'Goodwill discount on the corporate account', 'adjustment', [
      dr(ACCOUNTS.discountsAndAllowances, 1_000),
      cr(ACCOUNTS.tradeReceivables, 1_000),
    ]),
    entry('rent-billed', 'Monthly rent invoiced', 'supplier_bill', [
      dr(ACCOUNTS.rent, 50_000),
      dr(ACCOUNTS.recoverableInputVat, 2_500),
      cr(ACCOUNTS.tradePayables, 52_500),
    ]),
    entry('rent-paid', 'Monthly rent paid from the bank', 'payment', [
      dr(ACCOUNTS.tradePayables, 52_500),
      cr(ACCOUNTS.bankCurrent, 52_500),
    ]),
    entry('stock', 'Retail stock bought on credit', 'supplier_bill', [
      dr(ACCOUNTS.inventoryRetail, 30_000),
      cr(ACCOUNTS.tradePayables, 30_000),
    ]),
    entry('wages', 'Therapist wages accrued', 'payroll', [
      dr(ACCOUNTS.therapistWages, 80_000),
      cr(ACCOUNTS.wagesPayable, 80_000),
    ]),
    entry('tips', 'Tips collected on behalf of therapists', 'payment', [
      dr(ACCOUNTS.cashInDrawer, 5_000),
      cr(ACCOUNTS.tipsPayable, 5_000),
    ]),
    entry('couch', 'Treatment couch bought from the bank', 'supplier_bill', [
      dr(ACCOUNTS.equipment, 120_000),
      cr(ACCOUNTS.bankCurrent, 120_000),
    ]),
    entry('depreciation', 'Monthly depreciation charge', 'depreciation', [
      dr(ACCOUNTS.depreciation, 4_000),
      cr(ACCOUNTS.accumulatedDepreciation, 4_000),
    ]),
    entry('drawings', 'Owner drawings, cash', 'payout', [
      dr(ACCOUNTS.ownersDrawings, 25_000),
      cr(ACCOUNTS.cashInDrawer, 25_000),
    ]),
    entry('banking', 'Takings banked', 'cash_up', [
      dr(ACCOUNTS.bankCurrent, 50_000),
      cr(ACCOUNTS.cashInDrawer, 50_000),
    ]),
  ]
}

/**
 * The composition: the db reads, then core's arithmetic. The ONLY place the two halves meet.
 *
 * Written once and called five times — twice over the same closed month, once with a different `nowIso`,
 * once after the dated correction and once over the open month — so "byte-identical output" is a claim about
 * this function rather than about one object that happens to be reused.
 */
async function generate(month: Month, nowIso: string): Promise<FinancialStatements> {
  const period = { periodId: month.periodId, startsOn: month.startsOn, endsOn: month.endsOn }
  const figures = await statementLedgerFigures(sql, period)
  const source = await statementPeriodSource(sql, { period, nowIso })
  const [positionCensus, movementCensus, late] = await Promise.all([
    statementLedgerCensus(sql, { fromInclusive: null, toInclusive: period.endsOn }),
    statementLedgerCensus(sql, {
      fromInclusive: period.startsOn,
      toInclusive: period.endsOn,
    }),
    journalRowsWrittenAfter(sql, period, source.sourceAsOf),
  ])
  return buildFinancialStatements({
    chart: STANDARD_SPA_CHART,
    layout,
    period: {
      periodId: period.periodId,
      startsOn: localDate(period.startsOn),
      endsOn: localDate(period.endsOn),
    },
    openingAsAt: localDate(figures.openingAsAt),
    openingPosition: figures.openingPosition,
    closingPosition: figures.closingPosition,
    sourceAsOf: source.sourceAsOf,
    lockedPeriodId: source.lockedPeriodId,
    rowsWrittenAfterTheSourceInstant: late,
    positionCensus,
    movementCensus,
  })
}

const lineOf = (statements: FinancialStatements, lineId: string): bigint | undefined =>
  [
    ...statements.profitAndLoss.lines,
    ...statements.closingBalanceSheet.lines,
    ...statements.cashFlow.lines,
  ].find((line) => line.lineId === lineId)?.fils

/** The movement in a balance-sheet line across the period: closing position less opening. */
const sheetMovement = (statements: FinancialStatements, lineId: string): bigint => {
  const closing = statements.closingBalanceSheet.lines.find((line) => line.lineId === lineId)
  const opening = statements.openingBalanceSheet.lines.find((line) => line.lineId === lineId)
  return (closing?.fils ?? 0n) - (opening?.fils ?? 0n)
}

const sectionMovement = (statements: FinancialStatements, section: string): bigint =>
  statements.closingBalanceSheet.lines
    .filter((line) => line.section === section)
    .reduce((total, line) => total + sheetMovement(statements, line.lineId), 0n)

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  layout = statementLayoutFor(STANDARD_SPA_CHART)

  // A lock left behind by an interrupted earlier run would refuse every entry here with ZL002 and every
  // case would report that instead. Scoped to the ids this suite creates (ADR 0050).
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

  const [first, second] = await virginWindow()
  closedMonth = first
  openMonth = second

  for (const entry of monthEntries(closedMonth)) {
    await withUnitOfWork(sql, ACTOR, (uow) => postJournalEntry(uow, entry))
  }
  cardSaleEntryId = `je-rrep02s-${RUN}-${closedMonth.periodId}-card-sale`

  await withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId: closedMonth.periodId,
      startsOn: closedMonth.startsOn,
      endsOn: closedMonth.endsOn,
      reason: 'R-REP-02 statements fixture',
      closedByActorKind: 'system',
    }),
  )

  statements = await generate(closedMonth, NOW_ISO)
  statementsAgain = await generate(closedMonth, NOW_ISO)
  statementsOtherNow = await generate(closedMonth, '2301-06-01T00:00:00.000Z')
  bytesBeforeTheCorrection = statementBytes(statements)

  // The correction: the card sale reversed AFTER its own period was filed. The service decides the date.
  await withUnitOfWork(sql, ACTOR, (uow) =>
    postDatedCorrection(uow, {
      reversesEntryId: cardSaleEntryId,
      entryId: `je-rrep02s-${RUN}-${closedMonth.periodId}-card-sale-reversed`,
      narrative: 'Reversal of the card treatment sale',
      lines: [
        { accountCode: ACCOUNTS.treatmentRevenue, debitFils: CARD_SALE_NET, creditFils: 0 },
        { accountCode: ACCOUNTS.outputVatPayable, debitFils: CARD_SALE_VAT, creditFils: 0 },
        { accountCode: ACCOUNTS.cardTerminalClearing, debitFils: 0, creditFils: CARD_SALE_GROSS },
      ],
    }),
  )

  statementsAfterTheCorrection = await generate(closedMonth, NOW_ISO)
  openMonthStatements = await generate(openMonth, NOW_ISO)
}, 120_000)

afterAll(async () => {
  if (!sql) return
  // The locks go, so a later run is not refused its own dates by ZL002. The journal entries stay:
  // `journal_entry` refuses DELETE for every role, which is why the window is searched for.
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`
  await sql.end({ timeout: 5 })
})

describe('the month this unit is asserted over', () => {
  it('holds exactly the rows the figures below were counted from', () => {
    const movement = statements.coverage.find((entry) => entry.window === 'movement')
    expect(movement?.lineCount).toBe(MONTH_LINES)
    expect(movement?.censusMovementFils).toBe(MONTH_DEBITS * 2n)
    expect(new Set(monthEntries(closedMonth).map((entry) => entry.entryId)).size).toBe(
      MONTH_ENTRIES,
    )
  })

  it('was closed, so the figures are read at the lock’s own instant', () => {
    expect(statements.lockedPeriodId).toBe(closedMonth.periodId)
    expect(statements.rowsWrittenAfterTheSourceInstant).toBe(0)
    expect(statements.notReproducibleReasons).toEqual([])
  })

  it('carries the provisional markers rather than presenting the grouping as settled', () => {
    expect(statements.provisional.map((marker) => marker.openQuestionId)).toContain('Y8-coa')
  })
})

describe('the profit and loss account', () => {
  it('reports every line to the fil', () => {
    expect(lineOf(statements, 'treatment_revenue')).toBe(TREATMENT_REVENUE_FILS)
    expect(lineOf(statements, 'package_and_voucher_revenue')).toBe(PACKAGE_REVENUE_FILS)
    expect(lineOf(statements, 'retail_revenue')).toBe(RETAIL_REVENUE_FILS)
    expect(lineOf(statements, 'discounts_and_allowances')).toBe(DISCOUNTS_FILS)
    expect(lineOf(statements, 'staff_costs')).toBe(STAFF_COSTS_FILS)
    expect(lineOf(statements, 'premises_costs')).toBe(PREMISES_COSTS_FILS)
    expect(lineOf(statements, 'depreciation')).toBe(DEPRECIATION_FILS)
    expect(statements.profitAndLoss.totalRevenueFils).toBe(TOTAL_REVENUE_FILS)
    expect(statements.profitAndLoss.totalExpensesFils).toBe(TOTAL_EXPENSES_FILS)
    expect(statements.profitAndLoss.netProfitFils).toBe(NET_PROFIT_FILS)
  })

  it('keeps a discount on the revenue side rather than turning it into a cost', () => {
    const discount = statements.profitAndLoss.lines.find(
      (line) => line.lineId === 'discounts_and_allowances',
    )
    expect(discount?.section).toBe('revenue')
    expect(discount?.fils).toBeLessThan(0n)
  })
})

describe('the balance sheet', () => {
  it('balances at the opening date and at the closing date, to the fil', () => {
    expect(statements.openingBalanceSheet.differenceFils).toBe(0n)
    expect(statements.closingBalanceSheet.differenceFils).toBe(0n)
  })

  it('moves by the month, section by section', () => {
    expect(sectionMovement(statements, 'assets')).toBe(ASSETS_MOVEMENT_FILS)
    expect(sectionMovement(statements, 'liabilities')).toBe(LIABILITIES_MOVEMENT_FILS)
    expect(sectionMovement(statements, 'equity')).toBe(EQUITY_MOVEMENT_FILS)
    // And the three agree, which is the identity above restated as a movement rather than a position.
    expect(ASSETS_MOVEMENT_FILS).toBe(LIABILITIES_MOVEMENT_FILS + EQUITY_MOVEMENT_FILS)
  })

  it('shows accumulated depreciation as a deduction and the couch at cost', () => {
    expect(sheetMovement(statements, 'accumulated_depreciation')).toBe(-DEPRECIATION_FILS)
    expect(sheetMovement(statements, 'equipment_at_cost')).toBe(120_000n)
  })
})

describe('the articulation', () => {
  it('holds net profit equal to the movement in retained earnings, to the fil', () => {
    expect(statements.articulation.differenceFils).toBe(0n)
    expect(statements.articulation.movementFils).toBe(NET_PROFIT_FILS)
    expect(statements.articulation.netProfitFils).toBe(NET_PROFIT_FILS)
  })

  it('reports at zero the figure that would make the simple reading false', () => {
    // Nothing posts to retained earnings in this build; the identity is exact either way, and the plain
    // sentence "net profit equals the movement" is true only while this is zero. Reported, not assumed.
    expect(statements.articulation.directEquityPostingsFils).toBe(0n)
    expect(lineOf(statements, 'postings_to_retained_earnings')).toBe(0n)
  })
})

describe('the cash flow', () => {
  it('reports the three sections and the net movement to the fil', () => {
    expect(statements.cashFlow.operatingFils).toBe(OPERATING_FILS)
    expect(statements.cashFlow.investingFils).toBe(INVESTING_FILS)
    expect(statements.cashFlow.financingFils).toBe(FINANCING_FILS)
    expect(statements.cashFlow.netMovementInCashFils).toBe(NET_CASH_MOVEMENT_FILS)
  })

  it('opens with the profit and loss net profit, unchanged', () => {
    const opening =
      (lineOf(statements, 'revenue_recognised_in_the_period') ?? 0n) +
      (lineOf(statements, 'costs_recognised_in_the_period') ?? 0n)
    expect(opening).toBe(NET_PROFIT_FILS)
  })

  it('closes cash equal to the ledger cash and bank balances, to the fil', () => {
    expect(statements.cashFlow.differenceFils).toBe(0n)
    // And the figure it was compared against is the balance sheet's own cash line, which is the second
    // reader of the cash-account set the layout states once.
    expect(statements.cashFlow.ledgerCashFils).toBe(lineOf(statements, 'cash_and_bank'))
    expect(statements.cashFlow.closingCashFils - statements.cashFlow.openingCashFils).toBe(
      NET_CASH_MOVEMENT_FILS,
    )
  })

  it('is untouched by a transfer between two cash accounts', () => {
    /*
      Entry 16 banked 50,000 from the drawer. Both legs are cash accounts, so neither is in the non-cash
      partition the cash flow is built from and no line may move — which is the case a direct-method
      statement has to allocate pro rata when the same entry also carries a bank fee. Asserted as a
      property of the FIGURES rather than of the code: the banking run is in the month, the net movement is
      291,500, and 291,500 is what the cash accounts moved by.
    */
    const banked = statements.cashFlow.lines.filter((line) =>
      line.accountCodes.some((accountCode) => layout.cashAccountCodes.includes(accountCode)),
    )
    expect(banked).toEqual([])
  })

  it('adds depreciation back and puts the couch in investing', () => {
    expect(lineOf(statements, 'depreciation_charged_in_the_period')).toBe(DEPRECIATION_FILS)
    expect(lineOf(statements, 'purchase_of_equipment')).toBe(INVESTING_FILS)
  })
})

describe('every line drills to the journal rows that compose it', () => {
  it('sums the rows behind every line of all three statements to the line exactly', async () => {
    const rows = drillableLines(statements)
    // The population, asserted before it is used: an empty or short enumeration would make the property
    // below pass over a subset that happens to be the sound one.
    expect(rows.length).toBe(
      statements.profitAndLoss.lines.length +
        statements.closingBalanceSheet.lines.length * 2 +
        statements.cashFlow.lines.length,
    )
    expect(rows.length).toBeGreaterThan(70)
    let movementLinesWithRows = 0
    for (const row of rows) {
      const journal = await statementDrillDown(sql, {
        accountCodes: [...row.line.accountCodes],
        fromInclusive: row.fromInclusive,
        toInclusive: row.toInclusive,
      })
      const debits = journal.reduce((total, entry) => total + entry.debitFils, 0n)
      const credits = journal.reduce((total, entry) => total + entry.creditFils, 0n)
      const summed = directedTotalFils(row.line.direction, debits, credits)
      expect(
        summed,
        `${row.statement}/${row.line.lineId} at ${row.toInclusive} read ${summed} from ${journal.length} ` +
          `journal line(s) and reports ${row.line.fils}`,
      ).toBe(row.line.fils)
      if (journal.length > 0 && row.window === 'movement') movementLinesWithRows += 1
    }
    /*
      MEASURED, and here for brief rule 22's reason: a drill-down that returned nothing at all would satisfy
      the property above for every line whose figure is zero, and most lines in a single month ARE zero. So
      how many lines actually HAD rows is counted, and counted over the MOVEMENT window only — that window
      holds this suite's own entries and nothing else, so the figure is exact rather than a function of what
      earlier suites in the run left behind. Measured at 22: seven of the fourteen profit-and-loss lines and
      fifteen of the nineteen cash-flow lines. Asserted exactly, because a floor here would be satisfied by a
      drill-down that had stopped returning rows for two thirds of them.
    */
    expect(movementLinesWithRows).toBe(22)
  }, 60_000)

  it('the control: a line that claims the wrong accounts does NOT sum to its figure', async () => {
    const cash = statements.closingBalanceSheet.lines.find(
      (line) => line.lineId === 'cash_and_bank',
    )
    const short = (cash?.accountCodes ?? []).filter(
      (accountCode) => accountCode !== ACCOUNTS.bankCurrent,
    )
    const journal = await statementDrillDown(sql, {
      accountCodes: [...short],
      fromInclusive: null,
      toInclusive: statements.period.endsOn,
    })
    const debits = journal.reduce((total, entry) => total + entry.debitFils, 0n)
    const credits = journal.reduce((total, entry) => total + entry.creditFils, 0n)
    expect(directedTotalFils('debit_less_credit', debits, credits)).not.toBe(cash?.fils)
  })

  it('claims every journal line in both windows exactly once, against a census that knows no layout', async () => {
    /*
      The other half of "tied to the ledger", and the half the identities cannot give. The balance sheet's
      lines partition the whole chart, so the rows they claim must be EVERY row in the window — counted
      against `statementLedgerCensus`, which has no `group by`, no join to `account` and no account set at
      all. An account posted to and claimed by no line leaves the sheet balancing and this count short.
    */
    for (const window of [null, closedMonth.startsOn] as const) {
      const census = await statementLedgerCensus(sql, {
        fromInclusive: window,
        toInclusive: closedMonth.endsOn,
      })
      let claimed = 0
      for (const line of statements.closingBalanceSheet.lines) {
        const journal = await statementDrillDown(sql, {
          accountCodes: [...line.accountCodes],
          fromInclusive: window,
          toInclusive: closedMonth.endsOn,
        })
        claimed += journal.length
      }
      expect(claimed, `window from ${window ?? 'the beginning'}`).toBe(census.lineCount)
      expect(census.lineCount).toBeGreaterThan(0)
    }
  }, 60_000)

  it('accounts for every fil in both windows, by the statements’ own coverage', () => {
    for (const coverage of statements.coverage) {
      expect(coverage.unclaimedAccountCodes).toEqual([])
      expect(coverage.differenceFils).toBe(0n)
    }
  })
})

describe('a dated reversal lands in the period of its own date', () => {
  it('does not restate the filed period: the bytes are identical before and after', () => {
    expect(statementBytes(statementsAfterTheCorrection)).toBe(bytesBeforeTheCorrection)
    expect(statementContentHash(statementsAfterTheCorrection)).toBe(
      statementContentHash(statements),
    )
    expect(statementsAfterTheCorrection.rowsWrittenAfterTheSourceInstant).toBe(0)
  })

  it('appears in the next open period instead', () => {
    expect(openMonthStatements.lockedPeriodId).toBeNull()
    expect(openMonthStatements.profitAndLoss.netProfitFils).toBe(-CARD_SALE_NET_FILS)
    expect(lineOf(openMonthStatements, 'treatment_revenue')).toBe(-CARD_SALE_NET_FILS)
    expect(openMonthStatements.closingBalanceSheet.differenceFils).toBe(0n)
  })

  it('says the open period is not reproducible, because the next posting changes it', () => {
    expect(openMonthStatements.notReproducibleReasons.join(' ')).toContain('is not closed')
  })
})

describe('re-running a locked period produces byte-identical output', () => {
  it('is byte-identical across two independent generations', () => {
    expect(statementBytes(statementsAgain)).toBe(bytesBeforeTheCorrection)
    expect(statementContentHash(statementsAgain)).toBe(statementContentHash(statements))
  })

  it('is byte-identical when a different evaluation instant is passed', () => {
    // For a closed period `sourceAsOf` is the lock's own `locked_at`, so the caller's instant cannot reach
    // any figure — which is what makes a regeneration years later the same artefact.
    expect(statementBytes(statementsOtherNow)).toBe(bytesBeforeTheCorrection)
  })

  it('and the bytes change when one fil moves — the control', () => {
    const tampered = {
      ...statements,
      profitAndLoss: {
        ...statements.profitAndLoss,
        netProfitFils: statements.profitAndLoss.netProfitFils + 1n,
      },
    }
    expect(statementBytes(tampered)).not.toBe(bytesBeforeTheCorrection)
    expect(statementContentHash(tampered)).not.toBe(statementContentHash(statements))
  })

  it('renders every money figure as a decimal string, so nothing is a float in the bytes', () => {
    expect(bytesBeforeTheCorrection).toContain(`"netProfitFils":"${NET_PROFIT_FILS}"`)
    expect(bytesBeforeTheCorrection).not.toMatch(/"[a-zA-Z]+Fils":-?\d+\.\d/)
  })
})

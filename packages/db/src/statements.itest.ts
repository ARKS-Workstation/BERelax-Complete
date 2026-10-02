import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Actor } from './audit.ts'
import { createConnection, type Sql } from './connection.ts'
import {
  journalRowsWrittenAfter,
  statementBytes,
  statementContentHash,
  statementDrillDown,
  statementLedgerCensus,
  statementLedgerFigures,
  statementPeriodSource,
} from './reporting/statement-queries.ts'
import { type JournalEntryInput, postJournalEntry } from './repositories/journal.ts'
import { closeAccountingPeriod, postDatedCorrection } from './services/period-close.ts'
import { withUnitOfWork } from './tx.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * R-REP-02 — the ledger reads the three statements are built from, against real PostgreSQL.
 *
 * # What this file is and is not
 *
 * It is the **database half**. `packages/db` may never import `packages/core` (ADR 0001), so nothing here
 * can build a statement: the layout, the three statements and every identity are asserted in
 * `packages/fixtures/src/statements.itest.ts`, which may depend on both. What is asserted here is the four
 * things a statement rests on and which only a real database can show:
 *
 *   1. the opening position **excludes** the period and the closing position includes it, so consecutive
 *      periods neither overlap nor leave a gap;
 *   2. the drill-down's two windows — a position from the beginning of the ledger, a movement across the
 *      period — return exactly the rows their figures were taken from;
 *   3. the census counts rows and sums both columns **with no reference to any account set**, which is what
 *      makes an account claimed by no statement line visible at all;
 *   4. the ledger a statement reads **cannot be edited** (ZL001), and a correction to a closed period lands
 *      in the period of its own date.
 *
 * # Why the ledger here is posted directly
 *
 * A statement reads `journal_line` and nothing else, so a month built out of invoices, payments and
 * redemptions would exercise five posting services to produce the same fourteen lines. `month-
 * reconciliation.itest.ts` goes through the real services because its whole subject is documents against
 * the ledger; this unit's subject is the ledger against itself, and the entries are therefore posted
 * through `postJournalEntry` — the ONE write path — with figures counted by hand.
 *
 * It also means the month can be closed: `period_close_blocker()` refuses a period holding an invoice with
 * no `checkout_finalisation` row (0073), and a month with no documents in it has no blockers.
 *
 * # Why the window is searched for rather than fixed
 *
 * `journal_entry` refuses DELETE for every role including the owner (ZL001), so nothing can remove the
 * entries this suite posts and a FIXED month would double every figure on a second run against the same
 * database — M-TILL-10's recorded defect, where a delta-free assertion read 430,003 where 33,334 was
 * expected, from its own first run. The window is derived from `max(entry_date)` inside a reserved span and
 * every figure below is absolute for whichever window it got.
 */

/**
 * The span this suite may post into.
 *
 * Measured rather than assumed: the years in any date literal under `packages`, `apps` or `scripts` are
 * 2000-2036, 2079-2100, 2120-2149, 2150-2199 and 2200-2249 — the last claimed by
 * `month-reconciliation.itest.ts`, and 2150-2199 by `packages/fixtures/src/vat201.ts`. So 2250 onwards was
 * claimed by nothing, and this suite takes the first fifty years of it.
 * `packages/fixtures/src/statements.itest.ts` takes 2300-2349 and says so, because the two files are in one
 * integration run and a shared span would have them racing for the same months.
 *
 * Six hundred months is three hundred runs of this suite at two months each, and roughly forty runs of gate
 * block 142 — the figure that matters, because several of its cases invoke this suite once each. A span of a
 * few years would be exhausted inside one gate run and the failure would arrive as "the fixture threw" in a
 * case about something else.
 */
const STATEMENT_QUERIES_RESERVED_SPAN = { from: '2250-01-01', to: '2299-12-31' } as const

const PREFIX = 'RREP02Q'
const RUN = Date.now().toString(36)
const ACTOR: Actor = { kind: 'system', label: 'r-rep-02 statement queries itest' }

/** An instant before anything this suite writes, so the as-of census has something to find. */
const STALE_INSTANT = '2000-01-01T00:00:00.000Z'
const NOW_ISO = '2299-12-31T06:00:00.000Z'

// --- the ledger, counted by hand -----------------------------------------------------------------
//
// Six entries and thirteen lines, dated on ONE day inside the closed month. Figures chosen so that every
// account's position is distinct and no two sums are equal by accident — a suite whose expected figures
// collide cannot tell a right answer from a transposition.
//
//   1. capital introduced   Dr 1020 bank        500_000   Cr 3010 owner's capital   500_000
//   2. cash sale            Dr 1010 drawer       21_000   Cr 4010 revenue            20_000
//                                                         Cr 2030 output VAT          1_000
//   3. rent                 Dr 6010 rent         60_000   Cr 1020 bank               60_000
//   4. equipment bought     Dr 1100 equipment   100_000   Cr 1020 bank              100_000
//   5. depreciation         Dr 6130              5_000    Cr 1110 accumulated         5_000
//   6. drawings             Dr 3020              30_000   Cr 1010 drawer             30_000
//
// so the month's totals are 716,000 fils of debits and 716,000 of credits over 13 lines, the bank closes at
// 500,000 - 60,000 - 100,000 = 340,000 and the drawer at 21,000 - 30,000 = -9,000, which is 331,000 of cash
// and bank between them. Counted EXACTLY and never as a floor: the window is virgin, and "at least one row"
// would be satisfied by a month holding one.
const CAPITAL = 500_000
const SALE_GROSS = 21_000
const SALE_NET = 20_000
const SALE_VAT = 1_000
const RENT = 60_000
const EQUIPMENT = 100_000
const DEPRECIATION = 5_000
const DRAWINGS = 30_000
const MONTH_LINES = 13
const MONTH_DEBITS = BigInt(CAPITAL + SALE_GROSS + RENT + EQUIPMENT + DEPRECIATION + DRAWINGS)
const BANK_CLOSING = BigInt(CAPITAL - RENT - EQUIPMENT)
const DRAWER_CLOSING = BigInt(SALE_GROSS - DRAWINGS)

/** The chart codes, written out: `packages/db` may never import `packages/core`. */
const CASH_IN_DRAWER = '1010'
const PETTY_CASH = '1015'
const BANK_CURRENT = '1020'
const EQUIPMENT_AT_COST = '1100'
const ACCUMULATED_DEPRECIATION = '1110'
const OUTPUT_VAT = '2030'
const OWNERS_CAPITAL = '3010'
const OWNERS_DRAWINGS = '3020'
const TREATMENT_REVENUE = '4010'
const RENT_EXPENSE = '6010'
const DEPRECIATION_EXPENSE = '6130'

const CASH_CODES = [CASH_IN_DRAWER, PETTY_CASH, BANK_CURRENT]

interface Month {
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  /** The one day inside the month every entry is dated on. */
  readonly on: string
}

let sql: Sql
let closedMonth: Month
let openMonth: Month
let lockedAt: string
let saleEntryId: string
let correctionDate: string

const monthAt = (year: number, month: number): Month => {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    periodId: `${PREFIX}-${year}-${mm}`,
    startsOn: `${year}-${mm}-01`,
    endsOn: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    on: `${year}-${mm}-15`,
  }
}

const nextMonthAfter = (isoDate: string) => {
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

/**
 * Two consecutive months in the reserved span that no journal entry has ever been dated in.
 *
 * Derived from the database rather than from the clock, so two suites in one run cannot pick the same
 * window. It throws rather than wrapping when the span runs out, and says what to do: a silent wrap lands
 * on a month that already holds a previous run's entries and every figure below reads double.
 */
async function virginWindow(): Promise<readonly [Month, Month]> {
  const [row] = await sql<{ used: string | null }[]>`
    select max(entry_date)::text as used
      from journal_entry
     where entry_date between ${STATEMENT_QUERIES_RESERVED_SPAN.from}::date
                          and ${STATEMENT_QUERIES_RESERVED_SPAN.to}::date
  `
  const used = row?.used ?? null
  const first =
    used === null
      ? {
          year: Number(STATEMENT_QUERIES_RESERVED_SPAN.from.slice(0, 4)),
          month: Number(STATEMENT_QUERIES_RESERVED_SPAN.from.slice(5, 7)),
        }
      : nextMonthAfter(used)
  const months = [0, 1].map((offset) => {
    const zeroBased = first.month - 1 + offset
    return monthAt(first.year + Math.floor(zeroBased / 12), (zeroBased % 12) + 1)
  })
  const last = months[1] as Month
  if (last.endsOn > STATEMENT_QUERIES_RESERVED_SPAN.to) {
    throw new Error(
      'The R-REP-02 statement-queries suite needs two consecutive months with no journal entry in them, ' +
        `and the reserved span ${STATEMENT_QUERIES_RESERVED_SPAN.from}..` +
        `${STATEMENT_QUERIES_RESERVED_SPAN.to} is used up to ${used}. The journal is append-only and ` +
        'refuses the owner, so the entries cannot be removed: run this suite against a fresh database, or ' +
        'widen STATEMENT_QUERIES_RESERVED_SPAN into a half-century no other suite posts into. Wrapping ' +
        'round would land on a month that already holds a previous run and every figure would read double.',
    )
  }
  return [months[0] as Month, months[1] as Month]
}

const entries = (month: Month): readonly JournalEntryInput[] => {
  const id = (what: string) => `je-rrep02q-${RUN}-${month.periodId}-${what}`
  return [
    {
      entryId: id('capital'),
      entryDate: month.on,
      narrative: 'Owner capital introduced',
      source: 'adjustment',
      lines: [
        { accountCode: BANK_CURRENT, debitFils: CAPITAL, creditFils: 0 },
        { accountCode: OWNERS_CAPITAL, debitFils: 0, creditFils: CAPITAL },
      ],
    },
    {
      entryId: id('sale'),
      entryDate: month.on,
      narrative: 'Cash treatment sale',
      source: 'sale',
      lines: [
        { accountCode: CASH_IN_DRAWER, debitFils: SALE_GROSS, creditFils: 0 },
        { accountCode: TREATMENT_REVENUE, debitFils: 0, creditFils: SALE_NET },
        { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: SALE_VAT },
      ],
    },
    {
      entryId: id('rent'),
      entryDate: month.on,
      narrative: 'Monthly rent',
      source: 'supplier_bill',
      lines: [
        { accountCode: RENT_EXPENSE, debitFils: RENT, creditFils: 0 },
        { accountCode: BANK_CURRENT, debitFils: 0, creditFils: RENT },
      ],
    },
    {
      entryId: id('equipment'),
      entryDate: month.on,
      narrative: 'Treatment couch purchased',
      source: 'supplier_bill',
      lines: [
        { accountCode: EQUIPMENT_AT_COST, debitFils: EQUIPMENT, creditFils: 0 },
        { accountCode: BANK_CURRENT, debitFils: 0, creditFils: EQUIPMENT },
      ],
    },
    {
      entryId: id('depreciation'),
      entryDate: month.on,
      narrative: 'Monthly depreciation charge',
      source: 'depreciation',
      lines: [
        { accountCode: DEPRECIATION_EXPENSE, debitFils: DEPRECIATION, creditFils: 0 },
        { accountCode: ACCUMULATED_DEPRECIATION, debitFils: 0, creditFils: DEPRECIATION },
      ],
    },
    {
      entryId: id('drawings'),
      entryDate: month.on,
      narrative: 'Owner drawings, cash',
      source: 'payout',
      lines: [
        { accountCode: OWNERS_DRAWINGS, debitFils: DRAWINGS, creditFils: 0 },
        { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: DRAWINGS },
      ],
    },
  ]
}

const positionOf = (
  figures: readonly { accountCode: string; debitFils: bigint; creditFils: bigint }[],
  code: string,
): bigint => {
  const row = figures.find((figure) => figure.accountCode === code)
  return (row?.debitFils ?? 0n) - (row?.creditFils ?? 0n)
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  // A lock left behind by an interrupted earlier run would refuse every entry here with ZL002 and every
  // case would report that instead — month-reconciliation.itest.ts's and vat201.itest.ts's reason.
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

  const [first, second] = await virginWindow()
  closedMonth = first
  openMonth = second

  for (const entry of entries(closedMonth)) {
    await withUnitOfWork(sql, ACTOR, (uow) => postJournalEntry(uow, entry))
  }
  saleEntryId = `je-rrep02q-${RUN}-${closedMonth.periodId}-sale`

  const closed = await withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId: closedMonth.periodId,
      startsOn: closedMonth.startsOn,
      endsOn: closedMonth.endsOn,
      reason: 'R-REP-02 statement-queries fixture',
      closedByActorKind: 'system',
    }),
  )
  const [lock] = await sql<{ lockedAt: string }[]>`
    select locked_at::text as "lockedAt" from period_lock where period_id = ${closedMonth.periodId}
  `
  lockedAt = lock?.lockedAt as string
  expect(closed.trialBalanceHash).toMatch(/^[0-9a-f]{64}$/)

  // The dated correction: the sale reversed AFTER its own period was filed. The service decides the date.
  const correction = await withUnitOfWork(sql, ACTOR, (uow) =>
    postDatedCorrection(uow, {
      reversesEntryId: saleEntryId,
      entryId: `je-rrep02q-${RUN}-${closedMonth.periodId}-sale-reversed`,
      narrative: 'Reversal of the cash treatment sale',
      lines: [
        { accountCode: CASH_IN_DRAWER, debitFils: 0, creditFils: SALE_GROSS },
        { accountCode: TREATMENT_REVENUE, debitFils: SALE_NET, creditFils: 0 },
        { accountCode: OUTPUT_VAT, debitFils: SALE_VAT, creditFils: 0 },
      ],
    }),
  )
  correctionDate = correction.entry.entryDate
})

afterAll(async () => {
  if (!sql) return
  // The locks go, so a later run of this file is not refused its own dates by ZL002. Scoped to the ids
  // this suite creates: a suite may delete only rows it created (ADR 0050). The journal entries stay —
  // `journal_entry` refuses DELETE for every role, which is why the window is searched for.
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`
  await sql.end({ timeout: 5 })
})

describe('the opening and closing positions', () => {
  it('opens the period at the day before it starts', async () => {
    const figures = await statementLedgerFigures(sql, closedMonth)
    const [year, month] = [closedMonth.startsOn.slice(0, 4), closedMonth.startsOn.slice(5, 7)]
    expect(figures.openingAsAt).not.toBe(closedMonth.startsOn)
    // The last day of the previous month, computed by PostgreSQL. Asserted against the month it is IN
    // rather than against a literal, because the window is derived.
    expect(figures.openingAsAt < `${year}-${month}-01`).toBe(true)
  })

  it('excludes the period from the opening position and includes it in the closing one', async () => {
    const figures = await statementLedgerFigures(sql, closedMonth)
    // The MOVEMENT is this suite's, absolutely; the positions themselves hold whatever every earlier
    // suite in the run posted, which is why nothing here asserts a position as a total (brief rule 12).
    const openingBank = positionOf(figures.openingPosition, BANK_CURRENT)
    const closingBank = positionOf(figures.closingPosition, BANK_CURRENT)
    expect(closingBank - openingBank).toBe(BANK_CLOSING)
    const openingDrawer = positionOf(figures.openingPosition, CASH_IN_DRAWER)
    const closingDrawer = positionOf(figures.closingPosition, CASH_IN_DRAWER)
    expect(closingDrawer - openingDrawer).toBe(DRAWER_CLOSING)
  })

  it('does not carry the dated correction into the closed month', async () => {
    // The correction is dated in the NEXT period, so the closed month's closing position is the month's.
    const closed = await statementLedgerFigures(sql, closedMonth)
    const open = await statementLedgerFigures(sql, openMonth)
    const movement = (
      figures: Awaited<ReturnType<typeof statementLedgerFigures>>,
      code: string,
    ): bigint =>
      positionOf(figures.closingPosition, code) - positionOf(figures.openingPosition, code)
    expect(movement(closed, TREATMENT_REVENUE)).toBe(-BigInt(SALE_NET))
    expect(movement(open, TREATMENT_REVENUE)).toBe(BigInt(SALE_NET))
  })

  it('refuses a period read backwards rather than returning an empty month', async () => {
    await expect(
      statementLedgerFigures(sql, {
        periodId: closedMonth.periodId,
        startsOn: closedMonth.endsOn,
        endsOn: closedMonth.startsOn,
      }),
    ).rejects.toThrow(/before it starts/)
  })

  it('refuses a blank period identifier and a malformed date', async () => {
    await expect(statementLedgerFigures(sql, { ...closedMonth, periodId: '  ' })).rejects.toThrow(
      /identifier an accountant recognises/,
    )
    await expect(
      statementLedgerFigures(sql, { ...closedMonth, startsOn: '15/06/2250' }),
    ).rejects.toThrow(/ISO business day/)
  })
})

describe('the census', () => {
  it('counts every line in the period with no reference to any account set', async () => {
    const census = await statementLedgerCensus(sql, {
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    expect(census.lineCount).toBe(MONTH_LINES)
    expect(census.debitFils).toBe(MONTH_DEBITS)
    // Balanced, because the journal cannot hold an entry whose sides disagree.
    expect(census.creditFils).toBe(MONTH_DEBITS)
    expect(census.accountCodes).toEqual(
      [
        CASH_IN_DRAWER,
        BANK_CURRENT,
        EQUIPMENT_AT_COST,
        ACCUMULATED_DEPRECIATION,
        OUTPUT_VAT,
        OWNERS_CAPITAL,
        OWNERS_DRAWINGS,
        TREATMENT_REVENUE,
        RENT_EXPENSE,
        DEPRECIATION_EXPENSE,
      ].sort(),
    )
  })

  it('reads a position census from the beginning of the ledger', async () => {
    const position = await statementLedgerCensus(sql, {
      fromInclusive: null,
      toInclusive: closedMonth.endsOn,
    })
    const movement = await statementLedgerCensus(sql, {
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    // The position is a superset: it holds everything every earlier suite posted as well.
    expect(position.lineCount).toBeGreaterThanOrEqual(movement.lineCount)
    expect(position.debitFils).toBeGreaterThanOrEqual(movement.debitFils)
  })

  it('agrees with the positions it is supposed to anchor, to the fil', async () => {
    /*
      The check the coverage identity in @berelax/core is built on, made here against the two queries that
      have to agree: `trialBalanceAsAt` groups by account and drops accounts with no activity, the census
      does neither. Summing debits plus credits over the period's accounts from the POSITIONS must give the
      census's own total, or an account is missing from one of them.
    */
    const figures = await statementLedgerFigures(sql, closedMonth)
    const census = await statementLedgerCensus(sql, {
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    const movementTotal = census.accountCodes.reduce((total, code) => {
      const closing = figures.closingPosition.find((figure) => figure.accountCode === code)
      const opening = figures.openingPosition.find((figure) => figure.accountCode === code)
      const debit = (closing?.debitFils ?? 0n) - (opening?.debitFils ?? 0n)
      const credit = (closing?.creditFils ?? 0n) - (opening?.creditFils ?? 0n)
      return total + debit + credit
    }, 0n)
    expect(movementTotal).toBe(census.debitFils + census.creditFils)
  })
})

describe('the drill-down', () => {
  it('returns the rows behind a movement line and they sum to its figure', async () => {
    const rows = await statementDrillDown(sql, {
      accountCodes: CASH_CODES,
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    const debits = rows.reduce((total, row) => total + row.debitFils, 0n)
    const credits = rows.reduce((total, row) => total + row.creditFils, 0n)
    // Drawer 21,000 in and 30,000 out; bank 500,000 in and 160,000 out.
    expect(debits - credits).toBe(BANK_CLOSING + DRAWER_CLOSING)
    expect(rows.map((row) => row.accountCode).every((code) => CASH_CODES.includes(code))).toBe(true)
    // Two drawer lines (the sale in, the drawings out) and three bank lines (capital in, rent and the
    // couch out). Petty cash is claimed and has none, which is the case a drill-down has to survive.
    expect(rows).toHaveLength(5)
  })

  it('returns the whole ledger to a date for a position line', async () => {
    const position = await statementDrillDown(sql, {
      accountCodes: CASH_CODES,
      fromInclusive: null,
      toInclusive: closedMonth.endsOn,
    })
    const movement = await statementDrillDown(sql, {
      accountCodes: CASH_CODES,
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    expect(position.length).toBeGreaterThanOrEqual(movement.length)
    expect(position.every((row) => row.entryDate <= closedMonth.endsOn)).toBe(true)
  })

  it('orders fully, so two runs return the same rows in the same order', async () => {
    const window = {
      accountCodes: CASH_CODES,
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    }
    const [one, two] = await Promise.all([
      statementDrillDown(sql, window),
      statementDrillDown(sql, window),
    ])
    expect(one).toEqual(two)
    const keys = one.map((row) => `${row.entryDate}|${row.entryId}|${row.lineNo}`)
    expect([...keys].sort()).toEqual(keys)
  })

  it('carries the reversal pointer, so a corrected figure can be traced', async () => {
    const rows = await statementDrillDown(sql, {
      accountCodes: [TREATMENT_REVENUE],
      fromInclusive: openMonth.startsOn,
      toInclusive: openMonth.endsOn,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reverses).toBe(saleEntryId)
    expect(rows[0]?.source).toBe('reversal')
    expect(rows[0]?.debitFils).toBe(BigInt(SALE_NET))
  })

  it('refuses an empty account set rather than agreeing with any figure at all', async () => {
    await expect(
      statementDrillDown(sql, {
        accountCodes: [],
        fromInclusive: null,
        toInclusive: closedMonth.endsOn,
      }),
    ).rejects.toThrow(/at least one account code/)
  })
})

describe('as of the lock', () => {
  it('reads a closed period at the lock’s own instant', async () => {
    const source = await statementPeriodSource(sql, { period: closedMonth, nowIso: NOW_ISO })
    expect(source.lockedPeriodId).toBe(closedMonth.periodId)
    expect(source.sourceAsOf).toBe(lockedAt)
    // And a different `nowIso` cannot move it, which is what makes the bytes stable.
    const again = await statementPeriodSource(sql, {
      period: closedMonth,
      nowIso: '2251-06-01T00:00:00.000Z',
    })
    expect(again.sourceAsOf).toBe(lockedAt)
  })

  it('reads an open period at the caller’s instant', async () => {
    const source = await statementPeriodSource(sql, { period: openMonth, nowIso: NOW_ISO })
    expect(source.lockedPeriodId).toBeNull()
    expect(source.sourceAsOf).toBe(NOW_ISO)
  })

  it('finds nothing written after the lock in a month closed and left alone', async () => {
    expect(await journalRowsWrittenAfter(sql, closedMonth, lockedAt)).toBe(0)
  })

  it('counts every line as late against a stale instant — the control', async () => {
    // Without this the case above is satisfied by a query that counts nothing, which is the same green
    // tick over a different defect. A closed period refuses a posting (ZL002), so the only way to have a
    // late row is to read at an earlier instant — which is exactly what a reopened period would look like.
    expect(await journalRowsWrittenAfter(sql, closedMonth, STALE_INSTANT)).toBe(MONTH_LINES)
  })
})

describe('the ledger a statement reads cannot be edited', () => {
  it('refuses an UPDATE on journal_line with ZL001', async () => {
    const failure = await sql`
      update journal_line set memo = 'edited' where entry_id = ${saleEntryId}
    `.catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toBe('ZL001')
  })

  it('refuses a DELETE on journal_line with ZL001', async () => {
    const failure = await sql`
      delete from journal_line where entry_id = ${saleEntryId}
    `.catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toBe('ZL001')
  })

  it('and the rows are still there — the control for both refusals', async () => {
    const rows = await statementDrillDown(sql, {
      accountCodes: [CASH_IN_DRAWER, TREATMENT_REVENUE, OUTPUT_VAT],
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    const sale = rows.filter((row) => row.entryId === saleEntryId)
    expect(sale).toHaveLength(3)
    expect(sale.every((row) => row.memo === null)).toBe(true)
  })
})

describe('the dated reversal', () => {
  it('lands in the period of its own date, not the period it corrects', async () => {
    expect(correctionDate > closedMonth.endsOn).toBe(true)
    expect(correctionDate >= openMonth.startsOn).toBe(true)
    expect(correctionDate <= openMonth.endsOn).toBe(true)
  })

  it('leaves the closed month’s census exactly as it was filed', async () => {
    const census = await statementLedgerCensus(sql, {
      fromInclusive: closedMonth.startsOn,
      toInclusive: closedMonth.endsOn,
    })
    expect(census.lineCount).toBe(MONTH_LINES)
    expect(census.debitFils).toBe(MONTH_DEBITS)
    expect(await journalRowsWrittenAfter(sql, closedMonth, lockedAt)).toBe(0)
  })

  it('puts the reversal in the open month, where it can be seen', async () => {
    const census = await statementLedgerCensus(sql, {
      fromInclusive: openMonth.startsOn,
      toInclusive: openMonth.endsOn,
    })
    expect(census.lineCount).toBe(3)
    expect(census.debitFils).toBe(BigInt(SALE_GROSS))
  })
})

describe('the canonical bytes', () => {
  it('are stable for the same value and sort keys, so two runs compare', () => {
    const one = { b: 2n, a: [1n, { d: 4, c: undefined }] }
    const two = { a: [1n, { c: undefined, d: 4 }], b: 2n }
    expect(statementBytes(one)).toBe(statementBytes(two))
    expect(statementBytes(one)).toBe('{"a":["1",{"d":4}],"b":"2"}')
    expect(statementContentHash(one)).toBe(statementContentHash(two))
    expect(statementContentHash(one)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('change when a figure changes by one fil', () => {
    expect(statementBytes({ a: 1n })).not.toBe(statementBytes({ a: 2n }))
    expect(statementContentHash({ a: 1n })).not.toBe(statementContentHash({ a: 2n }))
  })
})

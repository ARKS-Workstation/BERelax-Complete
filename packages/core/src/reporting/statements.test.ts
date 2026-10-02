import { describe, expect, it } from 'vitest'
import type { AccountCode } from '../ledger/account.ts'
import { accountCode } from '../ledger/account.ts'
import type { ChartOfAccounts } from '../ledger/chart-of-accounts.ts'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { localDate } from '../time.ts'
import type {
  AccountFigure,
  FinancialStatementsInput,
  LedgerCensus,
  StatementLayout,
  StatementLineSpec,
} from './statements.ts'
import {
  articulation,
  assertStatementLayout,
  balanceSheet,
  buildFinancialStatements,
  cashFlow,
  directedTotalFils,
  drillableLines,
  linesOf,
  movementBetween,
  profitAndLoss,
  STANDARD_SPA_STATEMENT_LAYOUT,
  STATEMENT_FORMAT_VERSION,
  STATEMENT_LAYOUT_RULES,
  statementLayoutFindings,
  statementLayoutFor,
  UnknownStatementLayout,
} from './statements.ts'

/**
 * R-REP-02 — the three statements, as pure arithmetic over a ledger.
 *
 * # What each half of this file is for
 *
 * **The layout rules.** Eight named rules, each handed a layout that DOES violate it. That direction is
 * the one that matters: a rule which stops matching reports no findings, and "the shipped layout is sound"
 * then passes over a layout that has stopped being one (ADR 0003). The shipped layout passing is the
 * control, and it is asserted first so a broken chart is not mistaken for a broken rule.
 *
 * **The identities.** The balance sheet balancing is NOT evidence that the sections are right, and this
 * file proves that rather than asserting it: `the identity cannot see a liability filed under assets`
 * swaps two lines' sections, finds the sheet still balances to zero, and requires the direction rule to be
 * what catches it. Without that case, "the balance sheet balances" is the vacuous check the whole unit is
 * arranged to avoid.
 *
 * # The generator, and why it counts what it generated
 *
 * The properties are over random BALANCED ledgers, because an unbalanced one is unrepresentable: the
 * journal's deferred constraint trigger refuses an entry whose debits and credits disagree, so a generator
 * that could produce one would be testing a state the database cannot hold. Entries are therefore built
 * as a debit and a credit of the same amount on two different accounts.
 *
 * Brief rule 22: a generator has to be able to exercise the claim and the test has to count that. A
 * ledger whose period movement nets to zero on every revenue and expense account would satisfy the
 * articulation identity for a completely broken implementation, so the generator draws its pairs from
 * WEIGHTED pools — one account from the revenue/expense side, one from the balance-sheet side, most of the
 * time — and {@link countsThatCouldDisagree} counts how many generated ledgers actually have a non-zero
 * net profit and a non-zero cash movement. The floors below are the observed minimum less a margin.
 *
 * There is no `Math.random` anywhere here: `scripts/check-core-purity.mjs` bans it under
 * `packages/core/src/`, tests included, and a seeded generator is what makes a failing case reproducible
 * from its seed rather than from a screenshot.
 */

const CHART = STANDARD_SPA_CHART
const LAYOUT = STANDARD_SPA_STATEMENT_LAYOUT

const PERIOD = {
  periodId: 'RREP02-TEST-2250-04',
  startsOn: localDate('2250-04-01'),
  endsOn: localDate('2250-04-30'),
} as const
const OPENING_AS_AT = localDate('2250-03-31')

/** A 32-bit linear congruential generator. Reproducible from its seed, and not a clock read. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

const REVENUE_AND_EXPENSE = CHART.accounts
  .filter((account) => account.type === 'revenue' || account.type === 'expense')
  .map((account) => account.code as string)
const BALANCE_SHEET_SIDE = CHART.accounts
  .filter((account) => !REVENUE_AND_EXPENSE.includes(account.code as string))
  .map((account) => account.code as string)

interface GeneratedLedger {
  readonly opening: readonly AccountFigure[]
  readonly closing: readonly AccountFigure[]
  readonly positionCensus: LedgerCensus
  readonly movementCensus: LedgerCensus
}

/** Accumulates debits and credits per account, so a figure set is the sum of the entries that made it. */
class Book {
  private readonly rows = new Map<string, { debit: bigint; credit: bigint }>()
  lineCount = 0
  debitFils = 0n
  creditFils = 0n

  post(code: string, debit: bigint, credit: bigint): void {
    const row = this.rows.get(code) ?? { debit: 0n, credit: 0n }
    row.debit += debit
    row.credit += credit
    this.rows.set(code, row)
    this.lineCount += 1
    this.debitFils += debit
    this.creditFils += credit
  }

  merge(other: Book): void {
    for (const [code, row] of other.rows) this.post(code, row.debit, row.credit)
    // `post` already added the counts row by row, so nothing else is carried across.
  }

  figures(): readonly AccountFigure[] {
    return [...this.rows.entries()]
      .map(([accountCode, row]) => ({
        accountCode,
        debitFils: row.debit,
        creditFils: row.credit,
      }))
      .sort((a, b) => (a.accountCode < b.accountCode ? -1 : 1))
  }

  census(): LedgerCensus {
    return {
      lineCount: this.lineCount,
      debitFils: this.debitFils,
      creditFils: this.creditFils,
      accountCodes: [...this.rows.keys()].sort(),
    }
  }
}

/**
 * A random balanced ledger split into "before the period" and "inside it".
 *
 * `crossSided` is the weighting brief rule 22 asks for: a pair drawn from the revenue/expense pool and the
 * balance-sheet pool moves the net profit AND the cash or working capital, which is what the articulation
 * and cash-flow identities are about. Drawing both ends uniformly from all 62 accounts puts most of the
 * movement inside one side of the sheet, where every identity holds trivially.
 */
function generateLedger(rnd: () => number, entries: number): GeneratedLedger {
  const before = new Book()
  const during = new Book()
  for (let at = 0; at < entries; at += 1) {
    const crossSided = rnd() < 0.8
    const pool = crossSided ? REVENUE_AND_EXPENSE : BALANCE_SHEET_SIDE
    const other = BALANCE_SHEET_SIDE
    const debitCode = pool[Math.floor(rnd() * pool.length)] as string
    let creditCode = other[Math.floor(rnd() * other.length)] as string
    if (creditCode === debitCode) {
      creditCode = other[(other.indexOf(creditCode) + 1) % other.length] as string
    }
    const amount = BigInt(1 + Math.floor(rnd() * 1_000_000))
    const book = rnd() < 0.35 ? before : during
    book.post(debitCode, amount, 0n)
    book.post(creditCode, 0n, amount)
  }
  const cumulative = new Book()
  cumulative.merge(before)
  const closing = new Book()
  closing.merge(before)
  closing.merge(during)
  return {
    opening: cumulative.figures(),
    closing: closing.figures(),
    positionCensus: closing.census(),
    movementCensus: during.census(),
  }
}

const inputFor = (ledger: GeneratedLedger, overrides: Partial<FinancialStatementsInput> = {}) =>
  ({
    chart: CHART,
    layout: LAYOUT,
    period: PERIOD,
    openingAsAt: OPENING_AS_AT,
    openingPosition: ledger.opening,
    closingPosition: ledger.closing,
    sourceAsOf: '2250-05-02T06:00:00.000Z',
    lockedPeriodId: PERIOD.periodId,
    rowsWrittenAfterTheSourceInstant: 0,
    positionCensus: ledger.positionCensus,
    movementCensus: ledger.movementCensus,
    ...overrides,
  }) satisfies FinancialStatementsInput

/** A hand-built ledger, so one worked example sits beside the random ones. */
function handBuilt(): GeneratedLedger {
  const before = new Book()
  // The opening position: 500,000 fils of capital introduced, held in the bank.
  before.post(ACCOUNTS.bankCurrent as string, 500_000n, 0n)
  before.post(ACCOUNTS.ownersCapital as string, 0n, 500_000n)
  const during = new Book()
  // A cash sale of 21,000 gross: 20,000 revenue and 1,000 output VAT.
  during.post(ACCOUNTS.cashInDrawer as string, 21_000n, 0n)
  during.post(ACCOUNTS.treatmentRevenue as string, 0n, 20_000n)
  during.post(ACCOUNTS.outputVatPayable as string, 0n, 1_000n)
  // Rent of 60,000 paid from the bank.
  during.post(ACCOUNTS.rent as string, 60_000n, 0n)
  during.post(ACCOUNTS.bankCurrent as string, 0n, 60_000n)
  // A 100,000 equipment purchase from the bank: investing, not operating.
  during.post(ACCOUNTS.equipment as string, 100_000n, 0n)
  during.post(ACCOUNTS.bankCurrent as string, 0n, 100_000n)
  // 5,000 of depreciation: an expense with no cash behind it.
  during.post(ACCOUNTS.depreciation as string, 5_000n, 0n)
  during.post(ACCOUNTS.accumulatedDepreciation as string, 0n, 5_000n)
  // 30,000 of drawings, paid in cash.
  during.post(ACCOUNTS.ownersDrawings as string, 30_000n, 0n)
  during.post(ACCOUNTS.cashInDrawer as string, 0n, 30_000n)
  const opening = new Book()
  opening.merge(before)
  const closing = new Book()
  closing.merge(before)
  closing.merge(during)
  return {
    opening: opening.figures(),
    closing: closing.figures(),
    positionCensus: closing.census(),
    movementCensus: during.census(),
  }
}

/** A layout with one line replaced, for the rule cases. */
const withLine = (layout: StatementLayout, lineId: string, patch: Partial<StatementLineSpec>) => ({
  ...layout,
  lines: layout.lines.map((spec) => (spec.lineId === lineId ? { ...spec, ...patch } : spec)),
})

const rulesFired = (chart: ChartOfAccounts, layout: StatementLayout): readonly string[] =>
  statementLayoutFindings(chart, layout).map((finding) => finding.rule)

/**
 * Requires a named rule, with both the rule and what DID fire spelled out in the message.
 *
 * The message is not decoration. `scripts/test-gates.mjs` block 142 blinds each detector in turn and
 * requires the rule's own name in the output (ADR 0003), and vitest TRUNCATES a long expected value in its
 * default diff — `'statement-line-ids-are-unique-within-…'` — so four of those cases reported FAIL against a
 * gate that was firing correctly. A custom message is printed whole.
 */
const expectRuleFires = (
  chart: ChartOfAccounts,
  layout: StatementLayout,
  rule: (typeof STATEMENT_LAYOUT_RULES)[number],
): void => {
  const fired = rulesFired(chart, layout)
  expect(
    fired,
    `the layout rule ${rule} did not fire; what fired was [${fired.join(', ')}]`,
  ).toContain(rule)
}

describe('the statement layout', () => {
  it('is sound for the chart it was written for — the control for every case below', () => {
    expect(statementLayoutFindings(CHART, LAYOUT)).toEqual([])
    expect(() => assertStatementLayout(CHART, LAYOUT)).not.toThrow()
  })

  it('covers the whole chart on the balance sheet and nothing beyond it', () => {
    const claimed = linesOf(LAYOUT, 'balance_sheet').flatMap((spec) => spec.accountCodes)
    expect(new Set(claimed).size).toBe(claimed.length)
    expect([...claimed].sort()).toEqual(CHART.accounts.map((account) => account.code).sort())
  })

  it('has a layout only for the chart it was written for', () => {
    expect(statementLayoutFor(CHART)).toBe(LAYOUT)
    const other: ChartOfAccounts = { ...CHART, id: 'the-accountants-chart' }
    expect(() => statementLayoutFor(other)).toThrow(UnknownStatementLayout)
    try {
      statementLayoutFor(other)
    } catch (error) {
      expect((error as Error).message).toContain('Y8-coa')
    }
  })

  it('names the open question the grouping stands in for', () => {
    expect(LAYOUT.provisional?.openQuestionId).toBe('Y8-coa')
  })

  it('declares every rule it can report exactly once', () => {
    expect(new Set(STATEMENT_LAYOUT_RULES).size).toBe(STATEMENT_LAYOUT_RULES.length)
  })

  // --- one case per rule, each handed a layout that violates it -------------------------------

  it('fires when the balance sheet drops an account from the chart', () => {
    const broken = withLine(LAYOUT, 'tips_payable', { accountCodes: [] })
    expectRuleFires(CHART, broken, 'balance-sheet-claims-every-account-in-the-chart-exactly-once')
  })

  it('fires when the balance sheet claims one account twice', () => {
    const broken = withLine(LAYOUT, 'tips_payable', {
      accountCodes: [ACCOUNTS.tipsPayable, ACCOUNTS.refundsPayable],
    })
    expectRuleFires(CHART, broken, 'balance-sheet-claims-every-account-in-the-chart-exactly-once')
  })

  it('fires when the balance sheet claims a code the chart does not have', () => {
    const ghost = accountCode('9999')
    const broken = withLine(LAYOUT, 'tips_payable', {
      accountCodes: [ACCOUNTS.tipsPayable, ghost],
    })
    expectRuleFires(CHART, broken, 'balance-sheet-claims-every-account-in-the-chart-exactly-once')
    // And the type rule too, because a code the chart lacks has no type to check a direction against.
    expectRuleFires(CHART, broken, 'statement-line-claims-accounts-of-one-type')
  })

  it('fires when the profit and loss account drops an expense account', () => {
    const broken = withLine(LAYOUT, 'professional_fees', { accountCodes: [] })
    expectRuleFires(
      CHART,
      broken,
      'profit-and-loss-claims-every-revenue-and-expense-account-exactly-once',
    )
  })

  it('fires when the profit and loss account claims a balance-sheet account', () => {
    const broken = withLine(LAYOUT, 'professional_fees', {
      accountCodes: [ACCOUNTS.professionalFees, ACCOUNTS.bankCurrent],
    })
    expectRuleFires(
      CHART,
      broken,
      'profit-and-loss-claims-every-revenue-and-expense-account-exactly-once',
    )
  })

  it('fires when the cash flow drops a non-cash account', () => {
    const broken = withLine(LAYOUT, 'movement_in_tips_payable', { accountCodes: [] })
    expectRuleFires(CHART, broken, 'cash-flow-claims-every-non-cash-account-exactly-once')
  })

  it('fires when the cash flow claims a cash account, so its movement is not the movement in cash', () => {
    const broken = withLine(LAYOUT, 'movement_in_tips_payable', {
      accountCodes: [ACCOUNTS.tipsPayable, ACCOUNTS.cashInDrawer],
    })
    expectRuleFires(CHART, broken, 'cash-flow-claims-every-non-cash-account-exactly-once')
  })

  it('fires when a line claims accounts of two different types', () => {
    const broken = withLine(LAYOUT, 'tips_payable', {
      accountCodes: [ACCOUNTS.tipsPayable, ACCOUNTS.treatmentRevenue],
    })
    expectRuleFires(CHART, broken, 'statement-line-claims-accounts-of-one-type')
  })

  it('fires when a line is read on the wrong side for its declared sense', () => {
    const broken = withLine(LAYOUT, 'tips_payable', { direction: 'debit_less_credit' })
    expectRuleFires(CHART, broken, 'statement-line-direction-matches-its-declared-sense')
  })

  it('fires when a line declares the sense that does not match its direction', () => {
    // The mirror of the case above, and not a duplicate of it: the direction is right for the accounts
    // and the DECLARATION is wrong, which is the form the mistake takes when somebody copies a
    // cash-flow line into the balance sheet.
    const broken = withLine(LAYOUT, 'tips_payable', { sense: 'inverted' })
    expectRuleFires(CHART, broken, 'statement-line-direction-matches-its-declared-sense')
  })

  it('fires when the two statements of the cash-account set disagree', () => {
    const broken: StatementLayout = {
      ...LAYOUT,
      cashAccountCodes: [ACCOUNTS.cashInDrawer, ACCOUNTS.pettyCash],
    }
    expectRuleFires(CHART, broken, 'cash-flow-cash-accounts-are-the-balance-sheet-cash-line')
  })

  it('fires when a line claims no account at all', () => {
    const broken = {
      ...LAYOUT,
      lines: [
        ...LAYOUT.lines,
        {
          lineId: 'a_line_with_nothing_behind_it',
          label: 'Nothing',
          statement: 'profit_and_loss' as const,
          section: 'revenue',
          direction: 'credit_less_debit' as const,
          sense: 'natural' as const,
          accountCodes: [] as readonly AccountCode[],
        },
      ],
    }
    expectRuleFires(CHART, broken, 'statement-line-claims-at-least-one-account')
  })

  it('fires when a statement repeats a line id', () => {
    const duplicate = LAYOUT.lines.find(
      (spec) => spec.lineId === 'tips_payable',
    ) as StatementLineSpec
    const broken = { ...LAYOUT, lines: [...LAYOUT.lines, { ...duplicate, accountCodes: [] }] }
    expectRuleFires(CHART, broken, 'statement-line-ids-are-unique-within-a-statement')
  })

  it('refuses to build statements over an unsound layout, naming every rule that fired', () => {
    const broken = withLine(LAYOUT, 'tips_payable', { accountCodes: [] })
    expect(() => buildFinancialStatements(inputFor(handBuilt(), { layout: broken }))).toThrow(
      /balance-sheet-claims-every-account-in-the-chart-exactly-once/,
    )
  })
})

describe('the worked example', () => {
  const statements = buildFinancialStatements(inputFor(handBuilt()))

  it('carries the format version and both provisional markers', () => {
    expect(statements.formatVersion).toBe(STATEMENT_FORMAT_VERSION)
    // TWO markers against ONE open question, which is not a duplicate: Y8-coa asks for the existing chart
    // AND what the accountant expects monthly, and those are two different provisional things — the chart's
    // classification and this layout's grouping of it. The notes say which is which, so a reader of the
    // Unconfirmed Assumptions panel sees both rather than one standing in for the other.
    expect(statements.provisional.map((marker) => marker.openQuestionId)).toEqual([
      'Y8-coa',
      'Y8-coa',
    ])
    expect(new Set(statements.provisional.map((marker) => marker.note)).size).toBe(2)
    expect(statements.provisional[0]?.note).toContain('statement layout')
    expect(statements.provisional[1]?.note).toContain('Standard UAE spa chart')
  })

  it('reports the profit and loss to the fil', () => {
    // revenue 20,000; rent 60,000 and depreciation 5,000 of cost.
    expect(statements.profitAndLoss.totalRevenueFils).toBe(20_000n)
    expect(statements.profitAndLoss.totalExpensesFils).toBe(65_000n)
    expect(statements.profitAndLoss.netProfitFils).toBe(-45_000n)
  })

  it('shows accumulated depreciation as a deduction rather than as an asset', () => {
    const line = statements.closingBalanceSheet.lines.find(
      (entry) => entry.lineId === 'accumulated_depreciation',
    )
    expect(line?.fils).toBe(-5_000n)
  })

  it('balances at the opening and the closing date', () => {
    expect(statements.openingBalanceSheet.differenceFils).toBe(0n)
    expect(statements.closingBalanceSheet.differenceFils).toBe(0n)
  })

  it('articulates: the movement in retained earnings IS the net profit', () => {
    expect(statements.articulation.directEquityPostingsFils).toBe(0n)
    expect(statements.articulation.movementFils).toBe(statements.profitAndLoss.netProfitFils)
    expect(statements.articulation.differenceFils).toBe(0n)
  })

  it('reports the cash flow with depreciation added back and the equipment as investing', () => {
    const line = (id: string) =>
      statements.cashFlow.lines.find((entry) => entry.lineId === id)?.fils
    expect(line('depreciation_charged_in_the_period')).toBe(5_000n)
    expect(line('purchase_of_equipment')).toBe(-100_000n)
    expect(line('owners_drawings_paid')).toBe(-30_000n)
    expect(statements.cashFlow.investingFils).toBe(-100_000n)
    expect(statements.cashFlow.financingFils).toBe(-30_000n)
    // Operating: -45,000 of loss, +5,000 of depreciation added back, +1,000 of VAT still owed.
    expect(statements.cashFlow.operatingFils).toBe(-39_000n)
    expect(statements.cashFlow.netMovementInCashFils).toBe(-169_000n)
    expect(statements.cashFlow.openingCashFils).toBe(500_000n)
    expect(statements.cashFlow.closingCashFils).toBe(331_000n)
  })

  it('ties closing cash to the cash and bank accounts’ own position', () => {
    // 500,000 - 60,000 - 100,000 in the bank, 21,000 - 30,000 in the drawer.
    expect(statements.cashFlow.ledgerCashFils).toBe(331_000n)
    expect(statements.cashFlow.differenceFils).toBe(0n)
  })

  it('holds the cash flow’s opening lines equal to the profit and loss net profit', () => {
    const identity = statements.identities.find(
      (entry) => entry.identityId === 'cash_flow_operating_opens_with_the_p_and_l_net_profit',
    )
    expect(identity?.differenceFils).toBe(0n)
  })

  it('reports every identity at zero and is publishable', () => {
    expect(statements.identities.filter((entry) => entry.differenceFils !== 0n)).toEqual([])
    expect(statements.notReproducibleReasons).toEqual([])
  })

  it('accounts for every fil in both windows', () => {
    for (const coverage of statements.coverage) {
      expect(coverage.unclaimedAccountCodes).toEqual([])
      expect(coverage.differenceFils).toBe(0n)
      expect(coverage.lineCount).toBeGreaterThan(0)
    }
  })

  it('enumerates every line of all three statements for the drill-down, the sheet twice', () => {
    const rows = drillableLines(statements)
    expect(rows.filter((row) => row.statement === 'profit_and_loss')).toHaveLength(
      statements.profitAndLoss.lines.length,
    )
    expect(rows.filter((row) => row.statement === 'cash_flow')).toHaveLength(
      statements.cashFlow.lines.length,
    )
    // Opening and closing: a position line is read at a date, and there are two dates.
    expect(rows.filter((row) => row.statement === 'balance_sheet')).toHaveLength(
      statements.closingBalanceSheet.lines.length * 2,
    )
    expect(
      rows.filter((row) => row.window === 'position').every((row) => row.fromInclusive === null),
    ).toBe(true)
    expect(
      rows
        .filter((row) => row.window === 'movement')
        .every((row) => row.fromInclusive === PERIOD.startsOn),
    ).toBe(true)
    expect(rows.every((row) => row.line.accountCodes.length > 0)).toBe(true)
  })

  it('produces an identical set from identical arguments', () => {
    expect(buildFinancialStatements(inputFor(handBuilt()))).toEqual(statements)
  })
})

describe('what the balance identity cannot see', () => {
  /*
    The case this whole unit is arranged around. `assets - (liabilities + equity) = 0` holds for ANY total,
    disjoint partition of the chart whose per-section signs are consistent — so filing a liability under
    assets leaves it at zero, because the account leaves one side and joins the other with its sign already
    flipped by the section's own direction. The identity is a check on the PARTITION and on nothing else.
  */
  const misfiled: StatementLayout = {
    ...LAYOUT,
    lines: LAYOUT.lines.map((spec) =>
      spec.lineId === 'tips_payable' && spec.statement === 'balance_sheet'
        ? { ...spec, section: 'assets', direction: 'debit_less_credit' as const }
        : spec,
    ),
  }

  const ledger = (() => {
    const book = new Book()
    book.post(ACCOUNTS.cashInDrawer as string, 50_000n, 0n)
    book.post(ACCOUNTS.tipsPayable as string, 0n, 50_000n)
    const empty = new Book()
    return {
      opening: empty.figures(),
      closing: book.figures(),
      positionCensus: book.census(),
      movementCensus: book.census(),
    }
  })()

  it('still balances with a liability filed under assets', () => {
    const sheet = balanceSheet(misfiled, ledger.closing, PERIOD.endsOn)
    expect(sheet.differenceFils).toBe(0n)
    // And it is genuinely misstated: assets read 0 rather than 50,000, tips having cancelled the cash.
    expect(sheet.totalAssetsFils).toBe(0n)
    expect(sheet.totalLiabilitiesFils).toBe(0n)
  })

  it('and the direction rule is what catches it', () => {
    expectRuleFires(CHART, misfiled, 'statement-line-direction-matches-its-declared-sense')
  })
})

describe('the coverage census', () => {
  it('names an account posted to that no statement line claims', () => {
    const ledger = handBuilt()
    const withAGhost: LedgerCensus = {
      ...ledger.positionCensus,
      accountCodes: [...ledger.positionCensus.accountCodes, '9999'].sort(),
    }
    const statements = buildFinancialStatements(inputFor(ledger, { positionCensus: withAGhost }))
    const position = statements.coverage.find((entry) => entry.window === 'position')
    expect(position?.unclaimedAccountCodes).toEqual(['9999'])
    expect(statements.notReproducibleReasons.join(' ')).toContain(
      'every_account_posted_in_the_position_window_is_claimed_by_a_line',
    )
  })

  it('reports a difference when the ledger holds fils the lines do not claim', () => {
    const ledger = handBuilt()
    const short: LedgerCensus = {
      ...ledger.movementCensus,
      debitFils: ledger.movementCensus.debitFils + 1n,
      creditFils: ledger.movementCensus.creditFils + 1n,
    }
    const statements = buildFinancialStatements(inputFor(ledger, { movementCensus: short }))
    const movement = statements.coverage.find((entry) => entry.window === 'movement')
    expect(movement?.differenceFils).toBe(-2n)
    expect(statements.notReproducibleReasons.join(' ')).toContain(
      'the_movement_window_is_accounted_for_to_the_fil',
    )
  })
})

describe('reproducibility', () => {
  const ledger = handBuilt()

  it('refuses an open period, naming it', () => {
    const statements = buildFinancialStatements(inputFor(ledger, { lockedPeriodId: null }))
    expect(statements.notReproducibleReasons[0]).toContain('is not closed')
  })

  it('refuses a period posted into after the instant it was read at', () => {
    const statements = buildFinancialStatements(
      inputFor(ledger, { rowsWrittenAfterTheSourceInstant: 3 }),
    )
    expect(statements.notReproducibleReasons.join(' ')).toContain('3 journal line(s)')
    expect(statements.notReproducibleReasons.join(' ')).toContain('re-closed, not re-reported')
  })

  it('does not change a figure when a different instant is passed for a closed period', () => {
    const one = buildFinancialStatements(
      inputFor(ledger, { sourceAsOf: '2251-01-01T00:00:00.000Z' }),
    )
    const two = buildFinancialStatements(
      inputFor(ledger, { sourceAsOf: '2299-01-01T00:00:00.000Z' }),
    )
    expect(one.closingBalanceSheet).toEqual(two.closingBalanceSheet)
    expect(one.profitAndLoss).toEqual(two.profitAndLoss)
    expect(one.cashFlow).toEqual(two.cashFlow)
  })
})

describe('the arithmetic', () => {
  it('reads a direction as a subtraction and never as a magnitude', () => {
    expect(directedTotalFils('debit_less_credit', 10n, 4n)).toBe(6n)
    expect(directedTotalFils('debit_less_credit', 4n, 10n)).toBe(-6n)
    expect(directedTotalFils('credit_less_debit', 4n, 10n)).toBe(6n)
    expect(directedTotalFils('credit_less_debit', 10n, 4n)).toBe(-6n)
  })

  it('reports a movement for an account that had a position and then stopped moving', () => {
    const opening: readonly AccountFigure[] = [
      { accountCode: '1010', debitFils: 100n, creditFils: 0n },
    ]
    const closing: readonly AccountFigure[] = [
      { accountCode: '1020', debitFils: 7n, creditFils: 0n },
    ]
    expect(movementBetween(opening, closing)).toEqual([
      { accountCode: '1010', debitFils: -100n, creditFils: 0n },
      { accountCode: '1020', debitFils: 7n, creditFils: 0n },
    ])
  })

  it('counts how many of a line’s claimed accounts had any figure', () => {
    const pnl = profitAndLoss(
      LAYOUT,
      [{ accountCode: ACCOUNTS.rent as string, debitFils: 5n, creditFils: 0n }],
      { from: PERIOD.startsOn, to: PERIOD.endsOn },
    )
    const premises = pnl.lines.find((line) => line.lineId === 'premises_costs')
    expect(premises?.accountsWithFigures).toBe(1)
    expect(premises?.fils).toBe(5n)
  })

  it('reports a non-zero cash difference when the cash set stops matching the layout', () => {
    // `cashFlow` is called directly, because `buildFinancialStatements` would refuse this layout at the
    // door — which is the right order, and it is also why this case exists: the identity has to be able
    // to fail for the reason it is about, not only to be unreachable.
    const ledger = handBuilt()
    const tampered: StatementLayout = { ...LAYOUT, cashAccountCodes: [ACCOUNTS.cashInDrawer] }
    const flow = cashFlow(tampered, {
      movement: movementBetween(ledger.opening, ledger.closing),
      openingPosition: ledger.opening,
      closingPosition: ledger.closing,
      from: PERIOD.startsOn,
      to: PERIOD.endsOn,
    })
    expect(flow.differenceFils).not.toBe(0n)
  })

  it('reports a posting straight to retained earnings without calling it an error', () => {
    const before = new Book()
    before.post(ACCOUNTS.cashInDrawer as string, 100_000n, 0n)
    before.post(ACCOUNTS.treatmentRevenue as string, 0n, 100_000n)
    const during = new Book()
    // A closing entry: revenue swept into retained earnings. Nothing in the build posts one; the
    // articulation still has to be exact when somebody does it in psql.
    during.post(ACCOUNTS.treatmentRevenue as string, 100_000n, 0n)
    during.post(ACCOUNTS.retainedEarnings as string, 0n, 100_000n)
    const opening = new Book()
    opening.merge(before)
    const closing = new Book()
    closing.merge(before)
    closing.merge(during)
    const ledger: GeneratedLedger = {
      opening: opening.figures(),
      closing: closing.figures(),
      positionCensus: closing.census(),
      movementCensus: during.census(),
    }
    const statements = buildFinancialStatements(inputFor(ledger))
    expect(statements.profitAndLoss.netProfitFils).toBe(-100_000n)
    expect(statements.articulation.directEquityPostingsFils).toBe(100_000n)
    // The movement is zero: the sweep moved the earnings between two lines of the same section.
    expect(statements.articulation.movementFils).toBe(0n)
    expect(statements.articulation.differenceFils).toBe(0n)
    expect(statements.notReproducibleReasons).toEqual([])
  })

  it('articulates from the two sheets directly as well as through the builder', () => {
    const ledger = handBuilt()
    const movement = movementBetween(ledger.opening, ledger.closing)
    const window = { from: PERIOD.startsOn, to: PERIOD.endsOn }
    const pnl = profitAndLoss(LAYOUT, movement, window)
    const flow = cashFlow(LAYOUT, {
      movement,
      openingPosition: ledger.opening,
      closingPosition: ledger.closing,
      ...window,
    })
    const result = articulation(
      balanceSheet(LAYOUT, ledger.opening, OPENING_AS_AT),
      balanceSheet(LAYOUT, ledger.closing, PERIOD.endsOn),
      pnl,
      flow,
    )
    expect(result.differenceFils).toBe(0n)
    expect(result.openingRetainedEarningsFils).toBe(0n)
    expect(result.closingRetainedEarningsFils).toBe(-45_000n)
  })

  it('falls back to zero direct postings when the cash flow has no retained-earnings line', () => {
    const ledger = handBuilt()
    const movement = movementBetween(ledger.opening, ledger.closing)
    const window = { from: PERIOD.startsOn, to: PERIOD.endsOn }
    const withoutTheLine: StatementLayout = {
      ...LAYOUT,
      lines: LAYOUT.lines.filter((spec) => spec.lineId !== 'postings_to_retained_earnings'),
    }
    const flow = cashFlow(withoutTheLine, {
      movement,
      openingPosition: ledger.opening,
      closingPosition: ledger.closing,
      ...window,
    })
    const result = articulation(
      balanceSheet(LAYOUT, ledger.opening, OPENING_AS_AT),
      balanceSheet(LAYOUT, ledger.closing, PERIOD.endsOn),
      profitAndLoss(LAYOUT, movement, window),
      flow,
    )
    expect(result.directEquityPostingsFils).toBe(0n)
  })
})

/** How many of the generated ledgers could actually have disagreed. Brief rule 22. */
interface DisagreementCensus {
  readonly cases: number
  readonly withProfitMovement: number
  readonly withCashMovement: number
  readonly withOpeningPosition: number
}

function countsThatCouldDisagree(seed: number, cases: number, entries: number): DisagreementCensus {
  const rnd = seeded(seed)
  let withProfitMovement = 0
  let withCashMovement = 0
  let withOpeningPosition = 0
  for (let at = 0; at < cases; at += 1) {
    const ledger = generateLedger(rnd, entries)
    const statements = buildFinancialStatements(inputFor(ledger))
    if (statements.profitAndLoss.netProfitFils !== 0n) withProfitMovement += 1
    if (statements.cashFlow.netMovementInCashFils !== 0n) withCashMovement += 1
    if (statements.openingBalanceSheet.totalAssetsFils !== 0n) withOpeningPosition += 1
  }
  return { cases, withProfitMovement, withCashMovement, withOpeningPosition }
}

describe('the identities, over random balanced ledgers', () => {
  const CASES = 200
  const ENTRIES = 24

  it('holds every identity at zero for every generated ledger', () => {
    const rnd = seeded(20260929)
    for (let at = 0; at < CASES; at += 1) {
      const ledger = generateLedger(rnd, ENTRIES)
      const statements = buildFinancialStatements(inputFor(ledger))
      const broken = statements.identities.filter((entry) => entry.differenceFils !== 0n)
      expect(broken, `case ${at} of seed 20260929 broke an identity`).toEqual([])
      expect(statements.notReproducibleReasons, `case ${at}`).toEqual([])
    }
  }, 30_000)

  it('generated ledgers that could have disagreed, counted against a measured floor', () => {
    /*
      MEASURED, not reasoned about, and over forty seeds rather than one — a floor set just under the
      figure a single seed happens to give becomes its own flake, which is the failure brief rule 22
      records from the other side. Forty seeds of 200 cases at 24 entries gave minima of 200 ledgers with
      a non-zero net profit, 160 with a non-zero cash movement and 192 with a non-zero opening position.
      The floors sit below each minimum by enough margin that a fair draw cannot fail them, and far enough
      above zero that a generator which stopped producing cross-sided entries fails HERE rather than
      quietly turning the property above into an assertion about arithmetic on zeroes.
    */
    const census = countsThatCouldDisagree(987654321, CASES, ENTRIES)
    expect(census.cases).toBe(CASES)
    expect(census.withProfitMovement).toBeGreaterThan(180)
    expect(census.withCashMovement).toBeGreaterThan(140)
    expect(census.withOpeningPosition).toBeGreaterThan(170)
  }, 30_000)

  it('the control: dropping an account from the balance sheet is refused before any figure is read', () => {
    const rnd = seeded(13579)
    const ledger = generateLedger(rnd, ENTRIES)
    const broken = withLine(LAYOUT, 'cash_and_bank', {
      accountCodes: [ACCOUNTS.cashInDrawer, ACCOUNTS.pettyCash],
    })
    expect(() => buildFinancialStatements(inputFor(ledger, { layout: broken }))).toThrow(
      /balance-sheet-claims-every-account-in-the-chart-exactly-once/,
    )
  })

  it('the control: a sheet built from a partition missing an account does NOT balance', () => {
    // The same defect one layer down, where the refusal above is bypassed. Without this case, "the sheet
    // balances" could be true of an implementation that ignored the layout entirely.
    const rnd = seeded(24680)
    const ledger = generateLedger(rnd, ENTRIES)
    const partial: StatementLayout = {
      ...LAYOUT,
      lines: LAYOUT.lines.filter((spec) => spec.lineId !== 'staff_liabilities'),
    }
    const sheets = [
      balanceSheet(partial, ledger.closing, PERIOD.endsOn),
      balanceSheet(LAYOUT, ledger.closing, PERIOD.endsOn),
    ]
    expect(sheets[1]?.differenceFils).toBe(0n)
    expect(sheets[0]?.differenceFils).not.toBe(0n)
  })
})

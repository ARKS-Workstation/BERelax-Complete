import {
  ACCOUNTS,
  accountFor,
  deriveBill,
  entryId,
  filsFrom,
  localDate,
  money,
  reverseChargeForAccount,
  STANDARD_SPA_CHART,
  summariseVat201,
  type Vat201Attribution,
  type Vat201Line,
  vat201PartitionCensus,
  vat201SignedFils,
} from '@berelax/core'
import type { Actor, PostedBill, Sql } from '@berelax/db'
import {
  canonicaliseVat201WorkingPapers,
  closeAccountingPeriod,
  createConnection,
  currentPackageTemplateVersion,
  inputVatRecovery,
  postBill,
  postDatedCorrection,
  readJournalEntry,
  readPackageSale,
  recordSupplier,
  redeemPackage,
  savePackageTemplateVersion,
  sellPackage,
  unconfirmedAssumptionRows,
  vat201Boxes,
  vat201BoxForGrouping,
  vat201DrillDown,
  vat201MappingDisagreements,
  vat201PartitionCensus as vat201PartitionCensusSql,
  vat201UnboxedTotals,
  vat201UnrepresentableGroupings,
  vat201WorkingPapers,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { packageSaleMapping } from './package.ts'
import { packageRedemptionMapping } from './package-redemption.ts'
import { FIXTURE_SUPPLIERS } from './purchases.ts'
import { REVERSE_CHARGE_SUPPLIERS } from './reverse-charge.ts'
import {
  VAT201_CORRECTION_MONTH,
  VAT201_FIXTURE_BILLS,
  VAT201_FIXTURE_PACKAGE,
  VAT201_RESERVED_SPAN,
  VAT201_SALE_MONTH,
  VAT201_WORKED_EXAMPLE_BOXES,
  VAT201_WORKED_EXAMPLE_CENSUS,
  VAT201_WORKED_EXAMPLE_OUT_OF_SCOPE,
  VAT201_WORKED_EXAMPLE_UNALLOCATED,
} from './vat201.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-VAT-07 — the VAT201 box mapping, the return engine and the drill-down, against real PostgreSQL.
 *
 * It lives in `@berelax/fixtures` because it compares `@berelax/core`'s summation against the SQL one in
 * `0089_vat201_mapping.sql`, and fixtures is the one package allowed to depend on both: `db` may never
 * import `core`, so nothing compiles the two against each other and neither half's own suite can see the
 * mapping between them. The arrangement `package-redemption.itest.ts` and `period-close.itest.ts` already
 * use, for the same reason.
 *
 * What only this file can show:
 *
 *   1. **A box total equals the sum of its drill-down lines, exact to the fils.** Structurally, because
 *      `vat201_box_total()` aggregates over `vat201_box_line()`, and then MEASURED, by re-summing the
 *      drill-down in TypeScript `BigInt` — with a control that requires a one-fils error to be detected,
 *      because a structural guarantee nobody has watched fail is not evidence.
 *   2. **The mapping is data and not code.** One `update` of one row moves a figure to a different box,
 *      with a control proving it was in the first box beforehand and a second control proving the total
 *      across the boxes did not change, so a mapping edit that DOUBLED the line could not pass.
 *   3. **The exhaustive partition.** Every journal line in the period is attributed exactly once, counted
 *      in SQL and in core and compared, with the failing cases (a dropped line, a duplicated line, an
 *      unattributed one) each represented rather than assumed impossible.
 *   4. **Box to line to document, for every non-zero box**, including a dated reversal, whose entry has no
 *      document of its own and has to reach the one it corrects.
 *   5. **Y11-vat-package's provisional answer as two PERIOD movements**: a sale month whose output-VAT
 *      boxes are empty, and a redemption month that holds the tax. That is what a VAT return actually is
 *      and what no single entry's assertion can make.
 *
 * ## The window is picked, not fixed
 *
 * `journal_entry` and `journal_line` refuse DELETE for every role including the owner (ZL001), so nothing
 * here can be undone by this file. (DELETE, not TRUNCATE — `packages/db/src/repositories/journal.itest.ts`
 * truncates the journal in its `beforeAll` and a BEFORE DELETE row trigger cannot see that; see
 * `vat201.ts` for why it is safe in both orders.) A fixed month would DOUBLE every figure on a second run against the same database —
 * M-TILL-10's recorded defect (7), which reported 430,003 fils where 33,334 was expected, from its own
 * first run. So the suite finds a virgin three-month window inside {@link VAT201_RESERVED_SPAN}
 * (2150-01..2199-12, six hundred months that nothing else in this build posts into) and the committed
 * figures are absolute for whichever window it got. The span is that wide on purpose: gate block 116 runs
 * this suite once per mutant, so a span of a few years would be exhausted inside one `pnpm gates:only` and
 * the failure would arrive as "the fixture threw" in a case about something else. The period locks are removed in `afterAll` by `period_id` prefix so a later
 * run is not refused its own dates.
 */

const ACTOR: Actor = { kind: 'system', label: 'm-vat-07-itest' }
const RUN = Date.now().toString(36)
const PREFIX = 'MVAT07'
const codeFor = (code: string) => `${code}-mvat07-${RUN}`
const referenceFor = (reference: string) => `${reference}-${RUN}`

interface Month {
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  /** A day inside the month that everything in it is dated on. */
  readonly on: string
}

let sql: Sql
let saleMonth: Month
let returnMonth: Month
let correctionMonth: Month
const supplierIds = new Map<string, string>()
const bills = new Map<string, PostedBill>()
let rentEntryId = ''
let reversalEntry = ''

const monthAt = (year: number, month: number): Month => {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    periodId: `${PREFIX}-${year}-${mm}`,
    startsOn: `${year}-${mm}-01`,
    endsOn: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    on: `${year}-${mm}-20`,
  }
}

/**
 * Three consecutive months in the reserved span that no journal entry has ever been dated in.
 *
 * Derived from `max(entry_date)` rather than from the clock, so the choice is a function of the database
 * and two suites in one run cannot pick the same window. It throws rather than wrapping when the span runs
 * out, and the message says what to do: a silent wrap would land on a month that already holds a previous
 * run's entries, and every committed figure below would be double.
 */
async function virginWindow(): Promise<readonly [Month, Month, Month]> {
  const [row] = await sql<{ used: string | null }[]>`
    select max(entry_date)::text as used
    from journal_entry
    where entry_date between ${VAT201_RESERVED_SPAN.from}::date and ${VAT201_RESERVED_SPAN.to}::date
  `
  const used = row?.used ?? null
  const first =
    used === null
      ? {
          year: Number(VAT201_RESERVED_SPAN.from.slice(0, 4)),
          month: Number(VAT201_RESERVED_SPAN.from.slice(5, 7)),
        }
      : nextMonthAfter(used)
  const months = [0, 1, 2].map((offset) => {
    const zeroBased = first.month - 1 + offset
    return monthAt(first.year + Math.floor(zeroBased / 12), (zeroBased % 12) + 1)
  })
  const last = months[2] as Month
  if (last.endsOn > VAT201_RESERVED_SPAN.to) {
    throw new Error(
      `The VAT201 fixture needs three consecutive months with no journal entry in them, and the ` +
        `reserved span ${VAT201_RESERVED_SPAN.from}..${VAT201_RESERVED_SPAN.to} is used up to ${used}. ` +
        'The journal is append-only and refuses the owner, so the entries cannot be removed: run this ' +
        'suite against a fresh database, or widen VAT201_RESERVED_SPAN into a year no other suite posts ' +
        'into. Wrapping round would land on a month that already holds a previous run and every ' +
        'committed figure would read double.',
    )
  }
  return [months[0] as Month, months[1] as Month, months[2] as Month]
}

const nextMonthAfter = (isoDate: string) => {
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

const tradingDay = (day: string) => sql`
  insert into business_day (trading_date, opens_at, closes_at, source)
  values (
    ${day}::date,
    (${day}::date + time '11:00') at time zone 'Asia/Dubai',
    (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
    'weekly'
  )
  on conflict (trading_date) do nothing
`

const close = (month: Month) =>
  withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId: month.periodId,
      startsOn: month.startsOn,
      endsOn: month.endsOn,
      reason: 'M-VAT-07 fixture: the VAT201 working papers are produced against a closed period',
      closedByActorKind: 'system',
    }),
  )

/** The attributions as rows, mapped onto core's shape so the two summations can be compared. */
async function attributions(): Promise<readonly Vat201Attribution[]> {
  const rows = await sql<
    {
      account_code: string
      disposition: string
      box_no: number | null
      measure: string | null
      contribution: string | null
    }[]
  >`
    select account_code, disposition, box_no, measure, contribution
    from vat201_box_mapping order by account_code
  `
  return rows.map((row) => ({
    accountCode: row.account_code as Vat201Attribution['accountCode'],
    disposition: row.disposition as Vat201Attribution['disposition'],
    boxNo: row.box_no,
    measure: row.measure as Vat201Attribution['measure'],
    contribution: row.contribution as Vat201Attribution['contribution'],
  }))
}

const asCoreLines = (rows: readonly Awaited<ReturnType<typeof vat201DrillDown>>[number][]) =>
  rows.map(
    (row): Vat201Line => ({
      entryId: row.entryId,
      lineNo: row.lineNo,
      accountCode: row.accountCode as Vat201Line['accountCode'],
      debitFils: row.debitFils,
      creditFils: row.creditFils,
    }),
  )

/** The box number a grouping's column lands in, read from the ROWS. Never a literal 1, 3 or 10. */
async function boxOf(
  grouping: string,
  measure: 'net_supplies' | 'tax' = 'net_supplies',
): Promise<number> {
  const boxNo = await vat201BoxForGrouping(sql, grouping, measure)
  if (boxNo === null) throw new Error(`no box maps ${grouping}/${measure}`)
  return boxNo
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
  ;[saleMonth, returnMonth, correctionMonth] = await virginWindow()

  // A lock over the window left behind by an interrupted earlier run would refuse every entry here by
  // ZL002 and every case would report that instead — gate 103's, gate 105's and this file's own reason.
  await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

  for (const day of [saleMonth.on, returnMonth.on, correctionMonth.on]) await tradingDay(day)

  for (const supplier of [...FIXTURE_SUPPLIERS, ...REVERSE_CHARGE_SUPPLIERS]) {
    const record = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordSupplier(uow, {
        code: codeFor(supplier.code),
        legalName: supplier.legalName,
        residency: supplier.residency,
        placeOfSupplyRule: supplier.placeOfSupplyRule,
        trn: supplier.trn,
      }),
    )
    supplierIds.set(supplier.code, record.supplierId)
  }

  // --- the sale month: a package sold, and nothing else -----------------------------------------
  const templateKey = `mvat07_${RUN}`
  const [variant] = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
    where s.archived_at is null order by v.gross_price_fils desc, v.id limit 1
  `
  if (variant === undefined) throw new Error('run `pnpm seed`: a priced service variant is needed')
  const [customer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
  if (customer === undefined) throw new Error('run `pnpm seed`: a customer is needed')

  const saved = await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey,
      internalName: 'VAT201 fixture course',
      publicDisplayName: 'VAT201 fixture course',
      priceFils: VAT201_FIXTURE_PACKAGE.priceFils,
      lines: [{ serviceVariantId: variant.id, sessionCount: VAT201_FIXTURE_PACKAGE.sessions }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
  const version = await currentPackageTemplateVersion(sql, templateKey)
  if (version === null) throw new Error('the version just saved cannot be read back')

  const saleInput = packageSaleMapping({
    entryId: entryId(`JE-${PREFIX}-${RUN}-PKGSALE`),
    tradingDate: localDate(saleMonth.on),
    customerId: customer.id,
    templateVersionId: saved.versionId,
    priceGross: money(filsFrom(VAT201_FIXTURE_PACKAGE.priceFils)),
    lines: version.lines.map((line) => ({
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionCount: line.sessionCount,
      listGrossFils: line.listGrossFils,
    })),
    tenders: [{ kind: 'cash', amount: money(filsFrom(VAT201_FIXTURE_PACKAGE.priceFils)) }],
    validityMonths: version.validityMonths,
    transferable: version.transferable,
    unredeemedBalancePolicy: version.unredeemedBalancePolicy,
    packageLabel: version.internalName,
  }).input
  const sold = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, saleInput))
  const read = await readPackageSale(sql, sold.saleId)
  const balance = read?.balances[0]
  const balanceId = sold.balanceIds[0]
  if (balance === undefined || balanceId === undefined) {
    throw new Error('the sale opened no balance')
  }

  // --- the return month: the redemption and the four bills --------------------------------------
  const redemption = packageRedemptionMapping({
    entryId: entryId(`JE-${PREFIX}-${RUN}-PKGRED`),
    tradingDate: localDate(returnMonth.on),
    balance: {
      balanceId,
      sessionsTotal: balance.sessionsTotal,
      sessionsRedeemed: balance.sessionsRedeemed,
      valueGross: money(filsFrom(Number(balance.valueFils))),
      releasedGross: money(filsFrom(Number(balance.releasedFils))),
    },
    appointmentId: crypto.randomUUID(),
    units: VAT201_FIXTURE_PACKAGE.redeemedSessions,
    packageLabel: version.internalName,
  }).input
  await withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, redemption))

  for (const bill of VAT201_FIXTURE_BILLS) {
    const gross = money(filsFrom(bill.grossFils))
    const derived = deriveBill([
      {
        description: bill.why.slice(0, 60),
        account: bill.account,
        gross,
        treatment: bill.treatment,
        ...(bill.reverseChargeFils === undefined
          ? {}
          : {
              reverseCharge: reverseChargeForAccount(
                gross,
                accountFor(STANDARD_SPA_CHART, bill.account),
              ),
            }),
      },
    ])
    const posted = await withUnitOfWork(sql, ACTOR, (uow) =>
      postBill(uow, {
        supplierId: supplierIds.get(bill.supplierCode) as string,
        supplierReference: referenceFor(bill.supplierReference),
        billDate: localDate(returnMonth.on),
        dueDate: localDate(returnMonth.on),
        entryDate: localDate(returnMonth.on),
        receivedBy: 'm-vat-07-itest',
        lines: derived.lines.map((line) => ({
          description: line.description,
          expenseAccountCode: line.account,
          taxTreatment: line.treatment,
          vatRateBp: line.rateBp,
          grossFils: line.gross.fils,
          netFils: line.net.fils,
          ...(line.reverseChargeOutputVat.fils > 0
            ? { reverseChargeOutputVatFils: line.reverseChargeOutputVat.fils }
            : {}),
        })),
      }),
    )
    bills.set(bill.supplierReference, posted)
    if (bill.account === ACCOUNTS.rent) rentEntryId = posted.entryId
  }

  await close(saleMonth)
  await close(returnMonth)

  // --- the correction month: the rent bill reversed, dated by postDatedCorrection ---------------
  // The reversing LINES are the original's sides swapped, read back from the journal rather than retyped:
  // a reversal whose figures were recomputed could round differently from the entry it undoes.
  const original = await readJournalEntry(sql, rentEntryId)
  if (original === null) throw new Error('the rent bill posted no entry')
  reversalEntry = `JE-${PREFIX}-${RUN}-REV`
  await withUnitOfWork(sql, ACTOR, (uow) =>
    postDatedCorrection(uow, {
      reversesEntryId: rentEntryId,
      entryId: reversalEntry,
      narrative: `Reversal of ${rentEntryId}: the rent bill was entered twice`,
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitFils: line.creditFils,
        creditFils: line.debitFils,
        ...(line.memo === null ? {} : { memo: line.memo }),
      })),
    }),
  )
  await close(correctionMonth)
}, 180_000)

afterAll(async () => {
  // The locks go; the entries cannot (ZL001 refuses the owner too), which is why the window is picked.
  if (sql !== undefined) {
    await sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`
  }
  await sql?.end({ timeout: 5 })
})

describe('acceptance — every account carries exactly one attribution or an explicit out-of-scope marker', () => {
  it('leaves no account in the chart untagged, and the primary key makes "exactly one" structural', async () => {
    const [row] = await sql<{ accounts: string; mapped: string; untagged: string }[]>`
      select (select count(*) from account)::text                                as accounts,
             (select count(*) from vat201_box_mapping)::text                     as mapped,
             (select count(*) from account a
               left join vat201_box_mapping m on m.account_code = a.code
              where m.account_code is null)::text                                as untagged
    `
    expect(row?.untagged).toBe('0')
    expect(row?.accounts).toBe(row?.mapped)
    // Not merely non-empty: a chart that had lost most of itself would satisfy the equality above.
    expect(Number(row?.accounts)).toBeGreaterThan(50)
  })

  it('marks out of scope EXPLICITLY, with a stated reason a tax agent can disagree with', async () => {
    const rows = await sql<{ account_code: string; note: string }[]>`
      select account_code, note from vat201_box_mapping
      where disposition = 'out_of_scope' order by account_code
    `
    expect(rows.length).toBeGreaterThan(30)
    for (const row of rows) expect(row.note.length, row.account_code).toBeGreaterThan(20)
  })

  it('refuses an account with no attribution at COMMIT, naming it (ZY009)', async () => {
    // A DEFERRED constraint trigger, so the refusal arrives at COMMIT and the only honest fixture is a
    // transaction that actually tries to commit. Deleting the row rolls back with it.
    const refusal = await sql
      .begin(async (tx) => {
        await tx`delete from vat201_box_mapping where account_code = ${ACCOUNTS.treatmentRevenue}`
      })
      .then(
        () => undefined,
        (error: unknown) => error as { message?: string; code?: string },
      )
    expect(refusal?.code).toBe('ZY009')
    expect(refusal?.message).toContain('Vat201MappingIncomplete')
    expect(refusal?.message).toContain(ACCOUNTS.treatmentRevenue as string)
    // The control: the mapping row is still there, so the refusal was the trigger and not the delete
    // failing for some other reason.
    const [still] = await sql<{ n: string }[]>`
      select count(*)::text as n from vat201_box_mapping
      where account_code = ${ACCOUNTS.treatmentRevenue}
    `
    expect(still?.n).toBe('1')
  })

  it('refuses a revenue account mapped as tax, which would report the net as VAT (ZY010)', async () => {
    const refusal = await sql
      .begin(async (tx) => {
        await tx`
          update vat201_box_mapping set measure = 'tax'
          where account_code = ${ACCOUNTS.treatmentRevenue}
        `
      })
      .then(
        () => undefined,
        (error: unknown) => error as { message?: string; code?: string },
      )
    expect(refusal?.code).toBe('ZY010')
    expect(refusal?.message).toContain('cannot hold tax')
  })

  it('holds no write privilege for the application role, so the mapping is a migration', async () => {
    // Run as `berelax_app` and not only as the owner. The test pool connects as OWNER, so every rule that
    // is a GRANT rather than a trigger is invisible to it — the gap that has caught five units.
    const refusal = await sql
      .begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`update vat201_box_mapping set box_no = null where account_code = '2030'`
      })
      .then(
        () => undefined,
        (error: unknown) => error as { code?: string },
      )
    expect(refusal?.code).toBe('42501')
  })
})

describe('acceptance — the exhaustive partition', () => {
  it('attributes every journal line in the return month exactly once', async () => {
    const census = await vat201PartitionCensusSql(sql, returnMonth)
    expect(census.linesInPeriod).toBe(VAT201_WORKED_EXAMPLE_CENSUS.linesInPeriod)
    // Enumerated equals the population: greater means a line was DUPLICATED by the document join, fewer
    // means one was dropped. Two different defects, so both are named.
    expect(census.linesEnumerated).toBe(census.linesInPeriod)
    expect(census.linesDistinct).toBe(census.linesInPeriod)
    expect(census.unattributed).toBe(VAT201_WORKED_EXAMPLE_CENSUS.unattributed)
    expect(census.boxed).toBe(VAT201_WORKED_EXAMPLE_CENSUS.boxed)
    expect(census.unallocated).toBe(VAT201_WORKED_EXAMPLE_CENSUS.unallocated)
    expect(census.outOfScope).toBe(VAT201_WORKED_EXAMPLE_CENSUS.outOfScope)
    // The buckets are the whole population and nothing else.
    expect(census.boxed + census.unallocated + census.outOfScope + census.unattributed).toBe(
      census.linesInPeriod,
    )
  })

  it('agrees with core over the same lines, which is the only comparison neither half can make', async () => {
    const rows = await vat201DrillDown(sql, returnMonth)
    const census = vat201PartitionCensus(asCoreLines(rows), await attributions())
    const fromSql = await vat201PartitionCensusSql(sql, returnMonth)
    expect(census.unattributed).toEqual([])
    expect(census.duplicated).toEqual([])
    expect(census.boxed).toBe(fromSql.boxed)
    expect(census.unallocated).toBe(fromSql.unallocated)
    expect(census.outOfScope).toBe(fromSql.outOfScope)
  })

  it('SEES an unattributed line when one exists, so the zero above is a measurement', async () => {
    // Inside a transaction that rolls back. The deferred trigger fires only at COMMIT, so the hole is
    // visible to a query in between — which is the only way this failing case can be represented at all.
    await sql
      .begin(async (tx) => {
        await tx`delete from vat201_box_mapping where account_code = ${ACCOUNTS.tradePayables}`
        const [row] = await tx<{ unattributed: string }[]>`
          select unattributed::text from vat201_partition_census(
            ${returnMonth.startsOn}::date, ${returnMonth.endsOn}::date)
        `
        // 2010 Trade payables carries four lines in the return month, and every one becomes visible.
        expect(row?.unattributed).toBe('4')
        throw new Error('rollback')
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') throw error
      })
  })
})

describe('acceptance — the worked example, exact to the fils', () => {
  it('produces the committed box figures for the closed return month', async () => {
    const boxes = await vat201Boxes(sql, returnMonth)
    for (const expected of VAT201_WORKED_EXAMPLE_BOXES) {
      // The box is looked up by GROUPING through the mapping rows. A literal 1 here would be this test
      // asserting Y11-vat201-boxes' answer instead of reading it.
      const netBox = await boxOf(expected.grouping)
      const taxBox = await boxOf(expected.taxGrouping ?? expected.grouping, 'tax')
      expect(netBox, expected.grouping).toBe(taxBox)
      const box = boxes.find((row) => row.boxNo === netBox)
      expect(box?.netSuppliesFils, `${expected.grouping} value`).toBe(
        BigInt(expected.netSuppliesFils),
      )
      expect(box?.taxFils, `${expected.grouping} tax`).toBe(BigInt(expected.taxFils))
      expect(box?.lineCount, `${expected.grouping} lines`).toBe(expected.lineCount)
    }
  })

  it('reports the blocked account as UNALLOCATED and reconciles it to bill_line', async () => {
    const unboxed = await vat201UnboxedTotals(sql, returnMonth)
    const blocked = unboxed.find(
      (row) => row.accountCode === VAT201_WORKED_EXAMPLE_UNALLOCATED.accountCode,
    )
    expect(blocked?.disposition).toBe('unallocated')
    // Its OWN question. Y11-vat201-boxes asks for the numbers for standard-rated sales, reverse charge and
    // recoverable input tax and does not reach blocked expenditure, and filing a genuinely unasked question
    // under one that IS asked is how it comes to be answered by implication.
    expect(blocked?.openQuestionId).toBe('Y11-vat201-blocked-box')
    expect(blocked?.netSuppliesFils).toBe(BigInt(VAT201_WORKED_EXAMPLE_UNALLOCATED.netSuppliesFils))
    // The ledger holds the net AND the borne tax in one debit, so the 2,000 comes from M-VAT-02's
    // working paper. The two figures together are the acceptance line's "explicit non-recoverable
    // disclosure", and neither is derivable from the other.
    const paper = await inputVatRecovery(sql, {
      from: returnMonth.startsOn,
      to: returnMonth.endsOn,
    })
    expect(paper.blockedInputVatFils).toBe(
      BigInt(VAT201_WORKED_EXAMPLE_UNALLOCATED.blockedVatFromBillLine),
    )
    expect(blocked?.netSuppliesFils).toBe(BigInt(VAT201_WORKED_EXAMPLE_UNALLOCATED.netSuppliesFils))
  })

  it('measures the out-of-scope bucket as debits PLUS credits', async () => {
    const unboxed = await vat201UnboxedTotals(sql, returnMonth)
    for (const expected of VAT201_WORKED_EXAMPLE_OUT_OF_SCOPE) {
      const row = unboxed.find(
        (candidate) =>
          candidate.accountCode === expected.accountCode &&
          candidate.disposition === 'out_of_scope',
      )
      expect(row?.movementFils, expected.accountCode).toBe(BigInt(expected.movementFils))
      expect(row?.lineCount, expected.accountCode).toBe(expected.lineCount)
    }
  })

  it('reports the groupings the chart cannot express as zeros WITH the reason', async () => {
    const groupings = await vat201UnrepresentableGroupings(sql)
    expect(groupings.map((row) => row.grouping)).toEqual(['exempt_supplies', 'zero_rated_supplies'])
    for (const row of groupings) {
      expect(row.openQuestionId).toBe('Y8-coa')
      expect(row.reason).toContain('structural zero')
    }
  })

  it('reconciles the ledger against the bill columns to zero, both identities', async () => {
    const paper = await vat201WorkingPapers(sql, returnMonth)
    expect(paper.reconciliations.length).toBe(2)
    for (const line of paper.reconciliations) {
      expect(line.differenceFils, line.identity).toBe(0n)
      // Not vacuously zero: both sides carry a figure. Two zeros reconcile perfectly and say nothing.
      expect(line.ledgerFils, line.identity).toBeGreaterThan(0n)
      expect(line.documentFils, line.identity).toBeGreaterThan(0n)
    }
  })

  it('still reconciles in a month whose only movement is a dated REVERSAL', async () => {
    // FOUND BY READING, not by a failing test, which is why it is recorded: the reconciliation summed only
    // the bills DATED in the period, and a dated reversal moves the ledger while `bill` — append-only —
    // keeps the reversed bill's columns and its own date. So the correction month reported a difference of
    // −5,000 fils for a perfectly correct correction, and a report that cries wolf is one nobody opens.
    //
    // The document side now subtracts the columns of any bill whose posting a reversal in this period
    // undid, so the identity holds. Both figures are NEGATIVE here and that is the assertion: the ledger
    // took 5,000 back out of the claim and the document side agrees that it did.
    const paper = await vat201WorkingPapers(sql, correctionMonth)
    const claim = paper.reconciliations.find((line) =>
      line.identity.startsWith('input tax claimed'),
    )
    expect(claim?.differenceFils).toBe(0n)
    expect(claim?.ledgerFils).toBe(BigInt(VAT201_CORRECTION_MONTH.inputTaxTaxFils))
    expect(claim?.documentFils).toBe(BigInt(VAT201_CORRECTION_MONTH.inputTaxTaxFils))
    expect(claim?.ledgerFils).toBeLessThan(0n)
    // And the other identity is a pair of honest zeros: the reversed bill declared no reverse charge, so
    // there is nothing on either side. Asserted rather than skipped, because "zero" and "not computed"
    // look the same in a report.
    const declared = paper.reconciliations.find((line) =>
      line.identity.startsWith('reverse-charge output tax'),
    )
    expect(declared?.ledgerFils).toBe(0n)
    expect(declared?.documentFils).toBe(0n)
  })

  it('finds the chart and the mapping in agreement, and SEES a disagreement when one exists', async () => {
    expect(await vat201MappingDisagreements(sql)).toEqual([])
    await sql
      .begin(async (tx) => {
        await tx`
          update account set vat_box = null, input_vat_recoverable = false
          where code = ${ACCOUNTS.treatmentRevenue}
        `
        const rows = await tx<{ account_code: string }[]>`
          select account_code from vat201_mapping_disagreement()
        `
        expect(rows.map((row) => row.account_code)).toEqual([ACCOUNTS.treatmentRevenue as string])
        throw new Error('rollback')
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') throw error
      })
  })
})

describe('acceptance — a box total equals the sum of its drill-down lines, exact to the fils', () => {
  it('re-sums every box from its own drill-down and finds no difference at all', async () => {
    const boxes = await vat201Boxes(sql, returnMonth)
    let compared = 0
    for (const box of boxes) {
      const lines = await vat201DrillDown(sql, returnMonth, box.boxNo)
      const net = lines
        .filter((line) => line.measure === 'net_supplies')
        .reduce((total, line) => total + line.signedFils, 0n)
      const tax = lines
        .filter((line) => line.measure === 'tax')
        .reduce((total, line) => total + line.signedFils, 0n)
      expect(net, `box ${box.boxNo} value`).toBe(box.netSuppliesFils)
      expect(tax, `box ${box.boxNo} tax`).toBe(box.taxFils)
      expect(lines.length, `box ${box.boxNo} lines`).toBe(box.lineCount)
      if (box.netSuppliesFils !== 0n || box.taxFils !== 0n) compared += 1
    }
    // A vacuity floor: three boxes with figures in them, so the loop is not comparing zeros.
    expect(compared).toBe(3)
  })

  it('detects a ONE-FILS disagreement, which is the defect this unit exists to prevent', async () => {
    // The control. Without it the assertion above holds for a query that returned nothing, and "exact to
    // the fils" is precisely the claim a structural guarantee is easiest to believe without checking.
    const boxes = await vat201Boxes(sql, returnMonth)
    const box = boxes.find((row) => row.taxFils !== 0n)
    if (box === undefined) throw new Error('no box carries tax; the fixture posted nothing')
    const lines = await vat201DrillDown(sql, returnMonth, box.boxNo)
    const tax = lines
      .filter((line) => line.measure === 'tax')
      .reduce((total, line) => total + line.signedFils, 0n)
    expect(tax).toBe(box.taxFils)
    expect(tax + 1n).not.toBe(box.taxFils)
  })

  it('recomputes every box in core from the drill-down and agrees with the SQL aggregate', async () => {
    const rows = await vat201DrillDown(sql, returnMonth)
    const boxes = await vat201Boxes(sql, returnMonth)
    const { boxes: fromCore, unboxed } = summariseVat201(
      asCoreLines(rows),
      await attributions(),
      boxes.map((box) => box.boxNo),
    )
    for (const box of boxes) {
      const mine = fromCore.find((candidate) => candidate.boxNo === box.boxNo)
      expect(mine?.netSuppliesFils, `box ${box.boxNo}`).toBe(box.netSuppliesFils)
      expect(mine?.taxFils, `box ${box.boxNo}`).toBe(box.taxFils)
    }
    // And the sign rule itself, line by line: core's function against the SQL `case`, over every line in
    // the period rather than over a sample.
    for (const row of rows) {
      expect(
        vat201SignedFils(asCoreLines([row])[0] as Vat201Line, row.contribution),
        `${row.entryId}/${row.lineNo}`,
      ).toBe(row.signedFils)
    }
    expect(rows.length).toBe(VAT201_WORKED_EXAMPLE_CENSUS.linesInPeriod)
    expect(unboxed.length).toBeGreaterThan(0)
  })
})

describe('acceptance — box to journal line to source document', () => {
  it('reaches a document from every line in every non-zero box', async () => {
    const boxes = await vat201Boxes(sql, returnMonth)
    const withFigures = boxes.filter((box) => box.netSuppliesFils !== 0n || box.taxFils !== 0n)
    expect(withFigures.length).toBe(3)
    let walked = 0
    for (const box of withFigures) {
      for (const line of await vat201DrillDown(sql, returnMonth, box.boxNo)) {
        expect(
          line.documentKind,
          `${line.entryId}/${line.lineNo} in box ${box.boxNo}`,
        ).not.toBeNull()
        expect(line.documentId, `${line.entryId}/${line.lineNo}`).not.toBeNull()
        walked += 1
      }
    }
    expect(walked).toBe(VAT201_WORKED_EXAMPLE_CENSUS.boxed)
  })

  it('reaches the bill behind a recoverable line, by its printed number', async () => {
    const box = await boxOf('recoverable_input_tax', 'tax')
    const lines = await vat201DrillDown(sql, returnMonth, box)
    const kinds = new Set(lines.map((line) => line.documentKind))
    expect([...kinds]).toEqual(['bill'])
    for (const line of lines) expect(line.documentNumber).toMatch(/^BILL-\d+$/)
  })

  it('reaches the document of the entry a dated REVERSAL corrects, which has none of its own', async () => {
    const box = await boxOf('recoverable_input_tax', 'tax')
    const lines = await vat201DrillDown(sql, correctionMonth, box)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line.entryId).toBe(reversalEntry)
      expect(line.source).toBe('reversal')
      // The hop: the reversal carries no document, so the drill-down reaches the bill it undoes, marked.
      expect(line.documentKind).toBe('reversal_of_bill')
      expect(line.documentNumber).toMatch(/^BILL-\d+$/)
    }
  })

  it('makes the correction REDUCE the box rather than adding to it or being dropped', async () => {
    const boxes = await vat201Boxes(sql, correctionMonth)
    const inputBox = await boxOf('recoverable_input_tax')
    const box = boxes.find((row) => row.boxNo === inputBox)
    expect(box?.netSuppliesFils).toBe(BigInt(VAT201_CORRECTION_MONTH.inputTaxNetSuppliesFils))
    expect(box?.taxFils).toBe(BigInt(VAT201_CORRECTION_MONTH.inputTaxTaxFils))
    const census = await vat201PartitionCensusSql(sql, correctionMonth)
    expect(census.linesInPeriod).toBe(VAT201_CORRECTION_MONTH.linesInPeriod)
    expect(census.boxed).toBe(VAT201_CORRECTION_MONTH.boxed)
    expect(census.outOfScope).toBe(VAT201_CORRECTION_MONTH.outOfScope)
  })
})

describe('acceptance — the mapping is data and not code', () => {
  it('moves a figure to a different box when one ROW changes, with no code edit', async () => {
    const standardRated = await boxOf('standard_rated_supplies')
    const reverseCharge = await boxOf('reverse_charge')
    expect(standardRated).not.toBe(reverseCharge)

    // The CONTROL, first and outside the transaction: the figure is in the first box to begin with. Without
    // it, "it is in box 3 afterwards" is satisfied by a figure that was never anywhere else.
    const before = await vat201Boxes(sql, returnMonth)
    const wasHere = before.find((box) => box.boxNo === standardRated)
    const wasThere = before.find((box) => box.boxNo === reverseCharge)
    expect(wasHere?.netSuppliesFils).toBe(BigInt(66_667))
    expect(wasThere?.netSuppliesFils).toBe(BigInt(200_000))

    await sql
      .begin(async (tx) => {
        // One UPDATE of one row. No function is replaced, no TypeScript changes, and the journal is
        // untouched — which is what Y11-vat201-boxes' recorded answer asks to be demonstrated.
        await tx`
          update vat201_box_mapping set box_no = ${reverseCharge}
          where account_code = ${ACCOUNTS.packageRedemptionRevenue}
        `
        const rows = await tx<{ box_no: number; net_supplies_fils: string }[]>`
          select box_no, net_supplies_fils::text from vat201_box_total(
            ${returnMonth.startsOn}::date, ${returnMonth.endsOn}::date) order by box_no
        `
        const now = new Map(rows.map((row) => [row.box_no, BigInt(row.net_supplies_fils)]))
        expect(now.get(standardRated)).toBe(0n)
        expect(now.get(reverseCharge)).toBe(BigInt(200_000 + 66_667))
        // And the total across the boxes is unchanged, so the row MOVED the figure rather than
        // duplicating it — which both assertions above would otherwise accept.
        const total = [...now.values()].reduce((sum, value) => sum + value, 0n)
        const wasTotal = before.reduce((sum, box) => sum + box.netSuppliesFils, 0n)
        expect(total).toBe(wasTotal)
        throw new Error('rollback')
      })
      .catch((error: Error) => {
        if (error.message !== 'rollback') throw error
      })

    // And it is back, so no later case is reading a mutated mapping.
    const after = await vat201Boxes(sql, returnMonth)
    expect(after.find((box) => box.boxNo === standardRated)?.netSuppliesFils).toBe(BigInt(66_667))
  })

  it('keeps every box number in rows and out of the label, which is what a tax agent corrects', async () => {
    const boxes = await vat201Boxes(sql, returnMonth)
    expect(boxes.length).toBeGreaterThan(0)
    for (const box of boxes) {
      // Provisional, and the label SAYS so: `vat201_box_provisional_label_is_marked` ties the marker to
      // the flag in both directions, so a paper cannot print the number as settled.
      expect(box.isProvisional, `box ${box.boxNo}`).toBe(true)
      expect(box.openQuestionId, `box ${box.boxNo}`).toBe('Y11-vat201-boxes')
      expect(box.label.toLowerCase(), `box ${box.boxNo}`).toContain('to be confirmed')
    }
  })

  it('refuses a box row that claims to be settled while its label still carries the marker', async () => {
    const refusal = await sql
      .begin(async (tx) => {
        await tx`update vat201_box set is_provisional = false where box_no = ${await boxOf('standard_rated_supplies')}`
      })
      .then(
        () => undefined,
        (error: unknown) => error as { message?: string },
      )
    expect(refusal?.message).toContain('vat201_box_provisional_label_is_marked')
  })
})

describe('acceptance — Y11-vat-package, as two period movements', () => {
  it('puts nothing from a package SALE in any output-VAT box of the sale month', async () => {
    const census = await vat201PartitionCensusSql(sql, saleMonth)
    expect(census.linesInPeriod).toBe(VAT201_SALE_MONTH.linesInPeriod)
    expect(census.outOfScope).toBe(VAT201_SALE_MONTH.outOfScope)
    expect(census.boxed).toBe(VAT201_SALE_MONTH.boxed)

    const boxes = await vat201Boxes(sql, saleMonth)
    // Every OUTPUT box, not only the standard-rated one: the acceptance line says every output-VAT box.
    for (const box of boxes.filter((row) => row.side === 'output')) {
      expect(box.netSuppliesFils, `box ${box.boxNo}`).toBe(0n)
      expect(box.taxFils, `box ${box.boxNo}`).toBe(0n)
    }
    // And the sale's own lines are accounted for rather than merely absent: 2050 and the cash it came in
    // as, both out of scope. A month whose figures were zero because nothing was posted would pass the
    // loop above and prove nothing.
    const unboxed = await vat201UnboxedTotals(sql, saleMonth)
    expect(unboxed.map((row) => row.accountCode).sort()).toEqual(
      [ACCOUNTS.cashInDrawer as string, ACCOUNTS.packageDeferredRevenue as string].sort(),
    )
    expect(
      unboxed.find((row) => row.accountCode === ACCOUNTS.packageDeferredRevenue)?.movementFils,
    ).toBe(BigInt(VAT201_FIXTURE_PACKAGE.priceFils))
  })

  it('puts the redemption’s tax in the standard-rated box of the REDEMPTION month', async () => {
    // The tax of a standard-rated supply sits on 2030, whose grouping is `output_tax`, and the value sits
    // on a revenue account tagged `standard_rated_supplies`. Both resolve to the SAME box through the
    // mapping rows, which is the claim, and neither is looked up by a literal.
    const box = await boxOf('output_tax', 'tax')
    expect(box).toBe(await boxOf('standard_rated_supplies'))
    const boxes = await vat201Boxes(sql, returnMonth)
    const row = boxes.find((candidate) => candidate.boxNo === box)
    expect(row?.taxFils).toBe(BigInt(VAT201_FIXTURE_PACKAGE.vatFils))
    expect(row?.netSuppliesFils).toBe(BigInt(VAT201_FIXTURE_PACKAGE.netFils))
    // net + vat = the gross released, exactly. ADR 0007, and the one figure Y11-rounding could move — it
    // moves the SPLIT and never the sum.
    expect((row?.netSuppliesFils ?? 0n) + (row?.taxFils ?? 0n)).toBe(
      BigInt(VAT201_FIXTURE_PACKAGE.releasedFils),
    )
  })
})

describe('acceptance — the papers, and the period they are produced against', () => {
  it('regenerates byte-identically, twice, with no clock anywhere in them', async () => {
    const first = await vat201WorkingPapers(sql, returnMonth)
    const second = await vat201WorkingPapers(sql, returnMonth)
    expect(canonicaliseVat201WorkingPapers(second)).toBe(canonicaliseVat201WorkingPapers(first))
    expect(second.contentHash).toBe(first.contentHash)
    // No instant at all, not even a frozen one: an ISO timestamp anywhere would make the bytes differ
    // between two runs a second apart, and the property worth having is that the paper is a function of
    // the rows.
    expect(canonicaliseVat201WorkingPapers(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/)
    // The control: two DIFFERENT periods must not produce the same bytes, or the comparison above holds
    // for a serialiser that emits a constant.
    expect(canonicaliseVat201WorkingPapers(await vat201WorkingPapers(sql, saleMonth))).not.toBe(
      canonicaliseVat201WorkingPapers(first),
    )
  })

  it('carries every box figure into the bytes as an exact decimal string', async () => {
    // FOUND BY GATE CASE 116z, which is what the mutants are for. Replacing the canonical form's bigint
    // branch with `Number(value) + 1` left the byte-identical case above GREEN: two runs of an equally
    // wrong serialiser agree perfectly, and "the bytes are stable" says nothing about what is in them. So
    // the figures are asserted INTO the bytes — a rounded or altered figure is then a missing string.
    //
    // Not self-comparing: the left side is what the paper object holds and the right side is what the
    // serialiser wrote, and a serialiser that changed a figure breaks the pair.
    const paper = await vat201WorkingPapers(sql, returnMonth)
    const bytes = canonicaliseVat201WorkingPapers(paper)
    let asserted = 0
    for (const box of paper.boxes) {
      for (const figure of [box.netSuppliesFils, box.taxFils]) {
        if (figure === 0n) continue
        expect(bytes, `box ${box.boxNo} figure ${figure}`).toContain(`"${figure}"`)
        asserted += 1
      }
    }
    // A vacuity floor: the return month carries six non-zero box figures, so the loop cannot have passed
    // by finding nothing to check.
    expect(asserted).toBe(6)
    // And a bigint is never written as a JSON number, which is the form that would round silently at
    // 2^53: every figure is a quoted decimal string.
    expect(bytes).not.toMatch(/"(?:netSuppliesFils|taxFils)":\s*-?\d/)
  })

  it('carries the ledger evidence hash M-VAT-06 computes, and it is the ledger’s not the paper’s', async () => {
    const paper = await vat201WorkingPapers(sql, returnMonth)
    expect(paper.trialBalanceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(paper.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(paper.contentHash).not.toBe(paper.trialBalanceHash)
    expect(paper.closedPeriodId).toBe(returnMonth.periodId)
  })

  it('refuses an OPEN period, naming the earliest open date periodStatusOn gave it', async () => {
    const [row] = await sql<{ next: string }[]>`
      select (${correctionMonth.endsOn}::date + interval '1 month')::date::text as next
    `
    const open = monthAt(Number(row?.next.slice(0, 4)), Number(row?.next.slice(5, 7)))
    const refusal = await vat201WorkingPapers(sql, open).then(
      () => undefined,
      (error: unknown) => error as { name?: string; message?: string },
    )
    expect(refusal?.name).toBe('Vat201PeriodNotClosed')
    expect(refusal?.message).toContain('while the period is open')
    expect(refusal?.message).toContain(open.startsOn)
  })

  it('reports fileable false with every reason as a row, each naming its question', async () => {
    const paper = await vat201WorkingPapers(sql, returnMonth)
    expect(paper.fileable).toBe(false)
    const reasons = paper.notFileableReasons.map((row) => row.reason)
    expect(reasons).toContain('box_numbering_unconfirmed')
    expect(reasons).toContain('tax_agent_review_outstanding')
    expect(reasons).toContain('unallocated_figures_present')
    expect(reasons).toContain('rounding_convention_unconfirmed')
    // Nothing is a defect: the two reasons that would be are absent, which is what says the mapping is
    // complete and agrees with the chart rather than that the check is missing.
    expect(reasons).not.toContain('unattributed_lines_present')
    expect(reasons).not.toContain('mapping_disagrees_with_chart')
    for (const reason of paper.notFileableReasons) {
      expect(reason.openQuestionId, reason.reason).toMatch(/^Y\d+-/)
      expect(reason.detail.length, reason.reason).toBeGreaterThan(40)
    }
  })

  it('lists the provisional box numbers on the Unconfirmed Assumptions panel', async () => {
    // Through the panel's own reader and not through a query of my own. docs/12 §2 asks for ONE screen
    // listing everything to settle, and a provisional value the panel does not carry is one nobody will be
    // asked about — so the assertion has to go through `unconfirmedAssumptionRows`.
    const rows = await unconfirmedAssumptionRows(sql)
    const mine = rows.filter((row) => row.source === 'vat201_box')
    const boxes = await vat201Boxes(sql, returnMonth)
    expect(mine.map((row) => row.reference).sort()).toEqual(
      boxes.map((box) => String(box.boxNo)).sort(),
    )
    for (const row of mine) {
      expect(row.openQuestionId, row.reference).toBe('Y11-vat201-boxes')
      expect(row.note?.length ?? 0, row.reference).toBeGreaterThan(40)
    }
    // The control: the panel is reporting other sources too, so an empty or broken reader would not have
    // satisfied the equality above by returning only these.
    expect(new Set(rows.map((row) => row.source)).size).toBeGreaterThan(3)
  })
})

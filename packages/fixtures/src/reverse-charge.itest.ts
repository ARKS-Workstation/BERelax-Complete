import {
  ACCOUNTS,
  accountFor,
  billCreditTotal,
  billDebitTotal,
  crossesMidnight,
  deriveBill,
  filsFrom,
  instantFromIso,
  type LocalDate,
  localTime,
  money,
  resolveTradingDate,
  reverseChargeBoxes,
  reverseChargeForAccount,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import {
  createConnection,
  type PostedBill,
  postBill,
  purchaseError,
  REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE,
  readBill,
  recordSupplier,
  reverseChargeExceptions,
  type Sql,
  trialBalanceAsAt,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_CLOSE, FIXTURE_OPEN } from './clock.ts'
import { FIXTURE_SUPPLIERS } from './purchases.ts'
import {
  CORRECTED_PLACE_OF_SUPPLY_RULE,
  REVERSE_CHARGE_BILL_SHAPES,
  REVERSE_CHARGE_ENTRY_DATE,
  REVERSE_CHARGE_ENTRY_INSTANT_ISO,
  REVERSE_CHARGE_PERIOD,
  REVERSE_CHARGE_SUPPLIERS,
  REVERSE_CHARGE_WORKED_EXAMPLE,
  type ReverseChargeBillShape,
  reverseChargeShape,
  shapesDeclaringAReverseCharge,
  UNREPORTED_REVERSE_CHARGE,
} from './reverse-charge.ts'

/**
 * M-VAT-03 — the reverse-charge pair, the ledger it posts, and the scan that finds a missing one.
 *
 * It lives in `@berelax/fixtures` because it compares `core`'s derivation against `db`'s rows and `db`'s
 * SQL rounding against `core`'s, and fixtures is the one package allowed to depend on both — `db` must never
 * import `core`.
 *
 * What is proved here and nowhere else:
 *
 *   1. **The pair is two entries of equal fils in one transaction**, and the ledger stays balanced. A
 *      domestic bill in the same period produces neither, which is the control that makes the first
 *      assertion mean something.
 *   2. **Both sides appear in their VAT201 groupings**, read from `account.vat_box` in the applied database
 *      rather than from a constant — Y11-vat201-boxes is open and the numbered mapping is M-VAT-07's.
 *   3. **A blocked category declares and reclaims nothing**, matching the committed worked example to the
 *      fils, and the tax lands in the expense.
 *   4. **The two statements of the rounding rule agree.** `reverseChargeOn` in core and
 *      `bill_line_reverse_charge_output_matches_the_rate` in SQL, over the half-fils boundary.
 *   5. **The scan lists exactly the one bill posted without a pair**, and nothing else — and with that bill
 *      excluded the report is empty.
 *
 * Nothing here deletes a bill or a posting: both are append-only and refuse the owner too (ADR 0008). So
 * every total is a delta over this suite's own writes, every supplier code carries a per-run suffix, and the
 * report is narrowed to this run's suppliers wherever "and nothing else" is asserted — the integration suite
 * runs sequentially against one database and earlier files leave bills behind.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = { kind: 'system', label: 'm-vat-03-itest' } as const
const RUN = Date.now().toString(36)
const codeFor = (fixtureCode: string) => `${fixtureCode}-mvat03-${RUN}`
const referenceFor = (supplierReference: string) => `${supplierReference}-${RUN}`

/** The fixture salon trades 11:00–02:00, which is what makes 01:30 the previous trading day. */
const FIXTURE_HOURS = { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) }
const hoursFor = () => FIXTURE_HOURS

const IMPORTED_ACCOUNT = accountFor(STANDARD_SPA_CHART, ACCOUNTS.importedServices)
const BLOCKED_ACCOUNT = accountFor(STANDARD_SPA_CHART, ACCOUNTS.entertainment)

let sql: Sql
let entryDate: LocalDate
const supplierIds = new Map<string, string>()
const posted = new Map<string, PostedBill>()
let openingBalance = { debit: 0n, credit: 0n }
/** This run's supplier codes, so every "and nothing else" assertion is about rows this file wrote. */
const runSupplierCodes: string[] = []

async function post(bill: Parameters<typeof postBill>[1]): Promise<PostedBill> {
  try {
    return await withUnitOfWork(sql, ACTOR, (uow) => postBill(uow, bill))
  } catch (err) {
    throw purchaseError(err) ?? err
  }
}

/** The error a call raised, or undefined when it was accepted. */
async function rejection(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error as Error
  }
}

/**
 * Derives a shape through core, pair included.
 *
 * The reverse charge comes from `reverseChargeForAccount` with the chart's own account, which is what makes
 * the input side the chart's answer rather than the fixture's: a re-tagged account moves this derivation and
 * the committed expectation then fails, which is the point.
 */
function derive(shape: ReverseChargeBillShape) {
  return deriveBill(
    shape.lines.map((line) => {
      const gross = money(filsFrom(line.considerationFils))
      if (line.treatment !== 'imported_services_reverse_charge') {
        return {
          description: line.description,
          account: line.account,
          gross,
          treatment: line.treatment,
        }
      }
      return {
        description: line.description,
        account: line.account,
        gross,
        treatment: line.treatment,
        reverseCharge: reverseChargeForAccount(gross, accountFor(STANDARD_SPA_CHART, line.account)),
      }
    }),
  )
}

/** The journal lines of one entry, as `[code, side, fils]`, in posting order. */
async function entryLines(entryId: string): Promise<[string, string, number][]> {
  const rows = await sql<{ account_code: string; debit_fils: string; credit_fils: string }[]>`
    select account_code, debit_fils::text as debit_fils, credit_fils::text as credit_fils
    from journal_line where entry_id = ${entryId} order by line_no
  `
  return rows.map((row) => [
    row.account_code,
    Number(row.debit_fils) > 0 ? 'debit' : 'credit',
    Number(row.debit_fils) > 0 ? Number(row.debit_fils) : Number(row.credit_fils),
  ])
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  // The entry date is RESOLVED, not asserted: 01:30 on 16 March belongs to the 15th's session, and a
  // truncated instant would file every reverse charge below into the next VAT period.
  expect(crossesMidnight(FIXTURE_HOURS)).toBe(true)
  const resolved = resolveTradingDate(instantFromIso(REVERSE_CHARGE_ENTRY_INSTANT_ISO), hoursFor)
  expect(resolved.kind).toBe('trading')
  entryDate = (resolved as { date: LocalDate }).date
  expect(entryDate).toBe(REVERSE_CHARGE_ENTRY_DATE)

  const trial = await trialBalanceAsAt(sql, REVERSE_CHARGE_PERIOD.to)
  openingBalance = { debit: trial.totalDebitFils, credit: trial.totalCreditFils }

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
    runSupplierCodes.push(codeFor(supplier.code))
  }

  for (const shape of REVERSE_CHARGE_BILL_SHAPES) {
    const derived = derive(shape)
    posted.set(
      shape.supplierReference,
      await post({
        supplierId: supplierIds.get(shape.supplierCode) as string,
        supplierReference: referenceFor(shape.supplierReference),
        billDate: REVERSE_CHARGE_ENTRY_DATE,
        dueDate: REVERSE_CHARGE_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-03-itest',
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
  }

  // The bill the nightly report exists for. Posted while its supplier is recorded `outside_scope`, which is
  // a legitimate position accepted by every layer — and then the rule is CORRECTED, which is an ordinary
  // admin change 0028 grants UPDATE on the profile for. Nothing re-validates the bill: PostgreSQL does not
  // re-check a CHECK on a row nobody touched, and `bill` is append-only. That is the hole the scan closes.
  posted.set(
    UNREPORTED_REVERSE_CHARGE.supplierReference,
    await post({
      supplierId: supplierIds.get(UNREPORTED_REVERSE_CHARGE.supplierCode) as string,
      supplierReference: referenceFor(UNREPORTED_REVERSE_CHARGE.supplierReference),
      billDate: REVERSE_CHARGE_ENTRY_DATE,
      dueDate: REVERSE_CHARGE_ENTRY_DATE,
      entryDate,
      receivedBy: 'm-vat-03-itest',
      lines: [
        {
          description: UNREPORTED_REVERSE_CHARGE.description,
          expenseAccountCode: UNREPORTED_REVERSE_CHARGE.account,
          taxTreatment: UNREPORTED_REVERSE_CHARGE.treatment,
          grossFils: UNREPORTED_REVERSE_CHARGE.considerationFils,
          netFils: UNREPORTED_REVERSE_CHARGE.considerationFils,
        },
      ],
    }),
  )
  await sql`
    update supplier_tax_profile set place_of_supply_rule = ${CORRECTED_PLACE_OF_SUPPLY_RULE}
     where supplier_id = ${supplierIds.get(UNREPORTED_REVERSE_CHARGE.supplierCode) as string}::uuid
  `
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('acceptance — an offshore bill generates the pair in the same transaction, a domestic one does not', () => {
  it('posts an output line and an input line of equal fils, in one entry', async () => {
    const bill = posted.get('FIX-RC-CLOUD-0001') as PostedBill
    expect(bill.reverseChargeOutputVatFils).toBe(5_000)
    expect(bill.reverseChargeInputVatFils).toBe(5_000)
    // Equal, and NOT zero. "Nets to nothing" is satisfied by a bill that declared and claimed nothing at
    // all, which is exactly the understatement this unit exists to prevent.
    expect(bill.reverseChargeOutputVatFils).toBe(bill.reverseChargeInputVatFils)
    expect(bill.reverseChargeOutputVatFils).toBeGreaterThan(0)

    // In the SAME journal entry: one entry per bill (`bill.entry_id` is unique), so there is no second
    // transaction that could fail and leave the declaration without its claim.
    expect(await entryLines(bill.entryId)).toEqual(
      reverseChargeShape('FIX-RC-CLOUD-0001').expected.journalLines.map(([code, side, fils]) => [
        code as string,
        side,
        fils,
      ]),
    )
  })

  it('generates nothing at all for a domestic bill in the same period', async () => {
    const bill = posted.get('FIX-RC-DOMESTIC-0001') as PostedBill
    expect(bill.reverseChargeOutputVatFils).toBe(0)
    expect(bill.reverseChargeInputVatFils).toBe(0)
    // Its VAT is the ordinary claim against a supplier's tax invoice, which is a different column and a
    // different document — and the contrast that makes the offshore assertion above about the residency.
    expect(bill.recoverableInputVatFils).toBe(100_000)
    const lines = await entryLines(bill.entryId)
    expect(lines.some(([code]) => code === REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE)).toBe(false)
    expect(lines).toEqual(
      reverseChargeShape('FIX-RC-DOMESTIC-0001').expected.journalLines.map(([code, side, fils]) => [
        code as string,
        side,
        fils,
      ]),
    )
  })

  it('leaves the trial balance balanced across every bill this suite posted', async () => {
    const trial = await trialBalanceAsAt(sql, REVERSE_CHARGE_PERIOD.to)
    expect(trial.totalDebitFils).toBe(trial.totalCreditFils)
    // A delta, never a total: earlier files in this suite leave postings behind (ADR 0008). The debit side
    // grew by the payable plus every declaration, which is what `billCreditTotal` states in core.
    const declared = BigInt(REVERSE_CHARGE_WORKED_EXAMPLE.declaredFils)
    const grew = trial.totalDebitFils - openingBalance.debit
    expect(grew).toBeGreaterThan(declared)
    expect(trial.totalCreditFils - openingBalance.credit).toBe(grew)
  })

  it('agrees with core about the entry every shape posts, to the fils', async () => {
    for (const shape of REVERSE_CHARGE_BILL_SHAPES) {
      const bill = posted.get(shape.supplierReference) as PostedBill
      expect(await entryLines(bill.entryId), shape.supplierReference).toEqual(
        shape.expected.journalLines.map(([code, side, fils]) => [code as string, side, fils]),
      )
      const derived = derive(shape)
      // The two totals core states, against the rows the database holds. `billDebitTotal` is the gross plus
      // the declaration, not the gross — a caller comparing against the gross alone finds every offshore
      // bill out of balance by exactly the tax it declared.
      expect(billDebitTotal(derived).fils, shape.supplierReference).toBe(
        billCreditTotal(derived).fils,
      )
      expect(bill.reverseChargeOutputVatFils, shape.supplierReference).toBe(
        derived.reverseChargeOutputVat.fils,
      )
      expect(bill.reverseChargeInputVatFils, shape.supplierReference).toBe(
        derived.reverseChargeInputVat.fils,
      )
    }
  })
})

describe('acceptance — both sides land in their VAT201 groupings, read from the mapping and not hard-coded', () => {
  it('reads each side’s grouping out of the mapping and finds the period’s figure under it', async () => {
    // The grouping each side lands in is read from `account.vat_box` in the APPLIED database, joined to the
    // ledger — not from a constant. Y11-vat201-boxes is open: the FTA's box NUMBERS await a tax agent and the
    // numbered mapping table is M-VAT-07's, so a `3` or a `10` here would be a figure nobody has confirmed.
    //
    // Grouped by ACCOUNT rather than by box, and the difference matters: `vat_box` tags an account, and every
    // recoverable expense account in this chart carries `recoverable_input_tax` too — so a sum over the box
    // alone would add the rent expense to the input VAT. That is a property of the mapping this build has, and
    // the reason M-VAT-07 needs a box table of its own rather than this column.
    const rows = await sql<{ account_code: string; vat_box: string; net: string }[]>`
      select jl.account_code,
             a.vat_box,
             sum(jl.credit_fils - jl.debit_fils)::text as net
        from journal_line jl
        join account a on a.code = jl.account_code
       where jl.entry_id in (
               select b.entry_id from bill b
               join supplier s on s.supplier_id = b.supplier_id
               where s.code = any(${runSupplierCodes})
             )
         and jl.account_code in (
               ${REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE}, ${ACCOUNTS.recoverableInputVat as string}
             )
       group by 1, 2
    `
    const byAccount = new Map(rows.map((row) => [row.account_code, row]))
    const boxes = reverseChargeBoxes(STANDARD_SPA_CHART)

    // The output side: credited whole to the account whose grouping IS the reverse-charge box.
    const output = byAccount.get(REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE)
    expect(output?.vat_box).toBe(boxes.output)
    expect(Number(output?.net)).toBe(REVERSE_CHARGE_WORKED_EXAMPLE.declaredFils)

    // The input side: debited to the account whose grouping is recoverable input tax. It carries this run's
    // domestic claim as well — a credit is negative here, so the net is negated — and the reverse-charge half
    // is the difference. Equal in absolute amount to the declaration wherever the category is recoverable,
    // which is what the acceptance asks for.
    const input = byAccount.get(ACCOUNTS.recoverableInputVat as string)
    expect(input?.vat_box).toBe(boxes.input)
    const domesticClaim = (posted.get('FIX-RC-DOMESTIC-0001') as PostedBill).recoverableInputVatFils
    expect(-Number(input?.net) - domesticClaim).toBe(REVERSE_CHARGE_WORKED_EXAMPLE.reclaimedFils)

    // The two groupings are different rows of the mapping. If they were the same the pair would net to
    // nothing inside one figure, which is the failure a single column would produce.
    expect(boxes.output).not.toBe(boxes.input)
    // And the control on "read from the mapping": the figures were found under the boxes the mapping names,
    // so a chart that re-tagged either account would fail the two `vat_box` assertions above rather than
    // quietly moving a figure into the wrong box.
    expect(rows).toHaveLength(2)
  })

  it('declares and reclaims the same absolute amount for every recoverable import', () => {
    for (const shape of shapesDeclaringAReverseCharge()) {
      const bill = posted.get(shape.supplierReference) as PostedBill
      // Equal where nothing is blocked, and deliberately NOT equal on the two shapes that carry a blocked
      // line — which is the acceptance criterion below and the reason "equal" is not asserted globally.
      if (shape.expected.borneFils === 0) {
        expect(bill.reverseChargeOutputVatFils, shape.supplierReference).toBe(
          bill.reverseChargeInputVatFils,
        )
      } else {
        expect(bill.reverseChargeInputVatFils, shape.supplierReference).toBeLessThan(
          bill.reverseChargeOutputVatFils,
        )
      }
    }
  })
})

describe('acceptance — a blocked account declares output VAT and reclaims none', () => {
  it('matches the committed worked example to the fils, and puts the tax in the expense', async () => {
    const shape = reverseChargeShape('FIX-RC-BLOCKED-0001')
    const bill = posted.get('FIX-RC-BLOCKED-0001') as PostedBill
    expect(bill.reverseChargeOutputVatFils).toBe(shape.expected.declaredFils)
    expect(bill.reverseChargeInputVatFils).toBe(0)
    expect(bill.reverseChargeBorneVatFils).toBe(shape.expected.borneFils)
    // The expense carries the consideration plus the tax that cannot be reclaimed, and 1080 is untouched.
    const stored = await readBill(sql, bill.billId)
    expect(stored?.lines[0]?.expenseDebitFils).toBe(44_100)
    const lines = await entryLines(bill.entryId)
    expect(lines.some(([code]) => code === (ACCOUNTS.recoverableInputVat as string))).toBe(false)
    expect(lines).toEqual(
      shape.expected.journalLines.map(([code, side, fils]) => [code as string, side, fils]),
    )
    // The control: the recoverable import of the same shape bears nothing at all, so "blocked" here is the
    // classification doing the work rather than the treatment.
    expect((posted.get('FIX-RC-CLOUD-0001') as PostedBill).reverseChargeBorneVatFils).toBe(0)
  })

  it('refuses a claim on a blocked category and refuses abandoning one on a recoverable category', async () => {
    const supplierId = supplierIds.get('fixture-offshore-hospitality') as string
    // The database's own refusals, reached by bypassing the service: `postBill` derives the input side from
    // the chart, so a caller cannot state a wrong one — which is the design, and which makes ZV007 the layer
    // that catches a hand-written INSERT.
    const overClaim = await rejection(
      () => sql`
        insert into bill_line (bill_id, line_no, description, expense_account_code, tax_treatment,
                               vat_rate_bp, net_fils, gross_fils, recoverable_input_vat_fils,
                               blocked_input_vat_fils, reverse_charge_output_vat_fils,
                               reverse_charge_input_vat_fils)
        values (${(posted.get('FIX-RC-BLOCKED-0001') as PostedBill).billId}::uuid, 9,
                'over-claimed blocked import', ${ACCOUNTS.entertainment as string},
                'imported_services_reverse_charge', 500, 42000, 42000, 0, 0, 2100, 2100)
      `,
    )
    expect((overClaim as { code?: string } | undefined)?.code).toBe('ZV007')
    expect(overClaim?.message).toMatch(/classified blocked/)

    // And the opposite: declaring the output on a recoverable category and claiming nothing pays the FTA tax
    // the business was entitled to reclaim. Under-claiming is not a compliance failure and is still wrong.
    const underClaim = await rejection(() =>
      post({
        supplierId,
        supplierReference: referenceFor('FIX-RC-UNDERCLAIM'),
        billDate: REVERSE_CHARGE_ENTRY_DATE,
        dueDate: REVERSE_CHARGE_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-03-itest',
        lines: [
          {
            description: 'Booking platform subscription',
            expenseAccountCode: ACCOUNTS.importedServices,
            taxTreatment: 'imported_services_reverse_charge',
            grossFils: 20_000,
            netFils: 20_000,
            reverseChargeOutputVatFils: 1_000,
          },
        ],
      }),
    )
    // Accepted, and the claim is made FOR the caller: the input side is the chart's answer, so there is no
    // way to abandon it through the service. This is the control on the pair above — if postBill let the
    // caller decide, this bill would have declared 1,000 and claimed nothing.
    expect(underClaim).toBeUndefined()
    const [row] = await sql<{ declared: string; reclaimed: string }[]>`
      select reverse_charge_output_vat_fils::text as declared,
             reverse_charge_input_vat_fils::text  as reclaimed
        from bill where supplier_reference = ${referenceFor('FIX-RC-UNDERCLAIM')}
    `
    expect(row?.declared).toBe('1000')
    expect(row?.reclaimed).toBe('1000')
  })
})

describe('the rounding rule has two statements and they agree', () => {
  it('rounds half a fils up in core and in the database alike', async () => {
    const shape = reverseChargeShape('FIX-RC-HALF-0001')
    const bill = posted.get('FIX-RC-HALF-0001') as PostedBill
    // 4,010 × 5% = 200.5. Core said 201 when the bill was derived; the row exists, so
    // `bill_line_reverse_charge_output_matches_the_rate` — which computes the same thing in SQL — agreed.
    expect(bill.reverseChargeOutputVatFils).toBe(201)
    expect(reverseChargeForAccount(money(filsFrom(4_010)), IMPORTED_ACCOUNT).outputVat.fils).toBe(
      201,
    )
    expect(shape.expected.declaredFils).toBe(201)

    // The control, and the reason the agreement is not vacuous: the truncated figure is REFUSED by the
    // database. Without this, a SQL CHECK that computed nothing at all would satisfy every assertion above.
    const truncated = await rejection(
      () => sql`
        insert into bill_line (bill_id, line_no, description, expense_account_code, tax_treatment,
                               vat_rate_bp, net_fils, gross_fils, recoverable_input_vat_fils,
                               blocked_input_vat_fils, reverse_charge_output_vat_fils,
                               reverse_charge_input_vat_fils)
        values (${bill.billId}::uuid, 9, 'truncated instead of rounded',
                ${ACCOUNTS.importedServices as string}, 'imported_services_reverse_charge',
                500, 4010, 4010, 0, 0, 200, 200)
      `,
    )
    expect((truncated as { constraint_name?: string } | undefined)?.constraint_name).toBe(
      'bill_line_reverse_charge_output_matches_the_rate',
    )
    // And the blocked account's classification, read back from the applied chart rather than assumed, so a
    // re-tagged 6090 fails here rather than in a return six months later.
    expect(reverseChargeForAccount(money(filsFrom(42_000)), BLOCKED_ACCOUNT).inputVat.fils).toBe(0)
  })
})

describe('acceptance — the scan lists exactly the bill posted without a pair', () => {
  it('finds the one missing pair and nothing else, and says what it should have declared', async () => {
    const exceptions = await reverseChargeExceptions(sql, {
      from: REVERSE_CHARGE_PERIOD.from,
      to: REVERSE_CHARGE_PERIOD.to,
      supplierCode: codeFor(UNREPORTED_REVERSE_CHARGE.supplierCode),
    })
    expect(exceptions).toHaveLength(1)
    const [exception] = exceptions
    expect(exception?.kind).toBe('missing_pair')
    expect(exception?.supplierReference).toBe(
      referenceFor(UNREPORTED_REVERSE_CHARGE.supplierReference),
    )
    expect(exception?.declaredFils).toBe(0n)
    expect(exception?.netFils).toBe(BigInt(UNREPORTED_REVERSE_CHARGE.considerationFils))
    // The understatement is derivable from the row: 63,000 × 5% = 3,150, the figure a corrective adjustment
    // would carry. The report states the consideration rather than computing the tax, because the rate a
    // correction is made at is the rate in force then and not the rate this scan happens to assume.
    expect((exception?.netFils ?? 0n) / 20n).toBe(
      BigInt(REVERSE_CHARGE_WORKED_EXAMPLE.understatedFils),
    )
    expect(exception?.detail).toMatch(/declared nowhere/)
    expect(exception?.reference).toBe(
      (posted.get(UNREPORTED_REVERSE_CHARGE.supplierReference) as PostedBill).displayNumber,
    )
  })

  it('reports nothing for the suppliers whose pairs are complete, which is the report’s empty state', async () => {
    // Every supplier this run created EXCEPT the misclassified one. This is the "with that fixture removed
    // the report is empty" half of the criterion, and it is the assertion that would catch a scan flagging
    // every offshore bill — which would also satisfy the test above.
    for (const code of runSupplierCodes.filter(
      (candidate) => candidate !== codeFor(UNREPORTED_REVERSE_CHARGE.supplierCode),
    )) {
      const exceptions = await reverseChargeExceptions(sql, {
        from: REVERSE_CHARGE_PERIOD.from,
        to: REVERSE_CHARGE_PERIOD.to,
        supplierCode: code,
      })
      expect(exceptions, code).toEqual([])
    }
  })

  it('does not report an offshore supplier whose supply is genuinely outside the scope of UAE VAT', async () => {
    // The distinction the whole report turns on: `residency = 'offshore'` is not the obligation, the
    // place-of-supply RULE is. A scan keyed on residency alone would flag `fixture-offshore-training` — M-VAT-01's
    // out-of-scope offshore supplier — for ever, and a report that cries wolf is a report nobody opens.
    const stillOutOfScope = await sql<{ code: string }[]>`
      select s.code from supplier s
      join supplier_tax_profile p on p.supplier_id = s.supplier_id
      where p.residency = 'offshore' and p.place_of_supply_rule = 'outside_scope'
        and s.code = any(${runSupplierCodes})
    `
    // Vacuity guard: the correction in beforeAll moved the misclassified supplier out of this population, so
    // if it were empty the assertion below would be about nothing.
    expect(stillOutOfScope.map((row) => row.code)).toEqual([codeFor('fixture-offshore-training')])
    const exceptions = await reverseChargeExceptions(sql, {
      from: REVERSE_CHARGE_PERIOD.from,
      to: REVERSE_CHARGE_PERIOD.to,
      supplierCode: codeFor('fixture-offshore-training'),
    })
    expect(exceptions).toEqual([])
  })

  it('finds a pair the ledger does not carry, which is the corruption a row-level CHECK cannot see', async () => {
    // A bill whose row says it declared 5,000 and whose journal entry credits 2035 with nothing. Built by
    // reversing the ledger side only — `journal_line` is append-only, so this posts a SECOND entry rather
    // than editing the first, which is what a real correction looks like and is why the scan sums the entry
    // rather than trusting one line of it.
    const bill = posted.get('FIX-RC-CLOUD-0001') as PostedBill
    await sql`
      insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
      values (${bill.entryId}, 9, ${REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE}, 5000, 0),
             (${bill.entryId}, 10, ${ACCOUNTS.recoverableInputVat as string}, 0, 5000)
    `
    const exceptions = await reverseChargeExceptions(sql, {
      from: REVERSE_CHARGE_PERIOD.from,
      to: REVERSE_CHARGE_PERIOD.to,
      supplierCode: codeFor('fixture-offshore-cloud'),
    })
    const found = exceptions.find((row) => row.reference === bill.displayNumber)
    expect(found?.kind).toBe('ledger_disagrees')
    expect(found?.declaredFils).toBe(5_000n)
    expect(found?.ledgerDeclaredFils).toBe(0n)
    expect(found?.detail).toMatch(/credits 2035 with 0/)
  })
})

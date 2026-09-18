import {
  ACCOUNTS,
  agePayables,
  billEntryDraft,
  crossesMidnight,
  deriveBill,
  filsFrom,
  instantFromIso,
  type LocalDate,
  localDate,
  localTime,
  money,
  PAYABLES_AGING_BUCKETS,
  type PayableForAging,
  payablesBucketFor,
  resolveTradingDate,
} from '@berelax/core'
import {
  createConnection,
  PAYABLES_AGING_BUCKETS as DB_PAYABLES_AGING_BUCKETS,
  isBalanced,
  outstandingPayables,
  type PostedBill,
  payablesAging,
  postBill,
  purchaseError,
  RECOVERABLE_INPUT_VAT_ACCOUNT_CODE,
  readJournalEntry,
  recordSupplier,
  type Sql,
  TRADE_PAYABLES_ACCOUNT_CODE,
  trialBalanceAsAt,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_CLOSE, FIXTURE_OPEN, FIXTURE_TODAY } from './clock.ts'
import {
  billDateOf,
  dueDateOf,
  FIXTURE_BILL_SHAPES,
  FIXTURE_PAYABLES_AGING,
  FIXTURE_PAYABLES_TOTAL_FILS,
  FIXTURE_SUPPLIERS,
  type FixtureBillShape,
  grossOf,
} from './purchases.ts'

/**
 * M-VAT-01 — the pure derivation and the database agree, on every committed bill shape.
 *
 * Three things are proved here and nowhere else:
 *
 *   1. **The journal a bill posts is the journal `billEntryDraft` describes.** `packages/db` may not
 *      import `packages/core`, so `postBill` builds the Dr/Dr/Cr shape itself. Two statements of one
 *      posting rule is two chances to be wrong, and each half has its own passing test — this is the
 *      file where they are compared line for line.
 *   2. **The SQL aging buckets are the TypeScript aging buckets.** `payables_aging_bucket()` groups in
 *      the database; `payablesBucketFor` answers the same question in core. Compared on every day around
 *      every boundary, because an aging report is only ever wrong by one day.
 *   3. **The committed worked example is what the database produces**, to the fils.
 *
 * It lives in `@berelax/fixtures` because it needs both packages, and fixtures is the only one allowed
 * to depend on `core` and `db` at once.
 *
 * Nothing here deletes a bill or a posting — both are append-only and refuse the owner too — so every
 * total is a delta over this suite's own writes and every supplier code carries a per-run suffix. The
 * supplier *references* are the committed ones, unsuffixed: `bill_supplier_reference_unique` is scoped
 * per supplier, so a fresh supplier per run is enough to make them unique.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = { kind: 'system', label: 'm-vat-01-pair-itest' } as const
const RUN = Date.now().toString(36)
/** Every fixture supplier, under a code unique to this run. */
const codeFor = (fixtureCode: string) => `${fixtureCode}-${RUN}`

/** The fixture salon trades 11:00–02:00 every day, which is what makes 01:30 the previous trading day. */
const FIXTURE_HOURS = { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) }
const hoursFor = () => FIXTURE_HOURS

let sql: Sql
const supplierIds = new Map<string, string>()
const posted = new Map<string, PostedBill>()
let openingBalance = { debit: 0n, credit: 0n }

/** Posts through the service the application uses, with the translation applied at the transaction. */
async function post(bill: Parameters<typeof postBill>[1]): Promise<PostedBill> {
  try {
    return await withUnitOfWork(sql, ACTOR, (uow) => postBill(uow, bill))
  } catch (err) {
    throw purchaseError(err) ?? err
  }
}

/** The lines of one shape, derived in core: gross in, net and VAT out. */
function derive(shape: FixtureBillShape) {
  return deriveBill(
    shape.lines.map((line) => ({
      description: line.description,
      account: line.account,
      gross: money(filsFrom(line.grossFils)),
      treatment: line.treatment,
    })),
  )
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const before = await trialBalanceAsAt(sql, FIXTURE_TODAY)
  openingBalance = { debit: before.totalDebitFils, credit: before.totalCreditFils }

  for (const supplier of FIXTURE_SUPPLIERS) {
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

  for (const shape of FIXTURE_BILL_SHAPES) {
    const derived = derive(shape)
    posted.set(
      shape.supplierReference,
      await post({
        supplierId: supplierIds.get(shape.supplierCode) as string,
        supplierReference: shape.supplierReference,
        billDate: billDateOf(shape),
        dueDate: dueDateOf(shape),
        // The business day the bill was ENTERED, not its invoice date. A supplier invoice dated in a
        // month that is already closed — or before the books open — is posted on the day it arrives,
        // which is what a bookkeeper does and the only date guaranteed to be in an open period. The
        // aging below reads the supplier's due date, which is unaffected.
        entryDate: FIXTURE_TODAY,
        receivedBy: 'm-vat-01-pair-itest',
        lines: derived.lines.map((line) => ({
          description: line.description,
          expenseAccountCode: line.account,
          taxTreatment: line.treatment,
          vatRateBp: line.rateBp,
          grossFils: line.gross.fils,
          netFils: line.net.fils,
        })),
      }),
    )
  }
}, 120_000)

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('every committed bill shape posts the entry core describes', () => {
  it.each(FIXTURE_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s stores the committed figures',
    async (reference, shape) => {
      const bill = posted.get(reference) as PostedBill
      expect(bill.netFils).toBe(shape.expected.netFils)
      expect(bill.vatFils).toBe(shape.expected.vatFils)
      expect(bill.grossFils).toBe(shape.expected.grossFils)
      expect(bill.recoverableInputVatFils).toBe(shape.expected.recoverableInputVatFils)
      // net + vat === gross, from the generated column the database computed rather than the input.
      expect(bill.netFils + bill.vatFils).toBe(bill.grossFils)
      // The claim needs a TRN, and only the suppliers that hold one have a non-zero claim.
      const supplier = FIXTURE_SUPPLIERS.find((s) => s.code === shape.supplierCode)
      if (bill.recoverableInputVatFils > 0) expect(supplier?.trn).not.toBeNull()
      expect(bill.supplierTrn).toBe(supplier?.trn ?? null)
      expect(bill.supplierResidency).toBe(supplier?.residency)
    },
  )

  it.each(FIXTURE_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s posts the journal lines billEntryDraft describes, in the same order',
    async (reference, shape) => {
      const bill = posted.get(reference) as PostedBill
      const draft = billEntryDraft({
        entryId: bill.entryId,
        entryDate: FIXTURE_TODAY,
        narrative: `Supplier bill ${bill.displayNumber}`,
        bill: derive(shape),
      })
      const entry = await readJournalEntry(sql, bill.entryId)

      // The agreement this file exists for: the same accounts, the same sides, the same fils, in the
      // same order. `postBill` built these rows without importing core; `billEntryDraft` built the
      // comparison without touching a database.
      expect(
        entry?.lines.map((line) => [
          line.accountCode,
          line.debitFils > 0 ? 'debit' : 'credit',
          line.debitFils > 0 ? line.debitFils : line.creditFils,
        ]),
      ).toEqual(draft.lines.map((line) => [line.account, line.side, line.amount.fils]))
      // And the committed expectation, which neither half computed.
      expect(
        entry?.lines.map((line) => [
          line.accountCode,
          line.debitFils > 0 ? 'debit' : 'credit',
          line.debitFils > 0 ? line.debitFils : line.creditFils,
        ]),
      ).toEqual(shape.expected.journalLines.map(([account, side, fils]) => [account, side, fils]))
      expect(entry?.source).toBe('supplier_bill')
    },
  )

  it('leaves the ledger balanced, and moves exactly the gross of every shape', async () => {
    const after = await trialBalanceAsAt(sql, FIXTURE_TODAY)
    expect(isBalanced(after)).toBe(true)
    // A delta: other suites post into this ledger, and nothing here can be deleted (ADR 0008).
    expect(after.totalDebitFils - openingBalance.debit).toBe(BigInt(FIXTURE_PAYABLES_TOTAL_FILS))
    expect(after.totalCreditFils - openingBalance.credit).toBe(BigInt(FIXTURE_PAYABLES_TOTAL_FILS))
  })

  it('names the same two accounts in both packages, so neither spells a code of its own', async () => {
    expect(RECOVERABLE_INPUT_VAT_ACCOUNT_CODE).toBe(ACCOUNTS.recoverableInputVat)
    expect(TRADE_PAYABLES_ACCOUNT_CODE).toBe(ACCOUNTS.tradePayables)
    // And the accounts exist in the seeded chart, so the agreement is not two matching typos.
    const rows = await sql<{ code: string }[]>`
      select code from account
      where code in (${RECOVERABLE_INPUT_VAT_ACCOUNT_CODE}, ${TRADE_PAYABLES_ACCOUNT_CODE})
    `
    expect(rows.map((row) => row.code).sort()).toEqual(['1080', '2010'])
  })
})

describe('the payables aging: SQL and TypeScript answer the same question', () => {
  it('agrees on every day from five before a due date to a hundred and twenty after', async () => {
    // Every boundary crossed one day at a time, in one round trip. An aging report is only ever wrong by
    // one day, and this is the assertion that would catch a `<` where a `<=` belongs — in either half.
    const due = localDate('2026-06-01')
    const rows = await sql<{ offset_days: number; as_of: string; bucket: string }[]>`
      select days.n                                                    as offset_days,
             (${due}::date + days.n)::text                             as as_of,
             payables_aging_bucket(${due}::date, ${due}::date + days.n) as bucket
      from generate_series(-5, 120) as days(n)
    `
    // One round trip, and the as-of date comes back with each row: asking the database to add the days a
    // second time per row would be 126 queries to re-derive a date it has already computed.
    expect(rows).toHaveLength(126)
    for (const row of rows) {
      const core = payablesBucketFor(due, localDate(row.as_of))
      // The offset is in the compared value, so a failure names the day rather than only the bucket.
      expect(`${row.offset_days} days: ${row.bucket}`).toBe(`${row.offset_days} days: ${core}`)
    }
    // The control: the sweep really does cross every boundary. A function that returned one bucket for
    // everything would satisfy the loop above if core did too.
    expect(new Set(rows.map((row) => row.bucket)).size).toBe(PAYABLES_AGING_BUCKETS.length)
  })

  it('names the same buckets in the same order in both packages', () => {
    expect([...DB_PAYABLES_AGING_BUCKETS]).toEqual([...PAYABLES_AGING_BUCKETS])
  })

  it('matches the committed worked example exactly, to the fils and to the reference', async () => {
    const runCodes = new Set(FIXTURE_SUPPLIERS.map((s) => codeFor(s.code)))
    const outstanding = (await outstandingPayables(sql, FIXTURE_TODAY)).filter((row) =>
      runCodes.has(row.supplierCode),
    )
    // Vacuity guard: the filter must actually match this run's bills, or every bucket below is an empty
    // list agreeing with an empty list.
    expect(outstanding).toHaveLength(FIXTURE_BILL_SHAPES.length)

    const payables: readonly PayableForAging[] = outstanding.map((row) => ({
      // The supplier's own invoice number, because our internal reference comes from a counter whose
      // value depends on how many bills the database has ever issued.
      reference: row.supplierReference,
      supplierCode: row.supplierCode,
      dueDate: localDate(row.dueDate),
      outstanding: money(filsFrom(Number(row.outstandingFils))),
    }))
    const aging = agePayables(FIXTURE_TODAY, payables)

    expect(
      aging.rows.map((row) => ({
        bucket: row.bucket,
        totalFils: row.total.fils,
        supplierReferences: row.references,
      })),
    ).toEqual(
      FIXTURE_PAYABLES_AGING.map((row) => ({
        bucket: row.bucket,
        totalFils: row.totalFils,
        supplierReferences: [...row.supplierReferences],
      })),
    )
    expect(aging.total.fils).toBe(FIXTURE_PAYABLES_TOTAL_FILS)

    // The bucket the SQL function put each row in is the bucket core would: the same comparison as the
    // boundary sweep above, but on the rows the report actually returned.
    for (const row of outstanding) {
      expect(row.bucket).toBe(payablesBucketFor(localDate(row.dueDate), FIXTURE_TODAY))
    }

    // And every gross is the committed one, read back through the aging query rather than the bill.
    const byReference = new Map(
      outstanding.map((row) => [row.supplierReference, row.outstandingFils]),
    )
    for (const shape of FIXTURE_BILL_SHAPES) {
      expect(byReference.get(shape.supplierReference)).toBe(BigInt(grossOf(shape).fils))
    }
  })

  it('totals a single supplier in the database and ties to the detail', async () => {
    // The grouped query, scoped to one supplier so the figures are this run's alone: the landlord has a
    // bill not yet due and one ten days overdue, which is the smallest report that spans two buckets.
    const landlord = codeFor('fixture-registered-landlord')
    const report = await payablesAging(sql, FIXTURE_TODAY, { supplierCode: landlord })
    const detail = await outstandingPayables(sql, FIXTURE_TODAY, { supplierCode: landlord })

    expect(report.rows.map((row) => row.bucket)).toEqual([...PAYABLES_AGING_BUCKETS])
    expect(report.billCount).toBe(2)
    expect(report.totalFils).toBe(2_100_000n + 315_000n)
    expect(report.rows.find((row) => row.bucket === 'current')?.totalFils).toBe(315_000n)
    expect(report.rows.find((row) => row.bucket === 'days_1_30')?.totalFils).toBe(2_100_000n)
    // Summary ties to detail: the totals are summed by PostgreSQL and the rows are listed by it, and an
    // aging report whose two halves disagree is worse than one that is merely wrong.
    expect(detail.reduce((total, row) => total + row.outstandingFils, 0n)).toBe(report.totalFils)
    expect(detail).toHaveLength(report.billCount)
  })
})

describe('the entry date is the business day, not a truncated instant', () => {
  it('files a bill entered at 01:30 under the previous trading date', async () => {
    // Trading runs 11:00–02:00, so 01:30 on the 19th is inside the 18th's session. A date derived by
    // truncating the instant would file the bill on the 19th — and at a period boundary, into a period
    // that has already been filed.
    expect(crossesMidnight(FIXTURE_HOURS)).toBe(true)
    const lateNight = instantFromIso('2026-09-18T21:30:00.000Z') // 01:30 on the 19th, Gulf time
    const resolved = resolveTradingDate(lateNight, hoursFor)
    expect(resolved.kind).toBe('trading')
    const tradingDate = (resolved as { date: LocalDate }).date
    expect(tradingDate).toBe(FIXTURE_TODAY)

    const bill = await post({
      supplierId: supplierIds.get('fixture-registered-landlord') as string,
      supplierReference: 'FIX-LATE-NIGHT-0001',
      billDate: FIXTURE_TODAY,
      dueDate: FIXTURE_TODAY,
      entryDate: tradingDate,
      receivedBy: 'm-vat-01-pair-itest',
      lines: [
        {
          description: 'Emergency plumbing call-out',
          expenseAccountCode: ACCOUNTS.repairsAndMaintenance,
          taxTreatment: 'standard_recoverable',
          vatRateBp: 500,
          grossFils: 21_000,
          netFils: 20_000,
        },
      ],
    })
    const entry = await readJournalEntry(sql, bill.entryId)
    expect(entry?.entryDate).toBe(FIXTURE_TODAY)

    // The control, and it is what makes the case above mean anything: 11:30 that same morning resolves to
    // the same date, so the shift is the after-midnight rule rather than a constant offset applied to
    // every instant.
    const morning = resolveTradingDate(instantFromIso('2026-09-18T07:30:00.000Z'), hoursFor)
    expect((morning as { date: LocalDate }).date).toBe(FIXTURE_TODAY)
    // And 01:30 the following night belongs to the 19th, not to the 18th.
    const nextNight = resolveTradingDate(instantFromIso('2026-09-19T21:30:00.000Z'), hoursFor)
    expect((nextNight as { date: LocalDate }).date).toBe(localDate('2026-09-19'))
  })
})

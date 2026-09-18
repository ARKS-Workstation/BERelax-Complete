import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { isBalanced, trialBalanceAsAt } from '../queries/trial-balance.ts'
import { lockAccountingPeriod, readJournalEntry } from '../repositories/journal.ts'
import { findNumberingGaps, listDocumentSeries } from '../repositories/numbering.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  BILL_SERIES_CODE,
  type BillToPost,
  findSupplierByCode,
  isDuplicateSupplierReference,
  isInputVatWithoutTrn,
  PURCHASES_SQLSTATE,
  postBill,
  purchaseError,
  RECOVERABLE_INPUT_VAT_ACCOUNT_CODE,
  readBill,
  recordSupplier,
  TRADE_PAYABLES_ACCOUNT_CODE,
} from './post-bill.ts'

/**
 * M-VAT-01 — suppliers, bills and payables against real PostgreSQL.
 *
 * Everything here is a guarantee that cannot be tested any other way: a `not null` with no default, a
 * unique constraint, four triggers, a set of grants, and a posting that has to balance to the fils. The
 * pure half — the gross/net/VAT derivation and the aging boundaries — is
 * `packages/core/src/purchases/*.test.ts`, and the two are proved to agree in
 * `packages/fixtures/src/purchases.itest.ts`, the one package allowed to depend on both.
 *
 * ## Nothing here deletes a posting, and every total is a delta
 *
 * `bill`, `bill_line` and the journal are append-only, and their refusal triggers refuse the **owner**
 * too — so a reset between tests is impossible by construction, not merely discouraged (ADR 0008). Every
 * figure below is therefore a difference measured across this suite's own writes, and every supplier code
 * and supplier reference carries a per-run suffix so a second run against the same database collides with
 * nothing.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR = { kind: 'system', label: 'm-vat-01-itest' } as const

/** Unique per run: the bills this suite writes can never be deleted. */
const RUN = Date.now().toString(36)
/** The frozen clock of the fixture world, and a date that is in an open period by definition. */
const TODAY = '2026-09-18'

const TRN = '000000000000003'

let sql: Sql
let registeredSupplierId = ''
let unregisteredSupplierId = ''

const supplierCode = (suffix: string) => `itest-mvat01-${suffix}-${RUN}`
const reference = (suffix: string) => `MVAT01-${suffix}-${RUN}`

async function newSupplier(suffix: string, trn: string | null): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const supplier = await recordSupplier(uow, {
      code: supplierCode(suffix),
      // A company, and unmistakably not a real one. Suppliers are companies rather than people, but a
      // plausible company name is the same liability: it gets exported and eventually paid.
      legalName: `FIXTURE (not a real supplier) — ${suffix}`,
      residency: 'domestic',
      placeOfSupplyRule: 'domestic_uae',
      trn,
    })
    return supplier.supplierId
  })
}

/** A one-line bill of the given shape, with dates that sit in an open period. */
function billOf(overrides: Partial<BillToPost> & { supplierId: string }): BillToPost {
  return {
    supplierReference: reference('DEFAULT'),
    billDate: TODAY,
    dueDate: TODAY,
    entryDate: TODAY,
    receivedBy: 'm-vat-01-itest',
    lines: [
      {
        description: 'Premises rent',
        expenseAccountCode: '6010',
        taxTreatment: 'standard_recoverable',
        grossFils: 2_100_000,
        netFils: 2_000_000,
      },
    ],
    ...overrides,
  }
}

/** Every internal number this suite has issued, in the order it issued them. See the gap case below. */
const issued: number[] = []

async function post(bill: BillToPost) {
  try {
    const result = await withUnitOfWork(sql, ACTOR, (uow) => postBill(uow, bill))
    issued.push(result.number)
    return result
  } catch (err) {
    // The translation belongs around the transaction, because the deferred triggers raise at COMMIT and
    // no function inside postBill executes it.
    throw purchaseError(err) ?? err
  }
}

/** The error a statement raised, or undefined when it was accepted. */
async function rejection(
  run: () => Promise<unknown>,
): Promise<{ code: string; constraint: string; message: string } | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const e = error as { code?: string; constraint_name?: string; message?: string }
    return { code: e.code ?? '', constraint: e.constraint_name ?? '', message: e.message ?? '' }
  }
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  registeredSupplierId = await newSupplier('registered', TRN)
  unregisteredSupplierId = await newSupplier('unregistered', null)
}, 60_000)

afterAll(async () => {
  // The suppliers stay: a bill references them, and the whole point of the snapshot is that a supplier
  // cannot be edited out from under a posted bill. Only the opening-balance fixture is removed, because
  // it is a guard rather than a posting and leaving it would refuse every other suite's backdated entry.
  await sql`delete from opening_balance_import where entry_id = ${`JE-OPEN-MVAT01-${RUN}`}`
  await sql.end({ timeout: 5 })
})

describe('acceptance — supplier_tax_profile.residency is explicit', () => {
  it('is NOT NULL and carries no default', async () => {
    const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'supplier_tax_profile'
        and column_name = 'residency'
    `
    expect(column?.is_nullable).toBe('NO')
    // No default either. Defaulting to domestic drops the reverse charge on every offshore bill, and
    // defaulting to offshore invents one on the landlord: there is no safe value to pick.
    expect(column?.column_default).toBeNull()

    // The control: the same query over a column that IS nullable returns YES, so the assertion above is
    // reading the catalogue rather than an empty result.
    const [nullable] = await sql<{ is_nullable: string }[]>`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'supplier_tax_profile' and column_name = 'trn'
    `
    expect(nullable?.is_nullable).toBe('YES')
  })

  it('constrains residency to domestic or offshore, and place of supply to match it', async () => {
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'supplier_tax_profile'::regclass
        and conname = 'supplier_tax_profile_residency_check'
    `
    expect(check?.def).toContain('domestic')
    expect(check?.def).toContain('offshore')
    // Exactly two values. A third slipping in silently is how 'unknown' becomes a residency.
    expect(check?.def.match(/'[a-z_]+'::text/g)).toHaveLength(2)

    const mismatched = await rejection(
      () => sql`
        with s as (
          insert into supplier (code, legal_name)
          values (${supplierCode('mismatch')}, 'FIXTURE (not a real supplier) — mismatch')
          returning supplier_id
        )
        insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn)
        select supplier_id, 'domestic', 'imported_services_reverse_charge', null from s
      `,
    )
    expect(mismatched?.constraint).toBe('supplier_tax_profile_rule_matches_residency')
  })

  it('every seeded supplier states a residency, and the five offshore vendors are offshore', async () => {
    const rows = await sql<{ code: string; residency: string | null }[]>`
      select s.code, p.residency
      from supplier s left join supplier_tax_profile p on p.supplier_id = s.supplier_id
    `
    // Vacuity guard first: an empty table would satisfy "every row states a residency".
    expect(rows.length).toBeGreaterThanOrEqual(5)
    for (const row of rows) {
      expect(['domestic', 'offshore']).toContain(row.residency)
    }
    const seeded = new Map(rows.map((row) => [row.code, row.residency]))
    for (const vendor of ['digitalocean', 'resend', 'google', 'meta', 'anthropic']) {
      expect(seeded.get(vendor)).toBe('offshore')
    }
  })

  it('refuses a supplier with no tax profile at COMMIT, naming it', async () => {
    // Deferred, because the profile is a second INSERT — so the refusal is forced with `set constraints
    // all immediate` inside a transaction that rolls back, which is also a second proof that it really is
    // deferred: an immediate trigger would have raised at the INSERT before that statement was reached.
    const refused = await rejection(() =>
      sql.begin(async (tx) => {
        await tx`
          insert into supplier (code, legal_name)
          values (${supplierCode('orphan')}, 'FIXTURE (not a real supplier) — orphan')
        `
        await tx`set constraints all immediate`
      }),
    )
    expect(refused?.code).toBe(PURCHASES_SQLSTATE.supplierHasNoTaxProfile)
    expect(refused?.message).toContain('SupplierHasNoTaxProfile')
    expect(refused?.message).toContain(supplierCode('orphan'))

    // The control: the same insert WITH a profile commits, so the refusal is about the missing profile
    // rather than about `set constraints all immediate` failing everything.
    const accepted = await rejection(() =>
      sql.begin(async (tx) => {
        const [row] = await tx<{ supplier_id: string }[]>`
          insert into supplier (code, legal_name)
          values (${supplierCode('paired')}, 'FIXTURE (not a real supplier) — paired')
          returning supplier_id::text as supplier_id
        `
        await tx`
          insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule)
          values (${row?.supplier_id as string}::uuid, 'domestic', 'domestic_uae')
        `
        await tx`set constraints all immediate`
        // Rolled back by raising, so the control leaves nothing behind either.
        throw new Error('rollback the control')
      }),
    )
    expect(accepted?.message).toBe('rollback the control')
  })
})

describe('acceptance — a bill posts Dr expense, Dr recoverable input VAT, Cr payables', () => {
  it('posts the three lines, balances, and leaves the trial balance balanced', async () => {
    const before = await trialBalanceAsAt(sql, TODAY)
    const posted = await post(
      billOf({
        supplierId: registeredSupplierId,
        supplierReference: reference('RENT'),
        dueDate: '2026-10-18',
      }),
    )

    expect(posted.netFils).toBe(2_000_000)
    expect(posted.vatFils).toBe(100_000)
    expect(posted.grossFils).toBe(2_100_000)
    expect(posted.recoverableInputVatFils).toBe(100_000)
    // net + vat === gross, exactly, from the row the database stored rather than from the input.
    const stored = await readBill(sql, posted.billId)
    expect((stored?.netFils ?? 0) + (stored?.vatFils ?? 0)).toBe(stored?.grossFils)
    expect(stored?.supplierTrn).toBe(TRN)
    expect(stored?.supplierResidency).toBe('domestic')

    const entry = await readJournalEntry(sql, posted.entryId)
    expect(entry?.source).toBe('supplier_bill')
    expect(entry?.entryDate).toBe(TODAY)
    expect(entry?.lines.map((line) => [line.accountCode, line.debitFils, line.creditFils])).toEqual(
      [
        ['6010', 2_000_000, 0],
        [RECOVERABLE_INPUT_VAT_ACCOUNT_CODE, 100_000, 0],
        [TRADE_PAYABLES_ACCOUNT_CODE, 0, 2_100_000],
      ],
    )

    const after = await trialBalanceAsAt(sql, TODAY)
    expect(isBalanced(after)).toBe(true)
    // A delta, never a total: other suites post into this ledger and nothing here may be deleted.
    expect(after.totalDebitFils - before.totalDebitFils).toBe(2_100_000n)
    expect(after.totalCreditFils - before.totalCreditFils).toBe(2_100_000n)
  })

  it('posts a bill from a supplier with no TRN without claiming anything', async () => {
    // The case the unit exists for. Below the registration threshold an unregistered supplier is normal,
    // and a system that refused the bill is a system somebody keeps in a spreadsheet instead.
    const posted = await post(
      billOf({
        supplierId: unregisteredSupplierId,
        supplierReference: reference('LAUNDRY'),
        lines: [
          {
            description: 'Linen laundry, weekly',
            expenseAccountCode: '6050',
            taxTreatment: 'no_trn_not_recoverable',
            grossFils: 63_000,
            netFils: 63_000,
          },
        ],
      }),
    )
    expect(posted.supplierTrn).toBeNull()
    expect(posted.recoverableInputVatFils).toBe(0)
    expect(posted.vatFils).toBe(0)

    const entry = await readJournalEntry(sql, posted.entryId)
    // Two lines, not three: a zero VAT debit is not a posting, and journal_line_exactly_one_side would
    // refuse it anyway.
    expect(entry?.lines).toHaveLength(2)
    expect(entry?.lines.map((line) => line.accountCode)).toEqual([
      '6050',
      TRADE_PAYABLES_ACCOUNT_CODE,
    ])
  })

  it('refuses a claim from a supplier with no TRN, explaining it rather than raising a SQLSTATE', async () => {
    const refused = await rejection(() =>
      post(
        billOf({
          supplierId: unregisteredSupplierId,
          supplierReference: reference('CLAIM-NO-TRN'),
          lines: [
            {
              description: 'Cleaning materials',
              expenseAccountCode: '6050',
              taxTreatment: 'standard_recoverable',
              grossFils: 10_500,
              netFils: 10_000,
            },
          ],
        }),
      ),
    )
    expect(refused?.message).toContain('claims input VAT on line(s) 1')
    expect(refused?.message).toContain('held no TRN')
    expect(refused?.message).toContain('no_trn_not_recoverable')

    // Nothing was written: not the bill, and not a number out of the gapless range.
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from bill where supplier_reference = ${reference('CLAIM-NO-TRN')}
    `
    expect(count?.n).toBe('0')
  })

  it('refuses a recoverable line under a TRN-less bill in the database too, by SQLSTATE', async () => {
    // The layer below the service. The refusal above is a sentence a person can act on; this is the one
    // that holds when the statement does not come from this service at all.
    const refused = await rejection(() =>
      sql.begin(async (tx) => {
        const [entry] = await tx<{ entry_id: string }[]>`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`JE-ZV001-${RUN}`}, ${TODAY}::date, 'zv001 probe', 'supplier_bill')
          returning entry_id
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
          values (${entry?.entry_id as string}, 1, '6050', 10_500, 0),
                 (${entry?.entry_id as string}, 2, '2010', 0, 10_500)
        `
        const [bill] = await tx<{ bill_id: string }[]>`
          insert into bill (
            supplier_id, supplier_reference, series_code, period_key, number, display_number,
            bill_date, due_date, entry_id, net_fils, gross_fils, recoverable_input_vat_fils, received_by
          ) values (
            ${unregisteredSupplierId}::uuid, ${reference('ZV001')}, ${BILL_SERIES_CODE}, '2026',
            999999, ${`BILL-PROBE-${RUN}`}, ${TODAY}::date, ${TODAY}::date,
            ${entry?.entry_id as string}, 10_000, 10_500, 0, 'probe'
          )
          returning bill_id::text as bill_id
        `
        await tx`
          insert into bill_line (
            bill_id, line_no, description, expense_account_code, tax_treatment, vat_rate_bp,
            net_fils, gross_fils, recoverable_input_vat_fils
          ) values (
            ${bill?.bill_id as string}::uuid, 1, 'Cleaning', '6050', 'standard_recoverable', 500,
            10_000, 10_500, 500
          )
        `
      }),
    )
    expect(refused?.code).toBe(PURCHASES_SQLSTATE.inputVatWithoutSupplierTrn)
    expect(isInputVatWithoutTrn({ code: refused?.code })).toBe(true)
    expect(purchaseError({ code: refused?.code, message: refused?.message })?.kind).toBe(
      'validation',
    )
  })

  it('refuses a header total that disagrees with its lines, at COMMIT', async () => {
    const refused = await rejection(() =>
      sql.begin(async (tx) => {
        const [entry] = await tx<{ entry_id: string }[]>`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`JE-ZV002-${RUN}`}, ${TODAY}::date, 'zv002 probe', 'supplier_bill')
          returning entry_id
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
          values (${entry?.entry_id as string}, 1, '6050', 9_000, 0),
                 (${entry?.entry_id as string}, 2, '2010', 0, 9_000)
        `
        const [bill] = await tx<{ bill_id: string }[]>`
          insert into bill (
            supplier_id, supplier_reference, series_code, period_key, number, display_number,
            bill_date, due_date, entry_id, net_fils, gross_fils, recoverable_input_vat_fils, received_by
          ) values (
            ${unregisteredSupplierId}::uuid, ${reference('ZV002')}, ${BILL_SERIES_CODE}, '2026',
            999998, ${`BILL-PROBE2-${RUN}`}, ${TODAY}::date, ${TODAY}::date,
            ${entry?.entry_id as string}, 10_000, 10_000, 0, 'probe'
          )
          returning bill_id::text as bill_id
        `
        await tx`
          insert into bill_line (
            bill_id, line_no, description, expense_account_code, tax_treatment, vat_rate_bp,
            net_fils, gross_fils, recoverable_input_vat_fils
          ) values (
            ${bill?.bill_id as string}::uuid, 1, 'Cleaning', '6050', 'no_trn_not_recoverable', 0,
            9_000, 9_000, 0
          )
        `
        await tx`set constraints all immediate`
      }),
    )
    expect(refused?.code).toBe(PURCHASES_SQLSTATE.billTotalsDoNotMatchLines)
    expect(refused?.message).toContain('header says net 10000')
  })
})

describe('acceptance — a duplicate (supplier_id, supplier_reference) is refused', () => {
  it('accepts the first and refuses the second by constraint name', async () => {
    const bill = billOf({
      supplierId: registeredSupplierId,
      supplierReference: reference('DUPLICATE'),
      lines: [
        {
          description: 'Consumables',
          expenseAccountCode: '6030',
          taxTreatment: 'standard_recoverable',
          grossFils: 52_500,
          netFils: 50_000,
        },
      ],
    })
    const first = await post(bill)
    expect(first.billId).toBeTruthy()

    const refused = await rejection(() => post(bill))
    // By name, because a bare failure is also what a typo in a column name produces — and this is the
    // duplicate every accounts-payable process exists to catch: paid twice, VAT claimed twice.
    expect(refused?.message).toContain('bill_supplier_reference_unique')
    expect(
      isDuplicateSupplierReference({
        code: '23505',
        constraint_name: 'bill_supplier_reference_unique',
      }),
    ).toBe(true)

    // The control: the SAME reference under a DIFFERENT supplier is not a duplicate. Two suppliers
    // numbering their invoices '001' is the normal case, and a global unique key would refuse it.
    const other = await post(
      billOf({
        supplierId: unregisteredSupplierId,
        supplierReference: reference('DUPLICATE'),
        lines: [
          {
            description: 'Cleaning',
            expenseAccountCode: '6050',
            taxTreatment: 'no_trn_not_recoverable',
            grossFils: 5_000,
            netFils: 5_000,
          },
        ],
      }),
    )
    expect(other.supplierReference).toBe(reference('DUPLICATE'))
  })
})

describe('acceptance — a bill dated inside a locked period is refused with PeriodLocked', () => {
  const LOCKED_PERIOD = `mvat01-${RUN}`
  /** Filled in below: a range no existing lock covers. */
  let lockStart = ''
  let inside = ''
  let afterLock = ''

  it('refuses the posting, writes nothing, and says which period is locked', async () => {
    // The range is chosen AFTER the last lock in the database rather than at a fixed date.
    // `period_lock_no_overlap` is an exclusion constraint, so a second run of this suite — or any other
    // suite that locks a period — would otherwise fail on the lock itself, and the failure would be
    // reported against the bill this test is actually about. A lock is administrative rather than a
    // posting, but the application role holds no DELETE on it and reopening a period is deliberately not
    // something a code path does, so the range moves instead.
    const [last] = await sql<{ next_start: string; inside: string; after: string }[]>`
      select (coalesce(max(ends_on), '2026-12-31'::date) + 1)::text  as next_start,
             (coalesce(max(ends_on), '2026-12-31'::date) + 15)::text as inside,
             (coalesce(max(ends_on), '2026-12-31'::date) + 31)::text as after
      from period_lock
    `
    lockStart = last?.next_start as string
    inside = last?.inside as string
    afterLock = last?.after as string

    await withUnitOfWork(sql, ACTOR, (uow) =>
      lockAccountingPeriod(uow, {
        periodId: LOCKED_PERIOD,
        startsOn: lockStart,
        endsOn: inside,
        reason: 'm-vat-01 itest: a closed period to post into',
        lockedByActorKind: 'system',
      }),
    )

    const [billsBefore] = await sql<{ n: string }[]>`select count(*)::text as n from bill`
    const [seriesBefore] = await sql<{ next_number: string }[]>`
      select next_number::text as next_number from document_series where code = ${BILL_SERIES_CODE}
    `

    const refused = await rejection(() =>
      post(
        billOf({
          supplierId: registeredSupplierId,
          supplierReference: reference('LOCKED'),
          billDate: inside,
          dueDate: inside,
          entryDate: inside,
        }),
      ),
    )
    expect(refused?.message).toContain('PeriodLocked')
    expect(refused?.message).toContain(LOCKED_PERIOD)

    // Writes nothing. Three things are asserted rather than one, because "nothing was written" is a
    // claim about the whole transaction: no bill, no journal entry, and — because the number is
    // allocated before the entry is posted — no hole in the gapless range either.
    const [billsAfter] = await sql<{ n: string }[]>`select count(*)::text as n from bill`
    expect(billsAfter?.n).toBe(billsBefore?.n)
    const [entries] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entry where entry_date = ${inside}::date
    `
    expect(entries?.n).toBe('0')
    const [seriesAfter] = await sql<{ next_number: string }[]>`
      select next_number::text as next_number from document_series where code = ${BILL_SERIES_CODE}
    `
    expect(seriesAfter?.next_number).toBe(seriesBefore?.next_number)

    // The control: the same bill one day after the lock ends posts, so the refusal is the lock and not
    // the date being in 2027.
    const accepted = await post(
      billOf({
        supplierId: registeredSupplierId,
        supplierReference: reference('AFTER-LOCK'),
        billDate: afterLock,
        dueDate: afterLock,
        entryDate: afterLock,
      }),
    )
    // The same unbroken range whatever a bill is dated: the series resets never.
    expect(accepted.periodKey).toBe('')
    expect(accepted.billDate).toBe(afterLock)
  })

  it('leaves our own reference range gap-free across a refused bill', async () => {
    // The whole reason the number comes from a locked counter row rather than a sequence: the refused
    // bill above allocated a number inside a transaction that rolled back, and the number came back. So
    // did the one the duplicate-reference refusal allocated — that one failed AFTER the allocation, which
    // is precisely the case a SEQUENCE gets wrong.
    //
    // Asserted over the numbers THIS suite issued rather than over the whole table, and that is not
    // fussiness: M-TILL-02's journal suite runs `truncate journal_line, journal_entry cascade`, and
    // `bill.entry_id` references `journal_entry` — so the cascade empties the purchase ledger while the
    // counter keeps its value, and a whole-table gap report then shows a hole that no numbering defect
    // produced. A delta is correct whatever else has run (ADR 0008).
    const mine = [...issued].sort((a, b) => a - b)
    expect(mine.length).toBeGreaterThan(2)
    for (let i = 1; i < mine.length; i += 1) {
      expect(mine[i]).toBe((mine[i - 1] as number) + 1)
    }

    // And the gap report itself, which is what an auditor asks: no run of ours starts late. This also
    // asserts that `bill` exposes the four columns NUMBERING_LEDGER_COLUMNS names, since a missing one
    // would make the query fail rather than return nothing.
    const first = mine[0] as number
    const last = mine[mine.length - 1] as number
    const gapsInside = (await findNumberingGaps(sql, 'bill')).filter(
      (gap) =>
        gap.seriesCode === BILL_SERIES_CODE && gap.firstNumber > first && gap.firstNumber <= last,
    )
    expect(gapsInside).toEqual([])
  })
})

describe('acceptance — the line carries its tax treatment, and nothing may edit it', () => {
  let billId = ''
  let lineTreatment = ''

  beforeAll(async () => {
    const posted = await post(
      billOf({
        supplierId: registeredSupplierId,
        supplierReference: reference('IMMUTABLE'),
        lines: [
          {
            description: 'Treatment consumables',
            expenseAccountCode: '6030',
            taxTreatment: 'standard_recoverable',
            grossFils: 52_500,
            netFils: 50_000,
          },
          {
            description: 'Municipality inspection fee',
            expenseAccountCode: '6120',
            taxTreatment: 'out_of_scope',
            grossFils: 20_000,
            netFils: 20_000,
          },
        ],
      }),
    )
    billId = posted.billId
    lineTreatment = posted.lines[0]?.taxTreatment ?? ''
  })

  it('stores the treatment and the rate on each line, not on the bill', async () => {
    expect(lineTreatment).toBe('standard_recoverable')
    const stored = await readBill(sql, billId)
    expect(
      stored?.lines.map((line) => [
        line.taxTreatment,
        line.vatRateBp,
        line.recoverableInputVatFils,
      ]),
    ).toEqual([
      ['standard_recoverable', 500, 2_500],
      ['out_of_scope', 0, 0],
    ])
    // The header is the sum of the lines and the claim is only the recoverable line's VAT.
    expect(stored?.recoverableInputVatFils).toBe(2_500)
    expect(stored?.vatFils).toBe(2_500)

    // There is no treatment column on the bill itself: one bill mixes treatments, and a bill-level one
    // would force the preparer to split the invoice by hand or claim the wrong figure.
    const billColumns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'bill'
    `
    expect(billColumns.map((c) => c.column_name)).not.toContain('tax_treatment')
    // Control: the same query finds the column on bill_line, so the absence above is real.
    const lineColumns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'bill_line'
    `
    expect(lineColumns.map((c) => c.column_name)).toContain('tax_treatment')
  })

  it('holds no UPDATE, DELETE or TRUNCATE grant on bill_line for the application role', async () => {
    const [priv] = await sql<
      { sel: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean }[]
    >`
      select has_table_privilege('berelax_app', 'bill_line', 'SELECT')   as sel,
             has_table_privilege('berelax_app', 'bill_line', 'INSERT')   as ins,
             has_table_privilege('berelax_app', 'bill_line', 'UPDATE')   as upd,
             has_table_privilege('berelax_app', 'bill_line', 'DELETE')   as del,
             has_table_privilege('berelax_app', 'bill_line', 'TRUNCATE') as trunc
    `
    expect(priv?.upd).toBe(false)
    expect(priv?.del).toBe(false)
    expect(priv?.trunc).toBe(false)
    // The control: SELECT and INSERT are held, so the three falses are a revoke rather than a role with
    // no access at all.
    expect(priv?.sel).toBe(true)
    expect(priv?.ins).toBe(true)

    // Asserted from information_schema as well, because that is what the acceptance asks for and it
    // reads the grant itself rather than the effective answer for one role.
    const grants = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where grantee = 'berelax_app' and table_name = 'bill_line'
    `
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(['INSERT', 'SELECT'])
  })

  it('refuses an UPDATE of a line for the owner too, which a privilege cannot cover', async () => {
    // A migration, a psql session and any future admin tool connect as the owner, and the owner is who
    // reclassifies a filed line by hand at 2am.
    const [me] = await sql<{ me: string }[]>`select current_user as me`
    expect(me?.me).not.toBe('berelax_app')

    const updated = await rejection(
      () => sql`
        update bill_line set tax_treatment = 'no_trn_not_recoverable' where bill_id = ${billId}::uuid
      `,
    )
    expect(updated?.code).toBe(PURCHASES_SQLSTATE.appendOnly)
    expect(updated?.message).toContain('append-only')

    const deleted = await rejection(
      () => sql`delete from bill_line where bill_id = ${billId}::uuid`,
    )
    expect(deleted?.code).toBe(PURCHASES_SQLSTATE.appendOnly)

    const billUpdated = await rejection(
      () => sql`update bill set received_by = 'somebody else' where bill_id = ${billId}::uuid`,
    )
    expect(billUpdated?.code).toBe(PURCHASES_SQLSTATE.appendOnly)

    // The control: the treatment is still what it was, so the refusals above are refusals rather than
    // silent no-ops. `create rule ... do instead nothing` would have reported success here.
    const stored = await readBill(sql, billId)
    expect(stored?.lines[0]?.taxTreatment).toBe('standard_recoverable')
    expect(stored?.lines).toHaveLength(2)
  })

  it('lets an admin correct a supplier, and the bill keeps the TRN it was recorded with', async () => {
    // The other half of the immutability argument: the supplier IS editable, because a TRN arrives when
    // they register and a name is misspelled on the day it is created. What must not move is the
    // snapshot on the bill — a supplier registering in March cannot make January recoverable.
    const before = await readBill(sql, billId)
    await sql`
      update supplier_tax_profile set trn = '000000000000011'
      where supplier_id = ${registeredSupplierId}::uuid
    `
    const after = await readBill(sql, billId)
    expect(after?.supplierTrn).toBe(before?.supplierTrn)
    expect(after?.supplierTrn).toBe(TRN)
    const supplier = await findSupplierByCode(sql, supplierCode('registered'))
    expect(supplier?.trn).toBe('000000000000011')
    // Put it back, so a later test in this file reads the TRN it was set up with.
    await sql`
      update supplier_tax_profile set trn = ${TRN} where supplier_id = ${registeredSupplierId}::uuid
    `
  })
})

describe('the numbering series, and the guard before the books open', () => {
  it('issues our own gapless reference alongside the supplier one', async () => {
    const posted = await post(
      billOf({
        supplierId: registeredSupplierId,
        supplierReference: reference('NUMBERED'),
        lines: [
          {
            description: 'Retail stock',
            expenseAccountCode: '6040',
            taxTreatment: 'standard_recoverable',
            grossFils: 10_501,
            netFils: 10_001,
          },
        ],
      }),
    )
    expect(posted.seriesCode).toBe(BILL_SERIES_CODE)
    // 'BILL-00001', with no year: the series resets never, because one counter row holds one period key
    // and an annual reset re-issues a number when a bill dated in the previous period arrives after one
    // dated in the next — which for purchase invoices is the normal case, not an edge case.
    expect(posted.displayNumber).toMatch(/^BILL-\d{5,}$/)
    expect(posted.periodKey).toBe('')
    // The odd-fils shape, from the database rather than from the input: the remainder is the VAT.
    expect(posted.netFils + posted.vatFils).toBe(10_501)
    expect(posted.recoverableInputVatFils).toBe(500)

    const series = await listDocumentSeries(sql)
    expect(series.find((s) => s.code === BILL_SERIES_CODE)?.documentKind).toBe('supplier_bill')
  })

  it('explains a bill dated before the books open instead of surfacing ZL004', async () => {
    // A far-future opening date makes every plausible posting "before the books open", so this test
    // creates it, uses it and removes it — and `afterAll` removes it again, because leaving it behind
    // would refuse every backdated entry in every other suite.
    const openingEntry = `JE-OPEN-MVAT01-${RUN}`
    await sql`
      insert into legal_entity (id, legal_name, trading_name)
      values (1, 'BE RELAX Massage Center and Spa LLC', 'BE RELAX')
      on conflict (id) do nothing
    `
    // One transaction: the balance trigger in 0018 is deferred to COMMIT, so an entry inserted on its own
    // fails there with "0 line(s)" before its lines can arrive.
    await sql.begin(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${openingEntry}, '2099-01-01', 'm-vat-01 itest opening fixture', 'opening_balance')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${openingEntry}, 1, '1010', 1, 0), (${openingEntry}, 2, '3010', 0, 1)
      `
      await tx`
        insert into opening_balance_import
          (legal_entity_id, opening_date, entry_id, total_debit_fils, total_credit_fils, imported_by)
        values (1, '2099-01-01', ${openingEntry}, 1, 1, 'm-vat-01-itest')
      `
    })

    try {
      const refused = await rejection(() =>
        post(
          billOf({
            supplierId: registeredSupplierId,
            supplierReference: reference('BEFORE-OPENING'),
          }),
        ),
      )
      expect(refused?.message).toContain('BeforeOpeningBalance')
      // The explanation, not the code: a bookkeeper reading "ZL004" learns nothing about the invoice in
      // their hand.
      expect(refused?.message).toContain('count the cost twice')
      // Once, not twice: purchaseError is applied inside postBill and again around the transaction, so
      // an explanation appended on both passes would reach the reader duplicated.
      expect(refused?.message.match(/count the cost twice/g)).toHaveLength(1)
      expect(refused?.message).toContain('2099-01-01')
      expect(purchaseError({ code: 'ZL004', message: 'BeforeOpeningBalance: ...' })?.kind).toBe(
        'conflict',
      )
    } finally {
      await sql`delete from opening_balance_import where entry_id = ${openingEntry}`
    }

    // The control: with the guard gone the same bill posts, so the refusal was the opening date.
    const accepted = await post(
      billOf({ supplierId: registeredSupplierId, supplierReference: reference('AFTER-OPENING') }),
    )
    expect(accepted.grossFils).toBe(2_100_000)
  })

  it('records an audit row and one outbox event per posted bill', async () => {
    const posted = await post(
      billOf({
        supplierId: registeredSupplierId,
        supplierReference: reference('AUDITED'),
      }),
    )
    const [audited] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where action = 'purchases.bill.posted' and entity_id = ${posted.billId}
    `
    expect(audited?.n).toBe('1')
    const [published] = await sql<{ n: string; key: string }[]>`
      select count(*)::text as n, min(idempotency_key) as key from outbox_event
      where event_type = 'purchases.bill.posted' and aggregate_id = ${posted.billId}
    `
    expect(published?.n).toBe('1')
    // Derived from the business fact, so a retry of the same posting cannot enqueue twice.
    expect(published?.key).toBe(
      `purchases.bill.posted:${registeredSupplierId}:${reference('AUDITED')}`,
    )
  })
})

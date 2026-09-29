import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CASH_FAMILY_TABLES,
  COMMISSION_FAMILY_TABLES,
  CREDIT_NOTE_FAMILY_TABLES,
  DOCUMENT_FAMILY_TABLES,
  INVOICE_FAMILY_TABLES,
  PACKAGE_FAMILY_TABLES,
  truncateCashFamily,
  truncateCommissionFamily,
  truncateDocumentFamily,
  truncateInvoiceFamily,
  truncatePackageFamily,
} from './invoice-family.ts'

/**
 * The written list and the live schema, held equal.
 *
 * `INVOICE_FAMILY_TABLES` is what ten suites now use to empty the invoice family. Its failure mode is silence:
 * a migration adds a table with a foreign key into the family, every suite that does not write invoices keeps
 * passing, and the one that does fails in its TEARDOWN with `cannot truncate a table referenced in a foreign
 * key constraint` — after all of its assertions have passed, which is the least useful place in a run for that
 * sentence to appear. That is exactly how P-HR-11's `commission_line` was found.
 *
 * So this case derives the set from `pg_constraint`, transitively, and compares. A derived answer would have
 * been the obvious design for the helper itself and is refused there for a stated reason — a teardown that
 * discovers its own scope empties tables it does not own — but a CHECK is precisely where a derivation
 * belongs: it names the missing table, in a file about the list, before anybody's teardown runs.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (url === undefined || url === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the invoice family', () => {
  it('names every table that holds a foreign key into it, transitively', async () => {
    const rows = await sql<{ table_name: string }[]>`
      with recursive family(oid) as (
        select 'invoice'::regclass::oid
        union
        select c.conrelid
        from pg_constraint c
        join family f on c.confrelid = f.oid
        where c.contype = 'f'
      )
      select oid::regclass::text as table_name from family
    `
    const derived = rows.map((row) => row.table_name).sort()
    // The floor first: a query that returned only `invoice` would make the comparison below trivially true if
    // the written list were ever shortened to match it. ADR 0002.
    expect(derived.length, 'the recursive walk found nothing to reference invoice').toBeGreaterThan(
      4,
    )
    expect(
      [...INVOICE_FAMILY_TABLES].sort(),
      'the written list and the live schema disagree. A table that references the invoice family must be in ' +
        'INVOICE_FAMILY_TABLES, or every suite that writes an invoice fails in its own teardown with ' +
        '"cannot truncate a table referenced in a foreign key constraint" — after its assertions have passed.',
    ).toEqual(derived)
  })

  it('names every table that holds a foreign key into the package family, transitively', async () => {
    // The same derivation from the package roots. Two roots and not one: a suite empties the templates too,
    // because 0078 pins a sale to its template version with `on delete restrict`, and a template that outlives
    // its sales is a row the next run can neither remove nor reuse.
    const rows = await sql<{ table_name: string }[]>`
      with recursive family(oid) as (
        select oid from (values ('package_template'::regclass::oid), ('package_sale'::regclass::oid)) as r(oid)
        union
        select c.conrelid
        from pg_constraint c
        join family f on c.confrelid = f.oid
        where c.contype = 'f'
      )
      select oid::regclass::text as table_name from family
    `
    const derived = rows.map((row) => row.table_name).sort()
    expect(
      derived.length,
      'the recursive walk found nothing in the package family',
    ).toBeGreaterThan(5)
    expect(
      [...PACKAGE_FAMILY_TABLES].sort(),
      'the written package list and the live schema disagree. This is the list P-HR-11 broke by pointing ' +
        '`commission_line` at `package_redemption`: six suites truncated the family and four failed in their ' +
        'own teardown, after their assertions had passed.',
    ).toEqual(derived)
  })

  it('names every table that holds a foreign key into the credit-note family, transitively', async () => {
    // A separate root because `credit_note` holds no key to `invoice` (0072's header says why), so the invoice
    // walk above cannot reach it. The two closures meet in `refund` alone.
    const rows = await sql<{ table_name: string }[]>`
      with recursive family(oid) as (
        select 'credit_note'::regclass::oid
        union
        select c.conrelid
        from pg_constraint c
        join family f on c.confrelid = f.oid
        where c.contype = 'f'
      )
      select oid::regclass::text as table_name from family
    `
    const derived = rows.map((row) => row.table_name).sort()
    expect(
      derived.length,
      'the recursive walk found nothing to reference credit_note',
    ).toBeGreaterThan(2)
    expect(
      [...CREDIT_NOTE_FAMILY_TABLES].sort(),
      'the written credit-note list and the live schema disagree.',
    ).toEqual(derived)
    // And the statement five suites actually issue is the two closures with each table named ONCE: `refund`
    // is in both, and PostgreSQL refuses a truncate that names a table twice.
    expect(
      [...DOCUMENT_FAMILY_TABLES].sort(),
      'DOCUMENT_FAMILY_TABLES is not the union of the two derived closures, so a suite that writes both ' +
        'documents is truncating either too little or the same table twice.',
    ).toEqual([...new Set([...derived, ...INVOICE_FAMILY_TABLES])].sort())
    expect(
      new Set(DOCUMENT_FAMILY_TABLES).size,
      'DOCUMENT_FAMILY_TABLES names a table twice, which PostgreSQL refuses',
    ).toBe(DOCUMENT_FAMILY_TABLES.length)
  })

  it('names every table that holds a foreign key into the cash family, transitively', async () => {
    // The walk that would have saved eighteen files. Four suites wrote `truncate cash_session_adjustment,
    // cash_drop, cash_session` by hand; P-HR-12's `employee_tip` took a key to `cash_session`, `till.itest.ts`
    // threw in its `afterAll` before the line that removes its probe service, and the probe then refused every
    // fixture loader that ran after it.
    const rows = await sql<{ table_name: string }[]>`
      with recursive family(oid) as (
        select 'cash_session'::regclass::oid
        union
        select c.conrelid
        from pg_constraint c
        join family f on c.confrelid = f.oid
        where c.contype = 'f'
      )
      select oid::regclass::text as table_name from family
    `
    const derived = rows.map((row) => row.table_name).sort()
    expect(
      derived.length,
      'the recursive walk found nothing to reference cash_session',
    ).toBeGreaterThan(3)
    expect(
      [...CASH_FAMILY_TABLES].sort(),
      'the written cash list and the live schema disagree. A table that references the cash family must be ' +
        'in CASH_FAMILY_TABLES, or every suite that opens a drawer fails in its own teardown.',
    ).toEqual(derived)
  })

  it('names every table that holds a foreign key into the commission family, transitively', async () => {
    // Three roots because `hr-commission.itest.ts` writes all three and the rules are what the runs read.
    const rows = await sql<{ table_name: string }[]>`
      with recursive family(oid) as (
        select oid from (values ('commission_rule'::regclass::oid), ('commission_run'::regclass::oid),
                                ('commission_line'::regclass::oid)) as r(oid)
        union
        select c.conrelid
        from pg_constraint c
        join family f on c.confrelid = f.oid
        where c.contype = 'f'
      )
      select oid::regclass::text as table_name from family
    `
    const derived = rows.map((row) => row.table_name).sort()
    expect(
      derived.length,
      'the recursive walk found nothing in the commission family',
    ).toBeGreaterThan(4)
    expect(
      [...COMMISSION_FAMILY_TABLES].sort(),
      'the written commission list and the live schema disagree. This is the list P-HR-12 broke by pointing ' +
        '`payslip` at `commission_run`: the suite that writes commission runs sent all twenty-two of its ' +
        'cases to SKIPPED, because a `beforeAll` that throws does not report as a failure.',
    ).toEqual(derived)
  })

  it('empties both families, which is what the sixteen callers need them to do', async () => {
    // Driven for real rather than asserted about: a helper that named the right tables and built a statement
    // PostgreSQL refuses would pass the case above and fail every caller. Empty is the state a seeded database
    // is already in for these tables, so this proves the statement RUNS, not that it deleted something — the
    // suites that write invoices are where the removal itself is exercised.
    await truncateInvoiceFamily(sql)
    await truncatePackageFamily(sql)
    // The two later statements too, for the same reason: a list PostgreSQL refuses passes every case above.
    await truncateCommissionFamily(sql)
    await truncateDocumentFamily(sql)
    await truncateCashFamily(sql)
    const [invoices] = await sql<{ n: string }[]>`select count(*)::text as n from invoice`
    const [sales] = await sql<{ n: string }[]>`select count(*)::text as n from package_sale`
    expect(invoices?.n).toBe('0')
    expect(sales?.n).toBe('0')
  })
})

import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { INVOICE_FAMILY_TABLES, truncateInvoiceFamily } from './invoice-family.ts'

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

  it('empties the family, which is what the ten callers need it to do', async () => {
    // Driven for real rather than asserted about: a helper that named the right tables and built a statement
    // PostgreSQL refuses would pass the case above and fail every caller. Empty is the state a seeded database
    // is already in for these tables, so this proves the statement RUNS, not that it deleted something — the
    // suites that write invoices are where the removal itself is exercised.
    await truncateInvoiceFamily(sql)
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from invoice`
    expect(row?.n).toBe('0')
  })
})

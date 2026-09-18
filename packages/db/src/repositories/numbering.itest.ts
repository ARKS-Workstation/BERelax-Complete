import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import { type UnitOfWork, withUnitOfWork } from '../tx.ts'
import {
  type AllocatedDocumentNumber,
  allocateDocumentNumber,
  DOCUMENT_SERIES_CODES,
  findNumberingGaps,
  listDocumentSeries,
  NUMBERING_LEDGER_COLUMNS,
} from './numbering.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The document tables do not exist yet: M-TILL-04 adds `invoice`, credit notes follow it. The
 * numbering property being proved here is a property of the *pair* — an allocation and an insert
 * sharing one transaction — so it cannot be proved against the series table alone.
 *
 * So the suite brings its own document table, in its own schema. Its own schema and not `public`
 * because `pnpm db:drift` compares every base table in `public` against the Drizzle mirrors in both
 * directions; a stray test table there fails the build, and it would fail it in a way that looks like
 * a forgotten migration rather than like test litter.
 */
const TEST_SCHEMA = 'numbering_itest'
const LEDGER = `${TEST_SCHEMA}.issued_document`
const SEQUENCE_DEMO = `${TEST_SCHEMA}.sequence_numbered_document`
const SEQUENCE_DEMO_SEQ = `${TEST_SCHEMA}.sequence_demo_seq`

/** The configuration migration 0013 seeds. Restored before each test; see resetSeries(). */
const SEEDED = [
  { code: 'TAX-INV', kind: 'tax_invoice', prefix: 'TI-', padding: 5, reset: 'annual' },
  { code: 'SIMPL-INV', kind: 'simplified_invoice', prefix: 'SI-', padding: 5, reset: 'annual' },
  { code: 'CR-NOTE', kind: 'credit_note', prefix: 'CN-', padding: 5, reset: 'annual' },
] as const

const TRADING_DATE = '2026-09-18'
const TILL: Actor = {
  kind: 'staff',
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Till',
}

/**
 * 64, because the concurrency case issues 64 documents at once and each one needs a connection of
 * its own. A pool smaller than the fan-out would queue the transactions in the client, and the test
 * would then pass for the wrong reason: it would be proving that JavaScript runs one thing at a
 * time, not that a row lock serialises real concurrent issuers.
 */
const FANOUT = 64
let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: FANOUT })
  await sql.unsafe(`drop schema if exists ${TEST_SCHEMA} cascade`)
  await sql.unsafe(`create schema ${TEST_SCHEMA}`)
  // Shaped as M-TILL-04's invoice table will be, in the columns numbering cares about. The unique
  // constraints are part of the claim: "gap-free" without "no duplicates" is not a numbering range.
  await sql.unsafe(`
    create table ${LEDGER} (
      id             bigint generated always as identity primary key,
      series_code    text        not null references document_series(code),
      period_key     text        not null,
      number         bigint      not null,
      display_number text        not null,
      issued_at      timestamptz not null default now(),
      unique (series_code, period_key, number),
      unique (display_number)
    )
  `)
  // The known-bad fixture: the mechanism this unit rejected, so the suite can be seen to tell the
  // two apart. See 'a SEQUENCE fails the same three steps' below.
  await sql.unsafe(`create sequence ${SEQUENCE_DEMO_SEQ}`)
  await sql.unsafe(`
    create table ${SEQUENCE_DEMO} (
      number bigint primary key
    )
  `)
})

afterAll(async () => {
  await sql?.unsafe(`drop schema if exists ${TEST_SCHEMA} cascade`)
  await sql?.end({ timeout: 5 })
})

/**
 * Puts the three seeded series back to their initial state.
 *
 * `document_series` is configuration, not an append-only ledger, so this is a legitimate reset — and
 * a necessary one, because "TAX-INV issues 1, 2, 3" is only a meaningful assertion from a known
 * start. The counter columns are written here with the superuser test credential; the application
 * role cannot do this, which is itself asserted below.
 */
async function resetSeries(): Promise<void> {
  for (const s of SEEDED) {
    await sql`
      update document_series
         set prefix = ${s.prefix}, padding = ${s.padding}, reset_policy = ${s.reset},
             next_number = 1, period_key = ''
       where code = ${s.code}
    `
  }
}

beforeEach(async () => {
  await sql.unsafe(`truncate ${LEDGER}`)
  await resetSeries()
})

async function counterOf(code: string): Promise<{ nextNumber: number; periodKey: string }> {
  const [row] = await sql<{ next_number: string; period_key: string }[]>`
    select next_number, period_key from document_series where code = ${code}
  `
  if (!row) throw new Error(`no such series ${code}`)
  return { nextNumber: Number(row.next_number), periodKey: row.period_key }
}

async function storedNumbers(code: string): Promise<readonly number[]> {
  const rows = await sql<{ number: string }[]>`
    select number from ${sql(LEDGER)} where series_code = ${code} order by number
  `
  return rows.map((r) => Number(r.number))
}

async function storedDisplay(code: string): Promise<readonly string[]> {
  const rows = await sql<{ display_number: string }[]>`
    select display_number from ${sql(LEDGER)} where series_code = ${code} order by number
  `
  return rows.map((r) => r.display_number)
}

async function insertDocument(uow: UnitOfWork, n: AllocatedDocumentNumber): Promise<void> {
  await uow.sql`
    insert into ${uow.sql(LEDGER)} (series_code, period_key, number, display_number)
    values (${n.seriesCode}, ${n.periodKey}, ${n.number}, ${n.displayNumber})
  `
}

/** Issue one document: allocate and insert in ONE transaction, exactly as a till would. */
async function issue(code: string, tradingDate = TRADING_DATE): Promise<AllocatedDocumentNumber> {
  return withUnitOfWork(sql, TILL, async (uow) => {
    const allocated = await allocateDocumentNumber(uow, code, tradingDate)
    await insertDocument(uow, allocated)
    return allocated
  })
}

describe('the series', () => {
  it('seeds the independent series, and a new counter starts at 1', async () => {
    const series = await listDocumentSeries(sql)
    // The exact set, not a subset: a series nobody expected is a range that will show up in the gap
    // report. 'SUPP-BILL' joined in 0028 — a purchase bill is not a document we issue, but our own
    // reference to one is gap-free for the same reason, and it shares this counter rather than
    // getting a second implementation of it (ADR 0023).
    expect(series.map((s) => s.code)).toEqual([...DOCUMENT_SERIES_CODES].sort())
    expect(series.map((s) => s.documentKind).sort()).toEqual([
      'credit_note',
      'simplified_invoice',
      'supplier_bill',
      'tax_invoice',
    ])

    // The seed relies on the column default rather than writing 1 explicitly, so the default is the
    // thing that guarantees a series added later also starts at 1.
    const [defaults] = await sql<{ column_default: string }[]>`
      select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'document_series'
        and column_name = 'next_number'
    `
    expect(defaults?.column_default).toBe('1')
  })

  it('the stand-in document table matches the contract the gap report reads', async () => {
    // NUMBERING_LEDGER_COLUMNS is what M-TILL-04's invoice table must expose. Asserting it here is
    // what keeps it from becoming a comment: if the stand-in drifts from the published contract, the
    // gap-report cases below would be proving the property of a shape nothing else will ever have.
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${TEST_SCHEMA} and table_name = 'issued_document'
    `
    const present = new Set(rows.map((r) => r.column_name))
    for (const column of NUMBERING_LEDGER_COLUMNS) expect(present).toContain(column)
    // Control: the check is reading a real column list, not an empty one.
    expect(present).not.toContain('display_numbre')
    expect(present.size).toBeGreaterThan(NUMBERING_LEDGER_COLUMNS.length)
  })

  it('raises on an unknown series rather than issuing a null number', async () => {
    await expect(issue('NO-SUCH-SERIES')).rejects.toThrow(/unknown document series/)
  })

  it('rejects an unknown reset policy instead of silently resetting the counter every time', async () => {
    // The control matters more than the raise: a null period key would never equal the stored one,
    // so every allocation would look like a new period and hand out 1 forever.
    await expect(
      sql`select document_series_period_key('quarterly', date '2026-09-18')`,
    ).rejects.toThrow(/unknown document series reset policy/)
    const [ok] = await sql<{ k: string }[]>`
      select document_series_period_key('annual', date '2026-09-18') as k
    `
    expect(ok?.k).toBe('2026')
  })
})

describe('the display number', () => {
  it('treats padding as a minimum width, so a wide number is not truncated into a duplicate', async () => {
    // lpad() alone renders 1000 at padding 3 as '100', which is byte-identical to number 100's
    // display number. Two documents, one identifier.
    const [wide] = await sql<{ d: string }[]>`
      select document_number_display('TI-', '2026', 3::smallint, 1000::bigint) as d
    `
    const [narrow] = await sql<{ d: string }[]>`
      select document_number_display('TI-', '2026', 3::smallint, 100::bigint) as d
    `
    expect(wide?.d).toBe('TI-2026-1000')
    expect(narrow?.d).toBe('TI-2026-100')
    expect(wide?.d).not.toBe(narrow?.d)

    // Control: within the padding, it still pads.
    const [padded] = await sql<{ d: string }[]>`
      select document_number_display('TI-', '2026', 6::smallint, 1000::bigint) as d
    `
    expect(padded?.d).toBe('TI-2026-001000')
  })
})

describe('allocation is inside the document transaction', () => {
  it('a transaction that allocates and then raises leaves the counter untouched', async () => {
    const before = await counterOf('TAX-INV')
    expect(before.nextNumber).toBe(1)

    await expect(
      withUnitOfWork(sql, TILL, async (uow) => {
        const allocated = await allocateDocumentNumber(uow, 'TAX-INV', TRADING_DATE)
        // It really did allocate: this is not a test of a call that never happened.
        expect(allocated.number).toBe(1)
        expect(allocated.displayNumber).toBe('TI-2026-00001')
        await insertDocument(uow, allocated)
        throw new Error('deliberate failure after allocation')
      }),
    ).rejects.toThrow('deliberate failure')

    const after = await counterOf('TAX-INV')
    // Allocate-then-insert-in-a-second-transaction would leave this at 2, and number 1 would be
    // gone forever. So would a SEQUENCE.
    expect(after.nextNumber).toBe(1)
    expect(await storedNumbers('TAX-INV')).toEqual([])

    // Control: a committed allocation does move the counter, so the assertion above is not passing
    // because allocation is broken.
    const committed = await issue('TAX-INV')
    expect(committed.number).toBe(1)
    expect((await counterOf('TAX-INV')).nextNumber).toBe(2)
  })

  it('the number the rollback returned is handed to the next issuer', async () => {
    await issue('TAX-INV')
    await expect(
      withUnitOfWork(sql, TILL, async (uow) => {
        const allocated = await allocateDocumentNumber(uow, 'TAX-INV', TRADING_DATE)
        expect(allocated.number).toBe(2)
        throw new Error('card declined')
      }),
    ).rejects.toThrow('card declined')

    const next = await issue('TAX-INV')
    expect(next.number).toBe(2)
    expect(await storedNumbers('TAX-INV')).toEqual([1, 2])
  })

  it('a SEQUENCE fails the same three steps, which is why there is not one', async () => {
    // The known-bad fixture for this whole unit. Everything above asserts that the row-locked
    // counter is gap-free; none of it shows that the assertions could ever have failed. So here is
    // the rejected mechanism, put through exactly the same three steps — commit, roll back, commit —
    // deterministically, with no concurrency to make the outcome depend on the scheduler.
    await sql.unsafe(`truncate ${SEQUENCE_DEMO}`)
    await sql.unsafe(`alter sequence ${SEQUENCE_DEMO_SEQ} restart with 1`)

    const issueFromSequence = async (fails: boolean) =>
      sql.begin(async (tx) => {
        await tx`insert into ${sql(SEQUENCE_DEMO)} (number) values (nextval(${SEQUENCE_DEMO_SEQ}))`
        if (fails) throw new Error('deliberate failure after nextval')
      })

    await issueFromSequence(false)
    await expect(issueFromSequence(true)).rejects.toThrow('deliberate failure')
    await issueFromSequence(false)

    const rows = await sql<{ number: string }[]>`
      select number from ${sql(SEQUENCE_DEMO)} order by number
    `
    // 1, 3. Number 2 was consumed by a transaction that left no trace of itself, which is precisely
    // the question a tax authority asks and the only answer a sequence can give.
    expect(rows.map((r) => Number(r.number))).toEqual([1, 3])

    // The same three steps through the row-locked counter, for the contrast:
    await issue('TAX-INV')
    await expect(
      withUnitOfWork(sql, TILL, async (uow) => {
        await allocateDocumentNumber(uow, 'TAX-INV', TRADING_DATE)
        throw new Error('deliberate failure after allocation')
      }),
    ).rejects.toThrow('deliberate failure')
    await issue('TAX-INV')
    expect(await storedNumbers('TAX-INV')).toEqual([1, 2])
  })
})

describe('concurrency', () => {
  it(`${FANOUT} parallel transactions, half rolled back, issue exactly 1..${FANOUT / 2}`, async () => {
    const committed: number[] = []
    const rolledBack: number[] = []
    const backendPids = new Set<number>()

    const attempt = async (i: number): Promise<void> => {
      const fails = i % 2 === 1 // exactly half
      try {
        await withUnitOfWork(sql, TILL, async (uow) => {
          const [pid] = await uow.sql<{ pid: number }[]>`select pg_backend_pid() as pid`
          if (pid) backendPids.add(pid.pid)
          const allocated = await allocateDocumentNumber(uow, 'TAX-INV', TRADING_DATE)
          await insertDocument(uow, allocated)
          if (fails) {
            rolledBack.push(allocated.number)
            throw new Error(`deliberate rollback ${i}`)
          }
          committed.push(allocated.number)
        })
      } catch (err) {
        if (!fails) throw err
      }
    }

    await Promise.all(Array.from({ length: FANOUT }, (_, i) => attempt(i)))

    expect(committed).toHaveLength(FANOUT / 2)
    expect(rolledBack).toHaveLength(FANOUT / 2)

    // The specification: the issued range is exactly 1..32 — contiguous, no gap, no duplicate.
    expect([...committed].sort((a, b) => a - b)).toEqual(
      Array.from({ length: FANOUT / 2 }, (_, i) => i + 1),
    )
    expect(await storedNumbers('TAX-INV')).toEqual(
      Array.from({ length: FANOUT / 2 }, (_, i) => i + 1),
    )
    expect(await findNumberingGaps(sql, LEDGER)).toEqual([])
    expect((await counterOf('TAX-INV')).nextNumber).toBe(FANOUT / 2 + 1)

    // The refutation of a SEQUENCE, and the reason this assertion is on ALL 64 allocations rather
    // than on the 32 that survived.
    //
    // `nextval` would have been called 64 times and consumed 64 distinct numbers; the 32 it gave to
    // the doomed transactions would be gone, and the committed set would be a sparse subset of
    // 1..64. Here the same number is handed out again and again until somebody commits it, so 64
    // allocations produced at most 33 distinct values.
    //
    // 33, not 32, and the extra one is not slack: the counter always stands at commits-so-far plus
    // one, so if the last transaction to reach the lock is one of the doomed ones it allocates 33
    // and immediately gives it back. Asserting exactly 32 would have made this test depend on the
    // scheduler's ordering — which is how a concurrency test becomes an intermittent failure.
    const everyAllocation = [...committed, ...rolledBack]
    expect(everyAllocation).toHaveLength(FANOUT)
    expect(Math.max(...everyAllocation)).toBeLessThanOrEqual(FANOUT / 2 + 1)
    expect(new Set(everyAllocation).size).toBeLessThanOrEqual(FANOUT / 2 + 1)

    // And the transactions really were concurrent. One pooled connection reused 64 times would
    // serialise them in the client, and the test would then be proving that JavaScript runs one
    // thing at a time rather than that a row lock serialises genuinely concurrent issuers.
    expect(backendPids.size).toBeGreaterThanOrEqual(FANOUT / 2)
  })
})

describe('the series do not interleave', () => {
  it('TAX-INV, SIMPL-INV and CR-NOTE each start at 1 and run independently', async () => {
    const order = [
      'TAX-INV',
      'SIMPL-INV',
      'CR-NOTE',
      'CR-NOTE',
      'TAX-INV',
      'SIMPL-INV',
      'SIMPL-INV',
      'CR-NOTE',
      'TAX-INV',
    ]
    const issued: AllocatedDocumentNumber[] = []
    for (const code of order) issued.push(await issue(code))

    for (const code of ['TAX-INV', 'SIMPL-INV', 'CR-NOTE']) {
      expect(issued.filter((n) => n.seriesCode === code).map((n) => n.number)).toEqual([1, 2, 3])
    }

    expect(await storedDisplay('TAX-INV')).toEqual([
      'TI-2026-00001',
      'TI-2026-00002',
      'TI-2026-00003',
    ])
    expect(await storedDisplay('SIMPL-INV')).toEqual([
      'SI-2026-00001',
      'SI-2026-00002',
      'SI-2026-00003',
    ])
    expect(await storedDisplay('CR-NOTE')).toEqual([
      'CN-2026-00001',
      'CN-2026-00002',
      'CN-2026-00003',
    ])

    // The [1, 2, 3] above is what rules out one shared counter behind three prefixes: that design
    // would have given TAX-INV 1, 5 and 9. This rules out the opposite mistake — three series
    // resolving to the same prefix, where the numbers are independent and the identifiers collide.
    expect(
      new Set(
        (await sql`select display_number from ${sql(LEDGER)}`).map((r) => r['display_number']),
      ).size,
    ).toBe(9)
    expect(await findNumberingGaps(sql, LEDGER)).toEqual([])
  })

  it('an annual reset restarts at 1 in the new year without colliding', async () => {
    const dec = await issue('TAX-INV', '2026-12-31')
    const jan = await issue('TAX-INV', '2027-01-01')
    expect(dec.number).toBe(1)
    expect(jan.number).toBe(1)
    expect(dec.displayNumber).toBe('TI-2026-00001')
    expect(jan.displayNumber).toBe('TI-2027-00001')
    // Two rows numbered 1, in different statutory years. The gap report partitions on the period for
    // exactly this reason; partitioning on the series alone would call this a duplicate.
    expect(await findNumberingGaps(sql, LEDGER)).toEqual([])
  })
})

describe('a format change does not renumber what is already issued', () => {
  it('mutating prefix and padding leaves every stored display_number byte-identical', async () => {
    for (let i = 0; i < 3; i += 1) await issue('TAX-INV')
    const before = await storedDisplay('TAX-INV')
    expect(before).toEqual(['TI-2026-00001', 'TI-2026-00002', 'TI-2026-00003'])

    await sql`update document_series set prefix = 'ZZZ/', padding = 9 where code = 'TAX-INV'`

    const after = await storedDisplay('TAX-INV')
    expect(after).toEqual(before)
    // Byte-identical, not merely equal-looking: the stored value is the document, and a renderer
    // that re-derived it from prefix + number would now print a different invoice reference than the
    // copy the customer holds.
    for (let i = 0; i < before.length; i += 1) {
      expect(Buffer.from(after[i] ?? '')).toEqual(Buffer.from(before[i] ?? ''))
    }

    // Control: the change was real and it does apply to the next document. Without this the test
    // would pass just as happily if the UPDATE had matched no row.
    const next = await issue('TAX-INV')
    expect(next.displayNumber).toBe('ZZZ/2026-000000004')
    expect(next.number).toBe(4)
    expect(await findNumberingGaps(sql, LEDGER)).toEqual([])
  })

  it('the application role may change the format but cannot touch the counter', async () => {
    // The structural half of the guarantee. Renumbering is impossible not because no code does it,
    // but because the role the application connects as holds no privilege to.
    const [priv] = await sql<{ counter: boolean; period: boolean; format: boolean }[]>`
      select has_column_privilege('berelax_app', 'document_series', 'next_number', 'UPDATE') as counter,
             has_column_privilege('berelax_app', 'document_series', 'period_key',  'UPDATE') as period,
             has_column_privilege('berelax_app', 'document_series', 'prefix',      'UPDATE') as format
    `
    expect(priv?.counter).toBe(false)
    expect(priv?.period).toBe(false)
    // The control: the check is not reporting false for every column because the role is missing.
    expect(priv?.format).toBe(true)

    // And the same thing end to end, as the application role itself.
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`update document_series set next_number = 1 where code = 'TAX-INV'`
      }),
    ).rejects.toThrow(/permission denied/)

    // Control: that role CAN still allocate, through the one function that owns the counter.
    const allocated = await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      return tx`select number from allocate_document_number('TAX-INV', ${TRADING_DATE}::date)`
    })
    expect(Number(allocated[0]?.['number'])).toBe(1)
  })
})

describe('the gap report', () => {
  it('finds nothing across 10,000 issued documents, with rollbacks in the middle', async () => {
    // Seeded server-side: 10,000 client round trips would spend the whole test budget proving
    // something the round trips are not part of. Every number still comes from
    // allocate_document_number, one call per row.
    //
    // The call is in a subquery's target list, with `offset 0` as the optimisation fence, and both
    // details are load-bearing. The first version of this seed put it in the FROM clause as
    // `generate_series(1, n), lateral allocate_document_number(...)`; with nothing correlating the
    // function to the series, the planner ran the function scan ONCE and cross-joined its single row
    // 10,000 times, so the insert tried to write 10,000 copies of number 1. `offset 0` stops the
    // subquery being flattened back into that shape.
    const seed = async (n: number) => {
      await sql.unsafe(`
        insert into ${LEDGER} (series_code, period_key, number, display_number)
        select (a).series_code, (a).period_key, (a).number, (a).display_number
        from (
          select allocate_document_number('TAX-INV', date '${TRADING_DATE}') as a
          from generate_series(1, ${n})
          offset 0
        ) t
      `)
    }

    await seed(5_000)
    // Three failed sales in the middle of the day. Each allocates and rolls back.
    for (let i = 0; i < 3; i += 1) {
      await expect(
        withUnitOfWork(sql, TILL, async (uow) => {
          await allocateDocumentNumber(uow, 'TAX-INV', TRADING_DATE)
          throw new Error('deliberate rollback')
        }),
      ).rejects.toThrow('deliberate rollback')
    }
    await seed(5_000)

    const [count] = await sql<{ n: string; max: string }[]>`
      select count(*)::text as n, max(number)::text as max from ${sql(LEDGER)}
    `
    expect(count?.n).toBe('10000')
    expect(count?.max).toBe('10000')
    expect(await findNumberingGaps(sql, LEDGER)).toEqual([])

    // The control. A gate that has never been seen to fail is not a gate: remove two numbers and the
    // same query must report them, or the zero rows above meant nothing.
    await sql`delete from ${sql(LEDGER)} where number in (17, 4096)`
    const gaps = await findNumberingGaps(sql, LEDGER)
    expect(gaps).toHaveLength(2)
    expect(gaps[0]).toMatchObject({
      seriesCode: 'TAX-INV',
      periodKey: '2026',
      missingBefore: 1,
      firstNumber: 18,
    })
    expect(gaps[1]).toMatchObject({ missingBefore: 2, firstNumber: 4097, lastNumber: 10_000 })
  })

  it('reports a series whose first document is not number 1', async () => {
    // The other way a range can be wrong: not a hole in the middle but a start above 1, which is
    // what an imported or hand-seeded counter produces.
    await sql.unsafe(`
      insert into ${LEDGER} (series_code, period_key, number, display_number)
      values ('TAX-INV', '2026', 7, 'TI-2026-00007'), ('TAX-INV', '2026', 8, 'TI-2026-00008')
    `)
    const gaps = await findNumberingGaps(sql, LEDGER)
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toMatchObject({ missingBefore: 6, firstNumber: 7, lastNumber: 8 })
  })

  it('refuses a relation name it cannot escape', async () => {
    await expect(findNumberingGaps(sql, 'issued"; drop table document_series; --')).rejects.toThrow(
      /not a relation name/,
    )
  })
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { isBalanced, trialBalanceAsAt, trialBalanceMovement } from '../queries/trial-balance.ts'
import { postJournalEntry } from '../repositories/journal.ts'
import {
  PROVISIONAL_OPENING_DATE,
  PROVISIONAL_OPENING_LINES,
  seedProvisionalOpeningBalances,
} from '../seed/opening-balances.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  importOpeningBalances,
  isBeforeOpeningBalance,
  openingDate,
  openingImbalanceFils,
  provisionalOpeningBalances,
} from './opening-balances.ts'

/**
 * M-VAT-05 — opening balances and the trial balance, against real PostgreSQL.
 *
 * The three things that cannot be checked any other way: a unique constraint refusing a second import, a
 * trigger refusing a backdated posting, and a `sum()` over `bigint` coming back from the driver as a
 * string so a figure beyond 2^53 is not silently rounded.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
// `actor_id` is a uuid column; the label is where a name goes.
const ACTOR = { kind: 'system', label: 'm-vat-05-itest' } as const
const OPENING = '2026-09-01'

let sql: Sql
/** The entry id of the opening import that actually exists, read back rather than assumed. */
let openingEntryId = ''

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  // `legal_entity` is a single-row table (0003) and migration 0026 seeds its row; the foreign key from
  // `opening_balance_import` is not optional, so the row is ensured rather than assumed and
  // `on conflict do nothing` keeps that idempotent.
  //
  // The values are the ones 0026 seeds and docs/13 §1 states, deliberately and not as decoration. This
  // insert used to carry an invented spelling of the legal name on the reasoning that a conflict would
  // discard it — and then it ran against a database that predated 0026, won the race, and left the wrong
  // legal name in the singleton every later suite reads. `legal_entity.legal_name` is snapshotted onto
  // every tax invoice, so a fallback that can disagree with the seed is a fallback that can put the wrong
  // registered name on a document filed with the FTA. There is one spelling, and this is it.
  await sql`
    insert into legal_entity (id, legal_name, trading_name, trn, licensing_authority, emirate)
    values (1, 'BE RELAX SPA - L.L.C - O.P.C', 'BE RELAX - Massage Center and Spa',
            'TRN-PENDING-Y1-TRN', 'ADDED', 'Abu Dhabi')
    on conflict (id) do nothing
  `
  // Every import row, cleared. `opening_balance_import` carries no refusal trigger — it is evidence, not
  // a posting — and clearing it is what makes a re-run against the same database repeatable. The journal
  // entries those imports posted stay, because the ledger is append-only; they are harmless, since every
  // total below is a delta.
  await sql`delete from opening_balance_import`

  // One import at the opening date. The before-opening guard needs it to exist, and the entry it posts
  // cannot be deleted afterwards — so the entry id is kept, because the reversal test needs the id that
  // actually exists rather than one it assumed.
  openingEntryId = `JE-OPEN-${RUN}`
  await importOnce(OPENING, openingEntryId)
}, 60_000)

afterAll(async () => {
  // The guard goes away with the import row, and it has to.
  //
  // `opening_date_for()` reads `min(opening_date)`, so leaving an import behind leaves a floor behind —
  // and `journal.itest.ts` (M-TILL-02) posts entries dated well before any plausible opening date, as it
  // is entitled to: it was written before this guard existed and its subject is the balance trigger, not
  // the calendar. Whichever of the two suites ran second would fail, on a database that only differed by
  // the order the files happened to run in. Found exactly that way: thirty of M-TILL-02's assertions
  // broke the first time this unit's suite ran ahead of it.
  //
  // The import row is evidence rather than a posting, so unlike the entries it is deletable, and a test
  // that created one removes it.
  await sql`delete from opening_balance_import`
  await sql.end({ timeout: 5 })
})

/**
 * Nothing here deletes a posting.
 *
 * The ledger is append-only and the refusal triggers in 0018 refuse the **owner** too, not merely the
 * application role — which is the point, and which this suite discovered by trying: a `delete from
 * journal_line` between tests raised `journal_line is append-only`. So every total below is a **delta**
 * over a window this suite alone posts into, never a total over the table (ADR 0008; the brief's rule 9).
 *
 * That is also why the opening import happens once, in `beforeAll`: the before-opening guard needs it to
 * exist, and removing it between tests would remove the guard the tests are about.
 */
async function importOnce(date: string, entryId: string): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const result = await importOpeningBalances(uow, {
      openingDate: date,
      entryId,
      importedBy: 'itest',
      lines: [
        { accountCode: '1010', debitFils: 250_000, creditFils: 0 },
        { accountCode: '3010', debitFils: 0, creditFils: 250_000 },
      ],
    })
    return result.importId
  })
}

/** A unique suffix per run, so a re-run of this suite against the same database does not collide. */
const RUN = Date.now().toString(36)

/**
 * Cumulative debits as at each of several dates.
 *
 * Captured before a test posts and again after, so every total below is a **difference**. A fixed date
 * window looked sufficient and was not: the entry ids are unique per run but the dates were not, so four
 * earlier runs of this suite against the same database had left the window holding four times what the
 * test expected — the assertion failed at exactly 4x, which is what gave it away. A delta is correct
 * whatever else is in the ledger, which is the only thing that is true of an append-only table.
 */
async function debitsAt(dates: readonly string[]): Promise<Map<string, bigint>> {
  const entries = await Promise.all(
    dates.map(async (date) => [date, (await trialBalanceAsAt(sql, date)).totalDebitFils] as const),
  )
  return new Map(entries)
}

function deltaAt(before: Map<string, bigint>, after: Map<string, bigint>, date: string): bigint {
  return (after.get(date) ?? 0n) - (before.get(date) ?? 0n)
}

describe('acceptance — one dated entry that balances to zero', () => {
  it('posts a single balanced entry and records the import', async () => {
    // `beforeAll` did the import — it has to, because the guard every other test exercises needs it. What
    // this test asserts is the shape of what it produced.
    const entries = (await sql`
      select entry_id, entry_date::text, source from journal_entry where entry_id = ${openingEntryId}
    `) as unknown as { entry_id: string; entry_date: string; source: string }[]
    // One entry, not one per account: the opening position is a single balanced document, and a
    // per-account entry would let half of it commit.
    expect(entries).toHaveLength(1)
    expect(entries[0]?.source).toBe('opening_balance')
    expect(entries[0]?.entry_date).toBe(OPENING)

    const [row] = (await sql`
      select total_debit_fils::text as debit, total_credit_fils::text as credit
      from opening_balance_import where entry_id = ${openingEntryId}
    `) as unknown as { debit: string; credit: string }[]
    expect(row?.debit).toBe('250000')
    expect(row?.credit).toBe('250000')
    // And the ledger balances as at that date, which is the property every later gate depends on.
    expect(isBalanced(await trialBalanceAsAt(sql, OPENING))).toBe(true)
  })

  it('rejects an unbalanced import naming the difference in fils, and writes nothing', async () => {
    // An opening balance is transcribed by hand from somebody else's books. The number a person needs is
    // the difference, because that is what they go looking for — "the entry does not balance" sends them
    // to re-add the whole column.
    const entryId = `JE-OPEN-BAD-${RUN}`
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) =>
        importOpeningBalances(uow, {
          openingDate: '2027-01-01',
          entryId,
          importedBy: 'itest',
          lines: [
            { accountCode: '1010', debitFils: 250_000, creditFils: 0 },
            { accountCode: '3010', debitFils: 0, creditFils: 249_499 },
          ],
        }),
      ),
    ).rejects.toThrow(/debits exceed credits by 501 fils/)

    // Nothing was written — not the entry, not the import row. The deferred trigger would also have
    // caught this, at COMMIT, after the audit row and the domain event had been written for a posting
    // that never existed.
    const [counts] = (await sql`
      select (select count(*) from journal_entry where entry_id = ${entryId})::int as entries,
             (select count(*) from opening_balance_import where entry_id = ${entryId})::int as imports
    `) as unknown as { entries: number; imports: number }[]
    expect(counts).toEqual({ entries: 0, imports: 0 })
  })

  it('names the difference in the other direction too', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) =>
        importOpeningBalances(uow, {
          openingDate: '2027-01-01',
          entryId: `JE-OPEN-BAD2-${RUN}`,
          importedBy: 'itest',
          lines: [
            { accountCode: '1010', debitFils: 1_000, creditFils: 0 },
            { accountCode: '3010', debitFils: 0, creditFils: 1_007 },
          ],
        }),
      ),
    ).rejects.toThrow(/credits exceed debits by 7 fils/)
  })

  it('computes the imbalance purely, so the message and the check cannot disagree', () => {
    expect(
      openingImbalanceFils([
        { accountCode: '1010', debitFils: 10, creditFils: 0 },
        { accountCode: '3010', debitFils: 0, creditFils: 4 },
      ]),
    ).toBe(6)
    expect(openingImbalanceFils([])).toBe(0)
  })
})

describe('acceptance — importing twice is refused', () => {
  it('raises on the second import for the same entity and date', async () => {
    // The failure this prevents is not an error message: it is a second import run because somebody was
    // not sure the first had worked. Undetectable afterwards — the books still balance, they are simply
    // twice the size.
    const [before] = (await sql`
      select count(*)::int as n from opening_balance_import where opening_date = ${OPENING}::date
    `) as unknown as { n: number }[]
    expect(before?.n).toBe(1)

    await expect(importOnce(OPENING, `JE-OPEN-DUP-${RUN}`)).rejects.toThrow()

    const [after] = (await sql`
      select count(*)::int as n from opening_balance_import where opening_date = ${OPENING}::date
    `) as unknown as { n: number }[]
    expect(after?.n).toBe(1)
    // And the second attempt's entry was rolled back with it, rather than left orphaned.
    const orphan = (await sql`
      select entry_id from journal_entry where entry_id = ${`JE-OPEN-DUP-${RUN}`}
    `) as unknown as { entry_id: string }[]
    expect(orphan).toEqual([])
  })

  it('allows a different opening date, so the constraint is on the pair and not on the entity', async () => {
    // The control. A unique key on `legal_entity_id` alone would pass the test above and make a corrected
    // re-import at a new date impossible. The later date does not move the guard: `opening_date_for` takes
    // the earliest, because the books opened when they first opened.
    await expect(importOnce('2027-07-01', `JE-OPEN-LATER-${RUN}`)).resolves.toMatch(
      /^[0-9a-f-]{36}$/,
    )
    expect(await openingDate(sql)).toBe(OPENING)
  })
})

describe('acceptance — nothing may be posted before the books open', () => {
  /** The five posting paths the acceptance line names, as the `source` each one will carry. */
  const POSTING_PATHS = [
    { path: 'invoice', source: 'sale' },
    { path: 'bill', source: 'supplier_bill' },
    { path: 'credit note', source: 'refund' },
    { path: 'payment', source: 'payment' },
    { path: 'package redemption', source: 'package_redemption' },
  ] as const

  for (const [index, { path, source }] of POSTING_PATHS.entries()) {
    it(`refuses a ${path} dated before the opening date`, async () => {
      let raised: unknown
      try {
        await withUnitOfWork(sql, ACTOR, async (uow) =>
          postJournalEntry(uow, {
            entryId: `JE-EARLY-${index}-${RUN}`,
            entryDate: '2026-08-31',
            narrative: `${path} dated before the books open`,
            source,
            lines: [
              { accountCode: '1010', debitFils: 100, creditFils: 0 },
              { accountCode: '4010', debitFils: 0, creditFils: 100 },
            ],
          }),
        )
      } catch (error) {
        raised = error
      }
      expect(raised, `a ${path} dated 2026-08-31 was accepted`).toBeDefined()
      expect(String(raised)).toMatch(/BeforeOpeningBalance/)
      expect(String(raised)).toContain('the books open on 2026-09-01')
    })
  }

  it('accepts the same posting dated on the opening date, so the boundary is inclusive', async () => {
    // The control for all five above. A guard that refused everything would satisfy them and make the
    // system unusable on its first trading day.
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) =>
        postJournalEntry(uow, {
          entryId: `JE-ON-OPENING-${RUN}`,
          entryDate: OPENING,
          narrative: 'a sale on the opening date',
          source: 'sale',
          lines: [
            { accountCode: '1010', debitFils: 100, creditFils: 0 },
            { accountCode: '4010', debitFils: 0, creditFils: 100 },
          ],
        }),
      ),
    ).resolves.toBeDefined()
  })

  it('classifies the refusal by SQLSTATE, not by message matching', async () => {
    try {
      await withUnitOfWork(sql, ACTOR, async (uow) =>
        postJournalEntry(uow, {
          entryId: `JE-EARLY-CODE-${RUN}`,
          entryDate: '2026-01-01',
          narrative: 'backdated',
          source: 'sale',
          lines: [
            { accountCode: '1010', debitFils: 1, creditFils: 0 },
            { accountCode: '4010', debitFils: 0, creditFils: 1 },
          ],
        }),
      )
      expect.unreachable('expected BeforeOpeningBalance')
    } catch (error) {
      expect(isBeforeOpeningBalance(error)).toBe(true)
    }
  })

  it('exempts a reversal, because a correction to the opening entry must be able to predate it', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) =>
        postJournalEntry(uow, {
          entryId: `JE-REVERSAL-${RUN}`,
          entryDate: '2026-08-15',
          narrative: 'reverses the opening entry',
          source: 'reversal',
          reverses: openingEntryId,
          lines: [
            { accountCode: '1010', debitFils: 0, creditFils: 250_000 },
            { accountCode: '3010', debitFils: 250_000, creditFils: 0 },
          ],
        }),
      ),
    ).resolves.toBeDefined()
  })

  it('reports null for an entity with no import, which is what leaves the guard off', async () => {
    // Null means no guard: a system that refused every posting until the opening balances were imported
    // could not be set up at all. Asserted against an entity id with no import rather than by deleting
    // this one, which would remove the guard the tests above are about.
    expect(await openingDate(sql, 1)).toBe(OPENING)
    expect(await openingDate(sql, 99)).toBeNull()
  })
})

describe('acceptance — the trial balance is exact over many postings', () => {
  // A window nothing else in this suite or the wider suite posts into, so a movement over it is exactly
  // what this test wrote.
  const WINDOW_FROM = '2026-11-30'
  const WINDOW_TO = '2026-12-31'

  it('balances to the fils over 1000 generated postings', async () => {
    // Deterministic, not random: a seeded generator, so a failure can be reproduced from the output. Both
    // the amounts and the dates vary, because a trial balance that summed correctly but cut on the wrong
    // date would pass a single-date test.
    let seed = 20260918
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % limit
    }

    const pairs = [
      ['1010', '4010'],
      ['1020', '4020'],
      ['1010', '2010'],
      ['5010', '1010'],
    ] as const
    let expectedDebit = 0
    const before = await debitsAt([WINDOW_FROM, WINDOW_TO])

    await withUnitOfWork(sql, ACTOR, async (uow) => {
      for (let index = 0; index < 1000; index += 1) {
        const pair = pairs[index % pairs.length]
        if (pair === undefined) continue
        const amount = 1 + next(5_000_000)
        const day = 1 + next(30)
        expectedDebit += amount
        await postJournalEntry(uow, {
          entryId: `JE-TB-${index}-${RUN}`,
          entryDate: `2026-12-${String(day).padStart(2, '0')}`,
          narrative: `generated posting ${index}`,
          source: 'sale',
          lines: [
            { accountCode: pair[0], debitFils: amount, creditFils: 0 },
            { accountCode: pair[1], debitFils: 0, creditFils: amount },
          ],
        })
      }
    })

    const after = await debitsAt([WINDOW_FROM, WINDOW_TO])
    // The difference across the window is exactly what this test posted — no more, and not zero.
    expect(deltaAt(before, after, WINDOW_TO) - deltaAt(before, after, WINDOW_FROM)).toBe(
      BigInt(expectedDebit),
    )

    const closing = await trialBalanceAsAt(sql, WINDOW_TO)
    expect(closing.differenceFils).toBe(0n)
    expect(isBalanced(closing)).toBe(true)
    expect(closing.rows.length).toBeGreaterThanOrEqual(5)

    // The whole ledger balances too, which is the property every later gate depends on.
    expect(isBalanced(await trialBalanceAsAt(sql, '2027-12-31'))).toBe(true)
  }, 180_000)

  it('is cumulative and cut on entry_date, not on posted_at', async () => {
    // Every row below is posted now, in one transaction, and dated across four weeks. A trial balance
    // cutting on `posted_at` would put all four into whichever date this test ran on — and at a period
    // boundary, into a period that had already been filed.
    const amounts = [1000, 2000, 3000, 4000]
    const DATES = [
      '2027-02-28',
      '2027-03-01',
      '2027-03-11',
      '2027-03-12',
      '2027-03-18',
      '2027-03-25',
      '2027-03-31',
    ]
    const before = await debitsAt(DATES)
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      for (const [index, day] of ['05', '12', '19', '26'].entries()) {
        await postJournalEntry(uow, {
          entryId: `JE-DATED-${index}-${RUN}`,
          entryDate: `2027-03-${day}`,
          narrative: 'dated posting',
          source: 'sale',
          lines: [
            { accountCode: '1010', debitFils: amounts[index] ?? 0, creditFils: 0 },
            { accountCode: '4010', debitFils: 0, creditFils: amounts[index] ?? 0 },
          ],
        })
      }
    })

    for (const asAt of DATES) {
      expect(isBalanced(await trialBalanceAsAt(sql, asAt)), `unbalanced as at ${asAt}`).toBe(true)
    }
    const after = await debitsAt(DATES)
    const since = (date: string) =>
      deltaAt(before, after, date) - deltaAt(before, after, '2027-02-28')

    // Nothing is dated before the 5th, two of the four are in by the 12th, all four by the 31st. Every
    // figure is a delta, because the ledger cannot be emptied and a re-run would otherwise double it.
    expect(since('2027-03-01')).toBe(0n)
    expect(since('2027-03-11')).toBe(1000n)
    expect(since('2027-03-12')).toBe(3000n)
    expect(since('2027-03-31')).toBe(10_000n)
  })

  it('movement is the later position minus the earlier one, with from exclusive', async () => {
    const before = await debitsAt(['2027-05-01', '2027-05-09', '2027-05-31'])
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      for (const [index, day] of ['10', '20'].entries()) {
        await postJournalEntry(uow, {
          entryId: `JE-MOVE-${index}-${RUN}`,
          entryDate: `2027-05-${day}`,
          narrative: 'movement',
          source: 'sale',
          lines: [
            { accountCode: '1010', debitFils: 700, creditFils: 0 },
            { accountCode: '4010', debitFils: 0, creditFils: 700 },
          ],
        })
      }
    })

    // `from` exclusive: the 10th falls in the second period and in neither both. A closed range would
    // count the boundary date twice, which is the classic off-by-one in a financial report — a year that
    // does not add up to its months.
    const after = await debitsAt(['2027-05-01', '2027-05-09', '2027-05-31'])
    const firstPeriod = deltaAt(before, after, '2027-05-09') - deltaAt(before, after, '2027-05-01')
    const secondPeriod = deltaAt(before, after, '2027-05-31') - deltaAt(before, after, '2027-05-09')
    expect(firstPeriod).toBe(0n)
    expect(secondPeriod).toBe(1400n)
    expect(isBalanced(await trialBalanceMovement(sql, '2027-05-09', '2027-05-31'))).toBe(true)
  })

  it('does not round a figure beyond 2^53', async () => {
    // `sum()` over bigint returns numeric and the driver hands it back as a string precisely so this
    // cannot be silently rounded. A trial balance parsing the sum as a float would lose fils at the top
    // of the range. As a string, not a bigint literal: `createConnection` serialises bigint with
    // `String(v)`, so the driver's own parameter type is text — which is the mechanism under test.
    const huge = '9007199254740993' // 2^53 + 1
    const entryId = `JE-HUGE-${RUN}`
    // One transaction. The entry-level balance trigger is DEFERRED to COMMIT, so two separate statements
    // would commit an entry with no lines and be refused — correctly — before the lines arrived.
    await sql.begin(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, '2027-09-09'::date, 'a figure beyond 2^53', 'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${entryId}, 1, '1010', ${huge}::bigint, 0), (${entryId}, 2, '3010', 0, ${huge}::bigint)
      `
    })
    const [row] = (await sql`
      select sum(debit_fils)::text as total from journal_line where entry_id = ${entryId}
    `) as unknown as { total: string }[]
    expect(row?.total).toBe(huge)
    // And the trial balance still balances at that magnitude, which is the property that matters.
    expect((await trialBalanceAsAt(sql, '2027-09-09')).differenceFils).toBe(0n)
  })
})

describe('acceptance — provisional zeros appear in the Unconfirmed Assumptions panel', () => {
  it('seeds a flagged import that names its open question', async () => {
    const before = await provisionalOpeningBalances(sql)
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await seedProvisionalOpeningBalances(uow, {
        // The seed's own date is already taken by this suite's `beforeAll` import, and one import per
        // (entity, date) is the whole point of the unique key.
        openingDate: '2027-02-01',
        entryId: `JE-OPEN-PROVISIONAL-${RUN}`,
      })
    })

    const after = await provisionalOpeningBalances(sql)
    expect(after.length - before.length).toBe(1)
    const seeded = after.find((row) => row.openingDate === '2027-02-01')
    expect(seeded?.openQuestionId).toBe('Y8-opening-balances')
    // The note has to say what is actually wrong, not that something is: without the real closing
    // position, every balance sheet is a movement rather than a position.
    expect(seeded?.note).toMatch(/movement since/)
    expect(PROVISIONAL_OPENING_LINES).toHaveLength(2)
    expect(PROVISIONAL_OPENING_DATE).toBe(OPENING)
  })

  it('does not list a confirmed import, so the panel shows only what is unanswered', async () => {
    // The control. A query returning every import would fill the panel with settled facts and make the
    // one unanswered question invisible. `beforeAll`'s import is not provisional and must be absent.
    // Asserted against the collected rows rather than by emptying the table.
    const rows = await provisionalOpeningBalances(sql)
    expect(rows.some((row) => row.openingDate === OPENING)).toBe(false)
    // And it does return something, or the assertion above holds for a query that reads nothing.
    expect(rows.length).toBeGreaterThan(0)
  })

  it('refuses a provisional import that names no question', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) =>
        importOpeningBalances(uow, {
          openingDate: '2027-04-01',
          entryId: `JE-OPEN-NOQ-${RUN}`,
          importedBy: 'itest',
          lines: [...PROVISIONAL_OPENING_LINES],
          isProvisional: true,
        }),
      ),
    ).rejects.toThrow(/must name its open question/)
  })

  it('writes an audit row for the import', async () => {
    const [before] = (await sql`
      select count(*)::int as n from audit_event where action = 'opening_balances.imported'
    `) as unknown as { n: number }[]
    await importOnce('2027-06-01', `JE-OPEN-AUDIT-${RUN}`)
    const [after] = (await sql`
      select count(*)::int as n from audit_event where action = 'opening_balances.imported'
    `) as unknown as { n: number }[]
    // A delta, never a total: audit_event is append-only and cannot be truncated (ADR 0008).
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1)
  })
})

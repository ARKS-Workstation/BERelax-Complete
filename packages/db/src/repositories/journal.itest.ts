import { type AppError, isAppError } from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import { withUnitOfWork } from '../tx.ts'
import * as journalModule from './journal.ts'
import {
  accountTotals,
  isAppendOnlyViolation,
  isPeriodLocked,
  isUnbalancedEntry,
  JOURNAL_SQLSTATE,
  type JournalEntryInput,
  journalError,
  listPeriodLocks,
  lockAccountingPeriod,
  periodLockFor,
  postJournalEntry,
  readJournalEntry,
} from './journal.ts'

/**
 * M-TILL-02 against a real PostgreSQL.
 *
 * Every property here is a property of the *database*: a grant, a trigger that raises, and a
 * constraint whose whole point is that it is checked at COMMIT rather than at each statement. None of
 * the three can be tested against a mock — a mock would assert that the mock refuses UPDATE.
 *
 * Two shapes are deliberate throughout:
 *
 *   - **No assertion on "an error was raised".** Every refusal is matched on its SQLSTATE, and the
 *     append-only cases additionally on the trigger's own message. A bare rejection would pass just as
 *     happily if the statement had failed for a typo in the table name.
 *   - **Every assertion has a control that must fail.** After proving UPDATE is refused, the same
 *     transaction proves INSERT still works; after proving the grants are absent, the same query
 *     proves it can see a grant that IS present.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** A trading date in an open period. Every case that needs a locked one locks it explicitly. */
const TRADING_DATE = '2026-09-18'

/**
 * The till, as an actor. A role, not a person: therapists have no display name until an admin sets
 * one and no name is invented anywhere in this repository.
 */
const TILL: Actor = {
  kind: 'staff',
  id: '55555555-5555-5555-5555-555555555555',
  label: 'Till',
}

const CASH = '1010'
const REVENUE = '4010'
const OUTPUT_VAT = '2030'

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/**
 * Empties the journal between cases with TRUNCATE, as the owner.
 *
 * Not DELETE: the refusal triggers refuse a DELETE from every role including this one, which is the
 * property being tested. TRUNCATE does not fire a row-level DELETE trigger, and that is precisely why
 * 0018 revokes TRUNCATE from the application role — otherwise the one statement that can empty an
 * append-only table would be the one statement nobody had thought about.
 */
let testStartedAt: Date

beforeEach(async () => {
  await sql.unsafe('truncate journal_line, journal_entry cascade')
  await sql`delete from period_lock`
  // audit_event is append-only and shared with every other unit, so it cannot be truncated and a
  // TOTAL would be a different number on every machine and on every re-run of this file. Every count
  // below is a delta measured from here (brief rule 9).
  const [now] = await sql<{ now: Date }[]>`select now() as now`
  if (!now) throw new Error('the database did not answer select now()')
  testStartedAt = now.now
})

function saleOf(entryId: string, grossFils: number, entryDate = TRADING_DATE): JournalEntryInput {
  // A VAT-inclusive gross of 105 AED at 5%: net 100.00, VAT 5.00. Derived as gross - net so that
  // net + vat === gross exactly (ADR 0007); the figures are spelled out rather than computed here,
  // because computing them would make this fixture a second implementation of splitGross().
  const vat = grossFils - Math.round((grossFils * 20) / 21)
  return {
    entryId,
    entryDate,
    narrative: `Treatment sale ${entryId}`,
    source: 'sale',
    lines: [
      { accountCode: CASH, debitFils: grossFils, creditFils: 0, memo: 'cash taken' },
      { accountCode: REVENUE, debitFils: 0, creditFils: grossFils - vat },
      { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: vat },
    ],
  }
}

const post = (input: JournalEntryInput) =>
  withUnitOfWork(sql, TILL, (uow) => postJournalEntry(uow, input))

/** Audit rows written for `entityId` since this test began — a delta, never a total. */
async function auditCount(entityId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where entity_type = 'journal_entry' and entity_id = ${entityId}
      and occurred_at >= ${testStartedAt}
  `
  return Number(row?.n ?? '0')
}

/** Audit rows written for `action` since this test began. */
async function auditCountByAction(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where action = ${action} and occurred_at >= ${testStartedAt}
  `
  return Number(row?.n ?? '0')
}

/** Runs `body` as the application role, in its own transaction. */
async function asApplicationRole<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role berelax_app`
    return body(tx as unknown as Sql)
  }) as Promise<T>
}

/**
 * The SQLSTATE of a rejected promise, or undefined.
 *
 * Read from `err.code` for a raw statement and from `details.sqlState` for a repository call, which
 * translates the driver's error into an `AppError` and carries the code across. Either way the
 * assertion is on the SQLSTATE: "an error was raised" would pass just as happily for a typo in a
 * table name, which is how a test for a trigger ends up testing nothing.
 */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const translated = (err as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : translated
    return {
      code: typeof code === 'string' ? code : undefined,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

describe('posting', () => {
  it('appends an entry and its lines, and reads them back in line order', async () => {
    const posted = await post(saleOf('JE-POST-1', 10_500))
    expect(posted.lines.map((l) => l.lineNo)).toEqual([1, 2, 3])

    const stored = await readJournalEntry(sql, 'JE-POST-1')
    expect(stored?.entryDate).toBe(TRADING_DATE)
    expect(stored?.currency).toBe('AED')
    expect(stored?.reverses).toBeNull()
    expect(stored?.lines.map((l) => [l.accountCode, l.debitFils, l.creditFils])).toEqual([
      [CASH, 10_500, 0],
      [REVENUE, 0, 10_000],
      [OUTPUT_VAT, 0, 500],
    ])
    // net + vat === gross exactly, which is the reason gross is authoritative (ADR 0007).
    expect(10_000 + 500).toBe(10_500)

    // Control: reading an entry that was never posted returns null rather than an empty entry, so the
    // assertions above cannot be passing against a fabricated shape.
    expect(await readJournalEntry(sql, 'JE-NEVER-POSTED')).toBeNull()
  })

  it('refuses a draft that cannot be a double entry before it writes anything', async () => {
    const oneLine: JournalEntryInput = {
      entryId: 'JE-ONE-LINE',
      entryDate: TRADING_DATE,
      narrative: 'single line',
      source: 'adjustment',
      lines: [{ accountCode: CASH, debitFils: 100, creditFils: 0 }],
    }
    await expect(post(oneLine)).rejects.toThrow(/needs at least two/)
    expect(await readJournalEntry(sql, 'JE-ONE-LINE')).toBeNull()
    // The audit row is not written either: an audit row for a posting that never happened is as bad
    // as a posting with no audit row.
    expect(await auditCount('JE-ONE-LINE')).toBe(0)

    // A line with an amount on both sides, and a line with an amount on neither.
    const bothSides = {
      ...saleOf('JE-BOTH-SIDES', 10_500),
      lines: [
        { accountCode: CASH, debitFils: 100, creditFils: 100 },
        { accountCode: REVENUE, debitFils: 0, creditFils: 100 },
      ],
    }
    await expect(post(bothSides)).rejects.toThrow(/exactly one side/)

    const fractional = {
      ...saleOf('JE-FRACTIONAL', 10_500),
      lines: [
        { accountCode: CASH, debitFils: 10.5, creditFils: 0 },
        { accountCode: REVENUE, debitFils: 0, creditFils: 10.5 },
      ],
    }
    await expect(post(fractional)).rejects.toThrow(/fractional amount/)

    // Control: the same shape with integer fils on one side each does post, so the three refusals
    // above are about the defect and not about the fixture.
    await expect(post(saleOf('JE-CONTROL', 10_500))).resolves.toBeDefined()
  })

  it('refuses an account code the chart does not contain', async () => {
    const unknownAccount = {
      ...saleOf('JE-UNKNOWN-ACCOUNT', 10_500),
      lines: [
        { accountCode: '9999', debitFils: 100, creditFils: 0 },
        { accountCode: REVENUE, debitFils: 0, creditFils: 100 },
      ],
    }
    await expect(post(unknownAccount)).rejects.toThrow(
      /account or entry the database does not have/,
    )
    expect(await readJournalEntry(sql, 'JE-UNKNOWN-ACCOUNT')).toBeNull()
  })

  it('posts a reversal that points at the entry it corrects', async () => {
    const original = await post(saleOf('JE-ORIGINAL', 10_500))
    // Debits and credits swap, the absolute fils are untouched, and the date is an argument — this is
    // the shape reverseEntry() in @berelax/core produces.
    const reversal: JournalEntryInput = {
      entryId: 'JE-ORIGINAL-R',
      entryDate: '2026-09-20',
      narrative: 'Reversal of JE-ORIGINAL',
      source: 'reversal',
      reverses: 'JE-ORIGINAL',
      lines: original.lines.map((line) => ({
        accountCode: line.accountCode,
        debitFils: line.creditFils,
        creditFils: line.debitFils,
      })),
    }
    await post(reversal)

    const stored = await readJournalEntry(sql, 'JE-ORIGINAL-R')
    expect(stored?.reverses).toBe('JE-ORIGINAL')

    // The pair nets to nothing per account, which is what makes a reversal a correction rather than a
    // second transaction.
    const totals = await accountTotals(sql)
    for (const row of totals) {
      expect(row.debitFils).toBe(row.creditFils)
    }

    // Control: the original alone does NOT net to nothing, so the loop above is asserting something.
    await sql.unsafe('truncate journal_line, journal_entry cascade')
    await post(saleOf('JE-ALONE', 10_500))
    const alone = await accountTotals(sql)
    expect(alone.some((row) => row.debitFils !== row.creditFils)).toBe(true)
  })
})

describe('the journal is append-only', () => {
  it('UPDATE and DELETE on journal_line raise ZL001 with the named trigger message', async () => {
    await post(saleOf('JE-APPEND-1', 10_500))

    const updated = await stateOf(
      sql`update journal_line set memo = 'corrected' where entry_id = 'JE-APPEND-1' and line_no = 1`,
    )
    expect(updated.code).toBe(JOURNAL_SQLSTATE.appendOnly)
    expect(updated.message).toContain('journal_line is append-only')
    expect(updated.message).toContain('UPDATE is refused')

    const deleted = await stateOf(sql`delete from journal_line where entry_id = 'JE-APPEND-1'`)
    expect(deleted.code).toBe(JOURNAL_SQLSTATE.appendOnly)
    expect(deleted.message).toContain('DELETE is refused')

    // The row is still exactly as posted. A refusal that left the row changed would satisfy the
    // assertions above and still have rewritten history.
    const stored = await readJournalEntry(sql, 'JE-APPEND-1')
    expect(stored?.lines).toHaveLength(3)
    expect(stored?.lines[0]?.memo).toBe('cash taken')

    // Control: INSERT is not refused, so ZL001 is the append-only trigger and not the table being
    // unreachable for some unrelated reason.
    await expect(post(saleOf('JE-APPEND-2', 10_500))).resolves.toBeDefined()
  })

  it('UPDATE and DELETE on journal_entry raise ZL001 too', async () => {
    await post(saleOf('JE-APPEND-3', 10_500))

    const updated = await stateOf(
      sql`update journal_entry set narrative = 'rewritten' where entry_id = 'JE-APPEND-3'`,
    )
    expect(updated.code).toBe(JOURNAL_SQLSTATE.appendOnly)
    expect(updated.message).toContain('journal_entry is append-only')

    const deleted = await stateOf(sql`delete from journal_entry where entry_id = 'JE-APPEND-3'`)
    expect(deleted.code).toBe(JOURNAL_SQLSTATE.appendOnly)

    expect((await readJournalEntry(sql, 'JE-APPEND-3'))?.narrative).toBe(
      'Treatment sale JE-APPEND-3',
    )
  })

  it('the refusal fires for the owner, not only for the application role', async () => {
    // This is the half that privileges cannot cover. A migration, a psql session and any future admin
    // tool connect as the owner, and the owner is who rewrites history by hand at 2am.
    await post(saleOf('JE-OWNER', 10_500))
    const [me] = await sql<{ me: string }[]>`select current_user as me`
    expect(me?.me).not.toBe('berelax_app')

    const refused = await stateOf(sql`delete from journal_line where entry_id = 'JE-OWNER'`)
    expect(refused.code).toBe(JOURNAL_SQLSTATE.appendOnly)

    // Control: the same connection CAN delete from a table that is not append-only, so the refusal is
    // the trigger and not a read-only session.
    await sql`insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
              values ('DELETABLE', '2020-01-01', '2020-01-31', 'control row', 'system')`
    await expect(sql`delete from period_lock where period_id = 'DELETABLE'`).resolves.toBeDefined()
  })

  it('the application role is refused by the GRANT, before any trigger runs', async () => {
    await post(saleOf('JE-GRANT', 10_500))

    const updated = await stateOf(
      asApplicationRole((tx) => tx`update journal_line set memo = 'x' where entry_id = 'JE-GRANT'`),
    )
    // 42501, not ZL001: the privilege is absent, so the statement never reaches the trigger. That
    // ordering is the point of having both layers — an injected statement cannot get far enough to be
    // refused by a trigger somebody might later drop.
    expect(updated.code).toBe('42501')
    expect(updated.message).toMatch(/permission denied/)

    const deleted = await stateOf(
      asApplicationRole((tx) => tx`delete from journal_line where entry_id = 'JE-GRANT'`),
    )
    expect(deleted.code).toBe('42501')

    const truncated = await stateOf(asApplicationRole((tx) => tx.unsafe('truncate journal_line')))
    // TRUNCATE is the statement that would slip past a row-level trigger, so the privilege matters
    // more here than anywhere else.
    expect(truncated.code).toBe('42501')

    // Control: the application role CAN append, which is the privilege it is supposed to hold.
    const inserted = await asApplicationRole(async (tx) => {
      await tx`insert into journal_entry (entry_id, entry_date, narrative, source)
               values ('JE-APP-ROLE', ${TRADING_DATE}::date, 'posted by the app role', 'sale')`
      await tx`insert into journal_line (entry_id, line_no, account_code, debit_fils)
               values ('JE-APP-ROLE', 1, ${CASH}, 100)`
      await tx`insert into journal_line (entry_id, line_no, account_code, credit_fils)
               values ('JE-APP-ROLE', 2, ${REVENUE}, 100)`
      return 'appended'
    })
    expect(inserted).toBe('appended')
  })

  it('information_schema shows the application role holds no UPDATE or DELETE', async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
      from information_schema.role_table_grants
      where grantee = 'berelax_app'
        and table_schema = 'public'
        and table_name in ('journal_entry', 'journal_line')
      order by table_name, privilege_type
    `
    const held = rows.map((r) => `${r.table_name}.${r.privilege_type}`)
    expect(held).not.toContain('journal_line.UPDATE')
    expect(held).not.toContain('journal_line.DELETE')
    expect(held).not.toContain('journal_entry.UPDATE')
    expect(held).not.toContain('journal_entry.DELETE')
    expect(held).not.toContain('journal_line.TRUNCATE')

    // Two controls. First: the query really does return rows for these tables, so the four
    // assertions above are not passing because the role name or the schema filter is wrong.
    expect(held.sort()).toEqual([
      'journal_entry.INSERT',
      'journal_entry.SELECT',
      'journal_line.INSERT',
      'journal_line.SELECT',
    ])

    // Second: the same query DOES find an UPDATE grant where one exists. Without this, a query shape
    // that could never return the string 'UPDATE' would satisfy every assertion above.
    const mutable = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where grantee = 'berelax_app' and table_schema = 'public' and table_name = 'app_setting'
        and privilege_type = 'UPDATE'
    `
    expect(mutable.map((r) => r.privilege_type)).toEqual(['UPDATE'])
  })

  it('the chart of accounts is not writable by the application role', async () => {
    // Renumbering an account referenced by history means restating history. Adding or renaming one is
    // a migration, so the role holds SELECT and nothing else.
    const [priv] = await sql<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }[]>`
      select has_table_privilege('berelax_app', 'account', 'INSERT') as ins,
             has_table_privilege('berelax_app', 'account', 'UPDATE') as upd,
             has_table_privilege('berelax_app', 'account', 'DELETE') as del,
             has_table_privilege('berelax_app', 'account', 'SELECT') as sel
    `
    expect(priv?.ins).toBe(false)
    expect(priv?.upd).toBe(false)
    expect(priv?.del).toBe(false)
    // The control: SELECT is held, so the three falses are not a role that cannot see the table.
    expect(priv?.sel).toBe(true)
  })
})

describe('the balance invariant is deferred to COMMIT', () => {
  it('accepts each line insert and fails the COMMIT when they do not sum to zero', async () => {
    // The structure IS the proof. An immediate trigger would reject the first line of every two-line
    // entry ever posted, so a test that failed on the first insert would have proved the opposite of
    // what is wanted: that the constraint is unusable.
    const reached: string[] = []
    const outcome = await stateOf(
      sql.begin(async (tx) => {
        await tx`insert into journal_entry (entry_id, entry_date, narrative, source)
                 values ('JE-DEFERRED', ${TRADING_DATE}::date, 'lines inserted one by one', 'sale')`
        reached.push('entry inserted')
        await tx`insert into journal_line (entry_id, line_no, account_code, debit_fils)
                 values ('JE-DEFERRED', 1, ${CASH}, 10_500)`
        reached.push('debit line inserted')
        await tx`insert into journal_line (entry_id, line_no, account_code, credit_fils)
                 values ('JE-DEFERRED', 2, ${REVENUE}, 9_999)`
        reached.push('credit line inserted')
        // Every statement above succeeded while the entry was unbalanced. If any of them had raised,
        // `reached` would be short and the assertion below would fail.
        const [visible] = await tx<{ n: string }[]>`
          select count(*)::text as n from journal_line where entry_id = 'JE-DEFERRED'
        `
        reached.push(`${visible?.n} lines visible inside the transaction`)
      }),
    )

    expect(reached).toEqual([
      'entry inserted',
      'debit line inserted',
      'credit line inserted',
      '2 lines visible inside the transaction',
    ])
    // And the failure arrived at COMMIT.
    expect(outcome.code).toBe(JOURNAL_SQLSTATE.unbalancedEntry)
    expect(outcome.message).toContain('does not balance')
    expect(outcome.message).toContain('difference 501 fils')

    // The whole transaction rolled back, so no half-entry survives.
    expect(await readJournalEntry(sql, 'JE-DEFERRED')).toBeNull()

    // Control: the same three statements, with the credit corrected, commit. Without this the test
    // would pass equally well against a trigger that rejected every entry.
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into journal_entry (entry_id, entry_date, narrative, source)
                 values ('JE-BALANCED', ${TRADING_DATE}::date, 'lines inserted one by one', 'sale')`
        await tx`insert into journal_line (entry_id, line_no, account_code, debit_fils)
                 values ('JE-BALANCED', 1, ${CASH}, 10_500)`
        await tx`insert into journal_line (entry_id, line_no, account_code, credit_fils)
                 values ('JE-BALANCED', 2, ${REVENUE}, 10_500)`
        return 'committed'
      }),
    ).resolves.toBe('committed')
    expect((await readJournalEntry(sql, 'JE-BALANCED'))?.lines).toHaveLength(2)
  })

  it('the constraint is registered as DEFERRABLE INITIALLY DEFERRED, not merely late-firing', async () => {
    // Asserting the catalogue as well as the behaviour: the case above would also pass if the
    // constraint happened to be immediate and the driver happened to pipeline the statements.
    const rows = await sql<{ tgname: string; deferrable: boolean; deferred: boolean }[]>`
      select tgname, tgdeferrable as deferrable, tginitdeferred as deferred
      from pg_trigger
      where tgname in ('journal_line_entry_balanced', 'journal_entry_balanced')
      order by tgname
    `
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.deferrable).toBe(true)
      expect(row.deferred).toBe(true)
    }

    // Control: the period-lock guard on the same table is NOT deferred, because it is a property of
    // one row and there is nothing to wait for. If every trigger read as deferred, the assertion
    // above would be about the query rather than about the constraint.
    const [immediate] = await sql<{ deferrable: boolean }[]>`
      select tgdeferrable as deferrable from pg_trigger where tgname = 'journal_line_period_lock'
    `
    expect(immediate?.deferrable).toBe(false)
  })

  it('rejects an entry with no lines at all, which the line-level trigger cannot see', async () => {
    // No line insert means no line trigger, so without the entry-level deferred trigger an empty
    // entry would commit and sit in the journal as evidence of nothing.
    const outcome = await stateOf(
      sql.begin(
        (tx) => tx`insert into journal_entry (entry_id, entry_date, narrative, source)
                   values ('JE-EMPTY', ${TRADING_DATE}::date, 'no lines', 'adjustment')`,
      ),
    )
    expect(outcome.code).toBe(JOURNAL_SQLSTATE.unbalancedEntry)
    expect(outcome.message).toContain('has 0 line(s)')
    expect(await readJournalEntry(sql, 'JE-EMPTY')).toBeNull()
  })

  it('journalError translates the COMMIT failure by SQLSTATE, not by message', async () => {
    // The deferred failure arrives from COMMIT, which belongs to withUnitOfWork rather than to any
    // repository function — so the translation is exported for a caller to apply around its own
    // transaction. See the note in journal.ts.
    const unbalanced: JournalEntryInput = {
      entryId: 'JE-TRANSLATE',
      entryDate: TRADING_DATE,
      narrative: 'does not balance',
      source: 'adjustment',
      lines: [
        { accountCode: CASH, debitFils: 10_500, creditFils: 0 },
        { accountCode: REVENUE, debitFils: 0, creditFils: 9_999 },
      ],
    }
    let translated: ReturnType<typeof journalError> = null
    try {
      await post(unbalanced)
    } catch (err) {
      expect(isUnbalancedEntry(err)).toBe(true)
      expect(isPeriodLocked(err)).toBe(false)
      expect(isAppendOnlyViolation(err)).toBe(false)
      translated = journalError(err)
    }
    expect(translated?.kind).toBe('invariant_violated')
    expect(translated?.details['sqlState']).toBe(JOURNAL_SQLSTATE.unbalancedEntry)

    // Control: an error that is not one of ours is not translated into a ledger failure, so the
    // switch is reading the SQLSTATE rather than returning something for everything.
    expect(journalError(new Error('unrelated'))).toBeNull()
    expect(journalError({ code: '42P01' })).toBeNull()
  })
})

/**
 * Every period here is in 2088, and the far-future year is load-bearing rather than whimsical.
 *
 * M-VAT-06's migration 0073 gave `period_lock` a BEFORE INSERT trigger: a period containing a document
 * the ledger does not account for cannot be closed (ZE002). These cases are about the LOCK — what it
 * refuses to let be posted, that two of them cannot overlap, that the application role cannot reopen
 * one — and not about what happens to be dated inside it, so they need a range no document suite can
 * reach into.
 *
 * They used to say 2026, and so does `invoice.itest.ts`, which issues invoices with a tax point of
 * 2026-09-18 through `issueInvoice` — the primitive `finaliseCheckout` calls, which posts no journal
 * entry — and leaves its last one behind. `2026-Q3` spans that date, so the overlapping-locks case
 * became a close of a period with an unposted invoice in it, and whether it passed depended on which of
 * the two files vitest reached first: measured green in one order and red in the other, on the same
 * commit and the same database. That is brief rule 12's failure exactly, and the fix it asks for is to
 * narrow what the code under test can see rather than to delete another suite's rows — `invoice` refuses
 * DELETE for every role (ZI003), so the only way to clear them is a TRUNCATE of the whole document
 * family, which seven suites across six units rely on the shape of.
 *
 * Nothing in the file's other blocks moves: they post entries and never close a period.
 */
describe('period locks', () => {
  const lock = (periodId: string, startsOn: string, endsOn: string) =>
    withUnitOfWork(sql, TILL, (uow) =>
      lockAccountingPeriod(uow, {
        periodId,
        startsOn,
        endsOn,
        reason: 'VAT return filed',
        lockedByActorKind: 'staff',
        lockedByActorId: TILL.id ?? null,
      }),
    )

  it('refuses a journal_line whose entry_date falls inside a locked period, naming the period', async () => {
    // The entry is posted while the period is open, so the LINE is what meets the lock. That is the
    // acceptance criterion exactly: a line appended to an entry after the period closed.
    await post(saleOf('JE-LOCKED', 10_500, '2088-08-31'))
    await lock('2088-08', '2088-08-01', '2088-08-31')

    const refused = await stateOf(
      sql`insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values ('JE-LOCKED', 4, ${REVENUE}, 1)`,
    )
    expect(refused.code).toBe(JOURNAL_SQLSTATE.periodLocked)
    expect(refused.message).toContain('PeriodLocked')
    // The period identifier is in the message. Without it the person reading the failure goes looking
    // in the wrong month, and the entry they then chase is usually the correct one.
    expect(refused.message).toContain('"2088-08"')
    expect(refused.message).toContain('2088-08-31')

    // It failed at the INSERT, not at COMMIT: the guard is immediate, so the balance check never got
    // the chance to report a different problem for the same statement.
    expect(refused.code).not.toBe(JOURNAL_SQLSTATE.unbalancedEntry)

    // Control: with the period reopened, the identical append succeeds. Without this the case would
    // pass just as happily against a journal_line that had stopped accepting inserts altogether. The
    // pair of lines keeps the entry balanced, so the deferred check at COMMIT is satisfied too.
    await sql`delete from period_lock where period_id = '2088-08'`
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into journal_line (entry_id, line_no, account_code, credit_fils)
                 values ('JE-LOCKED', 4, ${REVENUE}, 1)`
        await tx`insert into journal_line (entry_id, line_no, account_code, debit_fils)
                 values ('JE-LOCKED', 5, ${CASH}, 1)`
        return 'appended'
      }),
    ).resolves.toBe('appended')
    expect((await readJournalEntry(sql, 'JE-LOCKED'))?.lines).toHaveLength(5)
  })

  it('refuses a whole posting into a locked period, as a translated AppError', async () => {
    await lock('2088-07', '2088-07-01', '2088-07-31')
    const refused = await stateOf(post(saleOf('JE-INTO-LOCKED', 10_500, '2088-07-15')))
    expect(refused.code).toBe(JOURNAL_SQLSTATE.periodLocked)
    expect(refused.message).toContain('"2088-07"')

    // Refused at the INSERT, so postJournalEntry saw it and translated it already: what the caller
    // catches is an AppError carrying the SQLSTATE, not a driver error it has to classify itself.
    let caught: unknown
    try {
      await post(saleOf('JE-INTO-LOCKED-2', 10_500, '2088-07-15'))
    } catch (err) {
      caught = err
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as AppError).kind).toBe('conflict')
    expect((caught as AppError).details['sqlState']).toBe(JOURNAL_SQLSTATE.periodLocked)
    expect(isPeriodLocked(caught)).toBe(true)
    expect(isUnbalancedEntry(caught)).toBe(false)

    // Nothing was written, including no audit row for a posting that did not happen.
    expect(await readJournalEntry(sql, 'JE-INTO-LOCKED')).toBeNull()
    expect(await auditCount('JE-INTO-LOCKED')).toBe(0)

    // Control: the day after the lock ends posts normally, so the refusal is the range and not the
    // posting path. A lock that closed every date would satisfy the assertions above.
    await expect(post(saleOf('JE-AFTER-LOCK', 10_500, '2088-08-01'))).resolves.toBeDefined()
  })

  it('a reversal dated in an open period corrects an entry inside a locked one', async () => {
    // The reason reverseEntry() takes the date as an argument instead of reading a clock: a correction
    // found in September for an August entry is dated in September because August is closed. Only the
    // caller, which knows the locks, can decide.
    await post(saleOf('JE-AUGUST', 10_500, '2088-08-20'))
    await lock('2088-08', '2088-08-01', '2088-08-31')

    const original = await readJournalEntry(sql, 'JE-AUGUST')
    const reversal: JournalEntryInput = {
      entryId: 'JE-AUGUST-R',
      entryDate: '2088-09-01',
      narrative: 'Reversal of JE-AUGUST',
      source: 'reversal',
      reverses: 'JE-AUGUST',
      lines: (original?.lines ?? []).map((line) => ({
        accountCode: line.accountCode,
        debitFils: line.creditFils,
        creditFils: line.debitFils,
      })),
    }
    await expect(post(reversal)).resolves.toBeDefined()

    // Control: the same reversal dated INSIDE the locked period is refused, which is the whole reason
    // the date is an argument.
    const backdated = await stateOf(
      post({ ...reversal, entryId: 'JE-AUGUST-R2', entryDate: '2088-08-31' }),
    )
    expect(backdated.code).toBe(JOURNAL_SQLSTATE.periodLocked)
  })

  it('refuses two overlapping locks, so the named period is never ambiguous', async () => {
    await lock('2088-Q3', '2088-07-01', '2088-09-30')
    const overlapping = await stateOf(lock('2088-09', '2088-09-01', '2088-09-30'))
    expect(overlapping.code).toBe('23P01')

    let caught: unknown
    try {
      await lock('2088-08-again', '2088-08-01', '2088-08-31')
    } catch (err) {
      caught = err
    }
    expect(isAppError(caught)).toBe(true)
    expect((caught as AppError).kind).toBe('conflict')
    expect((caught as AppError).message).toContain('Overlapping accounting period lock')

    // Control: an adjacent, non-overlapping period locks fine. ends_on is the last day OF the period,
    // so Q4 starts the day after Q3 ends and the inclusive ranges do not touch.
    await expect(lock('2088-Q4', '2088-10-01', '2088-12-31')).resolves.toBeDefined()
    expect((await listPeriodLocks(sql)).map((l) => l.periodId)).toEqual(['2088-Q3', '2088-Q4'])
  })

  it('periodLockFor answers with the same range the trigger uses', async () => {
    await lock('2088-08', '2088-08-01', '2088-08-31')
    expect(await periodLockFor(sql, '2088-08-01')).toBe('2088-08')
    expect(await periodLockFor(sql, '2088-08-31')).toBe('2088-08')
    // Inclusive at both ends: an exclusive ends_on would leave the last day of every filed period
    // open, which is the day the cash-up runs.
    expect(await periodLockFor(sql, '2088-07-31')).toBeNull()
    expect(await periodLockFor(sql, '2088-09-01')).toBeNull()
    await expect(periodLockFor(sql, '31/08/2088')).rejects.toThrow(/ISO business day/)
  })

  it('the application role cannot reopen a period it closed', async () => {
    await lock('2088-08', '2088-08-01', '2088-08-31')
    const reopened = await stateOf(
      asApplicationRole((tx) => tx`delete from period_lock where period_id = '2088-08'`),
    )
    expect(reopened.code).toBe('42501')
    const shortened = await stateOf(
      asApplicationRole(
        (tx) => tx`update period_lock set ends_on = '2088-08-01' where period_id = '2088-08'`,
      ),
    )
    expect(shortened.code).toBe('42501')

    // Control: it CAN close one, which is an operation rather than a schema change.
    await expect(
      asApplicationRole(
        (
          tx,
        ) => tx`insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
                   values ('2088-06', '2088-06-01', '2088-06-30', 'filed', 'staff')`,
      ),
    ).resolves.toBeDefined()
  })
})

describe('every posting is audited', () => {
  it('writes exactly one audit_event per posting, with an explicit before and a full after', async () => {
    // The whole criterion is "fails on zero", so the interesting number is the delta: two postings,
    // two rows, one each.
    expect(await auditCountByAction('ledger.entry.post')).toBe(0)

    await post(saleOf('JE-AUDIT-1', 10_500))
    await post(saleOf('JE-AUDIT-2', 21_000))

    expect(await auditCountByAction('ledger.entry.post')).toBe(2)
    expect(await auditCount('JE-AUDIT-1')).toBe(1)
    expect(await auditCount('JE-AUDIT-2')).toBe(1)
    // Control: an entity nobody posted has none, so the counts above are not a query that matches
    // every row in the table.
    expect(await auditCount('JE-NEVER-POSTED')).toBe(0)

    const [row] = await sql<
      {
        actor_kind: string
        actor_label: string | null
        operation: string
        has_before: boolean
        after_lines: number
        after_date: string
        after_entry: string
      }[]
    >`
      select actor_kind,
             actor_label,
             operation,
             before_state is not null                   as has_before,
             jsonb_array_length(after_state -> 'lines')  as after_lines,
             after_state ->> 'entryDate'                 as after_date,
             after_state ->> 'entryId'                   as after_entry
      from audit_event
      where entity_type = 'journal_entry' and entity_id = 'JE-AUDIT-1'
        and occurred_at >= ${testStartedAt}
    `
    expect(row?.actor_kind).toBe('staff')
    expect(row?.actor_label).toBe('Till')
    expect(row?.operation).toBe('create')
    // The `after` state is the whole posting, lines included, so the audit row alone answers "what was
    // posted" without a join back to a table nobody may edit anyway.
    expect(row?.after_lines).toBe(3)
    expect(row?.after_date).toBe(TRADING_DATE)
    expect(row?.after_entry).toBe('JE-AUDIT-1')
    // No `before`, because a fresh posting has no prior state. Recording one would be a record of
    // something that never existed. The reversal case below is where the pair is real.
    expect(row?.has_before).toBe(false)
  })

  it('a reversal records the entry it corrects as the before state', async () => {
    await post(saleOf('JE-AUDITED-ORIGINAL', 10_500))
    const original = await readJournalEntry(sql, 'JE-AUDITED-ORIGINAL')
    await post({
      entryId: 'JE-AUDITED-ORIGINAL-R',
      entryDate: '2026-09-20',
      narrative: 'Reversal of JE-AUDITED-ORIGINAL',
      source: 'reversal',
      reverses: 'JE-AUDITED-ORIGINAL',
      lines: (original?.lines ?? []).map((line) => ({
        accountCode: line.accountCode,
        debitFils: line.creditFils,
        creditFils: line.debitFils,
      })),
    })

    const [row] = await sql<
      { before_entry: string | null; before_lines: number | null; after_reverses: string | null }[]
    >`
      select before_state ->> 'entryId'                  as before_entry,
             jsonb_array_length(before_state -> 'lines')  as before_lines,
             after_state  ->> 'reverses'                  as after_reverses
      from audit_event
      where entity_type = 'journal_entry' and entity_id = 'JE-AUDITED-ORIGINAL-R'
        and occurred_at >= ${testStartedAt}
    `
    // The pair: what was corrected, and what corrected it. Read back inside the posting transaction,
    // so it is what the journal holds rather than what the caller said it held.
    expect(row?.before_entry).toBe('JE-AUDITED-ORIGINAL')
    expect(row?.before_lines).toBe(3)
    expect(row?.after_reverses).toBe('JE-AUDITED-ORIGINAL')

    // Control: the original's own audit row has no before state, so `has_before` is tracking the
    // reversal rather than being true for every posting.
    const [plain] = await sql<{ has_before: boolean }[]>`
      select before_state is not null as has_before from audit_event
      where entity_type = 'journal_entry' and entity_id = 'JE-AUDITED-ORIGINAL'
        and occurred_at >= ${testStartedAt}
    `
    expect(plain?.has_before).toBe(false)
  })

  it('the audit row and the posting share a transaction, so neither survives alone', async () => {
    await expect(
      withUnitOfWork(sql, TILL, async (uow) => {
        await postJournalEntry(uow, saleOf('JE-ROLLBACK', 10_500))
        // Whatever happens after a successful posting — a card capture, a printer, a second write —
        // taking the audit row down with the posting is the only acceptable outcome.
        throw new Error('deliberate failure after posting')
      }),
    ).rejects.toThrow('deliberate failure')

    expect(await auditCountByAction('ledger.entry.post')).toBe(0)
    expect(await readJournalEntry(sql, 'JE-ROLLBACK')).toBeNull()

    // Control: the identical call without the throw leaves exactly one of each, so the zero above is
    // the rollback and not a posting path that never audits.
    await post(saleOf('JE-COMMITTED', 10_500))
    expect(await auditCountByAction('ledger.entry.post')).toBe(1)
    expect(await auditCount('JE-COMMITTED')).toBe(1)
  })

  it('publishes one outbox event per posting, in the same transaction', async () => {
    // A fresh entry id per run, because the idempotency key is derived from it: `on conflict do
    // nothing` would swallow the second run's event and the delta below would read zero for a reason
    // that has nothing to do with publishing. In production an entry id is issued once, which is what
    // makes deriving the key from it correct.
    const entryId = `JE-OUTBOX-${process.hrtime.bigint().toString(36)}`
    await post(saleOf(entryId, 10_500))

    const rows = await sql<{ aggregate_id: string; idempotency_key: string }[]>`
      select aggregate_id, idempotency_key from outbox_event
      where event_type = 'ledger.entry.posted' and aggregate_id = ${entryId}
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.idempotency_key).toBe(`ledger.entry.posted:${entryId}`)

    // And the event is gone if the posting is. The outbox exists so that a state change and the news
    // of it cannot disagree (ADR 0008).
    const rolledBack = `${entryId}-ROLLED-BACK`
    await expect(
      withUnitOfWork(sql, TILL, async (uow) => {
        await postJournalEntry(uow, saleOf(rolledBack, 10_500))
        throw new Error('deliberate failure after publishing')
      }),
    ).rejects.toThrow('deliberate failure')
    const orphaned = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event where aggregate_id = ${rolledBack}
    `
    expect(Number(orphaned[0]?.n ?? '-1')).toBe(0)
  })
})

describe('the write surface', () => {
  it('exports no way to edit, void or delete a posting', async () => {
    // Append-only is a property of the schema, but a function named voidJournalEntry() would be an
    // invitation to find a way, and the first person to need one would add the grant rather than the
    // reversal. The absence is asserted so it stays absent.
    const exported = Object.keys(journalModule)
    const forbidden = exported.filter((name) =>
      /update|delete|edit|void|amend|patch|unlock|reopen/i.test(name),
    )
    expect(forbidden).toEqual([])

    // Controls. First: the module really was introspected, and it exports the write path it should.
    expect(exported).toContain('postJournalEntry')
    expect(exported).toContain('lockAccountingPeriod')
    expect(exported.length).toBeGreaterThan(5)
    // Second: the regex does match the names it is looking for, so the empty list above means
    // something. Without this the test would pass against a regex that matched nothing at all.
    expect(['voidJournalEntry', 'updateLine'].filter((n) => /update|void/i.test(n))).toHaveLength(2)
  })
})

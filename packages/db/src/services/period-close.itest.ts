import type { AppError } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import * as dbModule from '../index.ts'
import { JOURNAL_SQLSTATE, postJournalEntry, readJournalEntry } from '../repositories/journal.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  closeAccountingPeriod,
  earliestOpenDateFrom,
  PERIOD_CLOSE_SQLSTATE,
  periodCloseBlockers,
  periodStatusOn,
  postDatedCorrection,
  trialBalanceHashAsAt,
} from './period-close.ts'

/**
 * M-VAT-06 — the period close, the refusals that guard it, and correction by dated reversal.
 *
 * ## Why every case here needs real PostgreSQL
 *
 * Nothing in this unit is enforced by TypeScript. The close is refused by a `BEFORE INSERT` trigger on
 * `period_lock` (ZE001, ZE002) that binds every role including the owner; the posting refusal is 0018's
 * pair of guards calling a function 0073 redefined; the evidence hash is a SQL function so that a `psql`
 * session and a report written in five years reproduce it identically. A mock would prove none of it, and
 * the service functions are deliberately thin over the database for exactly that reason.
 *
 * ## The year is 2093, and nothing here is deleted
 *
 * The journal refuses UPDATE and DELETE for every role (ZL001), so the entries this suite posts are
 * permanent — every figure below is therefore a delta over this suite's own writes, never a total. The
 * periods are in 2093 so they cannot overlap a lock any other suite takes: `journal.itest.ts` uses 2088,
 * `issue-credit-note.itest.ts` 2097, `checkout-finalise.itest.ts` 2099, and `post-bill.itest.ts` computes
 * its own range as the fortnight after `max(ends_on)`. Two locks sharing a day is refused by
 * `period_lock_no_overlap`, which would present as this suite failing on somebody else's branch.
 *
 * The locks this suite takes ARE removed, in `beforeAll` and `afterAll`, and by `period_id` prefix so it
 * can only ever remove its own. Not tidiness: `period_lock_no_overlap` would refuse the second run
 * against the same database, because the second run wants the same dates under a different id. Deleting
 * a lock is what `journal.itest.ts` already does to reset, and it is available here for the reason ADR
 * 0026 records — `period_lock` carries no refusal trigger, deliberately.
 *
 * Every invoice this suite writes lives inside a transaction that is rolled back, because `invoice`
 * refuses DELETE for every role (ZI003) and an unposted invoice left behind in 2093 would be a straggler
 * that makes a later close of that year refuse for a reason nothing in this file explains.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = {
  kind: 'staff',
  id: '66666666-6666-6666-6666-666666666666',
  label: 'm-vat-06-itest',
} as const

const CASH = '1010'
const REVENUE = '4010'
const OUTPUT_VAT = '2030'

/** Unique per run: the entries this suite posts can never be deleted. */
const RUN = Date.now().toString(36)
const PREFIX = 'MVAT06'

const AUGUST = {
  periodId: `${PREFIX}-2093-08`,
  startsOn: '2093-08-01',
  endsOn: '2093-08-31',
} as const
const SEPTEMBER = {
  periodId: `${PREFIX}-2093-09`,
  startsOn: '2093-09-01',
  endsOn: '2093-09-30',
} as const
/** August and September both filed, so the earliest open date is neither of them. */
const FIRST_OPEN_DAY = '2093-10-01'

const SALE_ENTRY = `${PREFIX}-${RUN}-SALE`
const SALE_DATE = '2093-08-20'
const SALE_GROSS = 26_250
const SALE_VAT = 1_250

let sql: Sql

const saleLines = (grossFils: number, vatFils: number) => [
  { accountCode: CASH, debitFils: grossFils, creditFils: 0, memo: 'cash taken' },
  { accountCode: REVENUE, debitFils: 0, creditFils: grossFils - vatFils },
  { accountCode: OUTPUT_VAT, debitFils: 0, creditFils: vatFils },
]

/** The reversal of {@link saleLines}: every side swapped, every absolute fils untouched. */
const reversalLines = (grossFils: number, vatFils: number) =>
  saleLines(grossFils, vatFils).map((line) => ({
    accountCode: line.accountCode,
    debitFils: line.creditFils,
    creditFils: line.debitFils,
    ...(line.memo === undefined ? {} : { memo: line.memo }),
  }))

/** The `AppError` a promise rejected with, so its `details` can be asserted rather than its text. */
async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
    throw new Error('expected a refusal; the call resolved')
  } catch (err) {
    return err as AppError
  }
}

/**
 * The SQLSTATE and message of a rejected statement.
 *
 * Read from `err.code` for a raw statement and from `details.sqlState` for a repository call, which
 * translates the driver's error into an `AppError` and carries the code across. Either way the assertion
 * is on the SQLSTATE: "an error was raised" would pass just as happily for a typo in a table name, which
 * is how a test for a trigger ends up testing nothing.
 */
async function stateOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
    return { code: 'RESOLVED', message: 'the statement was accepted' }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const translated = (err as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : translated
    return {
      code: typeof code === 'string' ? code : 'NO_CODE',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Runs `body` as `berelax_app` inside a transaction, so `set local role` cannot leak.
 *
 * One statement per query: postgres.js prepares each one, and a prepared statement may not contain two
 * commands -- `set role ...; delete ...` in a single template comes back as `42601`, a syntax error,
 * which reads exactly like the grant having been checked when nothing was.
 */
async function asApplicationRole<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role berelax_app`
    return body(tx as unknown as Sql)
  }) as Promise<T>
}

const removeOwnLocks = () => sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

/**
 * One unposted invoice: an `invoice` row with no `checkout_finalisation` referencing it.
 *
 * That is the reachable "unposted document", and it is reachable because `issueInvoice` (M-TILL-04) is
 * the primitive `finaliseCheckout` (M-TILL-06) calls — a caller that reaches it directly commits a
 * document the ledger has never heard of. Inserted raw rather than through `issueInvoice` so the case is
 * about the state and not about that repository's own validation.
 */
const insertUnpostedInvoice = (uow: { sql: Sql }, taxPoint: string, label: string) => uow.sql`
  insert into invoice (
    document_kind, series_code, period_key, number, display_number,
    issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
    customer_name_snapshot, issue_date, tax_point_date, net_total, vat_total, gross_total, notes
  ) values (
    'tax_invoice', 'TAX-INV', ${`${PREFIX}-${RUN}`}, 930900, ${label},
    'BE RELAX SPA - L.L.C - O.P.C', 'BE RELAX - Massage Center and Spa', '100123456700003',
    '250 Al Meena Street', 'Abu Dhabi', 'Customer 0042',
    ${taxPoint}::date, ${taxPoint}::date, 2857, 143, 3000, ${label}
  )
  returning id
`

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  // Defensive: a previous run that was killed between its cases leaves its locks behind, and
  // `period_lock_no_overlap` would then refuse this run's first close for a reason unrelated to it.
  await removeOwnLocks()
  await withUnitOfWork(sql, ACTOR, (uow) =>
    postJournalEntry(uow, {
      entryId: SALE_ENTRY,
      entryDate: SALE_DATE,
      narrative: 'Aromatherapy 60 min, cash',
      source: 'sale',
      lines: saleLines(SALE_GROSS, SALE_VAT),
    }),
  )
})

afterAll(async () => {
  await removeOwnLocks()
  await sql.end()
})

describe('closing is refused unless the books balance and every document is posted', () => {
  it('names every unposted document, as data and not only in the message', async () => {
    const label = `${PREFIX}-${RUN}-UNPOSTED`
    const refusal = await refusalOf(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        await insertUnpostedInvoice(uow, '2093-08-15', label)
        return closeAccountingPeriod(uow, {
          ...AUGUST,
          reason: 'VAT return filed',
          closedByActorKind: 'staff',
          closedByActorId: ACTOR.id,
        })
      }),
    )

    expect(refusal.kind).toBe('conflict')
    expect(refusal.message).toContain(label)
    // The ids as DATA, which is the whole reason `closeAccountingPeriod` reads the blockers itself: a
    // screen offering "post these first" cannot parse them out of a sentence.
    const documents = (refusal.details as { unpostedDocuments?: { documentLabel: string }[] })
      .unpostedDocuments
    expect(documents?.map((d) => d.documentLabel)).toEqual([label])

    // The whole transaction rolled back, so neither the invoice nor the lock survives.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from invoice where display_number = ${label}
    `
    expect(Number(row?.n ?? '-1')).toBe(0)
    expect((await periodStatusOn(sql, '2093-08-15')).closed).toBe(false)
  })

  it('is refused by the DATABASE and not only by the service, for the owner too', async () => {
    // The service's refusal above is the good error message. This is the rule: a bare INSERT into
    // `period_lock`, as the role a migration and a psql session connect as, with no TypeScript anywhere
    // in the path. `closeAccountingPeriod` is not the only caller of that table and must not be the only
    // thing that checks.
    const label = `${PREFIX}-${RUN}-RAW`
    const refused = await stateOf(
      sql.begin(async (tx) => {
        await insertUnpostedInvoice({ sql: tx as unknown as Sql }, '2093-08-16', label)
        await tx`
          insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
          values (${AUGUST.periodId}, ${AUGUST.startsOn}::date, ${AUGUST.endsOn}::date, 'raw', 'system')
        `
      }),
    )
    expect(refused.code).toBe(PERIOD_CLOSE_SQLSTATE.hasUnpostedDocuments)
    expect(refused.message).toContain('PeriodHasUnpostedDocuments')
    expect(refused.message).toContain(label)
  })

  it('CONTROL: the same period closes once that invoice is in the ledger', async () => {
    // Without this, both cases above would also pass for a trigger that refused every close. The
    // invoice is identical; what changes is the `checkout_finalisation` row, which is what "posted"
    // means for an invoice.
    const label = `${PREFIX}-${RUN}-POSTED`
    const entryId = `${PREFIX}-${RUN}-POSTED-E`
    const accepted = await stateOf(
      sql.begin(async (tx) => {
        const [invoice] = (await insertUnpostedInvoice(
          { sql: tx as unknown as Sql },
          '2093-08-17',
          label,
        )) as unknown as { id: string }[]
        await tx`
          insert into invoice_line (
            invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp,
            line_net_fils, line_vat_fils
          ) values (${invoice?.id ?? null}, 1, 'Control treatment', 3, 1000, 500, 2857, 143)
        `
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${entryId}, '2093-08-17'::date, 'Control sale', 'sale')
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils)
          values (${entryId}, 1, ${CASH}, 3000)
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values (${entryId}, 2, ${REVENUE}, 2857)
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values (${entryId}, 3, ${OUTPUT_VAT}, 143)
        `
        await tx`
          insert into checkout_finalisation (
            idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id,
            trading_date, tender_total_fils
          ) values (
            ${`${PREFIX}-${RUN}-K`}, 'fp', 'basket', ${invoice?.id ?? null}, ${entryId},
            '2093-08-17'::date, 3000
          )
        `
        await tx`
          insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
          values (${AUGUST.periodId}, ${AUGUST.startsOn}::date, ${AUGUST.endsOn}::date, 'ok', 'system')
        `
        // The deferred rules — the entry's balance, the invoice's totals against its lines — fire at a
        // COMMIT that never comes, so they are forced before the rollback. Without this the case would
        // pass for an unbalanced control.
        await tx`set constraints all immediate`
        throw new Error('deliberate rollback: this control must leave nothing behind')
      }),
    )
    expect(refusalMessage(accepted)).toContain('deliberate rollback')
  })

  it('refuses a close whose trial balance does not balance, naming the difference in fils', async () => {
    // Every committed entry balances, because `assert_entry_balanced` is a deferred constraint trigger
    // per entry — so an out-of-balance trial balance is unreachable through any posting path, and ZE001
    // is a backstop rather than a rule callers meet. It is still asserted, and the only honest way to
    // assert it is to remove the thing that makes it unreachable: the balance triggers are disabled
    // inside a transaction that rolls back, which needs the table owner and is why this case cannot be
    // written against the application role.
    //
    // A backstop that has never been seen to fire is not a backstop (ADR 0003). If `journal_line` ever
    // gains a second write path, or the deferred trigger is dropped in a migration, this is the rule
    // that stops a period being filed on books that do not add up.
    const refused = await stateOf(
      sql.begin(async (tx) => {
        await tx`alter table journal_line disable trigger journal_line_entry_balanced`
        await tx`alter table journal_entry disable trigger journal_entry_balanced`
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`${PREFIX}-${RUN}-OOB`}, '2093-08-10'::date, 'Unbalanced', 'adjustment')
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils)
          values (${`${PREFIX}-${RUN}-OOB`}, 1, ${CASH}, 7)
        `
        const [difference] = (await tx`
          select period_trial_balance_difference_fils('2093-08-31'::date)::text as d
        `) as unknown as { d: string }[]
        // The control for the fixture itself: the ledger really is out, and by the amount inserted.
        expect(difference?.d).toBe('7')
        await tx`
          insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
          values (${AUGUST.periodId}, ${AUGUST.startsOn}::date, ${AUGUST.endsOn}::date, 'oob', 'system')
        `
      }),
    )
    expect(refused.code).toBe(PERIOD_CLOSE_SQLSTATE.willNotBalance)
    expect(refused.message).toContain('PeriodWillNotBalance')
    expect(refused.message).toContain('out by 7 fils')

    // And the rollback took the disabled triggers with it, so the next case is not running against a
    // journal with its balance check switched off. Asserted rather than assumed: a leftover would make
    // every later suite in the run pass for the wrong reason.
    const [enabled] = await sql<{ n: string }[]>`
      select count(*)::text as n from pg_trigger
       where tgname = 'journal_line_entry_balanced' and tgenabled = 'O'
    `
    expect(Number(enabled?.n ?? '-1')).toBe(1)
  })

  it('periodCloseBlockers reports the same two facts the trigger checks', async () => {
    const readiness = await periodCloseBlockers(sql, AUGUST)
    expect(readiness.differenceFils).toBe(0n)
    expect(readiness.unpostedDocuments).toEqual([])
    expect(readiness.closeable).toBe(true)
    // The control: a range with the straggler in it is not closeable, read through the same function.
    const label = `${PREFIX}-${RUN}-READINESS`
    await sql
      .begin(async (tx) => {
        await insertUnpostedInvoice({ sql: tx as unknown as Sql }, '2093-08-18', label)
        const blocked = await periodCloseBlockers(tx as unknown as Sql, AUGUST)
        expect(blocked.closeable).toBe(false)
        expect(blocked.unpostedDocuments.map((d) => d.documentKind)).toEqual(['invoice'])
        throw new Error('deliberate rollback')
      })
      .catch(() => undefined)
  })
})

describe('after the close', () => {
  let hashAtClose = ''
  let auditedHash: string | null = null
  let lineHashesBefore: string[] = []

  beforeAll(async () => {
    lineHashesBefore = await lineHashesOf(SALE_ENTRY)

    const before = await auditCount('ledger.period.closed')
    const closed = await withUnitOfWork(sql, ACTOR, (uow) =>
      closeAccountingPeriod(uow, {
        ...AUGUST,
        reason: 'VAT return filed',
        closedByActorKind: 'staff',
        closedByActorId: ACTOR.id,
      }),
    )
    hashAtClose = closed.trialBalanceHash
    // September as well, so the earliest open date is neither the locked period nor the month after it.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      closeAccountingPeriod(uow, {
        ...SEPTEMBER,
        reason: 'VAT return filed',
        closedByActorKind: 'staff',
        closedByActorId: ACTOR.id,
      }),
    )
    expect(await auditCount('ledger.period.closed')).toBe(before + 2)

    const [row] = await sql<{ hash: string | null; label: string | null; kind: string }[]>`
      select after_state ->> 'trialBalanceHash' as hash, actor_label as label, actor_kind as kind
      from audit_event
      where action = 'ledger.period.closed' and entity_id = ${AUGUST.periodId}
      order by occurred_at desc limit 1
    `
    auditedHash = row?.hash ?? null
    expect(row?.label).toBe(ACTOR.label)
    expect(row?.kind).toBe('staff')
  })

  it('writes an audit_event naming the closer and the trial balance hash', () => {
    expect(auditedHash).toBe(hashAtClose)
    expect(hashAtClose).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reproduces that hash byte for byte when the trial balance is recomputed later', async () => {
    // Recomputed after two further closes and whatever else this suite has posted since. The hash is
    // over the position as at 2093-08-31, so nothing dated after that date may move it.
    expect(await trialBalanceHashAsAt(sql, AUGUST.endsOn)).toBe(hashAtClose)

    // Two controls, because a hash that never changes is a constant and not a content hash.
    // First: a different date is a different position.
    expect(await trialBalanceHashAsAt(sql, SEPTEMBER.endsOn)).not.toBe(hashAtClose)
    // Second: a posting INSIDE the hashed window changes it. Rolled back, because it would otherwise
    // have to go into a period that is now closed.
    await sql
      .begin(async (tx) => {
        await tx`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`${PREFIX}-${RUN}-HASH`}, '2093-07-01'::date, 'Moves the hash', 'adjustment')
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils)
          values (${`${PREFIX}-${RUN}-HASH`}, 1, ${CASH}, 100)
        `
        await tx`
          insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values (${`${PREFIX}-${RUN}-HASH`}, 2, ${REVENUE}, 100)
        `
        expect(await trialBalanceHashAsAt(tx as unknown as Sql, AUGUST.endsOn)).not.toBe(
          hashAtClose,
        )
        throw new Error('deliberate rollback')
      })
      .catch(() => undefined)
  })

  it('answers "is this period closed" with the locked period and the earliest open date', async () => {
    const status = await periodStatusOn(sql, SALE_DATE)
    expect(status.closed).toBe(true)
    expect(status.periodId).toBe(AUGUST.periodId)
    // Past the adjacent lock. A caller told "September" would re-date the correction into a month that
    // is also shut, which is the half-answer 0018's message gave on its own.
    expect(status.earliestOpenDate).toBe(FIRST_OPEN_DAY)
    expect(await earliestOpenDateFrom(sql, SALE_DATE)).toBe(FIRST_OPEN_DAY)

    // The control: an open date reports itself, so `earliestOpenDate` is not a constant.
    const open = await periodStatusOn(sql, FIRST_OPEN_DAY)
    expect(open.closed).toBe(false)
    expect(open.periodId).toBeNull()
    expect(open.earliestOpenDate).toBe(FIRST_OPEN_DAY)
  })

  it('refuses a posting dated in the closed period from every posting path, naming the open date', async () => {
    // The acceptance asks for all five paths. They are asserted through the one choke point they all
    // reach: `journal_entry`'s BEFORE INSERT guard, with each path's own `source`. M-VAT-05 made the
    // same argument for ZL004 — "a rule enforced in five places has five chances to be forgotten" —
    // and 0073 redefines the single function both guards call, so a path that carried a different
    // message would be a path that did not post.
    const paths = [
      'sale', // the invoice, through finaliseCheckout
      'reversal', // the credit note, through issueCreditNote
      'supplier_bill', // the bill, through postBill
      'payment', // the payment, through the manual-payment adapter
      'package_redemption', // the package redemption
    ] as const

    for (const [index, source] of paths.entries()) {
      const refused = await stateOf(
        withUnitOfWork(sql, ACTOR, (uow) =>
          postJournalEntry(uow, {
            entryId: `${PREFIX}-${RUN}-LOCKED-${index}`,
            entryDate: SALE_DATE,
            narrative: `Refused ${source}`,
            source,
            lines: saleLines(1_050, 50),
          }),
        ),
      )
      expect(refused.code, source).toBe(JOURNAL_SQLSTATE.periodLocked)
      expect(refused.message, source).toContain('PeriodLocked')
      expect(refused.message, source).toContain(`"${AUGUST.periodId}"`)
      expect(refused.message, source).toContain(`The earliest open date is ${FIRST_OPEN_DAY}`)
    }

    // And the LINE guard, which is the case the entry guard cannot cover: a line appended to an entry
    // that was posted while the period was still open.
    const appended = await stateOf(
      sql`insert into journal_line (entry_id, line_no, account_code, credit_fils)
          values (${SALE_ENTRY}, 9, ${REVENUE}, 1)`,
    )
    expect(appended.code).toBe(JOURNAL_SQLSTATE.periodLocked)
    expect(appended.message).toContain(`The earliest open date is ${FIRST_OPEN_DAY}`)

    // The control: the same entry on the first open day is accepted, so every refusal above is about
    // the lock and not about the entry.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        postJournalEntry(uow, {
          entryId: `${PREFIX}-${RUN}-OPEN`,
          entryDate: FIRST_OPEN_DAY,
          narrative: 'Accepted on the first open day',
          source: 'sale',
          lines: saleLines(1_050, 50),
        }),
      ),
    ).resolves.toBeDefined()
  })

  it('corrects a locked period by a dated reversal in the next open one', async () => {
    const before = await accountNet([CASH, REVENUE, OUTPUT_VAT])

    const correction = await withUnitOfWork(sql, ACTOR, (uow) =>
      postDatedCorrection(uow, {
        reversesEntryId: SALE_ENTRY,
        entryId: `${SALE_ENTRY}-R`,
        narrative: `Reversal of ${SALE_ENTRY}: wrong therapist`,
        lines: reversalLines(SALE_GROSS, SALE_VAT),
      }),
    )

    // The date is the service's, computed from the database, and it is the first open day rather than
    // the original's own date or the month after the lock.
    expect(correction.entry.entryDate).toBe(FIRST_OPEN_DAY)
    expect(correction.entry.reverses).toBe(SALE_ENTRY)
    expect(correction.entry.source).toBe('reversal')
    expect(correction.deferredFromPeriodId).toBe(AUGUST.periodId)

    // The original is untouched, asserted on the row hashes rather than on a field-by-field comparison:
    // a hash over the whole row catches a change to a column this test does not know to look at.
    expect(await lineHashesOf(SALE_ENTRY)).toEqual(lineHashesBefore)
    const original = await readJournalEntry(sql, SALE_ENTRY)
    expect(original?.entryDate).toBe(SALE_DATE)

    // The reversal nets the affected accounts to the intended figure: the sale and its reversal
    // together move every account either of them touched by exactly zero.
    const pair = await accountNetForEntries([SALE_ENTRY, `${SALE_ENTRY}-R`])
    for (const code of [CASH, REVENUE, OUTPUT_VAT]) {
      expect(pair[code] ?? 0n, code).toBe(0n)
    }

    // Two controls, because "nets to zero" is also what a pair of entries that posted nothing produces.
    // First: the sale on its own is NOT zero, and is exactly what was posted -- so the zero above is a
    // cancellation and not an absence.
    expect(await accountNetForEntries([SALE_ENTRY])).toEqual({
      [CASH]: BigInt(SALE_GROSS),
      [REVENUE]: -BigInt(SALE_GROSS - SALE_VAT),
      [OUTPUT_VAT]: -BigInt(SALE_VAT),
    })
    // Second: the whole ledger moved, by the negative of the sale's own contribution. Measured over the
    // real table rather than over the two entries, so a reversal written somewhere this test does not
    // look would fail here.
    const after = await accountNet([CASH, REVENUE, OUTPUT_VAT])
    expect((after[CASH] ?? 0n) - (before[CASH] ?? 0n)).toBe(-BigInt(SALE_GROSS))
    expect((after[REVENUE] ?? 0n) - (before[REVENUE] ?? 0n)).toBe(BigInt(SALE_GROSS - SALE_VAT))
    expect((after[OUTPUT_VAT] ?? 0n) - (before[OUTPUT_VAT] ?? 0n)).toBe(BigInt(SALE_VAT))
  })

  it('refuses a correction of an entry that does not exist', async () => {
    const refusal = await refusalOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        postDatedCorrection(uow, {
          reversesEntryId: `${PREFIX}-${RUN}-NOT-AN-ENTRY`,
          entryId: `${PREFIX}-${RUN}-NOT-AN-ENTRY-R`,
          narrative: 'Correction of nothing',
          lines: reversalLines(1_050, 50),
        }),
      ),
    )
    expect(refusal.kind).toBe('not_found')
  })

  it('the application role cannot reopen the period it closed', async () => {
    // The layer ADR 0026 rests on. `period_lock` carries no refusal trigger — 0018 decided that and
    // this record explains why — so the grant is what makes reopening impossible for every code path,
    // and a grant is only a guarantee once a statement has been seen to bounce off it.
    const deleted = await stateOf(
      asApplicationRole((tx) => tx`delete from period_lock where period_id = ${AUGUST.periodId}`),
    )
    expect(deleted.code).toBe('42501')
    expect(deleted.message).toMatch(/permission denied/)

    const shortened = await stateOf(
      asApplicationRole(
        (tx) => tx`update period_lock set ends_on = '2093-08-01'
                     where period_id = ${AUGUST.periodId}`,
      ),
    )
    expect(shortened.code).toBe('42501')
    // The control: the lock is still there, so the refusals above were refusals and not silent no-ops.
    expect((await periodStatusOn(sql, SALE_DATE)).periodId).toBe(AUGUST.periodId)
  })
})

describe('the close surface', () => {
  it('exports no way to reopen a period', async () => {
    // An export-surface test and not a SQLSTATE, because ADR 0026 records that `period_lock` carries no
    // refusal trigger by design. What has to be impossible is a CODE path, and a code path is a name in
    // this barrel.
    const exported = Object.keys(dbModule)
    expect(exported.filter(reopensAPeriod)).toEqual([])

    // Controls. First: the barrel really was introspected, and it exports this unit's surface.
    expect(exported).toContain('closeAccountingPeriod')
    expect(exported).toContain('lockAccountingPeriod')
    expect(exported).toContain('postDatedCorrection')
    expect(exported).toContain('periodStatusOn')
    expect(exported.length).toBeGreaterThan(100)
    // Second: the predicate matches the names it is looking for. Without this the empty list above
    // would also be produced by a predicate that had stopped matching anything at all.
    const fabricated = [
      'reopenPeriod',
      'unlockAccountingPeriod',
      'deletePeriodLock',
      'updatePeriodLock',
      'removeAccountingPeriod',
    ]
    expect(fabricated.filter(reopensAPeriod)).toHaveLength(fabricated.length)
    // Third: it does NOT match a name that merely contains one of those words by accident, which is the
    // defect the first version of this case had -- `/reopen/i` matches `isBefo(reOpen)ingBalance`, an
    // opening-balance guard that reopens nothing, and the case reported a reopening in the barrel.
    expect(
      ['isBeforeOpeningBalance', 'lockAccountingPeriod', 'openingDate'].filter(reopensAPeriod),
    ).toEqual([])
  })
})

// --- helpers -------------------------------------------------------------------------------------

const refusalMessage = (state: { message: string }) => state.message

/**
 * True when an exported identifier names something that reopens a period.
 *
 * Split into words on the camelCase boundaries rather than matched as a substring, and the difference is
 * a false positive this case actually produced: `/reopen/i` matches `isBeforeOpeningBalance`, because
 * "befo**reOpen**ingBalance" contains the letters. A substring pattern over identifiers will eventually
 * find one, and the first person to see it goes looking for a reopening path that does not exist.
 */
function reopensAPeriod(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  if (words.includes('reopen') || words.includes('unlock')) return true
  if (!words.includes('period')) return false
  return ['delete', 'update', 'remove', 'edit', 'amend', 'void'].some((verb) =>
    words.includes(verb),
  )
}

/** `md5(row::text)` per line, in `line_no` order: the whole row, not the columns a test remembers. */
async function lineHashesOf(entryId: string): Promise<string[]> {
  const rows = await sql<{ h: string }[]>`
    select md5(l::text) as h from journal_line l where l.entry_id = ${entryId} order by l.line_no
  `
  return rows.map((row) => row.h)
}

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '-1')
}

/** `debit - credit` per account over the whole ledger, as bigint. A total, so only used for deltas. */
async function accountNet(codes: readonly string[]): Promise<Record<string, bigint>> {
  const rows = await sql<{ account_code: string; net: string }[]>`
    select account_code, (sum(debit_fils) - sum(credit_fils))::text as net
    from journal_line where account_code in ${sql(codes)}
    group by account_code
  `
  return Object.fromEntries(rows.map((row) => [row.account_code, BigInt(row.net)]))
}

async function accountNetForEntries(entryIds: readonly string[]): Promise<Record<string, bigint>> {
  const rows = await sql<{ account_code: string; net: string }[]>`
    select account_code, (sum(debit_fils) - sum(credit_fils))::text as net
    from journal_line where entry_id in ${sql(entryIds)}
    group by account_code
  `
  return Object.fromEntries(rows.map((row) => [row.account_code, BigInt(row.net)]))
}

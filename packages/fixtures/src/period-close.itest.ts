import type { JournalEntry, JournalLine } from '@berelax/core'
import {
  ACCOUNTS,
  CorrectionIntoClosedPeriod,
  closedPeriodContaining,
  credit,
  debit,
  entryId,
  filsFrom,
  localDate,
  money,
  parsePeriodId,
  planCorrection,
  postEntry,
  reversalEntryId,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type { Actor, JournalLineInput, Sql } from '@berelax/db'
import {
  closeAccountingPeriod,
  createConnection,
  earliestOpenDateFrom,
  listPeriodLocks,
  periodStatusOn,
  postDatedCorrection,
  postJournalEntry,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * M-VAT-06's pair: core plans the correction, the database dates it and stores it.
 *
 * `packages/db` may never import `packages/core`, so this unit is proved in three places — the pure rule
 * in `packages/core/src/ledger/period.test.ts`, the schema and the transaction in
 * `packages/db/src/services/period-close.itest.ts`, and the PAIR only here, in the package allowed to
 * depend on both. The arrangement `credit-note.itest.ts` has for M-TILL-08 and
 * `checkout-finalisation.itest.ts` for M-TILL-06.
 *
 * What only this file can show:
 *
 *   - that a `JournalEntry` core built with `reverseEntry` maps onto `postDatedCorrection`'s
 *     `JournalLineInput` without losing anything. The two shapes are structural mirrors and nothing
 *     compiles them against each other: core has `account: AccountCode` and branded `Fils`, the
 *     repository has `accountCode: string` and integer `debitFils`. A mapping that swapped the sides, or
 *     dropped the memo, is a defect neither half's own suite can see.
 *   - that core's `closedPeriodContaining` and the database's `period_lock_for()` answer the same
 *     question the same way. `period.ts` says in its own header that it deliberately does NOT recompute
 *     the earliest open date, so the database is the authority and core is the refusal — and that
 *     division is only worth anything if the two agree about which dates are shut. Asserted over every
 *     date in a window spanning both closed periods and the open month after them.
 *
 * ## Isolation
 *
 * The periods are in 2091, which no other suite locks: `journal.itest.ts` uses 2088,
 * `period-close.itest.ts` 2093, `issue-credit-note.itest.ts` 2097, `checkout-finalise.itest.ts` 2099, and
 * `post-bill.itest.ts` takes the fortnight after `max(ends_on)`. Two locks sharing a day is refused by
 * `period_lock_no_overlap`, which would present as this file failing on somebody else's branch. The locks
 * are removed in `beforeAll` and `afterAll` by `period_id` prefix, so a second run against the same
 * database is not refused its own dates; the journal entries cannot be removed at all (ZL001 refuses the
 * owner too), so every figure here is read from the two entries this file posts rather than as a total.
 */
const ACTOR: Actor = { kind: 'system', label: 'm-vat-06-pair-itest' }

const PREFIX = 'MVAT06PAIR'
const RUN = Date.now().toString(36)

const AUGUST = parsePeriodId('2091-08')
const SEPTEMBER = parsePeriodId('2091-09')
/** August and September both filed, so the first open day is neither of them. */
const FIRST_OPEN_DAY = '2091-10-01'
const SALE_DATE = '2091-08-20'

const GROSS = 26_250
const VAT = 1_250

let sql: Sql

const periodIdOf = (period: { readonly periodId: string }) => `${PREFIX}-${period.periodId}`

/** The sale, built by core. `postEntry` is the only way to obtain a `JournalEntry`. */
const SALE: JournalEntry = postEntry(
  {
    entryId: entryId(`${PREFIX}-${RUN}-SALE`),
    entryDate: localDate(SALE_DATE),
    narrative: 'Aromatherapy 60 min, card',
    source: 'sale',
    lines: [
      debit(ACCOUNTS.gatewayClearing, money(filsFrom(GROSS)), 'Card settlement'),
      credit(ACCOUNTS.treatmentRevenue, money(filsFrom(GROSS - VAT))),
      credit(ACCOUNTS.outputVatPayable, money(filsFrom(VAT))),
    ],
  },
  STANDARD_SPA_CHART,
)

/**
 * The field-for-field mapping, written once and used by both the sale and its reversal.
 *
 * `Money` becomes integer `debitFils`/`creditFils`, `AccountCode` becomes a string, and the side stays
 * the side — direction is never folded into a sign, because a negative debit and a positive credit both
 * balance and only one of them is what the poster meant.
 */
const toLineInput = (line: JournalLine): JournalLineInput => ({
  accountCode: line.account as string,
  debitFils: Number(line.debitFils),
  creditFils: Number(line.creditFils),
  ...(line.memo === undefined ? {} : { memo: line.memo }),
})

const removeOwnLocks = () => sql`delete from period_lock where period_id like ${`${PREFIX}-%`}`

const close = (period: {
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
}) =>
  withUnitOfWork(sql, ACTOR, (uow) =>
    closeAccountingPeriod(uow, {
      periodId: periodIdOf(period),
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      reason: 'VAT return filed',
      closedByActorKind: 'system',
    }),
  )

/** `debit - credit` per account over named entries only, so nothing else in the ledger can reach it. */
async function netForEntries(entryIds: readonly string[]): Promise<Record<string, bigint>> {
  const rows = await sql<{ account_code: string; net: string }[]>`
    select account_code, (sum(debit_fils) - sum(credit_fils))::text as net
    from journal_line where entry_id in ${sql(entryIds)}
    group by account_code
  `
  return Object.fromEntries(rows.map((row) => [row.account_code, BigInt(row.net)]))
}

beforeAll(async () => {
  sql = createConnection({ url: url ?? '', max: 4 })
  await removeOwnLocks()
  await withUnitOfWork(sql, ACTOR, (uow) =>
    postJournalEntry(uow, {
      entryId: SALE.entryId as string,
      entryDate: SALE.entryDate as string,
      narrative: SALE.narrative,
      source: SALE.source,
      lines: SALE.lines.map(toLineInput),
    }),
  )
  await close(AUGUST)
  await close(SEPTEMBER)
})

afterAll(async () => {
  await removeOwnLocks()
  await sql.end()
})

describe('core plans the correction and the database dates it', () => {
  it('posts the reversal core built, into the first open period, unchanged', async () => {
    // The date comes from the database, which is the single definition of "where may this go" — core's
    // own header says it deliberately does not recompute it.
    const on = await earliestOpenDateFrom(sql, SALE.entryDate as string)
    expect(on).toBe(FIRST_OPEN_DAY)

    const closedPeriods = (await listPeriodLocks(sql))
      .filter((lock) => lock.periodId.startsWith(PREFIX))
      .map((lock) => ({
        periodId: lock.periodId,
        startsOn: localDate(lock.startsOn),
        endsOn: localDate(lock.endsOn),
      }))

    const plan = planCorrection(SALE, localDate(on), closedPeriods, {
      entryId: entryId(`${SALE.entryId}-R`),
    })
    expect(plan.deferred).toBe(true)
    expect(plan.reversal.entryId).toBe(reversalEntryId(SALE.entryId))

    const posted = await withUnitOfWork(sql, ACTOR, (uow) =>
      postDatedCorrection(uow, {
        reversesEntryId: SALE.entryId as string,
        entryId: plan.reversal.entryId as string,
        narrative: plan.reversal.narrative,
        lines: plan.reversal.lines.map(toLineInput),
      }),
    )

    // The service reached the same date core was given, from the database rather than from the caller.
    expect(posted.entry.entryDate).toBe(plan.reversal.entryDate)
    expect(posted.deferredFromPeriodId).toBe(periodIdOf(AUGUST))

    // Nothing was lost in the mapping: every line came back with its side, its account and its memo.
    expect(posted.entry.lines).toHaveLength(plan.reversal.lines.length)
    for (const [index, line] of plan.reversal.lines.entries()) {
      const stored = posted.entry.lines[index]
      expect(stored?.accountCode, `line ${index}`).toBe(line.account as string)
      expect(stored?.debitFils, `line ${index} debit`).toBe(Number(line.debitFils))
      expect(stored?.creditFils, `line ${index} credit`).toBe(Number(line.creditFils))
      // Both sides normalised to null: core leaves an absent memo as `undefined` on a line built with
      // no memo and `postgres.js` reads the column back as `null`, and the assertion is about whether
      // the text survived the mapping rather than about which of the two spellings of "absent" it is.
      expect(stored?.memo ?? null, `line ${index} memo`).toBe(line.memo ?? null)
    }

    // The pair nets every account it touched to zero, read from the rows and not from either writer's
    // return value.
    const pair = await netForEntries([SALE.entryId as string, posted.entry.entryId])
    for (const code of Object.keys(pair)) expect(pair[code], code).toBe(0n)

    // The control: the sale alone is not zero, and is exactly what core said it was — so the zero above
    // is a cancellation and not a mapping that dropped both halves.
    const sale = await netForEntries([SALE.entryId as string])
    expect(sale[ACCOUNTS.gatewayClearing as string]).toBe(BigInt(GROSS))
    expect(sale[ACCOUNTS.treatmentRevenue as string]).toBe(-BigInt(GROSS - VAT))
    expect(sale[ACCOUNTS.outputVatPayable as string]).toBe(-BigInt(VAT))
    // And a side that was swapped rather than copied: three accounts, not six.
    expect(Object.keys(pair)).toHaveLength(3)
  })

  it('core refuses the date the database moved past, so the two halves state one rule', async () => {
    const closedPeriods = [AUGUST, SEPTEMBER].map((period) => ({
      periodId: periodIdOf(period),
      startsOn: period.startsOn,
      endsOn: period.endsOn,
    }))

    // The date the correction would have carried if nobody had asked the database: inside the period it
    // corrects. Core refuses it by name, and `journal_entry`'s BEFORE INSERT guard would refuse it again
    // with ZL002 — two statements of one rule, which is the number `journal.ts` argues for.
    expect(() => planCorrection(SALE, SALE.entryDate, closedPeriods)).toThrow(
      CorrectionIntoClosedPeriod,
    )

    // And the agreement itself, over every day from a fortnight before August to a fortnight into the
    // open month. `closedPeriodContaining` is pure and `period_lock_for()` is a SQL function, and the
    // division of labour in `period.ts` is only worth anything if they never disagree.
    const days = [
      '2091-07-20',
      '2091-07-31',
      '2091-08-01',
      SALE_DATE,
      '2091-08-31',
      '2091-09-01',
      '2091-09-30',
      FIRST_OPEN_DAY,
      '2091-10-14',
    ]
    let closedInBoth = 0
    for (const day of days) {
      const fromCore = closedPeriodContaining(localDate(day), closedPeriods)
      const fromDatabase = await periodStatusOn(sql, day)
      expect(fromCore?.periodId ?? null, day).toBe(fromDatabase.periodId)
      if (fromCore !== null) closedInBoth += 1
    }
    // The control for that loop: it actually exercised both answers. A window entirely inside the open
    // months would have compared null against null nine times and proved nothing.
    // Five of the nine days are inside a filed period (the 1st, 20th and 31st of August, the 1st and
    // 30th of September) and four are not. Both halves asserted, so a comparison that had degenerated
    // to null-against-null fails here rather than passing nine times.
    expect(closedInBoth).toBe(5)
    expect(days.length - closedInBoth).toBe(4)
  })
})

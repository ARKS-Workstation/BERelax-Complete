import {
  ACCOUNTS,
  CHARGEBACK_KINDS,
  chargebackLostEntry,
  chargebackNetEffectFils,
  chargebackReceivedEntry,
  chargebackTradingDate,
  chargebackWonEntry,
  chargedBackNetFils,
  type EntryId,
  entryId,
  instantFromIso,
  localDate,
  refundableFils,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import type { Actor, Sql, UnitOfWork } from '@berelax/db'
import {
  applyPaymentIntentMovement,
  CHARGEBACK_SQLSTATE,
  chargebackError,
  createConnection,
  isChargebackRedelivery,
  isChargebackRule,
  journalLineMutationGrants,
  postJournalEntry,
  readDisputeEvents,
  readRefundablePosition,
  recordChargebackEvent,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Y-PAY-08 against a real PostgreSQL: a reversal is a dated event, and the cap is a refusal.
 *
 * `packages/db` may never import `packages/core`, so the unit is proved in halves — the arithmetic in
 * `packages/core/src/payments/refund.test.ts` and the 1,000-case property beside it, the rows here. This
 * is the only package that may import both, which makes it the only place these can be shown:
 *
 *   - that `ZY431`-`ZY436` actually fire, by code, each with the row that survived;
 *   - that the refund cap is a DATABASE refusal and not a screen's validation — including the ordering
 *     that matters most, a dispute arriving AFTER a refund that was legitimate when it was made;
 *   - that `1045` in SQL and `ACCOUNTS.disputedCardReceipts` in TypeScript are one account;
 *   - that a won dispute nets to nought on `1045` read back from `journal_line`, rather than from the
 *     entry the poster returned;
 *   - that `berelax_app` holds no UPDATE or DELETE on `journal_line` at all, which is a stronger form of
 *     "zero UPDATE or DELETE statements" than any scan of the source: a scan answers "nobody wrote one"
 *     and this answers "nobody could".
 *
 * ## Why the deferred refusals are driven through real transactions
 *
 * `ZY433` and `ZY436` are `constraint trigger ... deferrable initially deferred`, so they fire at COMMIT.
 * A probe inside a savepoint that is rolled back never reaches one — the rollback discards the pending
 * check — so every case for those two runs inside `withUnitOfWork` and asserts on what the COMMIT
 * answers. That is a real property of deferred triggers and it cost this suite a run before it was
 * written down.
 *
 * ## Teardown
 *
 * `chargeback` refuses DELETE for every role including the owner (ZY431), so truncate is the only legal
 * removal. The journal is NEVER truncated (0078 says so where it makes `package_sale.journal_entry_id` a
 * real key), so the entries this file posts are left behind deliberately — which is why every assertion
 * here is scoped to this suite's own entry ids and the `1045` totals are read per entry rather than as an
 * account balance.
 */

const TRADING_DATE = '2099-11-29'
/** The session that crosses midnight, so the 01:30 case has a real previous day to land in. */
const NEXT_CALENDAR_DATE = '2099-11-30'
const PREFIX = 'YPAY08'
/** AED 100.00 captured. A figure this suite chose. */
const CAPTURED = 10_000

const CHART = STANDARD_SPA_CHART
/** Trading hours as every other suite spells them: 11:00 to 02:00. */
const HOURS = { open: '11:00' as never, close: '02:00' as never }
const hoursFor = (): typeof HOURS => HOURS

const ACTOR: Actor = { kind: 'staff', label: 'Y-PAY-08 chargeback itest' }

let sql: Sql
/** One intent per case that needs its own untouched position. */
const intents = new Map<string, string>()
let nonce: string

/**
 * A core `JournalEntry` as `postJournalEntry` wants it.
 *
 * The two shapes differ by one field name (`account` against `accountCode`) and by `currency`, which the
 * row carries a default for. Converted here rather than in either package, because `packages/db` may not
 * name core's type and core may not know about the repository — which is the boundary this whole suite
 * exists on the far side of.
 */
function asEntryInput(entry: ReturnType<typeof chargebackReceivedEntry>) {
  return {
    entryId: entry.entryId as string,
    entryDate: entry.entryDate as string,
    narrative: entry.narrative,
    source: entry.source as string,
    reverses: entry.reverses === null ? null : (entry.reverses as string),
    lines: entry.lines.map((line) => ({
      accountCode: line.account as string,
      debitFils: line.debitFils as number,
      creditFils: line.creditFils as number,
      memo: line.memo,
    })),
  }
}

const errorOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('the statement was expected to be refused and was not')
}

/** A captured intent of `CAPTURED` fils, through the one UPDATE path ADR 0056 permits. */
async function captureAnIntent(key: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into payment_intent (
      idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference
    ) values (
      ${`${PREFIX}-${nonce}-${key}`}, 'gateway-not-chosen', 'card_online', '1030',
      ${CAPTURED}, ${`${PREFIX}-${nonce}-${key}`}
    )
    returning id
  `
  const id = row?.id as string
  await withUnitOfWork(sql, ACTOR, async (uow) => {
    await applyPaymentIntentMovement(uow, {
      paymentIntentId: id,
      gatewayEventId: `${PREFIX}-${nonce}-${key}-auth`,
      gatewayEventType: 'authorised',
      amountFils: CAPTURED,
      occurredAt: new Date(`${TRADING_DATE}T19:00:00+04:00`),
      idempotencyKey: `${PREFIX}-${nonce}-${key}-ik-auth`,
      state: 'authorised',
      authorisedFils: CAPTURED,
      capturedFils: 0,
      refundedFils: 0,
    })
  })
  await withUnitOfWork(sql, ACTOR, async (uow) => {
    await applyPaymentIntentMovement(uow, {
      paymentIntentId: id,
      gatewayEventId: `${PREFIX}-${nonce}-${key}-cap`,
      gatewayEventType: 'captured',
      amountFils: CAPTURED,
      occurredAt: new Date(`${TRADING_DATE}T19:05:00+04:00`),
      idempotencyKey: `${PREFIX}-${nonce}-${key}-ik-cap`,
      state: 'captured',
      authorisedFils: CAPTURED,
      capturedFils: CAPTURED,
      refundedFils: 0,
    })
  })
  intents.set(key, id)
  return id
}

/** A refund movement on an intent, in its own transaction so the deferred checks run at its COMMIT. */
async function refund(key: string, totalRefundedFils: number, seq: number): Promise<void> {
  const id = intents.get(key) as string
  await withUnitOfWork(sql, ACTOR, async (uow) => {
    await applyPaymentIntentMovement(uow, {
      paymentIntentId: id,
      gatewayEventId: `${PREFIX}-${nonce}-${key}-ref-${seq}`,
      gatewayEventType: 'refunded',
      amountFils: totalRefundedFils,
      occurredAt: new Date(`${TRADING_DATE}T20:00:00+04:00`),
      idempotencyKey: `${PREFIX}-${nonce}-${key}-ik-ref-${seq}`,
      state: 'captured',
      authorisedFils: CAPTURED,
      capturedFils: CAPTURED,
      refundedFils: totalRefundedFils,
    })
  })
}

/** A dispute event and its entry, in ONE transaction, which is what `recordChargebackEvent` requires. */
async function dispute(input: {
  readonly key: string
  readonly disputeRef: string
  readonly kind: 'received' | 'won' | 'lost'
  readonly amountFils: number
  readonly receivedAtIso: string
  readonly tradingDate: string
  readonly entrySuffix: string
  /** For `won`: the received entry to reverse. */
  readonly reverses?: { readonly entry: ReturnType<typeof chargebackReceivedEntry> }
  /** For the known-bad cases: post an entry that does NOT reverse. */
  readonly mirrorInsteadOfReversal?: boolean
}): Promise<{ readonly entryId: string }> {
  const id = intents.get(input.key) as string
  const built =
    input.kind === 'received'
      ? chargebackReceivedEntry(
          {
            entryId: entryId(`${PREFIX}-${nonce}-${input.entrySuffix}`) as EntryId,
            entryDate: localDate(input.tradingDate),
            intentRef: id,
            disputeRef: input.disputeRef,
            amountFils: input.amountFils,
          },
          CHART,
        )
      : input.kind === 'lost'
        ? chargebackLostEntry(
            {
              entryId: entryId(`${PREFIX}-${nonce}-${input.entrySuffix}`) as EntryId,
              entryDate: localDate(input.tradingDate),
              intentRef: id,
              disputeRef: input.disputeRef,
              amountFils: input.amountFils,
            },
            CHART,
          )
        : input.mirrorInsteadOfReversal === true
          ? // The known-bad shape: a hand-built mirror that balances perfectly and reverses nothing.
            chargebackLostEntry(
              {
                entryId: entryId(`${PREFIX}-${nonce}-${input.entrySuffix}`) as EntryId,
                entryDate: localDate(input.tradingDate),
                intentRef: id,
                disputeRef: input.disputeRef,
                amountFils: input.amountFils,
              },
              CHART,
            )
          : chargebackWonEntry(
              (input.reverses as { entry: ReturnType<typeof chargebackReceivedEntry> }).entry,
              localDate(input.tradingDate),
              {
                entryId: entryId(`${PREFIX}-${nonce}-${input.entrySuffix}`) as EntryId,
                disputeRef: input.disputeRef,
              },
            )

  await withUnitOfWork(sql, ACTOR, async (uow: UnitOfWork) => {
    await postJournalEntry(uow, asEntryInput(built))
    await recordChargebackEvent(uow, {
      paymentIntentId: id,
      disputeRef: input.disputeRef,
      kind: input.kind,
      amountFils: input.amountFils,
      receivedAtIso: input.receivedAtIso,
      tradingDate: input.tradingDate,
      journalEntryId: built.entryId as string,
    })
  })
  return { entryId: built.entryId as string }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  nonce = `${Date.now()}`

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${`${NEXT_CALENDAR_DATE} 02:00:00+04`}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${NEXT_CALENDAR_DATE}, ${`${NEXT_CALENDAR_DATE} 11:00:00+04`}::timestamptz,
            ${'2099-12-01 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  for (const key of ['partial', 'won', 'lost', 'cap', 'late', 'sequence', 'replay']) {
    await captureAnIntent(key)
  }
})

afterAll(async () => {
  if (sql !== undefined) {
    // TRUNCATE, because ZY431 refuses DELETE on this table for every role including the owner. Declared
    // in `packages/db/src/suite-table-declarations.ts`. The journal is deliberately NOT emptied: nothing
    // truncates it (0078), which is why every assertion in this file is scoped to its own entry ids.
    await sql.unsafe('truncate chargeback')
    await sql`delete from business_day where trading_date in (${TRADING_DATE}, ${NEXT_CALENDAR_DATE})`
    await sql.end({ timeout: 5 })
  }
})

describe('journal_line cannot be mutated at all', () => {
  it('holds no UPDATE or DELETE grant for the application role', async () => {
    // The acceptance line "with zero UPDATE or DELETE statements against journal_line" in its strongest
    // form. A source scan answers "nobody wrote one"; this answers "nobody could".
    expect(await journalLineMutationGrants(sql)).toEqual([])
    // The control: the role CAN read it, so the empty list above is an absence of those two privileges
    // and not an absence of the role or of the table.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from information_schema.table_privileges
       where table_schema = 'public' and table_name = 'journal_line'
         and grantee = 'berelax_app' and privilege_type = 'SELECT'
    `
    expect(row?.n).toBe('1')
  })
})

describe('the account is one account', () => {
  it('agrees between SQL and @berelax/core', async () => {
    const [row] = await sql<{ code: string }[]>`
      select disputed_card_receipts_account_code() as code
    `
    expect(row?.code).toBe(ACCOUNTS.disputedCardReceipts)
    // The control, which is what `tips_payable_account_code()` and `customer_deposit_account_code()`
    // carry one account along each way: the account must actually be in the chart table too, or the two
    // agree about a code nothing can post to.
    const [stored] = await sql<{ name: string; type: string }[]>`
      select name, type from account where code = ${ACCOUNTS.disputedCardReceipts}
    `
    expect(stored?.name).toBe('Disputed card receipts')
    expect(stored?.type).toBe('asset')
    const [mapping] = await sql<{ disposition: string }[]>`
      select disposition from vat201_box_mapping where account_code = ${ACCOUNTS.disputedCardReceipts}
    `
    expect(mapping?.disposition).toBe('out_of_scope')
  })
})

describe('a chargeback and its reversal', () => {
  it('posts to 1045 and unwinds to nought there, read back from journal_line', async () => {
    const received = chargebackReceivedEntry(
      {
        entryId: entryId(`${PREFIX}-${nonce}-WON-R1`) as EntryId,
        entryDate: localDate(TRADING_DATE),
        intentRef: intents.get('won') as string,
        disputeRef: `${PREFIX}-${nonce}-WON`,
        amountFils: 4_000,
      },
      CHART,
    )
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await postJournalEntry(uow, asEntryInput(received))
      await recordChargebackEvent(uow, {
        paymentIntentId: intents.get('won') as string,
        disputeRef: `${PREFIX}-${nonce}-WON`,
        kind: 'received',
        amountFils: 4_000,
        receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
        tradingDate: TRADING_DATE,
        journalEntryId: received.entryId as string,
      })
    })

    // After the received event: 4,000 has left 1030 and sits on 1045, and that much less is refundable.
    const afterReceipt = await readRefundablePosition(sql, intents.get('won') as string)
    expect(Number(afterReceipt?.chargedBackFils)).toBe(4_000)
    expect(
      refundableFils({
        capturedFils: Number(afterReceipt?.capturedFils),
        refundedFils: Number(afterReceipt?.refundedFils),
        chargedBackFils: Number(afterReceipt?.chargedBackFils),
      }),
    ).toBe(CAPTURED - 4_000)

    await dispute({
      key: 'won',
      disputeRef: `${PREFIX}-${nonce}-WON`,
      kind: 'won',
      amountFils: 4_000,
      receivedAtIso: `${NEXT_CALENDAR_DATE}T15:00:00+04:00`,
      tradingDate: NEXT_CALENDAR_DATE,
      entrySuffix: 'WON-R1-REV',
      reverses: { entry: received },
    })

    // The acceptance line, to the fils, read from the ROWS rather than from the entries the poster
    // returned — which is the only reading that could catch a poster that wrote something else.
    const [net] = await sql<{ net: string }[]>`
      select coalesce(sum(l.debit_fils - l.credit_fils), 0)::text as net
        from journal_line l
       where l.account_code = ${ACCOUNTS.disputedCardReceipts}
         and l.entry_id in (${received.entryId as string}, ${`${PREFIX}-${nonce}-WON-R1-REV`})
    `
    expect(net?.net).toBe('0')
    // And the pure arithmetic agrees about the same two entries, which is the pairing this file exists
    // for.
    const won = chargebackWonEntry(received, localDate(NEXT_CALENDAR_DATE))
    expect(chargebackNetEffectFils([received, won])).toBe(0)

    // The position is restored: a won dispute is money the business has again.
    const afterWin = await readRefundablePosition(sql, intents.get('won') as string)
    expect(Number(afterWin?.chargedBackFils)).toBe(0)

    const events = await readDisputeEvents(sql, `${PREFIX}-${nonce}-WON`)
    expect(events.map((e) => e.kind)).toEqual(['received', 'won'])
    // The pure net and the view's net are the same arithmetic written twice; held equal here.
    expect(
      chargedBackNetFils(
        events.map((e) => ({
          kind: e.kind as 'received' | 'won' | 'lost',
          amountFils: Number(e.amountFils),
        })),
      ),
    ).toBe(0)
  })

  it('writes a lost dispute off and leaves 1045 at nought by the other route', async () => {
    const ref = `${PREFIX}-${nonce}-LOST`
    const received = await dispute({
      key: 'lost',
      disputeRef: ref,
      kind: 'received',
      amountFils: 2_500,
      receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
      tradingDate: TRADING_DATE,
      entrySuffix: 'LOST-R1',
    })
    await dispute({
      key: 'lost',
      disputeRef: ref,
      kind: 'lost',
      amountFils: 2_500,
      receivedAtIso: `${NEXT_CALENDAR_DATE}T15:00:00+04:00`,
      tradingDate: NEXT_CALENDAR_DATE,
      entrySuffix: 'LOST-R1-W',
    })
    const [net] = await sql<{ net: string }[]>`
      select coalesce(sum(l.debit_fils - l.credit_fils), 0)::text as net
        from journal_line l
       where l.account_code = ${ACCOUNTS.disputedCardReceipts}
         and l.entry_id in (${received.entryId}, ${`${PREFIX}-${nonce}-LOST-R1-W`})
    `
    expect(net?.net).toBe('0')
    // But the money is still gone, which is the difference from a win: it is NOT refundable again.
    const position = await readRefundablePosition(sql, intents.get('lost') as string)
    expect(Number(position?.chargedBackFils)).toBe(2_500)
    // And it landed in bad debt rather than in an allowance.
    const [loss] = await sql<{ debit: string }[]>`
      select coalesce(sum(l.debit_fils), 0)::text as debit
        from journal_line l
       where l.account_code = ${ACCOUNTS.badDebt}
         and l.entry_id = ${`${PREFIX}-${nonce}-LOST-R1-W`}
    `
    expect(loss?.debit).toBe('2500')
  })

  it('refuses an UPDATE and a DELETE (ZY431)', async () => {
    const ref = `${PREFIX}-${nonce}-WON`
    const update = await errorOf(
      () => sql`update chargeback set amount_fils = 1 where dispute_ref = ${ref}`,
    )
    expect(isChargebackRule(update, 'eventIsAppendOnly')).toBe(true)
    const remove = await errorOf(() => sql`delete from chargeback where dispute_ref = ${ref}`)
    expect(isChargebackRule(remove, 'eventIsAppendOnly')).toBe(true)
    // The rows survived, which is the half a thrown error alone does not claim.
    expect((await readDisputeEvents(sql, ref)).length).toBe(2)
  })

  it('never writes to the payment it is about', async () => {
    // A chargeback is a dated event, so the capture it disputes is untouched: `captured_fils` is a
    // projection of the append-only transaction rows (ZY163) and the capture HAPPENED.
    const position = await readRefundablePosition(sql, intents.get('lost') as string)
    expect(Number(position?.capturedFils)).toBe(CAPTURED)
    expect(position?.state).toBe('captured')
    const [rows] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_intent_transaction
       where payment_intent_id = ${intents.get('lost') as string}::uuid
    `
    // Two: the authorisation and the capture. A dispute added none, because it is not a gateway movement
    // of the intent — ADR 0056's lifecycle has no chargeback member and this unit did not add one.
    expect(rows?.n).toBe('2')
  })
})

describe('the trading date', () => {
  it('resolves a notice at 01:30 to the previous trading date, and the database agrees', async () => {
    // The pure primitive first.
    const resolved = chargebackTradingDate({
      disputeRef: `${PREFIX}-${nonce}-LATE`,
      receivedAt: instantFromIso(`${NEXT_CALENDAR_DATE}T01:30:00+04:00`),
      hoursFor,
    })
    expect(resolved).toBe(TRADING_DATE)
    // Then the row, which ZY432 checks against `business_day` itself. The two derivations agreeing is
    // the claim; either alone would be satisfied by a wrong answer written twice.
    await dispute({
      key: 'late',
      disputeRef: `${PREFIX}-${nonce}-LATE`,
      kind: 'received',
      amountFils: 1_000,
      receivedAtIso: `${NEXT_CALENDAR_DATE}T01:30:00+04:00`,
      tradingDate: resolved as string,
      entrySuffix: 'LATE-R1',
    })
    const [row] = await readDisputeEvents(sql, `${PREFIX}-${nonce}-LATE`)
    expect(row?.tradingDate).toBe(TRADING_DATE)
  })

  it('refuses a notice attributed to the calendar date instead (ZY432)', async () => {
    const error = await errorOf(() =>
      dispute({
        key: 'late',
        disputeRef: `${PREFIX}-${nonce}-LATE-WRONG`,
        kind: 'received',
        amountFils: 1_000,
        // The same 01:30 instant, claiming the calendar date. This is the bug: it lands in a cash-up for
        // a session that had not started, and two days' card totals are wrong in opposite directions.
        receivedAtIso: `${NEXT_CALENDAR_DATE}T01:30:00+04:00`,
        tradingDate: NEXT_CALENDAR_DATE,
        entrySuffix: 'LATE-WRONG',
      }),
    )
    expect(isChargebackRule(error, 'tradingDateDisagrees')).toBe(true)
    expect(chargebackError(error)?.message).toContain('ChargebackTradingDateDisagrees')
  })
})

describe('the refund cap is a database refusal', () => {
  it('refuses a refund beyond what remains after a dispute (ZY433)', async () => {
    // 10,000 captured, 4,000 disputed, so 6,000 remains. A refund of 7,000 satisfies
    // `check (refunded_fils <= captured_fils)` perfectly and is nevertheless money the business does not
    // have — which is the whole reason this rule exists.
    await dispute({
      key: 'cap',
      disputeRef: `${PREFIX}-${nonce}-CAP`,
      kind: 'received',
      amountFils: 4_000,
      receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
      tradingDate: TRADING_DATE,
      entrySuffix: 'CAP-R1',
    })
    const error = await errorOf(() => refund('cap', 7_000, 1))
    expect(isChargebackRule(error, 'captureIsOverReversed')).toBe(true)
    expect(chargebackError(error)?.message).toContain('CaptureIsOverReversed')
    // The control, and it is what makes the refusal about the CAP rather than about the path: exactly
    // 6,000 goes through.
    await refund('cap', 6_000, 2)
    const position = await readRefundablePosition(sql, intents.get('cap') as string)
    expect(Number(position?.refundedFils)).toBe(6_000)
    expect(
      refundableFils({
        capturedFils: Number(position?.capturedFils),
        refundedFils: Number(position?.refundedFils),
        chargedBackFils: Number(position?.chargedBackFils),
      }),
    ).toBe(0)
  })

  it('refuses a DISPUTE arriving after a refund that was legitimate when it was made (ZY433)', async () => {
    // The ordering that matters most and the one a rule attached only to the refund path would miss: a
    // customer refunded in good faith who then disputes the original charge anyway.
    await refund('partial', 8_000, 1)
    const error = await errorOf(() =>
      dispute({
        key: 'partial',
        disputeRef: `${PREFIX}-${nonce}-PARTIAL`,
        kind: 'received',
        amountFils: 5_000,
        receivedAtIso: `${TRADING_DATE}T22:00:00+04:00`,
        tradingDate: TRADING_DATE,
        entrySuffix: 'PARTIAL-R1',
      }),
    )
    expect(isChargebackRule(error, 'captureIsOverReversed')).toBe(true)
    // The control: a dispute within the remaining 2,000 is accepted, so the refusal is the arithmetic
    // and not the direction of arrival.
    await dispute({
      key: 'partial',
      disputeRef: `${PREFIX}-${nonce}-PARTIAL-OK`,
      kind: 'received',
      amountFils: 2_000,
      receivedAtIso: `${TRADING_DATE}T22:00:00+04:00`,
      tradingDate: TRADING_DATE,
      entrySuffix: 'PARTIAL-OK',
    })
    const position = await readRefundablePosition(sql, intents.get('partial') as string)
    expect(Number(position?.refundedFils) + Number(position?.chargedBackFils)).toBe(CAPTURED)
  })
})

describe('the sequence', () => {
  it('refuses a dispute against an intent that captured nothing (ZY435)', async () => {
    const [row] = await sql<{ id: string }[]>`
      insert into payment_intent (
        idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference
      ) values (
        ${`${PREFIX}-${nonce}-uncaptured`}, 'gateway-not-chosen', 'card_online', '1030', 5000,
        ${`${PREFIX}-${nonce}-uncaptured`}
      )
      returning id
    `
    intents.set('uncaptured', row?.id as string)
    const error = await errorOf(() =>
      dispute({
        key: 'uncaptured',
        disputeRef: `${PREFIX}-${nonce}-UNCAP`,
        kind: 'received',
        amountFils: 1_000,
        receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
        tradingDate: TRADING_DATE,
        entrySuffix: 'UNCAP-R1',
      }),
    )
    expect(isChargebackRule(error, 'nothingWasCaptured')).toBe(true)
  })

  it('refuses a resolution with no received event before it (ZY434)', async () => {
    const error = await errorOf(() =>
      dispute({
        key: 'sequence',
        disputeRef: `${PREFIX}-${nonce}-ORPHAN`,
        kind: 'lost',
        amountFils: 1_000,
        receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
        tradingDate: TRADING_DATE,
        entrySuffix: 'ORPHAN-W',
      }),
    )
    expect(isChargebackRule(error, 'sequenceIsWrong')).toBe(true)
    expect(chargebackError(error)?.message).toContain('ChargebackResolvedBeforeItArrived')
  })

  it('refuses a second, different resolution of one dispute (ZY434)', async () => {
    const ref = `${PREFIX}-${nonce}-TWICE`
    const received = await dispute({
      key: 'sequence',
      disputeRef: ref,
      kind: 'received',
      amountFils: 1_000,
      receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
      tradingDate: TRADING_DATE,
      entrySuffix: 'TWICE-R1',
    })
    await dispute({
      key: 'sequence',
      disputeRef: ref,
      kind: 'lost',
      amountFils: 1_000,
      receivedAtIso: `${NEXT_CALENDAR_DATE}T15:00:00+04:00`,
      tradingDate: NEXT_CALENDAR_DATE,
      entrySuffix: 'TWICE-W',
    })
    // A `won` after a `lost`. The unique constraint does not refuse this — the kinds differ — and
    // without ZY434 it would unwind 1045 twice and leave the account negative.
    const error = await errorOf(() =>
      dispute({
        key: 'sequence',
        disputeRef: ref,
        kind: 'won',
        amountFils: 1_000,
        receivedAtIso: `${NEXT_CALENDAR_DATE}T16:00:00+04:00`,
        tradingDate: NEXT_CALENDAR_DATE,
        entrySuffix: 'TWICE-W2',
        reverses: {
          entry: chargebackReceivedEntry(
            {
              entryId: entryId(received.entryId) as EntryId,
              entryDate: localDate(TRADING_DATE),
              intentRef: intents.get('sequence') as string,
              disputeRef: ref,
              amountFils: 1_000,
            },
            CHART,
          ),
        },
      }),
    )
    expect(isChargebackRule(error, 'sequenceIsWrong')).toBe(true)
    expect(chargebackError(error)?.message).toContain('ChargebackResolvedTwice')
  })

  it('refuses a won entry that is a mirror rather than a reversal (ZY436)', async () => {
    const ref = `${PREFIX}-${nonce}-MIRROR`
    await dispute({
      key: 'replay',
      disputeRef: ref,
      kind: 'received',
      amountFils: 1_000,
      receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
      tradingDate: TRADING_DATE,
      entrySuffix: 'MIRROR-R1',
    })
    // A hand-built mirror: it balances perfectly, it moves the right amount on 1045, and it reverses
    // nothing — so nothing ties the win to the dispute it is about.
    const error = await errorOf(() =>
      dispute({
        key: 'replay',
        disputeRef: ref,
        kind: 'won',
        amountFils: 1_000,
        receivedAtIso: `${NEXT_CALENDAR_DATE}T15:00:00+04:00`,
        tradingDate: NEXT_CALENDAR_DATE,
        entrySuffix: 'MIRROR-W',
        mirrorInsteadOfReversal: true,
      }),
    )
    expect(isChargebackRule(error, 'wonDoesNotNetToZero')).toBe(true)
    expect(chargebackError(error)?.message).toContain('WonChargebackIsNotAReversal')
  })

  it('answers a redelivered notice as a redelivery and not as a second posting', async () => {
    // The property Y-PAY-04's webhook handler needs: a bare 23505 cannot be told apart from the intent's
    // own idempotency key, which means something completely different.
    const error = await errorOf(() =>
      dispute({
        key: 'replay',
        disputeRef: `${PREFIX}-${nonce}-MIRROR`,
        kind: 'received',
        amountFils: 1_000,
        receivedAtIso: `${TRADING_DATE}T21:00:00+04:00`,
        tradingDate: TRADING_DATE,
        entrySuffix: 'MIRROR-R1-REPLAY',
      }),
    )
    expect(isChargebackRedelivery(error)).toBe(true)
    // And it is NOT one of our own rules, which is the distinction a handler branches on.
    expect(chargebackError(error)).toBeNull()
  })
})

describe('the SQLSTATE registry', () => {
  it('names every code this migration raises, and no code it does not', async () => {
    const raised = new Set(Object.values(CHARGEBACK_SQLSTATE))
    expect([...raised].sort()).toEqual(['ZY431', 'ZY432', 'ZY433', 'ZY434', 'ZY435', 'ZY436'])
    const unusedCodes: readonly string[] = ['ZY437', 'ZY438', 'ZY439', 'ZY440']
    for (const unused of unusedCodes) {
      expect([...raised]).not.toContain(unused)
    }
    expect([...CHARGEBACK_KINDS]).toEqual(['received', 'won', 'lost'])
  })
})

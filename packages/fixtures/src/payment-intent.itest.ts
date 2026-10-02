import { parseConfig } from '@berelax/config'
import type {
  IdempotencyKey,
  Instant,
  PaymentIntentEvent,
  PaymentIntentEventType,
} from '@berelax/core'
import {
  aed,
  filsFrom,
  fixedClock,
  intentTransactions,
  money,
  PAYMENT_INTENT_EVENTS,
  PAYMENT_INTENT_STATES,
  reduceIntent,
  storedFiguresOf,
} from '@berelax/core'
import type { Actor, Sql } from '@berelax/db'
import {
  createConnection,
  deriveFiguresFromTransactions,
  isPaymentIntentRule,
  PAYMENT_INTENT_SQLSTATE,
  paymentIntentError,
  readPaymentIntent,
  readPaymentIntentTransactions,
  withUnitOfWork,
} from '@berelax/db'
import type { PaymentGatewayRegistry } from '@berelax/payments'
import {
  capturePaymentIntent,
  createPaymentGateways,
  createPaymentIntent,
  recordClientCallback,
  refundPaymentIntent,
  voidPaymentIntent,
} from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Y-PAY-02's pair: the pure lifecycle in `@berelax/core` and the durable rows in `@berelax/db` are the same
 * answer, and the database refuses every way of making them differ.
 *
 * `packages/fixtures` is the package allowed to depend on both (brief rule 4), and three of this unit's five
 * acceptance lines can only be asserted here because each is a claim about a real PostgreSQL:
 *
 *   - *"a repeated idempotency key returns the original intent and the adapter records zero additional
 *     calls"* — the key's uniqueness is a constraint and the call log is the registry's sink, so the claim
 *     spans both.
 *   - *"an UPDATE or DELETE on the payment transaction table is refused by a DB rule"* — a trigger fires or
 *     it does not; no source scan can tell.
 *   - *"a client-supplied success callback with no matching gateway transaction leaves the intent in its
 *     prior state and writes an audit_event"* — `audit_event` is append-only (ADR 0008) and the assertion is
 *     a DELTA on it.
 *
 * ## Isolation: nothing here is ever removed, and that is the design rather than a compromise
 *
 * ZY161 refuses DELETE on a `payment_intent_transaction` row for every role including the owner, and the row
 * references its intent — so an intent that has been moved can never be deleted either. There is therefore
 * no `beforeEach` truncation in this file and there cannot be one: every assertion is a DELTA or is scoped
 * to intents this run created, exactly as brief rule 9 requires of `audit_event`. Nothing is declared in
 * `packages/db/src/suite-table-declarations.ts` because nothing here issues an unqualified `delete` or a
 * `truncate` at all — the two probes that try to remove a row are scoped to one id by a `where` clause and
 * are asserted to FAIL.
 *
 * Every idempotency key and reference is prefixed with a per-run token, so two runs against one database — or
 * this file and another suite — cannot collide on `payment_intent_one_intent_per_key`.
 */

const ACTOR: Actor = { kind: 'staff', label: 'Y-PAY-02 pair itest' }
const CLOCK_ISO = '2026-09-28T19:30:00.000Z'

/**
 * A token unique to this run, so a second run against the same database does not meet its own keys.
 *
 * Needed rather than tidy: the rows cannot be removed, so a fixed key would make the second run of this file
 * read the FIRST run's intent and every "created" assertion would report a replay. That failure names the
 * assertion and not the cause, which is why the token is here and not left to a `beforeEach` that could not
 * work anyway.
 */
const RUN = `ypay02-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const key = (name: string): IdempotencyKey => `${RUN}-${name}` as IdempotencyKey

let sql: Sql
let registry: PaymentGatewayRegistry

beforeAll(() => {
  sql = createConnection({ url: url as string, max: 4 })
  registry = createPaymentGateways({
    config: parseConfig({ APP_ENV: 'test', DATABASE_URL: url as string }),
    clock: fixedClock(CLOCK_ISO),
  })
})

afterAll(async () => {
  await sql.end()
})

/** How many movements the gateway has been asked for, in total. The acceptance line's "call log". */
const callsSoFar = (): number => registry.records.all().length

const auditCount = async (action: string, entityId: string): Promise<number> => {
  // `entity_id` is TEXT and not uuid, so there is no `::uuid` cast here. The first version had one and
  // failed with `operator does not exist: text = uuid` — 0005 made the column text because an audited
  // entity is not always a uuid (a setting key, an account code), and a cast would have made this reader
  // work for exactly the tables whose ids happen to be one.
  //
  // Counted in SQL. `settings-store.itest.ts` lost three recorded changes to a capped reader — both sides of
  // a subtraction pinned at the limit — and a delta over an append-only table is exactly that shape.
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from audit_event
     where action = ${action} and entity_id = ${entityId}
  `
  return row?.n ?? 0
}

/** Authorises one intent through the fake card gateway and returns it. */
async function authorise(name: string, fils: number, reference = `INV-${name}`) {
  return await withUnitOfWork(sql, ACTOR, (uow) =>
    createPaymentIntent(uow, registry.cards, {
      idempotencyKey: key(name),
      amount: money(filsFrom(fils)),
      instrument: 'card_online',
      reference: `${RUN}/${reference}`,
    }),
  )
}

describe('acceptance — a repeated idempotency key returns the original intent and calls nothing', () => {
  it('replays the first intent and the adapter records zero additional calls', async () => {
    const first = await authorise('replay', 40_000)
    expect(first.outcome).toBe('created')
    expect(first.intent.state).toBe('authorised')
    expect(first.intent.authorisedFils).toBe(40_000)

    // The control on the measurement: the authorisation DID reach the adapter, so a log that never grows
    // cannot make the assertion below pass for the wrong reason.
    const afterFirst = callsSoFar()
    expect(afterFirst, 'the authorisation did not reach the adapter at all').toBeGreaterThan(0)

    const second = await authorise('replay', 40_000)
    expect(second.outcome).toBe('replayed')
    expect(second.intent.id, 'the replay returned a different intent').toBe(first.intent.id)
    expect(second.intent.authorisedFils).toBe(first.intent.authorisedFils)
    expect(
      callsSoFar() - afterFirst,
      'the replay reached the adapter. The key must be claimed by the INSERT before the gateway is called; ' +
        "deduplicating on the adapter's own idempotency still returns the first snapshot and still writes a " +
        'suppressed-duplicate movement, so the payments screen shows two rows for one authorisation.',
    ).toBe(0)

    // And the replay is visible on the audit trail rather than silent, because an operator asking "why does
    // this key appear twice in our logs" needs an answer that is not an absence.
    expect(await auditCount('payment.intent_replayed', first.intent.id)).toBe(1)
  })

  it('a different key against the same reference is a different intent, which is the control', async () => {
    // Without this, "the replay returned the same intent" is satisfied by an implementation that returns the
    // same intent for everything.
    const a = await authorise('distinct-a', 12_000, 'INV-SHARED')
    const b = await authorise('distinct-b', 12_000, 'INV-SHARED')
    expect(a.intent.id).not.toBe(b.intent.id)
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('created')
  })

  it('writes one movement per gateway event and not one per delivery', async () => {
    // The H02 fake queues every event TWICE on purpose, because a consumer that has only ever seen one copy
    // has an idempotency bug it has not met yet. So the stored rows are the distinct EVENTS, and this is the
    // assertion that would fail if `reduceIntent`'s dedupe were removed — the figures would double too, and
    // ZY163 would refuse the write, so the failure would arrive as a refusal rather than as a wrong number.
    const { intent } = await authorise('dedupe', 25_000)
    const rows = await readPaymentIntentTransactions(sql, intent.id)
    expect(rows.length).toBe(1)
    expect(rows.map((row) => row.gatewayEventType)).toEqual(['authorised'])
    expect(new Set(rows.map((row) => row.gatewayEventId)).size).toBe(rows.length)
  })
})

describe('acceptance — an UPDATE or DELETE on the transaction table is refused by a DB rule', () => {
  it('refuses both, by name, for the owner role', async () => {
    const { intent } = await authorise('append-only', 30_000)
    const [row] = await readPaymentIntentTransactions(sql, intent.id)
    expect(row, 'the intent has no movement to probe').toBeDefined()
    const id = row?.id as string

    // Scoped to one id by a `where` clause, and asserted to FAIL: W-SYS-13's scan refuses an UNQUALIFIED
    // delete or truncate in a test file, and neither of these is one. Nothing is removed in either case.
    let updateError: unknown
    try {
      await sql`update payment_intent_transaction set amount_fils = 1 where id = ${id}::uuid`
    } catch (error) {
      updateError = error
    }
    expect(updateError, 'the UPDATE was accepted').toBeDefined()
    expect(isPaymentIntentRule(updateError, 'transactionAppendOnly')).toBe(true)
    expect(paymentIntentError(updateError)?.message).toContain(
      'PaymentIntentTransactionIsAppendOnly',
    )

    let deleteError: unknown
    try {
      await sql`delete from payment_intent_transaction where id = ${id}::uuid`
    } catch (error) {
      deleteError = error
    }
    expect(deleteError, 'the DELETE was accepted').toBeDefined()
    expect(isPaymentIntentRule(deleteError, 'transactionAppendOnly')).toBe(true)

    // The row is still there, which is the claim the two refusals are for. A trigger that raised and
    // somehow let the change through would satisfy both assertions above.
    const after = await readPaymentIntentTransactions(sql, intent.id)
    expect(after.length).toBe(1)
    expect(after[0]?.amountFils).toBe(30_000)
  })

  it('refuses to delete the intent too, because its movements pin it', async () => {
    // The consequence of ZY161 that a reader has to know about: nothing here can ever be emptied, so every
    // assertion in this file is a delta. Asserted rather than left as a comment, because a future migration
    // adding `on delete cascade` would quietly make the intents deletable and this file's isolation story
    // would become wrong without anything failing.
    const { intent } = await authorise('undeletable', 15_000)
    let caught: unknown
    try {
      await sql`delete from payment_intent where id = ${intent.id}::uuid`
    } catch (error) {
      caught = error
    }
    expect(caught, 'the intent was deleted, which its movements must have prevented').toBeDefined()
    expect(await readPaymentIntent(sql, intent.id)).not.toBeNull()
  })

  it('refuses a second row for one gateway event, as a code a webhook handler can branch on', async () => {
    // ZY164. A bare unique violation cannot be told from the intent's own idempotency-key violation, which
    // means the opposite thing, so Y-PAY-04's handler needs the named code to answer 200 to a redelivery.
    const { intent } = await authorise('redelivery', 20_000)
    const [row] = await readPaymentIntentTransactions(sql, intent.id)
    let caught: unknown
    try {
      await sql`
        insert into payment_intent_transaction (
          payment_intent_id, gateway_event_id, gateway_event_type, amount_fils, occurred_at,
          idempotency_key
        ) values (
          ${intent.id}::uuid, ${row?.gatewayEventId as string}, 'captured', 1,
          ${CLOCK_ISO}, ${key('redelivery-probe')}
        )
      `
    } catch (error) {
      caught = error
    }
    expect(isPaymentIntentRule(caught, 'eventAlreadyRecorded')).toBe(true)
    // `conflict` and not `invariant_violated`: it is the one refusal here a correct caller meets on a
    // correct day, because a webhook stream is at-least-once.
    expect(paymentIntentError(caught)?.kind).toBe('conflict')
  })
})

describe('acceptance — only a gateway movement may move an intent (ADR 0056)', () => {
  it('refuses a state change that names no new transaction row', async () => {
    const { intent } = await authorise('no-row', 18_000)
    let caught: unknown
    try {
      await sql`update payment_intent set state = 'captured' where id = ${intent.id}::uuid`
    } catch (error) {
      caught = error
    }
    expect(isPaymentIntentRule(caught, 'movedWithoutATransaction')).toBe(true)
    expect((await readPaymentIntent(sql, intent.id))?.state).toBe('authorised')
  })

  it('refuses a figure change that names no new transaction row', async () => {
    // The same rule over the amounts, which is the half a reader skips: "moved" is not only the state, and
    // an intent whose captured figure crept up with no row behind it is money claimed from nothing.
    const { intent } = await authorise('no-row-figures', 18_000)
    let caught: unknown
    try {
      await sql`update payment_intent set captured_fils = 5_000 where id = ${intent.id}::uuid`
    } catch (error) {
      caught = error
    }
    expect(isPaymentIntentRule(caught, 'movedWithoutATransaction')).toBe(true)
    expect((await readPaymentIntent(sql, intent.id))?.capturedFils).toBe(0)
  })

  it("refuses a row that belongs to another intent, so one document cannot justify another's figures", async () => {
    const mine = await authorise('borrow-mine', 9_000)
    const theirs = await authorise('borrow-theirs', 9_000)
    const [row] = await readPaymentIntentTransactions(sql, theirs.intent.id)
    let caught: unknown
    try {
      await sql`
        update payment_intent
           set state = 'captured', captured_fils = 9_000, last_transaction_id = ${row?.id as string}::uuid
         where id = ${mine.intent.id}::uuid
      `
    } catch (error) {
      caught = error
    }
    expect(isPaymentIntentRule(caught, 'movedWithoutATransaction')).toBe(true)
    expect(paymentIntentError(caught)?.message).toContain('belongs to intent')
  })

  it('refuses a header that disagrees with its rows, at COMMIT', async () => {
    // ZY163, and reaching it is less obvious than it looks — which this unit's own probe found. A figure
    // changed with NO new row is already refused by ZY162, so the only way to a header/rows disagreement is
    // a genuine new row plus a header that lies about it. The refusal then arrives at COMMIT rather than at
    // the UPDATE, because the trigger is deferred (0018's reason: the row and the header are separate
    // statements, so an immediate check would reject every legal write).
    const { intent } = await authorise('lying-header', 50_000)
    let caught: unknown
    try {
      await sql.begin(async (tx) => {
        const [inserted] = await tx<{ id: string }[]>`
          insert into payment_intent_transaction (
            payment_intent_id, gateway_event_id, gateway_event_type, amount_fils, occurred_at,
            idempotency_key
          ) values (
            ${intent.id}::uuid, ${key('lying-capture')}, 'captured', 10_000, ${CLOCK_ISO},
            ${key('lying-header')}
          ) returning id
        `
        // One fils short of the truth. Both statements SUCCEED; the transaction fails as a whole.
        await tx`
          update payment_intent
             set state = 'captured', captured_fils = 9_999,
                 last_transaction_id = ${inserted?.id as string}::uuid
           where id = ${intent.id}::uuid
        `
      })
    } catch (error) {
      caught = error
    }
    expect(isPaymentIntentRule(caught, 'headerDisagreesWithTransactions')).toBe(true)

    // And the control, which is what makes the case above about the FIGURE rather than about the sequence:
    // the identical transaction with the truthful figure commits, through the real code path.
    const captured = await withUnitOfWork(sql, ACTOR, (uow) =>
      capturePaymentIntent(uow, registry.cards, {
        paymentIntentId: intent.id,
        amount: money(filsFrom(10_000)),
        idempotencyKey: key('honest-capture'),
      }),
    )
    expect(captured.intent.state).toBe('captured')
    expect(captured.intent.capturedFils).toBe(10_000)
  })

  it('refuses an intent for a tender kind the till takes rather than a gateway', async () => {
    // ZY165. An intent for `cash` would authorise money already in the drawer, and `finaliseCheckout` has
    // already posted it — so the same money would be posted twice.
    let caught: unknown
    try {
      await sql`
        insert into payment_intent (
          idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference
        ) values (${key('cash-intent')}, 'till', 'cash', '1000', 1_000, ${key('cash-ref')})
      `
    } catch (error) {
      caught = error
    }
    expect(isPaymentIntentRule(caught, 'instrumentIsNotAGatewayKind')).toBe(true)
    // The control: the same INSERT with the gateway's own kind is accepted, so the refusal is about the
    // adapter column and not about the statement.
    await sql`
      insert into payment_intent (
        idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference
      ) values (${key('online-intent')}, 'fake-card-gateway', 'card_online', '1030', 1_000,
                ${key('online-ref')})
    `
  })
})

describe('acceptance — the derived balance equals the sum of the append-only rows', () => {
  it('agrees with the pure fold over a real capture-and-refund sequence, in SQL', async () => {
    const authorised = await authorise('balance', 60_000)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      capturePaymentIntent(uow, registry.cards, {
        paymentIntentId: authorised.intent.id,
        amount: money(filsFrom(45_000)),
        idempotencyKey: key('balance-capture'),
      }),
    )
    const refunded = await withUnitOfWork(sql, ACTOR, (uow) =>
      refundPaymentIntent(uow, registry.cards, {
        paymentIntentId: authorised.intent.id,
        amount: money(filsFrom(5_000)),
        idempotencyKey: key('balance-refund'),
        reason: 'one treatment of three was not delivered',
      }),
    )

    expect(refunded.intent.state).toBe('captured')
    expect(refunded.intent.authorisedFils).toBe(60_000)
    expect(refunded.intent.capturedFils).toBe(45_000)
    expect(refunded.intent.refundedFils).toBe(5_000)

    // Direction 1: the header equals the SQL aggregate over the rows.
    const derived = await deriveFiguresFromTransactions(sql, authorised.intent.id)
    expect(derived.rowCount, 'no rows were aggregated, so this case measures nothing').toBe(3)
    expect({
      authorisedFils: derived.authorisedFils,
      capturedFils: derived.capturedFils,
      refundedFils: derived.refundedFils,
    }).toEqual({ authorisedFils: 60_000, capturedFils: 45_000, refundedFils: 5_000 })

    // Direction 2: and it equals what the PURE fold in `@berelax/core` makes of the same rows read back as
    // events. Two independent derivations — one in SQL, one in TypeScript — which is what the acceptance
    // line is about. A comparison of the header against itself would agree with anything.
    const stored = await readPaymentIntentTransactions(sql, authorised.intent.id)
    const events: PaymentIntentEvent[] = stored.map((row) => ({
      eventId: row.gatewayEventId,
      type: row.gatewayEventType as PaymentIntentEventType,
      occurredAt: row.occurredAt.getTime() as Instant,
      ...(row.amountFils === 0 ? {} : { amount: money(filsFrom(row.amountFils)) }),
    }))
    const folded = reduceIntent(events)
    expect(folded.state).toBe(refunded.intent.state)
    expect(storedFiguresOf(intentTransactions(events))).toEqual({
      authorisedFils: derived.authorisedFils,
      capturedFils: derived.capturedFils,
      refundedFils: derived.refundedFils,
    })
    // The residue an operator actually reads: what is still held, and what may still be taken.
    expect(folded.amounts.refundable.fils).toBe(40_000)
    expect(folded.amounts.capturable.fils).toBe(15_000)
  })

  it('the control: the comparison detects a figure that is one fils out', async () => {
    // Without this the two directions above are satisfied by `toEqual` comparing something to itself. The
    // perturbation is the smallest one that matters, because a check that only notices large errors is the
    // check that misses every rounding.
    const derived = { authorisedFils: 60_000, capturedFils: 45_000, refundedFils: 5_000 }
    expect({ ...derived, capturedFils: 44_999 }).not.toEqual(derived)
  })

  it('zeroes what is capturable once the reservation is released', async () => {
    const authorised = await authorise('void', 22_000)
    const voided = await withUnitOfWork(sql, ACTOR, (uow) =>
      voidPaymentIntent(uow, registry.cards, {
        paymentIntentId: authorised.intent.id,
        idempotencyKey: key('void-op'),
      }),
    )
    expect(voided.intent.state).toBe('voided')
    // `authorised` stays as it was — it is the record of what WAS reserved, which is the figure a
    // reconciliation against the gateway needs — and the void row carries zero fils.
    expect(voided.intent.authorisedFils).toBe(22_000)
    expect(voided.intent.capturedFils).toBe(0)
    const rows = await readPaymentIntentTransactions(sql, authorised.intent.id)
    expect(rows.map((row) => row.gatewayEventType)).toEqual(['authorised', 'voided'])
    expect(rows.find((row) => row.gatewayEventType === 'voided')?.amountFils).toBe(0)
  })
})

describe('acceptance — a client callback with no matching gateway transaction moves nothing', () => {
  it('leaves the intent in its prior state and writes an audit_event', async () => {
    const { intent } = await authorise('callback', 33_000)
    const before = await auditCount('payment.client_callback_unmatched', intent.id)

    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordClientCallback(uow, {
        paymentIntentId: intent.id,
        // The browser says the money was taken. Nothing captured it.
        claimedEvent: 'captured',
        claimedGatewayEventId: 'evt_the_client_made_this_up',
      }),
    )

    expect(result.outcome).toBe('no_matching_gateway_transaction')
    expect(result.stateBefore).toBe('authorised')
    expect(result.stateAfter).toBe('authorised')

    // The state in the DATABASE, not the value the function returned: a function that reported the prior
    // state while having moved the row would satisfy the three assertions above completely.
    const after = await readPaymentIntent(sql, intent.id)
    expect(after?.state).toBe('authorised')
    expect(after?.capturedFils).toBe(0)
    expect(after?.lastTransactionId).toBe(intent.lastTransactionId)

    // A DELTA on an append-only table (brief rule 9 / ADR 0008), never a total.
    expect(
      (await auditCount('payment.client_callback_unmatched', intent.id)) - before,
      'the unmatched callback wrote no audit row. A claim that the money moved when nothing recorded it ' +
        'moving is the shape of both a replay attack and a lost webhook, and telling those apart later ' +
        'needs the attempt on the trail.',
    ).toBe(1)

    // And no movement was written, which is what "moves nothing" means in the table this unit owns.
    expect((await readPaymentIntentTransactions(sql, intent.id)).length).toBe(1)
  })

  it('the control: a callback the stored movements DO support is answered as confirmed', async () => {
    // Without this, "the callback moves nothing" is satisfied by a function that refuses every callback,
    // and the acceptance line would be met by an endpoint that does not work at all.
    const { intent } = await authorise('callback-ok', 14_000)
    const [row] = await readPaymentIntentTransactions(sql, intent.id)
    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordClientCallback(uow, {
        paymentIntentId: intent.id,
        claimedEvent: 'authorised',
        claimedGatewayEventId: row?.gatewayEventId as string,
      }),
    )
    expect(result.outcome).toBe('confirmed_by_a_stored_movement')
    // Confirmed is still not a move: the movement that confirms it had already moved the intent.
    expect(result.stateBefore).toBe(result.stateAfter)
    expect((await readPaymentIntent(sql, intent.id))?.state).toBe('authorised')
    expect(await auditCount('payment.client_callback_confirmed', intent.id)).toBe(1)
  })
})

describe('the schema mirrors the core enums, in both directions', () => {
  /** The literals a CHECK over one column allows, read out of its definition. */
  const allowedBy = async (table: string, constraint: string): Promise<readonly string[]> => {
    const [row] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(c.oid) as definition
        from pg_constraint c join pg_class t on t.oid = c.conrelid
       where t.relname = ${table} and c.conname = ${constraint}
    `
    expect(row, `${table}.${constraint} does not exist`).toBeDefined()
    return [...(row?.definition ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] as string)
  }

  it('allows exactly the six states PAYMENT_INTENT_STATES names', async () => {
    // Both directions. A state added to the enum and not to the CHECK is an intent the fold can reach and
    // the database cannot store; one added to the CHECK and not to the enum is a column value nothing can
    // read back. Neither is a build error on its own, which is why this is asserted against a real
    // catalogue rather than against the migration's text.
    const allowed = await allowedBy('payment_intent', 'payment_intent_state_known')
    expect([...allowed].sort()).toEqual([...PAYMENT_INTENT_STATES].sort())
  })

  it('allows exactly the six events PAYMENT_INTENT_EVENTS names', async () => {
    const allowed = await allowedBy(
      'payment_intent_transaction',
      'payment_intent_transaction_event_type_known',
    )
    expect([...allowed].sort()).toEqual([...PAYMENT_INTENT_EVENTS].sort())
  })

  it('the control: the reader really does extract literals, and would notice a missing one', async () => {
    // A reader that returned `[]` would satisfy neither case above — both compare against a six-element
    // enum — but one that returned a fixed six would satisfy both. So: the extraction is non-empty, and the
    // comparison detects a set with one member removed.
    const allowed = await allowedBy('payment_intent', 'payment_intent_state_known')
    expect(allowed.length).toBe(6)
    expect([...allowed].slice(1).sort()).not.toEqual([...PAYMENT_INTENT_STATES].sort())
  })

  it('registers a distinct SQLSTATE for every rule these two tables raise', async () => {
    // SIX distinct values now, not five: ZY161-ZY165 are 0106's and ZY231 is 0117's (Y-PAY-03, card-shaped
    // text in a payments column). Distinctness is what is asserted, because a translator that matched two
    // rules to one code would report one file's refusal as the other's — the defect ADR 0043 exists to end —
    // and every probe above would still pass.
    //
    // This case used to assert `size === 5` and `/^ZY16[1-5]$/`, which read as a claim about distinctness and
    // was really a claim that the constant held one MIGRATION's codes. That stopped being true the moment a
    // second migration added a refusal to the same table, and grouping the constant by table rather than by
    // migration is deliberate: a caller branches on a RULE, and two homes for "the rules this table refuses
    // by" is the arrangement in which a caller checks one list and misses the other.
    const codes = Object.values(PAYMENT_INTENT_SQLSTATE)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBe(6)
    for (const code of codes) expect(code).toMatch(/^ZY(?:16[1-5]|231)$/)
    // And a code outside the set is not claimed by the translator, which is what stops it widening to a
    // class prefix — `startsWith('ZY')` would claim seven other units' refusals as this one's.
    expect(paymentIntentError({ code: 'ZY150' })).toBeNull()
    expect(paymentIntentError({ code: 'ZY166' })).toBeNull()
    expect(paymentIntentError({ code: 'ZY232' })).toBeNull()
  })
})

describe('the money never leaves integer fils', () => {
  it('stores the fils it was given, as an integer, through a real authorisation', async () => {
    // ADR 0007 end to end for this table. AED 262.50 is 26,250 fils and is NOT expressible with `aed`,
    // which takes whole dirhams from an integer literal — this case asserted `aed(26_250)` first and got
    // 2,625,000 fils back, which is the helper being right and the test being wrong about its unit. So the
    // amount comes through `money(filsFrom(...))`, and `aed`'s unit is asserted beside it rather than
    // assumed, because the two helpers differ by a factor of a hundred and only one of them is checked by
    // the compiler.
    expect(aed(262).fils, 'aed() takes whole dirhams').toBe(26_200)
    const amount = money(filsFrom(26_250))
    const { intent } = await authorise('fils', amount.fils)
    expect(intent.requestedFils).toBe(26_250)
    expect(intent.authorisedFils).toBe(26_250)
    // A `bigint` column read loosely arrives as a STRING, which is what `mode: 'bigint'` in the mirror and
    // the `::int` casts in the reader are between — and a string would compare unequal above, so this is
    // the assertion that says which of the two went wrong when it does.
    expect(typeof intent.authorisedFils).toBe('number')
  })
})

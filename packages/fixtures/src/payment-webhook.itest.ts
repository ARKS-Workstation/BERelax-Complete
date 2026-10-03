import {
  ACCOUNTS,
  filsFrom,
  type Instant,
  money,
  PAYMENT_INTENT_EVENTS,
  reduceIntent,
  splitGross,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  declaredWebhookHandlers,
  findPaymentWebhookEvent,
  readPaymentIntent,
  readWebhookHandlerRuns,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  ingestVerifiedWebhook,
  recordClientCallback,
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_HANDLERS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  webhookPayloadDigest,
  webhookSigningSecretFrom,
} from '@berelax/payments'
import { beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_ISSUER } from './invoice.ts'

/**
 * Y-PAY-04's durable half, against real PostgreSQL.
 *
 * The signature is proved without a database by `packages/payments/src/webhook/verify.test.ts`, and the
 * HTTP answers by `apps/web/src/payments-webhook.itest.ts` which drives the real server. What is left is
 * everything that is a property of the ROWS, and every one of them is an acceptance line that cannot be
 * made in a unit test:
 *
 *   1. **Re-delivery of a seen event id returns 200 with no second transition.** The mechanism is
 *      `unique (gateway, event_id)`, so only a real constraint can show it — and the row counts are the
 *      assertion, not the answer.
 *   2. **Ten concurrent deliveries of one event id produce exactly one state transition and exactly one
 *      journal entry.** Nine transactions have to lose a race, which needs nine real connections.
 *   3. **A shuffled six-event sequence converges to the same terminal state as an in-order one**, with
 *      the capture arriving before its authorisation and the refund before its capture. `reduceIntent`
 *      sorts by the gateway's instant before folding, and the claim is about the STORED rows the fold
 *      produces, one delivery at a time, in separate transactions.
 *   4. **An invoice is marked paid only by a webhook-confirmed capture**: driving `recordClientCallback`
 *      alone leaves `invoice_settlement.outstanding_fils` at the whole gross.
 *   5. **A different body under a reused event id is refused** (`ZY672`), which is the claim the unique
 *      constraint cannot make.
 *
 * ## Isolation (brief rule 12)
 *
 * Nothing here can be deleted: `payment_intent_transaction` refuses DELETE for every role (`ZY161`),
 * `journal_entry` refuses it (`ZL001`), `invoice` refuses it, and both webhook tables refuse it
 * (`ZY671`). So there is no truncate in this file, every event id, idempotency key, invoice number and
 * reference carries a per-run nonce, and every assertion is a count filtered to this run's own rows.
 *
 * The signing secret is this file's own string and is not a credential: no gateway has been chosen
 * (`Y7-gateway`), so there is nothing configured anywhere to match it. No customer is named (brief rule
 * 10): the label is `Customer 0042`, `synthetic.ts`' own spelling.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const SECRET = 'y-pay-04-itest-secret-not-a-credential'
const SECRET_BAG = webhookSigningSecretFrom({ PAYMENT_WEBHOOK_SIGNING_SECRET: SECRET })
const GATEWAY = 'gateway-not-chosen'

const TRADING_DAY = '2099-12-20'
const NEXT_DAY = '2099-12-21'
/** 19:00 Asia/Dubai on the trading day: inside the session, and nowhere near the 02:00 boundary. */
const CAPTURE_AT = `${TRADING_DAY}T15:00:00.000Z`

const TREATMENT_GROSS = 18_000
const ACTOR: Actor = { kind: 'staff', label: 'Y-PAY-04 webhook itest' }

let sql: Sql
let nonce: string

/**
 * A document series period unique to this RUN, so document numbers cannot collide with anything.
 *
 * `invoice_series_period_number_unique` covers (series, period, number) and `period_key` is free text, so
 * putting the run's nonce in the period makes a plain counter sufficient. The first version of this
 * helper hashed the nonce and the ticket name into a range of nine thousand, which collided between two
 * tickets of ONE run and could collide between runs — a flake that presents as a duplicate key in a
 * suite that has just inserted its own fixtures.
 */
const PERIOD_KEY = (): string => `2099-${nonce}`
let nextInvoiceNumber = 0
const invoiceNumberFor = (): number => {
  nextInvoiceNumber += 1
  return nextInvoiceNumber
}

const run = (suffix: string): string => `YPAY04-${nonce}-${suffix}`

/**
 * A verified delivery, built the way the route builds one: sign the bytes, then verify them.
 *
 * Through `verifyWebhookSignature` and not by hand-constructing a `VerifiedWebhook`, deliberately. A
 * hand-built one would let this suite pass against a verifier that accepted anything, and the whole point
 * of `ingestVerifiedWebhook` taking that type is that the only way to get one is to verify.
 */
function deliver(body: string, atMs = Date.now()): ReturnType<typeof verifyWebhookSignature> {
  const timestamp = String(Math.floor(atMs / 1000))
  const headers = new Headers()
  headers.set(WEBHOOK_SIGNATURE_HEADER, signWebhookPayload(SECRET, timestamp, body))
  headers.set(WEBHOOK_TIMESTAMP_HEADER, timestamp)
  return verifyWebhookSignature({
    rawBody: body,
    headers,
    secret: SECRET_BAG,
    now: atMs as Instant,
  })
}

const bodyFor = (input: {
  readonly eventId: string
  readonly eventType: string
  readonly gatewayIntentId: string
  readonly occurredAt: string
  readonly amountFils?: number
}): string => JSON.stringify(input)

const hoursAround = async () => (date: string) =>
  date === TRADING_DAY || date === NEXT_DAY
    ? ({ open: '11:00', close: '02:00' } as never)
    : undefined

const ingest = async (body: string) => {
  const verified = deliver(body)
  if (verified.kind !== 'verified')
    throw new Error(`the fixture did not verify: ${verified.reason}`)
  return await ingestVerifiedWebhook(
    { sql, gateway: GATEWAY, hoursAround: hoursAround as never },
    verified,
  )
}

interface Ticket {
  readonly intentId: string
  readonly gatewayIntentId: string
  readonly invoiceId: string
  readonly displayNumber: string
}

/**
 * An invoice that still owes its whole gross, and the gateway intent whose reference names it.
 *
 * No `checkout_finalisation` and no `payment`: the document was raised and nothing has been tendered
 * against it, which is the only state in which "marked paid" is a question. `payment_intent.reference`
 * carries the invoice's `display_number`, which is the lookup `findInvoiceForIntentReference` makes —
 * 0106 refused a foreign key here, because an intent is authorised before there is a document.
 */
async function ticket(suffix: string): Promise<Ticket> {
  const gatewayIntentId = run(`${suffix}-GW`)
  const displayNumber = run(`${suffix}-INV`)
  const split = splitGross(money(filsFrom(TREATMENT_GROSS)))

  const [customer] = await sql<
    { id: string }[]
  >`select id from customer order by created_at limit 1`
  if (customer === undefined) throw new Error('the seed holds no customer — run `pnpm seed` first')

  const invoiceId = await sql.begin(async (tx) => {
    const [made] = await tx<{ id: string }[]>`
      insert into invoice (
        document_kind, series_code, period_key, number, display_number, issuer_legal_name,
        issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
        customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date,
        net_total, vat_total, gross_total
      ) values (
        'tax_invoice', 'TAX-INV', ${PERIOD_KEY()}, ${invoiceNumberFor()}, ${displayNumber},
        ${FIXTURE_ISSUER.legalName}, ${FIXTURE_ISSUER.tradingName}, ${FIXTURE_ISSUER.trn},
        ${FIXTURE_ISSUER.addressLines.join('\n')}, ${FIXTURE_ISSUER.emirate},
        ${customer.id}::uuid, 'Customer 0042',
        ${TRADING_DAY}::date, ${TRADING_DAY}::date, ${TRADING_DAY}::date,
        ${split.net.fils}, ${split.vat.fils}, ${TREATMENT_GROSS}
      )
      returning id
    `
    if (made === undefined) throw new Error('inserting the fixture invoice returned no row')
    await tx`
      insert into invoice_line (
        invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp, line_net_fils,
        line_vat_fils
      ) values (
        ${made.id}::uuid, 1, 'Treatment (Y-PAY-04 fixture)', 1, ${TREATMENT_GROSS},
        ${split.rateBp}, ${split.net.fils}, ${split.vat.fils}
      )
    `
    return made.id
  })

  const [row] = await sql<{ id: string }[]>`
    insert into payment_intent (
      idempotency_key, gateway, gateway_intent_id, instrument, posting_account_code, requested_fils,
      reference
    ) values (
      ${run(`${suffix}-IK`)}, ${GATEWAY}, ${gatewayIntentId}, 'card_online',
      ${ACCOUNTS.gatewayClearing}, ${TREATMENT_GROSS}, ${displayNumber}
    )
    returning id
  `
  if (row === undefined) throw new Error('inserting the fixture intent returned no row')
  return { intentId: row.id, gatewayIntentId, invoiceId, displayNumber }
}

const outstandingOf = async (invoiceId: string): Promise<number> => {
  const [row] = await sql<{ outstanding: string }[]>`
    select outstanding_fils::bigint as outstanding
      from invoice_settlement where invoice_id = ${invoiceId}::uuid
  `
  return Number(row?.outstanding ?? '-1')
}

const transactionCount = async (intentId: string, eventId: string): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from payment_intent_transaction
     where payment_intent_id = ${intentId}::uuid and gateway_event_id = ${eventId}
  `
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 16 })
  nonce = Math.random().toString(36).slice(2, 10)
  for (const [day, next] of [
    [TRADING_DAY, NEXT_DAY],
    [NEXT_DAY, '2099-12-22'],
  ] as const) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date, ${`${day} 11:00:00+04`}::timestamptz, ${`${next} 02:00:00+04`}::timestamptz,
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
}, 60_000)

describe('the handler set, stated twice and held equal', () => {
  it('agrees between payment_webhook_handlers() and WEBHOOK_HANDLERS', async () => {
    // The whole reason the set is in SQL is ZY674's predicate, and a second statement of a fact drifts —
    // so this is the check that ships with it.
    expect([...(await declaredWebhookHandlers(sql))].sort()).toEqual([...WEBHOOK_HANDLERS].sort())
    expect(WEBHOOK_HANDLERS.length).toBeGreaterThan(1)
  })

  it('refuses a handler name the build does not declare', async () => {
    const row = await ticket('HANDLER')
    const outcome = await ingest(
      bodyFor({
        eventId: run('HANDLER-EVT'),
        eventType: 'authorised',
        gatewayIntentId: row.gatewayIntentId,
        occurredAt: CAPTURE_AT,
        amountFils: TREATMENT_GROSS,
      }),
    )
    expect(outcome.kind).toBe('applied')
    if (outcome.kind !== 'applied') return
    const stored = await findPaymentWebhookEvent(sql, GATEWAY, run('HANDLER-EVT'))
    expect(stored).not.toBeNull()
    let thrown: unknown
    try {
      await sql`
        insert into payment_webhook_handler_run (webhook_event_id, handler, outcome, detail)
        values (${stored?.id as string}::uuid, 'intnet', 'applied', 'a typo')
      `
    } catch (error) {
      thrown = error
    }
    // A typo is a NEW slot in unique (webhook_event_id, handler), so without this the event would be
    // processed twice while the constraint reported success.
    expect((thrown as { code?: string } | undefined)?.code).toBe('ZY674')
  })
})

describe('replay protection and idempotency, which are two claims', () => {
  it('lands the same delivery once and answers a redelivery without a second transition', async () => {
    const row = await ticket('REPLAY')
    const eventId = run('REPLAY-EVT')
    const body = bodyFor({
      eventId,
      eventType: 'authorised',
      gatewayIntentId: row.gatewayIntentId,
      occurredAt: CAPTURE_AT,
      amountFils: TREATMENT_GROSS,
    })

    expect((await ingest(body)).kind).toBe('applied')
    expect(await transactionCount(row.intentId, eventId)).toBe(1)

    // The SAME bytes again. 200, not a refusal: a gateway that gets a 4xx for a redelivery escalates an
    // incident about an event it processed correctly.
    const second = await ingest(body)
    expect(second.kind).toBe('redelivered')
    expect(await transactionCount(row.intentId, eventId)).toBe(1)
    const [events] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_webhook_event
       where gateway = ${GATEWAY} and event_id = ${eventId}
    `
    expect(events?.n).toBe('1')
  })

  it('refuses a DIFFERENT body under a reused event id, and applies nothing', async () => {
    const row = await ticket('REUSE')
    const eventId = run('REUSE-EVT')
    const first = bodyFor({
      eventId,
      eventType: 'authorised',
      gatewayIntentId: row.gatewayIntentId,
      occurredAt: CAPTURE_AT,
      amountFils: TREATMENT_GROSS,
    })
    expect((await ingest(first)).kind).toBe('applied')

    // Same id, one fils more. Correctly signed — whoever sent it holds the secret — and still refused.
    const forged = bodyFor({
      eventId,
      eventType: 'authorised',
      gatewayIntentId: row.gatewayIntentId,
      occurredAt: CAPTURE_AT,
      amountFils: TREATMENT_GROSS + 1,
    })
    expect(webhookPayloadDigest(forged)).not.toBe(webhookPayloadDigest(first))
    const refused = await ingest(forged)
    expect(refused.kind).toBe('event_id_reused')

    const stored = await readPaymentIntent(sql, row.intentId)
    expect(stored?.authorisedFils).toBe(TREATMENT_GROSS)
    expect(await transactionCount(row.intentId, eventId)).toBe(1)
  })

  it('produces exactly one transition and one journal entry under ten concurrent deliveries', async () => {
    const row = await ticket('RACE')
    const eventId = run('RACE-EVT')
    await ingest(
      bodyFor({
        eventId: run('RACE-AUTH'),
        eventType: 'authorised',
        gatewayIntentId: row.gatewayIntentId,
        occurredAt: CAPTURE_AT,
        amountFils: TREATMENT_GROSS,
      }),
    )
    const capture = bodyFor({
      eventId,
      eventType: 'captured',
      gatewayIntentId: row.gatewayIntentId,
      occurredAt: `${TRADING_DAY}T15:05:00.000Z`,
      amountFils: TREATMENT_GROSS,
    })

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, async () => {
        try {
          return (await ingest(capture)).kind
        } catch (error) {
          // A loser of the race may surface as a serialisation failure rather than as a unique violation,
          // which is the same fact arriving through another mechanism. Counted, not swallowed: the row
          // counts below are the assertion either way.
          return `threw:${(error as { code?: string }).code ?? 'unknown'}`
        }
      }),
    )
    expect(outcomes.filter((kind) => kind === 'applied')).toHaveLength(1)

    // The acceptance line, asserted by ROW COUNTS and not by the answers above.
    expect(await transactionCount(row.intentId, eventId)).toBe(1)
    const [entries] = await sql<{ n: string }[]>`
      select count(*)::text as n from journal_entry where entry_id = ${`WEBHOOK-${eventId}`}
    `
    expect(entries?.n).toBe('1')
    const [runs] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from payment_webhook_handler_run r
        join payment_webhook_event e on e.id = r.webhook_event_id
       where e.event_id = ${eventId}
    `
    expect(runs?.n).toBe(String(WEBHOOK_HANDLERS.length))
    const [tenders] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment where reference = ${row.gatewayIntentId}
    `
    expect(tenders?.n).toBe('1')
  }, 30_000)
})

describe('order independence', () => {
  it('converges to the same terminal state however the six events arrive', async () => {
    const authorised = TREATMENT_GROSS
    const sequence = [
      { eventType: 'action_required', at: '15:00:00', amountFils: undefined },
      { eventType: 'authorised', at: '15:01:00', amountFils: authorised },
      { eventType: 'captured', at: '15:02:00', amountFils: 10_000 },
      { eventType: 'captured', at: '15:03:00', amountFils: 8_000 },
      { eventType: 'refunded', at: '15:04:00', amountFils: 3_000 },
      { eventType: 'refunded', at: '15:05:00', amountFils: 1_000 },
    ] as const

    const deliverAll = async (suffix: string, order: readonly number[]) => {
      const row = await ticket(suffix)
      const kinds: string[] = []
      for (const index of order) {
        const step = sequence[index]
        if (step === undefined) continue
        kinds.push(
          (
            await ingest(
              bodyFor({
                eventId: run(`${suffix}-E${index}`),
                eventType: step.eventType,
                gatewayIntentId: row.gatewayIntentId,
                occurredAt: `${TRADING_DAY}T${step.at}.000Z`,
                ...(step.amountFils === undefined ? {} : { amountFils: step.amountFils }),
              }),
            )
          ).kind,
        )
      }
      const stored = await readPaymentIntent(sql, row.intentId)
      return {
        kinds,
        state: stored?.state,
        authorisedFils: stored?.authorisedFils,
        capturedFils: stored?.capturedFils,
        refundedFils: stored?.refundedFils,
      }
    }

    const inOrder = await deliverAll('ORDER', [0, 1, 2, 3, 4, 5])
    // The two orderings the acceptance names, each applied through the real ingest in six separate
    // transactions: a capture before the authorisation it belongs to, and a refund before its capture.
    const captureFirst = await deliverAll('SHUF1', [2, 0, 1, 3, 4, 5])
    const refundFirst = await deliverAll('SHUF2', [5, 4, 3, 2, 1, 0])

    const position = ({ kinds: _kinds, ...rest }: Awaited<ReturnType<typeof deliverAll>>) => rest
    expect(position(captureFirst)).toEqual(position(inOrder))
    expect(position(refundFirst)).toEqual(position(inOrder))

    // The vacuity control, and the one that matters: the shuffled runs must actually have HELD something.
    // If every delivery had been applicable on arrival, the convergence above would be a claim about an
    // ordering that never needed resolving — and it would hold for an ingest with no holding at all.
    expect(inOrder.kinds.every((kind) => kind === 'applied')).toBe(true)
    expect(captureFirst.kinds.filter((kind) => kind === 'held').length).toBeGreaterThan(0)
    expect(refundFirst.kinds.filter((kind) => kind === 'held').length).toBeGreaterThan(0)
    // And the control that stops it being vacuous: the terminal state is a REAL position, not an intent
    // every ordering failed to move.
    expect(inOrder.state).toBe('captured')
    expect(inOrder.capturedFils).toBe(18_000)
    expect(inOrder.refundedFils).toBe(4_000)

    // The same answer the pure fold gives, which is the authority the stored rows must agree with.
    const projection = reduceIntent(
      sequence.map((step, index) => ({
        eventId: `E${index}`,
        type: step.eventType,
        occurredAt: Date.parse(`${TRADING_DAY}T${step.at}.000Z`) as Instant,
        ...(step.amountFils === undefined ? {} : { amount: money(filsFrom(step.amountFils)) }),
      })),
    )
    expect(inOrder.state).toBe(projection.state)
    expect(inOrder.capturedFils).toBe(projection.amounts.captured.fils)
  }, 60_000)

  it('covers every event type the lifecycle declares, or says which it does not', () => {
    // A control on the case above: a sequence that exercised three of the six event types would pass it
    // while saying nothing about the other three. `authorisation_failed` and `voided` are deliberately
    // absent — both are terminal from `requires_authorisation`, so neither can appear in a sequence that
    // reaches `captured`, and `state.transitions.test.ts` already asserts the table total over the enum
    // product.
    const exercised = new Set(['action_required', 'authorised', 'captured', 'refunded'])
    const absent = PAYMENT_INTENT_EVENTS.filter((event) => !exercised.has(event))
    expect(absent).toEqual(['authorisation_failed', 'voided'])
  })
})

describe('an invoice is marked paid only by a webhook-confirmed capture', () => {
  it('leaves the invoice unpaid when the CLIENT callback path is driven alone', async () => {
    const row = await ticket('CLIENT')
    await ingest(
      bodyFor({
        eventId: run('CLIENT-AUTH'),
        eventType: 'authorised',
        gatewayIntentId: row.gatewayIntentId,
        occurredAt: CAPTURE_AT,
        amountFils: TREATMENT_GROSS,
      }),
    )
    expect(await outstandingOf(row.invoiceId)).toBe(TREATMENT_GROSS)

    // The browser says the money was taken. It is right almost every time, which is why the code that
    // believes it looks correct in review.
    const claimed = await withUnitOfWork(sql, ACTOR, async (uow) =>
      recordClientCallback(uow, {
        paymentIntentId: row.intentId,
        claimedEvent: 'captured',
        claimedGatewayEventId: run('CLIENT-CAP'),
      }),
    )
    expect(claimed.stateAfter).toBe(claimed.stateBefore)
    // The acceptance line: unchanged, to the fils.
    expect(await outstandingOf(row.invoiceId)).toBe(TREATMENT_GROSS)
    const [tenders] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment where reference = ${row.gatewayIntentId}
    `
    expect(tenders?.n).toBe('0')

    // And the control, which is what makes the case above a claim about the callback rather than about a
    // fixture nothing could ever settle: the WEBHOOK capture settles it.
    const applied = await ingest(
      bodyFor({
        eventId: run('CLIENT-CAP'),
        eventType: 'captured',
        gatewayIntentId: row.gatewayIntentId,
        occurredAt: `${TRADING_DAY}T15:10:00.000Z`,
        amountFils: TREATMENT_GROSS,
      }),
    )
    expect(applied.kind).toBe('applied')
    expect(await outstandingOf(row.invoiceId)).toBe(0)
    if (applied.kind !== 'applied') return
    const runs = await readWebhookHandlerRuns(sql, applied.webhookEventId)
    expect(runs.find((entry) => entry.handler === 'invoice-settlement')?.outcome).toBe('applied')
    expect(runs.find((entry) => entry.handler === 'intent')?.outcome).toBe('applied')
  }, 30_000)

  it('records a skipped run for a capture whose intent names no document', async () => {
    // A deposit on a booking: 0106 refused a key from `payment_intent` to `invoice` precisely because an
    // intent is authorised before there is a document, so this is a real state and not an edge case.
    const gatewayIntentId = run('NODOC-GW')
    await sql`
      insert into payment_intent (
        idempotency_key, gateway, gateway_intent_id, instrument, posting_account_code, requested_fils,
        reference
      ) values (
        ${run('NODOC-IK')}, ${GATEWAY}, ${gatewayIntentId}, 'card_online',
        ${ACCOUNTS.gatewayClearing}, ${TREATMENT_GROSS}, ${run('NODOC-REF')}
      )
    `
    await ingest(
      bodyFor({
        eventId: run('NODOC-AUTH'),
        eventType: 'authorised',
        gatewayIntentId,
        occurredAt: CAPTURE_AT,
        amountFils: TREATMENT_GROSS,
      }),
    )
    const applied = await ingest(
      bodyFor({
        eventId: run('NODOC-CAP'),
        eventType: 'captured',
        gatewayIntentId,
        occurredAt: `${TRADING_DAY}T15:06:00.000Z`,
        amountFils: TREATMENT_GROSS,
      }),
    )
    expect(applied.kind).toBe('applied')
    if (applied.kind !== 'applied') return
    const runs = await readWebhookHandlerRuns(sql, applied.webhookEventId)
    // SKIPPED and not absent: a `skipped` row is the record that this handler LOOKED, and a handler with
    // no row for an event is one a retry will come back to.
    const settlement = runs.find((entry) => entry.handler === 'invoice-settlement')
    expect(settlement?.outcome).toBe('skipped')
    expect(settlement?.detail).toContain('no document')
    expect(runs.find((entry) => entry.handler === 'intent')?.outcome).toBe('applied')
  }, 30_000)
})

describe('an intent the gateway knows and this build does not', () => {
  it('is accepted and not applied, rather than stored with no possible handler', async () => {
    const outcome = await ingest(
      bodyFor({
        eventId: run('ORPHAN-EVT'),
        eventType: 'captured',
        gatewayIntentId: run('ORPHAN-GW'),
        occurredAt: CAPTURE_AT,
        amountFils: 1_000,
      }),
    )
    expect(outcome.kind).toBe('unknown_intent')
    // No event row either: a row is EVIDENCE a signature verified, and this one did — but a row nothing
    // can ever apply would read as processed. Y-PAY-05's subject, and 0106 says so in as many words.
    expect(await findPaymentWebhookEvent(sql, GATEWAY, run('ORPHAN-EVT'))).toBeNull()
  })
})

describe('ZY671 — the ingest tables are append-only', () => {
  it('refuses UPDATE and DELETE on an event and on a handler run, for the owner', async () => {
    const row = await ticket('APPEND')
    const eventId = run('APPEND-EVT')
    const applied = await ingest(
      bodyFor({
        eventId,
        eventType: 'authorised',
        gatewayIntentId: row.gatewayIntentId,
        occurredAt: CAPTURE_AT,
        amountFils: TREATMENT_GROSS,
      }),
    )
    expect(applied.kind).toBe('applied')
    if (applied.kind !== 'applied') return
    const id = applied.webhookEventId
    for (const statement of [
      () => sql`update payment_webhook_event set event_type = 'voided' where id = ${id}::uuid`,
      () => sql`delete from payment_webhook_event where id = ${id}::uuid`,
      () =>
        sql`update payment_webhook_handler_run set outcome = 'skipped' where webhook_event_id = ${id}::uuid`,
      () => sql`delete from payment_webhook_handler_run where webhook_event_id = ${id}::uuid`,
    ]) {
      let thrown: unknown
      try {
        await statement()
      } catch (error) {
        thrown = error
      }
      expect((thrown as { code?: string } | undefined)?.code).toBe('ZY671')
    }
  }, 30_000)
})

describe('ZY673 — "applied" means something moved', () => {
  it('refuses an applied intent run with no movement behind it', async () => {
    const row = await ticket('CLAIM')
    // An event row with no movement at all, then a run claiming it was applied. The run row is what stops
    // a retry, so this state is a LOST money movement the system believes it has processed.
    let thrown: unknown
    try {
      await sql.begin(async (tx) => {
        const [event] = await tx<{ id: string }[]>`
          insert into payment_webhook_event (
            gateway, event_id, event_type, gateway_intent_id, amount_fils, payload_sha256,
            occurred_at, signed_at
          ) values (
            ${GATEWAY}, ${run('CLAIM-EVT')}, 'captured', ${row.gatewayIntentId}, ${TREATMENT_GROSS},
            ${'c'.repeat(64)}, ${CAPTURE_AT}::timestamptz, ${CAPTURE_AT}::timestamptz
          )
          returning id
        `
        await tx`
          insert into payment_webhook_handler_run (webhook_event_id, handler, outcome, detail)
          values (${event?.id as string}::uuid, 'intent', 'applied', 'claims a movement it never made')
        `
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe('ZY673')
  })
})

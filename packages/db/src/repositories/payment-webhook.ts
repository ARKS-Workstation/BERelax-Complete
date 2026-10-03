import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The durable half of webhook ingest: what has been delivered, and which handler has run for it.
 *
 * Y-PAY-04. Both claims the unit is about are reads and writes against `payment_webhook_event` and
 * `payment_webhook_handler_run` (migration 0147), and they are HERE rather than in a handler's memory
 * because the web process restarts on every release and the worker on every crash — at which point a
 * `Set` of seen event ids is empty and the gateway is still retrying everything it has not had a 200 for.
 */

export const PAYMENT_WEBHOOK_SQLSTATE = {
  /** A webhook event row or a handler run was UPDATEd or DELETEd. */
  ingestIsAppendOnly: 'ZY671',
  /** An event id was reused over a different payload digest. */
  eventIdReused: 'ZY672',
  /** A run recorded as applied has no movement behind it. */
  runClaimsAnUnappliedMovement: 'ZY673',
  /** A run names a handler this build does not declare. */
  handlerIsNotDeclared: 'ZY674',
} as const

export type PaymentWebhookRule = keyof typeof PAYMENT_WEBHOOK_SQLSTATE

const UNIQUE_VIOLATION = '23505'

/** The constraints a redelivery trips, by name. The name is the contract. */
export const PAYMENT_WEBHOOK_CONSTRAINT = {
  oneRowPerEvent: 'payment_webhook_event_one_row_per_event',
  oneRunPerHandler: 'payment_webhook_handler_run_once',
} as const

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const carried = (error as { details?: { sqlState?: unknown } }).details?.sqlState
  return typeof carried === 'string' ? carried : null
}

const constraintOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const name = (error as { constraint_name?: unknown }).constraint_name
  return typeof name === 'string' ? name : null
}

/**
 * A webhook refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message and never on the class (ADR 0043).
 *
 * `eventIdReused` is `conflict` and the rest are `invariant_violated`. The split is the one that matters
 * at the endpoint: a reused id is a fact about the REQUEST — the caller sent a body this build will not
 * accept under an id it has already seen — so it is answered, while the other three are states a correct
 * caller cannot produce and are defects in the ingest.
 */
export function paymentWebhookError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(PAYMENT_WEBHOOK_SQLSTATE) as [PaymentWebhookRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  return new AppError(
    rule === 'eventIdReused' ? 'conflict' : 'invariant_violated',
    error instanceof Error ? error.message : `Payment webhook rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named webhook refusal? For a caller that branches on one rule. */
export function isPaymentWebhookRule(error: unknown, rule: PaymentWebhookRule): boolean {
  return sqlStateOf(error) === PAYMENT_WEBHOOK_SQLSTATE[rule]
}

/**
 * Is this the same delivery arriving twice?
 *
 * The property the endpoint needs to answer 200 with no second transition. A bare `23505` cannot be told
 * apart from `payment_webhook_handler_run_once`, which means something different, or from
 * `payment_intent_one_intent_per_key` in the same transaction, which means something different again — so
 * the constraint NAME is part of the test.
 *
 * `ZY672` fires first for a reused id over a DIFFERENT body, so reaching this really does mean the bytes
 * were identical: replay protection, not idempotency.
 */
export function isWebhookRedelivery(error: unknown): boolean {
  return (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    constraintOf(error) === PAYMENT_WEBHOOK_CONSTRAINT.oneRowPerEvent
  )
}

/** Is this the same handler being recorded twice for one event? */
export function isWebhookHandlerAlreadyRun(error: unknown): boolean {
  return (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    constraintOf(error) === PAYMENT_WEBHOOK_CONSTRAINT.oneRunPerHandler
  )
}

export interface PaymentWebhookEventRow {
  readonly id: string
  readonly gateway: string
  readonly eventId: string
  readonly eventType: string
  readonly gatewayIntentId: string
  readonly payloadSha256: string
}

export interface RecordPaymentWebhookEventInput {
  readonly gateway: string
  readonly eventId: string
  readonly eventType: string
  readonly gatewayIntentId: string
  /** Integer fils, or null for an event that moves no money. */
  readonly amountFils?: number | undefined
  /** The digest of the BYTES, computed before the body was parsed. */
  readonly payloadSha256: string
  /** The gateway's own instant, ISO-8601. */
  readonly occurredAtIso: string
  /** The instant the signature covered, ISO-8601. */
  readonly signedAtIso: string
}

/**
 * Records one VERIFIED delivery. Raises on a redelivery and on a reused id.
 *
 * Takes a `UnitOfWork`, because `ZY673` reads the `payment_intent_transaction` rows at COMMIT: an event
 * row committed in one transaction and applied in another would let a crash between the two leave a run
 * claiming a movement that never happened — and the run row is what stops a retry.
 */
export async function recordPaymentWebhookEvent(
  uow: UnitOfWork,
  input: RecordPaymentWebhookEventInput,
): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into payment_webhook_event (
      gateway, event_id, event_type, gateway_intent_id, amount_fils, payload_sha256, occurred_at,
      signed_at
    ) values (
      ${input.gateway}, ${input.eventId}, ${input.eventType}, ${input.gatewayIntentId},
      ${input.amountFils ?? null},
      ${input.payloadSha256}, ${input.occurredAtIso}::timestamptz, ${input.signedAtIso}::timestamptz
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'recordPaymentWebhookEvent inserted no row and did not raise.',
    )
  }
  return row.id
}

/** One event on file for an intent, in the shape a re-fold needs. */
export interface WebhookEventForIntentRow {
  readonly eventId: string
  readonly eventType: string
  readonly amountFils: number | null
  /** Epoch milliseconds, which is what `Instant` is. */
  readonly occurredAtMs: number
}

/**
 * Every event ON FILE for one intent, oldest first by the gateway's own instant.
 *
 * This is what makes a HELD event re-foldable. A capture delivered before the authorisation it belongs to
 * cannot be applied when it arrives — ADR 0056's table is strict, and a capture on an unauthorised intent
 * is a real defect rather than an ordering to tolerate — so it sits here, and the delivery that brings
 * its predecessor folds the whole SET. `reduceIntent` sorts by `occurredAt` before folding, so the answer
 * is a function of the set and not of the order the deliveries arrived in.
 *
 * Read inside the delivery's own transaction, so the event just inserted is included.
 */
export async function readWebhookEventsForIntent(
  sql: Sql,
  gateway: string,
  gatewayIntentId: string,
): Promise<readonly WebhookEventForIntentRow[]> {
  const rows = await sql<
    { eventId: string; eventType: string; amountFils: string | null; occurredAtMs: string }[]
  >`
    select event_id   as "eventId",
           event_type as "eventType",
           amount_fils::bigint as "amountFils",
           (extract(epoch from occurred_at) * 1000)::bigint as "occurredAtMs"
      from payment_webhook_event
     where gateway = ${gateway} and gateway_intent_id = ${gatewayIntentId}
     order by occurred_at, event_id
  `
  return rows.map((row) => ({
    eventId: row.eventId,
    eventType: row.eventType,
    amountFils: row.amountFils === null ? null : Number(row.amountFils),
    occurredAtMs: Number(row.occurredAtMs),
  }))
}

/** The intent a delivery names, or null when the gateway knows one this build does not. */
export interface WebhookIntentRow {
  readonly id: string
  readonly state: string
  readonly postingAccountCode: string
  readonly reference: string
}

/**
 * The intent for one (gateway, gateway intent id).
 *
 * Here rather than added to `repositories/payment-intent.ts`, which is Y-PAY-02's file: a new reader for
 * a new caller belongs with the caller, and editing another unit's repository to add one is the kind of
 * widening a merge then has to arbitrate between two worktrees.
 *
 * `payment_intent_gateway_intent_idx` covers the pair. `limit 1` with no uniqueness claimed, because
 * `unique (gateway, gateway_intent_id)` was written, applied and REMOVED by 0106 — a gateway intent id is
 * unique within a merchant account and no account has been chosen (Y7-mcc), so two local intents against
 * one remote intent is a state the schema does not refuse and Y-PAY-05 reconciles.
 */
export async function readPaymentIntentByGatewayIntentId(
  sql: Sql,
  gateway: string,
  gatewayIntentId: string,
): Promise<WebhookIntentRow | null> {
  const [row] = await sql<WebhookIntentRow[]>`
    select id, state, posting_account_code as "postingAccountCode", reference
      from payment_intent
     where gateway = ${gateway} and gateway_intent_id = ${gatewayIntentId}
     order by created_at
     limit 1
  `
  return row ?? null
}

/** The stored delivery for one (gateway, event id), or null. */
export async function findPaymentWebhookEvent(
  sql: Sql,
  gateway: string,
  eventId: string,
): Promise<PaymentWebhookEventRow | null> {
  const [row] = await sql<PaymentWebhookEventRow[]>`
    select id,
           gateway,
           event_id          as "eventId",
           event_type        as "eventType",
           gateway_intent_id as "gatewayIntentId",
           payload_sha256    as "payloadSha256"
      from payment_webhook_event
     where gateway = ${gateway} and event_id = ${eventId}
  `
  return row ?? null
}

export interface RecordHandlerRunInput {
  readonly webhookEventId: string
  readonly handler: string
  readonly outcome: 'applied' | 'skipped'
  readonly detail: string
}

/** Records that one handler has run for one event. Raises if it has already run. */
export async function recordWebhookHandlerRun(
  uow: UnitOfWork,
  input: RecordHandlerRunInput,
): Promise<void> {
  await uow.sql`
    insert into payment_webhook_handler_run (webhook_event_id, handler, outcome, detail)
    values (${input.webhookEventId}::uuid, ${input.handler}, ${input.outcome}, ${input.detail})
  `
}

export interface WebhookHandlerRunRow {
  readonly handler: string
  readonly outcome: string
  readonly detail: string
}

/** Which handlers have run for one event. What a retry reads before doing anything. */
export async function readWebhookHandlerRuns(
  sql: Sql,
  webhookEventId: string,
): Promise<readonly WebhookHandlerRunRow[]> {
  return await sql<WebhookHandlerRunRow[]>`
    select handler, outcome, detail
      from payment_webhook_handler_run
     where webhook_event_id = ${webhookEventId}::uuid
     order by handler
  `
}

/**
 * The handler set `0147` declares, read from the database.
 *
 * Exists so `packages/fixtures/src/payment-webhook.itest.ts` can hold `payment_webhook_handlers()` equal
 * to `WEBHOOK_HANDLERS` in `@berelax/payments` — two homes of one set, with the check that holds them
 * equal shipping in the same commit as the second one.
 */
export async function declaredWebhookHandlers(sql: Sql): Promise<readonly string[]> {
  const [row] = await sql<{ handlers: readonly string[] }[]>`
    select payment_webhook_handlers() as handlers
  `
  return row?.handlers ?? []
}

/**
 * The invoice a gateway intent's `reference` names, by `display_number`, with what it still owes.
 *
 * `payment_intent` has no foreign key to `invoice` — 0106 refused one, because an intent is authorised
 * before there is a document (a deposit on a booking) — so the reference is text and this is a LOOKUP
 * that may legitimately answer nothing. A capture whose reference names no document is a `skipped` run
 * rather than a failure: the money moved and there is no invoice to settle.
 */
export async function findInvoiceForIntentReference(
  sql: Sql,
  gatewayIntentId: string,
): Promise<{ readonly invoiceId: string; readonly outstandingFils: number } | null> {
  const [row] = await sql<{ invoiceId: string; outstandingFils: string }[]>`
    select s.invoice_id            as "invoiceId",
           s.outstanding_fils::bigint as "outstandingFils"
      from payment_intent pi
      join invoice i on i.display_number = pi.reference
      join invoice_settlement s on s.invoice_id = i.id
     where pi.gateway_intent_id = ${gatewayIntentId}
     limit 1
  `
  if (row === undefined) return null
  const outstanding = Number(row.outstandingFils)
  if (!Number.isSafeInteger(outstanding)) {
    throw new AppError(
      'invariant_violated',
      `invoice_settlement.outstanding_fils is "${row.outstandingFils}", which does not survive the round ` +
        'trip to a JavaScript number. A money figure that rounds is a different figure (ADR 0007).',
    )
  }
  return { invoiceId: row.invoiceId, outstandingFils: outstanding }
}

/**
 * Writes the card tender a webhook-confirmed capture produces. The ONLY way a gateway capture is tendered.
 *
 * `reference` is the gateway intent id, which is what `TENDER_TYPES.card_online` says that column is for
 * and what Y-PAY-09's settlement lines tie against. `tender_no` is the next free one on the document, so
 * a card capture on a part-paid invoice does not collide with the tender already there.
 *
 * Nothing in `recordClientCallback` reaches this function, and that is the acceptance line: an invoice is
 * marked paid only by a webhook-confirmed capture.
 */
export async function tenderWebhookCapture(
  uow: UnitOfWork,
  input: {
    readonly invoiceId: string
    readonly gatewayIntentId: string
    readonly amountFils: number
    readonly postingAccountCode: string
    readonly tradingDate: string
  },
): Promise<void> {
  await uow.sql`
    insert into payment (
      invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, reference, trading_date
    ) values (
      ${input.invoiceId}::uuid,
      coalesce((select max(tender_no) from payment where invoice_id = ${input.invoiceId}::uuid), 0) + 1,
      'card_online', ${input.postingAccountCode}, ${input.amountFils}, ${input.gatewayIntentId},
      ${input.tradingDate}::date
    )
  `
}

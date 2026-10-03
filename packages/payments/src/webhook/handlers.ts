import { createHash } from 'node:crypto'
import {
  ACCOUNTS,
  credit,
  debit,
  entryId,
  filsFrom,
  type GatewayIntentId,
  type HoursForDate,
  type IdempotencyKey,
  INTENT_EVENT_CARRIES_AMOUNT,
  type Instant,
  IntentTransitionRefused,
  localDate,
  money,
  PAYMENT_INTENT_EVENTS,
  type PaymentIntentEvent,
  type PaymentIntentEventType,
  postEntry,
  resolveTradingDate,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import {
  findInvoiceForIntentReference,
  findPaymentWebhookEvent,
  isWebhookHandlerAlreadyRun,
  isWebhookRedelivery,
  paymentWebhookError,
  postJournalEntry,
  readPaymentIntentByGatewayIntentId,
  readWebhookEventsForIntent,
  recordPaymentWebhookEvent,
  recordWebhookHandlerRun,
  type Sql,
  tenderWebhookCapture,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { applyGatewayEvents } from '../intent.ts'
import type { VerifiedWebhook, WebhookDelivery } from './verify.ts'
import { parseWebhookDelivery } from './verify.ts'

/**
 * Applying a verified delivery: exactly once per handler, in the database, because the worker restarts.
 *
 * Y-PAY-04. The signature is `./verify.ts` and happens strictly before anything here. What this module
 * owns is the three things that have to survive a process dying mid-request:
 *
 * - **Replay protection.** The same event delivered twice lands once. `unique (gateway, event_id)` on
 *   `payment_webhook_event` is the mechanism, and the second delivery is answered **200** — a gateway
 *   that gets a 4xx for a redelivery escalates an incident about an event it processed correctly.
 * - **Idempotency, which is a DIFFERENT claim.** A different body under a reused event id is **refused**:
 *   `ZY672` compares the stored payload digest. The unique constraint cannot tell the two apart — both
 *   are a second row with the same id — and treating both as a redelivery accepts a forged payload
 *   silently and then ignores it silently.
 * - **Exactly-once per HANDLER.** One delivery legitimately has more than one handler: a capture moves
 *   the intent AND settles the document it paid for, and those can fail independently.
 *   `unique (webhook_event_id, handler)` is ADR 0008's rule as a constraint, and `ZY674` holds the
 *   handler name to {@link WEBHOOK_HANDLERS} because a typo is a NEW slot in that constraint rather than
 *   an error — the event would then be processed twice while the constraint reported success.
 *
 * ## Why nothing here decides which state an event reaches
 *
 * {@link applyGatewayEvents} does, through `reduceIntent` in `@berelax/core`, which SORTS by the
 * gateway's own instant before folding. That is what makes a shuffled delivery converge: a capture
 * arriving before the authorisation it belongs to is applied in the gateway's order, not ours, so the
 * terminal state is a function of the SET of events. This module adds no second opinion — ADR 0056's
 * division, where the database answers *is there a movement behind this* and core answers *which state
 * does it reach*.
 *
 * ## Why the invoice handler is separate, and what it means for "marked paid"
 *
 * An invoice is marked paid only by a webhook-confirmed capture. `recordClientCallback` in `../intent.ts`
 * contains no UPDATE and never reaches {@link tenderWebhookCapture}; the only path that writes a
 * `card_online` `payment` row for a gateway capture is {@link invoiceSettlementHandler}, and it runs only
 * from a verified, deduplicated delivery. A browser returning from a hosted-fields checkout is the most
 * ordinary untrusted input in the system and it is right almost every time, which is exactly why the code
 * that believes it looks correct in review.
 */

/**
 * Every handler a delivery may be processed by. **The TypeScript half of `payment_webhook_handlers()`.**
 *
 * Held equal to the SQL function by `packages/fixtures/src/payment-webhook.itest.ts`. A second statement
 * of a set drifts, and the reason this one is worth it is `ZY674`: `unique (webhook_event_id, handler)`
 * is exactly-once only if the handler name is one of a CLOSED set.
 */
export const WEBHOOK_HANDLERS = ['intent', 'invoice-settlement'] as const
export type WebhookHandlerName = (typeof WEBHOOK_HANDLERS)[number]

/** What one handler did. Both outcomes are a RUN: a handler that had nothing to do is not re-run. */
export interface WebhookHandlerOutcome {
  readonly handler: WebhookHandlerName
  readonly outcome: 'applied' | 'skipped'
  readonly detail: string
}

export type WebhookIngestOutcome =
  | {
      readonly kind: 'applied'
      readonly webhookEventId: string
      readonly handlers: readonly WebhookHandlerOutcome[]
    }
  /** The same bytes again. 200, and nothing moved. */
  | { readonly kind: 'redelivered'; readonly eventId: string }
  /** A different body under a known event id. Refused, and never applied. */
  | { readonly kind: 'event_id_reused'; readonly eventId: string }
  /** The gateway named an intent this build has never heard of. Y-PAY-05's subject. */
  | { readonly kind: 'unknown_intent'; readonly gatewayIntentId: string }
  /**
   * On file and not yet applied: the lifecycle has no cell for it YET.
   *
   * A capture delivered before the authorisation it belongs to is the case. ADR 0056's table is strict —
   * a capture on an unauthorised intent is a real defect and is refused — so the event is HELD on
   * `payment_webhook_event` and the delivery that brings its predecessor folds the whole set.
   *
   * Answered **200**, because the delivery is accepted: it is stored, it is deduplicated, and a 4xx
   * would make the gateway retry an event that is already safely on file. No `intent` handler run is
   * recorded, which is deliberate — a handler with no row for an event is one a retry comes back to.
   */
  | { readonly kind: 'held'; readonly webhookEventId: string; readonly reason: string }

/** The digest of the BYTES, computed before the body was parsed. `ZY672`'s subject. */
export function webhookPayloadDigest(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex')
}

const isKnownEventType = (value: string): value is PaymentIntentEventType =>
  (PAYMENT_INTENT_EVENTS as readonly string[]).includes(value)

/**
 * The delivery as a `PaymentIntentEvent`, with the amount rule enforced at the boundary.
 *
 * `INTENT_EVENT_CARRIES_AMOUNT` is the authority and it is read, not restated: a `captured` with no
 * amount is a capture of an unknown quantity and a `voided` with one reads as a partial void, which does
 * not exist. `reduceIntent` would throw on either; refusing here names the field instead, and the caller
 * answers a format disagreement rather than a 500.
 */
export function intentEventFrom(delivery: WebhookDelivery): PaymentIntentEvent {
  if (!isKnownEventType(delivery.eventType)) {
    throw new AppError(
      'validation',
      `A webhook delivery names event type "${delivery.eventType}", which is not one of ` +
        `${PAYMENT_INTENT_EVENTS.join(', ')}. An event this build cannot fold is refused at the ` +
        'boundary rather than stored and skipped for ever, because a stored one looks processed.',
    )
  }
  const carries = INTENT_EVENT_CARRIES_AMOUNT[delivery.eventType]
  if (carries && delivery.amountFils === undefined) {
    throw new AppError(
      'validation',
      `A "${delivery.eventType}" delivery carries no amountFils. A movement of an unknown quantity ` +
        'cannot be folded into a balance, and defaulting it to zero would make the intent read as ' +
        'settled for nothing.',
    )
  }
  if (!carries && delivery.amountFils !== undefined) {
    throw new AppError(
      'validation',
      `A "${delivery.eventType}" delivery carries an amountFils and that event moves no money. An ` +
        'authorisation is released whole; a partial void does not exist.',
    )
  }
  return {
    eventId: delivery.eventId,
    type: delivery.eventType,
    occurredAt: Date.parse(delivery.occurredAt) as Instant,
    ...(delivery.amountFils === undefined
      ? {}
      : { amount: { fils: delivery.amountFils as never, currency: 'AED' as const } }),
  }
}

export interface WebhookIngestDeps {
  readonly sql: Sql
  /** The adapter the delivery is attributed to. `payment_intent.gateway`'s own value. */
  readonly gateway: string
  /**
   * The trading hours around an instant, so a tender's business day is resolved and never assumed.
   *
   * An ASYNC factory taking the instant, rather than a ready `HoursForDate`: the instant that matters is
   * the GATEWAY's, which only exists once the verified body has been parsed, and a delivery may arrive
   * days after the capture it reports. Loading the sessions around "now" instead would resolve a late
   * delivery against the wrong three days.
   *
   * `resolveTradingDate` is pure and is the ONE place the 11:00-02:00 rule lives: a capture at 01:30
   * belongs to the previous trading date, and a second opinion about that would land a tender in a
   * cash-up for a session that had not started.
   */
  readonly hoursAround: (atMs: number) => Promise<HoursForDate>
}

/**
 * Applies one verified delivery, exactly once per handler.
 *
 * ONE transaction for the event row, every handler run and every movement, and that is load-bearing:
 * `ZY673` reads the `payment_intent_transaction` rows at COMMIT, so an event row committed separately
 * from its application would let a crash between the two leave a run claiming a movement that never
 * happened — and the run row is what stops a retry.
 *
 * Ten concurrent deliveries of one event therefore produce exactly one transition: nine of them lose the
 * race on `unique (gateway, event_id)`, their whole transaction rolls back, and they answer 200 as
 * redeliveries.
 */
export async function ingestVerifiedWebhook(
  deps: WebhookIngestDeps,
  verified: VerifiedWebhook,
): Promise<WebhookIngestOutcome> {
  const delivery = parseWebhookDelivery(verified)
  const event = intentEventFrom(delivery)
  const digest = webhookPayloadDigest(verified.body)

  const intent = await readPaymentIntentByGatewayIntentId(
    deps.sql,
    deps.gateway,
    delivery.gatewayIntentId,
  )
  if (intent === null) {
    // Quarantined rather than stored: an event row is EVIDENCE a signature verified, and this one did —
    // but nothing here can apply it, and a row with no possible handler run would read as processed. The
    // gateway knowing an intent we do not is Y-PAY-05's subject and 0106 says so in as many words.
    return { kind: 'unknown_intent', gatewayIntentId: delivery.gatewayIntentId }
  }

  try {
    return await withUnitOfWork(
      deps.sql,
      { kind: 'system', label: 'payments.webhook' },
      async (uow) => {
        const webhookEventId = await recordPaymentWebhookEvent(uow, {
          gateway: deps.gateway,
          eventId: delivery.eventId,
          eventType: delivery.eventType,
          gatewayIntentId: delivery.gatewayIntentId,
          ...(delivery.amountFils === undefined ? {} : { amountFils: delivery.amountFils }),
          payloadSha256: digest,
          occurredAtIso: new Date(event.occurredAt).toISOString(),
          signedAtIso: new Date(verified.signedAtEpochSeconds * 1000).toISOString(),
        })

        const moved = await intentHandler(uow, deps, intent.id, delivery)
        if (moved === null) {
          // HELD. The event is on file and nothing is recorded as having run, so the delivery that
          // brings its predecessor will fold it — and a retry of this one will too.
          return {
            kind: 'held',
            webhookEventId,
            reason:
              `a "${delivery.eventType}" event cannot reach this intent yet; it is on file and will be ` +
              'folded when the event it follows arrives',
          } as const
        }

        const handlers: WebhookHandlerOutcome[] = [moved]
        handlers.push(await invoiceSettlementHandler(uow, deps, intent, delivery, event))

        for (const run of handlers) {
          await recordWebhookHandlerRun(uow, {
            webhookEventId,
            handler: run.handler,
            outcome: run.outcome,
            detail: run.detail,
          })
        }
        return { kind: 'applied', webhookEventId, handlers } as const
      },
    )
  } catch (error) {
    // Replay protection: the SAME bytes again. `ZY672` fires first for a reused id over a DIFFERENT body,
    // so reaching here really does mean the delivery is identical to one already stored.
    if (isWebhookRedelivery(error)) return { kind: 'redelivered', eventId: delivery.eventId }
    if (isWebhookHandlerAlreadyRun(error)) {
      return { kind: 'redelivered', eventId: delivery.eventId }
    }
    const refusal = paymentWebhookError(error)
    if (refusal !== null && refusal.details?.['rule'] === 'eventIdReused') {
      return { kind: 'event_id_reused', eventId: delivery.eventId }
    }
    throw refusal ?? error
  }
}

/**
 * The `intent` handler: the one path that moves a `payment_intent`. `null` means the event is HELD.
 *
 * It folds every event ON FILE for the intent, not just the one that arrived, and that is what makes a
 * shuffled delivery converge. `reduceIntent` sorts by the gateway's own instant before folding, so the
 * terminal state is a function of the SET of events; `applyGatewayEvents` then writes a movement for each
 * one the stored history is missing, in that order.
 *
 * A set the lifecycle still has no cell for — a capture whose authorisation has not arrived — throws
 * `IntentTransitionRefused`, and the answer is to HOLD rather than to refuse the delivery. The
 * distinction matters: the event is genuine, signed, and the gateway will not send it again once it has a
 * 200, so discarding it loses a money movement. ADR 0056's table stays strict and the WAITING happens
 * here, which is the only arrangement in which both are true.
 *
 * An event the stored history already contains yields no new movement and is `skipped`, which is a
 * legitimate state: a redelivery whose event row was somehow absent — a restored database, a repaired
 * table — must not double-apply, and `reduceIntent`'s own dedupe plus
 * `unique (payment_intent_id, gateway_event_id)` are the two places that hold.
 */
async function intentHandler(
  uow: UnitOfWork,
  deps: WebhookIngestDeps,
  paymentIntentId: string,
  delivery: WebhookDelivery,
): Promise<WebhookHandlerOutcome | null> {
  // Read INSIDE the transaction, so the event just inserted is part of the set.
  const onFile = await readWebhookEventsForIntent(uow.sql, deps.gateway, delivery.gatewayIntentId)
  const events: PaymentIntentEvent[] = onFile.map((row) => ({
    eventId: row.eventId,
    type: row.eventType as PaymentIntentEventType,
    occurredAt: row.occurredAtMs as Instant,
    ...(row.amountFils === null ? {} : { amount: money(filsFrom(row.amountFils)) }),
  }))

  let applied: readonly { readonly gatewayEventId: string; readonly eventType: string }[]
  try {
    applied = await applyGatewayEvents(uow, paymentIntentId, events, {
      // The event id, so the movement's idempotency key names the delivery that caused it. A fresh key
      // per call would make two retries of one delivery two different claims on the gateway's side.
      idempotencyKey: `webhook:${delivery.eventId}` as IdempotencyKey,
      gatewayIntentId: delivery.gatewayIntentId as GatewayIntentId,
    })
  } catch (error) {
    if (error instanceof IntentTransitionRefused) return null
    throw error
  }

  if (applied.length === 0) {
    return {
      handler: 'intent',
      outcome: 'skipped',
      detail: `event ${delivery.eventId} was already in the intent's stored history`,
    }
  }
  return {
    handler: 'intent',
    outcome: 'applied',
    detail: `applied ${applied.map((row) => `${row.eventType}/${row.gatewayEventId}`).join(', ')}`,
  }
}

/**
 * The `invoice-settlement` handler: the ONLY way a gateway capture tenders against a document.
 *
 * Runs for a `captured` delivery and skips everything else. Skips, rather than not being registered for
 * the other event types, because a `skipped` run is the record that this handler LOOKED — and a handler
 * with no row for an event is one a retry will come back to.
 *
 * A capture whose intent reference names no document is `skipped` too, and legitimately: `payment_intent`
 * has no foreign key to `invoice` because an intent is authorised before there is a document (0106), so a
 * deposit on a booking has a capture and nothing to settle.
 */
async function invoiceSettlementHandler(
  uow: UnitOfWork,
  deps: WebhookIngestDeps,
  intent: { readonly id: string; readonly postingAccountCode: string },
  delivery: WebhookDelivery,
  event: PaymentIntentEvent,
): Promise<WebhookHandlerOutcome> {
  if (delivery.eventType !== 'captured') {
    return {
      handler: 'invoice-settlement',
      outcome: 'skipped',
      detail: `a "${delivery.eventType}" delivery settles no document`,
    }
  }
  const invoice = await findInvoiceForIntentReference(uow.sql, delivery.gatewayIntentId)
  if (invoice === null) {
    return {
      handler: 'invoice-settlement',
      outcome: 'skipped',
      detail: `intent ${delivery.gatewayIntentId} names no document to settle`,
    }
  }
  const amountFils = event.amount?.fils ?? 0
  if (amountFils <= 0 || invoice.outstandingFils <= 0) {
    return {
      handler: 'invoice-settlement',
      outcome: 'skipped',
      detail: `invoice ${invoice.invoiceId} has ${invoice.outstandingFils} fils outstanding`,
    }
  }
  // Capped at what is outstanding. `ZT001` refuses an overpayment anyway, and arriving at it from here
  // would make a capture that included a gratuity the till had already tendered a 500 rather than a
  // tender — the money moved either way, and the ledger is not the place to discover it.
  const tendered = Math.min(amountFils, invoice.outstandingFils)
  const hoursFor = await deps.hoursAround(event.occurredAt)
  const resolved = resolveTradingDate(event.occurredAt, hoursFor)
  if (resolved.kind !== 'trading') {
    throw new AppError(
      'invariant_violated',
      `A capture at ${new Date(event.occurredAt).toISOString()} falls in no trading session, so the ` +
        'tender it produces has no business day. It is REFUSED rather than attributed to the calendar ' +
        'date: a substituted date lands in a cash-up for a session that had not started, and two days ' +
        'card totals are then wrong by the same amount in opposite directions (ADR 0070).',
    )
  }
  await tenderWebhookCapture(uow, {
    invoiceId: invoice.invoiceId,
    gatewayIntentId: delivery.gatewayIntentId,
    amountFils: tendered,
    postingAccountCode: intent.postingAccountCode,
    tradingDate: resolved.date,
  })

  /*
    The entry, and there is exactly ONE per delivery because its id is derived from the event id. A
    deterministic id is not a convenience here: ten concurrent deliveries of one event all build the same
    entry, so nine of them lose on `journal_entry_pkey` even if they somehow got past the event row's own
    unique constraint — which is the acceptance line "exactly one state transition and exactly one journal
    entry, asserted by row counts" made structural rather than asserted.

    Dr the intent's clearing account, Cr 1050 Trade receivables. The money has arrived at the gateway and
    the customer no longer owes it. NOT revenue: the supply was recognised when the invoice was raised, at
    its own tax point, and crediting revenue here would recognise it twice and move part of it into
    whatever month the gateway happened to confirm. This handler runs only while the invoice still owes
    something, so the receivable it discharges is one the document's own posting created.
  */
  const entry = postEntry(
    {
      entryId: entryId(`WEBHOOK-${delivery.eventId}`),
      entryDate: localDate(resolved.date),
      narrative:
        `Card capture confirmed by webhook ${delivery.eventId} against invoice ${invoice.invoiceId}. ` +
        'The gateway, never the client, is what moves a payment.',
      source: 'payment',
      lines: [
        debit(
          intent.postingAccountCode as never,
          money(filsFrom(tendered)),
          `Gateway capture ${delivery.gatewayIntentId}`,
        ),
        credit(
          ACCOUNTS.tradeReceivables,
          money(filsFrom(tendered)),
          `Settled ${invoice.invoiceId}`,
        ),
      ],
    },
    STANDARD_SPA_CHART,
  )
  await postJournalEntry(uow, {
    entryId: entry.entryId,
    entryDate: entry.entryDate,
    narrative: entry.narrative,
    source: entry.source,
    lines: entry.lines.map((line) => ({
      accountCode: line.account,
      debitFils: line.debitFils,
      creditFils: line.creditFils,
      memo: line.memo,
    })),
  })

  return {
    handler: 'invoice-settlement',
    outcome: 'applied',
    detail: `tendered ${tendered} fils against invoice ${invoice.invoiceId}, entry ${entry.entryId}`,
  }
}

/** Which handlers have already run for a stored delivery. What a caller inspects after a 200. */
export { findPaymentWebhookEvent }

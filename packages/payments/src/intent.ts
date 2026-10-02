import type {
  GatewayIntentId,
  IdempotencyKey,
  InstrumentToken,
  PaymentGateway,
  PaymentIntentEvent,
  PaymentIntentEventType,
  PaymentIntentState,
  TenderKind,
} from '@berelax/core'
import {
  filsFrom,
  intentTransactions,
  money,
  nextIntentState,
  PAYMENT_INTENT_INITIAL_STATE,
  reduceIntent,
  storedFiguresOf,
  tenderTypeOf,
} from '@berelax/core'
import type { PaymentIntentRow, Sql, UnitOfWork } from '@berelax/db'
import {
  applyPaymentIntentMovement,
  claimPaymentIntent,
  isPaymentIntentRule,
  readPaymentIntent,
  readPaymentIntentTransactions,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import { redactCardData } from './redaction.ts'

/**
 * Where the pure lifecycle and the durable rows meet: the only place an intent is created or moved.
 *
 * `packages/core/src/payments/` is pure and `packages/db` may not import it, so neither half can do this on
 * its own — the arrangement `packages/hr/src/payroll-run.ts` records and for the same reason. What this
 * module adds beyond wiring is three orderings, and each one is an acceptance line rather than a preference.
 *
 * **The key is claimed before the gateway is called.** {@link createPaymentIntent} inserts the
 * `payment_intent` row first, and returns the stored intent untouched if the key was already held. The
 * acceptance line is *"a repeated idempotency key returns the original intent and the adapter records zero
 * additional calls, asserted against the fake's call log"*, and the adapter's own idempotency does not
 * satisfy it: the fake DOES return the first snapshot for a repeated key, and it writes a
 * `suppressedDuplicate` movement while doing so — so a replay that reached the adapter would appear on the
 * payments screen as a second authorisation. Zero calls means zero calls.
 *
 * **The state is decided by the table, never by the gateway's snapshot.** A gateway tells us what happened
 * (`PaymentIntentEvent`); which state that reaches is `nextIntentState`'s answer. Believing the snapshot's
 * `state` field instead would work for every adapter that agrees with us and silently accept an un-capture
 * from one that does not — the cell the lifecycle table has a comment about.
 *
 * **A client callback moves nothing, ever.** {@link recordClientCallback} reads the intent's stored rows,
 * looks for a gateway movement matching what the client claims, and writes an audit row either way. Its
 * return value says which happened; it issues no UPDATE at all when there is no matching movement, and 0106's
 * ZY162 is what makes that structural rather than a promise about this function. See ADR 0056.
 */

/** The outcome of asking for an intent. `replayed` is a key that had already been claimed. */
export type IntentOutcome = 'created' | 'replayed'

export interface CreatePaymentIntentRequest {
  readonly idempotencyKey: IdempotencyKey
  readonly amount: ReturnType<typeof money>
  readonly instrument: TenderKind
  /** The invoice or booking. Carried through to reconciliation; non-blank is the port's own refusal. */
  readonly reference: string
  /**
   * The gateway's own token for the card, from its hosted fields (Y-PAY-03).
   *
   * Forwarded to `gateway.authorise` and NOWHERE else: it is not stored, not audited and not put on an outbox
   * payload. Y-PAY-02 left `gatewayIntentId` and any customer-action URL out of this surface on the grounds
   * that an opaque token a browser may hold was Y-PAY-03's to define; the definition is that it travels one
   * way, through this function, into the adapter, and is never written down. A column for it would be a
   * single-use charge credential at rest with nothing that needed it there.
   */
  readonly instrumentToken?: InstrumentToken
}

export interface PaymentIntentResult {
  readonly intent: PaymentIntentRow
  readonly outcome: IntentOutcome
  /** Every movement recorded against the intent, oldest first. Empty for an intent nothing has moved. */
  readonly movements: readonly { readonly gatewayEventId: string; readonly eventType: string }[]
}

/**
 * Claims the key, authorises through the gateway, and records what the gateway said.
 *
 * On a replay the gateway is not touched: the stored intent is returned with `outcome: 'replayed'`. On a
 * first claim the gateway's events are folded by `@berelax/core` and written as movements, so the intent's
 * state and figures are the lifecycle table's answer rather than the adapter's opinion.
 *
 * `eventsSince` is read with the cursor the adapter held BEFORE the authorisation, so only this intent's own
 * events are folded. Reading from `null` would fold every intent the gateway has ever seen in this process,
 * which is not a subtle bug on a fake whose queue is shared: the first capture of another intent would be
 * applied to this one.
 */
export async function createPaymentIntent(
  uow: UnitOfWork,
  gateway: PaymentGateway,
  request: CreatePaymentIntentRequest,
): Promise<PaymentIntentResult> {
  const tender = tenderTypeOf(request.instrument)
  const claim = await claimPaymentIntent(uow.sql, {
    idempotencyKey: request.idempotencyKey,
    gateway: gateway.name,
    instrument: request.instrument,
    postingAccountCode: tender.account,
    requestedFils: request.amount.fils,
    reference: request.reference,
  })

  if (!claim.claimed) {
    // The whole of the acceptance line: return, having called nothing. `movements` is read rather than
    // assumed empty, because a replay of a key whose first call succeeded has movements and a caller
    // showing "nothing happened" would be wrong about a completed authorisation.
    const movements = await readPaymentIntentTransactions(uow.sql, claim.intent.id)
    await uow.audit.record({
      action: 'payment.intent_replayed',
      entityType: 'payment_intent',
      entityId: claim.intent.id,
      operation: 'read',
      // Y-PAY-03: the key is CALLER-SUPPLIED free text, so it goes to the sink through the redactor. Found
      // by `pnpm saq-a`'s rule 6, which refuses a payments module that writes an audit or outbox payload and
      // names no redactor — this row would otherwise have carried whatever a caller put in a key.
      after: redactCardData({ idempotencyKey: request.idempotencyKey, gateway: gateway.name }),
    })
    return {
      intent: claim.intent,
      outcome: 'replayed',
      movements: movements.map((row) => ({
        gatewayEventId: row.gatewayEventId,
        eventType: row.gatewayEventType,
      })),
    }
  }

  const before = await latestCursor(gateway)
  const snapshot = await gateway.authorise({
    amount: request.amount,
    instrument: request.instrument,
    idempotencyKey: request.idempotencyKey,
    reference: request.reference,
    // Spread rather than passed as `undefined`, because `exactOptionalPropertyTypes` is on: an explicit
    // `instrumentToken: undefined` is not the same as an absent one, and the till gateway has none to give.
    ...(request.instrumentToken === undefined ? {} : { instrumentToken: request.instrumentToken }),
  })

  const events = await eventsFor(gateway, snapshot.gatewayIntentId, before)
  const movements = await applyGatewayEvents(uow, claim.intent.id, events, {
    idempotencyKey: request.idempotencyKey,
    gatewayIntentId: snapshot.gatewayIntentId,
  })

  await uow.audit.record({
    action: 'payment.intent_authorised',
    entityType: 'payment_intent',
    entityId: claim.intent.id,
    operation: 'create',
    after: redactCardData({
      gateway: gateway.name,
      gatewayIntentId: snapshot.gatewayIntentId,
      requestedFils: request.amount.fils,
      events: events.map((event) => event.type),
    }),
  })

  const intent = await readPaymentIntent(uow.sql, claim.intent.id)
  if (intent === null) {
    throw new AppError('invariant_violated', 'the intent just written cannot be read back')
  }
  return { intent, outcome: 'created', movements }
}

/**
 * Applies a set of gateway events to a stored intent, one movement row each.
 *
 * The events are folded WITH the intent's existing rows and not on their own, which is the whole of
 * at-least-once safety here: the second delivery of a capture is dropped by `reduceIntent`'s dedupe on event
 * id, and a capture that arrives before its authorisation is reordered by the fold's sort. So the answer is a
 * function of the SET of events this intent has ever been told about, and applying the same webhook twice
 * changes nothing.
 *
 * A row whose event id is already stored is skipped rather than inserted and refused: ZY164 exists so a
 * webhook handler CAN answer 200 to a redelivery, and reaching for the refusal when we can already see the
 * row would make every redelivery a round trip that fails. The refusal is the backstop for the concurrent
 * case, which no read can close.
 */
export async function applyGatewayEvents(
  uow: UnitOfWork,
  paymentIntentId: string,
  events: readonly PaymentIntentEvent[],
  context: { readonly idempotencyKey: IdempotencyKey; readonly gatewayIntentId?: GatewayIntentId },
): Promise<readonly { readonly gatewayEventId: string; readonly eventType: string }[]> {
  const stored = await readPaymentIntentTransactions(uow.sql, paymentIntentId)
  const known = new Set(stored.map((row) => row.gatewayEventId))
  const history = stored.map(eventFromRow)

  const applied: { gatewayEventId: string; eventType: string }[] = []
  // One movement at a time, each carrying the figures the whole history adds up to AFTER it. A single
  // UPDATE at the end would leave the intermediate rows unexplained by any header, and ZY163's deferred
  // check would pass over a sequence whose middle nobody could reconstruct.
  const sofar: PaymentIntentEvent[] = [...history]
  for (const event of reduceIntent([...history, ...events]).applied) {
    if (known.has(event.eventId)) continue
    sofar.push(event)
    const rows = intentTransactions(sofar)
    const figures = storedFiguresOf(rows)
    const projection = reduceIntent(sofar)
    await applyPaymentIntentMovement(uow, {
      paymentIntentId,
      gatewayEventId: event.eventId,
      gatewayEventType: event.type,
      amountFils: event.amount?.fils ?? 0,
      occurredAt: new Date(event.occurredAt),
      idempotencyKey: context.idempotencyKey,
      state: projection.state,
      authorisedFils: figures.authorisedFils,
      capturedFils: figures.capturedFils,
      refundedFils: figures.refundedFils,
      ...(context.gatewayIntentId === undefined
        ? {}
        : { gatewayIntentId: context.gatewayIntentId }),
    })
    known.add(event.eventId)
    applied.push({ gatewayEventId: event.eventId, eventType: event.type })
  }
  return applied
}

/** A capture or a refund against an intent the gateway has already authorised. */
export interface MovePaymentIntentRequest {
  readonly paymentIntentId: string
  readonly amount: ReturnType<typeof money>
  readonly idempotencyKey: IdempotencyKey
}

export interface RefundPaymentIntentRequest extends MovePaymentIntentRequest {
  /** Stored, because a refund with no reason cannot be answered to an auditor (the port's rule). */
  readonly reason: string
}

/**
 * Captures against a stored intent, and records what the gateway said it did.
 *
 * The amount is not checked against the intent's own ceiling here. `assertCapturable` in `@berelax/core` is
 * the pre-flight check a CALLER makes before spending a round trip, and the fold's `CaptureExceedsAuthorised`
 * is what stops the gateway's answer being believed — so a check here would be a third copy of a rule whose
 * two existing homes answer different questions. The gateway refuses an over-capture itself, and if it does
 * not, the fold does.
 */
export async function capturePaymentIntent(
  uow: UnitOfWork,
  gateway: PaymentGateway,
  request: MovePaymentIntentRequest,
): Promise<PaymentIntentResult> {
  const intent = await requireIntent(uow.sql, request.paymentIntentId)
  const gatewayIntentId = requireGatewayIntentId(intent)
  const before = await latestCursor(gateway)
  await gateway.capture({
    gatewayIntentId,
    amount: request.amount,
    idempotencyKey: request.idempotencyKey,
  })
  return await recordSince(uow, gateway, intent.id, gatewayIntentId, before, request.idempotencyKey)
}

/** Refunds against a stored intent. Same shape as {@link capturePaymentIntent}, and same reasoning. */
export async function refundPaymentIntent(
  uow: UnitOfWork,
  gateway: PaymentGateway,
  request: RefundPaymentIntentRequest,
): Promise<PaymentIntentResult> {
  const intent = await requireIntent(uow.sql, request.paymentIntentId)
  const gatewayIntentId = requireGatewayIntentId(intent)
  const before = await latestCursor(gateway)
  await gateway.refund({
    gatewayIntentId,
    amount: request.amount,
    idempotencyKey: request.idempotencyKey,
    reason: request.reason,
  })
  return await recordSince(uow, gateway, intent.id, gatewayIntentId, before, request.idempotencyKey)
}

/** Releases the reservation. The one operation whose event carries no amount. */
export async function voidPaymentIntent(
  uow: UnitOfWork,
  gateway: PaymentGateway,
  request: { readonly paymentIntentId: string; readonly idempotencyKey: IdempotencyKey },
): Promise<PaymentIntentResult> {
  const intent = await requireIntent(uow.sql, request.paymentIntentId)
  const gatewayIntentId = requireGatewayIntentId(intent)
  const before = await latestCursor(gateway)
  await gateway.voidAuthorisation({ gatewayIntentId, idempotencyKey: request.idempotencyKey })
  return await recordSince(uow, gateway, intent.id, gatewayIntentId, before, request.idempotencyKey)
}

/**
 * Reads this intent's events emitted since a bookmark and records them, then returns the stored intent.
 *
 * The three operations above differ only in which gateway method they call, so everything after that call is
 * here rather than written three times: three copies of "read the events, apply them, read the intent back"
 * is how one of the three comes to forget the cursor and fold another intent's capture into this one.
 */
async function recordSince(
  uow: UnitOfWork,
  gateway: PaymentGateway,
  paymentIntentId: string,
  gatewayIntentId: GatewayIntentId,
  after: Parameters<PaymentGateway['eventsSince']>[0],
  idempotencyKey: IdempotencyKey,
): Promise<PaymentIntentResult> {
  const events = await eventsFor(gateway, gatewayIntentId, after)
  const movements = await applyGatewayEvents(uow, paymentIntentId, events, { idempotencyKey })
  const intent = await readPaymentIntent(uow.sql, paymentIntentId)
  if (intent === null) {
    throw new AppError('invariant_violated', 'the intent just moved cannot be read back')
  }
  return { intent, outcome: 'created', movements }
}

async function requireIntent(sql: Sql, id: string): Promise<PaymentIntentRow> {
  const intent = await readPaymentIntent(sql, id)
  if (intent === null) {
    throw new AppError('not_found', `No payment intent ${id}`, { details: { paymentIntentId: id } })
  }
  return intent
}

/**
 * The gateway's id, or a refusal naming what is missing.
 *
 * Null means the key was claimed and the authorisation never came back — the state Y-PAY-05 reconciles — and
 * capturing against it would send the gateway a request with no intent id in it. A refusal rather than a
 * silent skip, because "capture returned successfully and nothing was captured" is the shape of failure this
 * whole unit is built against.
 */
function requireGatewayIntentId(intent: PaymentIntentRow): GatewayIntentId {
  if (intent.gatewayIntentId === null) {
    throw new AppError(
      'conflict',
      `Payment intent ${intent.id} has no gateway intent id: its key was claimed and the authorisation ` +
        'never returned. Reconcile it against the gateway before moving it; there is nothing to capture ' +
        'against yet.',
      { details: { paymentIntentId: intent.id, state: intent.state } },
    )
  }
  return intent.gatewayIntentId as GatewayIntentId
}

/** What a browser came back saying. Not a gateway event, and deliberately not shaped like one. */
export interface ClientCallbackClaim {
  readonly paymentIntentId: string
  /** What the client says happened. A string, because it is untrusted input and not one of our enums yet. */
  readonly claimedEvent: string
  /** The gateway event id the client says proves it, if it offers one at all. */
  readonly claimedGatewayEventId?: string
}

export type ClientCallbackOutcome =
  /** A stored gateway movement matches the claim. Nothing was written; the intent was already there. */
  | 'confirmed_by_a_stored_movement'
  /** No movement matches. The intent was not touched and an audit row records the attempt. */
  | 'no_matching_gateway_transaction'

export interface ClientCallbackResult {
  readonly outcome: ClientCallbackOutcome
  /** The intent's state, before and after. Equal in both outcomes, which is the point of returning both. */
  readonly stateBefore: PaymentIntentState
  readonly stateAfter: PaymentIntentState
}

/**
 * Records a client's claim of success and refuses to act on it.
 *
 * The acceptance line: *"a client-supplied success callback with no matching gateway transaction leaves the
 * intent in its prior state and writes an audit_event"*. Both halves are here, and the important one is that
 * there is no branch in this function that issues an UPDATE — a confirmed claim writes nothing either,
 * because the movement that confirms it has ALREADY moved the intent. A browser is never the reason an intent
 * changes; it is at most a reason to look.
 *
 * `operation: 'denied'` for the unmatched case, which is one of `ALWAYS_AUDITED` in `@berelax/db`: a claim
 * that the money moved when nothing recorded it moving is the shape of a replay attack and of a genuinely
 * lost webhook, and telling those apart later needs the attempt on the trail.
 */
export async function recordClientCallback(
  uow: UnitOfWork,
  claim: ClientCallbackClaim,
): Promise<ClientCallbackResult> {
  const intent = await readPaymentIntent(uow.sql, claim.paymentIntentId)
  if (intent === null) {
    throw new AppError('not_found', `No payment intent ${claim.paymentIntentId}`, {
      details: { paymentIntentId: claim.paymentIntentId },
    })
  }
  const before = intent.state as PaymentIntentState
  const stored = await readPaymentIntentTransactions(uow.sql, claim.paymentIntentId)

  const matched = stored.find(
    (row) =>
      row.gatewayEventType === claim.claimedEvent &&
      (claim.claimedGatewayEventId === undefined ||
        row.gatewayEventId === claim.claimedGatewayEventId),
  )

  if (matched === undefined) {
    await uow.audit.record({
      action: 'payment.client_callback_unmatched',
      entityType: 'payment_intent',
      entityId: claim.paymentIntentId,
      operation: 'denied',
      before: { state: before },
      // Y-PAY-03, and this is the sharpest instance of the rule in the whole chain: `claimedEvent` and
      // `claimedGatewayEventId` are strings a BROWSER chose, on the path whose entire subject is an untrusted
      // claim, written to an append-only table. A card number pasted into either would have been permanent.
      after: redactCardData({
        claimedEvent: claim.claimedEvent,
        claimedGatewayEventId: claim.claimedGatewayEventId ?? null,
        storedMovements: stored.length,
      }),
    })
    // Read again rather than reusing `before`. The claim is that this function moves nothing, and a result
    // built from a value captured before the audit write could not tell a caller whether it had.
    const after = await readPaymentIntent(uow.sql, claim.paymentIntentId)
    return {
      outcome: 'no_matching_gateway_transaction',
      stateBefore: before,
      stateAfter: (after?.state ?? before) as PaymentIntentState,
    }
  }

  await uow.audit.record({
    action: 'payment.client_callback_confirmed',
    entityType: 'payment_intent',
    entityId: claim.paymentIntentId,
    operation: 'read',
    after: redactCardData({
      claimedEvent: claim.claimedEvent,
      gatewayEventId: matched.gatewayEventId,
    }),
  })
  return {
    outcome: 'confirmed_by_a_stored_movement',
    stateBefore: before,
    stateAfter: before,
  }
}

/**
 * The state the lifecycle table says an intent reaches from its stored state and one event.
 *
 * Exported because a caller that holds a stored state wants the answer without rebuilding the projection —
 * and because it is the one place this package converts a stored string back into the enum. A state column
 * holding something the enum does not name is impossible (`payment_intent_state_known`), so the cast is
 * checked by the database rather than asserted here.
 */
export function nextStateForStoredIntent(
  intent: PaymentIntentRow,
  event: PaymentIntentEventType,
  eventId: string,
): PaymentIntentState {
  return nextIntentState(intent.state as PaymentIntentState, event, eventId)
}

/** The stored initial state, for a caller comparing against an intent nothing has moved. */
export const STORED_INITIAL_STATE: PaymentIntentState = PAYMENT_INTENT_INITIAL_STATE

/**
 * One stored row read back as the event it recorded.
 *
 * So that {@link applyGatewayEvents} can fold the history together with the new deliveries rather than
 * trusting the header: the header is a projection, and re-deriving from the rows is what makes a capture
 * that arrives before its authorisation land in the right order however it was stored.
 */
function eventFromRow(row: {
  readonly gatewayEventId: string
  readonly gatewayEventType: string
  readonly amountFils: number
  readonly occurredAt: Date
}): PaymentIntentEvent {
  const carries = row.amountFils !== 0
  return {
    eventId: row.gatewayEventId,
    type: row.gatewayEventType as PaymentIntentEventType,
    occurredAt: row.occurredAt.getTime() as PaymentIntentEvent['occurredAt'],
    ...(carries ? { amount: money(filsFrom(row.amountFils)) } : {}),
  }
}

/**
 * The gateway's cursor as of now, before anything is asked of it.
 *
 * `eventsSince(null)` returns the whole queue, so the last delivery's cursor is the bookmark to resume after.
 * A gateway with nothing in it yet has no cursor, and `null` is the right answer for that.
 */
async function latestCursor(
  gateway: PaymentGateway,
): Promise<Parameters<PaymentGateway['eventsSince']>[0]> {
  const all = await gateway.eventsSince(null)
  return all.length === 0 ? null : (all[all.length - 1]?.cursor ?? null)
}

/**
 * This intent's events from the given cursor.
 *
 * Filtered by `gatewayIntentId`, because the cursor is the GATEWAY's bookmark and not this intent's: a second
 * intent authorised between the bookmark and this read would have its events in the same slice. Both filters
 * are needed — the cursor bounds the slice and the id selects within it — and a reader that had only the
 * cursor would apply another intent's capture to this one.
 */
async function eventsFor(
  gateway: PaymentGateway,
  gatewayIntentId: GatewayIntentId,
  after: Parameters<PaymentGateway['eventsSince']>[0],
): Promise<readonly PaymentIntentEvent[]> {
  const deliveries = await gateway.eventsSince(after)
  return deliveries
    .filter((delivery) => delivery.gatewayIntentId === gatewayIntentId)
    .map((delivery) => delivery.event)
}

export type { Sql }
/** Re-exported so a caller can branch on a redelivery without importing `@berelax/db` for one predicate. */
export { isPaymentIntentRule }

import type { Clock, IdempotencyKey, TenderKind } from '@berelax/core'
import { filsFrom, money, TENDER_KINDS, TENDER_TYPES } from '@berelax/core'
import type { Actor, Sql } from '@berelax/db'
import { paymentIntentError, withUnitOfWork } from '@berelax/db'
import type { PaymentGatewayRegistry } from '@berelax/payments'
import { createPaymentIntent, recordClientCallback } from '@berelax/payments'
import { isAppError } from '@berelax/shared'

/**
 * `POST /api/v1/payments/intent` — create an intent, or report a client callback that changes nothing.
 *
 * The logic is here and the wiring is in `route.ts`, exactly as `app/api/v1/otp` splits them, so the
 * integration suite can drive it with a frozen clock and the fake gateway instead of the real environment.
 *
 * ## Two actions on one endpoint, and why that is not a shortcut
 *
 * `action: "create"` asks for an authorisation. `action: "client_callback"` is the browser coming back from
 * the gateway saying it worked. They are one endpoint because they are one conversation about one intent, and
 * because separating them would invite the belief that the callback is a *different kind* of thing — an
 * update. It is not. The callback path issues no UPDATE at all: it looks for a stored gateway movement
 * matching the claim, writes an audit row either way, and returns the intent's state unchanged. ADR 0056 is
 * the decision and 0106's ZY162 is what makes it structural rather than a property of this file.
 *
 * So the honest reading of this endpoint is: one action asks the gateway for something, and the other asks
 * us what the gateway already told us. Neither lets the caller state an outcome.
 *
 * ## Nothing is read from the query string
 *
 * Not the actor, not a role, not a permission, not the intent id. Every field is in the POST body. That is a
 * rule across `apps/web` and the reason is narrower than tidiness here: a `?intent=…&state=captured` would
 * put a payment instruction in every access log, every `Referer` and every browser history, and a link is
 * forwardable in a way a POST body is not.
 *
 * ## Status codes
 *
 * 400 for a body this endpoint cannot read — a missing field, an amount that is not integer fils, an
 * instrument that is not a tender kind. 409 for a refusal the DATABASE made, which is a conflict about state
 * rather than a malformed request; the two are kept apart so a log can tell "the caller got the shape wrong"
 * from "the caller asked for something the ledger refuses". 200 for a created intent AND for a replayed one,
 * because a replay is the correct answer to a retry and not an error — the body says which through
 * `outcome`, which is the field a caller branches on.
 *
 * A callback with no matching movement is **200, not 4xx**. The request was well formed and the caller is
 * entitled to make it; what it claimed is simply not supported by anything we hold. Answering 4xx would make
 * a lost webhook look like a client defect, and the browser has no way to fix either. The body says
 * `moved: false` with the outcome, so nothing reads as success that was not.
 */

export interface PaymentIntentEndpointDeps {
  readonly sql: Sql
  readonly registry: PaymentGatewayRegistry
  readonly clock: Clock
}

/** Every request this endpoint answers, and no field it does not read. */
interface CreateBody {
  readonly action?: unknown
  readonly idempotencyKey?: unknown
  readonly amountFils?: unknown
  readonly instrument?: unknown
  readonly reference?: unknown
  readonly paymentIntentId?: unknown
  readonly claimedEvent?: unknown
  readonly claimedGatewayEventId?: unknown
}

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const bad = (reason: string): Response => json({ error: 'invalid_request', reason }, 400)

/**
 * The actor for a payment intent, and it is deliberately `system` rather than a person.
 *
 * Nothing on this endpoint is authenticated yet: it is reached from the checkout, which is Y-PAY-03's, and
 * inventing a staff identity here would put a plausible actor on an audit row that nobody stood behind
 * (brief rule 15). `system` is visibly unanswered, which is the right kind of wrong until Y-PAY-03 wires the
 * session through.
 */
const ACTOR: Actor = { kind: 'system', label: 'payments intent endpoint' }

const isTenderKind = (value: unknown): value is TenderKind =>
  typeof value === 'string' && (TENDER_KINDS as readonly string[]).includes(value)

export async function handlePaymentIntentRequest(
  deps: PaymentIntentEndpointDeps,
  request: Request,
): Promise<Response> {
  let body: CreateBody
  try {
    body = (await request.json()) as CreateBody
  } catch {
    return bad('the body is not JSON')
  }

  const action = body.action ?? 'create'
  if (action !== 'create' && action !== 'client_callback') {
    return bad('action must be "create" or "client_callback"')
  }

  try {
    if (action === 'client_callback') return await callback(deps, body)
    return await create(deps, body)
  } catch (error) {
    // A named database refusal is a 409: the request was readable and the ledger said no. Checked BEFORE
    // `isAppError`, because a translated refusal is an AppError too and the generic branch would report it
    // as a 400 — which would tell a caller to fix a body that is already correct.
    const refusal = paymentIntentError(error)
    if (refusal !== null) {
      return json(
        { error: 'refused', rule: refusal.details?.['rule'], reason: refusal.message },
        409,
      )
    }
    if (isAppError(error)) {
      return json(
        { error: error.kind, reason: error.message },
        error.kind === 'not_found' ? 404 : 400,
      )
    }
    throw error
  }
}

async function create(deps: PaymentIntentEndpointDeps, body: CreateBody): Promise<Response> {
  if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.trim() === '') {
    return bad('idempotencyKey is required and must be a non-empty string')
  }
  if (typeof body.reference !== 'string' || body.reference.trim() === '') {
    return bad('reference is required and must be a non-empty string')
  }
  if (!isTenderKind(body.instrument)) {
    return bad(`instrument must be one of ${TENDER_KINDS.join(', ')}`)
  }
  if (TENDER_TYPES[body.instrument].adapter !== 'gateway') {
    // Refused here as well as by ZY165, and the reason for both is the same: money taken at the desk is
    // recorded against the invoice and posted in the same transaction, so an intent beside it would post it
    // twice. 400 here because the caller can fix it; the database's refusal is the one that cannot be skipped.
    return bad(`"${body.instrument}" is taken at the till, not through a gateway`)
  }
  if (typeof body.amountFils !== 'number') return bad('amountFils must be a number of integer fils')
  let amount: ReturnType<typeof money>
  try {
    // `filsFrom` is the one place the integer rule lives (ADR 0007). A float here is a caller's mistake and
    // rounding it would move real money, so it is a 400 rather than a coercion.
    amount = money(filsFrom(body.amountFils))
  } catch {
    return bad('amountFils must be an integer number of fils, never a fraction of one')
  }
  if (amount.fils <= 0) return bad('amountFils must be greater than zero')

  const gateway = deps.registry.byInstrument(body.instrument)
  const result = await withUnitOfWork(deps.sql, ACTOR, (uow) =>
    createPaymentIntent(uow, gateway, {
      idempotencyKey: body.idempotencyKey as IdempotencyKey,
      amount,
      instrument: body.instrument as TenderKind,
      reference: body.reference as string,
    }),
  )

  // The gateway's own id is deliberately absent from the response, and `customerActionUrl` with it: an
  // opaque token for the hosted fields is Y-PAY-03's to hand back, and returning a gateway id today would
  // make one a contract before anybody had decided what a browser may hold.
  return json(
    {
      outcome: result.outcome,
      paymentIntentId: result.intent.id,
      state: result.intent.state,
      authorisedFils: result.intent.authorisedFils,
      capturedFils: result.intent.capturedFils,
      refundedFils: result.intent.refundedFils,
      movements: result.movements.length,
    },
    200,
  )
}

async function callback(deps: PaymentIntentEndpointDeps, body: CreateBody): Promise<Response> {
  if (typeof body.paymentIntentId !== 'string' || body.paymentIntentId.trim() === '') {
    return bad('paymentIntentId is required and must be a non-empty string')
  }
  if (typeof body.claimedEvent !== 'string' || body.claimedEvent.trim() === '') {
    return bad('claimedEvent is required and must be a non-empty string')
  }
  const claimedGatewayEventId =
    typeof body.claimedGatewayEventId === 'string' && body.claimedGatewayEventId.trim() !== ''
      ? body.claimedGatewayEventId
      : undefined

  const result = await withUnitOfWork(deps.sql, ACTOR, (uow) =>
    recordClientCallback(uow, {
      paymentIntentId: body.paymentIntentId as string,
      claimedEvent: body.claimedEvent as string,
      ...(claimedGatewayEventId === undefined ? {} : { claimedGatewayEventId }),
    }),
  )

  // `moved` is always false and is stated rather than omitted. A caller reading this response has just
  // asserted that money moved; the flat contradiction is the useful answer, and an absent field would let a
  // client assume the optimistic one.
  return json(
    {
      outcome: result.outcome,
      moved: false,
      stateBefore: result.stateBefore,
      stateAfter: result.stateAfter,
    },
    200,
  )
}

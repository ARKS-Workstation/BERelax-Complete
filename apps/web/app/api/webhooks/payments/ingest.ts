import type { Clock, HoursForDate } from '@berelax/core'
import { localTime } from '@berelax/core'
import { readTradingHoursAround, type Sql, withUnitOfWork } from '@berelax/db'
import {
  ingestVerifiedWebhook,
  verifyWebhookSignature,
  WebhookDeliveryMalformed,
  type WebhookRefusal,
  type WebhookSigningSecret,
} from '@berelax/payments'
import { AppError } from '@berelax/shared'

/**
 * `POST /api/webhooks/payments` — the logic, taking its dependencies as an argument.
 *
 * Y-PAY-04. Next door to the route for `app/api/whatsapp/issue.ts`'s reason: the integration suite drives
 * the same code the gateway reaches, with its own connection and a pinned clock.
 *
 * ## The order, which is the unit
 *
 * **A webhook is an unauthenticated request until its signature verifies.** So, in this order and no
 * other:
 *
 * 1. `request.text()` — the RAW bytes. Not `request.json()`: re-serialising a parsed object changes the
 *    bytes and breaks every signature, and parsing first makes the parser the attack surface.
 * 2. `verifyWebhookSignature`. Nothing has been parsed, nothing logged, nothing written, no database
 *    connection used.
 * 3. Only now: parse, deduplicate, apply.
 *
 * **No log line, audit payload or error message carries any part of an unverified body.** The audit row a
 * refusal writes names the reason, the length and the digest, and nothing else — a log aggregator is read
 * by more people than the database is, and under SAQ-A this body is the one place a misconfigured gateway
 * could put card data (ADR 0067).
 *
 * ## Why an absent secret is 503
 *
 * `PAYMENT_WEBHOOK_SIGNING_SECRET` is absent by default in every environment, because no gateway has been
 * chosen (`Y7-gateway`). The endpoint then answers 503 and writes nothing. Not 401: 401 says *your
 * signature is wrong* and the truth is *we cannot check it*, which has a different remedy — and a gateway
 * retries a 503 while a 401 makes it give up on an event that was perfectly valid, so the endpoint would
 * look healthy while losing money movements.
 *
 * There is no branch anywhere below that accepts a body without a verified signature.
 */

export interface WebhookRouteDeps {
  readonly sql: Sql
  readonly clock: Clock
  readonly secret: WebhookSigningSecret
  /** The adapter deliveries are attributed to. `payment_intent.gateway`'s own value. */
  readonly gateway: string
}

/** Every answer this endpoint gives, as data. A status with no name is a status nobody can grep for. */
export const WEBHOOK_OUTCOME_HEADER = 'x-berelax-webhook-outcome'

const refusalAudit: Readonly<Record<WebhookRefusal, string>> = Object.freeze({
  secret_not_configured: 'payment.webhook-not-configured',
  signature_absent: 'payment.webhook-signature-absent',
  signature_malformed: 'payment.webhook-signature-malformed',
  signature_invalid: 'payment.webhook-signature-invalid',
  timestamp_outside_tolerance: 'payment.webhook-replay',
})

/**
 * The trading sessions around an instant, as `resolveTradingDate` wants them.
 *
 * Built from the GATEWAY's instant rather than from ours, because a delivery may arrive days after the
 * capture it reports and the sessions around "now" would be the wrong three days. The hours themselves
 * are deliberately not written down here: they are `business_day` rows, and
 * `nap-hours-literal-outside-the-seed` refuses the literal anywhere under `apps/web`.
 */
const hoursAround =
  (sql: Sql) =>
  async (atMs: number): Promise<HoursForDate> => {
    const rows = await readTradingHoursAround(sql, atMs)
    return (date) => {
      const row = rows.find((entry) => entry.tradingDate === date)
      return row === undefined
        ? undefined
        : { open: localTime(row.open), close: localTime(row.close) }
    }
  }

const answer = (status: number, outcome: string): Response =>
  new Response(JSON.stringify({ outcome }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      [WEBHOOK_OUTCOME_HEADER]: outcome,
    },
  })

export async function handlePaymentWebhookRequest(
  deps: WebhookRouteDeps,
  request: Request,
): Promise<Response> {
  // The RAW bytes, first. `request.json()` here would be the defect: the signature covers what arrived.
  const rawBody = await request.text()

  const verification = verifyWebhookSignature({
    rawBody,
    headers: request.headers,
    secret: deps.secret,
    now: deps.clock.now(),
  })

  if (verification.kind === 'refused') {
    /*
      The audit row, and the acceptance line: absent, malformed and wrong-key each return 401, change no
      state and write an audit_event. `operation: 'denied'` for all of them — a claim that a payment moved,
      presented without a signature we accept, is the shape of a replay attack and of a genuinely
      misconfigured gateway, and telling those apart later needs the attempt on the trail.

      The payload carries the reason, the body's LENGTH and nothing from the body itself. Not even a
      prefix: a prefix of an unverified body is still the unverified body, in a table every operator can
      read.
    */
    await withUnitOfWork(deps.sql, { kind: 'system', label: 'payments.webhook' }, async (uow) => {
      await uow.audit.record({
        action: refusalAudit[verification.reason],
        entityType: 'payment_webhook_event',
        operation: 'denied',
        after: {
          reason: verification.reason,
          bodyBytes: rawBody.length,
          ...(verification.missing.length === 0 ? {} : { missing: verification.missing }),
        },
      })
    })
    return answer(verification.status, verification.reason)
  }

  try {
    const outcome = await ingestVerifiedWebhook(
      { sql: deps.sql, gateway: deps.gateway, hoursAround: hoursAround(deps.sql) },
      verification,
    )
    switch (outcome.kind) {
      case 'applied':
        return answer(200, 'applied')
      // 200, not 409. A gateway that gets a 4xx for a redelivery escalates an incident about an event it
      // processed correctly, and retries it harder.
      case 'redelivered':
        return answer(200, 'redelivered')
      // 200. The delivery is ACCEPTED — stored, deduplicated and on file — and its application waits for
      // the event it follows. A 4xx would make the gateway retry something already safely recorded, and
      // worse, a 4xx it gave up on would lose the movement entirely.
      case 'held':
        return answer(200, 'held')
      // 409. A different body under a known event id is a conflict the caller has to resolve, and it is
      // never applied.
      case 'event_id_reused':
        return answer(409, 'event_id_reused')
      // 202. The signature verified, so the delivery is OURS — but the intent it names is one this build
      // has never recorded, which is Y-PAY-05's subject. Accepted-and-not-acted-on rather than 404,
      // because a 404 tells a gateway to stop retrying a delivery that reconciliation will need.
      case 'unknown_intent':
        return answer(202, 'unknown_intent')
    }
  } catch (error) {
    if (error instanceof WebhookDeliveryMalformed) {
      // 422 and not 401: this body's signature VERIFIED, so it came from the holder of the signing
      // secret. That makes it a format disagreement with the gateway, and a 401 would send whoever is
      // debugging it to look at the secret.
      return answer(422, 'delivery_malformed')
    }
    if (error instanceof AppError && error.kind === 'validation')
      return answer(422, 'delivery_malformed')
    throw error
  }
}

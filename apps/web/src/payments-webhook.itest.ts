import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection, type Sql } from '@berelax/db'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import {
  signWebhookPayload,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Y-PAY-04 — what the application ANSWERS to a webhook delivery.
 *
 * The verification is proved without a server by `packages/payments/src/webhook/verify.test.ts` and the
 * durable half by `packages/fixtures/src/payment-webhook.itest.ts`. Four claims can only be made against
 * a response the route served, and all four are acceptance lines:
 *
 *   1. **Absent, malformed and wrong-key each answer 401, change no state and write an `audit_event`** —
 *      a status a handler test asserts about a `Response` it built itself is a status nobody has served.
 *   2. **An absent signing secret answers 503, not 401**, and that is a different fact with a different
 *      remedy: a gateway retries a 503 and gives up on a 401.
 *   3. **The route reads the RAW bytes.** This suite signs bytes and POSTs them; a route that called
 *      `request.json()` and re-serialised would fail every signature, and nothing short of a real
 *      request can show that.
 *   4. **`GET` is 405.** There is no verification-challenge handler, and an unexported method is the only
 *      way to be sure none exists.
 *
 * ## Why no signing secret is configured, and what that means for this file
 *
 * `PAYMENT_WEBHOOK_SIGNING_SECRET` is absent in every environment, because no gateway has been chosen
 * (OPEN-QUESTIONS `Y7-gateway`). So `startWebServer` is given one in the CHILD's environment — this
 * suite's own string, which is not a credential and matches nothing anywhere — and the 503 case is proved
 * against a SECOND server started without it. Two servers and two ports from the same band, sequentially,
 * because the absence is the one state that cannot be reached by sending a different request.
 *
 * ## Isolation (brief rule 12)
 *
 * Every assertion here is about a STATUS or an `audit_event` DELTA. `audit_event` is append-only and
 * partitioned (ADR 0008), so the counts are deltas measured around each request and never totals, and no
 * row is deleted.
 */

const APP_DIR = new URL('..', import.meta.url).pathname
const PATH = '/api/webhooks/payments'
/** This suite's own string. Not a credential: nothing anywhere is configured with it. */
const SECRET = 'y-pay-04-webserver-suite-secret-not-a-credential'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let signed: WebServer
let unconfigured: WebServer
let sql: Sql

const body = JSON.stringify({
  eventId: 'ypay04-webserver-probe',
  eventType: 'captured',
  gatewayIntentId: 'ypay04-no-such-intent',
  occurredAt: '2099-12-20T15:00:00.000Z',
  amountFils: 1_000,
})

const post = async (
  origin: string,
  init: { readonly headers?: Record<string, string>; readonly body?: string } = {},
): Promise<Response> =>
  await fetch(`${origin}${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body ?? body,
  })

const signedHeaders = (
  payload: string,
  secret = SECRET,
  atSeconds = Math.floor(Date.now() / 1000),
): Record<string, string> => ({
  [WEBHOOK_TIMESTAMP_HEADER]: String(atSeconds),
  [WEBHOOK_SIGNATURE_HEADER]: signWebhookPayload(secret, String(atSeconds), payload),
})

const auditCount = async (action: string): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  if (!existsSync(join(APP_DIR, '.next', 'BUILD_ID'))) {
    throw new Error(
      'apps/web has no build. `next start` serves whatever `.next` was last built, so a route added on ' +
        'a branch is a 404 in a tree nobody built — and the symptom names neither the branch nor the ' +
        'build (brief rule 17). Run `pnpm --filter @berelax/web build` first.',
    )
  }
  sql = createConnection({ url: url as string, max: 2 })
  signed = await startWebServer({
    suite: 'payments-webhook',
    cwd: APP_DIR,
    probePath: '/',
    readyWithinMs: 60_000,
    env: { PAYMENT_WEBHOOK_SIGNING_SECRET: SECRET },
  })
  // A second server with the variable ABSENT. The only way to reach `secret_not_configured`: it is not a
  // request anybody can send, it is a deployment somebody forgot to configure.
  unconfigured = await startWebServer({
    suite: 'payments-webhook',
    cwd: APP_DIR,
    probePath: '/',
    readyWithinMs: 60_000,
    env: { PAYMENT_WEBHOOK_SIGNING_SECRET: '' },
  })
}, 180_000)

afterAll(async () => {
  await signed?.stop()
  await unconfigured?.stop()
  await sql?.end()
})

describe('an unauthenticated delivery', () => {
  it('answers 401 with no signature at all, and writes an audit_event', async () => {
    const before = await auditCount('payment.webhook-signature-absent')
    const response = await post(signed.origin)
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ outcome: 'signature_absent' })
    // A DELTA, because `audit_event` is append-only and other suites write into it (brief rule 9).
    expect(await auditCount('payment.webhook-signature-absent')).toBe(before + 1)
  })

  it('answers 401 for a malformed signature, and writes its own audit_event', async () => {
    const before = await auditCount('payment.webhook-signature-malformed')
    const response = await post(signed.origin, {
      headers: {
        [WEBHOOK_SIGNATURE_HEADER]: 'not-a-digest',
        [WEBHOOK_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
      },
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ outcome: 'signature_malformed' })
    expect(await auditCount('payment.webhook-signature-malformed')).toBe(before + 1)
  })

  it('answers 401 for a wrong-key signature, and writes its own audit_event', async () => {
    const before = await auditCount('payment.webhook-signature-invalid')
    const response = await post(signed.origin, {
      headers: signedHeaders(body, 'a-completely-different-secret'),
    })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ outcome: 'signature_invalid' })
    expect(await auditCount('payment.webhook-signature-invalid')).toBe(before + 1)
  })

  it('answers 401 for a correctly signed delivery outside the tolerance, as a replay', async () => {
    const before = await auditCount('payment.webhook-replay')
    const stale = Math.floor(Date.now() / 1000) - WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS - 60
    const response = await post(signed.origin, { headers: signedHeaders(body, SECRET, stale) })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ outcome: 'timestamp_outside_tolerance' })
    expect(await auditCount('payment.webhook-replay')).toBe(before + 1)
  })

  it('writes NO webhook event row for any of them', async () => {
    // The acceptance line's "change no state". An unauthenticated request must not be able to fill a
    // table, so the refusals are audit rows and nothing else — and a row in this table is, by
    // construction, evidence that a signature verified.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_webhook_event
       where event_id = 'ypay04-webserver-probe'
    `
    expect(row?.n).toBe('0')
  })
})

describe('a correctly signed delivery', () => {
  it('is ACCEPTED, which is the control for every refusal above', async () => {
    const response = await post(signed.origin, { headers: signedHeaders(body) })
    // 202: the signature verified, so the delivery is ours — and it names an intent this build has never
    // recorded, which is Y-PAY-05's subject. Not 401, and not 404: a 404 would tell the gateway to stop
    // retrying a delivery reconciliation will need.
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ outcome: 'unknown_intent' })
  })

  it('is read as RAW BYTES, so a re-serialising route would fail the signature', async () => {
    // The same delivery with its keys in another order and extra whitespace. The signature covers these
    // bytes; a route that parsed and re-serialised would compute a different payload and answer 401.
    const reordered = `{  "amountFils": 1000,\n "eventType": "captured", "eventId": "ypay04-webserver-bytes",\n  "gatewayIntentId": "ypay04-no-such-intent", "occurredAt": "2099-12-20T15:00:00.000Z" }`
    const response = await post(signed.origin, {
      headers: signedHeaders(reordered),
      body: reordered,
    })
    expect(response.status).toBe(202)
  })

  it('answers 422 for a verified body this build cannot read, not 401', async () => {
    // The signature VERIFIED, so this came from the holder of the secret: a format disagreement with the
    // gateway, not an untrusted request. A 401 would send whoever is debugging it to look at the secret.
    const malformed = '{"eventId":"ypay04-webserver-bad","eventType":"captured"}'
    const response = await post(signed.origin, {
      headers: signedHeaders(malformed),
      body: malformed,
    })
    expect(response.status).toBe(422)
  })
})

describe('the deployment with no signing secret', () => {
  it('answers 503 and not 401, even to a correctly signed delivery', async () => {
    const before = await auditCount('payment.webhook-not-configured')
    const response = await post(unconfigured.origin, { headers: signedHeaders(body) })
    // 503, because the truth is "we cannot check it" rather than "your signature is wrong" — and a
    // gateway retries a 503 while a 401 makes it give up on an event that was perfectly valid.
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ outcome: 'secret_not_configured' })
    expect(await auditCount('payment.webhook-not-configured')).toBe(before + 1)
    // There is no fall-back: the same delivery the configured server accepts is refused here.
    const accepted = await post(signed.origin, { headers: signedHeaders(body) })
    expect(accepted.status).not.toBe(503)
  })
})

describe('the method surface', () => {
  it('answers 405 to GET, because there is no verification-challenge handler', async () => {
    const response = await fetch(`${signed.origin}${PATH}`)
    expect(response.status).toBe(405)
  })
})

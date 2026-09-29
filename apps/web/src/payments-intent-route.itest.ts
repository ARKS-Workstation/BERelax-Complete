import { parseConfig } from '@berelax/config'
import { fixedClock } from '@berelax/core'
import type { Sql } from '@berelax/db'
import { createConnection, readPaymentIntent } from '@berelax/db'
import { createPaymentGateways } from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handlePaymentIntentRequest,
  type PaymentIntentEndpointDeps,
} from '../app/api/v1/payments/intent/handler.ts'

/**
 * Y-PAY-02 — `POST /api/v1/payments/intent`, driven against a real PostgreSQL and the H02 card fake.
 *
 * The handler is called directly rather than over HTTP, which is `otp-route.itest.ts`'s arrangement and here
 * for a plainer reason than its: nothing in this file is a claim about a response header, a redirect or a
 * rendered page, so a `next start` in front of it would add a build, a port and a server to prove nothing
 * extra. `route.ts` beside the handler does the wiring and is four statements; what is worth asserting is
 * what the endpoint DECIDES.
 *
 * ## What this file adds over `packages/fixtures/src/payment-intent.itest.ts`
 *
 * That suite drives the service and the database. This one drives the boundary: the status codes, the
 * refusals a malformed body gets, and the one property the endpoint exists to have — **a caller cannot state
 * an outcome.** The service-level suite proves the client-callback path writes no movement; this proves the
 * HTTP surface offers no other way in, including the `create` action with a `state` field bolted on.
 *
 * Nothing is removed here either: `payment_intent` rows cannot be deleted (ZY161 pins them through their
 * movements), so every assertion is scoped to intents this run created and every key carries a run token.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const CLOCK_ISO = '2026-09-28T19:45:00.000Z'
const RUN = `ypay02-route-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

let deps: PaymentIntentEndpointDeps
let sql: Sql

beforeAll(() => {
  sql = createConnection({ url: url as string, max: 4 })
  const clock = fixedClock(CLOCK_ISO)
  deps = {
    sql,
    clock,
    registry: createPaymentGateways({
      config: parseConfig({ APP_ENV: 'test', DATABASE_URL: url as string }),
      clock,
    }),
  }
})

afterAll(async () => {
  await sql.end()
})

const post = async (body: unknown): Promise<Response> =>
  await handlePaymentIntentRequest(
    deps,
    new Request('http://127.0.0.1/api/v1/payments/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

const created = async (name: string, amountFils = 20_000) =>
  await post({
    action: 'create',
    idempotencyKey: `${RUN}-${name}`,
    amountFils,
    instrument: 'card_online',
    reference: `${RUN}/INV-${name}`,
  })

describe('POST /api/v1/payments/intent — creating an intent', () => {
  it('authorises and answers 200 with the outcome and the figures', async () => {
    const response = await created('ok', 41_000)
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['outcome']).toBe('created')
    expect(body['state']).toBe('authorised')
    expect(body['authorisedFils']).toBe(41_000)
    expect(typeof body['paymentIntentId']).toBe('string')
    // The gateway's own id is deliberately absent: an opaque token a browser may hold is Y-PAY-03's to
    // define, and returning one today would make it a contract before anybody decided what it may contain.
    expect(body).not.toHaveProperty('gatewayIntentId')
  })

  it('answers 200 and "replayed" for a repeated key, not an error', async () => {
    const first = (await (await created('replay')).json()) as Record<string, unknown>
    const again = await created('replay')
    expect(
      again.status,
      'a retry is the correct use of an idempotency key, not a client defect',
    ).toBe(200)
    const body = (await again.json()) as Record<string, unknown>
    expect(body['outcome']).toBe('replayed')
    expect(body['paymentIntentId']).toBe(first['paymentIntentId'])
  })

  it('refuses a float amount with 400 rather than rounding it', async () => {
    // ADR 0007. Rounding here would move real money, and the caller can fix a body.
    const response = await post({
      action: 'create',
      idempotencyKey: `${RUN}-float`,
      amountFils: 1_000.5,
      instrument: 'card_online',
      reference: `${RUN}/INV-float`,
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { reason: string }).reason).toContain('integer')
  })

  it('refuses a till tender kind with 400, because that money is posted at the desk', async () => {
    const response = await post({
      action: 'create',
      idempotencyKey: `${RUN}-cash`,
      amountFils: 1_000,
      instrument: 'cash',
      reference: `${RUN}/INV-cash`,
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { reason: string }).reason).toContain('till')
  })

  it('refuses a blank reference, a missing key and a body that is not JSON', async () => {
    // Each of the three separately, because one assertion over a shared 400 would pass for a handler that
    // rejected everything — which the control below is what rules out.
    expect(
      (
        await post({
          action: 'create',
          idempotencyKey: `${RUN}-blank`,
          amountFils: 100,
          instrument: 'card_online',
          reference: '   ',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await post({
          action: 'create',
          amountFils: 100,
          instrument: 'card_online',
          reference: `${RUN}/x`,
        })
      ).status,
    ).toBe(400)
    const notJson = await handlePaymentIntentRequest(
      deps,
      new Request('http://127.0.0.1/api/v1/payments/intent', { method: 'POST', body: 'not json' }),
    )
    expect(notJson.status).toBe(400)
  })

  it('the control: a well-formed body is accepted, so the 400s above are about the body', async () => {
    expect((await created('control')).status).toBe(200)
  })
})

describe('POST /api/v1/payments/intent — a client callback states nothing', () => {
  it('answers 200 with moved:false and leaves the intent where it was', async () => {
    const intent = (await (await created('callback')).json()) as Record<string, unknown>
    const id = intent['paymentIntentId'] as string

    const response = await post({
      action: 'client_callback',
      paymentIntentId: id,
      claimedEvent: 'captured',
      claimedGatewayEventId: 'evt_the_browser_made_this_up',
    })

    // 200 and not 4xx: the request was well formed and the caller is entitled to make it. A 4xx would make
    // a lost webhook look like a client defect, and the browser cannot fix either.
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['outcome']).toBe('no_matching_gateway_transaction')
    expect(body['moved']).toBe(false)
    expect(body['stateBefore']).toBe('authorised')
    expect(body['stateAfter']).toBe('authorised')

    // The row itself, not the response. A handler that reported the prior state while having moved the
    // intent would satisfy every assertion above.
    const stored = await readPaymentIntent(sql, id)
    expect(stored?.state).toBe('authorised')
    expect(stored?.capturedFils).toBe(0)
  })

  it('ignores a state the caller bolts onto a create, because there is no field to put it in', async () => {
    // The endpoint offers no way to state an outcome, so an extra field is not refused — it is simply not
    // read. Asserted rather than assumed: a handler that spread the body into the row would accept this, and
    // it would be a caller choosing its own state.
    const response = await post({
      action: 'create',
      idempotencyKey: `${RUN}-injected`,
      amountFils: 7_000,
      instrument: 'card_online',
      reference: `${RUN}/INV-injected`,
      state: 'captured',
      capturedFils: 7_000,
      authorisedFils: 999_999,
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['state']).toBe('authorised')
    expect(body['capturedFils']).toBe(0)
    expect(body['authorisedFils']).toBe(7_000)
  })

  it('answers 404 for an intent that does not exist, and 400 for a callback with no id', async () => {
    const missing = await post({
      action: 'client_callback',
      paymentIntentId: '00000000-0000-7000-8000-000000000000',
      claimedEvent: 'captured',
    })
    expect(missing.status).toBe(404)
    expect((await post({ action: 'client_callback', claimedEvent: 'captured' })).status).toBe(400)
  })

  it('refuses an unknown action with 400', async () => {
    expect((await post({ action: 'capture_it_please' })).status).toBe(400)
  })
})

describe('the endpoint reads nothing from the query string', () => {
  it('ignores every field offered in the URL, including an actor and a state', async () => {
    // A rule across `apps/web`: no module takes a principal, a role or a permission from the query string.
    // Here it is wider — nothing at all is read from the URL — because a payment instruction in a link is in
    // every access log, every `Referer` and every browser history, and a link is forwardable in a way a POST
    // body is not. The request below carries a complete, valid instruction in its query string and an empty
    // object as its body, and it must be a 400 about the BODY.
    const response = await handlePaymentIntentRequest(
      deps,
      new Request(
        'http://127.0.0.1/api/v1/payments/intent?action=create&idempotencyKey=' +
          `${RUN}-qs&amountFils=5000&instrument=card_online&reference=x&actor=owner&role=admin` +
          '&permission=payments:write&state=captured',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      ),
    )
    expect(response.status).toBe(400)
    // And no intent was created under that key, which is the assertion that would fail if the handler read
    // the URL as a fallback.
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from payment_intent where idempotency_key = ${`${RUN}-qs`}
    `
    expect(row?.n).toBe(0)
  })

  it('will not take the intent id for a callback from the URL, which is where a gateway puts it', async () => {
    // The sharpest version of the rule, because this is the mutation somebody actually writes: a gateway's
    // return URL is built by the gateway, so `?paymentIntentId=…` is exactly what the browser comes back
    // holding, and threading it into the callback looks like plumbing rather than a decision. It would make
    // the endpoint's subject — that a browser's word moves nothing — reachable by anybody who can get a
    // click, and it would put a payment identifier in every access log and `Referer`.
    const intent = (await (await created('qs-callback')).json()) as Record<string, unknown>
    const id = intent['paymentIntentId'] as string

    const response = await handlePaymentIntentRequest(
      deps,
      new Request(`http://127.0.0.1/api/v1/payments/intent?paymentIntentId=${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The id is ONLY in the URL. The body is a complete callback apart from it.
        body: JSON.stringify({ action: 'client_callback', claimedEvent: 'captured' }),
      }),
    )
    expect(response.status).toBe(400)
    expect(((await response.json()) as { reason: string }).reason).toContain('paymentIntentId')

    // And nothing was recorded against that intent, which is what would change if the id were read: the
    // callback would run, find no matching movement and write a `denied` audit row for an intent the caller
    // never named in its body.
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event
       where action = 'payment.client_callback_unmatched' and entity_id = ${id}
    `
    expect(row?.n).toBe(0)
  })
})

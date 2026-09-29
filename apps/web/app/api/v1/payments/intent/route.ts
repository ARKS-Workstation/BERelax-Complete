import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { createPaymentGateways } from '@berelax/payments'
import { handlePaymentIntentRequest, type PaymentIntentEndpointDeps } from './handler.ts'

/**
 * `POST /api/v1/payments/intent` — the wiring, and nothing else.
 *
 * The handler is next door and takes its dependencies as an argument, so
 * `packages/fixtures/src/payment-intent.itest.ts` drives the same code with a frozen clock and the fake
 * gateway. This file builds those dependencies from the real environment once.
 *
 * Under `/api/v1` and outside both locale groups, for the three reasons the endpoints beside it record:
 * `/api` is exempt from `proxy.ts` canonicalisation so a mistyped trailing slash is a 308 rather than a 301
 * that would downgrade this POST to a GET with the body dropped; a payment is not a document, so a locale
 * would give one endpoint two URLs; and an endpoint under `/api` is somewhere a `curl` naturally goes.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `next build` imports every route module to collect
 * its exports, so building the connection at module scope fails the build on any machine without a database —
 * including CI. A memoised getter moves the failure to the first request, which is where a missing secret
 * should surface.
 *
 * ## The registry is built here and nowhere else in this app
 *
 * `createPaymentGateways` is the only place `PAYMENT_PROVIDER` is read (ADR 0055), and it refuses at
 * construction when the value is `real` — so a production deploy with no gateway chosen fails on the first
 * request to this route rather than taking no money and answering 200.
 */
export const dynamic = 'force-dynamic'

let runtime: PaymentIntentEndpointDeps | undefined

function paymentsRuntime(): PaymentIntentEndpointDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a hard
  // connection ceiling (ADR 0004). One authorisation is a claim, a movement and an audit row.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  // Built here because `@berelax/core` cannot ship one: reading the clock is exactly what the purity gate
  // forbids there, so the edge supplies it and every instant an adapter stamps comes from this.
  const clock: Clock = { now: () => Date.now() as Instant }
  runtime = { sql, clock, registry: createPaymentGateways({ config, clock }) }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  return await handlePaymentIntentRequest(paymentsRuntime(), request)
}

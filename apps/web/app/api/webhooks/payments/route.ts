import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { webhookSigningSecretFrom } from '@berelax/payments'
import { handlePaymentWebhookRequest, type WebhookRouteDeps } from './ingest.ts'

/**
 * `POST /api/webhooks/payments` — the wiring, and nothing else.
 *
 * Y-PAY-04. The ingest path is next door and takes its dependencies as an argument, so the integration
 * suite drives the same code with a pinned clock and its own connection — `app/api/whatsapp/route.ts`'s
 * arrangement, for its reason.
 *
 * Under `/api` and outside both locale groups: `/api` is exempt from `proxy.ts` canonicalisation, and a
 * webhook is not a document, so a locale prefix would give one endpoint two URLs and the gateway's
 * configured one would be whichever was typed into its dashboard.
 *
 * **POST only.** There is deliberately no `GET`, and no verification-challenge handler: every gateway
 * that wants one wants a different one, none has been chosen (OPEN-QUESTIONS `Y7-gateway`), and a GET
 * that echoed a query parameter back is the shape of an open redirect and of a reflected-content probe.
 * An unexported method answers 405 from Next's own router, which is the right answer.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `next build` imports every route module to
 * collect its exports, so building the connection at module scope fails the build on any machine without
 * a database — including CI. A memoised getter moves the failure to the first request, which is where a
 * missing secret should surface.
 *
 * The signing secret is read ONCE, here, and an absent one is a first-class state the ingest answers 503
 * to. It is never read again inside the request, so a rotation takes effect on the next deploy rather
 * than halfway through a delivery.
 */
export const dynamic = 'force-dynamic'

let runtime: WebhookRouteDeps | undefined

function webhookRuntime(): WebhookRouteDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a hard
  // connection ceiling (ADR 0004). One delivery is a handful of statements in one short transaction.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  // Built here because `@berelax/core` cannot ship one: reading the clock is exactly what the purity gate
  // forbids there, so the edge supplies it and the timestamp tolerance is judged against this.
  const clock: Clock = { now: () => Date.now() as Instant }
  runtime = {
    sql,
    clock,
    secret: webhookSigningSecretFrom(config),
    // The adapter name `payment_intent.gateway` already holds. No provider has been chosen, so this is
    // the fake's own name rather than a vendor's, and it is deliberately not configurable: a delivery
    // attributed to a gateway nobody registered intents under would match no intent at all.
    gateway: 'gateway-not-chosen',
  }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  return await handlePaymentWebhookRequest(webhookRuntime(), request)
}

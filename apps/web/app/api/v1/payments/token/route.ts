import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createPaymentGateways, type PaymentGatewayRegistry } from '@berelax/payments'
import { guardAdminRoute } from '../../../../../src/session.ts'
import { handlePaymentTokenRequest } from './handler.ts'

/**
 * `POST /api/v1/payments/token` — the wiring, and nothing else (Y-PAY-03).
 *
 * The handler is next door and takes its dependencies as an argument, so `apps/web/src/checkout.itest.ts`
 * drives the same code with the fake gateway and a real database. This file builds those dependencies once and
 * resolves the session.
 *
 * ## Why it is `/api/v1/payments/token` and not `/api/payments/token`
 *
 * The manifest names the second. Every other endpoint in this application is under `/api/v1` and each one's
 * registry entry argues the same three reasons for it, which Y-PAY-02 restated when it moved the intent
 * endpoint for exactly this reason: `/api` is exempt from `proxy.ts` canonicalisation so a mistyped trailing
 * slash is a 308 rather than a 301 that would downgrade this POST to a GET with the body dropped; a payment is
 * not a document, so a locale would give one endpoint two URLs; and an endpoint under `/api` is somewhere a
 * `curl` naturally goes. An endpoint outside the prefix would leave the public API surface half-versioned. The
 * manifest carries a NOTE saying so.
 *
 * ## It is authenticated, unlike the intent endpoint beside it
 *
 * `guardAdminRoute` is the first statement, and the actor on every audit row is the signed-in member of
 * staff — which is the deferral Y-PAY-02 handed this unit. The refusal an unauthenticated request gets is the
 * admin 303 to the sign-in screen rather than a 401, which reads oddly for a JSON endpoint and is the right
 * answer anyway: the only caller is the gateway's script running on `/checkout`, which is itself behind the
 * session, so a request here with no cookie is a browser whose session expired mid-payment and the place it
 * needs to go is the sign-in screen. A 401 would need a client that knows what to do with one, and there is
 * none.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent and `next build` imports every route module to collect
 * its exports, so building the connection at module scope fails the build on any machine without a database —
 * including CI. A memoised getter moves the failure to the first request, which is where a missing secret
 * should surface. The intent endpoint beside this one records the same reasoning.
 */
export const dynamic = 'force-dynamic'

let runtime: { readonly sql: Sql; readonly registry: PaymentGatewayRegistry } | undefined

function paymentsRuntime(): { readonly sql: Sql; readonly registry: PaymentGatewayRegistry } {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a hard
  // connection ceiling (ADR 0004). One authorisation is a claim, a movement and an audit row.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  const clock: Clock = { now: () => Date.now() as Instant }
  runtime = { sql, registry: createPaymentGateways({ config, clock }) }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const { sql, registry } = paymentsRuntime()
  return await handlePaymentTokenRequest(
    {
      sql,
      registry,
      // `staffReference` and not a display name: ADR 0020's rule is that the employment record's internal
      // handle is the audit label, because therapists have no display name until an admin sets one.
      actor: {
        kind: 'staff',
        id: authorised.principal.employeeId,
        label: authorised.principal.staffReference,
      },
    },
    request,
  )
}

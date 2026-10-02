import { randomUUID } from 'node:crypto'
import { loadConfig } from '@berelax/config'
import type { Clock, Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { createPaymentGateways, hostedFieldsFrom } from '@berelax/payments'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { type AdminPrincipal, guardAdminRoute } from '../../../src/session.ts'
import {
  type CheckoutReadInput,
  checkoutHeaders,
  handleCheckoutRead,
  handleCheckoutWrite,
} from './handler.ts'

/**
 * `GET`/`POST /checkout` — the Next binding for the SAQ-A card checkout (Y-PAY-03).
 *
 * Everything decidable is in `./handler.ts` and `@berelax/payments`; this file is the session, the connection,
 * the registry, the clock and the two verbs. The split the till, the diary, the pipeline board and the review
 * paste form all take.
 *
 * ## This is where the intent path becomes authenticated
 *
 * Y-PAY-02's NOTE deferred authentication to this unit: *"the intent route's audit actor is `system` ... the
 * checkout is Y-PAY-03's and inventing a staff identity would put a plausible actor on an audit row nobody
 * stood behind"*. `guardAdminRoute` is the first statement of both verbs, and the actor on every audit row this
 * screen writes is the signed-in member of staff's `employeeId` with their `staffReference` as the label — an
 * audit handle that names no person (ADR 0020). A card taken at the front desk is now attributable to whoever
 * took it, which is the whole reason the deferral existed.
 *
 * `/api/v1/payments/intent` still audits as `system`, and that is deliberately NOT changed here: it is
 * Y-PAY-02's endpoint with Y-PAY-02's tests, this unit's acceptance list says nothing about it, and the brief
 * forbids repairing another unit's file beyond what this one needs. The manifest carries the re-deferral.
 */
export const dynamic = 'force-dynamic'

/**
 * A connection per request, closed in a `finally`.
 *
 * `max: 2` for the reason the till, the diary, the pipeline board and the paste form all give: this is a page
 * load plus one authorisation, not a pass over the book, and the integration suite opens a 64-connection pool
 * of its own to prove a row lock — a route holding a large pool would make `sorry, too many clients already` a
 * property of somebody else's test run.
 */
async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * The refusal for a checkout that cannot be rendered at all.
 *
 * 503 and `text/plain`, and deliberately NOT a document: every file under `app/(admin)` that emits a doctype
 * has to render the Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks the tree to say
 * so, and a one-sentence refusal for a database nobody can reach is not a page. The message goes through
 * nothing that could carry a submission: this branch is reached before any body is read.
 */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The card checkout is not available: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** A key per attempt, from the platform's CSPRNG. The port's rule is that a key identifies ONE call. */
const mintKey = (): string => `checkout-${randomUUID()}`

/**
 * What the audit trail names, from the session and nothing else.
 *
 * `staffReference` and not a display name: ADR 0020's rule is that an employment record's internal handle is
 * the audit label, because therapists have no display name until an admin sets one (brief rule 10).
 */
const actorFor = (principal: AdminPrincipal) => ({
  kind: 'staff' as const,
  id: principal.employeeId,
  label: principal.staffReference,
})

async function readInput(
  sql: Sql,
  request: Request,
  principal: AdminPrincipal,
): Promise<{ readonly input: CheckoutReadInput; readonly gatewayName: string }> {
  const config = loadConfig()
  // Built here because `@berelax/core` cannot ship one: reading the clock is exactly what the purity gate
  // forbids there, so the edge supplies it and every instant an adapter stamps comes from this.
  const clock: Clock = { now: () => Date.now() as Instant }
  const registry = createPaymentGateways({ config, clock })
  const gateway = registry.cards
  return {
    gatewayName: gateway.name,
    input: {
      chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
      hostedFields: hostedFieldsFrom(config),
      gatewayName: gateway.name,
      nowIso: new Date(clock.now()).toISOString(),
      actorLabel: principal.staffReference,
    },
  }
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and fails
  // closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    return await withSql(async (sql) => {
      const { input } = await readInput(sql, request, authorised.principal)
      return handleCheckoutRead(input, mintKey)
    })
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    // The request is handed over UNREAD. `handleCheckoutWrite` decides the encoding and passes the body to
    // `authoriseCheckout`, which is the one boundary — `pnpm saq-a`'s rule 3 refuses a payments transport that
    // reads a body and does not reach it, and it caught this file doing exactly that on its first run.
    return await withSql(async (sql) => {
      const config = loadConfig()
      const clock: Clock = { now: () => Date.now() as Instant }
      const registry = createPaymentGateways({ config, clock })
      const { input } = await readInput(sql, request, authorised.principal)
      return await handleCheckoutWrite(
        { sql, registry, actor: actorFor(authorised.principal) },
        request,
        input,
        mintKey,
      )
    })
  } catch (error) {
    // Nothing derived from the body may be echoed here. `unavailable` prints an `AppError`'s own message, and
    // every refusal that could carry a submitted value is RETURNED as a rendered refusal by
    // `authoriseCheckout` rather than thrown — see that module on why nothing there quotes a value.
    return unavailable(error)
  }
}

/** Exported so `route-spine.itest.ts` and the CSP test reach the same header builder the verbs use. */
export { checkoutHeaders }

import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import {
  InMemoryOutbox,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { type BookFlowDeps, handleBookFlowRequest, handleBookIcsRequest } from './handler.ts'

/**
 * `/api/v1/book` — the wiring, and nothing else.
 *
 * The handler lives next door and takes its dependencies as an argument, so `apps/web/src/book-flow.itest.ts`
 * can drive it with a frozen clock against a real PostgreSQL and a fake SMS transport. This file builds
 * those dependencies from the real environment exactly once.
 *
 * ## Why the route is outside both locale groups
 *
 * `app/(en)` and `app/(ar)` are two root layouts over one shell. An API route has no layout, no direction
 * and no font stack, so putting it inside a locale group would give the same endpoint two URLs. The locale
 * of the flow is a **field** in the form body, which is what the 303's `Location` is built from — the same
 * arrangement `/api/v1/otp` records beside it for the locale of a message.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent, and `next build` imports every route module to
 * collect its exports. Building the connection at module scope therefore fails the build on any machine
 * without a database, which is what CONTRIBUTING-AGENT-BRIEF's note about `APP_ENV=test` and *"Failed to
 * collect page data"* is describing from the other end.
 *
 * ## Why the cookie's `Secure` flag comes from the environment
 *
 * A `Secure` cookie is never sent over `http://`, and the integration suite drives `http://127.0.0.1`. So
 * the flag follows `APP_ENV`: set in production, absent in development and test. Deriving it from the
 * request's own scheme would be the wrong reading — a request that arrived at a proxy over HTTPS reaches
 * this process over HTTP, and the cookie would silently lose its flag in production.
 */

/** Nothing here can be prerendered or cached: every action writes, and the GET reads a cookie. */
export const dynamic = 'force-dynamic'

let runtime: BookFlowDeps | undefined

function bookFlowRuntime(): BookFlowDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // The confirm action holds a room lock across several statements, so a request occupies its connection
  // for longer than a read does. Still small: PgBouncer multiplexes in front of the database and the
  // managed instance has a hard connection ceiling (ADR 0004).
  const sql = createConnection({ url: config.DATABASE_URL, max: 8 })
  const nowIso = (): string => new Date().toISOString()
  const sms = createSmsalaTransport({ config, now: nowIso })

  const send: SendContext = {
    appEnv: config.APP_ENV,
    // From the parsed configuration, never restated here: the staging guard is only a guard if the
    // allowlist it reads is the one the environment actually set.
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => Date.now() as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // The same three fail-closed evaluators `/api/v1/otp` wires, for the same reasons it states. This
      // flow sends exactly one message — `auth.otp`, which is transactional — so `evaluateGate` returns
      // before any of them is read. A consent GRANT taken on the confirm step is a row in `consent`; the
      // promotional send path that will read it is C-AUTO's, and wiring a prefetch here would be a query
      // that decides nothing.
      evaluators: {
        hasConsent: () => {
          throw new Error(
            'This runtime prefetches no consent logs (the evaluator needs a recipient list, C-CRM-03). ' +
              'Promotional sends fail closed.',
          )
        },
        isSuppressed: () => {
          throw new Error('No suppression list yet (C-CRM-04). Promotional sends fail closed.')
        },
        frequencyCapReached: () => {
          throw new Error('No frequency store yet (C-AUTO-03). Promotional sends fail closed.')
        },
      },
    },
  }

  runtime = {
    sql,
    now: () => Date.now(),
    otp: { sql, now: nowIso, send },
    secureCookies: config.APP_ENV === 'production',
  }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  return await handleBookFlowRequest(bookFlowRuntime(), request)
}

export async function GET(request: Request): Promise<Response> {
  return await handleBookIcsRequest(bookFlowRuntime(), request)
}

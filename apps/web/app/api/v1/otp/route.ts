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
import { handleOtpRequest, type OtpEndpointDeps } from './handler.ts'

/**
 * `POST /api/v1/otp` — the wiring, and nothing else.
 *
 * The handler lives next door in `handler.ts` and takes its dependencies as an argument, so the
 * integration suite can drive it with a frozen clock and a fake transport. This file exists to build
 * those dependencies from the real environment exactly once, and it is deliberately the only place in
 * the app that knows a database connection or an SMS transport exists.
 *
 * ## Why the route is outside both locale groups
 *
 * `app/(en)` and `app/(ar)` are two root layouts over one shell. An API route has no layout, no
 * direction and no font stack, and putting it inside a locale group would give the same endpoint two
 * URLs — `/en/api/v1/otp` and `/ar/api/v1/otp` — or one of them and a 404 on the other. The locale of
 * the *message* is a field in the request body, which is the only place it belongs.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent, and `next build` imports every route module to
 * collect its exports. Building the connection at module scope therefore fails the build on any
 * machine without a database — including CI, where the build step has no reason to have one. A
 * memoised getter moves the failure to the first request, which is where a missing secret should
 * surface: loudly, in the logs, on a box somebody is watching.
 */

/**
 * Nothing about a code request can be prerendered or cached: it writes a row and sends an SMS.
 *
 * Next infers this from the request being read, and saying it explicitly is cheap insurance against an
 * inference that changes between minor versions.
 */
export const dynamic = 'force-dynamic'

let runtime: OtpEndpointDeps | undefined

function otpRuntime(): OtpEndpointDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // Small on purpose: PgBouncer multiplexes in front of the database and the managed instance has a
  // hard connection ceiling (ADR 0004). A code request is two short statements.
  const sql = createConnection({ url: config.DATABASE_URL, max: 4 })
  const now = (): string => new Date().toISOString()
  const sms = createSmsalaTransport({ config, now })

  const send: SendContext = {
    appEnv: config.APP_ENV,
    // From the parsed configuration, never restated here: the staging guard is only a guard if the
    // allowlist it reads is the one the environment actually set.
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    // The real clock, built here because `@berelax/core` cannot ship one: reading the clock is exactly
    // what the purity gate forbids there (`scripts/check-core-purity.mjs`), so the edge supplies it.
    clock: { now: () => Date.now() as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // The consent, suppression and frequency stores are C-CRM-03, C-CRM-04 and C-AUTO-03 and do not
      // exist yet. These throw rather than returning a permissive default, which means a promotional
      // message routed through this runtime is recorded as `blocked_unevaluable` and never sent — the
      // fail-closed behaviour B-MSG-02 exists for. `auth.otp` is transactional, so the gate returns
      // before reading any of them; that is why an OTP is unaffected by all three being absent.
      evaluators: {
        hasConsent: () => {
          throw new Error('No consent store yet (C-CRM-03). Promotional sends fail closed.')
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

  runtime = { sql, now, send }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  return await handleOtpRequest(otpRuntime(), request)
}

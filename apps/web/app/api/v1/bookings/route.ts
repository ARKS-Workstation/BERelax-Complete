import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection } from '@berelax/db'
import { type BookingEndpointDeps, handleBookingRequest } from './handler.ts'

/**
 * `POST /api/v1/bookings` — the wiring, and nothing else.
 *
 * The handler lives next door in `handler.ts` and takes its dependencies as an argument, so the
 * integration suite can drive it with a frozen clock against a real PostgreSQL. This file exists to
 * build those dependencies from the real environment exactly once.
 *
 * ## Why the route is outside both locale groups
 *
 * `app/(en)` and `app/(ar)` are two root layouts over one shell. An API route has no layout, no
 * direction and no font stack, and putting it inside a locale group would give the same endpoint two
 * URLs — `/en/api/v1/bookings` and `/ar/api/v1/bookings` — or one of them and a 404 on the other. The
 * same argument `/api/v1/otp` records beside it.
 *
 * ## Why the runtime is built lazily
 *
 * `loadConfig()` throws when `DATABASE_URL` is absent, and `next build` imports every route module to
 * collect its exports. Building the connection at module scope therefore fails the build on any machine
 * without a database — including CI, where the build step has no reason to have one. A memoised getter
 * moves the failure to the first request, which is where a missing secret should surface.
 */

/**
 * Nothing about a booking can be prerendered or cached: it takes a row lock and writes five records.
 *
 * Next infers this from the request being read, and saying it explicitly is cheap insurance against an
 * inference that changes between minor versions.
 */
export const dynamic = 'force-dynamic'

let runtime: BookingEndpointDeps | undefined

function bookingRuntime(): BookingEndpointDeps {
  if (runtime !== undefined) return runtime
  const config = loadConfig()
  // The booking transaction holds a row lock across several statements, so a request occupies its
  // connection for longer than a read does. Still small: PgBouncer multiplexes in front of the database
  // and the managed instance has a hard connection ceiling (ADR 0004).
  const sql = createConnection({ url: config.DATABASE_URL, max: 8 })
  runtime = { sql, now: () => Date.now() as Instant }
  return runtime
}

export async function POST(request: Request): Promise<Response> {
  return await handleBookingRequest(bookingRuntime(), request)
}

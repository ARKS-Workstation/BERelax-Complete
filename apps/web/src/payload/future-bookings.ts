import type { FutureBookingReport } from '@berelax/cms'
import { sql } from 'drizzle-orm'
import type { PayloadRequest } from 'payload'

/**
 * How many future bookings a catalogue service has.
 *
 * The only place in the CMS that knows the catalogue's table names, and it reaches them read-only. The
 * decision that uses the answer is `@berelax/cms`'s `retireRefusal`, which is pure.
 *
 * ## Scope
 *
 * The catalogue and the booking tables are B-CAT-03's and B-AVAIL-*'s, and neither has landed. So this
 * probe answers `unknowable` when the tables are absent, and `retireRefusal` treats `unknowable` as a
 * refusal — a treatment narrative that references a service cannot be unpublished or deleted until the
 * bookings can be counted, only archived. That is the fail-closed direction and it costs nothing today:
 * with no catalogue there are no services to reference, and an unattached narrative is exempt.
 *
 * It is deliberately NOT `{ counted: 0 }` when the table is missing. A probe that reports "no bookings"
 * because it could not look is how a fail-open default arrives dressed as a measurement, and the day it
 * matters is the day somebody renames the table.
 */

/** The table and columns B-CAT-03 and B-AVAIL-01 are expected to create. */
const BOOKING_TABLE = 'appointment' as const
const SERVICE_COLUMN = 'service_id' as const
const START_COLUMN = 'starts_at' as const

interface ExecutingAdapter {
  readonly drizzle: unknown
  readonly sessions: Readonly<Record<string, { readonly db: unknown } | undefined>>
  readonly execute: (args: { db?: unknown; drizzle?: unknown; sql?: unknown }) => Promise<unknown>
}

function adapterOf(req: PayloadRequest): ExecutingAdapter | null {
  const candidate = req.payload.db as unknown as Partial<ExecutingAdapter>
  if (typeof candidate.execute !== 'function' || candidate.sessions === undefined) return null
  return candidate as ExecutingAdapter
}

function firstRow(result: unknown): Readonly<Record<string, unknown>> | null {
  const rows = (result as { readonly rows?: unknown })?.rows
  if (!Array.isArray(rows) || rows.length === 0) return null
  const row = rows[0]
  return row !== null && typeof row === 'object' ? (row as Readonly<Record<string, unknown>>) : null
}

/**
 * The probe.
 *
 * Existence is checked separately from the count, on purpose. Wrapping the count in a try/catch and
 * reading "relation does not exist" out of the error message would also swallow a deadlock, a permission
 * error and a syntax mistake, and report all of them as the same thing.
 */
export async function countFutureBookings(
  req: PayloadRequest,
  catalogueServiceId: string,
  nowIso: string,
): Promise<FutureBookingReport> {
  const adapter = adapterOf(req)
  if (adapter === null) {
    return { kind: 'unknowable', reason: 'the database adapter exposes no way to run a query' }
  }

  const transaction =
    req.transactionID === undefined ? undefined : adapter.sessions[String(req.transactionID)]?.db
  const db = transaction ?? adapter.drizzle

  const present = firstRow(
    await adapter.execute({
      db,
      drizzle: db,
      sql: sql`
        select count(*)::int as n
        from information_schema.columns
        where table_schema = 'public'
          and table_name = ${BOOKING_TABLE}
          and column_name in (${SERVICE_COLUMN}, ${START_COLUMN})
      `,
    }),
  )
  if (Number(present?.['n'] ?? 0) < 2) {
    return {
      kind: 'unknowable',
      reason:
        `public.${BOOKING_TABLE} does not yet carry ${SERVICE_COLUMN} and ${START_COLUMN}; the ` +
        'catalogue and availability units (B-CAT-03, B-AVAIL-01) have not landed in this database',
    }
  }

  const counted = firstRow(
    await adapter.execute({
      db,
      drizzle: db,
      sql: sql`
        select count(*)::int as n
        from public.appointment
        where service_id = ${catalogueServiceId}::uuid
          and starts_at > ${nowIso}::timestamptz
      `,
    }),
  )
  const n = Number(counted?.['n'] ?? Number.NaN)
  return Number.isFinite(n)
    ? { kind: 'counted', count: n }
    : { kind: 'unknowable', reason: 'the count query returned no row' }
}

/**
 * The probe as a swappable reference.
 *
 * `apps/web/src/payload.itest.ts` substitutes a stub so the retire rules can be exercised for a service
 * that *does* have a future booking — which is impossible to arrange honestly while the catalogue and
 * appointment tables do not exist. The real probe is asserted separately in the same file: against this
 * database as it stands it must report `unknowable`, and the refusal must follow from that.
 *
 * A module-level reference rather than a parameter on the collection config, for the same reason
 * `setMaintenanceSql` is one in the worker's registry: the collection is built once at config time and
 * the hook runs per request.
 */
export type FutureBookingProbe = (
  req: PayloadRequest,
  catalogueServiceId: string,
  nowIso: string,
) => Promise<FutureBookingReport>

let probe: FutureBookingProbe = countFutureBookings

/** Pass `null` to restore the real probe. A test that forgets to restore it breaks the next one. */
export function setFutureBookingProbe(next: FutureBookingProbe | null): void {
  probe = next ?? countFutureBookings
}

export function futureBookingProbe(): FutureBookingProbe {
  return probe
}

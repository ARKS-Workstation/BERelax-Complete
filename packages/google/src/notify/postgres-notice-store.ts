import { type Instant, instantToIso, reauthIncidentKey } from '@berelax/core'
import type { Sql } from '@berelax/db'
import type {
  ReauthNoticeChannel,
  ReauthNoticeDecision,
  ReauthNoticeStore,
} from './notice-store.ts'

/**
 * The PostgreSQL implementation of the re-auth notice store (migration 0075).
 *
 * Four queries and no token column among them, which is the same property `postgres-store.ts` next door
 * keeps: the KEK is not a parameter of anything here, so a bug in a query cannot leak a credential even
 * in an error message.
 *
 * ## The incident read, and why it is a query rather than a column
 *
 * A dead grant's incident is the `google_connection_events` row that recorded it — `reauth_required`,
 * which `applyGrantFailure` appends inside the same transaction that moves the status to `needs_reauth`
 * (G-CONN-01). The alternative was a `broken_since` column on `google_connections`, and it is worse in a
 * way that only shows up later: the column would be written by whichever code path noticed, so a
 * revocation discovered by the liveness probe and one discovered by a review poll would race to set it,
 * and the ladder's dedupe key would move underneath an incident that had already started. The event log
 * is append-only and its ids are monotonic, so the newest `reauth_required` row is the incident, full
 * stop.
 *
 * `order by id desc` rather than by `occurred_at`: two events in one transaction share an instant, and the
 * identity column is what breaks the tie the same way every time.
 */

interface IncidentRow {
  readonly id: string
  readonly occurred_at: Date
}

interface DecisionRow {
  readonly connection_id: string
  readonly incident_key: string
  readonly kind: string
  readonly step: string
  readonly rung_index: number
  readonly to_role: string
  readonly channel: string
  readonly due_at: Date
  readonly decided_at: Date
  readonly message_id: string | null
  readonly skipped_reason: string | null
}

/**
 * Casts a stored row back to the decision shape.
 *
 * The three text columns are cast rather than validated, and that is safe for one reason only: every one
 * of them is CHECK-constrained by 0075 against the same vocabulary the types declare, and the
 * `google-reauth-notice.itest.ts` beside this file parses the accepted sets out of `pg_constraint` and
 * compares them with the unions in both directions. A cast over an unconstrained column would be the
 * thing brief rule 28 warns about.
 */
const toDecision = (row: DecisionRow): ReauthNoticeDecision => ({
  connectionId: row.connection_id,
  incidentKey: row.incident_key,
  kind: row.kind as ReauthNoticeDecision['kind'],
  step: row.step,
  rungIndex: row.rung_index,
  toRole: row.to_role as ReauthNoticeDecision['toRole'],
  channel: row.channel as ReauthNoticeChannel,
  dueAt: row.due_at.getTime() as Instant,
  decidedAt: row.decided_at.getTime() as Instant,
  messageId: row.message_id,
  skippedReason: row.skipped_reason as ReauthNoticeDecision['skippedReason'],
})

export function createPostgresReauthNoticeStore(sql: Sql): ReauthNoticeStore {
  return {
    async latestReauthIncident(connectionId) {
      const rows = await sql<IncidentRow[]>`
        select id::text as id, occurred_at
        from google_connection_events
        where connection_id = ${connectionId}::uuid and event = 'reauth_required'
        order by id desc
        limit 1
      `
      const row = rows[0]
      if (row === undefined) return null
      return {
        key: reauthIncidentKey(row.id),
        openedAt: row.occurred_at.getTime() as Instant,
      }
    },

    async decidedSteps({ connectionId, incidentKey }) {
      const rows = await sql<{ step: string }[]>`
        select distinct step from google_reauth_notice
        where connection_id = ${connectionId}::uuid and incident_key = ${incidentKey}
      `
      return rows.map((row) => row.step)
    },

    async record(decision) {
      // No `on conflict`: the unique index is the dedupe, and swallowing the conflict would turn "this
      // rung was already decided" into a silent success — which is the one thing that would let a second
      // worker send a second email and report one.
      await sql`
        insert into google_reauth_notice (
          connection_id, incident_key, kind, step, rung_index, to_role, channel,
          outcome, message_id, skipped_reason, due_at, decided_at
        ) values (
          ${decision.connectionId}::uuid,
          ${decision.incidentKey},
          ${decision.kind},
          ${decision.step},
          ${decision.rungIndex},
          ${decision.toRole},
          ${decision.channel},
          ${decision.skippedReason === null ? 'sent' : 'skipped'},
          ${decision.messageId},
          ${decision.skippedReason},
          ${instantToIso(decision.dueAt)}::timestamptz,
          ${instantToIso(decision.decidedAt)}::timestamptz
        )
      `
    },

    async decisionsFor({ connectionId, incidentKey }) {
      const rows = await sql<DecisionRow[]>`
        select connection_id::text as connection_id, incident_key, kind::text as kind, step,
               rung_index, to_role, channel, due_at, decided_at,
               message_id::text as message_id, skipped_reason
        from google_reauth_notice
        where connection_id = ${connectionId}::uuid and incident_key = ${incidentKey}
        order by decided_at desc, step desc
      `
      return rows.map(toDecision)
    },
  }
}

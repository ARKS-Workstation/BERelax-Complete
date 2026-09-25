import type {
  Instant,
  ReauthIncident,
  ReauthNoticeKind,
  ReauthNoticeRole,
  ReauthSkipReason,
} from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * The narrow seam the re-auth ladder reads and writes, and an in-memory implementation of it.
 *
 * Narrow on purpose, exactly as `GoogleHealthStore` is: four methods, none of which can reach a token
 * column, so the pass that sends emails cannot open a credential even by mistake. The Postgres
 * implementation is next door; this one is what lets every counting claim about the ladder — one email per
 * incident, a repeat at +24h, a stop at the cap, nothing at all for a healthy connection — run in the unit
 * suite with no database.
 *
 * ## Why "already decided" and not "already sent"
 *
 * The dedupe read returns every step this incident has a ROW for, sent or skipped. A skip is a decision
 * about that rung too — no recipient on file, the SMS channel switched off — and a rung whose skip did not
 * count as decided would be retried on every pass, which against migration 0075's unique index is an
 * insert that throws rather than a retry that works. So a rung is decided once, the ladder moves on, and
 * every skip carries a reason somebody can read off the row.
 */

/** One decision, as the store records it. Terminal: there is no state to move it out of. */
export interface ReauthNoticeDecision {
  readonly connectionId: string
  readonly incidentKey: string
  readonly kind: ReauthNoticeKind
  readonly step: string
  readonly rungIndex: number
  readonly toRole: ReauthNoticeRole
  readonly channel: ReauthNoticeChannel
  readonly dueAt: Instant
  readonly decidedAt: Instant
  /** The `message` row a send produced, when one was produced. See 0075's `message_id` comment. */
  readonly messageId: string | null
  readonly skippedReason: ReauthSkipReason | null
}

/** The two channels 0075 accepts. SMS is off by default (`google.reauth_sms_enabled`). */
export const REAUTH_NOTICE_CHANNELS = ['email', 'sms'] as const
export type ReauthNoticeChannel = (typeof REAUTH_NOTICE_CHANNELS)[number]

export interface ReauthNoticeStore {
  /**
   * The incident a connection's dead grant belongs to, or null when nothing recorded one.
   *
   * Null is not the same as "the connection is fine": it means the pass cannot identify the incident, and
   * the ladder then sends NOTHING rather than sending on every pass with nothing to deduplicate against.
   */
  latestReauthIncident(connectionId: string): Promise<ReauthIncident | null>
  /** Every step already decided for this incident, in any channel, for any role. */
  decidedSteps(args: {
    readonly connectionId: string
    readonly incidentKey: string
  }): Promise<readonly string[]>
  /** Records one decision. Refused by 0075's unique index if this rung was already decided. */
  record(decision: ReauthNoticeDecision): Promise<void>
  /** Every decision for one incident, newest first. For the pass's own report and for the tests. */
  decisionsFor(args: {
    readonly connectionId: string
    readonly incidentKey: string
  }): Promise<readonly ReauthNoticeDecision[]>
}

/**
 * An in-memory store, with the same refusal the unique index makes.
 *
 * The refusal is the point rather than a nicety: a memory store that silently accepted a duplicate would
 * let the unit suite prove "one email per incident" against an implementation that cannot fail, and the
 * claim would then be about the test's loop instead of about the code (ADR 0003).
 */
export function createMemoryReauthNoticeStore(
  incidents: Readonly<Record<string, ReauthIncident>> = {},
): ReauthNoticeStore & { readonly all: () => readonly ReauthNoticeDecision[] } {
  const rows: ReauthNoticeDecision[] = []
  const keyOf = (decision: ReauthNoticeDecision): string =>
    [
      decision.connectionId,
      decision.incidentKey,
      decision.step,
      decision.toRole,
      decision.channel,
    ].join('\u0000')
  return {
    async latestReauthIncident(connectionId) {
      return incidents[connectionId] ?? null
    },
    async decidedSteps({ connectionId, incidentKey }) {
      return [
        ...new Set(
          rows
            .filter((row) => row.connectionId === connectionId && row.incidentKey === incidentKey)
            .map((row) => row.step),
        ),
      ]
    },
    async record(decision) {
      if (rows.some((row) => keyOf(row) === keyOf(decision))) {
        throw new AppError(
          'conflict',
          `A re-auth notice for ${decision.step} to the ${decision.toRole} by ${decision.channel} was ` +
            'already recorded for this incident. Migration 0075 refuses the same row, which is what makes ' +
            '"one per incident" a constraint rather than a convention in the sender.',
          { details: { reason: 'google_reauth_notice_already_decided', step: decision.step } },
        )
      }
      rows.push(decision)
    },
    async decisionsFor({ connectionId, incidentKey }) {
      return rows
        .filter((row) => row.connectionId === connectionId && row.incidentKey === incidentKey)
        .slice()
        .reverse()
    },
    all: () => rows.slice(),
  }
}

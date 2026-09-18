import type { Instant } from '@berelax/core'
import { AppError } from '@berelax/shared'
import type {
  ConnectionEventInput,
  GoogleCapabilityRecord,
  GoogleConnectionRecord,
  GoogleConnectionStore,
} from './connection-store.ts'
import type { SealedToken } from './token-store.ts'

/**
 * An in-memory connection store.
 *
 * Not only a test double. It is what makes the whole token lifecycle — including the `invalid_grant`
 * path, which is the path that matters — walkable with no database and no Google account, which is the
 * same reason the provider fakes exist (docs/12 §1).
 *
 * It reproduces the two guarantees the database enforces, because a fake that is more permissive than
 * the real thing is how a bug reaches production green:
 *
 *   - the event log is append-only, and
 *   - an event payload carrying a token is refused outright.
 */

/** The keys the database's CHECK constraint refuses in `google_connection_events.detail`. */
const FORBIDDEN_DETAIL_KEYS = [
  'refresh_token',
  'access_token',
  'refreshToken',
  'accessToken',
  'token',
]

export interface MemoryConnectionStore extends GoogleConnectionStore {
  put(record: GoogleConnectionRecord): void
  putCapability(capability: GoogleCapabilityRecord): void
  records(): readonly GoogleConnectionRecord[]
  events(): readonly ConnectionEventInput[]
}

export function createMemoryConnectionStore(
  seed: readonly GoogleConnectionRecord[] = [],
): MemoryConnectionStore {
  const connections = new Map<string, GoogleConnectionRecord>(seed.map((r) => [r.id, r]))
  const capabilities: GoogleCapabilityRecord[] = []
  const events: ConnectionEventInput[] = []

  const mutate = (id: string, patch: Partial<GoogleConnectionRecord>): void => {
    const existing = connections.get(id)
    if (existing === undefined)
      throw new AppError('not_found', `No Google connection with id ${id}`)
    connections.set(id, { ...existing, ...patch })
  }

  return {
    put(record) {
      connections.set(record.id, record)
    },

    putCapability(capability) {
      capabilities.push(capability)
    },

    records() {
      return [...connections.values()]
    },

    events() {
      // A copy: a caller that could splice this would be able to rewrite an append-only log.
      return [...events]
    },

    async load(connectionId) {
      return connections.get(connectionId) ?? null
    },

    async listAll() {
      return [...connections.values()].sort((a, b) => a.id.localeCompare(b.id))
    },

    async capabilitiesFor(connectionId) {
      return capabilities.filter((c) => c.connectionId === connectionId)
    },

    async recordRefresh(write) {
      mutate(write.connectionId, {
        accessToken: write.accessToken,
        accessExpiresAt: write.accessExpiresAt,
        lastOkAt: write.lastOkAt,
        lastCheckedAt: write.lastOkAt,
        status: write.status,
        statusReason: write.statusReason,
        // An absent refresh token means Google returned the same one, so the stored one stands.
        ...(write.refreshToken === undefined ? {} : { refreshToken: write.refreshToken }),
      })
    },

    async recordStatus(write) {
      mutate(write.connectionId, {
        status: write.status,
        statusReason: write.statusReason,
        lastCheckedAt: write.lastCheckedAt,
      })
    },

    async rewrapRefreshToken({ connectionId, refreshToken }) {
      // Narrow on purpose, exactly like the SQL: a rotation cannot reach a status or a capability.
      mutate(connectionId, { refreshToken })
    },

    async appendEvent(event) {
      const detail = event.detail ?? {}
      const leaked = FORBIDDEN_DETAIL_KEYS.filter((key) => key in detail)
      if (leaked.length > 0) {
        throw new AppError(
          'invariant_violated',
          `An event payload may not carry ${leaked.join(', ')}. Rows reach query logs, ` +
            'pg_stat_statements, backups and pg-boss job payloads.',
        )
      }
      events.push(event)
    },
  }
}

/** Builds a record for a test or a demo. The sealed token is supplied; this never encrypts anything. */
export function connectionRecord(args: {
  readonly id: string
  readonly googleSub: string
  readonly refreshToken: SealedToken
  readonly consentAt: Instant
  readonly googleEmail?: string
  readonly grantedScopes?: readonly string[]
  readonly status?: GoogleConnectionRecord['status']
  readonly statusReason?: string | null
  readonly lastOkAt?: Instant | null
  readonly accessToken?: SealedToken | null
  readonly accessExpiresAt?: Instant | null
}): GoogleConnectionRecord {
  return {
    id: args.id,
    googleSub: args.googleSub,
    googleEmail: args.googleEmail ?? 'google-admin@berelax.ae',
    grantedScopes: args.grantedScopes ?? [],
    status: args.status ?? 'active',
    statusReason: args.statusReason ?? null,
    consentAt: args.consentAt,
    lastOkAt: args.lastOkAt ?? null,
    lastCheckedAt: null,
    accessExpiresAt: args.accessExpiresAt ?? null,
    refreshToken: args.refreshToken,
    accessToken: args.accessToken ?? null,
  }
}

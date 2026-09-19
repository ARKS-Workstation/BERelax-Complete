import type { Instant } from '@berelax/core'
import { AppError } from '@berelax/shared'
import type {
  ConfirmedListing,
  ConnectionEventInput,
  GoogleCapabilityRecord,
  GoogleCapabilitySelectionStore,
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleConsentStore,
  GoogleDisconnectStore,
  GoogleHealthStore,
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

/** Same shape as the jsonb comparison the database does, so the fake keys capability rows identically. */
const sameResource = (
  a: Readonly<Record<string, unknown>> | null,
  b: Readonly<Record<string, unknown>> | null,
): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export interface MemoryConnectionStore
  extends GoogleConnectionStore,
    GoogleConsentStore,
    GoogleCapabilitySelectionStore,
    GoogleDisconnectStore,
    GoogleHealthStore {
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
  let allocated = 0

  const mutate = (id: string, patch: Partial<GoogleConnectionRecord>): void => {
    const existing = connections.get(id)
    if (existing === undefined)
      throw new AppError('not_found', `No Google connection with id ${id}`)
    connections.set(id, { ...existing, ...patch })
  }

  /**
   * The append with the token-payload refusal, as a local function.
   *
   * A local rather than `this.appendEvent` inside `disconnect`, because `this` on an object literal is
   * whatever the call site bound — and a destructured `const { disconnect } = store` would silently
   * append nothing while still zeroising the row, which is the one combination that must not be
   * reachable.
   */
  const append = (event: ConnectionEventInput): void => {
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

    async loadBySub(googleSub) {
      return [...connections.values()].find((r) => r.googleSub === googleSub) ?? null
    },

    async authorizationCodeSeen(fingerprint) {
      return events.some((e) => e.detail?.['authorizationCodeFingerprint'] === fingerprint)
    },

    async allocateId() {
      allocated += 1
      // Zero-padded so `listAll`'s lexicographic sort matches the insertion order, the way a UUIDv7's
      // time prefix does in the database. An unpadded counter sorts 10 before 2.
      return `memory-connection-${String(allocated).padStart(6, '0')}`
    },

    async insert(connection) {
      // UNIQUE(google_sub), reproduced. A fake that let two rows share a sub would make the whole
      // "matching sub is a re-auth" question undecidable in a unit test and decidable only in
      // production.
      const clash = [...connections.values()].find((r) => r.googleSub === connection.googleSub)
      if (clash !== undefined) {
        throw new AppError(
          'conflict',
          `A Google connection for sub ${connection.googleSub} already exists (${clash.id}).`,
        )
      }
      connections.set(
        connection.id,
        connectionRecord({
          id: connection.id,
          googleSub: connection.googleSub,
          googleEmail: connection.googleEmail,
          grantedScopes: connection.grantedScopes,
          refreshToken: connection.refreshToken,
          consentAt: connection.consentAt,
        }),
      )
      return connection.id
    },

    async recordConsent(write) {
      mutate(write.connectionId, {
        googleEmail: write.googleEmail,
        grantedScopes: write.grantedScopes,
        refreshToken: write.refreshToken,
        consentAt: write.consentAt,
        status: 'active',
        statusReason: null,
        // Cleared, exactly as the SQL does: the cached token carries the OLD scope set and would keep
        // working against a product the owner has just removed.
        accessToken: null,
        accessExpiresAt: null,
      })
    },

    async upsertCapability(capability) {
      const clash = capabilities.find(
        (c) =>
          c.connectionId === capability.connectionId &&
          c.capability === capability.capability &&
          sameResource(c.resourceRef, capability.resourceRef),
      )
      if (clash !== undefined) {
        throw new AppError(
          'conflict',
          `A ${capability.capability} capability for that resource already exists on ` +
            `${capability.connectionId} (google_capability_resource_unique).`,
        )
      }
      const primaryClash =
        capability.isPrimary &&
        capabilities.some(
          (c) =>
            c.connectionId === capability.connectionId &&
            c.capability === capability.capability &&
            c.isPrimary,
        )
      if (primaryClash) {
        throw new AppError(
          'conflict',
          `${capability.capability} already has a primary resource on ${capability.connectionId} ` +
            '(google_capability_one_primary).',
        )
      }
      capabilities.push(capability)
    },

    async selectCapabilityResource(write) {
      // The primary row, keyed the way the partial unique index keys it. A fake that searched by resource
      // would find nothing on the first selection — the row it has to fill is the one whose resource_ref is
      // still null — and a fake that searched by capability alone would pick whichever row came first once
      // a second resource existed, which is the ambiguity `google_capability_one_primary` exists to remove.
      const index = capabilities.findIndex(
        (c) =>
          c.connectionId === write.connectionId && c.capability === write.capability && c.isPrimary,
      )
      const existing = capabilities[index]
      if (existing === undefined) {
        throw new AppError(
          'not_found',
          `No primary ${write.capability} capability on connection ${write.connectionId}. A consent ` +
            'registers one per capability; without it there is nothing for a selection to fill.',
        )
      }
      // `google_capability_resource_unique` is NULLS NOT DISTINCT over (connection_id, capability,
      // resource_ref), so the same resource cannot be registered twice under one capability. Reproduced
      // here because a fake more permissive than the database is how a bug reaches production green.
      const clash = capabilities.find(
        (c, position) =>
          position !== index &&
          c.connectionId === write.connectionId &&
          c.capability === write.capability &&
          sameResource(c.resourceRef, write.resourceRef),
      )
      if (clash !== undefined) {
        throw new AppError(
          'conflict',
          `That resource is already registered for ${write.capability} on ${write.connectionId} ` +
            '(google_capability_resource_unique).',
        )
      }
      capabilities[index] = { ...existing, resourceRef: write.resourceRef }
    },

    async updateCapabilityHealth(write) {
      const index = capabilities.findIndex(
        (c) =>
          c.connectionId === write.connectionId &&
          c.capability === write.capability &&
          sameResource(c.resourceRef, write.resourceRef),
      )
      const existing = capabilities[index]
      if (existing === undefined) {
        throw new AppError(
          'not_found',
          `No ${write.capability} capability on connection ${write.connectionId} for that resource`,
        )
      }
      capabilities[index] = { ...existing, health: write.health }
    },

    async listAll() {
      return [...connections.values()].sort((a, b) => a.id.localeCompare(b.id))
    },

    async capabilitiesFor(connectionId) {
      return capabilities.filter((c) => c.connectionId === connectionId)
    },

    async recordRefresh(write) {
      // The `and status <> 'disconnected'` clause the SQL carries, reproduced. A fake more permissive
      // than the database is how a bug reaches production green (see the header): without this, a unit
      // test of a refresh racing a disconnect would cache an access token on a zeroised row and pass.
      const existing = connections.get(write.connectionId)
      if (existing?.status === 'disconnected') {
        throw new AppError(
          'not_found',
          `No refreshable Google connection with id ${write.connectionId}: it is absent or it was ` +
            'disconnected while this refresh was in flight. A disconnected connection must not acquire ' +
            'a cached access token.',
        )
      }
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

    async recordCheckOutcome(write) {
      // The `coalesce` the SQL does, reproduced: a failed pass moves `last_checked_at` and leaves
      // `last_ok_at` alone. A fake that wrote null over the last success would make a working
      // connection read as never-verified in every unit test above it.
      mutate(write.connectionId, {
        lastCheckedAt: write.lastCheckedAt,
        ...(write.lastOkAt === null ? {} : { lastOkAt: write.lastOkAt }),
      })
    },

    async confirmedListing({ connectionId, capability }) {
      // Last match wins, which is `order by id desc limit 1` over an append-only log: a re-pick
      // supersedes the earlier choice, and the earlier row stays where it is because history is not
      // rewritten.
      const matches = events.filter(
        (event) =>
          event.connectionId === connectionId &&
          event.event === 'capability_changed' &&
          event.detail?.['capability'] === capability &&
          typeof event.detail?.['placeId'] === 'string',
      )
      const latest = matches[matches.length - 1]
      if (latest === undefined) return null
      const detail = latest.detail ?? {}
      const placeId = detail['placeId']
      const title = detail['title']
      const address = detail['address']
      if (typeof placeId !== 'string' || typeof title !== 'string' || typeof address !== 'string') {
        // All three or nothing, exactly as the SQL decides it. See `ConfirmedListing`.
        return null
      }
      return {
        placeId,
        title,
        address,
        // The memory store has no `occurred_at`; the event's own ordinal stands in, which is enough for
        // the only thing a caller does with it — say when the listing was confirmed relative to now.
        confirmedAt: 0 as Instant,
        actorLabel: latest.actorLabel ?? null,
      } satisfies ConfirmedListing
    },

    async pendingRevocations() {
      // The same predicate the SQL uses, including the `refresh_token_ct is not null` half. A fake that
      // returned a zeroised row would hand the retry a connection with no credential, which is a state
      // `google_connections_revoke_retry_keeps_its_token` makes impossible in the database — and a fake
      // more permissive than the database is how a bug reaches production green.
      return [...connections.values()]
        .filter((r) => r.statusReason === 'revoke_failed' && r.refreshToken !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
    },

    async disconnect(write) {
      // Not atomic, and the comment says so rather than the name implying otherwise — the same caveat
      // `createMemoryRefreshLock` records. There is no transaction here, so a body that failed halfway
      // would leave the earlier writes in place. That difference is exactly why the claim *the zeroised
      // columns and the events recording them commit together* is asserted against real PostgreSQL in
      // `google-disconnect.itest.ts` and not here.
      mutate(write.connectionId, {
        status: 'disconnected',
        statusReason: write.statusReason,
        lastCheckedAt: write.at,
        ...(write.zeroise ? { refreshToken: null } : {}),
        // Unconditional, whatever the revocation said: an hour of full authority that nothing may spend
        // again. See the SQL for why keeping it "until it expires" is not an option.
        accessToken: null,
        accessExpiresAt: null,
      })
      for (const event of write.events) append(event)
    },

    async rewrapRefreshToken({ connectionId, refreshToken }) {
      // Narrow on purpose, exactly like the SQL: a rotation cannot reach a status or a capability.
      mutate(connectionId, { refreshToken })
    },

    async appendEvent(event) {
      append(event)
    },
  }
}

/** Builds a record for a test or a demo. The sealed token is supplied; this never encrypts anything. */
export function connectionRecord(args: {
  readonly id: string
  readonly googleSub: string
  /** Null for a connection a disconnect has already zeroised — the one state with no credential. */
  readonly refreshToken: SealedToken | null
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

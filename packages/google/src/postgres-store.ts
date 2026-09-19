import type {
  GoogleCapability,
  GoogleCapabilityHealth,
  GoogleConnectionStatus,
  Instant,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type {
  CapabilityHealthWrite,
  CapabilityResourceWrite,
  CheckOutcomeWrite,
  ConfirmedListing,
  ConnectionEventInput,
  ConsentWrite,
  DisconnectWrite,
  GoogleCapabilityRecord,
  GoogleCapabilitySelectionStore,
  GoogleConnectionRecord,
  GoogleConnectionStore,
  GoogleConsentStore,
  GoogleDisconnectStore,
  GoogleHealthStore,
  NewConnection,
  RefreshWrite,
  StatusWrite,
} from './connection-store.ts'
import type { SealedToken } from './token-store.ts'

/**
 * The PostgreSQL implementation of the connection store.
 *
 * Every read here returns sealed columns. Nothing in this file decrypts anything, which is the point:
 * the KEK is not a parameter of any function in it, so a bug in a query cannot leak a token even in an
 * error message.
 */

interface ConnectionRow {
  readonly id: string
  readonly google_sub: string
  readonly google_email: string
  readonly granted_scopes: string[]
  readonly status: string
  readonly status_reason: string | null
  readonly consent_at: Date
  readonly last_ok_at: Date | null
  readonly last_checked_at: Date | null
  readonly access_expires_at: Date | null
  readonly refresh_token_ct: Buffer | null
  readonly refresh_token_nonce: Buffer | null
  readonly refresh_token_wrapped_key: Buffer | null
  readonly refresh_token_kid: string | null
  readonly refresh_token_aad_fp: string | null
  readonly access_token_ct: Buffer | null
  readonly access_token_nonce: Buffer | null
  readonly access_token_wrapped_key: Buffer | null
  readonly access_token_kid: string | null
  readonly access_token_aad_fp: string | null
}

const instant = (value: Date): Instant => value.getTime() as Instant
const instantOrNull = (value: Date | null): Instant | null =>
  value === null ? null : instant(value)

function toRecord(row: ConnectionRow): GoogleConnectionRecord {
  // An access token is five columns or none of them; the CHECK constraint in 0016 guarantees it, so a
  // single null test is enough and a half-populated cache cannot reach this point.
  const accessToken: SealedToken | null =
    row.access_token_ct === null ||
    row.access_token_nonce === null ||
    row.access_token_wrapped_key === null ||
    row.access_token_kid === null ||
    row.access_token_aad_fp === null
      ? null
      : {
          ct: row.access_token_ct,
          nonce: row.access_token_nonce,
          wrappedKey: row.access_token_wrapped_key,
          kid: row.access_token_kid,
          aadFingerprint: row.access_token_aad_fp,
        }
  return {
    id: row.id,
    googleSub: row.google_sub,
    googleEmail: row.google_email,
    grantedScopes: row.granted_scopes,
    status: row.status as GoogleConnectionStatus,
    statusReason: row.status_reason,
    consentAt: instant(row.consent_at),
    lastOkAt: instantOrNull(row.last_ok_at),
    lastCheckedAt: instantOrNull(row.last_checked_at),
    accessExpiresAt: instantOrNull(row.access_expires_at),
    // Five columns or none of them; `google_connections_refresh_token_complete` (0040) guarantees it, so
    // one null test is enough and a half-wiped credential cannot reach this point. Null is a completed
    // disconnect: the token was revoked at Google and then erased here.
    refreshToken:
      row.refresh_token_ct === null ||
      row.refresh_token_nonce === null ||
      row.refresh_token_wrapped_key === null ||
      row.refresh_token_kid === null ||
      row.refresh_token_aad_fp === null
        ? null
        : {
            ct: row.refresh_token_ct,
            nonce: row.refresh_token_nonce,
            wrappedKey: row.refresh_token_wrapped_key,
            kid: row.refresh_token_kid,
            aadFingerprint: row.refresh_token_aad_fp,
          },
    accessToken,
  }
}

const SELECT_COLUMNS = `
  id, google_sub, google_email, granted_scopes, status, status_reason, consent_at, last_ok_at,
  last_checked_at, access_expires_at, refresh_token_ct, refresh_token_nonce,
  refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, access_token_ct,
  access_token_nonce, access_token_wrapped_key, access_token_kid, access_token_aad_fp
`

/** Re-exported for the callers that imported it from here before the consent flow existed. */
export type { NewConnection } from './connection-store.ts'

export function createPostgresConnectionStore(sql: Sql): GoogleConnectionStore &
  GoogleConsentStore &
  GoogleCapabilitySelectionStore &
  GoogleDisconnectStore &
  GoogleHealthStore & {
    allocateId(): Promise<string>
    insert(connection: NewConnection): Promise<string>
    upsertCapability(capability: GoogleCapabilityRecord): Promise<void>
  } {
  return {
    async load(connectionId) {
      const rows = await sql<ConnectionRow[]>`
        select ${sql.unsafe(SELECT_COLUMNS)} from google_connections where id = ${connectionId}
      `
      const row = rows[0]
      return row === undefined ? null : toRecord(row)
    },

    async loadBySub(googleSub) {
      const rows = await sql<ConnectionRow[]>`
        select ${sql.unsafe(SELECT_COLUMNS)} from google_connections where google_sub = ${googleSub}
      `
      const row = rows[0]
      return row === undefined ? null : toRecord(row)
    },

    async authorizationCodeSeen(fingerprint) {
      // No index: this table holds a handful of rows per connection for the lifetime of the business,
      // and an index on a jsonb path that one query reads once per consent would cost more to maintain
      // than it saves. The fingerprint, not the code — a code is a bearer credential even after it is
      // spent, and its SHA-256 is enough to recognise a replay without storing one.
      const rows = await sql<{ one: number }[]>`
        select 1 as one from google_connection_events
        where detail->>'authorizationCodeFingerprint' = ${fingerprint}
        limit 1
      `
      return rows.length > 0
    },

    async listAll() {
      // Ordered so a resumed re-wrap visits rows in the same order as the run it is resuming.
      const rows = await sql<ConnectionRow[]>`
        select ${sql.unsafe(SELECT_COLUMNS)} from google_connections order by id
      `
      return rows.map(toRecord)
    },

    async capabilitiesFor(connectionId) {
      const rows = await sql<
        {
          connection_id: string
          capability: string
          resource_ref: Record<string, unknown> | null
          health: string
          is_primary: boolean
        }[]
      >`
        select connection_id, capability, resource_ref, health, is_primary
        from google_capabilities
        where connection_id = ${connectionId}
        order by capability, is_primary desc
      `
      return rows.map((row) => ({
        connectionId: row.connection_id,
        capability: row.capability as GoogleCapability,
        resourceRef: row.resource_ref,
        health: row.health as GoogleCapabilityHealth,
        isPrimary: row.is_primary,
      }))
    },

    async recordRefresh(write: RefreshWrite) {
      // One statement, so the access token and the success timestamp cannot land separately. A cached
      // token with a stale last_ok_at would make a working connection read as degraded.
      const rows = await sql`
        update google_connections set
          access_token_ct          = ${write.accessToken.ct},
          access_token_nonce       = ${write.accessToken.nonce},
          access_token_wrapped_key = ${write.accessToken.wrappedKey},
          access_token_kid         = ${write.accessToken.kid},
          access_token_aad_fp      = ${write.accessToken.aadFingerprint},
          access_expires_at        = ${new Date(write.accessExpiresAt)},
          refresh_token_ct          = coalesce(${write.refreshToken?.ct ?? null}, refresh_token_ct),
          refresh_token_nonce       = coalesce(${write.refreshToken?.nonce ?? null}, refresh_token_nonce),
          refresh_token_wrapped_key = coalesce(${write.refreshToken?.wrappedKey ?? null}, refresh_token_wrapped_key),
          refresh_token_kid         = coalesce(${write.refreshToken?.kid ?? null}, refresh_token_kid),
          refresh_token_aad_fp      = coalesce(${write.refreshToken?.aadFingerprint ?? null}, refresh_token_aad_fp),
          last_ok_at      = ${new Date(write.lastOkAt)},
          last_checked_at = ${new Date(write.lastOkAt)},
          status          = ${write.status},
          status_reason   = ${write.statusReason}
        -- The status clause is not belt-and-braces; it closes a race a disconnect cannot otherwise win.
        -- accessTokenUnderLock re-reads the row inside its advisory lock and refuses a disconnected one,
        -- but under READ COMMITTED a disconnect can commit AFTER that re-read and before this UPDATE:
        -- the UPDATE then waits on the row lock, re-evaluates its WHERE against the new row version,
        -- and — without this clause — writes a freshly minted access token onto a row whose credentials
        -- were just zeroised on purpose. An hour of full authority over the listing, cached on a
        -- connection an operator was told had been disconnected. Zero rows here raises not_found, the
        -- refresh transaction rolls back, and the next attempt degrades through loadActiveConnection
        -- the way every other caller of a disconnected connection does.
        where id = ${write.connectionId} and status <> 'disconnected'
        returning id
      `
      if (rows.length === 0) {
        throw new AppError(
          'not_found',
          `No refreshable Google connection with id ${write.connectionId}: it is absent or it was ` +
            'disconnected while this refresh was in flight. A disconnected connection must not acquire ' +
            'a cached access token.',
        )
      }
    },

    async recordConsent(write: ConsentWrite) {
      // One statement, and it CLEARS the cached access token rather than leaving it.
      //
      // The old access token is still valid for up to an hour, and it carries the *old* scope set. A
      // re-consent that removed a product would otherwise keep working against the removed API until
      // the cache expired, and the failure would arrive an hour later with nothing to correlate it to.
      // The five columns plus the expiry go to null together; the CHECK constraint in 0016 requires it.
      const rows = await sql`
        update google_connections set
          google_email              = ${write.googleEmail},
          granted_scopes            = ${sql.array(write.grantedScopes as string[])},
          refresh_token_ct          = ${write.refreshToken.ct},
          refresh_token_nonce       = ${write.refreshToken.nonce},
          refresh_token_wrapped_key = ${write.refreshToken.wrappedKey},
          refresh_token_kid         = ${write.refreshToken.kid},
          refresh_token_aad_fp      = ${write.refreshToken.aadFingerprint},
          access_token_ct           = null,
          access_token_nonce        = null,
          access_token_wrapped_key  = null,
          access_token_kid          = null,
          access_token_aad_fp       = null,
          access_expires_at         = null,
          consent_at                = ${new Date(write.consentAt)},
          status                    = 'active',
          status_reason             = null
        where id = ${write.connectionId}
        returning id
      `
      if (rows.length === 0) {
        throw new AppError('not_found', `No Google connection with id ${write.connectionId}`)
      }
    },

    async updateCapabilityHealth(write: CapabilityHealthWrite) {
      // `is not distinct from` rather than `=`: resource_ref is null for a capability whose resource
      // nobody has chosen yet, and `null = null` is null, so `=` would match no row and the write would
      // silently do nothing. The index this mirrors is NULLS NOT DISTINCT for the same reason.
      const resourceRef = write.resourceRef === null ? null : sql.json(write.resourceRef as never)
      const rows = await sql`
        update google_capabilities set health = ${write.health}
        where connection_id = ${write.connectionId}
          and capability = ${write.capability}
          and resource_ref is not distinct from ${resourceRef}::jsonb
        returning id
      `
      if (rows.length === 0) {
        throw new AppError(
          'not_found',
          `No ${write.capability} capability on connection ${write.connectionId} for that resource`,
        )
      }
    },

    async selectCapabilityResource(write: CapabilityResourceWrite) {
      // The PRIMARY row, and that is the whole addressing scheme. `google_capability_one_primary` is a
      // partial unique index on (connection_id, capability) where is_primary, so at most one row can match
      // — which is what makes "the row a consumer gets when it asks for this capability without naming a
      // resource" a single row rather than whichever the plan happened to read. A consent registers exactly
      // one row per capability and marks it primary (G-CONN-02), so this is the row it created.
      //
      // Not an upsert: a capability with no row at all means no consent has registered it, and inserting
      // one here would create a resource selection against a grant that never included the scope. The
      // not_found below says so instead.
      const rows = await sql`
        update google_capabilities set
          resource_ref = ${sql.json(write.resourceRef as never)},
          verified_at  = ${new Date(write.verifiedAt)}
        where connection_id = ${write.connectionId}
          and capability = ${write.capability}
          and is_primary
        returning id
      `
      if (rows.length === 0) {
        throw new AppError(
          'not_found',
          `No primary ${write.capability} capability on connection ${write.connectionId}. A consent ` +
            'registers one per capability; without it there is nothing for a selection to fill.',
        )
      }
    },

    async recordCheckOutcome(write: CheckOutcomeWrite) {
      // `coalesce` on the parameter rather than a conditional statement: a failed pass must move
      // `last_checked_at` and must NOT move `last_ok_at`, and expressing that as two code paths is how
      // one of them ends up writing `now()` into both and reporting a broken connection as verified.
      const rows = await sql`
        update google_connections set
          last_ok_at      = coalesce(${write.lastOkAt === null ? null : new Date(write.lastOkAt)}, last_ok_at),
          last_checked_at = ${new Date(write.lastCheckedAt)}
        where id = ${write.connectionId}
        returning id
      `
      if (rows.length === 0) {
        throw new AppError('not_found', `No Google connection with id ${write.connectionId}`)
      }
    },

    async confirmedListing({ connectionId, capability }) {
      // The most recent `capability_changed` row that carries a listing. Ordered by `id desc` rather
      // than by `occurred_at desc`: the column defaults to `now()`, which is the transaction's start
      // time, so three rows written by one selection share it exactly — and the identity column is the
      // only tie-break that reflects insertion order. Ordering by the timestamp alone would return an
      // arbitrary one of the three, which is harmless while they agree and is the wrong answer the day
      // a re-pick lands in the same transaction as something else.
      const rows = await sql<
        {
          place_id: string | null
          title: string | null
          address: string | null
          occurred_at: Date
          actor_label: string | null
        }[]
      >`
        select detail->>'placeId'  as place_id,
               detail->>'title'    as title,
               detail->>'address'  as address,
               occurred_at,
               actor_label
        from google_connection_events
        where connection_id = ${connectionId}
          and event = 'capability_changed'
          and detail->>'capability' = ${capability}
          and detail ? 'placeId'
        order by id desc
        limit 1
      `
      const row = rows[0]
      if (row === undefined) return null
      // All three or nothing. A partial snapshot cannot be compared without inventing which fields
      // count, and "the title matches so the listing is fine" is exactly the answer that misses a
      // listing merged into another company's premises under the same name.
      if (row.place_id === null || row.title === null || row.address === null) return null
      return {
        placeId: row.place_id,
        title: row.title,
        address: row.address,
        confirmedAt: instant(row.occurred_at),
        actorLabel: row.actor_label,
      } satisfies ConfirmedListing
    },

    async recordStatus(write: StatusWrite) {
      const rows = await sql`
        update google_connections set
          status          = ${write.status},
          status_reason   = ${write.statusReason},
          last_checked_at = ${new Date(write.lastCheckedAt)}
        where id = ${write.connectionId}
        returning id
      `
      if (rows.length === 0) {
        throw new AppError('not_found', `No Google connection with id ${write.connectionId}`)
      }
    },

    async rewrapRefreshToken({ connectionId, refreshToken }) {
      // Five columns and nothing else. A rotation that could also write `status` would eventually be
      // asked to.
      const rows = await sql`
        update google_connections set
          refresh_token_ct          = ${refreshToken.ct},
          refresh_token_nonce       = ${refreshToken.nonce},
          refresh_token_wrapped_key = ${refreshToken.wrappedKey},
          refresh_token_kid         = ${refreshToken.kid},
          refresh_token_aad_fp      = ${refreshToken.aadFingerprint}
        where id = ${connectionId}
        returning id
      `
      if (rows.length === 0) {
        throw new AppError('not_found', `No Google connection with id ${connectionId}`)
      }
    },

    async pendingRevocations() {
      // `status_reason` rather than a flag column: the state already has a canonical spelling and a second
      // representation of it would be a second thing to keep in step. Ordered by id so a pass and the pass
      // resuming it visit the rows in the same order, the way `listAll` does.
      const rows = await sql<ConnectionRow[]>`
        select ${sql.unsafe(SELECT_COLUMNS)} from google_connections
        where status_reason = 'revoke_failed' and refresh_token_ct is not null
        order by id
      `
      return rows.map(toRecord)
    },

    async disconnect(write: DisconnectWrite) {
      // `sql.begin` **inside** the store, which nothing else in this file does, and the reason is that
      // the three writes below are one fact. The zeroised columns and the append-only events that record
      // why they were zeroised have to commit together: a row with no credential and no `disconnected`
      // event beside it is a connection that stopped working with nothing anywhere to say why, and
      // because the credential is gone there is no second chance to write the record. On a caller that
      // already holds a transaction (the retry job's unit of work) postgres.js makes this a SAVEPOINT,
      // so the atomicity composes rather than conflicting.
      //
      // The revocation is NOT in here. An HTTPS call inside this transaction would hold a pooled
      // connection and a row lock for its duration, and a call that threw would roll back the disconnect
      // it had just achieved — which is the defect G-CONN-06 fixed one module over.
      await sql.begin(async (tx) => {
        const rows = await tx`
          update google_connections set
            status          = 'disconnected',
            status_reason   = ${write.statusReason},
            last_checked_at = ${new Date(write.at)},
            -- All eleven columns, in one statement, or none of them. Both CHECK constraints —
            -- google_connections_refresh_token_complete (0040) and
            -- google_connections_access_token_complete (0016) — are all-or-nothing, so a partial wipe
            -- is refused by the database rather than left as a row that cannot be opened, cannot be
            -- re-wrapped and cannot be told apart from corruption.
            refresh_token_ct          = case when ${write.zeroise}::boolean then null else refresh_token_ct end,
            refresh_token_nonce       = case when ${write.zeroise}::boolean then null else refresh_token_nonce end,
            refresh_token_wrapped_key = case when ${write.zeroise}::boolean then null else refresh_token_wrapped_key end,
            refresh_token_kid         = case when ${write.zeroise}::boolean then null else refresh_token_kid end,
            refresh_token_aad_fp      = case when ${write.zeroise}::boolean then null else refresh_token_aad_fp end,
            -- The cached access token goes unconditionally, whatever the revocation said. It is an hour
            -- of full authority over the listing and nothing can legitimately spend it again: every
            -- reader is behind loadActiveConnection, which refuses a disconnected row. Keeping it
            -- until it expires would be a live bearer credential on a connection an operator has been
            -- told is disconnected.
            access_token_ct           = null,
            access_token_nonce        = null,
            access_token_wrapped_key  = null,
            access_token_kid          = null,
            access_token_aad_fp       = null,
            access_expires_at         = null
          where id = ${write.connectionId}
          returning id
        `
        if (rows.length === 0) {
          throw new AppError('not_found', `No Google connection with id ${write.connectionId}`)
        }
        for (const event of write.events) {
          await tx`
            insert into google_connection_events
              (connection_id, google_sub, event, actor_kind, actor_label, detail)
            values (${event.connectionId}, ${event.googleSub}, ${event.event},
                    ${event.actorKind ?? 'system'}, ${event.actorLabel ?? null},
                    ${tx.json((event.detail ?? {}) as never)})
          `
        }
      })
    },

    async appendEvent(event: ConnectionEventInput) {
      await sql`
        insert into google_connection_events
          (connection_id, google_sub, event, actor_kind, actor_label, detail)
        values (${event.connectionId}, ${event.googleSub}, ${event.event},
                ${event.actorKind ?? 'system'}, ${event.actorLabel ?? null},
                ${sql.json((event.detail ?? {}) as never)})
      `
    },

    async allocateId() {
      // The database generates it so every id in the system comes from one generator, and so the
      // time-ordering that makes UUIDv7 index well is not lost to a client with a skewed clock.
      const rows = await sql<{ id: string }[]>`select uuid_generate_v7() as id`
      const id = rows[0]?.id
      if (id === undefined) {
        throw new AppError('invariant_violated', 'uuid_generate_v7() returned nothing')
      }
      return id
    },

    async insert(connection: NewConnection) {
      const rows = await sql<{ id: string }[]>`
        insert into google_connections
          (id, google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
           refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, consent_at, created_by)
        values (${connection.id}, ${connection.googleSub}, ${connection.googleEmail},
                ${sql.array(connection.grantedScopes as string[])},
                ${connection.refreshToken.ct}, ${connection.refreshToken.nonce},
                ${connection.refreshToken.wrappedKey}, ${connection.refreshToken.kid},
                ${connection.refreshToken.aadFingerprint}, ${new Date(connection.consentAt)},
                ${connection.createdBy ?? null})
        returning id
      `
      const id = rows[0]?.id
      if (id === undefined) {
        throw new AppError('invariant_violated', 'Inserting a Google connection returned no id')
      }
      return id
    },

    async upsertCapability(capability: GoogleCapabilityRecord) {
      await sql`
        insert into google_capabilities
          (connection_id, capability, resource_ref, health, is_primary)
        values (${capability.connectionId}, ${capability.capability},
                ${capability.resourceRef === null ? null : sql.json(capability.resourceRef as never)},
                ${capability.health}, ${capability.isPrimary})
      `
    },
  }
}

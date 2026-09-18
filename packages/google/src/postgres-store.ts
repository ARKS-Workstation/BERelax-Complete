import type {
  GoogleCapability,
  GoogleCapabilityHealth,
  GoogleConnectionStatus,
  Instant,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type {
  ConnectionEventInput,
  GoogleCapabilityRecord,
  GoogleConnectionRecord,
  GoogleConnectionStore,
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
  readonly refresh_token_ct: Buffer
  readonly refresh_token_nonce: Buffer
  readonly refresh_token_wrapped_key: Buffer
  readonly refresh_token_kid: string
  readonly refresh_token_aad_fp: string
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
    refreshToken: {
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

/**
 * Input for the first write of a connection. Used by the seed path and by G-CONN-02's consent flow.
 *
 * The id is supplied rather than defaulted, because the AAD binds the ciphertext to its own row: the
 * id has to exist before the token can be sealed. `allocateId` produces one.
 */
export interface NewConnection {
  readonly id: string
  readonly googleSub: string
  readonly googleEmail: string
  readonly grantedScopes: readonly string[]
  readonly refreshToken: SealedToken
  readonly consentAt: Instant
  readonly createdBy?: string
}

export function createPostgresConnectionStore(sql: Sql): GoogleConnectionStore & {
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
        where id = ${write.connectionId}
        returning id
      `
      if (rows.length === 0) {
        throw new AppError('not_found', `No Google connection with id ${write.connectionId}`)
      }
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

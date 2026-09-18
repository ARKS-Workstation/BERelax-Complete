import type {
  GoogleCapability,
  GoogleCapabilityHealth,
  GoogleConnectionEventName,
  GoogleConnectionStatus,
  Instant,
} from '@berelax/core'
import type { SealedToken } from './token-store.ts'

/**
 * The persistence seam for the Google connection.
 *
 * An interface rather than a class, for the same reason the clinical store is one: the token columns
 * are the most sensitive rows in the `public` schema, and a seam here is what lets a test exercise the
 * whole lifecycle — including the `invalid_grant` path — with no database, while the Postgres
 * implementation is proved separately against a real one.
 *
 * Note what is NOT here: any method returning a plaintext token. The store moves sealed columns; only
 * `lifecycle.ts` ever holds a decrypted token, and only for the duration of one call.
 */

export interface GoogleConnectionRecord {
  readonly id: string
  /** The identity key. */
  readonly googleSub: string
  /** Display only. */
  readonly googleEmail: string
  /** What Google returned. */
  readonly grantedScopes: readonly string[]
  readonly status: GoogleConnectionStatus
  readonly statusReason: string | null
  readonly consentAt: Instant
  readonly lastOkAt: Instant | null
  readonly lastCheckedAt: Instant | null
  readonly accessExpiresAt: Instant | null
  readonly refreshToken: SealedToken
  /** Null until a token has been fetched, and after a re-auth clears the stale cache. */
  readonly accessToken: SealedToken | null
}

export interface GoogleCapabilityRecord {
  readonly connectionId: string
  readonly capability: GoogleCapability
  readonly resourceRef: Readonly<Record<string, unknown>> | null
  readonly health: GoogleCapabilityHealth
  readonly isPrimary: boolean
}

export interface ConnectionEventInput {
  /** Null when the event precedes any connection row, e.g. an admin policy refusal at authorisation. */
  readonly connectionId: string | null
  readonly googleSub: string | null
  readonly event: GoogleConnectionEventName
  readonly actorKind?: 'staff' | 'customer' | 'system' | 'agent'
  readonly actorLabel?: string
  /**
   * Structured context. **Never a token.** A CHECK constraint refuses a payload carrying a token key,
   * because rows reach query logs, `pg_stat_statements`, backups and pg-boss job payloads.
   */
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface RefreshWrite {
  readonly connectionId: string
  readonly accessToken: SealedToken
  readonly accessExpiresAt: Instant
  /**
   * Present only when Google returned a new refresh token.
   *
   * Google normally returns the same one, but silently discarding a rotated token is a time bomb: the
   * old one stops working at a moment nobody can correlate with a deploy.
   */
  readonly refreshToken?: SealedToken
  readonly lastOkAt: Instant
  readonly status: GoogleConnectionStatus
  readonly statusReason: string | null
}

export interface StatusWrite {
  readonly connectionId: string
  readonly status: GoogleConnectionStatus
  readonly statusReason: string | null
  readonly lastCheckedAt: Instant
}

export interface GoogleConnectionStore {
  load(connectionId: string): Promise<GoogleConnectionRecord | null>
  /** Every connection, for the re-wrap job and the daily health check. */
  listAll(): Promise<readonly GoogleConnectionRecord[]>
  capabilitiesFor(connectionId: string): Promise<readonly GoogleCapabilityRecord[]>
  recordRefresh(write: RefreshWrite): Promise<void>
  recordStatus(write: StatusWrite): Promise<void>
  /**
   * Replaces the refresh token's sealed columns and nothing else.
   *
   * Deliberately narrow: a key rotation must not be able to change a status or a capability, and the
   * cheapest way to guarantee that is a method that cannot express it.
   */
  rewrapRefreshToken(args: {
    readonly connectionId: string
    readonly refreshToken: SealedToken
  }): Promise<void>
  appendEvent(event: ConnectionEventInput): Promise<void>
}

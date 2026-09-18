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

/**
 * A re-consent of an existing connection: a new refresh token and a new granted-scope set.
 *
 * Deliberately cannot express a change of `google_sub`. A re-consent that arrived with a different sub
 * is a **different Google account**, and the only safe thing to do with it is insert a second row and
 * say so loudly — silently swapping the sub under a connection's capabilities is how a review reply
 * reaches another business's listing (docs/10 §5).
 */
export interface ConsentWrite {
  readonly connectionId: string
  /** Display only, but it does change: a Workspace rename arrives on the next consent. */
  readonly googleEmail: string
  readonly grantedScopes: readonly string[]
  readonly refreshToken: SealedToken
  readonly consentAt: Instant
}

export interface CapabilityHealthWrite {
  readonly connectionId: string
  readonly capability: GoogleCapability
  /** Identifies the row together with the capability; never overwritten by a consent. */
  readonly resourceRef: Readonly<Record<string, unknown>> | null
  readonly health: GoogleCapabilityHealth
}

export interface GoogleConnectionStore {
  load(connectionId: string): Promise<GoogleConnectionRecord | null>
  /**
   * The connection for a Google account, by the identity key.
   *
   * `google_sub` is UNIQUE, so this returns at most one row — which is what makes "matching sub is a
   * re-auth" a decidable question rather than a heuristic over email addresses.
   */
  loadBySub(googleSub: string): Promise<GoogleConnectionRecord | null>
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

/**
 * What the consent flow needs on top of the lifecycle store.
 *
 * A separate interface rather than more methods on `GoogleConnectionStore`, so the re-wrap job and the
 * health check cannot reach an insert: the narrowest seam that expresses a job's needs is the cheapest
 * way to guarantee it does nothing else (the same argument as `rewrapRefreshToken`).
 */
export interface GoogleConsentStore {
  loadBySub(googleSub: string): Promise<GoogleConnectionRecord | null>
  /** Every connection, so a second account's arrival can name the incumbent it did not replace. */
  listAll(): Promise<readonly GoogleConnectionRecord[]>
  capabilitiesFor(connectionId: string): Promise<readonly GoogleCapabilityRecord[]>
  /**
   * Whether an authorization code with this fingerprint has already produced a connection.
   *
   * The durable half of replay rejection. A `state` cookie is cleared by a successful exchange, so it
   * can only report *"no authorization in flight"* — which is the same answer a CSRF attempt gets, and
   * conflating the two leaves nobody able to tell a replay from a forgery. The fingerprint is recorded
   * on the append-only event the consent wrote, so the evidence outlives the browser.
   */
  authorizationCodeSeen(fingerprint: string): Promise<boolean>
  allocateId(): Promise<string>
  insert(connection: NewConnection): Promise<string>
  recordConsent(write: ConsentWrite): Promise<void>
  upsertCapability(capability: GoogleCapabilityRecord): Promise<void>
  updateCapabilityHealth(write: CapabilityHealthWrite): Promise<void>
  appendEvent(event: ConnectionEventInput): Promise<void>
}

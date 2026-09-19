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

/**
 * The one write a resource selection makes: which Google resource this capability now serves.
 *
 * Deliberately cannot express a health, a status or a token. A selection is evidence that the resource
 * **resolves** — the picker re-read it from Google before writing — and nothing more: `ok` means every
 * capability read succeeded and stays G-CONN-06's to write, because the read that confirmed a location
 * through Business Information v1 says nothing about whether the legacy v4 reviews path works. So this
 * carries `verifiedAt`, which records that a read happened, and leaves `health` alone.
 *
 * `resourceRef` is not nullable here. Clearing a selection is a different operation with a different
 * consequence — every consumer of that capability degrades — and the narrowest write that expresses
 * "choose this one" is the cheapest way to guarantee it cannot silently do the other thing.
 */
export interface CapabilityResourceWrite {
  readonly connectionId: string
  readonly capability: GoogleCapability
  readonly resourceRef: Readonly<Record<string, unknown>>
  /** When the resource was last read back from Google. Written to `verified_at`. */
  readonly verifiedAt: Instant
}

/**
 * What the picker needs, and nothing else.
 *
 * A third interface beside `GoogleConnectionStore` and `GoogleConsentStore` rather than more methods on
 * either, for the reason the other two already give: the narrowest seam that expresses what a caller needs
 * is the cheapest way to guarantee it does nothing else. The picker chooses a resource and records that it
 * did. It cannot insert a connection, exchange a consent, replace a token or change a status — and it is a
 * surface an admin clicks, which is the surface where "while we are here" changes accumulate.
 */
export interface GoogleCapabilitySelectionStore {
  capabilitiesFor(connectionId: string): Promise<readonly GoogleCapabilityRecord[]>
  selectCapabilityResource(write: CapabilityResourceWrite): Promise<void>
  appendEvent(event: ConnectionEventInput): Promise<void>
}

export interface CapabilityHealthWrite {
  readonly connectionId: string
  readonly capability: GoogleCapability
  /** Identifies the row together with the capability; never overwritten by a consent. */
  readonly resourceRef: Readonly<Record<string, unknown>> | null
  readonly health: GoogleCapabilityHealth
}

/**
 * What the daily health run and the hourly liveness probe write about a connection as a whole.
 *
 * `lastOkAt` is nullable and that nullability is the whole point. `recordRefresh` moves `last_ok_at`
 * because a refresh **is** a successful authenticated call, but a health pass that read a location
 * without needing a new token has also just proved the connection works — and nothing else in the
 * store could say so. Without this write, a connection whose token has fifty minutes left is silently
 * un-verifiable: the deep check succeeds, `last_ok_at` stays where it was, and after 48 hours
 * `deriveConnectionHealth` calls a working connection `degraded`.
 *
 * A pass that failed writes `lastOkAt: null` and still moves `lastCheckedAt`, so *"we looked and it did
 * not work"* is distinguishable from *"nothing has looked"*. Those need different actions and the panel
 * shows different things for each.
 */
export interface CheckOutcomeWrite {
  readonly connectionId: string
  /** Null when nothing in the pass reached Google. Never a guess. */
  readonly lastOkAt: Instant | null
  readonly lastCheckedAt: Instant
}

/**
 * The listing the owner confirmed, read back out of the append-only event the picker wrote.
 *
 * Deliberately **not** a new table. The `capability_changed` row G-CONN-05 appends when somebody picks
 * a listing already is the record of what was confirmed, when, and by whom: it is append-only, it is
 * mirrored into `audit_event` by a trigger in the same transaction, and it is what the connection panel
 * renders. A `google_listing_snapshot` table beside it would be a second answer to one question, and
 * the interesting case — *which* of the two is what the owner actually clicked — would have no answer
 * at all. It also could only be filled by this unit, which would mean comparing a listing against a
 * snapshot taken from the same read: a check that cannot fail.
 */
export interface ConfirmedListing {
  readonly placeId: string
  readonly title: string
  readonly address: string
  readonly confirmedAt: Instant
  /** Who chose it, as the event recorded them. Null for a row written before actors were carried. */
  readonly actorLabel: string | null
}

/**
 * What the daily health check needs, and nothing else.
 *
 * A fourth narrow seam beside `GoogleConnectionStore`, `GoogleConsentStore` and
 * `GoogleCapabilitySelectionStore`, for the reason the other three already give: the narrowest
 * interface that expresses what a caller needs is the cheapest way to guarantee it does nothing else.
 * A health check reads, writes a health, records that it looked, and appends an event. It cannot insert
 * a connection, exchange a consent, choose a resource or touch a token column — and it is a cron, which
 * is the one caller nobody is watching while it runs.
 */
export interface GoogleHealthStore {
  listAll(): Promise<readonly GoogleConnectionRecord[]>
  /**
   * Re-reads one connection after the pass has made its calls.
   *
   * Needed because the pass can change the thing it is describing. A forced refresh that comes back
   * `invalid_grant` moves `status` to `needs_reauth` *inside* the pass, and a summary derived from the row
   * as it was loaded would report the connection `healthy` in the same breath as recording that its grant
   * is dead. That is not a cosmetic inconsistency: `displayState` is what the banner and the email read.
   */
  load(connectionId: string): Promise<GoogleConnectionRecord | null>
  capabilitiesFor(connectionId: string): Promise<readonly GoogleCapabilityRecord[]>
  confirmedListing(args: {
    readonly connectionId: string
    readonly capability: GoogleCapability
  }): Promise<ConfirmedListing | null>
  updateCapabilityHealth(write: CapabilityHealthWrite): Promise<void>
  recordCheckOutcome(write: CheckOutcomeWrite): Promise<void>
  appendEvent(event: ConnectionEventInput): Promise<void>
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

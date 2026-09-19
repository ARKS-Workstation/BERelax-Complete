import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of the Google connection tables (migration 0016).
 *
 * Hand-written because migrations are SQL-first (ADR 0006); `pnpm db:drift` compares this against the
 * live database in both directions.
 *
 * Two shapes here look like omissions and are not:
 *
 *   - `googleEmail` carries no unique index. The identity key is `googleSub`, and keying on an email
 *     address means a renamed Google account becomes a second connection while the first keeps being
 *     refreshed. docs/10 §2.
 *   - `googleCapability` has no unique on (connectionId, capability). One account may be verified on
 *     several Search Console properties and manage several locations; what is unique is which of them
 *     is primary.
 */

/** Ciphertext columns. Same representation as the clinical payloads in migration 0008. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const googleConnection = pgTable(
  'google_connections',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The stable subject from the id_token. The identity key, never the email address. */
    googleSub: text('google_sub').notNull(),
    /** Display only. A user can change it, so nothing keys on it. */
    googleEmail: text('google_email').notNull(),
    /** What Google returned, not what was requested. */
    grantedScopes: text('granted_scopes').array().notNull(),
    /**
     * The five sealed refresh-token columns. NULLABLE since migration 0040.
     *
     * They were NOT NULL, which made zeroisation impossible: the only way to "delete" a token was to
     * overwrite it with another ciphertext. A disconnect revokes at Google and then NULLs all five
     * together, fenced by three named CHECK constraints — all-or-none, only a terminal status may hold
     * none, and a row parked in `revoke_failed` must keep its ciphertext because that is the retry's
     * only credential. `pnpm db:drift` compares columns, so those constraints live in the SQL alone.
     */
    refreshTokenCt: bytea('refresh_token_ct'),
    refreshTokenNonce: bytea('refresh_token_nonce'),
    refreshTokenWrappedKey: bytea('refresh_token_wrapped_key'),
    /** KEK version. Present exactly when the ciphertext is, so the rotation job knows what to move. */
    refreshTokenKid: text('refresh_token_kid'),
    refreshTokenAadFp: text('refresh_token_aad_fp'),
    accessTokenCt: bytea('access_token_ct'),
    accessTokenNonce: bytea('access_token_nonce'),
    accessTokenWrappedKey: bytea('access_token_wrapped_key'),
    accessTokenKid: text('access_token_kid'),
    accessTokenAadFp: text('access_token_aad_fp'),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    /** The state of the grant: active | needs_reauth | revoked | disconnected. */
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    /** Consent instant. The Testing-status expiry is seven days after this. */
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('google_connections_google_sub_key').on(t.googleSub),
    index('google_connections_status_idx').on(t.status),
    index('google_connections_last_ok_idx').on(t.lastOkAt),
  ],
)

export const googleCapability = pgTable(
  'google_capabilities',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => googleConnection.id, { onDelete: 'cascade' }),
    /** gbp_reviews | gbp_location | gbp_performance | gsc */
    capability: text('capability').notNull(),
    /** {account, location, placeId} or {siteUrl}. */
    resourceRef: jsonb('resource_ref'),
    /** ok | permission_missing | not_verified | quota_zero | unknown */
    health: text('health').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** `primary` is reserved in SQL, hence the name. */
    isPrimary: boolean('is_primary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Partial: many rows may share a capability, at most one of them is primary.
    uniqueIndex('google_capability_one_primary')
      .on(t.connectionId, t.capability)
      .where(sql`is_primary`),
    index('google_capabilities_connection_idx').on(t.connectionId),
  ],
)

/** Append-only in the database, and mirrored into `audit_event` by a trigger. */
export const googleConnectionEvent = pgTable(
  'google_connection_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    /**
     * A plain uuid, not a foreign key — as on `audit_event`. An admin-policy refusal happens before
     * any connection row exists, and an append-only log whose rows a delete can rewrite is not a log.
     */
    connectionId: uuid('connection_id'),
    googleSub: text('google_sub'),
    event: text('event').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label'),
    /** A check constraint refuses a payload carrying a token key. Rows reach query logs. */
    detail: jsonb('detail').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('google_connection_events_connection_idx').on(t.connectionId, t.occurredAt),
    index('google_connection_events_event_idx').on(t.event, t.occurredAt),
  ],
)

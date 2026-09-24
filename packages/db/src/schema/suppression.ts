import { sql } from 'drizzle-orm'
import {
  index,
  inet,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { messageChannel } from './messaging.ts'

/**
 * Drizzle mirror of 0064_suppression.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Four things the mirror cannot say, and each of them will bite somebody who builds a write from these
 * definitions rather than calling `packages/db/src/repositories/suppression.ts`:
 *
 *   - **`suppression` is append-only.** `update` and `delete` are revoked from `berelax_app` AND refused
 *     by a BEFORE trigger for every role including the owner (ZQ001). `db.update(suppression)` typechecks
 *     perfectly and raises at run time, which is the correct outcome: removing somebody from the list is a
 *     NEW row with `kind: 'unsuppressed'` carrying its own actor and reason.
 *   - **`keyHmac` is never a phone number or an address.** It is the lower-case hex of
 *     HMAC-SHA256(normalised recipient, `SUPPRESSION_PEPPER`), and a CHECK refuses anything that is not 64
 *     hex characters. `suppressionKey` in the repository is the only thing that should ever produce one; a
 *     value built anywhere else is either a plaintext the CHECK will reject or a digest under the wrong
 *     pepper, which matches nothing and reports no error.
 *   - **`recordedAt`, `issuedAt`, `expiresAt` and `attemptedAt` have no default.** All four are supplied
 *     from an injected clock, because every ordering, expiry and rate-limit assertion in this area is made
 *     under a frozen one.
 *   - **`optoutGrant` is revoked by DELETE, not by a column.** There is no `revoked_at` to set: the row
 *     goes and the `audit_event` for the minting stays, which is the shape `obligation_evidence_grant`
 *     established. So this table is deliberately NOT append-only while the one above it is.
 *
 * Neither `suppression.contactCustomerId` nor `optoutGrant.contactCustomerId` is a foreign key to
 * `customer`, so there is no relation to declare here and `db.delete(customer)` is not blocked by either.
 * 0064's header says why twice: an append-only log cannot hold a reference to a mutable parent, and a
 * cascade would additionally make `truncate customer` raise in every integration file that clears the
 * table without naming these.
 */

/** Where a suppression came from. Closed; `SUPPRESSION_SOURCES` in `@berelax/shared` is the mirror. */
export const suppressionSource = pgEnum('suppression_source', [
  'manual',
  'complaint',
  'hard_bounce',
  'dnc_register',
  'preference_centre',
])

/** `suppressed` or `unsuppressed`. "Never suppressed" is the absence of a row and is never stored. */
export const suppressionKind = pgEnum('suppression_kind', ['suppressed', 'unsuppressed'])

export const suppression = pgTable(
  'suppression',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** `phone` or `email`, behind a CHECK. The same two labels `customer_blocklist.key_kind` uses. */
    keyKind: text('key_kind').notNull(),
    /** 64 lower-case hex characters. Never a recipient; see the header. */
    keyHmac: text('key_hmac').notNull(),
    /** The LABEL of the pepper this row was keyed under. Never the pepper. */
    pepperVersion: text('pepper_version').notNull(),
    kind: suppressionKind('kind').notNull(),
    source: suppressionSource('source').notNull(),
    reason: text('reason').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    /** When the decision was made. Supplied, never defaulted. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Which record the entry is about, when one is known. Never matched on, and not a foreign key. */
    contactCustomerId: uuid('contact_customer_id'),
    /** When the ROW landed, as distinct from when the decision was made. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('suppression_one_record_per_instant').on(
      t.keyKind,
      t.keyHmac,
      t.kind,
      t.recordedAt,
    ),
    index('suppression_key_idx').on(t.keyHmac, t.keyKind, t.recordedAt),
    index('suppression_contact_idx').on(t.contactCustomerId),
    index('suppression_source_idx').on(t.source, t.recordedAt),
  ],
)

export const optoutGrant = pgTable(
  'optout_grant',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The sha256 of the token, hex, never the token. Unique, behind a 64-hex CHECK. */
    tokenSha256: text('token_sha256').notNull(),
    /** Who the link is for. A plain uuid, not a foreign key; see the header. */
    contactCustomerId: uuid('contact_customer_id').notNull(),
    /** One legal value today (`preference_centre`), and a column so a second one cannot be retroactive. */
    purpose: text('purpose').notNull(),
    /** Which message carried the link. `message_channel` since 0014. */
    channel: messageChannel('channel').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('optout_grant_contact_idx').on(t.contactCustomerId, t.expiresAt),
    index('optout_grant_expiry_idx').on(t.expiresAt),
  ],
)

/**
 * One row per verification, which IS the rate limit.
 *
 * `requestIp` is NOT NULL here and nullable on `otp_challenge`, and the difference is deliberate: the OTP
 * endpoint has a per-number limit that still binds when the edge supplies no address, and this endpoint has
 * one dimension and nothing to fall back on. The route refuses an unattributable request by name rather
 * than recording one it cannot count.
 */
export const optoutVerificationAttempt = pgTable(
  'optout_verification_attempt',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    requestIp: inet('request_ip').notNull(),
    /** Supplied from the caller's clock, never `now()`: the window assertions use a frozen one. */
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    /** Pinned to `OPT_OUT_ATTEMPT_OUTCOMES` in `@berelax/core` by the integration suite. */
    outcome: text('outcome').notNull(),
  },
  (t) => [index('optout_verification_attempt_ip_idx').on(t.requestIp, t.attemptedAt)],
)

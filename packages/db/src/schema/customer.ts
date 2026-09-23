import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  inet,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0019_customer_identity.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Two columns here are not writable and the mirror cannot say so, which is worth knowing before
 * somebody builds an insert from these definitions:
 *
 *   - `customer.phone_match_key` is GENERATED ALWAYS in the database. Passing a value for it makes
 *     Postgres raise, which is the correct outcome: the match key is derived from `phone_e164` and a
 *     caller-supplied one would be a second opinion about the same nine digits.
 *   - `otp_challenge.issued_at` and `expires_at` have no default. Both are supplied from an injected
 *     clock, because every expiry assertion in this unit is made under a frozen one.
 */

/** The hash and its salt. Same representation as the ciphertext columns in 0008 and 0016. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const otpPurpose = pgEnum('otp_purpose', [
  'booking_verify',
  'view_bookings',
  'clinical_flags',
])

export const customer = pgTable(
  'customer',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Canonical E.164 and the identity itself: UNIQUE, so two spellings collide rather than split. */
    phoneE164: text('phone_e164').notNull().unique(),
    /** Generated in the database: the trailing nine digits. The merge candidate key, never the identity. */
    phoneMatchKey: text('phone_match_key').notNull(),
    /** Null until an admin enters one. No customer name is ever invented (ADR 0020). */
    displayName: text('display_name'),
    /** normalised-name + last-4, written by the application from `@berelax/core`. */
    nameMatchKey: text('name_match_key'),
    locale: text('locale').notNull(),
    /** Null for a guest booking. Verification gates reading data back, never taking a booking. */
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    createdVia: text('created_via').notNull(),
    notes: text('notes'),
    /**
     * The CRM columns, added expand-only by 0053 (C-CRM-01).
     *
     * `lifecycleState` and `acquisitionSource` are `text` with a foreign key into a vocabulary TABLE
     * rather than a `pgEnum`, because both vocabularies are provisional and an enum label cannot carry
     * `is_provisional`, an OPEN-QUESTIONS id or a note. `./crm.ts` holds those two tables.
     *
     * `isVip` and `vipSince` are one fact said twice and the database refuses a disagreement
     * (`customer_vip_since_matches_flag`), so an insert that sets the flag and not the date raises.
     */
    lifecycleState: text('lifecycle_state').notNull(),
    lifecycleChangedAt: timestamp('lifecycle_state_changed_at', { withTimezone: true }).notNull(),
    acquisitionSource: text('acquisition_source').notNull(),
    isVip: boolean('is_vip').notNull(),
    vipSince: timestamp('vip_since', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('customer_phone_match_key_idx').on(t.phoneMatchKey),
    index('customer_name_match_key_idx').on(t.nameMatchKey),
    index('customer_lifecycle_state_idx').on(t.lifecycleState, t.lifecycleChangedAt),
  ],
)

export const otpChallenge = pgTable(
  'otp_challenge',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Not a foreign key to `customer`: a challenge for an unknown number must exist. */
    phoneE164: text('phone_e164').notNull(),
    purpose: otpPurpose('purpose').notNull(),
    /** HMAC-SHA-256 of the code under `codeSalt`. The code itself is stored nowhere. */
    codeHash: bytea('code_hash').notNull(),
    codeSalt: bytea('code_salt').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Single use: set on the successful verification. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Set when a newer code replaces this one, so only the newest code verifies. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    failedAttempts: smallint('failed_attempts').notNull(),
    requestIp: inet('request_ip'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('otp_challenge_phone_idx').on(t.phoneE164, t.issuedAt),
    index('otp_challenge_ip_idx').on(t.requestIp, t.issuedAt),
  ],
)

export const otpPhoneLock = pgTable('otp_phone_lock', {
  phoneE164: text('phone_e164').primaryKey(),
  /** Per NUMBER, not per challenge: a new code must not reset the guess count. */
  consecutiveFailures: smallint('consecutive_failures').notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

import { sql } from 'drizzle-orm'
import { customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of `packages/db/migrations/0062_booking_session.sql` (B-UI-02).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these declarations against the live database in both directions.
 *
 * Three things the mirror cannot say, and each of them will bite somebody who builds a write from these
 * declarations rather than calling `packages/db/src/repositories/booking-session.ts`:
 *
 *   - **`tokenHash` is a digest and never the token.** The repository hashes; a caller that put a cookie
 *     value in this column would typecheck and would store a live bearer credential. The column CHECKs
 *     its length at 32 octets, which catches a raw 32-byte token only by accident and is there for the
 *     honest mistake of storing a truncated digest.
 *   - **`verifiedAt` and `customerId` are one fact.** A CHECK makes them null together or set together
 *     (`booking_session_verification_names_a_customer`), so `db.update` setting one raises. `verifyBookingSession`
 *     sets both in one statement.
 *   - **`bookingId` may only be set on a verified row** (`booking_session_booking_requires_verification`).
 *
 * Neither `customerId` nor `bookingId` is a foreign key, so there is no relation to declare and no
 * `TRUNCATE` of `appointment` or `DELETE` from `customer` is refused because of this table. The
 * migration's header gives both reasons.
 */

/** The token digest. Same representation as the ciphertext columns in 0008 and 0016. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const bookingSession = pgTable(
  'booking_session',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** SHA-256 of the cookie's 32 random bytes. UNIQUE: it is what a request is resolved by. */
    tokenHash: bytea('token_hash').notNull().unique(),
    /** Normalised E.164. Not a foreign key to `customer`; a session exists before anybody is known. */
    phoneE164: text('phone_e164').notNull(),
    /** Plain uuid, not a foreign key. Null until the code is verified. */
    customerId: uuid('customer_id'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** Supplied from an injected clock, never defaulted: expiry is asserted under a frozen one. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Plain uuid, not a foreign key. Null until the confirm step commits. */
    bookingId: uuid('booking_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('booking_session_phone_idx').on(t.phoneE164, t.createdAt),
    index('booking_session_expires_at_idx').on(t.expiresAt),
  ],
)

import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of `packages/db/migrations/0067_booking_manage_grant.sql` (B-UI-05).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these declarations against the live database in both directions.
 *
 * Three things the mirror cannot say, and each will bite somebody who builds a write from these
 * declarations rather than calling `packages/db/src/repositories/booking-token.ts`:
 *
 *   - **`tokenSha256` is a digest and never the token.** The repository mints and hashes; a caller that
 *     put the link's own token in this column would typecheck and would store a live bearer credential
 *     for somebody's booking. The column CHECKs the 64-lower-case-hex shape, which catches the honest
 *     mistake of storing a truncated or upper-cased digest and cannot catch a caller storing a token that
 *     happens to look like one.
 *   - **`expiresAt` is the appointment's end plus 24 hours**, computed by `bookingTokenExpiry` in
 *     `@berelax/core` and stored. Nothing in the schema derives it, so a `db.insert` here can write any
 *     expiry at all; `booking_manage_grant_expires_after_issue` only refuses one already in the past.
 *   - **UPDATE is revoked for `berelax_app`.** There is no legitimate edit to a capability — a different
 *     expiry or a different booking is a different grant — so `db.update(bookingManageGrant)` raises
 *     rather than moving a live link onto another booking in one statement.
 *
 * `bookingId` references NOTHING, exactly as `invoice.bookingId` and `checkoutIdempotency.bookingId` do,
 * and the migration's header records why it was a real `ON DELETE CASCADE` key first: four integration
 * suites `truncate booking_idempotency, appointment_status_history, scheduled_step, appointment, booking`
 * by an explicit list, and PostgreSQL refuses a truncate while a referencing table is absent from the
 * statement. The key turned all 24 of `booking-constraints.itest.ts`'s cases red in a file this unit never
 * touched — B-MSG-03's `scheduled_step` finding, arriving from the other table. So there is no relation to
 * declare here, and `db.delete(booking)` is not blocked by this table.
 */
export const bookingManageGrant = pgTable(
  'booking_manage_grant',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The sha256 of the token, lower-case hex, never the token. UNIQUE: it is what a request resolves by. */
    tokenSha256: text('token_sha256').notNull().unique(),
    /** The booking the link manages. No foreign key; see the header. */
    bookingId: uuid('booking_id').notNull(),
    /** One legal value today (`manage_booking`), and a column so a second one cannot be retroactive. */
    purpose: text('purpose').notNull(),
    /** Supplied from the caller's clock, never `now()`: the expiry assertions use a frozen one. */
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('booking_manage_grant_booking_idx').on(t.bookingId, t.expiresAt),
    index('booking_manage_grant_expiry_idx').on(t.expiresAt),
  ],
)

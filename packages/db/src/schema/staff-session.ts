import { sql } from 'drizzle-orm'
import { bigint, customType, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { employee } from './staff.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0090_admin_session.sql` (W-SYS-11).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these declarations against the live database in both directions.
 *
 * ## What the mirror cannot say, and why a caller must not build a write from it
 *
 * Use `packages/db/src/repositories/staff-session.ts`. Four constraints live in the database and none of
 * them is expressible here, so a `db.insert` assembled from these declarations typecheaks and then either
 * raises or — worse — succeeds with something wrong:
 *
 *   - **`passwordHash` must be a scrypt string**, `scrypt$N$r$p$salt$derived` from `hashPassword` in
 *     `@berelax/auth`. The column CHECKs the prefix, so storing a plaintext password raises rather than
 *     producing a login that never matches.
 *   - **`role` must be one of the eight `ROLES` declares.** The CHECK is a copy of a TypeScript constant
 *     that `apps/web/src/session.itest.ts` asserts cannot drift.
 *   - **`tokenHash` is a digest and never the token.** The repository hashes; a caller that put the
 *     cookie value here would typecheck and would store a live bearer credential for the admin estate.
 *     The column CHECKs 32 octets.
 *   - **`totpLastCounter` requires a secret.** Set together, by the verification.
 *
 * ## `staffSession` has no role, and that absence is the design
 *
 * There is no `role`, `permission` or `fieldGroup` column here and there must never be one. A request's
 * role is reached only by joining a live session to its credential, which is what makes a tampered cookie
 * name nothing rather than assert something, and what stops a session's authority from disagreeing with
 * its credential's after a demotion. The migration header gives the argument in full;
 * `apps/web/src/session.itest.ts` asserts the absence against `information_schema`, so adding such a
 * column fails a test rather than quietly restoring the forgeable shape.
 *
 * Neither table is seeded, in any environment. A deployment with no `staffCredential` row refuses every
 * login, and there is no bootstrap account — see the migration header.
 */

/** The token digest. Same representation as `booking_session.token_hash` (0062). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const staffCredential = pgTable('staff_credential', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  /** The employment record, not a person. UNIQUE: one sign-in per member of staff. RESTRICT on delete. */
  employeeId: uuid('employee_id')
    .notNull()
    .unique()
    .references(() => employee.id, { onDelete: 'restrict' }),
  /** One of `ROLES` in `@berelax/core/access`, CHECKed in the database. */
  role: text('role').notNull(),
  /** `scrypt$N$r$p$salt$derived` from `hashPassword`. Never a plaintext password; CHECKed. */
  passwordHash: text('password_hash').notNull(),
  /** Base32 seed, or null for "not enrolled" — which is a real login stage, not a missing value. */
  totpSecret: text('totp_secret'),
  /**
   * The newest counter accepted, so a code cannot be replayed inside its own 30-second window.
   *
   * `mode: 'number'` because a TOTP counter is `floor(epochSeconds / 30)` — about 5.9e7 today and under
   * 2^53 for the next billion years — so the bigint cannot lose precision, and `verifyTotp` takes and
   * returns a `number`. Left as a string it would compare as one, and `'60000000' <= '9'` is true.
   */
  totpLastCounter: bigint('totp_last_counter', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const staffSession = pgTable(
  'staff_session',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** CASCADE: revoking a credential must end the sessions it granted. */
    credentialId: uuid('credential_id')
      .notNull()
      .references(() => staffCredential.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie's 32 random bytes. UNIQUE: it is what a request is resolved by. */
    tokenHash: bytea('token_hash').notNull().unique(),
    /** Supplied from an injected clock, never defaulted: expiry is asserted under a frozen one. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set by signing out, so "ended" is distinguishable from "never existed". */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('staff_session_credential_idx').on(t.credentialId, t.createdAt),
    index('staff_session_expires_at_idx').on(t.expiresAt),
  ],
)

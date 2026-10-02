import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0121_customer_import.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Two things this mirror cannot say, both worth knowing before somebody builds an insert from it:
 *
 *   - **the table is append-only.** ZY272 raises on UPDATE and on DELETE for every role, and the
 *     application role holds neither privilege. A `db.update(importedContact)` compiles and cannot run,
 *     which is the correct outcome — a correction is a new import against the corrected file.
 *   - **`outcome` is held to the facts at COMMIT.** ZY273 walks this row's own provenance to the staged
 *     source row and refuses a `created` record with no customer behind it, or a `matched` or
 *     `quarantined` one whose line created a customer anyway. So a value written here is a claim the
 *     database checks, not a label.
 *
 * `contact_hmac` is the keyed digest of the number and never the number — H-MIG-04's answer to
 * Y9-import-ledger. The write path is `recordImportedContact` in
 * `packages/db/src/services/import-contacts.ts`, which is the only place the digest is computed.
 */
export const importedContact = pgTable(
  'imported_contact',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** `HMAC-SHA256(json(value), SUPPRESSION_PEPPER)`, lower-case hex. Never a phone number. */
    contactHmac: text('contact_hmac').notNull(),
    /** The LABEL of the pepper that keyed it, never the pepper. */
    pepperVersion: text('pepper_version').notNull(),
    /** `created` | `matched` | `quarantined`, held to the import's own provenance by ZY273. */
    outcome: text('outcome').notNull(),
    /** One of `E164_IDENTITY_REJECTIONS`, present exactly when `outcome` is `quarantined`. */
    quarantineReason: text('quarantine_reason'),
    /** The source list claimed a marketing consent and it was DISCARDED. Not a consent record. */
    consentClaimDiscarded: boolean('consent_claim_discarded').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('imported_contact_hmac_idx').on(t.contactHmac)],
)

import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of `packages/db/migrations/0101_private_document.sql` (W-SYS-14).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares this declaration against the live database in both directions.
 *
 * The rules that are **not** expressible here and therefore live only in the migration:
 *
 *   - `private_document_class_is_answerable`, the BEFORE INSERT trigger raising `ZY113` for a class outside
 *     `@berelax/core`'s catalogue. The CHECK below holds the same rule under a restore with triggers off;
 *     the trigger exists for the sentence somebody reads at 02:00;
 *   - `refuse_private_document_rewrite`, four BEFORE triggers raising `ZY112`. Both tables are append-only:
 *     the register is what an audited download NAMES, so a repointable storage key would make a recorded
 *     download name bytes that were never served, and the fetch log is the record that a copy of a
 *     statutory document left the business;
 *   - `assert_single_use_document_not_replayed`, the BEFORE INSERT trigger raising `ZY111`. It takes
 *     `for update` on the register row before it looks, which is the whole mechanism: a read-then-insert in
 *     TypeScript is two statements and two concurrent fetches of one forwarded link both pass the read;
 *   - the `revoke update, delete, truncate … from berelax_app` on both tables, which holds the same door one
 *     layer earlier than the triggers.
 *
 * There is deliberately **no `bucket` column**: every row is in the private bucket by definition, and a
 * column able to say `public` is a column somebody sets to `public`.
 */
export const privateDocument = pgTable(
  'private_document',
  {
    id: uuid('id').primaryKey(),
    /** One of `@berelax/core`'s `PRIVATE_DOCUMENT_CLASSES`. It decides the permission and the use policy. */
    documentClass: text('document_class').notNull(),
    /** The key inside the PRIVATE bucket. Never in a URL and never in an audit row. */
    storageKey: text('storage_key').notNull(),
    /** Which bytes this document IS. The audit row names this and not the storage key. */
    contentSha256: text('content_sha256').notNull(),
    bytes: integer('bytes').notNull(),
    /**
     * Recorded and deliberately not served: the route answers `application/octet-stream` with an attachment
     * disposition whatever this says, because rendering an untrusted upload inline in the admin origin is
     * the stored-XSS path a `Content-Disposition` closes.
     */
    contentType: text('content_type').notNull(),
    /** `replayable` or `single_use`, derived from the class and tied to it by a CHECK. */
    usePolicy: text('use_policy').notNull(),
    subjectKind: text('subject_kind').notNull(),
    subjectId: text('subject_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    registeredBy: text('registered_by').notNull(),
  },
  (t) => [
    check(
      'private_document_class_is_known',
      sql`private_document_class_is_known(${t.documentClass})`,
    ),
    check(
      'private_document_use_policy_matches_class',
      sql`${t.usePolicy} = case when ${t.documentClass} in ('payslip', 'clinical_extract') then 'single_use' else 'replayable' end`,
    ),
    check('private_document_storage_key_is_stated', sql`btrim(${t.storageKey}) <> ''`),
    check(
      'private_document_storage_key_is_relative',
      sql`${t.storageKey} not like '/%' and ${t.storageKey} not like '%..%'`,
    ),
    check('private_document_hash_is_a_sha256', sql`${t.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check('private_document_bytes_are_positive', sql`${t.bytes} > 0`),
    check(
      'private_document_subject_is_stated',
      sql`btrim(${t.subjectKind}) <> '' and btrim(${t.subjectId}) <> ''`,
    ),
    check('private_document_registered_by_is_stated', sql`btrim(${t.registeredBy}) <> ''`),
    uniqueIndex('private_document_storage_key_is_unique').on(t.storageKey),
    index('private_document_subject_idx').on(t.subjectKind, t.subjectId),
    index('private_document_class_idx').on(t.documentClass, t.createdAt),
  ],
)

export const privateDocumentFetch = pgTable(
  'private_document_fetch',
  {
    id: uuid('id').primaryKey(),
    privateDocumentId: uuid('private_document_id')
      .notNull()
      .references(() => privateDocument.id),
    /**
     * The nonce out of the signature, in the clear.
     *
     * Not a credential, unlike `obligation_evidence_grant.token_sha256` one table along: the nonce alone
     * opens nothing, because the signature is an HMAC over it under a key that is not in this database. It
     * is the identity of the LINK, which is what a single-use budget has to be keyed on.
     */
    signatureNonce: text('signature_nonce').notNull(),
    signatureKeyVersion: text('signature_key_version').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    fetchedByRole: text('fetched_by_role').notNull(),
    fetchedBy: text('fetched_by').notNull(),
    bytes: integer('bytes').notNull(),
  },
  (t) => [
    check('private_document_fetch_nonce_is_stated', sql`btrim(${t.signatureNonce}) <> ''`),
    check(
      'private_document_fetch_key_version_is_stated',
      sql`btrim(${t.signatureKeyVersion}) <> ''`,
    ),
    check(
      'private_document_fetch_by_is_stated',
      sql`btrim(${t.fetchedByRole}) <> '' and btrim(${t.fetchedBy}) <> ''`,
    ),
    check('private_document_fetch_bytes_are_positive', sql`${t.bytes} > 0`),
    index('private_document_fetch_nonce_idx').on(t.privateDocumentId, t.signatureNonce),
    index('private_document_fetch_at_idx').on(t.fetchedAt),
  ],
)

import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { messageChannel } from './messaging.ts'

/**
 * Drizzle mirror of 0056_consent.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Four things the mirror cannot say, and every one of them will bite somebody who builds a write from
 * these definitions rather than calling `packages/db/src/repositories/consent.ts`:
 *
 *   - **`consent` and `consent_wording` are append-only.** `update` and `delete` are revoked from
 *     `berelax_app` AND refused by a BEFORE trigger for every role including the owner (ZP003, ZP001).
 *     `db.update(consent)` typechecks perfectly and raises at run time, which is the correct outcome: a
 *     withdrawal is a NEW row with `kind: 'withdrawn'`, and so is a correction.
 *   - **`consentWording.contentHash` is GENERATED ALWAYS.** Passing a value makes Postgres raise. It is
 *     `consent_wording_hash(text_en, text_ar)`, so the row cannot hold a hash that disagrees with its
 *     own words.
 *   - **`consent.wordingHash` is checked against it on INSERT.** A row whose snapshot does not equal the
 *     referenced version's hash raises ZP002. Read the version through `readConsentWording`, which
 *     returns the hash alongside the text, and pass back what it gave you.
 *   - **`consent.recordedAt` and `consentWording.publishedAt` have no default.** Both are supplied from
 *     an injected clock, because every ordering assertion in this area is made under a frozen one.
 *
 * `consent.contactCustomerId` is deliberately **not** a foreign key to `customer`, so there is no
 * relation to declare here and `db.delete(customer)` is not blocked by it. The migration header says
 * why: an append-only log cannot hold a reference to a mutable parent, and this record has to outlive
 * the erasure of the identity it is about.
 */

/** The wording hash. Same representation as the ciphertext columns in 0008 and 0016. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

/** `granted` or `withdrawn`. "Never asked" is the absence of a row and is never stored. */
export const consentKind = pgEnum('consent_kind', ['granted', 'withdrawn'])

/**
 * The purpose vocabulary. A TABLE and not a `pgEnum`, because every label is provisional
 * (`Y9-consent-purpose`) and an enum label cannot carry `is_provisional`, an OPEN-QUESTIONS id or a
 * note. `consentKind` above IS an enum, and the contrast is deliberate: the two record kinds are the
 * model rather than an assumption about this business.
 */
export const consentPurpose = pgTable('consent_purpose', {
  purpose: text('purpose').primaryKey(),
  displayOrder: smallint('display_order').notNull(),
  description: text('description').notNull(),
  /** Whether a promotional send may be gated on it. False for a lawful basis that is not a permission. */
  isSendGating: boolean('is_send_gating').notNull(),
  isProvisional: boolean('is_provisional').notNull(),
  openQuestionId: text('open_question_id'),
  provisionalNote: text('provisional_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const consentWording = pgTable(
  'consent_wording',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    purpose: text('purpose').notNull(),
    /** Monotonic per purpose, and the number a person quotes. Not derived from `published_at`. */
    version: integer('version').notNull(),
    textEn: text('text_en').notNull(),
    textAr: text('text_ar').notNull(),
    /** GENERATED ALWAYS. Supplying a value raises; see the header. */
    contentHash: bytea('content_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    openQuestionId: text('open_question_id'),
    provisionalNote: text('provisional_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('consent_wording_version_unique').on(t.purpose, t.version),
    index('consent_wording_purpose_idx').on(t.purpose, t.version),
  ],
)

export const consent = pgTable(
  'consent',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Plain uuid, not a foreign key. See the header and the migration's. */
    contactCustomerId: uuid('contact_customer_id').notNull(),
    /** `message_channel` since 0014 — the same enum the template and the transport use. */
    channel: messageChannel('channel').notNull(),
    purpose: text('purpose').notNull(),
    kind: consentKind('kind').notNull(),
    /** When the person decided. Supplied, never defaulted. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
    /** Null only on a withdrawal: a grant must carry the wording it was given under. */
    consentWordingId: uuid('consent_wording_id'),
    wordingHash: bytea('wording_hash'),
    captureSource: text('capture_source').notNull(),
    captureActorKind: text('capture_actor_kind').notNull(),
    captureActorLabel: text('capture_actor_label').notNull(),
    captureLocale: text('capture_locale').notNull(),
    /** When the ROW landed, as distinct from when the person decided. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('consent_one_record_per_instant').on(
      t.contactCustomerId,
      t.channel,
      t.purpose,
      t.kind,
      t.recordedAt,
    ),
    index('consent_contact_idx').on(t.contactCustomerId, t.channel, t.purpose, t.recordedAt),
    index('consent_wording_id_idx').on(t.consentWordingId),
  ],
)

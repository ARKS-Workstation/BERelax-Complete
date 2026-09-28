import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirrors of the `clinical` schema (migrations 0008–0009).
 *
 * These live in `@berelax/clinical`, not `@berelax/db`, so the package that owns the boundary owns
 * its own shape. Nothing outside this package imports them.
 *
 * Note what is absent: any `references()` to a table in `public`. That omission is load-bearing —
 * a single cross-boundary foreign key would weld the schemas together and make relocating the
 * clinical store impossible. An integration test asserts it in the database too.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

export const clinicalSchema = pgSchema('clinical')

export const intakeFormTemplate = clinicalSchema.table(
  'intake_form_template',
  {
    id: uuid('id').primaryKey().default(sql`public.uuid_generate_v7()`),
    version: integer('version').notNull(),
    locale: text('locale').notNull(),
    title: text('title').notNull(),
    /** The question set — structure only. No answers, so no health data. */
    definition: jsonb('definition').notNull(),
    consentText: text('consent_text').notNull(),
    consentHash: text('consent_hash').notNull(),
    isCurrent: boolean('is_current').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Set when a later version replaced this one (0082). One of two columns an UPDATE may touch. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('intake_template_one_current_per_locale').on(t.locale).where(sql`is_current`),
  ],
)

export const intakeSubmission = clinicalSchema.table(
  'intake_submission',
  {
    id: uuid('id').primaryKey().default(sql`public.uuid_generate_v7()`),
    /** UUID reference only — deliberately NOT a foreign key to public.customer. */
    customerId: uuid('customer_id').notNull(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => intakeFormTemplate.id),
    payloadCiphertext: bytea('payload_ciphertext').notNull(),
    payloadNonce: bytea('payload_nonce').notNull(),
    wrappedDataKey: bytea('wrapped_data_key').notNull(),
    kekVersion: text('kek_version').notNull(),
    /** Binds the ciphertext to its row, so a payload cannot be moved between customers. */
    aadFingerprint: text('aad_fingerprint').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
    submittedVia: text('submitted_via').notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    /**
     * The template version these answers were given to (0082).
     *
     * Denormalised on purpose: it is the fourth term of this payload's AAD, and every term the GCM tag
     * covers has to be a column of the row so that 0043's ZK002 freezes it. A trigger asserts it equals
     * the referenced template's own version.
     */
    templateVersion: integer('template_version').notNull(),
    /** The fourth AAD term as stored — `template_version=<n>`, tied to the column above by a CHECK. */
    aadContext: text('aad_context').notNull(),
    /** `synthetic` or `real`. A real payload is refused while OPEN-QUESTIONS Y5-residency is open. */
    dataOrigin: text('data_origin').notNull(),
    /** Computed at capture from the profile in force, which defaults to healthcare-grade 25 years. */
    retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
  },
  (t) => [index('intake_submission_customer_idx').on(t.customerId, t.submittedAt)],
)

export const treatmentNote = clinicalSchema.table(
  'treatment_note',
  {
    id: uuid('id').primaryKey().default(sql`public.uuid_generate_v7()`),
    customerId: uuid('customer_id').notNull(),
    appointmentId: uuid('appointment_id').notNull(),
    authorEmployeeId: uuid('author_employee_id').notNull(),
    bodyCiphertext: bytea('body_ciphertext').notNull(),
    bodyNonce: bytea('body_nonce').notNull(),
    wrappedDataKey: bytea('wrapped_data_key').notNull(),
    kekVersion: text('kek_version').notNull(),
    aadFingerprint: text('aad_fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** A correction supersedes; a rewritable clinical record is not evidence. */
    supersedesId: uuid('supersedes_id'),
  },
  (t) => [
    index('treatment_note_customer_idx').on(t.customerId, t.createdAt),
    index('treatment_note_appointment_idx').on(t.appointmentId),
  ],
)

/**
 * The KEK version registry (migration 0043).
 *
 * Key MATERIAL is never here — only the label that says which externally-held key opens a row. It
 * lives in the `clinical` schema rather than `public` so that it is dumped, moved and restored with
 * the store it describes: a registry left behind in `public` would make the relocated store
 * unreadable. `status` is `active` or `retired`, one active row at most, and retirement is one-way.
 */
export const kekVersion = clinicalSchema.table('kek_version', {
  version: text('version').primaryKey(),
  status: text('status').notNull(),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull(),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
})

/**
 * The only shape permitted to cross the boundary. Booleans, no detail, no diagnosis.
 *
 * The closed set is eight keys (`CONTRAINDICATION_FLAG_KEYS`), and migration 0084 added the three it was
 * missing. The three non-boolean columns are NOT part of the crossing and are deliberately absent from
 * `public.customer_contraindication_flags`: `derivation_version` and `source_template_version` are the
 * provenance a staleness verdict is computed from, and `undetermined_count` is how many answers the
 * derivation refused to interpret — a count of anything about somebody's answers is more than a boolean, so
 * it stays behind the boundary and its only consumers are 0084's CHECK and an audit row.
 */
export const contraindicationFlag = clinicalSchema.table(
  'contraindication_flag',
  {
    customerId: uuid('customer_id').primaryKey(),
    pregnancy: boolean('pregnancy').notNull(),
    recentSurgery: boolean('recent_surgery').notNull(),
    cardiovascular: boolean('cardiovascular').notNull(),
    skinCondition: boolean('skin_condition').notNull(),
    allergyPresent: boolean('allergy_present').notNull(),
    bloodThinners: boolean('blood_thinners').notNull(),
    acuteInjury: boolean('acute_injury').notNull(),
    requiresConsultation: boolean('requires_consultation').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    sourceSubmissionId: uuid('source_submission_id')
      .notNull()
      .references(() => intakeSubmission.id),
    /** Which version of the DERIVATION produced this row. 0 means "before the derivation existed". */
    derivationVersion: integer('derivation_version').notNull(),
    /** The template version the source submission was captured under. Tied to it by 0084's ZA001. */
    sourceTemplateVersion: integer('source_template_version').notNull(),
    /** Answers the derivation would not interpret. Non-zero implies `requiresConsultation` (0084). */
    undeterminedCount: integer('undetermined_count').notNull(),
  },
  (t) => [
    index('contraindication_flag_stale_idx').on(t.derivationVersion, t.sourceTemplateVersion),
  ],
)

export const treatmentConsent = clinicalSchema.table(
  'treatment_consent',
  {
    id: uuid('id').primaryKey().default(sql`public.uuid_generate_v7()`),
    customerId: uuid('customer_id').notNull(),
    appointmentId: uuid('appointment_id'),
    templateId: uuid('template_id')
      .notNull()
      .references(() => intakeFormTemplate.id),
    /** Which wording they agreed to, so "what did they consent to" is answerable years later. */
    consentHash: text('consent_hash').notNull(),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    consentLocale: text('consent_locale').notNull(),
    capturedVia: text('captured_via').notNull(),
    signaturePresent: boolean('signature_present').notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  },
  (t) => [index('treatment_consent_customer_idx').on(t.customerId, t.consentedAt)],
)

/**
 * Step-up re-authentication (migration 0082).
 *
 * In the `clinical` schema and not in `public` because ADR 0010's test for what belongs here is whether
 * it MOVES with the store: exactly one code path consumes a grant — the audited clinical read — and a
 * relocated store that left its grants behind would reach back across a database boundary for its own
 * authorisation decision. It holds no health data. `employeeId` is a plain uuid, never a foreign key.
 */
export const stepUpGrant = clinicalSchema.table(
  'step_up_grant',
  {
    id: uuid('id').primaryKey().default(sql`public.uuid_generate_v7()`),
    employeeId: uuid('employee_id').notNull(),
    method: text('method').notNull(),
    /** What the reads under this grant are for. A read declaring a different purpose is refused. */
    statedPurpose: text('stated_purpose').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    index('step_up_grant_live_idx').on(t.employeeId, t.expiresAt).where(sql`revoked_at is null`),
  ],
)

/**
 * Data keys destroyed under a data-subject erasure (migration 0085, C-CRM-10).
 *
 * In the `clinical` schema by ADR 0010's own test for what belongs here: it moves with the store, because
 * it is the record of what happened to rows in this schema, and a relocated store that left it behind would
 * be unable to say which of its own records had been erased or on whose authority.
 *
 * **This table, not the empty `wrappedDataKey`, is the AUTHORITY on whether a record was crypto-erased.**
 * The zero-byte key is the mechanism — a real wrapped key is always 60 bytes, so zero is a value `seal()`
 * cannot produce — and a mechanism with no record beside it cannot say who decided or when.
 *
 * Append-only: UPDATE and DELETE raise for every role including the owner (ZY005). It has to outlive every
 * other trace of the data it is about, which is the one retention in that unit that is a CONSEQUENCE of the
 * erasure rather than something surviving it. Written only by `public.destroy_customer_deks`, which
 * refuses (ZY006) unless an `in_progress` erasure request names the customer — so there is no path that
 * destroys a key without a row saying who asked and how they were verified.
 *
 * `customerId` and `rightsRequestId` are plain uuids and NOT foreign keys, which is 0008's decision for
 * this schema verbatim: a foreign key would weld the two schemas together and defeat the relocation the
 * boundary exists to enable. `rightsRequestId` points ACROSS that boundary, which is exactly why it cannot
 * be one.
 */
export const dekDestruction = clinicalSchema.table(
  'dek_destruction',
  {
    id: uuid('id').primaryKey().default(sql`public.uuid_generate_v7()`),
    /** `intake_submission` or `treatment_note`, behind a CHECK. The only two sealed tables. */
    targetTable: text('target_table').notNull(),
    recordId: uuid('record_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    rightsRequestId: uuid('rights_request_id').notNull(),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }).notNull(),
    /**
     * The KEK version the key was wrapped under when it was destroyed.
     *
     * Recorded because it is the one fact that stops a future rotation being blamed: a row whose key is
     * gone was never re-wrapped, and this says which version it stopped at. The rotation work queue
     * excludes destroyed rows (`listSealedNotOn`), so nothing will ever move it.
     */
    kekVersionAtDestruction: text('kek_version_at_destruction').notNull(),
  },
  (t) => [index('dek_destruction_customer_idx').on(t.customerId, t.destroyedAt)],
)

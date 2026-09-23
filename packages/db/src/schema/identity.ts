import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
// The `employee_document_type` enum is declared with the tables it belongs to (0030) and imported
// here, not redeclared: a second pgEnum of the same name would compile, read identically and be a
// different Postgres type, so the mandatory list and the documents it is checked against would stop
// being comparable.
import { employeeDocumentType } from './staff.ts'

/**
 * Drizzle mirrors of the SQL in packages/db/migrations.
 *
 * Migrations are SQL-first (ADR 0006): exclusion constraints, partitioning, generated columns,
 * rules and domains are either awkward or impossible to express through a schema-generating ORM,
 * and the database is where these guarantees belong. These definitions exist for type-safe queries
 * and are kept honest by `pnpm db:drift`, which compares them against the live database.
 */

export const licenceClass = pgEnum('licence_class', ['unconfirmed', 'wellness', 'healthcare'])

export const legalEntity = pgTable('legal_entity', {
  id: smallint('id').primaryKey(),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name').notNull(),
  /** Null until the owner supplies it. Invoice issuance validates presence. */
  trn: text('trn'),
  tradeLicenceNumber: text('trade_licence_number'),
  licensingAuthority: text('licensing_authority').notNull(),
  emirate: text('emirate').notNull(),
  legalForm: text('legal_form').notNull(),
  financialYearEndMonth: smallint('financial_year_end_month').notNull(),
  vatRegistered: boolean('vat_registered').notNull(),
  vatRegistrationDate: date('vat_registration_date'),
  smallBusinessRelief: boolean('small_business_relief').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const premises = pgTable('premises', {
  id: smallint('id').primaryKey(),
  displayName: text('display_name').notNull(),
  addressLine1: text('address_line_1').notNull(),
  addressLine2: text('address_line_2'),
  floor: text('floor'),
  area: text('area').notNull(),
  emirate: text('emirate').notNull(),
  countryCode: char('country_code', { length: 2 }).notNull(),
  poBox: text('po_box'),
  makaniNumber: text('makani_number'),
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  plusCode: text('plus_code'),
  googlePlaceId: text('google_place_id'),
  phoneLandline: text('phone_landline'),
  phoneMobile: text('phone_mobile'),
  phoneWhatsapp: text('phone_whatsapp'),
  email: text('email'),
  parkingNotes: text('parking_notes'),
  directionsNotes: text('directions_notes'),
  timezone: text('timezone').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const premisesHours = pgTable('premises_hours', {
  id: smallint('id').primaryKey(),
  dayOfWeek: smallint('day_of_week').notNull(),
  openTime: time('open_time').notNull(),
  closeTime: time('close_time').notNull(),
  /** Generated in the database: close_time <= open_time. Trading is 11:00–02:00. */
  crossesMidnight: boolean('crosses_midnight').notNull(),
  isClosed: boolean('is_closed').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const premisesClosure = pgTable(
  'premises_closure',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    reason: text('reason').notNull(),
    kind: text('kind').notNull(),
    /** UAE public holidays are lunar and announced late; provisional must be distinguishable. */
    isConfirmed: boolean('is_confirmed').notNull(),
    /** Start of a partial-day closure, local time. Null with the pair means the whole date. */
    closedFromTime: time('closed_from_time'),
    closedUntilTime: time('closed_until_time'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('premises_closure_range_idx').on(t.startsOn, t.endsOn)],
)

export const regulatoryProfile = pgTable('regulatory_profile', {
  version: smallint('version').primaryKey(),
  licenceClass: licenceClass('licence_class').notNull(),
  emirate: text('emirate').notNull(),
  clinicalRetentionYears: smallint('clinical_retention_years').notNull(),
  financialRetentionYears: smallint('financial_retention_years').notNull(),
  erasureOverridesRetention: boolean('erasure_overrides_retention').notNull(),
  medicalClaimsPermitted: boolean('medical_claims_permitted').notNull(),
  permittedPublicTitles: text('permitted_public_titles').array().notNull(),
  bannedClaimTerms: text('banned_claim_terms').array().notNull(),
  /**
   * Document types a therapist must hold, unexpired, to be offered in availability (0030).
   *
   * Here rather than in `app_setting` because it is a consequence of the same unanswered question
   * every other column in this table is a consequence of: whether the licence is a commercial
   * wellness activity or a healthcare activity decides which credentials the person delivering a
   * treatment must hold. An array of the `employee_document_type` enum rather than `text[]` — unlike
   * `bannedClaimTerms`, which is free words a lint scans for, these have to match
   * `employee_document.document_type` exactly, and a typo in a text[] is a mandatory type nothing
   * matches, so every therapist passes the check that was meant to exclude them.
   */
  mandatoryTherapistDocumentTypes: employeeDocumentType('mandatory_therapist_document_types')
    .array()
    .notNull(),
  /**
   * Document types whose records carry no expiry date (0054).
   *
   * Beside the mandatory set and not in `app_setting`, for the reason the mandatory set is here:
   * whether an Emiratisation registration or a good-conduct certificate has to be renewed is part of
   * the same [UNVERIFIED] paragraph of docs/04 §7 as which credentials a therapist must hold, and one
   * read of one row should answer the whole credential policy — two reads can disagree about which
   * profile version they belong to.
   *
   * **Empty by default**, which is the strict reading: a credential must be renewed until somebody
   * confirms it need not be. The empty default is also what keeps 0030's guarantee intact on every
   * database that exists today — `employee_document.expires_on` became nullable in 0054 and the
   * `employee_document_expiry_is_declared` trigger refuses a NULL for any type not listed here, so
   * while this array is empty no row may have one.
   */
  nonExpiringDocumentTypes: employeeDocumentType('non_expiring_document_types').array().notNull(),
  isProvisional: boolean('is_provisional').notNull(),
  sourceNote: text('source_note'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: text('created_by').notNull(),
})

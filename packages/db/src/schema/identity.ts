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
    openTime: time('open_time'),
    closeTime: time('close_time'),
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
  isProvisional: boolean('is_provisional').notNull(),
  sourceNote: text('source_note'),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  createdBy: text('created_by').notNull(),
})

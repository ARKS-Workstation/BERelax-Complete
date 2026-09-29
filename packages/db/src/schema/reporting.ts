import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle mirrors of the `reporting` schema (migration 0110, R-REP-01).
 *
 * SQL-first (ADR 0006); `pnpm db:drift` compares these against the live database in both directions, and
 * `scripts/check-schema-drift.mjs` gains `reporting` in its `OWNED_SCHEMAS` on the same commit — a schema
 * a migration creates and nothing mirrors is exactly what that list exists to refuse.
 *
 * ## The drift gate compares TABLES, and seven of the nine relations here are not tables
 *
 * `relkind in ('r', 'p')` is what the gate enumerates on the database side, so the seven materialised
 * views (`relkind = 'm'`) are invisible to it in both directions. Their shape is therefore held by
 * `packages/db/src/reporting.itest.ts`, which reads `pg_attribute` and asserts the column set of each
 * view against the mirrors below. The two BASE tables — `materialised_view` and `refresh_run` — ARE
 * drift-checked in the ordinary way.
 *
 * Writing the views out as `.existing()` mirrors rather than leaving them undeclared is what gives the
 * shape assertion something to compare against. A mirror with no definition is the honest form: the
 * definition is the migration's, and a Drizzle `.as(...)` here would be a second statement of seven view
 * bodies with nothing holding it equal to the first.
 *
 * ## Five things the mirror cannot say, and each will mislead somebody who writes from it
 *
 *   1. **Every materialised view is READ-ONLY and derived.** `db.insert(dimDate)` typechecks and the
 *      server refuses it. The only thing that changes a row here is `reporting.refresh_all()` or
 *      `reporting.refresh(view)`, and the application role holds `select` and `execute` and nothing else.
 *   2. **Nullability is not expressed and deliberately not asserted.** A materialised view's columns are
 *      all nullable in `pg_attribute` whatever the underlying expression guarantees, so `.notNull()`
 *      here would be a claim the catalogue cannot confirm. Where a fact's key must be present, the
 *      guarantee is `reporting.assert_business_day_keys` (ZY185), which refuses a null at refresh time —
 *      a real check rather than a type annotation.
 *   3. **`dim_date` is keyed on `business_day`, which is `business_day.trading_date`.** It is not a
 *      calendar date and there are no rows for dates the premises did not trade on. 0110's header has the
 *      argument; the short version is that a generated calendar dimension would be the twelfth statement
 *      of the trading calendar and the first one entitled to disagree with it.
 *   4. **`refresh_run` is append-only.** UPDATE and DELETE raise `ZY184` for every role including the
 *      owner, by two BEFORE triggers. A `db.update(refreshRun)` typechecks perfectly and is refused.
 *   5. **No relation here holds a contact detail, a name or a note.** That is what makes the whole schema's
 *      absence from C-CRM-05's merge registry and C-CRM-10's erasure catalogue — both of which enumerate
 *      `relkind in ('r','p')` — safe rather than a hole. `dim_customer` carries a customer's SHAPE and
 *      `is_erased`, and nothing an erasure would have to remove.
 */
export const reportingSchema = pgSchema('reporting')

/**
 * The registry the refresh walks: which views exist, their grain, the order, and which column carries the
 * trading date.
 *
 * A second statement of "which views exist", so it comes with the check that holds the two equal —
 * `reporting.assert_views_are_refreshable()`, ZY181 — which both refresh entry points call before they
 * touch anything.
 */
export const reportingMaterialisedView = reportingSchema.table(
  'materialised_view',
  {
    viewName: text('view_name').primaryKey(),
    kind: text('kind').notNull(),
    /** One sentence naming what one row IS. `fact_shift` is one row per employee per shift, not per shift. */
    grain: text('grain').notNull(),
    /** The declared order `refresh_all` walks. Not a dependency order: no view here reads another. */
    refreshRank: smallint('refresh_rank').notNull(),
    /** The column holding the trading date, or null for an undated dimension. */
    businessDayColumn: text('business_day_column'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    check('materialised_view_kind_check', sql`${t.kind} in ('dimension', 'fact')`),
    check('materialised_view_rank_positive', sql`${t.refreshRank} >= 1`),
  ],
)

/**
 * One row per view per refresh — the only record of when a materialised view was last rebuilt, because
 * PostgreSQL keeps none.
 *
 * Append-only (ZY184) and with no `updated_at`: R-REP-07 decides whether a tile may render a number from
 * this table, and the one thing an editable freshness log permits is making a stale view look current.
 */
export const reportingRefreshRun = reportingSchema.table(
  'refresh_run',
  {
    id: uuid('id').primaryKey(),
    viewName: text('view_name').notNull(),
    refreshTrigger: text('refresh_trigger').notNull(),
    /** Recorded rather than assumed: a pass that fell back to a blocking refresh blocked every reader. */
    ranConcurrently: boolean('ran_concurrently').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }).notNull(),
    rowCount: integer('row_count').notNull(),
    /** md5 over the rows, order-independent. Equal across two refreshes means the refresh is idempotent. */
    checksum: text('checksum').notNull(),
  },
  (t) => [
    index('refresh_run_view_finished_idx').on(t.viewName, t.finishedAt),
    check('refresh_run_trigger_check', sql`${t.refreshTrigger} in ('nightly', 'on_demand')`),
    check('refresh_run_finishes_after_it_starts', sql`${t.finishedAt} >= ${t.startedAt}`),
  ],
)

/**
 * Public holidays and Ramadan, as date ranges, for `dim_date`'s two flags and nothing else.
 *
 * The operational holiday calendar is P-HR-10's. This table is deliberately EMPTY: every date is
 * `Y9-holiday-calendar`, and a plausible lunar date is indistinguishable from a confirmed one (brief rule
 * 15). `calendar_observance_lunar_is_provisional` is what makes "every lunar-date holiday row carries
 * provisional = true" a refusal rather than a property of rows somebody seeded.
 */
export const reportingCalendarObservance = reportingSchema.table(
  'calendar_observance',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** `gregorian` for a fixed date, `lunar` for one announced at short notice. A lunar row is provisional. */
    dateBasis: text('date_basis').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    isProvisional: boolean('is_provisional').notNull(),
    openQuestionId: text('open_question_id'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('calendar_observance_range_idx').on(t.kind, t.startsOn, t.endsOn),
    check('calendar_observance_kind_check', sql`${t.kind} in ('public_holiday', 'ramadan')`),
    check('calendar_observance_basis_check', sql`${t.dateBasis} in ('gregorian', 'lunar')`),
    check('calendar_observance_range_ordered', sql`${t.endsOn} >= ${t.startsOn}`),
    check(
      'calendar_observance_lunar_is_provisional',
      sql`${t.dateBasis} <> 'lunar' or ${t.isProvisional}`,
    ),
  ],
)

/**
 * One row per TRADING date. Keyed on `business_day`, which is `business_day.trading_date`.
 *
 * `openMinutes` derives from `business_day.duration_seconds`, which 0011 generates from the open and close
 * instants — so every hours denominator in R-REP-03 through R-REP-06 reads `premises_hours` and its dated
 * overrides transitively, and a Ramadan schedule is a row plus a regeneration with no code change.
 *
 * The two observances are three columns and two columns rather than two booleans, because "a holiday,
 * settled" and "a holiday, on a date that may still move" are different facts and R-REP-06 has to report
 * them separately.
 */
export const dimDate = reportingSchema
  .materializedView('dim_date', {
    businessDay: date('business_day'),
    opensAt: timestamp('opens_at', { withTimezone: true }),
    closesAt: timestamp('closes_at', { withTimezone: true }),
    openMinutes: integer('open_minutes'),
    crossesMidnight: boolean('crosses_midnight'),
    hoursSource: text('hours_source'),
    isoDayOfWeek: smallint('iso_day_of_week'),
    isoYear: smallint('iso_year'),
    isoWeek: smallint('iso_week'),
    businessYear: smallint('business_year'),
    businessMonth: date('business_month'),
    businessQuarter: date('business_quarter'),
    isPublicHoliday: boolean('is_public_holiday'),
    publicHolidayNames: text('public_holiday_names'),
    publicHolidayIsProvisional: boolean('public_holiday_is_provisional'),
    publicHolidayIsLunarDated: boolean('public_holiday_is_lunar_dated'),
    isRamadan: boolean('is_ramadan'),
    ramadanIsProvisional: boolean('ramadan_is_provisional'),
  })
  .existing()

/** One row per service VARIANT — the grain an appointment references. */
export const dimService = reportingSchema
  .materializedView('dim_service', {
    serviceVariantId: uuid('service_variant_id'),
    serviceId: uuid('service_id'),
    treatmentStyle: text('treatment_style'),
    treatmentKey: text('treatment_key'),
    slug: text('slug'),
    internalName: text('internal_name'),
    publicDisplayName: text('public_display_name'),
    durationMinutes: smallint('duration_minutes'),
    turnaroundMinutes: smallint('turnaround_minutes'),
    /** The CATALOGUE price now. The price a treatment sold at is on `fact_appointment`. */
    listGrossFils: bigint('list_gross_fils', { mode: 'bigint' }),
    isPublished: boolean('is_published'),
    isArchived: boolean('is_archived'),
    isProvisional: boolean('is_provisional'),
    openQuestionId: text('open_question_id'),
  })
  .existing()

/**
 * One row per employee, with NO wage or allowance column.
 *
 * R-REP-08 has to keep salary out of a serialised response per role; the cheapest way to keep that
 * promise is for the dimension every dashboard joins to not to contain one. `displayName` stays nullable:
 * a therapist has no display name until an admin sets one (ADR 0020).
 */
export const dimStaff = reportingSchema
  .materializedView('dim_staff', {
    employeeId: uuid('employee_id'),
    staffReference: text('staff_reference'),
    displayName: text('display_name'),
    contractType: text('contract_type'),
    employedFrom: date('employed_from'),
    employedUntil: date('employed_until'),
    isCurrent: boolean('is_current'),
    isPublishable: boolean('is_publishable'),
    isProvisional: boolean('is_provisional'),
    openQuestionId: text('open_question_id'),
  })
  .existing()

/**
 * One row per customer, holding no contact detail, name, label or note.
 *
 * `firstVisitBusinessDay` is the trading date of the earliest DELIVERED appointment, and it is the cohort
 * key R-REP-05 reads rather than recomputing — two definitions of "first visit" are two answers to one
 * question.
 */
export const dimCustomer = reportingSchema
  .materializedView('dim_customer', {
    customerId: uuid('customer_id'),
    recordCreatedAt: timestamp('record_created_at', { withTimezone: true }),
    createdVia: text('created_via'),
    locale: text('locale'),
    lifecycleState: text('lifecycle_state'),
    acquisitionSource: text('acquisition_source'),
    isVip: boolean('is_vip'),
    isErased: boolean('is_erased'),
    firstVisitBusinessDay: date('first_visit_business_day'),
    lastVisitBusinessDay: date('last_visit_business_day'),
  })
  .existing()

/**
 * One row per appointment, in every status.
 *
 * `businessDay` is `appointment.trading_date` — foreign-keyed to `business_day` and resolved per
 * appointment across midnight — so a 01:30 treatment is filed under the previous trading date and this
 * view does not recompute it. The amounts are the snapshot on the appointment.
 */
export const factAppointment = reportingSchema
  .materializedView('fact_appointment', {
    appointmentId: uuid('appointment_id'),
    businessDay: date('business_day'),
    bookingId: uuid('booking_id'),
    customerId: uuid('customer_id'),
    serviceVariantId: uuid('service_variant_id'),
    employeeId: uuid('employee_id'),
    roomId: uuid('room_id'),
    shape: text('shape'),
    status: text('status'),
    holdsResources: boolean('holds_resources'),
    isDelivered: boolean('is_delivered'),
    isNoShow: boolean('is_no_show'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    treatmentMinutes: integer('treatment_minutes'),
    turnaroundMinutes: smallint('turnaround_minutes'),
    therapistBufferMinutes: smallint('therapist_buffer_minutes'),
    roomPlaces: smallint('room_places'),
    grossFils: bigint('gross_fils', { mode: 'bigint' }),
    netFils: bigint('net_fils', { mode: 'bigint' }),
    vatFils: bigint('vat_fils', { mode: 'bigint' }),
    vatRateBp: smallint('vat_rate_bp'),
    lateCancellation: boolean('late_cancellation'),
    rescheduledFromId: uuid('rescheduled_from_id'),
    priceListId: uuid('price_list_id'),
    promotionId: text('promotion_id'),
  })
  .existing()

/**
 * One row per tax DOCUMENT — invoice or credit note, the credit note's amounts negated.
 *
 * `businessDay` is `tax_point_date`, the date of SUPPLY, which 0026 already stores as a trading date.
 * Never `date(issued_at)`, which would move every sale between midnight and 02:00 into the next day; and
 * never an inner join to `business_day`, which would drop an off-calendar tax point instead of refusing
 * the refresh (ZY185).
 */
export const factSale = reportingSchema
  .materializedView('fact_sale', {
    documentId: uuid('document_id'),
    documentKind: text('document_kind'),
    displayNumber: text('display_number'),
    businessDay: date('business_day'),
    /** The trading date the DOCUMENT was written on, for cash-up. Null when the premises was shut. */
    issueBusinessDay: date('issue_business_day'),
    issueDate: date('issue_date'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    customerId: uuid('customer_id'),
    correctsDocumentId: uuid('corrects_document_id'),
    netFils: bigint('net_fils', { mode: 'bigint' }),
    vatFils: bigint('vat_fils', { mode: 'bigint' }),
    grossFils: bigint('gross_fils', { mode: 'bigint' }),
  })
  .existing()

/**
 * One row per employee per SHIFT ASSIGNMENT — the measure is rostered minutes per person.
 *
 * A shift with nobody on it has no row here, which is right for therapist utilisation and wrong for "how
 * many shifts were there"; that question counts `public.shift`.
 */
export const factShift = reportingSchema
  .materializedView('fact_shift', {
    shiftId: uuid('shift_id'),
    employeeId: uuid('employee_id'),
    businessDay: date('business_day'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    rosteredMinutes: integer('rostered_minutes'),
    label: text('label'),
  })
  .existing()

import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * The incident register (0142). A hand-written mirror of the migration, which is the authority
 * (ADR 0006); `pnpm db:drift` compares the two in both directions.
 *
 * The three facts worth knowing before reading it:
 *
 *   - **`discovered_at` is the clock and `filed_at` is not.** They are separate columns with a CHECK
 *     ordering them, because a deadline computed from the filing would restart the statutory clock
 *     every time somebody got round to the paperwork.
 *   - **`incident` is append-only.** UPDATE and DELETE raise ZY521, and `incidentAddendum` is the only
 *     way to add information. There is no `updated_at` here, deliberately: a row with no second version
 *     has no update time, and `pnpm db:conventions` refuses one on a table whose comment says UPDATE
 *     and DELETE raise.
 *   - **Two columns are GENERATED**, so there is no writer at all for either. `occurrence_known` and
 *     `breach_fields_present` are derived from the columns they describe rather than held beside them,
 *     which is what stops a flag disagreeing with the thing it is about.
 */
export const incidentClass = pgEnum('incident_class', [
  'personal_data_breach',
  'client_injury',
  'staff_injury',
  'hygiene_failure',
  'equipment_failure',
  'security_event',
])

export const incidentNotifiedParty = pgEnum('incident_notified_party', [
  'data_subjects',
  'supervisory_authority',
  'insurer',
  'police',
  'municipality',
  'health_authority',
])

const F07_ROLES =
  "('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer', 'auditor', 'system')"

export const incident = pgTable(
  'incident',
  {
    id: uuid('id').primaryKey(),
    /** The business's own handle, which is what an insurer and an inspector quote back. */
    reference: text('reference').notNull(),
    incidentClass: incidentClass('incident_class').notNull(),
    /** When it happened, where that is known. NULL is common for a breach and is not a defect. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    /** GENERATED from `occurred_at`. No writer, which is the point. */
    occurrenceKnown: boolean('occurrence_known').notNull(),
    /**
     * When the business became aware. THE CLOCK: every notification deadline derives from this, in the
     * civil zone and never the trading date — a statutory deadline does not move with the salon's
     * trading hours.
     */
    discoveredAt: timestamp('discovered_at', { withTimezone: true }).notNull(),
    filedAt: timestamp('filed_at', { withTimezone: true }).notNull(),
    recordedByRole: text('recorded_by_role').notNull(),
    recordedByLabel: text('recorded_by_label').notNull(),
    summary: text('summary').notNull(),
    location: text('location').notNull(),
    immediateAction: text('immediate_action').notNull(),
    measuresProposed: text('measures_proposed'),
    peopleAffectedCount: integer('people_affected_count').notNull(),
    injuryReported: boolean('injury_reported').notNull(),
    emergencyServicesAttended: boolean('emergency_services_attended').notNull(),
    claimAnticipated: boolean('claim_anticipated').notNull(),
    /** Fils (ADR 0007). NULL where unknown and never 0 — an insurer reads a zero as a claim. */
    estimatedLossFils: bigint('estimated_loss_fils', { mode: 'bigint' }),
    personalDataCategories: text('personal_data_categories').array(),
    dataSubjectsAffectedEstimate: integer('data_subjects_affected_estimate'),
    recordsAffectedEstimate: integer('records_affected_estimate'),
    likelyConsequences: text('likely_consequences'),
    crossBorderTransfer: boolean('cross_border_transfer'),
    /** GENERATED. Every breach field present, or every one absent. */
    breachFieldsPresent: boolean('breach_fields_present').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex('incident_reference_key').on(t.reference),
    index('incident_class_discovered_idx').on(t.incidentClass, t.discoveredAt),
    index('incident_discovered_idx').on(t.discoveredAt),
    check('incident_filed_after_discovery', sql`${t.filedAt} >= ${t.discoveredAt}`),
    check(
      'incident_discovered_after_occurrence',
      sql`${t.occurredAt} is null or ${t.occurredAt} <= ${t.discoveredAt}`,
    ),
    /**
     * The breach fields are required for a breach and REFUSED for anything else.
     *
     * Refused rather than merely optional: "approximately how many data subjects" on an equipment
     * failure is a field somebody fills in with a number that means nothing, and the regulator's field
     * list is what gives those columns their meaning in the first place.
     */
    check(
      'incident_breach_fields_match_class',
      sql`(${t.incidentClass} = 'personal_data_breach') = ${t.breachFieldsPresent}`,
    ),
    check('incident_recorded_by_role_known', sql`${t.recordedByRole} in ${sql.raw(F07_ROLES)}`),
  ],
)

export const incidentAddendum = pgTable(
  'incident_addendum',
  {
    id: uuid('id').primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incident.id, { onDelete: 'restrict' }),
    /**
     * When this was learned, supplied by the caller rather than defaulted.
     *
     * An addendum dated when it was typed cannot distinguish a finding from something known at filing,
     * which is the whole question the register is asked.
     */
    addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
    addedByRole: text('added_by_role').notNull(),
    addedByLabel: text('added_by_label').notNull(),
    body: text('body').notNull(),
    /** The incident column this corrects, or NULL for an addendum that only adds. */
    correctsField: text('corrects_field'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('incident_addendum_incident_idx').on(t.incidentId, t.addedAt),
    check('incident_addendum_role_known', sql`${t.addedByRole} in ${sql.raw(F07_ROLES)}`),
  ],
)

export const incidentNotification = pgTable(
  'incident_notification',
  {
    id: uuid('id').primaryKey(),
    incidentId: uuid('incident_id')
      .notNull()
      .references(() => incident.id, { onDelete: 'restrict' }),
    /** A CATEGORY of recipient, never a named body (Y1-entity). */
    party: incidentNotifiedParty('party').notNull(),
    /**
     * When they were told. Compared against the deadline INSTANT and not the due date: a notification
     * at 23:00 on the due date is inside a 72-hour period that expired that morning only if the
     * comparison is done on dates, which is the answer a regulator would not accept.
     */
    notifiedAt: timestamp('notified_at', { withTimezone: true }).notNull(),
    notifiedByRole: text('notified_by_role').notNull(),
    notifiedByLabel: text('notified_by_label').notNull(),
    /** How, in the filer's words. Free text, because this build has no notification integration. */
    channel: text('channel').notNull(),
    contentSummary: text('content_summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('incident_notification_incident_idx').on(t.incidentId, t.notifiedAt),
    index('incident_notification_party_idx').on(t.party, t.notifiedAt),
    check('incident_notification_role_known', sql`${t.notifiedByRole} in ${sql.raw(F07_ROLES)}`),
  ],
)

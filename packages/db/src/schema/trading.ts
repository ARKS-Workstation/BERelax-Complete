import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Dated hours overrides — Ramadan, a seasonal change, a one-off late opening.
 *
 * A row here, not a migration. Ramadan hours change every year and are sometimes confirmed days
 * beforehand; a schema change is not something to run under that kind of time pressure.
 */
export const premisesHoursOverride = pgTable(
  'premises_hours_override',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    /** Null means every day in the range. */
    dayOfWeek: smallint('day_of_week'),
    openTime: time('open_time').notNull(),
    closeTime: time('close_time').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('premises_hours_override_range_idx').on(t.startsOn, t.endsOn)],
)

/**
 * The trading calendar, materialised — one row per trading date.
 *
 * Trading runs 11:00–02:00, so a trading date is not a calendar date and cannot be had by truncating
 * a timestamp. Reports join to this table; none of them recompute it, which is what keeps the rule in
 * one place instead of in every query that ever needed a daily figure.
 *
 * A closed date is **absent**, not present with a flag. A report that forgot an `is_open` predicate
 * would otherwise report a shut day as a trading day with no takings, which is a different and much
 * worse claim than "we were closed".
 */
export const businessDay = pgTable(
  'business_day',
  {
    tradingDate: date('trading_date').primaryKey(),
    opensAt: timestamp('opens_at', { withTimezone: true }).notNull(),
    closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
    /** Generated in the database, so no writer can disagree with the instants. */
    durationSeconds: integer('duration_seconds').notNull(),
    crossesMidnight: boolean('crosses_midnight').notNull(),
    source: text('source').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('business_day_opens_at_idx').on(t.opensAt),
    check('business_day_closes_after_opens', sql`${t.closesAt} > ${t.opensAt}`),
    check(
      'business_day_plausible_length',
      sql`${t.closesAt} - ${t.opensAt} <= interval '24 hours'`,
    ),
  ],
)

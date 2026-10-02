import { sql } from 'drizzle-orm'
import { check, date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * The operational holiday calendar (migration 0123, P-HR-10).
 *
 * Mirrors the SQL by hand: migrations are SQL-first (ADR 0006) and `pnpm db:drift` holds the two equal in
 * both directions.
 *
 * The table is deliberately EMPTY on a fresh database. Every UAE lunar holiday date is
 * `Y9-holiday-calendar` in docs/OPEN-QUESTIONS.md, and a plausible lunar date is indistinguishable from a
 * confirmed one (brief rule 15) in the one place the rota, the payslip and three reports all key on. The
 * mechanism is here; the figures are not.
 *
 * A row here does **not** close the premises and changes no trading hour. That is `premises_closure`
 * (0003), and a public holiday the salon trades through has no closure row at all (`Y9-overtime`) — which
 * is why deriving a holiday calendar from closures would be false on exactly the days the flag is for.
 * What an observance decides is which bucket a worked minute is paid in (`publicHoliday`, P-HR-05) and
 * what the rota screen shows.
 */
export const holidayObservance = pgTable(
  'holiday_observance',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** `public_holiday` or `ramadan`, the same two words `reporting.calendar_observance.kind` uses. */
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    /** `gregorian` or `lunar`. A lunar date is announced at short notice (docs/04 §6). */
    dateBasis: text('date_basis').notNull(),
    /**
     * `provisional` or `confirmed`.
     *
     * A column and not a convention: the two states are two positive claims about where the date came
     * from, and a reader of the row must be able to tell an announced date from a predicted one without
     * reading anything else.
     */
    confirmationState: text('confirmation_state').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    /** The OPEN-QUESTIONS id owning a provisional date; null on a confirmed one, and held so by a check. */
    openQuestionId: text('open_question_id'),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('holiday_observance_range_idx').on(t.kind, t.startsOn, t.endsOn),
    check('holiday_observance_range_ordered', sql`${t.endsOn} >= ${t.startsOn}`),
    check(
      'holiday_observance_provisional_names_a_question',
      sql`(${t.confirmationState} = 'provisional') = (${t.openQuestionId} is not null)`,
    ),
  ],
)

/**
 * The announcement a confirmed observance rests on. Append-only: UPDATE and DELETE raise (ZY292).
 *
 * It carries the dates the observance held BEFORE the confirmation as well as the ones it holds now,
 * which is what makes the impact report reproducible from the row rather than stored beside it
 * (ADR 0075). The two ranges are the report's whole input on the calendar side.
 */
export const holidayConfirmation = pgTable(
  'holiday_confirmation',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** Unique: an observance is confirmed ONCE, and a re-announcement is a superseding observance. */
    observanceId: uuid('observance_id').notNull(),
    previousStartsOn: date('previous_starts_on').notNull(),
    previousEndsOn: date('previous_ends_on').notNull(),
    confirmedStartsOn: date('confirmed_starts_on').notNull(),
    confirmedEndsOn: date('confirmed_ends_on').notNull(),
    announcementSource: text('announcement_source').notNull(),
    recordedBy: text('recorded_by').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('holiday_confirmation_recorded_at_idx').on(t.recordedAt),
    check(
      'holiday_confirmation_previous_range_ordered',
      sql`${t.previousEndsOn} >= ${t.previousStartsOn}`,
    ),
    check(
      'holiday_confirmation_confirmed_range_ordered',
      sql`${t.confirmedEndsOn} >= ${t.confirmedStartsOn}`,
    ),
  ],
)

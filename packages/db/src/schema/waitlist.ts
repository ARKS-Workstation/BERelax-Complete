import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  customType,
  date,
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { serviceShape, serviceVariant } from './catalogue.ts'
import { customer } from './customer.ts'
import { businessDay } from './trading.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0045_waitlist.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these definitions against the live database in both directions.
 *
 * Two tables, and neither holds an availability answer. `no-precomputed-slot-table` in
 * `scripts/check-schema-conventions.mjs` forbids a slot table, an availability cache and a materialised
 * view of either, and the reason it gives is right: a stored answer is stale from the next block,
 * closure, shift change or walk-in. `availability_epoch` stores one integer per trading date — how many
 * times anything that could change that date's availability has been written — which is what lets an
 * in-process memo of a *computed* answer find out that the schedule has moved instead of serving a
 * result it cannot know is wrong.
 *
 * `serviceShape` is **imported** from `./catalogue.ts` rather than redeclared, exactly as `./booking.ts`
 * imports it: a second `pgEnum('service_shape', …)` would compile, read identically and be a different
 * Postgres type, so every join would need a cast — and a cast is where two spellings of one vocabulary
 * drift apart.
 */

/**
 * `tstzrange`, which Drizzle has no built-in column type for.
 *
 * Carried as the Postgres text form rather than parsed into a pair of instants — the same choice
 * `./rooms.ts`, `./booking.ts` and `./staff.ts` make, and for the same reason: parsing it here would put
 * range semantics in the ORM layer, where a caller could construct an inclusive upper bound without
 * noticing. The database refuses anything but `[)` (`waitlist_period_half_open`).
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange'
  },
})

/**
 * The four write types that can change a trading date's availability.
 *
 * An enum and not `text`, so a test can assert **which** write purged a cache tag. With free text a
 * fifth writer invents a fifth spelling, and four separate assertions collapse into one that proves
 * only that something fired — which is the failure the manifest's "asserted once per write type (four
 * cases)" line is written against.
 *
 * `approved_leave` and not `leave`: availability reads `employee_approved_leave` (0030), never
 * `leave_request`, so a pending request must not move the epoch.
 */
export const availabilityEpochCause = pgEnum('availability_epoch_cause', [
  'appointment',
  'shift',
  'resource_block',
  'approved_leave',
])

/**
 * One integer per trading date: how many times its availability inputs have been written.
 *
 * Holds no slot, no room, no therapist and no period, so there is nothing here a caller could serve
 * instead of computing an answer. Four triggers advance it — one per write type — and they run inside
 * the writer's own transaction, which is what stops an *uncommitted* booking purging a memo that is
 * still correct.
 *
 * Deliberately **no** foreign key into `business_day`. The row is bookkeeping about a cache key rather
 * than a fact about a trading day: `on delete restrict` would let this table refuse a calendar
 * regeneration, and `on delete cascade` would silently resurrect every stale memo for a date whose
 * hours had just been rewritten. An orphaned row is inert — nothing reads it but the key it belongs to.
 */
export const availabilityEpoch = pgTable('availability_epoch', {
  tradingDate: date('trading_date').primaryKey(),
  /**
   * Monotonic, and never reset. A holder compares the integer it recorded against this one; equal means
   * nothing that could change the answer has been written since. A counter that went backwards would
   * make a stale memo look current exactly once, and that once sells a slot that no longer exists.
   *
   * `mode: 'number'` because the value is a generation counter that is compared for equality, not an
   * amount: money is integer fils and never passes through here (ADR 0007).
   */
  epoch: bigint('epoch', { mode: 'number' }).notNull(),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }).notNull(),
  /** Which of the four write types moved it last. The four purge cases are asserted by this column. */
  lastCause: availabilityEpochCause('last_cause').notNull(),
})

/**
 * Who is waiting for a window that is full.
 *
 * The idempotency of a repeat join is `waitlist_one_row_per_window`, and the whole of it is the two
 * words `NULLS NOT DISTINCT`. `therapistId` is null for "any therapist", which is the ordinary request,
 * and under PostgreSQL's default `NULLS DISTINCT` two joins for the same customer, variant, date and
 * window would be two different keys — so `on conflict do nothing` would insert both, the second join
 * would not be idempotent, and the table would grow one row per page refresh. Drizzle expresses this as
 * `unique().on(…).nullsNotDistinct()`; a mirror that dropped it would read as the same constraint and
 * describe a different one.
 *
 * No status column and no `notified_at`: the unit that offers a released slot to the next person waiting
 * does not exist in `build/manifest.yaml`, and a status enum whose every row reads `waiting` for ever is
 * a column that claims a lifecycle the system does not have.
 */
export const waitlist = pgTable(
  'waitlist',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** CASCADE: a waitlist entry is a request by a person and has no meaning without them. */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    /** RESTRICT: deleting the variant would leave a row that cannot say what it is waiting for. */
    serviceVariantId: uuid('service_variant_id')
      .notNull()
      .references(() => serviceVariant.id, { onDelete: 'restrict' }),
    /**
     * The trading date, materialised and foreign-keyed exactly as `appointment.tradingDate` and
     * `shift.tradingDate` are. Trading runs 11:00–02:00, so 01:30 belongs to the **previous** trading
     * date and a row keyed on the calendar date of its instants would file the last two hours of every
     * day under tomorrow.
     */
    tradingDate: date('trading_date')
      .notNull()
      .references(() => businessDay.tradingDate, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /** The window the customer will accept, `[)` bounds. Instants, for `leave_request.period`'s reason. */
    desiredPeriod: tstzrange('desired_period').notNull(),
    /** The footprint asked for. A Four Hands waiting list is not a solo waiting list. */
    shape: serviceShape('shape').notNull(),
    /**
     * The therapist asked for, or null for "any" — the reason the unique key is `NULLS NOT DISTINCT`.
     *
     * Not a foreign key into `employee`, for `appointment.therapistId`'s reason (0038):
     * `references employee (id)` would accept a receptionist while reading as though it had proved
     * otherwise, and the claim worth making is the eligibility read model.
     */
    therapistId: uuid('therapist_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('waitlist_one_row_per_window')
      .on(t.customerId, t.serviceVariantId, t.tradingDate, t.desiredPeriod, t.therapistId)
      .nullsNotDistinct(),
    index('waitlist_date_period_idx').using('gist', t.tradingDate, t.desiredPeriod),
    index('waitlist_customer_idx').on(t.customerId, t.createdAt.desc()),
    check('waitlist_period_nonempty', sql`not isempty(${t.desiredPeriod})`),
    check(
      'waitlist_period_bounded',
      sql`lower(${t.desiredPeriod}) is not null and upper(${t.desiredPeriod}) is not null`,
    ),
    check(
      'waitlist_period_half_open',
      sql`lower_inc(${t.desiredPeriod}) and not upper_inc(${t.desiredPeriod})`,
    ),
  ],
)

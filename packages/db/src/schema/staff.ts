import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  customType,
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { therapistSkill } from './catalogue.ts'
import { businessDay } from './trading.ts'

/**
 * Drizzle mirror of `packages/db/migrations/0030_staff_availability.sql`.
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares these definitions against the live database in both directions.
 *
 * These are the tables the therapist half of availability reads: an employment period, the skills a
 * person holds, the rostered spans they are on, their approved leave and their credentials. Rota
 * generation, accrual, contracts and payroll are P-HR's and extend these; nothing here anticipates
 * them, and nothing here is a second source of truth for "is this therapist bookable".
 *
 * `therapistSkill` is **imported** from `./catalogue.ts` rather than redeclared, exactly as
 * `./booking.ts` imports `serviceShape`: a second `pgEnum('therapist_skill', …)` would compile, read
 * identically and be a different Postgres type, so the join to `service_skill.required_skill` would
 * need a cast — and a cast is where two spellings of one vocabulary drift apart.
 */

/**
 * `tstzrange`, which Drizzle has no built-in column type for.
 *
 * Carried as the Postgres text form rather than parsed into a pair of instants — the same choice
 * `./rooms.ts` and `./booking.ts` make, and for the same reason: parsing it here would put range
 * semantics in the ORM layer, where a caller could construct an inclusive upper bound without
 * noticing. The database refuses anything but `[)` (`shift_period_half_open`,
 * `leave_request_period_half_open`).
 */
const tstzrange = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tstzrange'
  },
})

/**
 * female | male.
 *
 * Read by the strict same-gender matching rule of B-AVAIL-05, not by any report. Nullable on
 * `employee`: nineteen photographs and no staff list is the real handover position (Y8-staff), and a
 * NOT NULL would have the migration invent nineteen people's genders.
 */
export const employeeGender = pgEnum('employee_gender', ['female', 'male'])

/**
 * The document kinds an employee file holds.
 *
 * Which of them are **mandatory** for a bookable therapist is data, in
 * `regulatory_profile.mandatory_therapist_document_types`, because it follows the licence class nobody
 * has confirmed (Y1-licence). An enum rather than free text because the profile names a subset of
 * these: a mandatory type spelled two ways matches no document, and the therapist is then bookable
 * with no certificate at all.
 */
export const employeeDocumentType = pgEnum('employee_document_type', [
  'professional_licence',
  'health_certificate',
  'work_permit',
  'emirates_id',
  'passport',
  'training_certificate',
])

/**
 * Only `approved` removes a therapist from availability.
 *
 * A status rather than a boolean, and rather than "is there a row": keying on the row's existence
 * makes asking for leave the same act as being granted it. P-HR may add approval stages; every added
 * state is unapproved until it reaches `approved`.
 */
export const leaveStatus = pgEnum('leave_status', ['pending', 'approved', 'rejected', 'cancelled'])

/** What the leave is, for P-HR's accrual rules. Availability reads the period and the status only. */
export const leaveKind = pgEnum('leave_kind', ['annual', 'sick', 'unpaid', 'other'])

/**
 * The minimal employee availability reads.
 *
 * There is deliberately **no `display_name`**. ADR 0020 needs a display name *and* a recorded
 * photography consent before a therapist page exists, and a nullable column here is the one an admin
 * screen fills in without the consent row — at which point the guard is invisible. `staffReference` is
 * an internal handle ("Therapist 07"), never a person's name.
 */
export const employee = pgTable(
  'employee',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    staffReference: text('staff_reference').notNull().unique(),
    /** Absent when nobody has told the build. B-AVAIL-05 decides what strict matching does with it. */
    gender: employeeGender('gender'),
    /**
     * Employment as a **period**, not an `is_active` flag.
     *
     * A flag answers "now" and nothing else, and availability is asked about future and past trading
     * dates: a therapist who leaves in March is not eligible in April and *was* eligible in February,
     * which one boolean cannot say. Compared against the TRADING date, never the calendar date —
     * trading runs 11:00–02:00, so an appointment at 01:30 belongs to the previous trading date.
     */
    employedFrom: date('employed_from').notNull(),
    /** Null is open-ended employment, not an unknown end date. */
    employedUntil: date('employed_until'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('employee_employment_idx').on(t.employedFrom, t.employedUntil),
    check(
      'employee_staff_reference_not_placeholder',
      sql`not is_placeholder_text(${t.staffReference})`,
    ),
    check(
      'employee_employment_period_ordered',
      sql`${t.employedUntil} is null or ${t.employedUntil} >= ${t.employedFrom}`,
    ),
  ],
)

/**
 * Skills held, one row per skill, so a therapist may hold both styles or neither.
 *
 * This is the table that keeps style an attribute of the **treatment** (ADR 0021). An
 * `employee.style treatment_style` column would compile and read naturally and be wrong three ways at
 * once: a therapist trained in both styles cannot be expressed, the catalogue's style enum becomes a
 * property of a person, and the first screen that read the therapist's style to decide what to charge
 * would recouple pricing to assignment — so reassigning a therapist would reprice the booking.
 */
export const employeeSkill = pgTable(
  'employee_skill',
  {
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'cascade' }),
    skill: therapistSkill('skill').notNull(),
    /** Read by the Unconfirmed Assumptions panel, as `service_room_type_compat.is_provisional` is. */
    isProvisional: boolean('is_provisional').notNull(),
    openQuestionId: text('open_question_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.employeeId, t.skill] }),
    check(
      'employee_skill_provisional_names_a_question',
      sql`not ${t.isProvisional} or ${t.openQuestionId} is not null`,
    ),
  ],
)

/**
 * One rostered span on one trading date; `shiftAssignment` says who is on it.
 *
 * Two tables rather than one `employee_shift`, because a shift is a span the premises rosters and the
 * assignment is who is on it: with one table, "move the evening shift half an hour later" is an update
 * per therapist, and the half that fails leaves two versions of one shift.
 *
 * Whether the span sits inside the date's trading window is deliberately not constrained. The solver
 * intersects presence with the window, so a shift running past close offers nothing past close and a
 * shift filed under the wrong trading date covers no candidate of that date — both roster errors are
 * inert, and a trigger asserting it would be a second opinion about where a trading day ends.
 */
export const shift = pgTable(
  'shift',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    tradingDate: date('trading_date')
      .notNull()
      .references(() => businessDay.tradingDate, { onUpdate: 'cascade', onDelete: 'restrict' }),
    /**
     * The rostered span, `[)` bounds. Crosses midnight on a normal day, which is why it is an instant
     * range and not a pair of `time` columns: 17:00–02:00 as two times cannot say which date the 02:00
     * belongs to, and that is the bug that loses the last two hours of every trading day.
     */
    period: tstzrange('period').notNull(),
    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('shift_trading_date_idx').on(t.tradingDate),
    index('shift_date_period_idx').using('gist', t.tradingDate, t.period),
    check('shift_period_nonempty', sql`not isempty(${t.period})`),
    check(
      'shift_period_bounded',
      sql`lower(${t.period}) is not null and upper(${t.period}) is not null`,
    ),
    check('shift_period_half_open', sql`lower_inc(${t.period}) and not upper_inc(${t.period})`),
  ],
)

/**
 * Who is on a shift.
 *
 * Two overlapping shifts for one employee are **not** an error: a roster written in two halves is one
 * presence, which `mergePeriods` in `@berelax/core` unions so that a treatment crossing the join is not
 * refused. `RESTRICT` on the employee, because somebody who has been rostered has a history and
 * deleting the person to erase the roster is the delete this refuses — ending employment is
 * `employedUntil`.
 */
export const shiftAssignment = pgTable(
  'shift_assignment',
  {
    shiftId: uuid('shift_id')
      .notNull()
      .references(() => shift.id, { onDelete: 'cascade' }),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shiftId, t.employeeId] }),
    index('shift_assignment_employee_idx').on(t.employeeId),
  ],
)

/**
 * Leave, with the approval state that decides whether it removes a therapist from availability.
 *
 * Availability reads the `employee_approved_leave` **view**, never this table — the same shape
 * `regulatory_profile_current` takes (0004), so the predicate cannot be forgotten. Forgetting it here
 * has a quiet consequence: a *pending* request would remove a therapist from the roster, which
 * presents as "no availability" with no reason attached.
 *
 * The period is an instant range rather than a pair of dates, and that is the decision in this table. A
 * day of leave stored as a date range starts at midnight, and midnight is the middle of a trading day:
 * leave "from the 20th" would cut the 19th's session at 00:00 and leave its last two hours rostered.
 * Instants let P-HR align a day of leave to the trading day or to the calendar day, which is a policy
 * question and theirs (Y8-leave).
 *
 * The exclusion constraint `leave_request_no_overlapping_approved` —
 * `exclude using gist (employee_id with =, period with &&) where (status = 'approved')` — is not
 * expressible in Drizzle. It lives in the migration and is asserted against real PostgreSQL.
 */
export const leaveRequest = pgTable(
  'leave_request',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'restrict' }),
    period: tstzrange('period').notNull(),
    kind: leaveKind('kind').notNull(),
    status: leaveStatus('status').notNull(),
    /** Null exactly while the request is pending, so "approved by nobody at no time" is unstorable. */
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('leave_request_employee_idx').on(t.employeeId, t.status),
    check('leave_request_period_nonempty', sql`not isempty(${t.period})`),
    check(
      'leave_request_period_bounded',
      sql`lower(${t.period}) is not null and upper(${t.period}) is not null`,
    ),
    check(
      'leave_request_period_half_open',
      sql`lower_inc(${t.period}) and not upper_inc(${t.period})`,
    ),
    // A biconditional rather than two one-way checks: pending with a decision instant is as wrong as
    // approved without one, and one named constraint catches both directions.
    check(
      'leave_request_decision_has_an_instant',
      sql`(${t.status} = 'pending') = (${t.decidedAt} is null)`,
    ),
  ],
)

/**
 * Credentials and their expiry.
 *
 * `expiresOn` is a **date**, not a timestamptz, and it is compared against the appointment's TRADING
 * date inclusively: a licence valid through the 18th covers the 18th's 01:30 appointment, whose
 * calendar date is the 19th. It is NOT NULL because a nullable expiry reads as "valid for ever", which
 * is the permissive default that makes an unrenewed licence invisible.
 *
 * A renewal is a **new row** with a later expiry rather than an edit, so the file still shows what was
 * valid last March; `employee_document_one_row_per_expiry` refuses only the exact duplicate, and the
 * eligibility read takes the latest expiry per (employee, type).
 */
export const employeeDocument = pgTable(
  'employee_document',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id, { onDelete: 'cascade' }),
    documentType: employeeDocumentType('document_type').notNull(),
    /**
     * The licence or certificate number. Null until somebody enters the real one, and a provisional
     * marker is refused outright: a plausible-looking licence number is indistinguishable from a
     * configured one, while a null is visibly unanswered (`is_placeholder_text`, 0026).
     */
    reference: text('reference'),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('employee_document_current_idx').on(t.employeeId, t.documentType, t.expiresOn.desc()),
    unique('employee_document_one_row_per_expiry').on(t.employeeId, t.documentType, t.expiresOn),
    check(
      'employee_document_reference_not_placeholder',
      sql`${t.reference} is null or not is_placeholder_text(${t.reference})`,
    ),
    check(
      'employee_document_expiry_after_issue',
      sql`${t.issuedOn} is null or ${t.expiresOn} >= ${t.issuedOn}`,
    ),
  ],
)

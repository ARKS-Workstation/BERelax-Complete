import {
  AppError,
  type GenderMatchingMode,
  genderMatchingMode,
  type TherapistSkill,
} from '@berelax/shared'
import type { Actor, ActorKind, RequestContext } from '../audit.ts'
import type { Sql } from '../connection.ts'
import { doNotPairExclusion, therapistsExcludedBy } from '../queries/therapist-exclusions.ts'
import { type ResolvedTemplateRow, readCurrentTemplate } from '../seed/templates.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  type EligibleTherapistRow,
  type ExcludedTherapistRow,
  readCommittedAppointments,
  readEligibleTherapists,
  type ScheduledAppointmentRow,
  type TherapistShiftRow,
} from './eligibility.ts'

/**
 * The reassignment flag's read and write side (P-HR-03, migration 0058).
 *
 * `appointment_reassignment_flag` says "this appointment's therapist may no longer take it" **without
 * touching the appointment**. Nothing here writes `appointment.status`, and that is the point rather
 * than an omission: `holds_resources` is GENERATED from the status (0024), so any terminal label would
 * release the therapist and the room in the same statement and hand the slot to somebody else while a
 * human is still deciding — and `cancelled_by_salon` tells a customer their booking is gone when the
 * intention is to keep it. The acceptance line is literal about it: status unchanged, and zero
 * appointments reaching CANCELLED_BY_SALON or NO_SHOW as a side effect.
 *
 * ## No judgement here
 *
 * Whether a therapist's file is current is `packages/core/src/hr/credentials.ts`'s, and `packages/db`
 * may never import `packages/core` — the dependency runs the other way. So this module returns **rows**
 * and writes **rows**, and the caller (`apps/worker/src/jobs/credential-sweep.ts`) supplies the verdict.
 * That is the same division `repositories/credentials.ts` states for the policy read.
 *
 * ## The audit row and the outbox event are the caller's
 *
 * `sweepRecurringCostAlerts` and the reverse-charge report make the same split: the repository writes
 * the row and returns what actually changed, the job writes the audit and publishes. It is what makes
 * "one audit_event and one notification per NEWLY flagged appointment" checkable — the insert returns
 * only the rows it inserted, so the count the job audits cannot drift from the count the database
 * accepted.
 */

/** A future appointment the sweep has to judge. No customer, no price: neither decides eligibility. */
export interface ReassignmentCandidateRow {
  readonly appointmentId: string
  readonly therapistId: string
  /** The appointment's trading date. The date the credential comparison is made against. */
  readonly tradingDate: string
  /** The treatment's start, for the notification and for ordering the queue. */
  readonly startsAt: Date
  readonly status: string
}

/** The window one sweep pass covers. Both halves come from `business_day`; see {@link readReassignmentCandidates}. */
export interface ReassignmentWindow {
  /**
   * The trading date the window starts at — the session the sweep instant belongs to, never
   * `date(instant)`.
   */
  readonly fromTradingDate: string
  /** The instant the window starts at. An appointment already under way is not reassignable. */
  readonly fromInstant: string
}

/**
 * Every appointment in the window that still holds its therapist, oldest first.
 *
 * ## Why the window needs both halves
 *
 * `trading_date >= fromTradingDate` alone is too wide: it would include the appointment that started an
 * hour ago and is being delivered right now, which nobody can reassign. `lower(period) >= fromInstant`
 * alone would be correct and unindexable — `appointment_trading_date_idx` is on the date, and a scan of
 * every appointment ever taken is what this query must not become. Together they are an index range plus
 * an exact cut.
 *
 * And the date half is the reason the fifth acceptance line exists. Trading runs 11:00–02:00, so at
 * 00:30 the session in force opened YESTERDAY: an appointment at 01:30 tonight carries yesterday's
 * trading date, and a window floored with the sweep instant's own calendar date would skip it. That is
 * not a rounding error — it is the two hours of every trading day in which a therapist whose licence
 * lapsed at midnight keeps their bookings. `businessDayAt` is what supplies the date, from the
 * calendar's own `opens_at`/`closes_at`.
 *
 * ## `holds_resources`, not a status list
 *
 * A cancelled, no-showed or superseded-by-reschedule appointment needs no therapist, so it needs no
 * flag; 0024 already reduces that question to one generated column and says why a second copy of the
 * status list is a liability. Restating it here would be the third copy.
 */
export async function readReassignmentCandidates(
  sql: Sql,
  window: ReassignmentWindow,
): Promise<readonly ReassignmentCandidateRow[]> {
  return sql<ReassignmentCandidateRow[]>`
    select a.id            as "appointmentId",
           a.therapist_id  as "therapistId",
           a.trading_date::text as "tradingDate",
           lower(a.period) as "startsAt",
           a.status::text  as status
      from appointment a
     where a.trading_date >= ${window.fromTradingDate}::date
       and lower(a.period) >= ${window.fromInstant}::timestamptz
       and a.holds_resources
     order by lower(a.period), a.id
  `
}

/** What the sweep decided about one appointment, for the row it writes. */
export interface ReassignmentFlagInput {
  readonly appointmentId: string
  readonly therapistId: string
  readonly appointmentTradingDate: string
  readonly reason: 'credential_missing' | 'credential_expired'
  /** The document type that blocks them. Never a bare "a credential lapsed". */
  readonly documentType: string
  /** The expiry judged against, or null for `credential_missing` — whole-or-nothing with `reason`. */
  readonly documentExpiresOn: string | null
  readonly regulatoryProfileVersion: number
  /** The TRADING date of the sweep pass, not its calendar date. */
  readonly detectedOn: string
}

/** A flag this pass actually raised. Empty on the second pass of a day, which is the point. */
export interface RaisedReassignmentFlag extends ReassignmentFlagInput {
  readonly flagId: string
}

/**
 * Raises the flags, and returns **only** the ones this call inserted.
 *
 * Idempotent in the DATABASE and not in the caller.
 * `appointment_reassignment_flag_one_live_per_appointment` is a partial unique index and this is
 * `on conflict ... do nothing`, so a second pass on the same day inserts nothing and returns nothing —
 * which is what makes the audit rows and the outbox events non-duplicating too, because the job writes
 * one of each per returned row. 0031 records the alternative and its cost: a job that remembered
 * "already flagged" in its own state would raise a second copy the first time that state was lost.
 *
 * `do nothing` and deliberately **not** `do update`. A live flag carries the credential that was
 * blocking WHEN IT WAS RAISED, and the `audit_event` beside it says the same thing; a row that rewrote
 * its own reason on every pass would make that audit trail unverifiable against the row it describes,
 * and the queue would be no more correct for it — the flag stays live for exactly as long as the
 * therapist is ineligible, whichever document is responsible by then. The clearance is where the
 * change of state is, and the clearance is recorded.
 *
 * The conflict target names the index predicate (`where cleared_at is null`), which is required for a
 * partial unique index: without it PostgreSQL looks for a total constraint on `appointment_id` and
 * refuses the statement rather than silently matching the wrong one.
 */
export async function flagAppointmentsForReassignment(
  sql: Sql,
  flags: readonly ReassignmentFlagInput[],
): Promise<readonly RaisedReassignmentFlag[]> {
  if (flags.length === 0) return []
  const raised: RaisedReassignmentFlag[] = []
  for (const flag of flags) {
    if (flag.reason === 'credential_expired' && flag.documentExpiresOn === null) {
      throw new AppError(
        'validation',
        `A credential_expired reassignment flag for appointment ${flag.appointmentId} carries no expiry ` +
          'date. The date is what makes the flag explainable, and the database refuses the pair ' +
          '(appointment_reassignment_flag_expiry_matches_reason).',
        { details: { appointmentId: flag.appointmentId, documentType: flag.documentType } },
      )
    }
    const [row] = await sql<{ id: string }[]>`
      insert into appointment_reassignment_flag
        (appointment_id, therapist_id, appointment_trading_date, reason, document_type,
         document_expires_on, regulatory_profile_version, detected_on)
      values (${flag.appointmentId}::uuid, ${flag.therapistId}::uuid,
              ${flag.appointmentTradingDate}::date,
              ${flag.reason}::appointment_reassignment_reason,
              ${flag.documentType}::employee_document_type,
              ${flag.documentExpiresOn}::date, ${flag.regulatoryProfileVersion},
              ${flag.detectedOn}::date)
      on conflict (appointment_id) where cleared_at is null do nothing
      returning id
    `
    if (row !== undefined) raised.push({ ...flag, flagId: row.id })
  }
  return raised
}

/** A flag a pass cleared, carrying enough to explain what was withdrawn. */
export interface ClearedReassignmentFlag {
  readonly flagId: string
  readonly appointmentId: string
  readonly therapistId: string
  readonly appointmentTradingDate: string
  readonly reason: string
  readonly documentType: string
}

/**
 * Clears the live flag on each of `appointmentIds`, and returns only the ones that were live.
 *
 * Stamped, never deleted: the flag is the evidence that the check ran and what it said, and a row that
 * vanished on renewal would make "was this appointment ever at risk" unanswerable — which is the
 * question asked after somebody has already been told it was.
 *
 * `cleared_on` is the sweep's TRADING date rather than `current_date`, for the reason the column's own
 * comment gives: the pass runs after trading closes at 02:00, so its calendar date is the day after the
 * session it swept.
 *
 * `cleared_reason` is `credential_restored` and it is written here rather than taken as an argument
 * (0065, P-HR-04). This function IS the sweep's clearance — it is called from
 * `apps/worker/src/jobs/credential-sweep.ts` and from nowhere else, and it clears exactly when the
 * therapist is credential-eligible again for the appointment's own trading date. The other two exits from
 * the queue are separate functions with separate labels, which is what makes "how did this leave the
 * queue" a question the row answers: a parameter here would let any caller claim any of the three.
 */
export async function clearReassignmentFlags(
  sql: Sql,
  args: { readonly appointmentIds: readonly string[]; readonly clearedOn: string },
): Promise<readonly ClearedReassignmentFlag[]> {
  if (args.appointmentIds.length === 0) return []
  return sql<ClearedReassignmentFlag[]>`
    update appointment_reassignment_flag
       set cleared_at = now(), cleared_on = ${args.clearedOn}::date,
           cleared_reason = 'credential_restored'
     where appointment_id = any(${[...args.appointmentIds]}::uuid[])
       and cleared_at is null
    returning id                        as "flagId",
              appointment_id            as "appointmentId",
              therapist_id              as "therapistId",
              appointment_trading_date::text as "appointmentTradingDate",
              reason::text              as reason,
              document_type::text       as "documentType"
  `
}

/** One live flag, as the reassignment queue and the HR screen read it. */
export interface LiveReassignmentFlagRow extends ClearedReassignmentFlag {
  readonly documentExpiresOn: string | null
  readonly regulatoryProfileVersion: number
  readonly detectedOn: string
  readonly flaggedAt: Date
}

/**
 * Every live flag, worst date first — the reassignment queue P-HR-04 works through.
 *
 * `appointmentIds` narrows it and is how a test asserts about its own rows without depending on what
 * earlier files in the integration suite left behind (brief rule 12). Omitted, it returns the whole
 * queue, which is what the screen wants: a queue is not per-appointment.
 */
export async function readLiveReassignmentFlags(
  sql: Sql,
  args: { readonly appointmentIds?: readonly string[] } = {},
): Promise<readonly LiveReassignmentFlagRow[]> {
  // `null` rather than an empty array for "every appointment": `= any(array[]::uuid[])` is false for
  // every row, so an empty array would silently mean "nothing" where the caller meant "everything".
  const narrowed = args.appointmentIds === undefined ? null : [...args.appointmentIds]
  return sql<LiveReassignmentFlagRow[]>`
    select id                             as "flagId",
           appointment_id                 as "appointmentId",
           therapist_id                   as "therapistId",
           appointment_trading_date::text as "appointmentTradingDate",
           reason::text                   as reason,
           document_type::text            as "documentType",
           document_expires_on::text      as "documentExpiresOn",
           regulatory_profile_version     as "regulatoryProfileVersion",
           detected_on::text              as "detectedOn",
           flagged_at                     as "flaggedAt"
      from appointment_reassignment_flag
     where needs_reassignment
       and (${narrowed}::uuid[] is null or appointment_id = any(${narrowed}::uuid[]))
     order by appointment_trading_date, flagged_at, id
  `
}

// ================================================================================================
// P-HR-04 — acting on the queue: the candidate read, the reassign transaction, the audited exit.
// ================================================================================================

/**
 * ## The queue, the candidates and the write, and the one thing they must agree about
 *
 * 0058 produces the work queue and this half works through it. Three things are added here and they are
 * one mechanism read from three ends:
 *
 *   - {@link readReassignmentQueue} — every live flag with the appointment it points at, ordered by the
 *     appointment's START. `readLiveReassignmentFlags` above orders by `flagged_at` and answers a
 *     different question ("what has the sweep found"); this one answers "what has to be dealt with
 *     first", and an appointment tomorrow evening outranks one next month whose flag is older.
 *   - {@link listReassignmentCandidates} — who may take it. The eligibility answer for the
 *     appointment's own trading date, narrowed by the composed exclusions the booking path applies, and
 *     handed to the INJECTED pure rule.
 *   - {@link reassignAppointment} — the write. All of it or none of it.
 *
 * **The listing and the write apply the same rule to freshly read rows.** That is the whole of the
 * unit's correctness: a candidate list is a memo, a page is rendered from it, and by the time somebody
 * clicks the therapist may have had leave approved, taken another booking or had a licence lapse. So the
 * transaction does not trust the tuple it is given — it re-reads the pool and the committed appointments
 * inside the transaction, with the appointment row locked, and re-applies the rule to the ONE therapist
 * named. `packages/fixtures/src/reassignment.itest.ts` drives exactly that sequence — list, change the
 * world, commit — because a test that lists and commits in one quiet breath proves nothing about it.
 *
 * ## Why there is no room lock and no therapist lock
 *
 * `createBooking` locks the `rooms` row because room capacity is a COUNT and a count can be taken twice.
 * A reassignment changes no room, no period and no places, so it cannot change any room's peak
 * concurrency — the deferred capacity trigger is forced immediate below and passes by arithmetic rather
 * than by luck. The therapist half is an EXCLUSION CONSTRAINT, which does not race: two staff members
 * reassigning two different appointments to one therapist over one period is settled by
 * `appointment_therapist_no_overlap` with SQLSTATE 23P01, and exactly one of them commits. That is the
 * fourth acceptance line, and it is a claim about the database rather than about this code — so the code
 * deliberately does not serialise it, and {@link reassignmentError} turns the loser's 23P01 into a named
 * `slot_taken` conflict rather than letting a 500 reach whoever was told to fix the rota.
 *
 * ## What a reassignment writes, and what it must not
 *
 * `appointment.therapist_id`, and nothing else on the appointment. Not the status — 0058's header gives
 * the reason in full and it has not changed: `holds_resources` is GENERATED from the status (0024), so
 * any new label releases the therapist and the room, and `cancelled_by_salon` tells a customer their
 * booking is gone when the intention is to keep it. Not the price, the variant, the room, the period or
 * the delivery either, which is the second acceptance line asserted by column equality before and
 * after.
 *
 * The history row is the 0065 trigger's, not this module's, for 0024's reason: a history table the
 * application writes is a history table with gaps exactly where somebody was in a hurry. It is read back
 * and refused unless it carries this actor, this role, this reason and this therapist pair — 0036's
 * recorded failure was 8,202 rows with three NULLs in them, because the value was demanded of the
 * operator, validated, and then dropped on the floor.
 */

/** Every reason a reassignment is refused, as a value. Callers branch on these, never on prose. */
export const REASSIGNMENT_REFUSALS = [
  /** No appointment with that id. */
  'appointment_not_found',
  /**
   * The appointment no longer holds its therapist and room: cancelled, no-showed or superseded by a
   * reschedule. There is nothing to reassign, and writing a therapist onto it would put a person back
   * on a booking that does not exist.
   */
  'appointment_released',
  /** The therapist named already holds it. Not an error to swallow: the caller believes it changed. */
  'therapist_unchanged',
  /** The footprint this appointment was sold in is no longer offered, so no required skill is readable. */
  'shape_not_offered',
  /** The named therapist may not take this appointment. Carries the rejection the rule reported. */
  'therapist_not_eligible',
  /** Somebody else committed an overlapping appointment for that therapist first (23P01). */
  'slot_taken',
  /** The rows of one delivery would disagree about the room, the period or the footprint (ZB004). */
  'delivery_incoherent',
  /** The room would hold more overlapping appointments than its capacity (ZB001). */
  'room_over_capacity',
  /** No candidate rule was injected, so nothing re-applied the availability answer. Fail closed. */
  'candidates_not_revalidated',
  /** No notice rule was injected, so nothing judged the customer notification. Fail closed. */
  'notice_not_judged',
  /** The notice cannot be sent: no template, the wrong one, the wrong class, or unapproved words. */
  'notice_not_sendable',
  /** The trigger did not append exactly one history row carrying this actor, reason and pair. */
  'reassignment_not_recorded',
  /** The reason is not one the database accepts for a reassignment row. */
  'reason_not_known',
  /** The outbox already held this event, so the reassignment would commit with nothing announced. */
  'event_not_enqueued',
  /** An explicit resolution with no live flag to resolve, or with no note. */
  'nothing_to_resolve',
] as const
export type ReassignmentRefusal = (typeof REASSIGNMENT_REFUSALS)[number]

/** `23P01`, exclusion_violation — `appointment_therapist_no_overlap`, the therapist half of ADR 0015. */
const EXCLUSION_VIOLATION = '23P01'
/** `23514`, check_violation. Only one of them is this transaction's to name; see {@link reassignmentError}. */
const CHECK_VIOLATION = '23514'
/** `ZB001` — the deferred room-capacity trigger (0024, re-issued by 0038). */
const ROOM_OVER_CAPACITY = 'ZB001'
/** `ZB004` — `appointment_delivery_is_coherent` (0038). */
const DELIVERY_INCOHERENT = 'ZB004'
/** The 0065 CHECK that closes a reassignment row's reason to the four P-HR-04 declares. */
const REASON_CONSTRAINT = 'appointment_status_history_reassignment_reason_known'

const refusal = (
  kind: 'conflict' | 'validation' | 'forbidden' | 'not_found' | 'invariant_violated',
  name: ReassignmentRefusal,
  message: string,
  extra: Record<string, unknown> = {},
): AppError =>
  new AppError(kind, `${name}: ${message}`, {
    userFacing: true,
    details: { refusal: name, ...extra },
  })

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/** The constraint a driver error names, from either spelling the drivers use. */
const constraintOf = (err: unknown): string | undefined => {
  const named = err as { constraint_name?: unknown; constraint?: unknown } | null
  if (typeof named?.constraint_name === 'string') return named.constraint_name
  if (typeof named?.constraint === 'string') return named.constraint
  const carried = (err as { details?: { constraint?: unknown } } | null)?.details?.constraint
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a PostgreSQL error from a reassignment into a named `AppError`, or `null`.
 *
 * The 23P01 case is the fourth acceptance line's second half: *the rejection surfaces as a conflict, not
 * a 500*. It can only be `appointment_therapist_no_overlap` — the only EXCLUDE on `appointment` — and the
 * loser of that race has done nothing wrong, so it is a `conflict` carrying the winner's own
 * explanation rather than an internal error.
 *
 * Anything unrecognised returns `null` and is rethrown. A translation that guessed would report a disk
 * error as a taken slot, and somebody would go looking for a booking that is not there.
 */
export function reassignmentError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code, constraint: constraintOf(err) }
  switch (code) {
    case EXCLUSION_VIOLATION:
      return refusal(
        'conflict',
        'slot_taken',
        `that therapist already holds an appointment overlapping this one. ${message}`,
        details,
      )
    case ROOM_OVER_CAPACITY:
      return refusal('conflict', 'room_over_capacity', message, details)
    case DELIVERY_INCOHERENT:
      return refusal('invariant_violated', 'delivery_incoherent', message, details)
    case CHECK_VIOLATION:
      // ONE check, named. Every other 23514 on these tables means something else entirely, and
      // reporting it as "that reason is not allowed" would send the reader to the wrong vocabulary.
      return constraintOf(err) === REASON_CONSTRAINT
        ? refusal(
            'validation',
            'reason_not_known',
            'a reassignment records one of the four reasons P-HR-04 declares ' +
              `(REASSIGNMENT_REASONS in @berelax/core, mirrored by 0065 as this constraint). ${message}`,
            details,
          )
        : null
    default:
      return null
  }
}

/** The refusal an error carries, or `null`. Lets a caller branch without matching on the message. */
export function reassignmentRefusalOf(err: unknown): ReassignmentRefusal | null {
  const translated = err instanceof AppError ? err : reassignmentError(err)
  const name = translated?.details['refusal']
  return REASSIGNMENT_REFUSALS.includes(name as ReassignmentRefusal)
    ? (name as ReassignmentRefusal)
    : null
}

/**
 * One row of the reassignment queue: the live flag, and the appointment it is about.
 *
 * `therapistReference` is `employee.staff_reference` — "Therapist 07", the internal handle — and never a
 * name: nineteen employees have none recorded and the ones that do have it under a publication guard
 * (ADR 0020, brief rule 10). The customer is not named at all, for the same reason the credentials
 * screen shows no document number: nothing on this queue needs it.
 */
export interface ReassignmentQueueRow extends LiveReassignmentFlagRow {
  readonly bookingId: string
  /** The treatment's start. The axis the queue is ordered on. */
  readonly startsAt: Date
  readonly endsAt: Date
  readonly appointmentStatus: string
  readonly shape: string
  readonly deliveryId: string
  readonly roomCode: string
  /** The internal staff handle of the therapist the appointment was sold with. Never a person's name. */
  readonly therapistReference: string | null
}

/**
 * The queue, worst-first by the appointment's own start.
 *
 * An INNER join to `appointment`, deliberately: `appointment_id` references nothing (0058 — PostgreSQL
 * refuses `truncate appointment` while a referencing table is absent from the statement), so a flag can
 * outlive its appointment, and such a row is invisible to every reader because they all join. Making it
 * visible here would put a queue entry on a screen that cannot be acted on and cannot be explained.
 *
 * `appointmentIds` narrows it, which is how a test asserts about its own rows without depending on what
 * earlier files in the integration suite left behind (brief rule 12). Omitted, it returns the whole
 * queue, which is what the screen wants.
 */
export async function readReassignmentQueue(
  sql: Sql,
  args: { readonly appointmentIds?: readonly string[] } = {},
): Promise<readonly ReassignmentQueueRow[]> {
  // `null` rather than an empty array for "every appointment", for the reason
  // `readLiveReassignmentFlags` gives: `= any(array[]::uuid[])` is false for every row.
  const narrowed = args.appointmentIds === undefined ? null : [...args.appointmentIds]
  return sql<ReassignmentQueueRow[]>`
    select f.id                             as "flagId",
           f.appointment_id                 as "appointmentId",
           f.therapist_id                   as "therapistId",
           f.appointment_trading_date::text as "appointmentTradingDate",
           f.reason::text                   as reason,
           f.document_type::text            as "documentType",
           f.document_expires_on::text      as "documentExpiresOn",
           f.regulatory_profile_version     as "regulatoryProfileVersion",
           f.detected_on::text              as "detectedOn",
           f.flagged_at                     as "flaggedAt",
           a.booking_id                     as "bookingId",
           lower(a.period)                  as "startsAt",
           upper(a.period)                  as "endsAt",
           a.status::text                   as "appointmentStatus",
           a.shape::text                    as shape,
           a.delivery_id                    as "deliveryId",
           r.code                           as "roomCode",
           e.staff_reference                as "therapistReference"
      from appointment_reassignment_flag f
      join appointment a on a.id = f.appointment_id
      join rooms r on r.id = a.room_id
      -- LEFT, because appointment.therapist_id has no foreign key either (0024): an employee row
      -- removed by a fixture teardown must not take the queue entry with it.
      left join employee e on e.id = f.therapist_id
     where f.needs_reassignment
       and (${narrowed}::uuid[] is null or f.appointment_id = any(${narrowed}::uuid[]))
     -- The appointment's START, then its id. Ordered here as well as in the pure comparator
     -- (compareQueueEntries in @berelax/core) so the screen's order survives a re-sort and the two are
     -- asserted equal by the pair itest; the id tiebreak matters because the two rows of a couple
     -- booking start at the same minute.
     order by lower(a.period), f.appointment_id
  `
}

/** Everything the candidate rule needs about the appointment being reassigned. */
export interface ReassignmentTarget {
  readonly appointmentId: string
  readonly bookingId: string
  readonly customerId: string
  /** The locale the customer reads, for the notice. `en` or `ar` as `customer.locale` holds it. */
  readonly customerLocale: string
  readonly therapistId: string
  readonly tradingDate: string
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  /** The appointment's OWN snapshot (0038), never today's catalogue figure. */
  readonly therapistBufferMinutes: number
  readonly requiredSkill: TherapistSkill
  readonly shape: string
  readonly roomId: string
  readonly deliveryId: string
  readonly status: string
  readonly holdsResources: boolean
}

interface TargetRow {
  readonly booking_id: string
  readonly customer_id: string
  readonly customer_locale: string | null
  readonly therapist_id: string
  readonly trading_date: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly therapist_buffer_minutes: number
  readonly shape: string
  readonly room_id: string
  readonly delivery_id: string
  readonly status: string
  readonly holds_resources: boolean
  readonly required_skill: TherapistSkill | null
}

/**
 * The appointment, its booking's customer and the ONE catalogue fact the rule needs, in one statement.
 *
 * `lock` takes `SELECT … FOR NO KEY UPDATE`. It is a parameter rather than two functions because the
 * read is identical and the difference is the whole point: the listing reads without a lock, because a
 * candidate list is a memo; the transaction reads with one, because what it reads it then writes. A
 * second copy of this SQL would be a second answer to "which appointment is this".
 *
 * NO KEY rather than a plain FOR UPDATE, because `booking` and `customer` are joined in the same
 * statement: a plain row lock on those two would block every concurrent insert that references them —
 * every other booking that customer makes — for the length of this transaction.
 *
 * `required_skill` is today's catalogue and that is right for what it decides: which skill may deliver
 * this treatment is a rule, not a figure that was sold. The buffer beside it is the appointment's own
 * snapshot, because that one WAS sold (0038) — re-deriving it would move the busy interval of an
 * appointment already in the diary while deciding who may deliver it.
 */
async function readTarget(
  sql: Sql,
  args: { readonly appointmentId: string; readonly lock: boolean },
): Promise<ReassignmentTarget | undefined> {
  const [row] = await sql<TargetRow[]>`
    select a.booking_id::text          as booking_id,
           b.customer_id::text         as customer_id,
           c.locale                    as customer_locale,
           a.therapist_id::text        as therapist_id,
           a.trading_date::text        as trading_date,
           lower(a.period)             as starts_at,
           upper(a.period)             as ends_at,
           a.therapist_buffer_minutes  as therapist_buffer_minutes,
           a.shape::text               as shape,
           a.room_id::text             as room_id,
           a.delivery_id::text         as delivery_id,
           a.status::text              as status,
           a.holds_resources           as holds_resources,
           sk.required_skill::text     as required_skill
      from appointment a
      join booking b on b.id = a.booking_id
      join customer c on c.id = b.customer_id
      join service_variant v on v.id = a.service_variant_id
      join service s on s.id = v.service_id
      left join service_skill sk on sk.style = s.style
     where a.id = ${args.appointmentId}
       ${args.lock ? sql`for no key update of a` : sql``}
  `
  if (row === undefined) return undefined
  if (row.required_skill === null) {
    throw refusal(
      'conflict',
      'shape_not_offered',
      'no service_skill row says which skill this treatment style requires, so there is no ' +
        'eligibility question to ask. Guessing one would offer a therapist trained in the other style.',
      { appointmentId: args.appointmentId, shape: row.shape },
    )
  }
  return {
    appointmentId: args.appointmentId,
    bookingId: row.booking_id,
    customerId: row.customer_id,
    // `en` is not a guess: `customer.locale` is NOT NULL with a default, and the fallback is here only
    // because this reader may not assume a column's nullability on a caller's behalf.
    customerLocale: row.customer_locale ?? 'en',
    therapistId: row.therapist_id,
    tradingDate: row.trading_date,
    treatment: { startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() },
    therapistBufferMinutes: Number(row.therapist_buffer_minutes),
    requiredSkill: row.required_skill,
    shape: row.shape,
    roomId: row.room_id,
    deliveryId: row.delivery_id,
    status: row.status,
    holdsResources: row.holds_resources,
  }
}

/** The appointment being judged, as the injected rule takes it. Field for field core's own shape. */
export interface ReassignmentRuleAppointment {
  readonly appointmentId: string
  readonly therapistId: string
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly therapistBufferMinutes: number
}

/** The eligibility answer the rule consumes. Field for field `TherapistPool` in `@berelax/core`. */
export interface ReassignmentRulePool {
  readonly therapists: readonly EligibleTherapistRow[]
  readonly shifts: readonly TherapistShiftRow[]
  /**
   * `ExcludedTherapistRow`, so `reason` is the port's CLOSED union rather than a bare string.
   *
   * It has to be closed for the injected rule to be assignable to this type at all: the pure rule
   * reports the pool's reason verbatim, and a `string` here would make `reassignmentCandidates` unable
   * to `satisfies` this seam — which is the line in `packages/fixtures/src/reassignment.itest.ts` that
   * pins the two declarations together. The seven labels are already pinned to core's own list in both
   * directions by `therapist-eligibility.itest.ts`.
   */
  readonly excluded: readonly ExcludedTherapistRow[]
}

export interface ReassignmentRuleInput {
  readonly appointment: ReassignmentRuleAppointment
  readonly pool: ReassignmentRulePool
  readonly committed: readonly ScheduledAppointmentRow[]
}

export interface ReassignmentRuleAnswer {
  readonly candidates: readonly string[]
  readonly rejected: readonly { readonly therapistId: string; readonly reason: string }[]
  readonly buffered: { readonly startsAt: number; readonly endsAt: number }
}

/**
 * `reassignmentCandidates` from `@berelax/core`, injected.
 *
 * A function rather than an import because `packages/db` must never import `packages/core`, and
 * required rather than optional for the reason `createBooking` gives for its own re-check: a
 * reassignment written without the availability answer being re-applied is a reassignment nobody
 * checked, and the permissive default is the failure this whole transaction exists to prevent.
 * `packages/fixtures/src/reassignment.itest.ts` pins the two declarations with `satisfies`.
 */
export type ReassignmentCandidateRule = (input: ReassignmentRuleInput) => ReassignmentRuleAnswer

/** The template row the notice rule judges. Field for field `ResolvedNoticeTemplate` in core. */
export interface NoticeTemplateRow {
  readonly templateKey: string
  readonly messageClass: string
  readonly approvalState: string
}

/** What the notice rule answers. Field for field `NoticeVerdict` in core. */
export type NoticeRuleVerdict =
  | { readonly kind: 'sendable'; readonly templateKey: string }
  | { readonly kind: 'refused'; readonly refusal: string; readonly why: string }

/**
 * `judgeReassignmentNotice` from `@berelax/core`, injected for the same reason the candidate rule is.
 *
 * The compliance claim it enforces — a booking-change notice is TRANSACTIONAL and may be nothing else —
 * belongs in core beside the template key it names. This module reads the row and refuses to commit on a
 * verdict it does not understand; it holds no copy of the class vocabulary, so a reclassification cannot
 * be worked around by a second reading here.
 */
export type ReassignmentNoticeRule = (row: NoticeTemplateRow | undefined) => NoticeRuleVerdict

export interface ReassignmentDeps {
  readonly candidates: ReassignmentCandidateRule
  readonly notice: ReassignmentNoticeRule
}

/** Who performed the reassignment. The same shape `transitionAppointment` takes, for one vocabulary. */
export interface ReassignmentActor {
  readonly kind: ActorKind
  /** The F07 role, e.g. `owner`, `manager`. 0046's CHECK refuses a role the policy layer does not know. */
  readonly role: string
  readonly id?: string
  readonly label?: string
}

export interface ListCandidatesInput {
  readonly appointmentId: string
  /**
   * The **client's** gender, when it was collected. No table holds it (B-AVAIL-05: `customer` has no
   * gender column), so it is an argument here exactly as it is in `createBooking`.
   *
   * Absent means the eligibility read is not asked a client-specific question, so it applies no gender
   * narrowing — which for a REASSIGNMENT would offer a therapist the booking path refused. So
   * {@link reassignAppointment} refuses an absent value under strict matching rather than relaxing it,
   * and the listing reports what it was asked through
   * {@link ReassignmentCandidateList.genderApplied} rather than silently returning a wider answer.
   */
  readonly clientGender?: 'female' | 'male'
  /** `booking.same_gender_matching`, from `readGenderMatching`. **Absent is strict**, as everywhere. */
  readonly genderMatching?: GenderMatchingMode
}

export interface ReassignmentCandidateList {
  readonly appointment: ReassignmentTarget
  readonly candidates: readonly string[]
  readonly rejected: readonly { readonly therapistId: string; readonly reason: string }[]
  /** The interval every candidate was judged free over: the treatment plus its buffer, both sides. */
  readonly buffered: { readonly startsAt: number; readonly endsAt: number }
  /** False when no client gender was supplied, so the answer is not client-specific. See the input. */
  readonly genderApplied: boolean
  /** How many therapists a composed exclusion removed. A count, never the ids: see the note below. */
  readonly silentlyExcluded: number
}

/**
 * Who may take this appointment instead. A read, and deliberately not a lock.
 *
 * The composed exclusions are applied by REMOVING the candidate before the rule runs, which is
 * `composedExclusions`' own shape for an exclusion whose `reason` is null (C-CRM-01): there is then no
 * row and no label for a reason to leak from. Only a COUNT reaches the answer — naming the ids would
 * reconstruct the do-not-pair list from a screen whose job is to pick a therapist, and that list is a
 * fact about an employee and a customer that this surface has no use for.
 *
 * The result is a memo, which the transaction shows it knows by re-reading rather than trusting it.
 */
export async function listReassignmentCandidates(
  sql: Sql,
  input: ListCandidatesInput,
  deps: Pick<ReassignmentDeps, 'candidates'>,
): Promise<ReassignmentCandidateList> {
  if (typeof deps?.candidates !== 'function') {
    throw refusal(
      'invariant_violated',
      'candidates_not_revalidated',
      'no candidate rule was supplied, so nothing applied the availability answer. ' +
        '`reassignmentCandidates` from @berelax/core is the rule; packages/db may not import it, so ' +
        'the caller injects it.',
    )
  }
  const target = await readTarget(sql, { appointmentId: input.appointmentId, lock: false })
  if (target === undefined) {
    throw refusal(
      'not_found',
      'appointment_not_found',
      `no appointment with id ${input.appointmentId}`,
      { appointmentId: input.appointmentId },
    )
  }
  return await candidatesFor(sql, { target, input, rule: deps.candidates })
}

/**
 * The candidate computation both halves share: one pool read, one exclusion read, one rule call.
 *
 * Shared rather than copied because the listing and the transaction must apply the SAME rule to the
 * same shape of facts — the only difference being WHEN they read them. Two copies of this is how the
 * page comes to offer a therapist the transaction then refuses for a reason nobody can see.
 */
async function candidatesFor(
  sql: Sql,
  args: {
    readonly target: ReassignmentTarget
    readonly input: ListCandidatesInput
    readonly rule: ReassignmentCandidateRule
  },
): Promise<ReassignmentCandidateList> {
  const { target, input, rule } = args
  const pool = await readEligibleTherapists(sql, {
    tradingDate: target.tradingDate,
    requiredSkill: target.requiredSkill,
    ...(input.clientGender === undefined ? {} : { clientGender: input.clientGender }),
    ...(input.genderMatching === undefined ? {} : { genderMatching: input.genderMatching }),
  })
  // C-CRM-01's do-not-pair flag, asked of the exclusions themselves rather than of
  // `readEligibleTherapists` — that function is the PORT and `EligibilityQueryInput` carries no
  // exclusions by design. The same value the availability read composes, so the rule has one definition
  // and this path cannot drift from it.
  const composed = await therapistsExcludedBy(sql, {
    therapistIds: pool.therapists.map((therapist) => therapist.therapistId),
    exclusions: [doNotPairExclusion(sql, { customerId: target.customerId })],
  })
  const visible: ReassignmentRulePool = {
    therapists: pool.therapists.filter((therapist) => !composed.has(therapist.therapistId)),
    // Presence is only meaningful for a therapist still in the pool, and handing the rule a shift for
    // somebody it was never told about would make the two inputs disagree about who the question is
    // about — the same reason `readEligibleTherapists` filters its own presence rows.
    shifts: pool.shifts.filter((shift) => !composed.has(shift.therapistId)),
    excluded: pool.excluded,
  }
  const committed = await readCommittedAppointments(sql, { tradingDate: target.tradingDate })
  const answer = rule({
    appointment: {
      appointmentId: target.appointmentId,
      therapistId: target.therapistId,
      treatment: target.treatment,
      therapistBufferMinutes: target.therapistBufferMinutes,
    },
    pool: visible,
    committed,
  })
  return {
    appointment: target,
    candidates: answer.candidates,
    rejected: answer.rejected,
    buffered: answer.buffered,
    genderApplied: input.clientGender !== undefined,
    silentlyExcluded: composed.size,
  }
}

export interface ReassignInput extends ListCandidatesInput {
  /** The therapist who will take it. Refused unless the rule, applied now, returns them. */
  readonly toTherapistId: string
  /** One of `REASSIGNMENT_REASONS` in `@berelax/core`. 0065 refuses anything else. */
  readonly reason: string
  readonly actor: ReassignmentActor
  /**
   * The TRADING date the decision is taken on, for the flag's `cleared_on`.
   *
   * An argument and not `current_date`, for the reason that column's own comment gives: trading runs
   * 11:00–02:00, so at 00:30 the session in force opened yesterday and a calendar date would file the
   * clearance under a day the salon was not trading. `resolveTradingDate` is the rule and it is
   * `@berelax/core`'s, which this package may not import.
   */
  readonly decidedOn: string
  /**
   * The template key the customer notice is sent under — `REASSIGNMENT_NOTICE_TEMPLATE_KEY` in
   * `@berelax/core`.
   *
   * The caller's rather than a constant here, because this package may not import that module; and the
   * injected rule checks the key it gets back, so the two halves verify each other rather than trusting
   * one spelling. A caller naming another template is refused by the rule's `notice_template_wrong`.
   */
  readonly noticeTemplateKey: string
}

/** One committed reassignment, read back rather than assumed. */
export interface ReassignmentResult {
  readonly appointmentId: string
  readonly bookingId: string
  readonly fromTherapistId: string
  readonly toTherapistId: string
  readonly reason: string
  /** The appended `appointment_status_history` row, read back inside the transaction. */
  readonly history: {
    readonly id: string
    readonly fromTherapistId: string | null
    readonly toTherapistId: string | null
    readonly status: string
    readonly occurredAt: Date
  }
  /** The flag this cleared, or `null` when there was none — leave and archival need not be flagged first. */
  readonly clearedFlagId: string | null
  /** The notice enqueued: the template version it names, and the class it was judged under. */
  readonly notice: {
    readonly templateId: string
    readonly templateKey: string
    readonly messageClass: string
    readonly locale: string
    readonly eventId: string
  }
  readonly eventId: string
}

/** The reassignment itself, and the customer notification. Two events, because they are two facts. */
export const REASSIGNED_EVENT = 'appointment.therapist_reassigned'
export const REASSIGNMENT_NOTICE_EVENT = 'appointment.therapist_changed_notice'
/** Published when a human closes a queue entry without a reassignment. */
export const REASSIGNMENT_RESOLVED_EVENT = 'appointment.reassignment_resolved'

interface ReassignmentHistoryRow {
  readonly id: string
  readonly from_status: string | null
  readonly to_status: string
  readonly from_therapist_id: string | null
  readonly to_therapist_id: string | null
  readonly actor_kind: string | null
  readonly actor_id: string | null
  readonly actor_role: string | null
  readonly reason: string | null
  readonly occurred_at: Date
}

/**
 * Hands the actor, the role and the reason to the 0046/0065 trigger.
 *
 * Transaction-local (`set_config(…, true)`), so an actor cannot leak into the next statement on a pooled
 * connection. The same five keys `transitionAppointment` sets, because it is the same trigger: two
 * spellings of these names would be a reassignment recorded with three NULLs in it, which is 0036's
 * failure exactly.
 */
async function announceActor(
  uow: UnitOfWork,
  actor: ReassignmentActor,
  reason: string,
): Promise<void> {
  await uow.sql`
    select set_config('berelax.transition_actor_kind', ${actor.kind}, true),
           set_config('berelax.transition_actor_id', ${actor.id ?? ''}, true),
           set_config('berelax.transition_actor_label', ${actor.label ?? ''}, true),
           set_config('berelax.transition_actor_role', ${actor.role}, true),
           set_config('berelax.transition_reason', ${reason}, true)
  `
}

/** The highest history id this appointment holds, read under the row lock. `'0'` when it has none. */
async function historyHighWater(uow: UnitOfWork, appointmentId: string): Promise<string> {
  const [row] = await uow.sql<{ high: string }[]>`
    select coalesce(max(id), 0)::text as high
      from appointment_status_history where appointment_id = ${appointmentId}
  `
  return row?.high ?? '0'
}

/**
 * The three facts that make a reassignment impossible before anybody is judged eligible.
 *
 * A separate function because the reassignment itself is long enough without them, and because each one
 * is a different conversation: the appointment is gone, the caller already has what they asked for, or
 * nobody has collected the fact the gender rule needs.
 */
function assertReassignable(target: ReassignmentTarget, input: ReassignInput): void {
  if (!target.holdsResources) {
    throw refusal(
      'conflict',
      'appointment_released',
      `the appointment is ${target.status}, so it holds no therapist and no room (holds_resources is ` +
        'generated from the status, 0024). Writing a therapist onto it would put somebody back on a ' +
        'booking that no longer exists.',
      { appointmentId: input.appointmentId, status: target.status },
    )
  }
  if (target.therapistId === input.toTherapistId) {
    throw refusal(
      'validation',
      'therapist_unchanged',
      'that therapist already holds this appointment. Answering yes to a reassignment that reassigns ' +
        'nothing would tell the caller the rota changed, and the queue entry would still be there.',
      { appointmentId: input.appointmentId, therapistId: input.toTherapistId },
    )
  }
  // B-AVAIL-05's rule, honoured rather than re-opened - the same refusal `createBooking` makes and for
  // the same reason: an absent client gender means the eligibility read is not asked a client-specific
  // question, so a reassignment taken without it would assign a therapist the booking path refused.
  if (genderMatchingMode(input.genderMatching) === 'strict' && input.clientGender === undefined) {
    throw refusal(
      'validation',
      'therapist_not_eligible',
      "the client's gender has not been collected, and same-gender matching is a hard constraint " +
        'under strict mode (ADR 0020, Y9-gender open). It is a fact no table holds, so it is an ' +
        'argument the caller has to write out; a reassignment taken without it would hand the ' +
        'appointment to a therapist the availability query refused to offer.',
      { appointmentId: input.appointmentId },
    )
  }
}

/**
 * Asserts the chain recorded this reassignment, once, with its attribution - and returns the row.
 *
 * Every clause has a precedent. More than one row means something else changed the same appointment in
 * this transaction and the chain no longer describes one act; zero means the 0065 trigger does not fire
 * for `therapist_id`, which is what dropping that column from its `update of` list looks like; a NULL
 * actor is a `set_config` that never arrived, which is 0036's recorded failure - 8,202 rows with three
 * NULLs in them because the value was demanded, validated and then dropped on the floor; and a row whose
 * status MOVED means this was not a reassignment at all.
 */
function assertReassignmentRecorded(
  appended: readonly ReassignmentHistoryRow[],
  args: {
    readonly fromTherapistId: string
    readonly toTherapistId: string
    readonly status: string
    readonly actor: ReassignmentActor
    readonly reason: string
  },
): ReassignmentHistoryRow {
  const row = appended[0]
  const recorded =
    appended.length === 1 &&
    row !== undefined &&
    row.from_therapist_id === args.fromTherapistId &&
    row.to_therapist_id === args.toTherapistId &&
    row.from_status === args.status &&
    row.to_status === args.status &&
    row.actor_kind === args.actor.kind &&
    row.actor_role === args.actor.role &&
    row.actor_id === (args.actor.id ?? null) &&
    row.reason === args.reason
  if (!recorded || row === undefined) {
    throw refusal(
      'invariant_violated',
      'reassignment_not_recorded',
      `the update appended ${appended.length} history row(s), and exactly one must carry this actor, ` +
        'this reason and this therapist pair. The chain is written by the 0065 trigger, so a row with ' +
        'NULLs in it is a `set_config` that never arrived (0036), no row at all means the trigger no ' +
        'longer fires for `therapist_id`, and a row whose status moved means something else changed ' +
        'the appointment in this transaction.',
      {
        appended: appended.length,
        expected: { ...args, actorId: args.actor.id ?? null },
        stored:
          row === undefined
            ? null
            : {
                fromTherapistId: row.from_therapist_id,
                toTherapistId: row.to_therapist_id,
                fromStatus: row.from_status,
                toStatus: row.to_status,
                actorKind: row.actor_kind,
                actorRole: row.actor_role,
                reason: row.reason,
              },
      },
    )
  }
  return row
}

/**
 * The customer notice's template version, resolved inside the transaction and judged by the rule.
 *
 * Resolved HERE rather than by the caller for the reason B-MSG-03 gives for resolving a reminder's
 * template at send time: a template id chosen on a page is a template id from before somebody
 * reclassified it, and the class decides which gates the send goes through. Judged by the injected rule
 * because the compliance claim - a booking-change notice is TRANSACTIONAL and may be nothing else -
 * belongs in `@berelax/core` beside the key it names, and this package may not import it.
 *
 * It throws rather than returning a verdict, and that is the decision with a cost written out: a
 * template left in `draft` blocks every reassignment until somebody approves it. It is the right cost,
 * because the appointment stays in the reassignment queue where it already was, the refusal names the
 * template, and the alternative is a therapist swapped and a customer who finds out when a stranger
 * opens the treatment-room door.
 */
async function resolveNotice(
  uow: UnitOfWork,
  args: {
    readonly templateKey: string
    readonly locale: string
    readonly judge: ReassignmentNoticeRule
  },
): Promise<ResolvedTemplateRow> {
  const template = await readCurrentTemplate(uow.sql, {
    key: args.templateKey,
    channel: 'sms',
    locale: args.locale,
  })
  const verdict = args.judge(
    template === undefined
      ? undefined
      : {
          templateKey: template.templateKey,
          messageClass: template.messageClass,
          approvalState: template.approvalState,
        },
  )
  if (verdict.kind !== 'sendable' || template === undefined) {
    throw refusal(
      'conflict',
      'notice_not_sendable',
      verdict.kind === 'refused'
        ? verdict.why
        : `the notice rule approved a template this transaction could not read (${args.templateKey}).`,
      {
        templateKey: args.templateKey,
        locale: args.locale,
        ...(verdict.kind === 'refused' ? { noticeRefusal: verdict.refusal } : {}),
      },
    )
  }
  return template
}

/**
 * Reassigns one appointment inside an existing unit of work. All of it, or none of it.
 *
 * Call it through {@link reassignAppointmentTx} unless the reassignment is part of a larger transaction.
 */
export async function reassignAppointment(
  uow: UnitOfWork,
  input: ReassignInput,
  deps: ReassignmentDeps,
): Promise<ReassignmentResult> {
  // Fail closed, both of them. A reassignment written without the availability answer re-applied is one
  // nobody checked, and one written without the notice judged is a therapist swapped without the
  // customer being told.
  if (typeof deps?.candidates !== 'function') {
    throw refusal(
      'invariant_violated',
      'candidates_not_revalidated',
      'no candidate rule was supplied, so nothing re-applied the availability answer inside the ' +
        'transaction. `reassignmentCandidates` from @berelax/core is the rule; packages/db may not ' +
        'import it, so the caller injects it.',
    )
  }
  if (typeof deps?.notice !== 'function') {
    throw refusal(
      'invariant_violated',
      'notice_not_judged',
      'no notice rule was supplied, so nothing judged the customer notification. ' +
        '`judgeReassignmentNotice` from @berelax/core is the rule.',
    )
  }
  // FOR NO KEY UPDATE, and before anything is judged. The lock is what makes the re-read below a
  // re-read: without it the pool is read, the rule applied and the row written across three statements,
  // and a competitor can commit between any two of them.
  const target = await readTarget(uow.sql, { appointmentId: input.appointmentId, lock: true })
  if (target === undefined) {
    throw refusal(
      'not_found',
      'appointment_not_found',
      `no appointment with id ${input.appointmentId}`,
      { appointmentId: input.appointmentId },
    )
  }
  assertReassignable(target, input)

  // Re-read and re-applied HERE, under the lock, against the world as it is now. This is the race the
  // unit turns on: the candidate list a page was rendered from is a memo, and the therapist on it may
  // have taken another booking, had leave approved or had a licence lapse since.
  const recheck = await candidatesFor(uow.sql, { target, input, rule: deps.candidates })
  if (!recheck.candidates.includes(input.toTherapistId)) {
    const rejected = recheck.rejected.find((entry) => entry.therapistId === input.toTherapistId)
    throw refusal(
      'conflict',
      'therapist_not_eligible',
      `that therapist may not take this appointment${rejected === undefined ? '' : ` (${rejected.reason})`}. ` +
        'The availability answer is re-applied inside this transaction rather than trusted from the ' +
        'page that offered them, because a page is a memo: between the two, a licence lapses, leave is ' +
        'approved and another booking is taken.',
      {
        appointmentId: input.appointmentId,
        therapistId: input.toTherapistId,
        // Absent rather than null when the rule reported nothing about them: a therapist a composed
        // exclusion removed has no rejection by design (C-CRM-01), and inventing one here would be the
        // disclosure that exclusion is shaped to avoid.
        ...(rejected === undefined ? {} : { rejection: rejected.reason }),
      },
    )
  }

  const highWater = await historyHighWater(uow, input.appointmentId)
  await announceActor(uow, input.actor, input.reason)

  // The ONE column a reassignment writes. Not the status, not the room, not the period, not the price:
  // the second acceptance line is asserted by column equality before and after, and this statement is
  // what makes it true rather than a promise.
  await uow.sql`
    update appointment
       set therapist_id = ${input.toTherapistId}::uuid
     where id = ${input.appointmentId}
  `

  const appended = await uow.sql<ReassignmentHistoryRow[]>`
    select id::text as id, from_status::text as from_status, to_status::text as to_status,
           from_therapist_id::text as from_therapist_id, to_therapist_id::text as to_therapist_id,
           actor_kind, actor_id::text as actor_id, actor_role, reason, occurred_at
      from appointment_status_history
     where appointment_id = ${input.appointmentId}
       and appointment_status_history.id > ${highWater}::bigint
     order by appointment_status_history.id
  `
  const row = assertReassignmentRecorded(appended, {
    fromTherapistId: target.therapistId,
    toTherapistId: input.toTherapistId,
    status: target.status,
    actor: input.actor,
    reason: input.reason,
  })

  // The queue entry leaves the queue BY THIS REASSIGNMENT, and the row says so (0065). `reassigned`
  // names the successor as well, because after a second reassignment the join to `appointment` no
  // longer answers who took it the first time.
  const [cleared] = await uow.sql<{ id: string }[]>`
    update appointment_reassignment_flag
       set cleared_at = now(), cleared_on = ${input.decidedOn}::date,
           cleared_reason = 'reassigned',
           reassigned_to_therapist_id = ${input.toTherapistId}::uuid
     where appointment_id = ${input.appointmentId}::uuid
       and cleared_at is null
    returning id
  `

  const template = await resolveNotice(uow, {
    templateKey: input.noticeTemplateKey,
    locale: target.customerLocale,
    judge: deps.notice,
  })

  await uow.audit.record({
    action: REASSIGNED_EVENT,
    entityType: 'appointment',
    entityId: input.appointmentId,
    operation: 'update',
    // The before/after pair is the claim of the whole unit: one column moved, and the status did not.
    before: { therapist_id: target.therapistId, status: target.status },
    after: {
      therapist_id: input.toTherapistId,
      status: target.status,
      reason: input.reason,
      actor_role: input.actor.role,
      history_id: row.id,
      booking_id: target.bookingId,
      flag_id: cleared?.id ?? null,
      notice_template_id: template.templateId,
    },
  })

  // Keyed on the history row, which is the business fact: a reassignment BACK to the original therapist
  // next week is a different history row and a different event, and a transaction that rolled back never
  // wrote one at all, so a retry cannot collide with itself.
  const eventId = await uow.publish({
    eventType: REASSIGNED_EVENT,
    aggregateType: 'appointment',
    aggregateId: input.appointmentId,
    idempotencyKey: `${REASSIGNED_EVENT}:${row.id}`,
    payload: {
      appointmentId: input.appointmentId,
      bookingId: target.bookingId,
      tradingDate: target.tradingDate,
      fromTherapistId: target.therapistId,
      toTherapistId: input.toTherapistId,
      reason: input.reason,
      actorKind: input.actor.kind,
      actorRole: input.actor.role,
      actorId: input.actor.id ?? null,
      historyId: row.id,
      clearedFlagId: cleared?.id ?? null,
      // The status, carried deliberately: a consumer must be able to see that it did not move.
      status: target.status,
    },
  })
  if (eventId === null) {
    throw refusal(
      'invariant_violated',
      'event_not_enqueued',
      `the outbox already holds ${REASSIGNED_EVENT}:${row.id}, so this reassignment would commit with ` +
        'nothing announced. The key is the history row and history is append-only, so a duplicate ' +
        'means the chain has been written outside this API.',
    )
  }

  // A SECOND event, for the customer notice, because they are two facts with two audiences: the first
  // says the rota changed and the second is a message somebody has to send. Splitting them is what lets
  // the notice be retried, or its template version be named, without re-announcing the reassignment.
  // The BODY is deliberately absent: B-MSG-03's argument is that a body stored now is a body about a
  // period the appointment may no longer hold, so the send resolves it from the row at send time.
  const noticeEventId = await uow.publish({
    eventType: REASSIGNMENT_NOTICE_EVENT,
    aggregateType: 'appointment',
    aggregateId: input.appointmentId,
    idempotencyKey: `${REASSIGNMENT_NOTICE_EVENT}:${row.id}`,
    payload: {
      appointmentId: input.appointmentId,
      bookingId: target.bookingId,
      customerId: target.customerId,
      templateId: template.templateId,
      templateKey: template.templateKey,
      // The class the notice was JUDGED under, carried so a consumer sends under the same one rather
      // than restating it — the hole C-AUTO-01 closed in `send-scheduled-step.ts`.
      messageClass: template.messageClass,
      locale: template.locale,
      startsAt: new Date(target.treatment.startsAt).toISOString(),
      tradingDate: target.tradingDate,
    },
  })
  if (noticeEventId === null) {
    throw refusal(
      'invariant_violated',
      'event_not_enqueued',
      `the outbox already holds ${REASSIGNMENT_NOTICE_EVENT}:${row.id}, so this reassignment would ` +
        'commit and the customer would never be told.',
    )
  }

  // Forces the two DEFERRED triggers — `appointment_room_capacity` and
  // `appointment_delivery_is_coherent` — to fire here rather than at COMMIT, so a refusal arrives where
  // the context is and can be named. A reassignment changes no room and no period, so both must PASS:
  // that is the seventh acceptance line's claim about a Four Hands, checked by the database rather than
  // asserted by this comment.
  await uow.sql`set constraints all immediate`

  return {
    appointmentId: input.appointmentId,
    bookingId: target.bookingId,
    fromTherapistId: target.therapistId,
    toTherapistId: input.toTherapistId,
    reason: input.reason,
    history: {
      id: row.id,
      fromTherapistId: row.from_therapist_id,
      toTherapistId: row.to_therapist_id,
      status: row.to_status,
      occurredAt: row.occurred_at,
    },
    clearedFlagId: cleared?.id ?? null,
    notice: {
      templateId: template.templateId,
      templateKey: template.templateKey,
      messageClass: template.messageClass,
      locale: template.locale,
      eventId: noticeEventId,
    },
    eventId,
  }
}

/**
 * Reassigns one appointment in a transaction of its own, translating the constraint that decides the
 * race.
 *
 * The 23P01 translation is here rather than only in a caller because the exclusion constraint is
 * IMMEDIATE: the loser of two staff members reassigning to one therapist meets it at the `update`, and
 * that error has already aborted the transaction it arrived in. Nothing can be read afterwards, so the
 * refusal is built from the error alone — which is what makes it a named conflict instead of a 500.
 */
export async function reassignAppointmentTx(
  sql: Sql,
  input: ReassignInput,
  deps: ReassignmentDeps,
  context: RequestContext = {},
): Promise<ReassignmentResult> {
  const actor: Actor = {
    kind: input.actor.kind,
    ...(input.actor.id === undefined ? {} : { id: input.actor.id }),
    ...(input.actor.label === undefined ? {} : { label: input.actor.label }),
  }
  try {
    return await withUnitOfWork(sql, actor, (uow) => reassignAppointment(uow, input, deps), context)
  } catch (err) {
    throw reassignmentError(err) ?? err
  }
}

export interface ResolveFlagInput {
  readonly appointmentId: string
  /** Why this appointment needs no reassignment. Mandatory: 0065 refuses a hand resolution without one. */
  readonly note: string
  readonly actor: ReassignmentActor
  /** The TRADING date the decision was taken on. See {@link ReassignInput.decidedOn}. */
  readonly decidedOn: string
}

export interface ResolvedFlag {
  readonly flagId: string
  readonly appointmentId: string
  readonly therapistId: string
  readonly note: string
  readonly eventId: string
}

/**
 * The other way out of the queue: a human decides this appointment needs no reassignment, and says why.
 *
 * The sixth acceptance line is that a flagged appointment cannot leave the queue except by a
 * reassignment or an **audited explicit resolution**, and this is that second exit. Three things make it
 * audited rather than merely possible: 0065 refuses `cleared_at` without a `cleared_reason`, refuses
 * `resolved_by_hand` without a note, and this function writes the `audit_event` and the outbox row in
 * the same transaction as the clearance. There is no third path — `delete` is revoked on the table, the
 * flag is never removed, and the sweep's own clearance names `credential_restored`.
 *
 * It does NOT touch the appointment. The therapist keeps it; what has been withdrawn is the claim that
 * somebody else must take it. That is why this is not a reassignment with the therapist left out: the
 * two exits differ in what they assert, and a resolution that quietly unassigned would be the
 * cancellation 0058 exists to avoid.
 */
export async function resolveReassignmentFlag(
  sql: Sql,
  input: ResolveFlagInput,
  context: RequestContext = {},
): Promise<ResolvedFlag> {
  const note = input.note.trim()
  if (note === '') {
    throw refusal(
      'validation',
      'nothing_to_resolve',
      'closing a queue entry by hand records why. The other two exits have an external fact behind ' +
        'them — a renewal, or another therapist — and this one has only what somebody wrote down, so ' +
        '0065 refuses the row without it.',
      { appointmentId: input.appointmentId },
    )
  }
  const actor: Actor = {
    kind: input.actor.kind,
    ...(input.actor.id === undefined ? {} : { id: input.actor.id }),
    ...(input.actor.label === undefined ? {} : { label: input.actor.label }),
  }
  return await withUnitOfWork(
    sql,
    actor,
    async (uow) => {
      const [cleared] = await uow.sql<{ id: string; therapist_id: string }[]>`
        update appointment_reassignment_flag
           set cleared_at = now(), cleared_on = ${input.decidedOn}::date,
               cleared_reason = 'resolved_by_hand', resolution_note = ${note}
         where appointment_id = ${input.appointmentId}::uuid
           and cleared_at is null
        returning id, therapist_id::text as therapist_id
      `
      if (cleared === undefined) {
        throw refusal(
          'not_found',
          'nothing_to_resolve',
          `appointment ${input.appointmentId} has no live reassignment flag. Answering yes would ` +
            'record a decision about a queue entry that is not there.',
          { appointmentId: input.appointmentId },
        )
      }
      await uow.audit.record({
        action: REASSIGNMENT_RESOLVED_EVENT,
        entityType: 'appointment',
        entityId: input.appointmentId,
        operation: 'update',
        after: {
          flag_id: cleared.id,
          cleared_reason: 'resolved_by_hand',
          resolution_note: note,
          actor_role: input.actor.role,
          cleared_on: input.decidedOn,
        },
      })
      const eventId = await uow.publish({
        eventType: REASSIGNMENT_RESOLVED_EVENT,
        aggregateType: 'appointment',
        aggregateId: input.appointmentId,
        // Keyed on the FLAG and not on the appointment: a later lapse raises a second flag (0058's
        // partial unique index is what allows that), and closing that one by hand is a second decision.
        idempotencyKey: `${REASSIGNMENT_RESOLVED_EVENT}:${cleared.id}`,
        payload: {
          appointmentId: input.appointmentId,
          flagId: cleared.id,
          therapistId: cleared.therapist_id,
          note,
          actorKind: input.actor.kind,
          actorRole: input.actor.role,
          actorId: input.actor.id ?? null,
          clearedOn: input.decidedOn,
        },
      })
      if (eventId === null) {
        throw refusal(
          'invariant_violated',
          'event_not_enqueued',
          `the outbox already holds ${REASSIGNMENT_RESOLVED_EVENT}:${cleared.id}, so this resolution ` +
            'would commit unannounced. The key is the flag and a flag is cleared once.',
        )
      }
      return {
        flagId: cleared.id,
        appointmentId: input.appointmentId,
        therapistId: cleared.therapist_id,
        note,
        eventId,
      }
    },
    context,
  )
}

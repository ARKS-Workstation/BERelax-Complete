import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

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
 */
export async function clearReassignmentFlags(
  sql: Sql,
  args: { readonly appointmentIds: readonly string[]; readonly clearedOn: string },
): Promise<readonly ClearedReassignmentFlag[]> {
  if (args.appointmentIds.length === 0) return []
  return sql<ClearedReassignmentFlag[]>`
    update appointment_reassignment_flag
       set cleared_at = now(), cleared_on = ${args.clearedOn}::date
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

import { AppError, type TherapistSkill } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The therapist availability read model (B-AVAIL-04): who may take an appointment on a trading date,
 * and when they are present.
 *
 * This is the database half of the `TherapistEligibilityProvider` port in
 * `packages/core/src/availability/eligibility-port.ts`. `packages/db` must never import
 * `packages/core` — the dependency runs the other way — so the answer shape is declared here and
 * **asserted structurally assignable to the port** by `packages/fixtures/src/therapist-eligibility.
 * itest.ts`, which is the only package that may import both. That is the same arrangement B-CAT-05
 * made for `CompliancePolicyRow` and the compliance lexicon, and for the same reason: the field copy
 * is one line in a test, and a shared type would be an import the boundary forbids.
 *
 * ## Six reasons, one order, two implementations
 *
 * `ELIGIBILITY_EXCLUSION_REASONS` in core is the order these checks are applied in, and the `case`
 * expression below mirrors it exactly. A therapist who is both unemployed and unrostered must be
 * reported identically by both implementations, or the agreement test in `packages/fixtures` is
 * comparing two different questions rather than two answers to one.
 *
 * {@link EXCLUSION_REASONS} is the list as this side spells it, and {@link exclusionReasonFrom}
 * refuses anything else rather than letting it through as `undefined`. A seventh reason added to the
 * SQL and not to this list is a therapist excluded for a reason the caller cannot name — and the
 * failure mode of the permissive version is an exclusion that reads as eligibility.
 *
 * ## Why the rules are in SQL rather than in a loop over rows
 *
 * Three of the six are set operations over rows this layer is already joining (skills, credentials,
 * roster), and the fourth — subtracting approved leave from the roster — is range arithmetic Postgres
 * does natively with `range_agg` and multirange difference. Fetching every employee's every document
 * and doing it in TypeScript would move a `where` clause into a `filter` and make the read cost grow
 * with the size of the staff file rather than with the size of the answer.
 *
 * ## The trading date is the unit of comparison, and it is not a calendar date
 *
 * Trading runs 11:00–02:00 (0011), so an appointment at 01:30 belongs to the **previous** trading
 * date. Employment and credential expiry are therefore compared to `trading_date` and never to
 * `lower(period)::date`: a licence valid through the 18th covers the 18th's 01:30 appointment, whose
 * calendar date is the 19th, and the calendar comparison silently takes the last two hours of every
 * trading day away from a therapist who is licensed for all of them.
 *
 * ## It must not offer what the database would refuse
 *
 * {@link readCommittedAppointments} is part of the read model rather than a convenience. The
 * exclusion constraint `appointment_therapist_no_overlap` (0024) refuses a second overlapping
 * appointment for one therapist with SQLSTATE 23P01, so a pool handed to the solver without the
 * appointments those therapists already hold produces a slot the booking transaction cannot commit —
 * after the customer has been told yes. It returns **one record per appointment row**, which is the
 * unit 0024 counts room capacity in; see that function for why merging a two-therapist delivery into
 * one record over-reports the room's free places.
 */

/** The reasons this reader can report. Mirrors `EligibilityExclusionReason` in `@berelax/core`. */
export const EXCLUSION_REASONS = [
  'not_employed',
  'missing_skill',
  'credential_missing',
  'credential_expired',
  'not_rostered',
  'on_approved_leave',
] as const
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

/**
 * The reason a row carries, or a refusal.
 *
 * Throws rather than returning `undefined`, because the permissive version of this function turns a
 * reason the TypeScript side has not learned about into a therapist with no reason attached — and a
 * therapist with no reason attached is indistinguishable from an eligible one at the call site. The
 * `case` in the query is the only writer, so a value arriving here that is not in the list means the
 * SQL and this list have drifted, which is a deploy-time defect and should read as one.
 */
export function exclusionReasonFrom(value: string): ExclusionReason {
  const known = (EXCLUSION_REASONS as readonly string[]).includes(value)
  if (!known) {
    throw new AppError(
      'invariant_violated',
      `"${value}" is not a therapist exclusion reason. The \`case\` in readEligibleTherapists and ` +
        `EXCLUSION_REASONS have drifted; known reasons are ${EXCLUSION_REASONS.join(', ')}.`,
      { details: { value, known: [...EXCLUSION_REASONS] } },
    )
  }
  return value as ExclusionReason
}

/** The query. One trading date, one required skill, and optionally a narrowed candidate list. */
export interface EligibilityQueryInput {
  /** A trading date as `YYYY-MM-DD`. Never a calendar date; see the header. */
  readonly tradingDate: string
  /**
   * `service_skill.required_skill` for the treatment's style — a skill, never a style (ADR 0021).
   *
   * Typed from `@berelax/shared` rather than as a bare `string`. `packages/db` may import shared and
   * so may `packages/core`, which makes it the one place a closed vocabulary can be spelled once
   * across a boundary that forbids the two from importing each other — and it is what lets the port
   * conformance in `packages/fixtures` be a `satisfies` rather than a cast.
   */
  readonly requiredSkill: TherapistSkill
  /**
   * Narrows the candidates. Absent means every employee.
   *
   * Production behaviour — a customer asking for the therapist they saw last time — and also the only
   * safe isolation for a test: the integration suite runs sequentially against one database and
   * earlier files leave employees behind, so a test narrows what this query can SEE rather than
   * deleting rows that `shift_assignment.employee_id` protects with ON DELETE RESTRICT.
   */
  readonly employeeIds?: readonly string[]
}

export interface EligibleTherapistRow {
  readonly therapistId: string
  readonly skills: readonly TherapistSkill[]
  /** Omitted when `employee.gender` is null: nobody has told the build (Y8-staff). */
  readonly gender?: 'female' | 'male'
}

export interface ExcludedTherapistRow {
  readonly therapistId: string
  readonly reason: ExclusionReason
}

export interface TherapistShiftRow {
  readonly therapistId: string
  readonly period: { readonly startsAt: number; readonly endsAt: number }
}

/** The pool. Field for field the shape of `TherapistPool` in `@berelax/core`. */
export interface TherapistPoolRead {
  readonly therapists: readonly EligibleTherapistRow[]
  /** Presence net of approved leave, ascending by therapist id then by start. */
  readonly shifts: readonly TherapistShiftRow[]
  readonly excluded: readonly ExcludedTherapistRow[]
}

/** An appointment that already holds its therapist and room. Shape of `ScheduledAppointment`. */
export interface ScheduledAppointmentRow {
  readonly id: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
}

interface PoolQueryRow {
  employee_id: string
  gender: 'female' | 'male' | null
  /**
   * `employee_skill.skill` is the `therapist_skill` enum of 0017, and `catalogue.itest.ts` asserts that
   * enum has exactly the two labels `THERAPIST_SKILLS` spells. So the driver's `text[]` is that union,
   * and the assertion below is narrowing a value the database has already constrained rather than
   * trusting a string.
   */
  skills: TherapistSkill[]
  reason: string | null
}

interface PresenceQueryRow {
  employee_id: string
  starts_at: Date
  ends_at: Date
}

/**
 * The mandatory document types from the profile in force.
 *
 * Reads `regulatory_profile_current` — the view, never the table (0004) — and **throws** when there is
 * no profile. There is always one: 0004 seeds the stricter default precisely so the system is never
 * without it, so an empty result means the migration did not run or somebody stamped `superseded_at`
 * on every row. Defaulting to an empty list here would be a credential gate that silently permits
 * every therapist, which is the one outcome worse than no gate: it looks like a gate.
 */
export async function readMandatoryDocumentTypes(sql: Sql): Promise<readonly string[]> {
  const [row] = await sql<{ mandatory_therapist_document_types: string[] }[]>`
    select mandatory_therapist_document_types from regulatory_profile_current
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'No regulatory profile is in force, so which therapist credentials are mandatory is unknown. ' +
        '0004 seeds one; an empty result means the profile was superseded without a replacement.',
    )
  }
  return row.mandatory_therapist_document_types
}

/**
 * The pool for one trading date.
 *
 * Two statements, and they are separate for a reason that is visible in the second: the presence
 * query subtracts approved leave from the roster with multirange difference and then `unnest`es the
 * result, so it returns *n rows per therapist*. Folding it into the first query would multiply every
 * therapist's row by the number of fragments their day is broken into, and the skills array would be
 * duplicated along with it.
 */
export async function readEligibleTherapists(
  sql: Sql,
  query: EligibilityQueryInput,
): Promise<TherapistPoolRead> {
  const { tradingDate, requiredSkill, employeeIds } = query
  // `null` rather than an empty array for "every employee": `= any(array[]::uuid[])` is false for
  // every row, so an empty array would silently mean "nobody" where the caller meant "everybody".
  const narrowed = employeeIds === undefined ? null : [...employeeIds]

  const rows = await sql<PoolQueryRow[]>`
    with profile as (
      select mandatory_therapist_document_types as mandatory from regulatory_profile_current
    ),
    candidate as (
      select e.id, e.gender, e.employed_from, e.employed_until
        from employee e
       where ${narrowed} :: uuid[] is null or e.id = any(${narrowed} :: uuid[])
    ),
    skill as (
      select es.employee_id, array_agg(es.skill::text order by es.skill::text) as skills
        from employee_skill es
        join candidate c on c.id = es.employee_id
       group by es.employee_id
    ),
    -- The LATEST expiry per (employee, type). A renewal is a new row rather than an edit
    -- (employee_document_one_row_per_expiry), so max() is what says "currently held": taking any
    -- other row reports a therapist as expired on the strength of a licence already replaced.
    latest_document as (
      select ed.employee_id, ed.document_type, max(ed.expires_on) as expires_on
        from employee_document ed
        join candidate c on c.id = ed.employee_id
       group by ed.employee_id, ed.document_type
    ),
    -- One row per candidate, whatever the mandatory list holds. The LEFT JOIN LATERAL over an EMPTY
    -- list yields a single row whose document_type is null, which is why both aggregates test
    -- m.document_type first: without that, an empty mandatory list - a legitimate value meaning "no
    -- credential gate" - would read as "every mandatory type is missing" and exclude everybody.
    credential as (
      select c.id as employee_id,
             bool_or(m.document_type is not null and ld.employee_id is null) as any_missing,
             bool_or(ld.expires_on is not null and ld.expires_on < ${tradingDate}::date)
               as any_expired
        from candidate c
        cross join profile p
        left join lateral unnest(p.mandatory) as m(document_type) on true
        left join latest_document ld
          on ld.employee_id = c.id and ld.document_type = m.document_type
       group by c.id
    ),
    roster as (
      select sa.employee_id, range_agg(s.period) as rostered
        from shift_assignment sa
        join shift s on s.id = sa.shift_id
        join candidate c on c.id = sa.employee_id
       where s.trading_date = ${tradingDate}::date
       group by sa.employee_id
    ),
    -- Narrowed to leave that overlaps the trading day's own span, so the subtraction below reads only
    -- the rows that can change the answer. The view, never leave_request: a PENDING request must not
    -- make a therapist unbookable.
    day_span as (
      select tstzrange(opens_at, closes_at, '[)') as span
        from business_day where trading_date = ${tradingDate}::date
    ),
    taken as (
      select al.employee_id, range_agg(al.period) as leave
        from employee_approved_leave al
        join candidate c on c.id = al.employee_id
        join day_span d on al.period && d.span
       group by al.employee_id
    ),
    presence as (
      select r.employee_id,
             case when t.leave is null then r.rostered else r.rostered - t.leave end as net
        from roster r
        left join taken t on t.employee_id = r.employee_id
    )
    select c.id as employee_id,
           c.gender::text as gender,
           coalesce(sk.skills, array[]::text[]) as skills,
           -- The order is ELIGIBILITY_EXCLUSION_REASONS in @berelax/core, and it has to be: a
           -- therapist failing two checks must be reported the same way by both implementations.
           case
             when c.employed_from > ${tradingDate}::date
               or (c.employed_until is not null and c.employed_until < ${tradingDate}::date)
               then 'not_employed'
             when not (coalesce(sk.skills, array[]::text[]) @> array[${requiredSkill}::text])
               then 'missing_skill'
             when cr.any_missing then 'credential_missing'
             when cr.any_expired then 'credential_expired'
             when p.employee_id is null then 'not_rostered'
             when isempty(p.net) then 'on_approved_leave'
           end as reason
      from candidate c
      left join skill sk on sk.employee_id = c.id
      left join credential cr on cr.employee_id = c.id
      left join presence p on p.employee_id = c.id
     order by c.id
  `

  const presenceRows = await sql<PresenceQueryRow[]>`
    with candidate as (
      select e.id from employee e
       where ${narrowed} :: uuid[] is null or e.id = any(${narrowed} :: uuid[])
    ),
    roster as (
      select sa.employee_id, range_agg(s.period) as rostered
        from shift_assignment sa
        join shift s on s.id = sa.shift_id
        join candidate c on c.id = sa.employee_id
       where s.trading_date = ${tradingDate}::date
       group by sa.employee_id
    ),
    day_span as (
      select tstzrange(opens_at, closes_at, '[)') as span
        from business_day where trading_date = ${tradingDate}::date
    ),
    taken as (
      select al.employee_id, range_agg(al.period) as leave
        from employee_approved_leave al
        join candidate c on c.id = al.employee_id
        join day_span d on al.period && d.span
       group by al.employee_id
    )
    select r.employee_id,
           lower(fragment) as starts_at,
           upper(fragment) as ends_at
      from roster r
      left join taken t on t.employee_id = r.employee_id
      cross join lateral unnest(
        case when t.leave is null then r.rostered else r.rostered - t.leave end
      ) as fragment
     order by r.employee_id, lower(fragment)
  `

  const therapists: EligibleTherapistRow[] = []
  const excluded: ExcludedTherapistRow[] = []
  for (const row of rows) {
    if (row.reason !== null) {
      excluded.push({ therapistId: row.employee_id, reason: exclusionReasonFrom(row.reason) })
      continue
    }
    therapists.push({
      therapistId: row.employee_id,
      skills: row.skills,
      // Spread rather than `gender: row.gender ?? undefined`, because the port's `gender` is an
      // optional property under `exactOptionalPropertyTypes`: present-and-undefined and absent are
      // different types there, and only absence means "nobody has told the build".
      ...(row.gender === null ? {} : { gender: row.gender }),
    })
  }

  const eligibleIds = new Set(therapists.map((therapist) => therapist.therapistId))
  const shifts = presenceRows
    // Presence is returned only for therapists in the pool. An excluded therapist's roster is not
    // availability, and handing it to the solver alongside an id it was never given would make the
    // two inputs disagree about who the query was about.
    .filter((row) => eligibleIds.has(row.employee_id))
    .map((row) => ({
      therapistId: row.employee_id,
      period: { startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() },
    }))

  return { therapists, shifts, excluded }
}

/**
 * The appointments on a trading date that still hold a therapist and a room.
 *
 * **One record per appointment ROW, not per delivery.** 0024 stores one row per therapist and its
 * capacity trigger counts ROWS (`room_peak_concurrency`), so the two rows of a Four Hands are two
 * places in the room. `roomPlacesTaken` in `assign-shape.ts` counts `ScheduledAppointment` records,
 * which means the record has to be the row for the two to agree: merging a Four Hands into one record
 * with two `therapistIds` — the reading its doc comment suggests — under-counts that room's committed
 * places by one, and a capacity-2 room already holding a Four Hands is then offered a third place that
 * the trigger refuses at COMMIT. Per-row is also exactly right for the therapist side: each row blocks
 * its own therapist over the same period, which is what `therapistsFreeFor` asks.
 *
 * Selected on `holds_resources` (0024), the generated column the exclusion constraint and the capacity
 * trigger both read, so "still holds" has one definition and a cancelled appointment releases its
 * therapist here as well as there.
 *
 * Deliberately **not** narrowable by therapist, unlike the pool query. A room can be occupied by a
 * therapist outside the pool entirely — that is the case B-AVAIL-03's Morocco Bath assertion is built
 * on, "the wet room is occupied by an appointment held by a therapist outside every pool" — so
 * filtering these rows by candidate id would hide room occupancy and offer a room that is taken. The
 * trading date is the axis that narrows this safely.
 *
 * Turnaround and buffer are the figures in force, read from the catalogue, and that is a limitation
 * rather than a choice: `appointment` snapshots neither column, so a Morocco Bath booked before the
 * owner shortened the standard turnaround is re-derived at today's figure. `solve.ts` says these
 * should be the appointment's own ("both figures are snapshotted onto the appointment when it is
 * booked"), and they are not there to read — fixing it means adding both columns, which belongs with
 * the booking transaction that would write them (B-AVAIL-06).
 */
export async function readCommittedAppointments(
  sql: Sql,
  args: { readonly tradingDate: string },
): Promise<readonly ScheduledAppointmentRow[]> {
  const rows = await sql<
    {
      id: string
      room_id: string
      therapist_id: string
      starts_at: Date
      ends_at: Date
      turnaround_minutes: number
      therapist_buffer_minutes: number
    }[]
  >`
    select a.id::text as id,
           a.room_id,
           a.therapist_id::text as therapist_id,
           lower(a.period) as starts_at,
           upper(a.period) as ends_at,
           s.turnaround_minutes,
           coalesce(srs.therapist_buffer_minutes, 0) as therapist_buffer_minutes
      from appointment a
      join service_variant v on v.id = a.service_variant_id
      join service s on s.id = v.service_id
      left join service_resource_shape srs
        on srs.service_style = s.style
       and srs.service_treatment_key = s.treatment_key
       and srs.shape = a.shape
     where a.trading_date = ${args.tradingDate}::date
       and a.holds_resources
     order by lower(a.period), a.room_id, a.therapist_id
  `
  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    therapistIds: [row.therapist_id],
    treatment: { startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() },
    turnaroundMinutes: Number(row.turnaround_minutes),
    therapistBufferMinutes: Number(row.therapist_buffer_minutes),
  }))
}

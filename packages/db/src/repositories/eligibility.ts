import {
  AppError,
  type GenderMatchingMode,
  genderMatchingMode,
  type TherapistSkill,
} from '@berelax/shared'
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
 * ## Seven reasons, one order, two implementations
 *
 * `ELIGIBILITY_EXCLUSION_REASONS` in core is the order these checks are applied in, and the `case`
 * expression below mirrors it exactly. A therapist who is both unemployed and unrostered must be
 * reported identically by both implementations, or the agreement test in `packages/fixtures` is
 * comparing two different questions rather than two answers to one.
 *
 * {@link EXCLUSION_REASONS} is the list as this side spells it, and {@link exclusionReasonFrom}
 * refuses anything else rather than letting it through as `undefined`. An eighth reason added to the
 * SQL and not to this list is a therapist excluded for a reason the caller cannot name — and the
 * failure mode of the permissive version is an exclusion that reads as eligibility.
 * `packages/fixtures/src/therapist-eligibility.itest.ts` pins the two lists to each other in both
 * directions, at runtime for the order and at compile time for the membership, so a reason that exists
 * on one side only fails `pnpm typecheck` rather than a booking.
 *
 * ## Same-gender matching is the seventh, and it is the last arm of the `case`
 *
 * B-AVAIL-05, and a hard constraint rather than a preference (ADR 0020, docs/04 §3, `Y9-gender` still
 * open). It is applied last for the two reasons `ELIGIBILITY_EXCLUSION_REASONS` records: it is only the
 * useful answer when everything else passed, and reporting it for a therapist who is excluded anyway
 * would name a person's recorded gender to a caller with no use for it. `clientGender` absent means the
 * query is not about a client at all — the admin calendar asks who is working on Thursday — and a
 * BOOKING request with no client gender is refused one layer up, in
 * `solveGenderMatchedAvailability`, with `requires_client_gender`. The mode goes through
 * `genderMatchingMode`, so an absent or unreadable setting is strict here exactly as it is in core.
 *
 * ## Why the rules are in SQL rather than in a loop over rows
 *
 * Three of the seven are set operations over rows this layer is already joining (skills, credentials,
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
 * after the customer has been told yes. It returns **one record per appointment row**, each carrying the
 * delivery it belongs to: rows are what block therapists, deliveries are what fill a room (0038).
 */

/**
 * The reasons this reader can report, in the order the `case` applies them.
 *
 * Mirrors `EligibilityExclusionReason` and `ELIGIBILITY_EXCLUSION_REASONS` in `@berelax/core`, which
 * this package may not import. `gender_mismatch` is last and only last; see the header.
 */
export const EXCLUSION_REASONS = [
  'not_employed',
  'missing_skill',
  'credential_missing',
  'credential_expired',
  'not_rostered',
  'on_approved_leave',
  'gender_mismatch',
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
  /**
   * The **client's** gender, when it is known. A different question from the therapist's.
   *
   * The therapist's is `employee.gender`; this is a fact about the person asking for the appointment,
   * which no table holds — `customer` has no gender column and B-AVAIL-05 added none. Absent means the
   * query is not about a client (the admin calendar, the reminder scheduler), so no gender narrowing is
   * applied; it does NOT mean "any therapist will do" for a booking, which
   * `solveGenderMatchedAvailability` refuses with `requires_client_gender`.
   */
  readonly clientGender?: 'female' | 'male'
  /**
   * `booking.same_gender_matching`, from {@link readGenderMatching}. **Absent is strict.**
   *
   * Optional deliberately: a call site that has never heard of this field must not be able to relax a
   * compliance constraint by omission. The value is normalised with `genderMatchingMode`, the same
   * function the settings reader and `@berelax/core` use, so an unreadable or stale value means strict
   * in all three places rather than in two of them.
   */
  readonly genderMatching?: GenderMatchingMode
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
  /**
   * `appointment.delivery_id` and `appointment.room_places` (0038).
   *
   * Always present from this reader, because the columns are NOT NULL: the rows of one delivery share
   * the id, so two therapists over one client count as **one** place in the room. Optional on the core
   * side, where absence means one delivery per record — the stricter reading.
   */
  readonly delivery: { readonly id: string; readonly places: number }
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
  // `null` rather than `undefined`, because postgres.js sends `undefined` as an error rather than as
  // SQL NULL, and NULL is what the `case` arm below tests for "this query is not about a client".
  const clientGender = query.clientGender ?? null
  // Normalised here rather than passed through, so the SQL cannot be handed a mode this build does not
  // know how to be strict about. `genderMatchingMode` is the same function core applies.
  const strictGender = genderMatchingMode(query.genderMatching) === 'strict'

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
             -- Same-gender matching (B-AVAIL-05), LAST. "is distinct from" and not "<>": a therapist
             -- whose gender nobody has recorded (Y8-staff leaves employee.gender nullable) is a
             -- MISMATCH and not a wildcard, and "<>" against NULL is NULL, which a case treats as
             -- false - the permissive answer, reached by writing the obvious operator.
             when ${strictGender}::boolean
                  and ${clientGender}::employee_gender is not null
                  and c.gender is distinct from ${clientGender}::employee_gender
               then 'gender_mismatch'
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
 * **One record per appointment ROW, with the delivery carried on each.** 0024 stores one row per
 * therapist, so per-row is what the therapist side needs: each row blocks its own therapist over the
 * same period, which is what `therapistsFreeFor` asks. The ROOM side is counted per delivery — 0038
 * gave the appointment a `delivery_id` and a `room_places` figure and re-issued `room_peak_concurrency`
 * to sum places over distinct deliveries — so the two rows of a Four Hands are two therapists and
 * **one** place in the room.
 *
 * That pairing is what settled a disagreement this function used to work around. The trigger counted
 * appointment ROWS against `rooms.capacity`, a column 0012 documents as CLIENTS, while
 * `roomPlacesTaken` in `assign-shape.ts` counted `ScheduledAppointment` records — so whether a room had
 * a free place depended on which unit you asked, and Four Hands (one client, two rows) was unbookable
 * in every capacity-1 standard room the salon owns. Carrying the delivery makes both readings agree:
 * merging the rows of a delivery into one record and returning them separately now give the same
 * number of places.
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
 * Turnaround and buffer are **the appointment's own**, read from the columns 0038 added, which is what
 * `solve.ts` always said they were ("both figures are snapshotted onto the appointment when it is
 * booked"). They used to be re-derived from `service` and `service_resource_shape` at today's figures
 * because the columns did not exist, and that is the retroactive occupancy change `solve.ts` warns
 * about: shortening the configured turnaround moved the busy interval of every appointment already
 * taken, and the first sign of it would have been a double booking. The catalogue is no longer joined
 * here at all.
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
      delivery_id: string
      room_places: number
      starts_at: Date
      ends_at: Date
      turnaround_minutes: number
      therapist_buffer_minutes: number
    }[]
  >`
    select a.id::text as id,
           a.room_id,
           a.therapist_id::text as therapist_id,
           a.delivery_id::text as delivery_id,
           a.room_places,
           lower(a.period) as starts_at,
           upper(a.period) as ends_at,
           a.turnaround_minutes,
           a.therapist_buffer_minutes
      from appointment a
     where a.trading_date = ${args.tradingDate}::date
       and a.holds_resources
     order by lower(a.period), a.room_id, a.therapist_id
  `
  return rows.map((row) => ({
    id: row.id,
    roomId: row.room_id,
    therapistIds: [row.therapist_id],
    delivery: { id: row.delivery_id, places: Number(row.room_places) },
    treatment: { startsAt: row.starts_at.getTime(), endsAt: row.ends_at.getTime() },
    turnaroundMinutes: Number(row.turnaround_minutes),
    therapistBufferMinutes: Number(row.therapist_buffer_minutes),
  }))
}

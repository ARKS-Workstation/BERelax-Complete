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
 * ## The seven are the port's; a composed exclusion is somebody else's
 *
 * {@link TherapistExclusion} is the seam for a unit that has to take a therapist out of availability
 * for a reason the port cannot compute — M-VAT-10's overdue blocking credential obligation, C-CRM-01's
 * do-not-pair flag. They arrive as a LIST of named predicates and are spliced into the `case` ahead of
 * the gender arm, so two of them apply at once and neither is an edit to this SQL. Two units inlining a
 * condition into one expression is the merge that silently keeps one of the two.
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
 * A nested postgres.js fragment: SQL text plus its own bound parameters, spliceable into a statement.
 *
 * Named rather than left inline because it is the mechanism that makes the availability read one round
 * trip, and a reader has to be able to find it.
 */
export type SqlFragment = ReturnType<Sql>

/**
 * One **composable exclusion**: a named reason, and a predicate over the candidate row.
 *
 * The mechanism exists because more than one unit needs to take a therapist out of availability for a
 * reason that is not one of the seven, and two units each inlining a condition into the `case` below is
 * the merge that silently drops one of them — both branches edit the same expression, one wins, and the
 * lost filter is invisible because the query still compiles and still returns therapists. M-VAT-10's
 * overdue blocking credential obligation and C-CRM-01's therapist/customer do-not-pair flag are the
 * first two. Each is a value, both can be in the list at once, and adding a third is an array entry
 * rather than an edit to this SQL.
 *
 * Why it is not an eighth `EligibilityExclusionReason`. Those seven are the **port's** vocabulary,
 * mirrored word for word in `@berelax/core` and pinned in both directions by
 * `packages/fixtures/src/therapist-eligibility.itest.ts`, and `resolveTherapistPool` computes every one
 * of them from facts the port declares. A composed exclusion is a fact from somewhere else entirely — a
 * compliance calendar, a CRM flag — so widening the port's union for it would make the pure rule
 * incapable of answering its own question. `readEligibleTherapists` is therefore the port and takes no
 * exclusions; the availability read composes them in and reports the reason as an open string, which is
 * what `AvailabilityFacts.excluded[].reason` has always been.
 *
 * `when` is a boolean SQL expression evaluated against **`c`**, the candidate row of `tp_candidate`
 * (`c.id` is the employee id). That coupling is the price of one round trip: a predicate that had to be
 * a joined CTE instead would need a unique name per contributor, and two contributors picking one name
 * is the collision this type exists to avoid.
 */
export interface TherapistExclusion {
  /** For the error message when two exclusions collide, and for the test that names one. */
  readonly name: string
  /**
   * The reason reported for an excluded therapist. NOT one of {@link EXCLUSION_REASONS}: a composed
   * reason is deliberately outside the port's closed union — see the type's header.
   */
  readonly reason: string
  /** A boolean expression over `c.id`, the candidate's employee id. */
  readonly when: SqlFragment
}

/**
 * {@link therapistPoolCtes}'s query, which differs from {@link EligibilityQueryInput} in two fields.
 *
 * `requiredSkill` may be a **SQL expression** as well as a value. B-AVAIL-07 resolves the skill from the
 * service variant inside the same statement — `(select required_skill from av_variant)` — because the
 * skill a treatment's style requires is not known until the variant has been read, and reading it first
 * would make the availability query two round trips instead of one. A value is still the ordinary case
 * and `readEligibleTherapists` passes one.
 *
 * `exclusions` are the composed predicates, applied in the order given and **before** the gender arm.
 * Deliberately absent from {@link EligibilityQueryInput}, so the port implementation cannot be handed a
 * reason its answer shape may not carry.
 */
export type TherapistPoolCtesQuery = Omit<EligibilityQueryInput, 'requiredSkill'> & {
  readonly requiredSkill: TherapistSkill | SqlFragment
  readonly exclusions?: readonly TherapistExclusion[]
}

/**
 * The composed exclusions as `case` arms, or an empty fragment when there are none.
 *
 * Two names that are the same are refused rather than deduplicated. Two contributors that both call
 * their exclusion `overdue` have not written one rule twice: they have written two, and the permissive
 * reading applies whichever the array happens to hold first — which is the silent loss this whole
 * mechanism exists to prevent, reintroduced by a copy-paste. The reason strings are refused as
 * duplicates for the same reason, and refused if one collides with the port's seven, because a composed
 * exclusion reporting `credential_expired` would send a caller to a renewal screen for a CRM flag.
 */
function composedExclusionArms(sql: Sql, exclusions: readonly TherapistExclusion[]): SqlFragment {
  const seen = new Set<string>()
  for (const exclusion of exclusions) {
    for (const [what, value] of [
      ['name', exclusion.name],
      ['reason', exclusion.reason],
    ] as const) {
      if (seen.has(`${what}:${value}`)) {
        throw new AppError(
          'invariant_violated',
          `Two composed therapist exclusions share the ${what} "${value}". Each is a separate rule and ` +
            'both must apply; one name for two rules is how a merge drops one of them.',
          { details: { what, value, names: exclusions.map((e) => e.name) } },
        )
      }
      seen.add(`${what}:${value}`)
    }
    if ((EXCLUSION_REASONS as readonly string[]).includes(exclusion.reason)) {
      throw new AppError(
        'invariant_violated',
        `Composed exclusion "${exclusion.name}" reports "${exclusion.reason}", which is one of the ` +
          'seven port reasons. A composed reason must be its own, or a caller is told to renew a ' +
          'credential that is not the problem.',
        { details: { name: exclusion.name, reason: exclusion.reason } },
      )
    }
  }
  // An empty template is a fragment that contributes nothing, so the `case` below has one shape whether
  // or not anything was composed in — a conditional `case` would be two statements for a plan test to
  // measure.
  let arms: SqlFragment = sql``
  for (const exclusion of exclusions) {
    arms = sql`${arms} when ${exclusion.when} then ${exclusion.reason}`
  }
  return arms
}

/**
 * The whole therapist read model as a **composable SQL fragment**: the CTEs, and nothing else.
 *
 * Exported and used by two callers, and the point is that there is only one of it. B-AVAIL-07's
 * availability query has to answer a `(business_day, service_variant, therapist?)` request in a SINGLE
 * round trip, so the pool cannot arrive from a second statement; and re-typing this SQL there would be a
 * second answer to "is this therapist bookable", which is exactly what B-AVAIL-04 was built to prevent.
 * postgres.js interpolates a nested `sql` fragment with its parameters intact, so the same text and the
 * same binds serve `readEligibleTherapists` below and the one-statement read in `queries/availability.ts`.
 *
 * Every CTE is prefixed `tp_` so a composing statement's own CTEs cannot collide with these. The two a
 * caller reads are the last two:
 *
 *   - `tp_pool(employee_id, gender, skills, reason)` — one row per candidate. `reason` null means
 *     eligible; anything else is an `EligibilityExclusionReason` or a composed exclusion's own reason
 *     ({@link TherapistExclusion}), which is why the availability read types it as a string.
 *   - `tp_presence(employee_id, starts_at, ends_at)` — presence net of approved leave, **n rows per
 *     therapist**, because the multirange difference is `unnest`ed. That is why this was two statements
 *     before and why a caller that wants both either runs two queries or aggregates each side to JSON:
 *     joining them multiplies every therapist's row by the number of fragments their day is broken into.
 */
export function therapistPoolCtes(sql: Sql, query: TherapistPoolCtesQuery) {
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
  const composedArms = composedExclusionArms(sql, query.exclusions ?? [])

  return sql`
    tp_profile as (
      select mandatory_therapist_document_types as mandatory from regulatory_profile_current
    ),
    tp_candidate as (
      select e.id, e.gender, e.employed_from, e.employed_until
        from employee e
       where ${narrowed} :: uuid[] is null or e.id = any(${narrowed} :: uuid[])
    ),
    tp_skill as (
      select es.employee_id, array_agg(es.skill::text order by es.skill::text) as skills
        from employee_skill es
        join tp_candidate c on c.id = es.employee_id
       group by es.employee_id
    ),
    -- The LATEST expiry per (employee, type). A renewal is a new row rather than an edit
    -- (employee_document_one_row_per_expiry), so max() is what says "currently held": taking any
    -- other row reports a therapist as expired on the strength of a licence already replaced.
    tp_latest_document as (
      select ed.employee_id, ed.document_type, max(ed.expires_on) as expires_on
        from employee_document ed
        join tp_candidate c on c.id = ed.employee_id
       group by ed.employee_id, ed.document_type
    ),
    -- One row per candidate, whatever the mandatory list holds. The LEFT JOIN LATERAL over an EMPTY
    -- list yields a single row whose document_type is null, which is why both aggregates test
    -- m.document_type first: without that, an empty mandatory list - a legitimate value meaning "no
    -- credential gate" - would read as "every mandatory type is missing" and exclude everybody.
    tp_credential as (
      select c.id as employee_id,
             bool_or(m.document_type is not null and ld.employee_id is null) as any_missing,
             bool_or(ld.expires_on is not null and ld.expires_on < ${tradingDate}::date)
               as any_expired
        from tp_candidate c
        cross join tp_profile p
        left join lateral unnest(p.mandatory) as m(document_type) on true
        left join tp_latest_document ld
          on ld.employee_id = c.id and ld.document_type = m.document_type
       group by c.id
    ),
    tp_roster as (
      select sa.employee_id, range_agg(s.period) as rostered
        from shift_assignment sa
        join shift s on s.id = sa.shift_id
        join tp_candidate c on c.id = sa.employee_id
       where s.trading_date = ${tradingDate}::date
       group by sa.employee_id
    ),
    -- Narrowed to leave that overlaps the trading day's own span, so the subtraction below reads only
    -- the rows that can change the answer. The view, never leave_request: a PENDING request must not
    -- make a therapist unbookable.
    tp_day_span as (
      select tstzrange(opens_at, closes_at, '[)') as span
        from business_day where trading_date = ${tradingDate}::date
    ),
    tp_taken as (
      select al.employee_id, range_agg(al.period) as leave
        from employee_approved_leave al
        join tp_candidate c on c.id = al.employee_id
        join tp_day_span d on al.period && d.span
       group by al.employee_id
    ),
    tp_net as (
      select r.employee_id,
             case when t.leave is null then r.rostered else r.rostered - t.leave end as net
        from tp_roster r
        left join tp_taken t on t.employee_id = r.employee_id
    ),
    tp_pool as (
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
               -- The COMPOSED exclusions ({@link TherapistExclusion}), in the order the caller listed
               -- them. Spliced here rather than appended after the gender arm, because gender is last
               -- for a reason that still holds: reporting a therapist's recorded gender to a caller that
               -- cannot book them anyway discloses it for nothing. An overdue blocking obligation is the
               -- more actionable answer and it is a fact about the therapist's file, so it belongs with
               -- the credential arms and ahead of the question about who is asking.
               ${composedArms}
               -- Same-gender matching (B-AVAIL-05), LAST. "is distinct from" and not "<>": a therapist
               -- whose gender nobody has recorded (Y8-staff leaves employee.gender nullable) is a
               -- MISMATCH and not a wildcard, and "<>" against NULL is NULL, which a case treats as
               -- false - the permissive answer, reached by writing the obvious operator.
               when ${strictGender}::boolean
                    and ${clientGender}::employee_gender is not null
                    and c.gender is distinct from ${clientGender}::employee_gender
                 then 'gender_mismatch'
             end as reason
        from tp_candidate c
        left join tp_skill sk on sk.employee_id = c.id
        left join tp_credential cr on cr.employee_id = c.id
        left join tp_net p on p.employee_id = c.id
    ),
    tp_presence as (
      select n.employee_id,
             lower(fragment) as starts_at,
             upper(fragment) as ends_at
        from tp_net n
        cross join lateral unnest(n.net) as fragment
    )
  `
}

/**
 * The pool for one trading date.
 *
 * Two statements, and they are separate for a reason that is visible in the second: the presence
 * query subtracts approved leave from the roster with multirange difference and then `unnest`es the
 * result, so it returns *n rows per therapist*. Folding it into the first query would multiply every
 * therapist's row by the number of fragments their day is broken into, and the skills array would be
 * duplicated along with it.
 *
 * Both statements are the SAME fragment — {@link therapistPoolCtes} — read from two different ends, so
 * the two halves cannot disagree about who the query was about, and a third caller composing the pool
 * into one larger statement (B-AVAIL-07) gets this rule rather than a copy of it.
 */
export async function readEligibleTherapists(
  sql: Sql,
  query: EligibilityQueryInput,
): Promise<TherapistPoolRead> {
  const ctes = therapistPoolCtes(sql, query)

  const rows = await sql<PoolQueryRow[]>`
    with ${ctes}
    select employee_id, gender, skills, reason from tp_pool order by employee_id
  `

  const presenceRows = await sql<PresenceQueryRow[]>`
    with ${therapistPoolCtes(sql, query)}
    select employee_id, starts_at, ends_at from tp_presence
     order by employee_id, starts_at
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
